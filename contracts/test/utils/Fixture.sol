// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IssuerRegistry} from "../../src/IssuerRegistry.sol";
import {NyseCalendar} from "../../src/NyseCalendar.sol";
import {EASEligibility} from "../../src/EASEligibility.sol";
import {ParityHook} from "../../src/ParityHook.sol";
import {DarkCrossHook} from "../../src/DarkCrossHook.sol";
import {MockIssuerToken} from "../../src/mocks/MockIssuerToken.sol";
import {MockPriceOracle} from "../../src/mocks/MockPriceOracle.sol";
import {B20MultiplierAdapter} from "../../src/adapters/B20MultiplierAdapter.sol";
import {XStocksMultiplierAdapter} from "../../src/adapters/XStocksMultiplierAdapter.sol";
import {IParityHook} from "../../src/interfaces/IParityHook.sol";
import {MockEAS} from "../mocks/MockEAS.sol";
import {MockAttestationIndexer} from "../mocks/MockAttestationIndexer.sol";

/// @notice Shared deployment: PoolManager, routers, registry, calendar, eligibility (demoMode on), oracle, the two
///         mock issuer tokens at forced addresses (ordering chosen by mcbIsCurrency0()), adapters, ParityHook at a
///         0x20C8 address, the issuer/issuer pool at parity, and DarkCrossHook.
abstract contract Fixture is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant OPEN_TS = 1790692200; // Tue 2026-09-29 10:30 EDT
    uint256 internal constant CLOSED_TS = 1790424000; // Sat 2026-09-26
    bytes32 internal constant AAPL = "AAPL";
    bytes32 internal constant SCHEMA = keccak256("verified-country");
    address internal constant ATTESTER = 0x357458739F90461b99789350868CD7CF330Dd7EE;
    address internal constant LOW = address(uint160(0x1000) << 144);
    address internal constant HIGH = address(uint160(0x2000) << 144);
    address internal constant HOOK_ADDR = address(uint160(0x20C8) | (uint160(0x4444) << 144));

    IPoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal lpRouter;
    IssuerRegistry internal registry;
    NyseCalendar internal calendar;
    EASEligibility internal eligibility;
    MockEAS internal eas;
    MockAttestationIndexer internal indexer;
    MockPriceOracle internal oracle;
    MockIssuerToken internal mcb; // 6 decimals, multiplier 1.0125
    MockIssuerToken internal maaplx; // 18 decimals, multiplier 1.0
    B20MultiplierAdapter internal mcbAdapter;
    XStocksMultiplierAdapter internal maaplxAdapter;
    ParityHook internal hook;
    DarkCrossHook internal dark;
    PoolKey internal key;
    PoolId internal poolId;
    address internal treasury;

    address internal demo = makeAddr("demo");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function mcbIsCurrency0() internal pure virtual returns (bool);

    function mcbDecimals() internal pure virtual returns (uint8) {
        return 6;
    }

    function maaplxDecimals() internal pure virtual returns (uint8) {
        return 18;
    }

    function mcbMultiplier() internal pure virtual returns (uint256) {
        return 1.0125e18;
    }

    function maaplxMultiplier() internal pure virtual returns (uint256) {
        return 1e18;
    }

    function setUp() public virtual {
        vm.warp(OPEN_TS);
        treasury = address(this);
        manager = IPoolManager(address(new PoolManager(address(this))));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);
        registry = new IssuerRegistry(address(this));
        calendar = new NyseCalendar(address(this));
        eas = new MockEAS();
        indexer = new MockAttestationIndexer();
        eligibility = new EASEligibility(address(this), address(eas), address(indexer), SCHEMA, ATTESTER, "US");
        eligibility.setDemoMode(true);
        oracle = new MockPriceOracle(address(this));
        oracle.setPusher(address(this), true);

        (address mcbAt, address maaplxAt) = mcbIsCurrency0() ? (LOW, HIGH) : (HIGH, LOW);
        deployCodeTo(
            "MockIssuerToken.sol:MockIssuerToken",
            abi.encode("Mock Coinbase Apple", "mcbAAPL", mcbDecimals(), mcbMultiplier()),
            mcbAt
        );
        deployCodeTo(
            "MockIssuerToken.sol:MockIssuerToken",
            abi.encode("Mock Apple xStock", "mAAPLx", maaplxDecimals(), maaplxMultiplier()),
            maaplxAt
        );
        mcb = MockIssuerToken(mcbAt);
        maaplx = MockIssuerToken(maaplxAt);
        mcbAdapter = new B20MultiplierAdapter(address(mcb), AAPL);
        maaplxAdapter = new XStocksMultiplierAdapter(address(maaplx), AAPL);
        registry.add(address(mcbAdapter));
        registry.add(address(maaplxAdapter));

        deployCodeTo(
            "ParityHook.sol:ParityHook",
            abi.encode(address(manager), address(registry), address(eligibility), address(this)),
            HOOK_ADDR
        );
        hook = ParityHook(HOOK_ADDR);
        key = PoolKey(
            Currency.wrap(LOW), Currency.wrap(HIGH), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook))
        );
        poolId = key.toId();
        manager.initialize(key, paritySqrtPriceX96());

        dark = new DarkCrossHook(
            manager, hook, oracle, eligibility, address(mcb), address(maaplx), key, treasury, address(this)
        );
        eligibility.setTrustedRouter(address(swapRouter), true);
        eligibility.setTrustedRouter(address(dark), true);

        mcb.approve(address(hook), type(uint256).max);
        maaplx.approve(address(hook), type(uint256).max);
        mcb.approve(address(lpRouter), type(uint256).max);
        maaplx.approve(address(lpRouter), type(uint256).max);
        mcb.approve(address(swapRouter), type(uint256).max);
        maaplx.approve(address(swapRouter), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function c0IsMcb() internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(mcb);
    }

    function cur(MockIssuerToken t) internal pure returns (Currency) {
        return Currency.wrap(address(t));
    }

    /// @dev isqrt(floor(spt0 * 10^dec1 * 2^192 / (spt1 * 10^dec0))), INTERFACES.md §10.
    function paritySqrtPriceX96() internal view returns (uint160) {
        (MockIssuerToken t0, MockIssuerToken t1) = LOW == address(mcb) ? (mcb, maaplx) : (maaplx, mcb);
        uint256 num = t0.multiplier() * 10 ** t1.decimals();
        uint256 den = t1.multiplier() * 10 ** t0.decimals();
        return uint160(Math.sqrt(FullMath.mulDiv(num, 1 << 192, den)));
    }

    function one(MockIssuerToken t) internal view returns (uint256) {
        return 10 ** t.decimals();
    }

    function seedInventory(uint256 mcbAmount, uint256 maaplxAmount) internal {
        if (mcbAmount > 0) {
            mcb.mint(address(this), mcbAmount);
            hook.depositInventory(cur(mcb), mcbAmount);
        }
        if (maaplxAmount > 0) {
            maaplx.mint(address(this), maaplxAmount);
            hook.depositInventory(cur(maaplx), maaplxAmount);
        }
    }

    /// @dev LP around parity ±`halfWidth` ticks (rounded outward to spacing 10) using up to the given amounts.
    function seedLiquidity(uint256 mcbMax, uint256 maaplxMax, int24 halfWidth) internal returns (uint128 liquidity) {
        (, int24 tick,,) = manager.getSlot0(poolId);
        int24 lower = _floorTick(tick - halfWidth);
        int24 upper = _floorTick(tick + halfWidth) + 10;
        (uint256 a0, uint256 a1) = c0IsMcb() ? (mcbMax, maaplxMax) : (maaplxMax, mcbMax);
        (uint160 sqrtP,,,) = manager.getSlot0(poolId);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), a0, a1
        );
        mcb.mint(address(this), mcbMax + 10);
        maaplx.mint(address(this), maaplxMax + 10);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), 0), "");
    }

    function _floorTick(int24 t) internal pure returns (int24) {
        int24 c = t / 10;
        if (t < 0 && t % 10 != 0) c--;
        return c * 10;
    }

    function zfo(bool mcbIn) internal view returns (bool) {
        return mcbIn == c0IsMcb();
    }

    function fund(address who, uint256 mcbAmount, uint256 maaplxAmount) internal {
        if (mcbAmount > 0) mcb.mint(who, mcbAmount);
        if (maaplxAmount > 0) maaplx.mint(who, maaplxAmount);
        vm.startPrank(who);
        mcb.approve(address(swapRouter), type(uint256).max);
        maaplx.approve(address(swapRouter), type(uint256).max);
        mcb.approve(address(dark), type(uint256).max);
        maaplx.approve(address(dark), type(uint256).max);
        vm.stopPrank();
    }

    function hookData(address swapper, bytes32 uid) internal pure returns (bytes memory) {
        return abi.encode(uint8(1), swapper, uid);
    }

    /// @dev Swap through PoolSwapTest as `who`, naming `who` as swapper in hookData v1.
    function swapAs(address who, bool mcbIn, int256 amountSpecified) internal returns (BalanceDelta) {
        return swapAsWith(who, mcbIn, amountSpecified, hookData(who, 0));
    }

    function swapAsWith(address who, bool mcbIn, int256 amountSpecified, bytes memory data)
        internal
        returns (BalanceDelta d)
    {
        bool z = zfo(mcbIn);
        vm.prank(who);
        d = swapRouter.swap(
            key,
            SwapParams(z, amountSpecified, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            data
        );
    }

    /// @dev Swapper delta (amountIn paid, amountOut received) in (mcb/maaplx) orientation.
    function inOut(BalanceDelta d, bool mcbIn) internal view returns (uint256 paid, uint256 received) {
        bool z = zfo(mcbIn);
        int128 a = z ? d.amount0() : d.amount1();
        int128 b = z ? d.amount1() : d.amount0();
        paid = uint256(uint128(-a));
        received = uint256(uint128(b));
    }

    function quoteOf(bool mcbIn, int256 amountSpecified) internal view returns (IParityHook.Quote memory) {
        return hook.quote(key, zfo(mcbIn), amountSpecified);
    }
}
