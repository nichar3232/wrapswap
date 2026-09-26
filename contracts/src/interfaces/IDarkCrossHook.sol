// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IParityHook} from "./IParityHook.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {IEligibility} from "./IEligibility.sol";

/// @title IDarkCrossHook
/// @notice Commit-reveal batch crossing of one issuer pair (baseToken, quoteToken) at an IPriceOracle midpoint.
/// @dev Not attached to any pool (no hook permission flags). settle() runs inside one PoolManager.unlock: crossed
///      amounts move between escrow balances; each residual with routeResidual=true is swapped exact-input into the
///      ParityHook pool of the same pair, with ParityHook hookData v1 naming the trader as swapper.
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
        bool routeResidual;
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
        bool routeResidual
    );
    event RevealRejected(uint256 indexed batchId, address indexed trader, uint8 reason);
    event Crossed(
        uint256 indexed batchId,
        address indexed trader,
        bool sellBase,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        uint256 midX18
    );
    event ResidualRouted(
        uint256 indexed batchId,
        address indexed trader,
        PoolId indexed poolId,
        bool sellBase,
        uint256 amountIn,
        uint256 amountOut
    );
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
    function treasury() external view returns (address);
    function batchOrigin() external view returns (uint256);

    function currentBatch() external view returns (uint256 batchId, Phase phase, uint256 phaseEndsBlock);
    /// @notice keccak256(abi.encode(block.chainid, address(this), batchId, trader, sellBase, amountIn,
    ///         limitPriceX18, routeResidual, salt)).
    function commitHashOf(
        uint256 batchId,
        address trader,
        bool sellBase,
        uint256 amountIn,
        uint256 limitPriceX18,
        bool routeResidual,
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
    function reveal(bool sellBase, uint256 amountIn, uint256 limitPriceX18, bool routeResidual, bytes32 salt)
        external;
    /// @notice Permissionless. batchId < current, or batchId == current in SETTLE phase. Reverts OracleStale if the
    ///         mid is older than ORACLE_MAX_AGE at block.timestamp.
    function settle(uint256 batchId) external;

    function order(uint256 batchId, address trader) external view returns (Order memory);
    function participants(uint256 batchId) external view returns (address[] memory);
    function settled(uint256 batchId) external view returns (bool);
    function batchResult(uint256 batchId) external view returns (BatchResult memory);
}
