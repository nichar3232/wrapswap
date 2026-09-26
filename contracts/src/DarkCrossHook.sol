// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IDarkCrossHook} from "./interfaces/IDarkCrossHook.sol";
import {IParityHook} from "./interfaces/IParityHook.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IEligibility} from "./interfaces/IEligibility.sol";
import {IWrapperAdapter} from "./interfaces/IWrapperAdapter.sol";
import {IIssuerRegistry} from "./interfaces/IIssuerRegistry.sol";
import {CanonicalShares} from "./libraries/CanonicalShares.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title DarkCrossHook
/// @notice Commit-reveal batch crossing of one issuer pair at an IPriceOracle midpoint (<= 30 minutes old). Residuals
///         fall through, exact-input and capped at available inventory, into the ParityHook pool of the same pair
///         inside the settlement unlock; the unfilled part is returned to the committer.
/// @dev Not a pool hook (no permission flags, deployed with plain CREATE). The owner can only change the
///      protocolFeeRecipient, which receives the 1 bp cross fees and unrevealed-commit forfeits (credited to its escrow).
contract DarkCrossHook is IDarkCrossHook, IUnlockCallback, Ownable {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    uint256 public constant BATCH_BLOCKS = 20;
    uint256 public constant COMMIT_BLOCKS = 12;
    uint256 public constant REVEAL_BLOCKS = 6;
    uint256 public constant MAX_PARTICIPANTS = 64;
    uint24 public constant CROSS_FEE_PIPS = 100;
    uint256 public constant FORFEIT_BPS = 10;
    uint64 public constant ORACLE_MAX_AGE = 1800;
    /// @notice Minimum lock per commit in raw units: makes every unrevealed forfeit non-zero (>= 10 raw units).
    uint256 public constant MIN_LOCK = 10_000;

    uint8 internal constant REJECT_WRONG_LOCK_TOKEN = 1;
    uint8 internal constant REJECT_INSUFFICIENT_LOCK = 2;
    uint8 internal constant REJECT_ZERO_AMOUNT = 3;
    uint8 internal constant REJECT_ZERO_LIMIT = 4;
    uint8 internal constant CALLBACK_VERSION = 1;

    bytes32 internal constant LOCK_SLOT = keccak256("wrapswap.dark.lock");
    bytes32 internal constant SETTLING_SLOT = keccak256("wrapswap.dark.settling");

    struct Balance {
        uint256 available;
        uint256 locked;
    }

    error InvalidConfig();
    error Reentrancy();
    error TransferAmountMismatch(uint256 expected, uint256 received);
    error ResidualBelowMinOut(uint256 amountOut, uint256 minOut);
    error ResidualNotFillable();

    IPoolManager public immutable poolManager;
    IParityHook public immutable parityHook;
    IPriceOracle public immutable oracle;
    IEligibility public immutable eligibility;
    address public immutable baseToken;
    address public immutable quoteToken;
    bytes32 public immutable asset;
    uint256 public immutable batchOrigin;
    address public protocolFeeRecipient;
    uint256 internal immutable baseUnit;
    uint256 internal immutable quoteUnit;

    PoolKey internal _parityPoolKey;
    mapping(address => mapping(address => Balance)) internal _balances;
    mapping(uint256 => mapping(address => Order)) internal _orders;
    mapping(uint256 => address[]) internal _participants;
    mapping(uint256 => mapping(address => uint256)) internal _residualUsed;
    mapping(uint256 => BatchResult) internal _results;
    mapping(uint256 => bool) public settled;

    modifier nonReentrant() {
        if (_tload(LOCK_SLOT) != 0) revert Reentrancy();
        _tstore(LOCK_SLOT, 1);
        _;
        _tstore(LOCK_SLOT, 0);
    }

    constructor(
        IPoolManager poolManager_,
        IParityHook parityHook_,
        IPriceOracle oracle_,
        IEligibility eligibility_,
        address baseToken_,
        address quoteToken_,
        PoolKey memory parityKey,
        address protocolFeeRecipient_,
        address owner_
    ) Ownable(owner_) {
        (address lo, address hi) = baseToken_ < quoteToken_ ? (baseToken_, quoteToken_) : (quoteToken_, baseToken_);
        bytes32 underlying = parityHook_.registry().underlyingOf(baseToken_);
        if (
            baseToken_ == quoteToken_ || lo == address(0) || protocolFeeRecipient_ == address(0)
                || underlying == bytes32(0) || underlying != parityHook_.registry().underlyingOf(quoteToken_)
                || address(parityKey.hooks) != address(parityHook_) || Currency.unwrap(parityKey.currency0) != lo
                || Currency.unwrap(parityKey.currency1) != hi || parityKey.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG
        ) revert InvalidConfig();
        poolManager = poolManager_;
        parityHook = parityHook_;
        oracle = oracle_;
        eligibility = eligibility_;
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        asset = underlying;
        protocolFeeRecipient = protocolFeeRecipient_;
        emit ProtocolFeeRecipientSet(protocolFeeRecipient_);
        batchOrigin = block.number;
        baseUnit = 10 ** IERC20Metadata(baseToken_).decimals();
        quoteUnit = 10 ** IERC20Metadata(quoteToken_).decimals();
        _parityPoolKey = parityKey;
    }

    function setProtocolFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert InvalidConfig();
        protocolFeeRecipient = recipient;
        emit ProtocolFeeRecipientSet(recipient);
    }

    // ---------------------------------------------------------------- views

    function parityPoolKey() external view returns (PoolKey memory) {
        return _parityPoolKey;
    }

    function currentBatch() public view returns (uint256 batchId, Phase phase, uint256 phaseEndsBlock) {
        uint256 n = block.number - batchOrigin;
        batchId = n / BATCH_BLOCKS;
        uint256 pos = n % BATCH_BLOCKS;
        phase = pos < COMMIT_BLOCKS ? Phase.COMMIT : pos < COMMIT_BLOCKS + REVEAL_BLOCKS ? Phase.REVEAL : Phase.SETTLE;
        phaseEndsBlock = batchOrigin + batchId * BATCH_BLOCKS
            + (phase == Phase.COMMIT ? COMMIT_BLOCKS : phase == Phase.REVEAL ? COMMIT_BLOCKS + REVEAL_BLOCKS : BATCH_BLOCKS);
    }

    function commitHashOf(
        uint256 batchId,
        address trader,
        bool sellBase,
        uint256 amountIn,
        uint256 limitPriceX18,
        address recipient,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), batchId, trader, sellBase, amountIn, limitPriceX18, recipient, salt)
        );
    }

    function balances(address account, address token) external view returns (uint256 available, uint256 locked) {
        Balance storage b = _balances[account][token];
        return (b.available, b.locked);
    }

    function order(uint256 batchId, address trader) external view returns (Order memory) {
        return _orders[batchId][trader];
    }

    function participants(uint256 batchId) external view returns (address[] memory) {
        return _participants[batchId];
    }

    function batchResult(uint256 batchId) external view returns (BatchResult memory) {
        return _results[batchId];
    }

    // ---------------------------------------------------------------- escrow

    function fund(address token, uint256 amount) external nonReentrant {
        _supported(token);
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert TransferAmountMismatch(amount, received);
        _balances[msg.sender][token].available += amount;
        emit Funded(msg.sender, token, amount);
    }

    function withdraw(address token, uint256 amount) external nonReentrant {
        _supported(token);
        Balance storage b = _balances[msg.sender][token];
        if (amount > b.available) revert InsufficientEscrow(token, b.available, amount);
        b.available -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ---------------------------------------------------------------- commit / reveal

    function commit(bytes32 commitHash, address lockToken, uint256 lockAmount, bytes32 attestationUid)
        external
        nonReentrant
        returns (bool accepted)
    {
        (uint256 batchId, Phase phase,) = currentBatch();
        if (phase != Phase.COMMIT) revert WrongPhase(Phase.COMMIT, phase);
        _supported(lockToken);
        if (commitHash == bytes32(0) || lockAmount < MIN_LOCK) revert InvalidCommit();
        if (_orders[batchId][msg.sender].commitHash != bytes32(0)) revert AlreadyCommitted(batchId, msg.sender);
        if (_participants[batchId].length >= MAX_PARTICIPANTS) revert BatchFull(batchId);
        Balance storage b = _balances[msg.sender][lockToken];
        if (lockAmount > b.available) revert InsufficientEscrow(lockToken, b.available, lockAmount);
        if (!eligibility.enforce(msg.sender, attestationUid)) return false;

        b.available -= lockAmount;
        b.locked += lockAmount;
        Order storage o = _orders[batchId][msg.sender];
        o.commitHash = commitHash;
        o.lockToken = lockToken;
        o.locked = lockAmount;
        o.attestationUid = attestationUid;
        _participants[batchId].push(msg.sender);
        emit Committed(batchId, msg.sender, commitHash, lockToken, lockAmount);
        return true;
    }

    function reveal(bool sellBase, uint256 amountIn, uint256 limitPriceX18, address recipient, bytes32 salt)
        external
        nonReentrant
    {
        (uint256 batchId, Phase phase,) = currentBatch();
        if (phase != Phase.REVEAL) revert WrongPhase(Phase.REVEAL, phase);
        Order storage o = _orders[batchId][msg.sender];
        if (o.commitHash == bytes32(0)) revert UnknownCommit(batchId, msg.sender);
        if (o.revealed) revert AlreadyRevealed(batchId, msg.sender);
        if (o.commitHash != commitHashOf(batchId, msg.sender, sellBase, amountIn, limitPriceX18, recipient, salt))
        {
            revert CommitMismatch(batchId, msg.sender);
        }
        o.revealed = true;
        o.sellBase = sellBase;
        o.amountIn = amountIn;
        o.limitPriceX18 = limitPriceX18;
        o.recipient = recipient == address(0) ? msg.sender : recipient;

        uint8 reason;
        if (o.lockToken != (sellBase ? baseToken : quoteToken)) reason = REJECT_WRONG_LOCK_TOKEN;
        else if (o.locked < amountIn) reason = REJECT_INSUFFICIENT_LOCK;
        else if (amountIn == 0) reason = REJECT_ZERO_AMOUNT;
        else if (limitPriceX18 == 0) reason = REJECT_ZERO_LIMIT;
        if (reason != 0) {
            emit RevealRejected(batchId, msg.sender, reason);
            return;
        }
        o.valid = true;
        emit Revealed(batchId, msg.sender, sellBase, amountIn, limitPriceX18, o.recipient);
    }

    // ---------------------------------------------------------------- settlement

    function settle(uint256 batchId) external nonReentrant {
        (uint256 current, Phase phase,) = currentBatch();
        if (batchId > current || (batchId == current && phase != Phase.SETTLE)) revert BatchNotSettleable(batchId);
        if (settled[batchId]) revert AlreadySettled(batchId);
        (uint256 mid, uint64 updatedAt) = oracle.getMid(baseToken, quoteToken);
        if (block.timestamp > updatedAt && block.timestamp - updatedAt > ORACLE_MAX_AGE) {
            revert OracleStale(updatedAt, uint64(block.timestamp));
        }
        settled[batchId] = true;

        BatchResult storage r = _results[batchId];
        r.settled = true;
        r.midX18 = mid;
        r.midUpdatedAt = updatedAt;
        r.participants = uint32(_participants[batchId].length);

        bool anyResidual = _cross(batchId, mid, r);
        if (anyResidual) {
            _tstore(SETTLING_SLOT, 1);
            poolManager.unlock(abi.encode(CALLBACK_VERSION, batchId));
            _tstore(SETTLING_SLOT, 0);
        }
        _release(batchId);
        emit BatchSettled(
            batchId,
            mid,
            updatedAt,
            r.crossedBase,
            r.crossedQuote,
            r.residualBaseIn,
            r.residualQuoteIn,
            r.participants
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (_tload(SETTLING_SLOT) == 0) revert Unauthorized(msg.sender);
        (uint8 version, uint256 batchId) = abi.decode(data, (uint8, uint256));
        if (version != CALLBACK_VERSION) revert Unauthorized(msg.sender);
        address[] storage ps = _participants[batchId];
        for (uint256 i; i < ps.length; i++) {
            address trader = ps[i];
            Order storage o = _orders[batchId][trader];
            if (!o.valid || o.residualIn == 0) continue;
            uint256 fillIn = _fillableIn(o);
            uint256 filled;
            if (fillIn != 0) {
                try this.executeResidual(batchId, trader, fillIn) returns (uint256 amountIn, uint256) {
                    filled = amountIn;
                } catch (bytes memory reason) {
                    emit ResidualSkipped(batchId, trader, reason);
                }
            }
            if (filled < o.residualIn) emit Unfilled(batchId, trader, _shares(_inToken(o), o.residualIn - filled));
        }
        return "";
    }

    /// @notice Self-call only, while settling: fills `fillIn` of one residual exact-input from the ParityHook pool's
    ///         inventory (never the AMM: reverts if the hook would not fill), naming the trader as swapper and the
    ///         order's recipient, at no worse than the trader's limit; settles the deltas and delivers the output.
    function executeResidual(uint256 batchId, address trader, uint256 fillIn)
        external
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (msg.sender != address(this) || _tload(SETTLING_SLOT) == 0) revert Unauthorized(msg.sender);
        Order storage o = _orders[batchId][trader];
        PoolKey memory key = _parityPoolKey;
        (address tokenIn, address tokenOut) = o.sellBase ? (baseToken, quoteToken) : (quoteToken, baseToken);
        bool zeroForOne = tokenIn == Currency.unwrap(key.currency0);
        if (!parityHook.quote(key, zeroForOne, -int256(fillIn)).fillable) revert ResidualNotFillable();
        (, uint256 baseFee, uint256 skewFee,,) = parityHook.quote(asset, tokenIn, tokenOut, fillIn);
        uint256 minOut = o.sellBase
            ? FullMath.mulDiv(fillIn, o.limitPriceX18 * quoteUnit, 1e18 * baseUnit)
            : FullMath.mulDiv(fillIn, 1e18 * baseUnit, o.limitPriceX18 * quoteUnit);

        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(fillIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            abi.encode(uint8(2), trader, o.attestationUid, o.recipient)
        );
        (int128 dIn, int128 dOut) = zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        amountIn = uint256(uint128(-dIn));
        amountOut = uint256(uint128(dOut));
        if (amountOut < minOut) revert ResidualBelowMinOut(amountOut, minOut);
        _resolve(key.currency0, d.amount0());
        _resolve(key.currency1, d.amount1());

        _balances[trader][tokenIn].locked -= amountIn;
        _deliver(trader, o.recipient, tokenOut, amountOut);
        _residualUsed[batchId][trader] = amountIn;
        BatchResult storage res = _results[batchId];
        if (o.sellBase) res.residualBaseIn += amountIn;
        else res.residualQuoteIn += amountIn;
        emit ResidualFilled(batchId, trader, _shares(tokenIn, amountIn), baseFee, skewFee);
    }

    // ---------------------------------------------------------------- internals

    /// @dev Steps 1-4 of INTERFACES.md §1.8. Returns whether any valid order has a residual.
    function _cross(uint256 batchId, uint256 mid, BatchResult storage r) internal returns (bool anyResidual) {
        address[] storage ps = _participants[batchId];
        uint256 n = ps.length;
        uint256 totalBase;
        uint256 totalQuote;
        for (uint256 i; i < n; i++) {
            Order storage o = _orders[batchId][ps[i]];
            if (!_eligible(o, mid)) continue;
            if (o.sellBase) totalBase += o.amountIn;
            else totalQuote += o.amountIn;
        }
        uint256 quoteAsBase = totalQuote == 0 ? 0 : FullMath.mulDiv(totalQuote, 1e18 * baseUnit, mid * quoteUnit);
        uint256 crossedBase = totalBase < quoteAsBase ? totalBase : quoteAsBase;
        uint256 crossedQuote = FullMath.mulDiv(crossedBase, mid * quoteUnit, 1e18 * baseUnit);
        r.crossedBase = crossedBase;
        r.crossedQuote = crossedQuote;

        // Cumulative-floor allocation state: [0] base side, [1] quote side.
        uint256[2] memory cumIn;
        uint256[2] memory prevAlloc;
        uint256[2] memory cumCrossed;
        uint256[2] memory prevGross;
        uint256[2] memory fees;
        for (uint256 i; i < n; i++) {
            address trader = ps[i];
            Order storage o = _orders[batchId][trader];
            if (!o.valid) continue;
            uint256 crossedIn;
            uint256 gross;
            if (_eligible(o, mid)) {
                uint256 s = o.sellBase ? 0 : 1;
                (uint256 sideTotal, uint256 sideCrossed, uint256 otherCrossed) =
                    s == 0 ? (totalBase, crossedBase, crossedQuote) : (totalQuote, crossedQuote, crossedBase);
                cumIn[s] += o.amountIn;
                uint256 alloc = FullMath.mulDiv(cumIn[s], sideCrossed, sideTotal);
                crossedIn = alloc - prevAlloc[s];
                prevAlloc[s] = alloc;
                cumCrossed[s] += crossedIn;
                uint256 g = sideCrossed == 0 ? 0 : FullMath.mulDiv(cumCrossed[s], otherCrossed, sideCrossed);
                gross = g - prevGross[s];
                prevGross[s] = g;
            }
            o.crossedIn = crossedIn;
            o.residualIn = o.amountIn - crossedIn;
            if (o.residualIn != 0) anyResidual = true;
            if (crossedIn != 0 || gross != 0) {
                uint256 fee = _creditCross(batchId, trader, o, crossedIn, gross);
                fees[o.sellBase ? 1 : 0] += fee; // [0] base-token fees (quote sellers), [1] quote-token fees
            }
        }
        if (crossedBase != 0) {
            emit Crossed(
                batchId, asset, _shares(baseToken, crossedBase), mid, _shares(baseToken, fees[0]) + _shares(quoteToken, fees[1])
            );
        }
    }

    function _creditCross(uint256 batchId, address trader, Order storage o, uint256 crossedIn, uint256 gross)
        internal
        returns (uint256 fee)
    {
        address outToken = o.sellBase ? quoteToken : baseToken;
        fee = FullMath.mulDivRoundingUp(gross, CROSS_FEE_PIPS, 1e6);
        uint256 amountOut = gross - fee;
        _balances[trader][o.lockToken].locked -= crossedIn;
        _deliver(trader, o.recipient, outToken, amountOut);
        _balances[protocolFeeRecipient][outToken].available += fee;
        emit CrossFilled(batchId, trader, o.recipient, o.sellBase, crossedIn, amountOut, fee);
    }

    /// @dev Proceeds to the committer stay in its escrow (withdrawable); to anyone else they are transferred.
    function _deliver(address trader, address recipient, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (recipient == trader) _balances[trader][token].available += amount;
        else IERC20(token).safeTransfer(recipient, amount);
    }

    /// @dev Largest exact input whose parity gross output fits the hook's inventory of the output token:
    ///      fromSharesDown(toSharesDown(inventoryOut)) of the input, capped at the residual.
    function _fillableIn(Order storage o) internal view returns (uint256) {
        (address tokenIn, address tokenOut) = o.sellBase ? (baseToken, quoteToken) : (quoteToken, baseToken);
        (uint256 sptOut, uint8 decOut) = _ratio(tokenOut);
        (uint256 sptIn, uint8 decIn) = _ratio(tokenIn);
        uint256 maxShares = CanonicalShares.toSharesDown(parityHook.inventory(Currency.wrap(tokenOut)), sptOut, decOut);
        uint256 maxIn = CanonicalShares.fromSharesDown(maxShares, sptIn, decIn);
        return o.residualIn < maxIn ? o.residualIn : maxIn;
    }

    function _inToken(Order storage o) internal view returns (address) {
        return o.sellBase ? baseToken : quoteToken;
    }

    function _shares(address token, uint256 amount) internal view returns (uint256) {
        (uint256 spt, uint8 dec) = _ratio(token);
        return CanonicalShares.toSharesDown(amount, spt, dec);
    }

    function _ratio(address token) internal view returns (uint256 spt, uint8 decimals) {
        IWrapperAdapter adapter = IWrapperAdapter(parityHook.registry().adapterOf(token));
        (spt,) = adapter.ratio();
        decimals = adapter.tokenDecimals();
    }

    /// @dev Step 6: forfeit unrevealed commits to the protocolFeeRecipient, then unlock everything that remains
    ///      (including any unfilled residual) back to the committer.
    function _release(uint256 batchId) internal {
        address[] storage ps = _participants[batchId];
        for (uint256 i; i < ps.length; i++) {
            address trader = ps[i];
            Order storage o = _orders[batchId][trader];
            uint256 remaining = o.locked - o.crossedIn - _residualUsed[batchId][trader];
            Balance storage b = _balances[trader][o.lockToken];
            if (!o.revealed) {
                uint256 penalty = o.locked * FORFEIT_BPS / 1e4;
                remaining -= penalty;
                b.locked -= penalty;
                _balances[protocolFeeRecipient][o.lockToken].available += penalty;
                emit Forfeited(batchId, trader, o.lockToken, penalty);
            }
            b.locked -= remaining;
            b.available += remaining;
        }
    }

    function _eligible(Order storage o, uint256 mid) internal view returns (bool) {
        return o.valid && (o.sellBase ? mid >= o.limitPriceX18 : mid <= o.limitPriceX18);
    }

    function _supported(address token) internal view {
        if (token != baseToken && token != quoteToken) revert UnsupportedToken(token);
    }

    function _resolve(Currency c, int128 delta) internal {
        if (delta < 0) {
            poolManager.sync(c);
            IERC20(Currency.unwrap(c)).safeTransfer(address(poolManager), uint256(uint128(-delta)));
            poolManager.settle();
        } else if (delta > 0) {
            poolManager.take(c, address(this), uint256(uint128(delta)));
        }
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
