// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IParityHook} from "./IParityHook.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {IEligibility} from "./IEligibility.sol";

/// @title IDarkCrossHook
/// @notice Commit-reveal batch crossing of one issuer pair (baseToken, quoteToken) of one asset at an IPriceOracle
///         midpoint no older than ORACLE_MAX_AGE (30 minutes).
/// @dev Not attached to any pool (no hook permission flags). Opposite sides cross directly at the mid; the crossed
///      volume pays CROSS_FEE_PIPS (1 bp) to protocolFeeRecipient (owner-settable), no skew. Every residual then falls
///      through, inside one PoolManager.unlock, into the ParityHook pool of the same pair as an exact-input inventory
///      fill at base + skew (to the LP), capped at the hook's available inventory; the unfilled part (and a residual
///      that cannot fill at the trader's limit) stays with the committer (unlocked to escrow), never filled free.
///      Proceeds go to the order's recipient: credited to escrow when it is the committer, transferred otherwise.
///      Batch = BATCH_BLOCKS blocks from batchOrigin: COMMIT_BLOCKS commit, REVEAL_BLOCKS reveal, remainder settle.
///      Prices are whole quote tokens per whole base token, 1e18 fixed point.
interface IDarkCrossHook {
    enum Phase {
        COMMIT,
        REVEAL,
        SETTLE
    }

    struct Order {
        bytes32 commitHash;
        address lockToken;
        uint256 locked;
        bytes32 attestationUid;
        bool revealed;
        bool valid;
        bool sellBase;
        uint256 amountIn;
        uint256 limitPriceX18;
        address recipient;
        uint256 crossedIn;
        uint256 residualIn;
    }

    struct BatchResult {
        bool settled;
        uint256 midX18;
        uint64 midUpdatedAt;
        uint256 crossedBase;
        uint256 crossedQuote;
        uint256 residualBaseIn;
        uint256 residualQuoteIn;
        uint32 participants;
    }

    /// @dev RevealRejected.reason: 1 WRONG_LOCK_TOKEN, 2 INSUFFICIENT_LOCK, 3 ZERO_AMOUNT, 4 ZERO_LIMIT

    event Funded(address indexed account, address indexed token, uint256 amount);
    event Withdrawn(address indexed account, address indexed token, uint256 amount);
    event Committed(
        uint256 indexed batchId, address indexed trader, bytes32 commitHash, address lockToken, uint256 locked
    );
    event Revealed(
        uint256 indexed batchId,
        address indexed trader,
        bool sellBase,
        uint256 amountIn,
        uint256 limitPriceX18,
        address recipient
    );
    event RevealRejected(uint256 indexed batchId, address indexed trader, uint8 reason);
    /// @notice Batch crossing summary: matchedShares = canonical shares of the crossed base amount; protocolFee =
    ///         canonical shares of the 1 bp cross fees (both sides).
    event Crossed(
        uint256 indexed batchId, bytes32 indexed asset, uint256 matchedShares, uint256 midpoint, uint256 protocolFee
    );
    /// @notice Per-trader crossed fill (token amounts; fee in the output token).
    event CrossFilled(
        uint256 indexed batchId,
        address indexed trader,
        address indexed recipient,
        bool sellBase,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    /// @notice Residual filled from ParityHook inventory: shares = canonical shares in; baseFee/skewFee in shares.
    event ResidualFilled(uint256 indexed batchId, address indexed user, uint256 shares, uint256 baseFee, uint256 skewFee);
    /// @notice Residual not filled (inventory short, limit not met, or dust): returned to the committer's escrow.
    event Unfilled(uint256 indexed batchId, address indexed user, uint256 sharesRefunded);
    event ProtocolFeeRecipientSet(address indexed recipient);
    event ResidualSkipped(uint256 indexed batchId, address indexed trader, bytes reason);
    event Forfeited(uint256 indexed batchId, address indexed trader, address token, uint256 amount);
    event BatchSettled(
        uint256 indexed batchId,
        uint256 midX18,
        uint64 midUpdatedAt,
        uint256 crossedBase,
        uint256 crossedQuote,
        uint256 residualBaseIn,
        uint256 residualQuoteIn,
        uint32 participants
    );

    error NotPoolManager();
    error Unauthorized(address caller);
    error UnsupportedToken(address token);
    error WrongPhase(Phase expected, Phase actual);
    error InvalidCommit();
    error AlreadyCommitted(uint256 batchId, address trader);
    error BatchFull(uint256 batchId);
    error UnknownCommit(uint256 batchId, address trader);
    error AlreadyRevealed(uint256 batchId, address trader);
    error CommitMismatch(uint256 batchId, address trader);
    error AlreadySettled(uint256 batchId);
    error BatchNotSettleable(uint256 batchId);
    error OracleStale(uint64 updatedAt, uint64 nowTs);
    error InsufficientEscrow(address token, uint256 available, uint256 requested);

    function BATCH_BLOCKS() external view returns (uint256);
    function COMMIT_BLOCKS() external view returns (uint256);
    function REVEAL_BLOCKS() external view returns (uint256);
    function MAX_PARTICIPANTS() external view returns (uint256);
    function CROSS_FEE_PIPS() external view returns (uint24);
    function FORFEIT_BPS() external view returns (uint256);
    function ORACLE_MAX_AGE() external view returns (uint64);

    function poolManager() external view returns (IPoolManager);
    function parityHook() external view returns (IParityHook);
    function oracle() external view returns (IPriceOracle);
    function eligibility() external view returns (IEligibility);
    function baseToken() external view returns (address);
    function quoteToken() external view returns (address);
    function parityPoolKey() external view returns (PoolKey memory);
    function asset() external view returns (bytes32);
    function protocolFeeRecipient() external view returns (address);
    /// @notice Owner-only.
    function setProtocolFeeRecipient(address recipient) external;
    function batchOrigin() external view returns (uint256);

    function currentBatch() external view returns (uint256 batchId, Phase phase, uint256 phaseEndsBlock);
    /// @notice keccak256(abi.encode(block.chainid, address(this), batchId, trader, sellBase, amountIn,
    ///         limitPriceX18, recipient, salt)). recipient == address(0) means the committer.
    function commitHashOf(
        uint256 batchId,
        address trader,
        bool sellBase,
        uint256 amountIn,
        uint256 limitPriceX18,
        address recipient,
        bytes32 salt
    ) external view returns (bytes32);

    function fund(address token, uint256 amount) external;
    function withdraw(address token, uint256 amount) external;
    function balances(address account, address token) external view returns (uint256 available, uint256 locked);

    /// @notice COMMIT phase only. Calls eligibility.enforce(msg.sender, attestationUid); on denial returns false and
    ///         changes no state (EligibilityDenied is emitted by the eligibility contract).
    function commit(bytes32 commitHash, address lockToken, uint256 lockAmount, bytes32 attestationUid)
        external
        returns (bool accepted);
    /// @notice REVEAL phase of the batch the caller committed to.
    function reveal(bool sellBase, uint256 amountIn, uint256 limitPriceX18, address recipient, bytes32 salt)
        external;
    /// @notice Permissionless. batchId < current, or batchId == current in SETTLE phase. Reverts OracleStale if the
    ///         mid is older than ORACLE_MAX_AGE at block.timestamp.
    function settle(uint256 batchId) external;

    function order(uint256 batchId, address trader) external view returns (Order memory);
    function participants(uint256 batchId) external view returns (address[] memory);
    function settled(uint256 batchId) external view returns (bool);
    function batchResult(uint256 batchId) external view returns (BatchResult memory);
}
