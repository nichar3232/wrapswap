// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IParityHook} from "./interfaces/IParityHook.sol";
import {IIssuerRegistry} from "./interfaces/IIssuerRegistry.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";
import {IWrapperAdapter} from "./interfaces/IWrapperAdapter.sol";
import {CanonicalShares} from "./libraries/CanonicalShares.sol";

/// @title ParityHook
/// @notice Settlement engine for issuer/issuer pools of the same underlying: exact share-parity conversion from
///         hook-owned ERC-6909 inventory (custom accounting via beforeSwapReturnDelta), all-or-nothing, else a
///         zero-delta fall-through to the pool's concentrated liquidity under a 50 bps peg guard.
///         Fee = owner-settable base + a skew fee charged only to trades that increase inventory imbalance; the
///         whole fee stays in the hook's inventory (the LP's), the protocol takes nothing on Convert.
contract ParityHook is IParityHook, IUnlockCallback, Ownable {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint24 public constant DEFAULT_BASE_FEE_PIPS = CanonicalShares.DEFAULT_BASE_FEE_PIPS;
    uint24 public constant MAX_BASE_FEE_PIPS = CanonicalShares.MAX_BASE_FEE_PIPS;
    uint24 public constant SKEW_FEE_PIPS = CanonicalShares.SKEW_FEE_PIPS;
    uint24 public constant SKEW_FEE_CAP_PIPS = CanonicalShares.SKEW_FEE_CAP_PIPS;
    uint256 public constant PEG_GUARD_BPS = 50;
    /// @dev Latest hookData version (2 adds the recipient); version 1 (no recipient) is still accepted.
    uint8 public constant HOOK_DATA_VERSION = 2;
    int24 public constant TICK_SPACING = 10;

    /// @dev Transient swap context, one packed word: mode | reason << 8 | feePips << 16 | swapper << 40.
    bytes32 internal constant SWAP_SLOT = keccak256("wrapswap.parity.swap");
    /// @dev Transient flag set only by depositInventory / withdrawInventory around their unlock.
    bytes32 internal constant CALLBACK_SLOT = keccak256("wrapswap.parity.callback");
    uint256 internal constant MODE_FILL = 1;
    uint256 internal constant MODE_FALL = 2;
    uint8 internal constant REASON_DEPOSIT = 0;
    uint8 internal constant REASON_WITHDRAW = 1;
    uint8 internal constant REASON_FILL_IN = 2;
    uint8 internal constant REASON_FILL_OUT = 3;
    uint8 internal constant FALL_INSUFFICIENT = 1;
    uint8 internal constant FALL_DUST = 2;

    enum Action {
        DEPOSIT,
        WITHDRAW
    }

    struct Side {
        Currency currency;
        uint256 spt;
        uint8 decimals;
    }

    error TransferAmountMismatch(uint256 expected, uint256 received);

    IPoolManager public immutable poolManager;
    IIssuerRegistry public immutable registry;
    IEligibility public immutable eligibility;

    uint24 public baseFeePips;
    mapping(address => bool) public isKeeper;
    mapping(PoolId => bool) public pegTripped;

    modifier onlyManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper(msg.sender);
        _;
    }

    constructor(
        IPoolManager poolManager_,
        IIssuerRegistry registry_,
        IEligibility eligibility_,
        address owner_
    ) Ownable(owner_) {
        poolManager = poolManager_;
        registry = registry_;
        eligibility = eligibility_;
        baseFeePips = DEFAULT_BASE_FEE_PIPS;
        emit BaseFeeSet(DEFAULT_BASE_FEE_PIPS);
        isKeeper[owner_] = true;
        emit KeeperSet(owner_, true);
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    // ---------------------------------------------------------------- keepers and inventory

    function setBaseFeePips(uint24 basePips) external onlyOwner {
        if (basePips > MAX_BASE_FEE_PIPS) revert BaseFeeTooHigh(basePips, MAX_BASE_FEE_PIPS);
        baseFeePips = basePips;
        emit BaseFeeSet(basePips);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function depositInventory(Currency currency, uint256 amount) external onlyKeeper {
        if (amount == 0) revert ZeroAmount();
        address token = Currency.unwrap(currency);
        if (!registry.isIssuer(token)) revert IIssuerRegistry.UnknownIssuer(token);
        _unlock(abi.encode(Action.DEPOSIT, currency, amount, msg.sender));
        emit InventoryChanged(token, msg.sender, REASON_DEPOSIT, int256(amount), inventory(currency));
    }

    function withdrawInventory(Currency currency, uint256 amount, address to) external onlyKeeper {
        if (amount == 0) revert ZeroAmount();
        uint256 available = inventory(currency);
        if (amount > available) revert InsufficientInventory(Currency.unwrap(currency), available, amount);
        _unlock(abi.encode(Action.WITHDRAW, currency, amount, to));
        emit InventoryChanged(Currency.unwrap(currency), msg.sender, REASON_WITHDRAW, -int256(amount), available - amount);
    }

    function unlockCallback(bytes calldata data) external onlyManager returns (bytes memory) {
        if (_tload(CALLBACK_SLOT) == 0) revert NotPoolManager();
        (Action action, Currency currency, uint256 amount, address who) =
            abi.decode(data, (Action, Currency, uint256, address));
        if (action == Action.DEPOSIT) {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(who, address(poolManager), amount);
            uint256 paid = poolManager.settle();
            if (paid != amount) revert TransferAmountMismatch(amount, paid);
            poolManager.mint(address(this), currency.toId(), amount);
        } else {
            poolManager.burn(address(this), currency.toId(), amount);
            poolManager.take(currency, who, amount);
        }
        return "";
    }

    function inventory(Currency currency) public view returns (uint256) {
        return poolManager.balanceOf(address(this), currency.toId());
    }

    function inventoryShares(Currency currency) external view returns (uint256) {
        Side memory s = _side(currency);
        return CanonicalShares.toSharesDown(inventory(currency), s.spt, s.decimals);
    }

    // ---------------------------------------------------------------- views

    function feeBreakdown(PoolKey calldata key) public view returns (FeeBreakdown memory fee) {
        (Side memory s0, Side memory s1) = _pair(key);
        return _feeBreakdown(s0, s1);
    }

    function quote(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        external
        view
        returns (Quote memory q)
    {
        if (amountSpecified == 0) revert ZeroAmount();
        (Side memory s0, Side memory s1) = _pair(key);
        _requireActive(s0.currency, s1.currency);
        q = _quote(s0, s1, zeroForOne, amountSpecified);
    }

    function quote(bytes32 asset, address fromWrapper, address toWrapper, uint256 amountIn)
        external
        view
        returns (uint256 sharesOut, uint256 baseFee, uint256 skewFee, int256 postSkew, bool reducesImbalance)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (
            fromWrapper == toWrapper || asset == bytes32(0) || registry.underlyingOf(fromWrapper) != asset
                || registry.underlyingOf(toWrapper) != asset
        ) revert UnsupportedPool(fromWrapper, toWrapper);
        _requireActive(Currency.wrap(fromWrapper), Currency.wrap(toWrapper));
        bool zeroForOne = fromWrapper < toWrapper;
        (Side memory s0, Side memory s1) = zeroForOne
            ? (_side(Currency.wrap(fromWrapper)), _side(Currency.wrap(toWrapper)))
            : (_side(Currency.wrap(toWrapper)), _side(Currency.wrap(fromWrapper)));
        Quote memory q = _quote(s0, s1, zeroForOne, -int256(amountIn));
        (sharesOut, baseFee, skewFee) = _feeShares(q, zeroForOne ? s1 : s0);
        return (sharesOut, baseFee, skewFee, q.fee.postSkewX18, q.fee.reducesImbalance);
    }

    function pegStatus(PoolKey calldata key) public view returns (PegStatus memory) {
        (Side memory s0, Side memory s1) = _pair(key);
        return _pegStatus(key.toId(), s0, s1);
    }

    function checkPeg(PoolKey calldata key) external returns (bool tripped) {
        PegStatus memory p = pegStatus(key);
        tripped = p.tripped;
        PoolId id = key.toId();
        if (tripped != pegTripped[id]) {
            pegTripped[id] = tripped;
            emit PegGuardStatus(id, tripped, p.poolPriceX18, p.parityPriceX18, p.deviationBps);
        }
    }

    // ---------------------------------------------------------------- hook callbacks

    function beforeInitialize(address, PoolKey calldata key, uint160 sqrtPriceX96)
        external
        onlyManager
        returns (bytes4)
    {
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert DynamicFeeRequired(key.fee);
        address t0 = Currency.unwrap(key.currency0);
        address t1 = Currency.unwrap(key.currency1);
        if (key.tickSpacing != TICK_SPACING || !registry.active(t0) || !registry.active(t1)) {
            revert UnsupportedPool(t0, t1);
        }
        (Side memory s0, Side memory s1) = _pair(key);
        PoolId id = key.toId();
        uint256 parity = CanonicalShares.parityPriceX18(s0.spt, s1.spt);
        uint256 dev = CanonicalShares.deviationBps(
            CanonicalShares.poolPriceX18(sqrtPriceX96, s0.decimals, s1.decimals), parity
        );
        if (dev > PEG_GUARD_BPS) revert PegGuardTripped(id, dev);
        emit PoolRegistered(id, t0, t1, registry.underlyingOf(t0), key.tickSpacing);
        return this.beforeInitialize.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (Side memory s0, Side memory s1) = _pair(key);
        (address swapper, address recipient) = _checkSwapper(sender, hookData);
        _requireActive(s0.currency, s1.currency);

        PoolId id = key.toId();
        Quote memory q = _quote(s0, s1, params.zeroForOne, params.amountSpecified);
        FeeBreakdown memory fee = q.fee;
        uint24 lpFeeOverride = fee.totalPips | LPFeeLibrary.OVERRIDE_FEE_FLAG;
        if (!q.fillable) {
            uint8 reason = (q.amountIn == 0 || q.amountOut == 0) ? FALL_DUST : FALL_INSUFFICIENT;
            _tstore(
                SWAP_SLOT,
                MODE_FALL | uint256(reason) << 8 | uint256(fee.totalPips) << 16 | uint256(uint160(swapper)) << 40
            );
            return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, lpFeeOverride);
        }

        (Currency cIn, Currency cOut) = params.zeroForOne ? (s0.currency, s1.currency) : (s1.currency, s0.currency);
        int128 inDelta = q.amountIn.toInt128();
        int128 outDelta = q.amountOut.toInt128();
        poolManager.mint(address(this), cIn.toId(), q.amountIn);
        // Only the net output leaves: the fee stays in inventory (the LP's).
        poolManager.burn(address(this), cOut.toId(), q.amountOut);
        _tstore(SWAP_SLOT, MODE_FILL);

        bool exactInput = params.amountSpecified < 0;
        emit InventoryFill(
            id,
            swapper,
            sender,
            params.zeroForOne,
            exactInput,
            q.amountIn,
            q.amountOut,
            q.shares,
            q.feeAmount,
            fee.totalPips
        );
        emit InventoryChanged(Currency.unwrap(cIn), swapper, REASON_FILL_IN, int256(q.amountIn), inventory(cIn));
        emit InventoryChanged(Currency.unwrap(cOut), swapper, REASON_FILL_OUT, -int256(q.amountOut), inventory(cOut));
        _emitConverted(q, cIn, cOut, params.zeroForOne ? s1 : s0, swapper, recipient);

        BeforeSwapDelta delta =
            exactInput ? toBeforeSwapDelta(inDelta, -outDelta) : toBeforeSwapDelta(-outDelta, inDelta);
        return (this.beforeSwap.selector, delta, lpFeeOverride);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyManager
        returns (bytes4, int128)
    {
        uint256 ctx = _tload(SWAP_SLOT);
        _tstore(SWAP_SLOT, 0);
        if (ctx & 0xff == MODE_FALL) {
            (Side memory s0, Side memory s1) = _pair(key);
            PoolId id = key.toId();
            PegStatus memory p = _pegStatus(id, s0, s1);
            if (p.tripped) revert PegGuardTripped(id, p.deviationBps);
            emit FallThrough(
                id,
                address(uint160(ctx >> 40)),
                sender,
                params.zeroForOne,
                uint8(ctx >> 8),
                delta.amount0(),
                delta.amount1(),
                uint24(ctx >> 16),
                p.deviationBps
            );
        }
        return (this.afterSwap.selector, 0);
    }

    // ---------------------------------------------------------------- internals

    /// @dev Exact input (amountSpecified < 0) and exact output (> 0) per INTERFACES.md §1.7; every rounding step
    ///      favours the hook. Shared verbatim by quote() and beforeSwap() so the view equals execution.
    ///      The fee depends on the trade: its skew part is evaluated at the post-trade skew. The trade's share
    ///      size for that is fee-independent: the input's shares (exact input) or the net output's shares (exact output).
    function _quote(Side memory s0, Side memory s1, bool zeroForOne, int256 amountSpecified)
        internal
        view
        returns (Quote memory q)
    {
        (Side memory sIn, Side memory sOut) = zeroForOne ? (s0, s1) : (s1, s0);
        uint256 size = amountSpecified < 0
            ? CanonicalShares.toSharesDown(uint256(-amountSpecified), sIn.spt, sIn.decimals)
            : CanonicalShares.toSharesUp(uint256(amountSpecified), sOut.spt, sOut.decimals);
        q.fee = _tradeFee(s0, s1, zeroForOne, size);
        uint24 pips = q.fee.totalPips;
        if (amountSpecified < 0) {
            q.amountIn = uint256(-amountSpecified);
            q.shares = size;
            q.grossOut = CanonicalShares.fromSharesDown(q.shares, sOut.spt, sOut.decimals);
            q.feeAmount = CanonicalShares.feeOnGross(q.grossOut, pips);
            q.amountOut = q.grossOut - q.feeAmount;
        } else {
            q.amountOut = uint256(amountSpecified);
            q.grossOut = CanonicalShares.grossForNet(q.amountOut, pips);
            q.feeAmount = q.grossOut - q.amountOut;
            q.shares = CanonicalShares.toSharesUp(q.grossOut, sOut.spt, sOut.decimals);
            q.amountIn = CanonicalShares.fromSharesUp(q.shares, sIn.spt, sIn.decimals);
        }
        q.fillable = q.amountIn > 0 && q.amountOut > 0 && inventory(sOut.currency) >= q.grossOut;
    }

    /// @dev Trade-less view (feeBreakdown): the fee a marginal |skew|-increasing trade pays now, i.e. the skew fee at
    ///      the current |skew|. Exact per-trade figures come from quote().
    function _feeBreakdown(Side memory s0, Side memory s1) internal view returns (FeeBreakdown memory fee) {
        (uint256 sh0, uint256 sh1) = _inventoryShares(s0, s1);
        uint24 skew = CanonicalShares.capSkewFee(CanonicalShares.skewPips(sh0, sh1, SKEW_FEE_PIPS));
        fee = _fee(skew);
        fee.skewX18 = CanonicalShares.skewX18(sh0, sh1);
        fee.postSkewX18 = fee.skewX18;
        fee.reducesImbalance = skew == 0;
    }

    /// @dev Fee for a parity fill of `size` canonical shares: baseFeePips + skew fee, the latter 15 bps * |post-trade
    ///      skew| (cap 50 bps) and only when the trade increases |skew| (CanonicalShares.skewFeePips).
    function _tradeFee(Side memory s0, Side memory s1, bool zeroForOne, uint256 size)
        internal
        view
        returns (FeeBreakdown memory fee)
    {
        (uint256 sh0, uint256 sh1) = _inventoryShares(s0, s1);
        (uint256 post0, uint256 post1) = CanonicalShares.postTradeShares(sh0, sh1, zeroForOne, size);
        uint24 skew = CanonicalShares.skewFeePips(sh0, sh1, post0, post1);
        fee = _fee(skew);
        fee.skewX18 = CanonicalShares.skewX18(sh0, sh1);
        fee.postSkewX18 = CanonicalShares.skewX18(post0, post1);
        fee.reducesImbalance = !CanonicalShares.increasesImbalance(sh0, sh1, post0, post1);
    }

    function _fee(uint24 skewPips) internal view returns (FeeBreakdown memory fee) {
        fee.basePips = baseFeePips;
        fee.skewPips = skewPips;
        fee.totalPips = baseFeePips + skewPips;
    }

    /// @dev Splits a quote into canonical shares: sharesOut (net output), baseFee and skewFee, pro rata to the pips,
    ///      with sharesIn = sharesOut + baseFee + skewFee exactly.
    function _feeShares(Quote memory q, Side memory sOut)
        internal
        pure
        returns (uint256 sharesOut, uint256 baseFee, uint256 skewFee)
    {
        sharesOut = CanonicalShares.toSharesDown(q.amountOut, sOut.spt, sOut.decimals);
        uint256 feeShares = q.shares - sharesOut;
        baseFee = q.fee.totalPips == 0 ? 0 : feeShares * q.fee.basePips / q.fee.totalPips;
        skewFee = feeShares - baseFee;
    }

    function _emitConverted(Quote memory q, Currency cIn, Currency cOut, Side memory sOut, address swapper, address recipient)
        internal
    {
        (uint256 sharesOut, uint256 baseFee, uint256 skewFee) = _feeShares(q, sOut);
        emit Converted(
            registry.underlyingOf(Currency.unwrap(cIn)),
            Currency.unwrap(cIn),
            Currency.unwrap(cOut),
            swapper,
            recipient,
            q.amountIn,
            sharesOut,
            baseFee,
            skewFee,
            q.fee.postSkewX18
        );
    }

    function _inventoryShares(Side memory s0, Side memory s1) internal view returns (uint256 sh0, uint256 sh1) {
        sh0 = CanonicalShares.toSharesDown(inventory(s0.currency), s0.spt, s0.decimals);
        sh1 = CanonicalShares.toSharesDown(inventory(s1.currency), s1.spt, s1.decimals);
    }

    function _pegStatus(PoolId id, Side memory s0, Side memory s1) internal view returns (PegStatus memory p) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        p.parityPriceX18 = CanonicalShares.parityPriceX18(s0.spt, s1.spt);
        p.poolPriceX18 = CanonicalShares.poolPriceX18(sqrtPriceX96, s0.decimals, s1.decimals);
        p.deviationBps = CanonicalShares.deviationBps(p.poolPriceX18, p.parityPriceX18);
        p.tripped = p.deviationBps > PEG_GUARD_BPS;
    }

    /// @dev hookData: empty => (sender, uid 0, recipient sender); 96 bytes abi.encode(uint8 1, address swapper, bytes32 uid)
    ///      or 128 bytes abi.encode(uint8 2, address swapper, bytes32 uid, address recipient), clean words =>
    ///      swapper = resolveSwapper(sender, swapper), recipient (v1 or zero: the swapper); anything else => InvalidHookData.
    function _checkSwapper(address sender, bytes calldata hookData)
        internal
        view
        returns (address swapper, address recipient)
    {
        bytes32 uid;
        if (hookData.length == 0) {
            swapper = sender;
        } else {
            if (hookData.length != 96 && hookData.length != 128) revert InvalidHookData();
            uint256 version;
            uint256 claimed;
            uint256 to;
            assembly ("memory-safe") {
                version := calldataload(hookData.offset)
                claimed := calldataload(add(hookData.offset, 32))
                uid := calldataload(add(hookData.offset, 64))
            }
            if (hookData.length == 128) {
                assembly ("memory-safe") {
                    to := calldataload(add(hookData.offset, 96))
                }
            }
            if (version != (hookData.length == 96 ? 1 : 2) || claimed >> 160 != 0 || to >> 160 != 0) {
                revert InvalidHookData();
            }
            swapper = eligibility.resolveSwapper(sender, address(uint160(claimed)));
            recipient = address(uint160(to));
        }
        if (recipient == address(0)) recipient = swapper;
        (bool eligible, uint8 reason) = eligibility.check(swapper, uid);
        if (!eligible) revert IEligibility.NotEligible(swapper, reason);
    }

    function _requireActive(Currency c0, Currency c1) internal view {
        if (!registry.active(Currency.unwrap(c0))) revert AdapterUnhealthy(Currency.unwrap(c0));
        if (!registry.active(Currency.unwrap(c1))) revert AdapterUnhealthy(Currency.unwrap(c1));
    }

    /// @dev Both currencies registered with the same non-zero underlying and the key attached to this hook.
    function _pair(PoolKey calldata key) internal view returns (Side memory s0, Side memory s1) {
        address t0 = Currency.unwrap(key.currency0);
        address t1 = Currency.unwrap(key.currency1);
        bytes32 u0 = registry.underlyingOf(t0);
        if (
            address(key.hooks) != address(this) || !registry.isIssuer(t0) || !registry.isIssuer(t1) || u0 == bytes32(0)
                || u0 != registry.underlyingOf(t1)
        ) revert UnsupportedPool(t0, t1);
        s0 = _side(key.currency0);
        s1 = _side(key.currency1);
    }

    function _side(Currency currency) internal view returns (Side memory s) {
        address token = Currency.unwrap(currency);
        address adapter = registry.adapterOf(token);
        if (adapter == address(0)) revert IIssuerRegistry.UnknownIssuer(token);
        (uint256 spt,) = IWrapperAdapter(adapter).ratio();
        s = Side(currency, spt, IWrapperAdapter(adapter).tokenDecimals());
    }

    function _unlock(bytes memory data) internal {
        _tstore(CALLBACK_SLOT, 1);
        poolManager.unlock(data);
        _tstore(CALLBACK_SLOT, 0);
    }

    function _tstore(bytes32 slot, uint256 value) internal {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }

    function _tload(bytes32 slot) internal view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }
}
