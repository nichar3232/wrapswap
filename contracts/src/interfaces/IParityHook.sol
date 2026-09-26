// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IIssuerRegistry} from "./IIssuerRegistry.sol";
import {IEligibility} from "./IEligibility.sol";

/// @title IParityHook
/// @notice Settlement engine for pools of two real issuer tokens of the same underlying security.
/// @dev Pool: currency0/currency1 = the two issuer tokens (sorted), fee = DYNAMIC_FEE_FLAG, hooks = this.
///      Hook permissions: beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta (flags 0x20C8).
///      Inventory = ERC-6909 claims owned by this hook in the PoolManager; fees stay in it (100% to the LP).
///      beforeSwap fills all-or-nothing from inventory via BeforeSwapDelta; otherwise returns ZERO_DELTA and the
///      swap falls through to concentrated liquidity on the same pool, after which afterSwap enforces the peg guard.
///      Fees are pips (1e-6): total = baseFeePips + skewPips. baseFeePips is owner-settable (default 200 = 2 bps).
///      skewPips = min(ceil(SKEW_FEE_PIPS * |post-trade skew|), SKEW_FEE_CAP_PIPS) when the trade increases |skew|,
///      else 0. skew = (inv0Shares - inv1Shares) / (inv0Shares + inv1Shares) in canonical shares. The post-trade skew
///      moves the trade's canonical shares one-for-one (exact input: input shares; exact output: net output shares).
///      amountSpecified < 0 = exact input, > 0 = exact output (pinned v4-core convention).
///      hookData: empty, or abi.encode(uint8 1, address swapper, bytes32 uid) (96 bytes), or
///      abi.encode(uint8 2, address swapper, bytes32 uid, address recipient) (128 bytes; recipient reported in Converted).
interface IParityHook {
    struct FeeBreakdown {
        uint24 basePips;
        uint24 skewPips;
        uint24 totalPips;
        /// @dev Pre-trade (inv0Shares - inv1Shares) * 1e18 / (inv0Shares + inv1Shares), truncated toward zero; 0 if empty.
        int256 skewX18;
        /// @dev Post-trade skew, same definition (equals skewX18 in the trade-less feeBreakdown view).
        int256 postSkewX18;
        /// @dev true when the trade does not increase |skew| (skewPips == 0).
        bool reducesImbalance;
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
    /// @notice One inventory fill. Amounts: amountIn in `from` raw units; sharesOut, baseFee, skewFee in canonical
    ///         shares (1e18) with sharesIn = sharesOut + baseFee + skewFee; postSkew 1e18 signed.
    event Converted(
        bytes32 indexed asset,
        address indexed from,
        address indexed to,
        address sender,
        address recipient,
        uint256 amountIn,
        uint256 sharesOut,
        uint256 baseFee,
        uint256 skewFee,
        int256 postSkew
    );
    event BaseFeeSet(uint24 basePips);
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
    error BaseFeeTooHigh(uint24 basePips, uint24 max);

    function DEFAULT_BASE_FEE_PIPS() external view returns (uint24);
    function MAX_BASE_FEE_PIPS() external view returns (uint24);
    function SKEW_FEE_PIPS() external view returns (uint24);
    function SKEW_FEE_CAP_PIPS() external view returns (uint24);
    function PEG_GUARD_BPS() external view returns (uint256);
    function HOOK_DATA_VERSION() external view returns (uint8);

    function poolManager() external view returns (IPoolManager);
    function registry() external view returns (IIssuerRegistry);
    function eligibility() external view returns (IEligibility);

    function baseFeePips() external view returns (uint24);
    /// @notice Owner-only. basePips <= MAX_BASE_FEE_PIPS.
    function setBaseFeePips(uint24 basePips) external;

    function isKeeper(address account) external view returns (bool);
    function setKeeper(address keeper, bool allowed) external;

    /// @notice Keeper-only. Pulls ERC20 from msg.sender and mints ERC-6909 claims to this hook.
    function depositInventory(Currency currency, uint256 amount) external;
    /// @notice Keeper-only. Burns claims and sends ERC20 to `to` (inventory includes retained fees).
    function withdrawInventory(Currency currency, uint256 amount, address to) external;

    function inventory(Currency currency) external view returns (uint256);
    function inventoryShares(Currency currency) external view returns (uint256);

    /// @notice Trade-less view: the fee a marginal |skew|-increasing trade pays now (skew at the current skew).
    function feeBreakdown(PoolKey calldata key) external view returns (FeeBreakdown memory);
    /// @notice Exact-input Convert quote from inventory for `amountIn` of `fromWrapper` into `toWrapper` (both registered
    ///         for `asset`). sharesOut, baseFee, skewFee in canonical shares (sharesIn = sharesOut + baseFee + skewFee).
    function quote(bytes32 asset, address fromWrapper, address toWrapper, uint256 amountIn)
        external
        view
        returns (uint256 sharesOut, uint256 baseFee, uint256 skewFee, int256 postSkew, bool reducesImbalance);
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
