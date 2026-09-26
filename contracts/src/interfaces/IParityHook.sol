// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IIssuerRegistry} from "./IIssuerRegistry.sol";
import {INyseCalendar} from "./INyseCalendar.sol";
import {IEligibility} from "./IEligibility.sol";

/// @title IParityHook
/// @notice Settlement engine for pools of two real issuer tokens of the same underlying security.
/// @dev Pool: currency0/currency1 = the two issuer tokens (sorted), fee = DYNAMIC_FEE_FLAG, hooks = this.
///      Hook permissions: beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta (flags 0x20C8).
///      Inventory = ERC-6909 claims owned by this hook in the PoolManager, excluding feesAccrued.
///      beforeSwap fills all-or-nothing from inventory via BeforeSwapDelta; otherwise returns ZERO_DELTA and the
///      swap falls through to concentrated liquidity on the same pool, after which afterSwap enforces the peg guard.
///      Fees are pips (1e-6): total = min(BASE + ceil(SKEW * |skew|) + (open ? 0 : CLOSED), MAX).
///      amountSpecified < 0 = exact input, > 0 = exact output (pinned v4-core convention).
interface IParityHook {
    struct FeeBreakdown {
        uint24 basePips;
        uint24 skewPips;
        uint24 closedPips;
        uint24 totalPips;
        /// @dev (inv0Shares - inv1Shares) * 1e18 / (inv0Shares + inv1Shares), truncated toward zero; 0 if empty.
        int256 skewX18;
        bool marketOpen;
    }

    struct Quote {
        /// @dev true: inventory fill (PARITY). false: swap would fall through to the pool's liquidity.
        bool fillable;
        uint256 amountIn;
        uint256 amountOut;
        uint256 grossOut;
        uint256 shares;
        uint256 feeAmount;
        FeeBreakdown fee;
    }

    struct PegStatus {
        /// @dev Whole-token price of currency0 in currency1, 1e18 fixed point.
        uint256 poolPriceX18;
        uint256 parityPriceX18;
        uint256 deviationBps;
        bool tripped;
    }

    /// @dev InventoryChanged.reason
    /// 0 DEPOSIT, 1 WITHDRAW, 2 FILL_IN, 3 FILL_OUT
    /// @dev FallThrough.reason
    /// 1 INSUFFICIENT_INVENTORY, 2 DUST

    event PoolRegistered(
        PoolId indexed poolId, address indexed currency0, address indexed currency1, bytes32 underlying, int24 tickSpacing
    );
    event FeeQuoted(
        PoolId indexed poolId,
        uint24 totalPips,
        uint24 basePips,
        uint24 skewPips,
        uint24 closedPips,
        int256 skewX18,
        bool marketOpen
    );
    event InventoryFill(
        PoolId indexed poolId,
        address indexed swapper,
        address indexed sender,
        bool zeroForOne,
        bool exactInput,
        uint256 amountIn,
        uint256 amountOut,
        uint256 shares,
        uint256 feeAmount,
        uint24 feePips
    );
    event FallThrough(
        PoolId indexed poolId,
        address indexed swapper,
        address indexed sender,
        bool zeroForOne,
        uint8 reason,
        int128 amount0,
        int128 amount1,
        uint24 feePips,
        uint256 deviationBpsAfter
    );
    event InventoryChanged(
        address indexed currency, address indexed actor, uint8 indexed reason, int256 delta, uint256 inventoryAfter
    );
    event FeesSwept(address indexed currency, address indexed to, uint256 amount);
    event PegGuardStatus(
        PoolId indexed poolId, bool tripped, uint256 poolPriceX18, uint256 parityPriceX18, uint256 deviationBps
    );
    event KeeperSet(address indexed keeper, bool allowed);

    error NotPoolManager();
    error NotKeeper(address caller);
    error DynamicFeeRequired(uint24 fee);
    error UnsupportedPool(address currency0, address currency1);
    error AdapterUnhealthy(address token);
    error PegGuardTripped(PoolId poolId, uint256 deviationBps);
    error InsufficientInventory(address currency, uint256 available, uint256 requested);
    error InvalidHookData();
    error ZeroAmount();

    function BASE_FEE_PIPS() external view returns (uint24);
    function SKEW_FEE_PIPS() external view returns (uint24);
    function CLOSED_FEE_PIPS() external view returns (uint24);
    function MAX_FEE_PIPS() external view returns (uint24);
    function PEG_GUARD_BPS() external view returns (uint256);
    function HOOK_DATA_VERSION() external view returns (uint8);

    function poolManager() external view returns (IPoolManager);
    function registry() external view returns (IIssuerRegistry);
    function calendar() external view returns (INyseCalendar);
    function eligibility() external view returns (IEligibility);

    function isKeeper(address account) external view returns (bool);
    function setKeeper(address keeper, bool allowed) external;

    /// @notice Keeper-only. Pulls ERC20 from msg.sender and mints ERC-6909 claims to this hook.
    function depositInventory(Currency currency, uint256 amount) external;
    /// @notice Keeper-only. Burns claims and sends ERC20 to `to`. Cannot touch feesAccrued.
    function withdrawInventory(Currency currency, uint256 amount, address to) external;
    /// @notice Owner-only. Burns fee claims and sends ERC20 to `to`.
    function sweepFees(Currency currency, address to) external returns (uint256 amount);

    function inventory(Currency currency) external view returns (uint256);
    function inventoryShares(Currency currency) external view returns (uint256);
    function feesAccrued(Currency currency) external view returns (uint256);

    function feeBreakdown(PoolKey calldata key) external view returns (FeeBreakdown memory);
    function quote(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        external
        view
        returns (Quote memory);
    function pegStatus(PoolKey calldata key) external view returns (PegStatus memory);
    /// @notice Last status emitted by checkPeg for this pool.
    function pegTripped(PoolId poolId) external view returns (bool);
    /// @notice Permissionless. Emits PegGuardStatus only when the tripped state differs from pegTripped(poolId).
    function checkPeg(PoolKey calldata key) external returns (bool tripped);
}
