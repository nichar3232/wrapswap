// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIssuerRegistry} from "./interfaces/IIssuerRegistry.sol";
import {IWrapperAdapter} from "./interfaces/IWrapperAdapter.sol";
import {IParityHook} from "./interfaces/IParityHook.sol";
import {IWrapSwapRouter} from "./interfaces/IWrapSwapRouter.sol";
import {CanonicalShares} from "./libraries/CanonicalShares.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @title ShareVault
/// @notice Custody side of Unison Pay. Issuer tokens deposited here back canonical-share credits on the Sui Pool;
///         the keeper attests each Deposited event on Sui and settles Sui withdrawals here, converting through the
///         ParityHook pool via WrapSwapRouter when the recipient wants the other issuer's wrapper.
/// @dev Solvency: `sharesOutstanding` mirrors Sui `Pool.total_shares`; `sharesHeld()` values custody at live adapter
///      ratios and must be >= sharesOutstanding. Deposits credit shares rounded down and withdrawals debit shares
///      rounded up, so rounding never erodes the backing.
contract ShareVault {
    using SafeERC20 for IERC20;

    struct Withdrawal {
        bytes32 commitment;
        address recipient;
        address targetIssuerToken;
        /// @dev Canonical shares the recipient must receive (face value, 1e18 = one share).
        uint256 shares;
        /// @dev Largest ParityHook fee the payer accepts, in basis points; a conversion above it is skipped.
        uint256 maxFeeBps;
    }

    event Deposited(
        bytes32 indexed commitment, address indexed issuerToken, uint256 amount, uint256 shares, bytes32 suiRecipientTag
    );
    /// @param sharesDebited canonical shares removed from custody: `shares` for a direct transfer, the share value of
    ///        the swap input (rounded up) for a conversion. The Sui escrow is debited by exactly this amount.
    event WithdrawalSettled(
        bytes32 indexed commitment,
        address indexed recipient,
        address indexed targetIssuerToken,
        address sourceIssuerToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 sharesDebited
    );
    event WithdrawalSkipped(bytes32 indexed commitment, bytes reason);
    event SettlementBatch(bytes32 indexed authHash, uint256 count, uint256 settled, uint256 sharesDebited);
    event KeeperSet(address indexed keeper, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner(address caller);
    error NotKeeper(address caller);
    error OnlySelf();
    error UnsupportedIssuer(address token);
    error ZeroAmount();
    error ZeroRecipient();
    error AlreadySettled(bytes32 commitment);
    error FeeAboveMax(uint256 feePips, uint256 maxFeeBps);
    error NotFillable(uint256 grossOut);
    error InsufficientCustody(address token, uint256 held, uint256 needed);

    /// @dev Bounded top-ups of the exact-input amount when the executed trade's fee exceeds the exact-output quote's.
    uint256 internal constant GROSS_UP_TRIES = 4;

    IIssuerRegistry public immutable registry;
    IParityHook public immutable hook;
    IWrapSwapRouter public immutable router;
    /// @dev The issuer/issuer ParityHook pool every conversion routes through.
    Currency public immutable currency0;
    Currency public immutable currency1;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;

    address public owner;
    mapping(address => bool) public isKeeper;
    /// @notice Mirror of Sui Pool.total_shares: credited on deposit, debited on settlement.
    uint256 public sharesOutstanding;
    uint256 public depositNonce;
    mapping(bytes32 => bool) public settled;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier onlyKeeper() {
        if (!isKeeper[msg.sender]) revert NotKeeper(msg.sender);
        _;
    }

    constructor(IIssuerRegistry registry_, IWrapSwapRouter router_, PoolKey memory key_, address owner_) {
        registry = registry_;
        router = router_;
        hook = IParityHook(address(key_.hooks));
        currency0 = key_.currency0;
        currency1 = key_.currency1;
        poolFee = key_.fee;
        tickSpacing = key_.tickSpacing;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---------------------------------------------------------------- admin

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------- user

    /// @notice Pulls `amount` of an issuer token into custody and credits its canonical-share value (rounded down) to
    ///         the Sui address `suiRecipientTag` once the keeper attests the event.
    function deposit(address issuerToken, uint256 amount, bytes32 suiRecipientTag) external returns (uint256 shares) {
        if (!_inPool(issuerToken) || !registry.active(issuerToken)) revert UnsupportedIssuer(issuerToken);
        if (amount == 0) revert ZeroAmount();
        (uint256 spt, uint8 dec) = _ratio(issuerToken);
        shares = CanonicalShares.toSharesDown(amount, spt, dec);
        if (shares == 0) revert ZeroAmount();

        IERC20(issuerToken).safeTransferFrom(msg.sender, address(this), amount);
        sharesOutstanding += shares;
        bytes32 commitment = keccak256(
            abi.encode(block.chainid, address(this), depositNonce++, msg.sender, issuerToken, amount, suiRecipientTag)
        );
        emit Deposited(commitment, issuerToken, amount, shares, suiRecipientTag);
    }

    // ---------------------------------------------------------------- keeper

    /// @notice Settles a window of Sui withdrawals. Each withdrawal is isolated: a failure emits WithdrawalSkipped with
    ///         the revert data and the keeper restores that credit on Sui; it never reverts the batch.
    /// @param auth opaque settlement reference from the keeper (the Sui batch it settles), hashed into SettlementBatch.
    function settleWithdrawals(Withdrawal[] calldata ws, bytes calldata auth) external onlyKeeper {
        uint256 ok;
        uint256 debited;
        for (uint256 i; i < ws.length; ++i) {
            try this.settleOne(ws[i]) returns (uint256 sharesDebited) {
                ok++;
                debited += sharesDebited;
            } catch (bytes memory reason) {
                emit WithdrawalSkipped(ws[i].commitment, reason);
            }
        }
        emit SettlementBatch(keccak256(auth), ws.length, ok, debited);
    }

    /// @dev External only so settleWithdrawals can isolate it with try/catch; callable by the vault itself only.
    function settleOne(Withdrawal calldata w) external returns (uint256 sharesDebited) {
        if (msg.sender != address(this)) revert OnlySelf();
        if (settled[w.commitment]) revert AlreadySettled(w.commitment);
        if (w.recipient == address(0)) revert ZeroRecipient();
        if (w.shares == 0) revert ZeroAmount();
        address target = w.targetIssuerToken;
        if (!_inPool(target) || !registry.active(target)) revert UnsupportedIssuer(target);
        settled[w.commitment] = true;

        (uint256 sptT, uint8 decT) = _ratio(target);
        uint256 net = CanonicalShares.fromSharesDown(w.shares, sptT, decT);
        if (net == 0) revert ZeroAmount();

        uint256 heldTarget = IERC20(target).balanceOf(address(this));
        if (heldTarget >= net) {
            // Custody already holds the recipient's wrapper: deliver share-for-share, no conversion, no fee.
            sharesDebited = w.shares;
            _debit(sharesDebited);
            IERC20(target).safeTransfer(w.recipient, net);
            emit WithdrawalSettled(w.commitment, w.recipient, target, target, net, net, sharesDebited);
            return sharesDebited;
        }

        address source = Currency.unwrap(currency0) == target ? Currency.unwrap(currency1) : Currency.unwrap(currency0);
        PoolKey memory key = poolKey();
        bool zeroForOne = Currency.unwrap(currency0) == source;

        // Gross-up: ParityHook charges its fee on output, so start from the hook's own exact-output quote for the net
        // amount (grossForNet + hook-output rounding), then re-quote the exact-input trade actually executed: the
        // off-hours fee depends on post-trade skew, which an exact-input trade moves by its (larger) input shares.
        uint256 amountIn = hook.quote(key, zeroForOne, int256(net)).amountIn;
        IParityHook.Quote memory q = hook.quote(key, zeroForOne, -int256(amountIn));
        for (uint256 i; q.amountOut < net && i < GROSS_UP_TRIES; ++i) {
            amountIn += FullMath.mulDivRoundingUp(amountIn, net - q.amountOut, q.amountOut == 0 ? 1 : q.amountOut) + 1;
            q = hook.quote(key, zeroForOne, -int256(amountIn));
        }
        if (uint256(q.fee.totalPips) > w.maxFeeBps * 100) revert FeeAboveMax(q.fee.totalPips, w.maxFeeBps);
        if (!q.fillable || q.amountOut < net) revert NotFillable(q.grossOut);
        uint256 heldSource = IERC20(source).balanceOf(address(this));
        if (heldSource < amountIn) revert InsufficientCustody(source, heldSource, amountIn);

        (uint256 sptS, uint8 decS) = _ratio(source);
        sharesDebited = CanonicalShares.toSharesUp(amountIn, sptS, decS);
        _debit(sharesDebited);

        IERC20(source).forceApprove(address(router), amountIn);
        uint256 out = router.swapExactIn(
            IWrapSwapRouter.ExactInputParams({
                key: key,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMin: uint128(net),
                recipient: w.recipient,
                deadline: block.timestamp,
                hookData: ""
            })
        );
        emit WithdrawalSettled(w.commitment, w.recipient, target, source, amountIn, out, sharesDebited);
    }

    // ---------------------------------------------------------------- views

    function poolKey() public view returns (PoolKey memory key) {
        key.currency0 = currency0;
        key.currency1 = currency1;
        key.fee = poolFee;
        key.tickSpacing = tickSpacing;
        key.hooks = IHooks(address(hook));
    }

    /// @notice Canonical shares held in custody, valued at live adapter ratios (rounded down per token).
    function sharesHeld() public view returns (uint256 shares) {
        shares = _heldShares(Currency.unwrap(currency0)) + _heldShares(Currency.unwrap(currency1));
    }

    /// @notice (shares held in custody, shares credited on Sui). Solvent iff held >= outstanding.
    function reserves() external view returns (uint256 held, uint256 outstanding) {
        return (sharesHeld(), sharesOutstanding);
    }

    /// @notice Hook-output gross-up quote for delivering `shares` of `target`: token input from the other issuer, the
    ///         canonical shares that input is worth (rounded up, what the Sui escrow is debited), and the fee in pips.
    function quoteWithdrawal(address target, uint256 shares)
        external
        view
        returns (uint256 amountIn, uint256 sharesDebited, uint24 feePips, bool direct)
    {
        (uint256 sptT, uint8 decT) = _ratio(target);
        uint256 net = CanonicalShares.fromSharesDown(shares, sptT, decT);
        if (IERC20(target).balanceOf(address(this)) >= net) return (net, shares, 0, true);
        address source = Currency.unwrap(currency0) == target ? Currency.unwrap(currency1) : Currency.unwrap(currency0);
        PoolKey memory key = poolKey();
        bool zeroForOne = Currency.unwrap(currency0) == source;
        amountIn = hook.quote(key, zeroForOne, int256(net)).amountIn;
        IParityHook.Quote memory q = hook.quote(key, zeroForOne, -int256(amountIn));
        for (uint256 i; q.amountOut < net && i < GROSS_UP_TRIES; ++i) {
            amountIn += FullMath.mulDivRoundingUp(amountIn, net - q.amountOut, q.amountOut == 0 ? 1 : q.amountOut) + 1;
            q = hook.quote(key, zeroForOne, -int256(amountIn));
        }
        (uint256 sptS, uint8 decS) = _ratio(source);
        return (amountIn, CanonicalShares.toSharesUp(amountIn, sptS, decS), q.fee.totalPips, false);
    }

    // ---------------------------------------------------------------- internals

    function _debit(uint256 shares) internal {
        // A withdrawal can never take more than has been credited.
        sharesOutstanding -= shares;
    }

    function _inPool(address token) internal view returns (bool) {
        return token == Currency.unwrap(currency0) || token == Currency.unwrap(currency1);
    }

    function _ratio(address token) internal view returns (uint256 spt, uint8 dec) {
        IWrapperAdapter adapter = IWrapperAdapter(registry.adapterOf(token));
        if (address(adapter) == address(0)) revert UnsupportedIssuer(token);
        spt = adapter.sharesPerToken();
        dec = adapter.tokenDecimals();
    }

    function _heldShares(address token) internal view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return 0;
        (uint256 spt, uint8 dec) = _ratio(token);
        return CanonicalShares.toSharesDown(bal, spt, dec);
    }
}
