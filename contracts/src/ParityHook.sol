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
import {INyseCalendar} from "./interfaces/INyseCalendar.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";
import {IWrapperAdapter} from "./interfaces/IWrapperAdapter.sol";
import {CanonicalShares} from "./libraries/CanonicalShares.sol";

/// @title ParityHook
/// @notice Settlement engine for issuer/issuer pools of the same underlying: exact share-parity conversion from
///         hook-owned ERC-6909 inventory (custom accounting via beforeSwapReturnDelta), all-or-nothing, else a
///         zero-delta fall-through to the pool's concentrated liquidity under a 50 bps peg guard.
contract ParityHook is IParityHook, IUnlockCallback, Ownable {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint24 public constant BASE_FEE_PIPS = CanonicalShares.BASE_FEE_PIPS;
    uint24 public constant SKEW_FEE_PIPS = CanonicalShares.SKEW_FEE_PIPS;
    uint24 public constant CLOSED_FEE_PIPS = CanonicalShares.CLOSED_FEE_PIPS;
    uint24 public constant MAX_FEE_PIPS = CanonicalShares.MAX_FEE_PIPS;
    uint256 public constant PEG_GUARD_BPS = 50;
    uint8 public constant HOOK_DATA_VERSION = 1;
    int24 public constant TICK_SPACING = 10;

    /// @dev Transient swap context, one packed word: mode | reason << 8 | feePips << 16 | swapper << 40.
    bytes32 internal constant SWAP_SLOT = keccak256("wrapswap.parity.swap");
    /// @dev Transient flag set only by depositInventory / withdrawInventory / sweepFees around their unlock.
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
    INyseCalendar public immutable calendar;
    IEligibility public immutable eligibility;

    mapping(address => bool) public isKeeper;
    mapping(Currency => uint256) public feesAccrued;
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
        INyseCalendar calendar_,
        IEligibility eligibility_,
        address owner_
    ) Ownable(owner_) {
        poolManager = poolManager_;
        registry = registry_;
        calendar = calendar_;
        eligibility = eligibility_;
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

    function sweepFees(Currency currency, address to) external onlyOwner returns (uint256 amount) {
        amount = feesAccrued[currency];
        if (amount == 0) return 0;
        feesAccrued[currency] = 0;
        _unlock(abi.encode(Action.WITHDRAW, currency, amount, to));
        emit FeesSwept(Currency.unwrap(currency), to, amount);
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
        return poolManager.balanceOf(address(this), currency.toId()) - feesAccrued[currency];
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
        q = _quote(s0, s1, zeroForOne, amountSpecified, _feeBreakdown(s0, s1));
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
        address swapper = _checkSwapper(sender, hookData);
        _requireActive(s0.currency, s1.currency);

        PoolId id = key.toId();
        FeeBreakdown memory fee = _feeBreakdown(s0, s1);
        emit FeeQuoted(id, fee.totalPips, fee.basePips, fee.skewPips, fee.closedPips, fee.skewX18, fee.marketOpen);
        uint24 lpFeeOverride = fee.totalPips | LPFeeLibrary.OVERRIDE_FEE_FLAG;

        Quote memory q = _quote(s0, s1, params.zeroForOne, params.amountSpecified, fee);
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
        poolManager.burn(address(this), cOut.toId(), q.amountOut);
        feesAccrued[cOut] += q.feeAmount;
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
        emit InventoryChanged(Currency.unwrap(cOut), swapper, REASON_FILL_OUT, -int256(q.grossOut), inventory(cOut));

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
    function _quote(Side memory s0, Side memory s1, bool zeroForOne, int256 amountSpecified, FeeBreakdown memory fee)
        internal
        view
        returns (Quote memory q)
    {
        (Side memory sIn, Side memory sOut) = zeroForOne ? (s0, s1) : (s1, s0);
        q.fee = fee;
        uint24 pips = fee.totalPips;
        if (amountSpecified < 0) {
            q.amountIn = uint256(-amountSpecified);
            q.shares = CanonicalShares.toSharesDown(q.amountIn, sIn.spt, sIn.decimals);
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

    function _feeBreakdown(Side memory s0, Side memory s1) internal view returns (FeeBreakdown memory fee) {
        uint256 sh0 = CanonicalShares.toSharesDown(inventory(s0.currency), s0.spt, s0.decimals);
        uint256 sh1 = CanonicalShares.toSharesDown(inventory(s1.currency), s1.spt, s1.decimals);
        fee.marketOpen = calendar.isOpen(block.timestamp);
        fee.basePips = BASE_FEE_PIPS;
        fee.skewPips = CanonicalShares.skewPips(sh0, sh1, SKEW_FEE_PIPS);
        fee.closedPips = fee.marketOpen ? 0 : CLOSED_FEE_PIPS;
        fee.totalPips = CanonicalShares.totalFeePips(sh0, sh1, fee.marketOpen);
        fee.skewX18 = CanonicalShares.skewX18(sh0, sh1);
    }

    function _pegStatus(PoolId id, Side memory s0, Side memory s1) internal view returns (PegStatus memory p) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        p.parityPriceX18 = CanonicalShares.parityPriceX18(s0.spt, s1.spt);
        p.poolPriceX18 = CanonicalShares.poolPriceX18(sqrtPriceX96, s0.decimals, s1.decimals);
        p.deviationBps = CanonicalShares.deviationBps(p.poolPriceX18, p.parityPriceX18);
        p.tripped = p.deviationBps > PEG_GUARD_BPS;
    }

    /// @dev hookData: empty => (sender, 0); exactly 96 bytes of abi.encode(uint8 1, address swapper, bytes32 uid)
    ///      with clean words => resolveSwapper(sender, swapper); anything else => InvalidHookData.
    function _checkSwapper(address sender, bytes calldata hookData) internal view returns (address swapper) {
        bytes32 uid;
        if (hookData.length == 0) {
            swapper = sender;
        } else {
            if (hookData.length != 96) revert InvalidHookData();
            uint256 version;
            uint256 claimed;
            assembly ("memory-safe") {
                version := calldataload(hookData.offset)
                claimed := calldataload(add(hookData.offset, 32))
                uid := calldataload(add(hookData.offset, 64))
            }
            if (version != HOOK_DATA_VERSION || claimed >> 160 != 0) revert InvalidHookData();
            swapper = eligibility.resolveSwapper(sender, address(uint160(claimed)));
        }
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
