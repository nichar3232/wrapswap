// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IssuerRegistry} from "../src/IssuerRegistry.sol";
import {CanonicalStock} from "../src/CanonicalStock.sol";
import {StaticAdapter} from "../src/adapters/StaticAdapter.sol";
import {NyseCalendar} from "../src/NyseCalendar.sol";
import {ParityHook} from "../src/ParityHook.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

contract TestIssuer is ERC20 {
    constructor() ERC20("Issuer", "ISS") {}

    function mint(address a, uint256 n) external {
        _mint(a, n);
    }
}

contract TestIssuer8 is TestIssuer {
    function decimals() public pure override returns (uint8) {
        return 8;
    }
}

contract ParityVaultTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    TestIssuer token;
    TestIssuer token2;
    StaticAdapter adapter;
    IssuerRegistry registry;
    CanonicalStock vault;
    NyseCalendar calendar;
    ParityHook hook;
    PoolManager manager;
    PoolSwapTest router;
    PoolModifyLiquidityTest liquidity;
    PoolKey key;

    function setUp() public {
        vm.warp(1784037600);
        token = new TestIssuer();
        token2 = new TestIssuer();
        registry = new IssuerRegistry(address(this));
        adapter = new StaticAdapter(address(token), "issuer", 1e18, address(this));
        registry.add(address(adapter));
        registry.add(address(new StaticAdapter(address(token2), "issuer2", 1e18, address(this))));
        vault = new CanonicalStock(registry, address(this));
        calendar = new NyseCalendar(address(this));
        manager = new PoolManager(address(this));
        router = new PoolSwapTest(manager);
        liquidity = new PoolModifyLiquidityTest(manager);
        bytes memory code = abi.encodePacked(
            type(ParityHook).creationCode, abi.encode(manager, registry, vault, calendar, address(this))
        );
        bytes32 salt;
        for (uint256 i;; i++) {
            salt = bytes32(i);
            address expected = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code)))))
            );
            if (uint160(expected) & ((1 << 14) - 1) == (1 << 13) | (1 << 7) | (1 << 6) | (1 << 3)) break;
        }
        hook = new ParityHook{salt: salt}(manager, registry, vault, calendar, address(this));
        (Currency c0, Currency c1) = address(token) < address(vault)
            ? (Currency.wrap(address(token)), Currency.wrap(address(vault)))
            : (Currency.wrap(address(vault)), Currency.wrap(address(token)));
        key = PoolKey(c0, c1, 0x800000, 60, IHooks(address(hook)));
        manager.initialize(key, uint160(1 << 96));
        token.mint(address(this), 100000e18);
        token2.mint(address(this), 100000e18);
        token.approve(address(vault), type(uint256).max);
        token2.approve(address(vault), type(uint256).max);
        vault.mint(address(token), 10000e18, address(this));
        for (uint256 i; i < 2; i++) {
            ERC20 t = i == 0 ? ERC20(address(token)) : ERC20(address(vault));
            t.approve(address(hook), type(uint256).max);
            t.approve(address(router), type(uint256).max);
            t.approve(address(liquidity), type(uint256).max);
            hook.depositInventory(Currency.wrap(address(t)), 1000e18);
        }
    }

    function _swap(bool sellIssuer, int256 n) internal returns (BalanceDelta) {
        bool z = (Currency.unwrap(key.currency0) == address(token)) == sellIssuer;
        return router.swap(
            key,
            SwapParams(z, n, z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function testEightDecimalHookExactInOutAndGuard() public {
        TestIssuer8 t = new TestIssuer8();
        registry.add(address(new StaticAdapter(address(t), "eight", 1e18, address(this))));
        t.mint(address(this), 10000e8);
        t.approve(address(hook), type(uint256).max);
        t.approve(address(router), type(uint256).max);
        hook.depositInventory(Currency.wrap(address(t)), 1000e8);
        bool tFirst = address(t) < address(vault);
        PoolKey memory k = PoolKey(
            Currency.wrap(tFirst ? address(t) : address(vault)),
            Currency.wrap(tFirst ? address(vault) : address(t)),
            0x800000,
            60,
            IHooks(address(hook))
        );
        uint160 sqrt = tFirst ? uint160((1 << 96) * 1e5) : uint160(uint256(1 << 96) / 1e5);
        manager.initialize(k, sqrt);
        uint256 beforeBal = vault.balanceOf(address(this));
        uint256 fee = hook.feeBpsNow(address(t));
        router.swap(
            k,
            SwapParams(tFirst, -int256(10e8), tFirst ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(vault.balanceOf(address(this)) - beforeBal, 10e18 * (10000 - fee) / 10000);
        beforeBal = t.balanceOf(address(this));
        router.swap(
            k,
            SwapParams(!tFirst, int256(1e8), !tFirst ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        assertEq(t.balanceOf(address(this)) - beforeBal, 1e8);
        // An empty, correctly priced curve returns zero without tripping the decimal-adjusted peg guard.
        hook.withdrawInventory(Currency.wrap(address(vault)), hook.inventory(Currency.wrap(address(vault))));
        router.swap(
            k,
            SwapParams(tFirst, -int256(1e8), tFirst ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function testEightDecimalIssuer() public {
        TestIssuer8 t = new TestIssuer8();
        registry.add(address(new StaticAdapter(address(t), "eight", 2e18, address(this))));
        t.mint(address(this), 100e8);
        t.approve(address(vault), type(uint256).max);
        assertEq(vault.mint(address(t), 10e8, address(this)), 20e18);
        assertEq(vault.redeem(address(t), 20e18, address(this)), 999500000);
    }

    function testProviderCannotImpairBacking() public {
        vault.setInventoryProvider(address(this), true);
        vm.expectRevert("underbacked");
        vault.pullInventory(address(token), 1);
    }

    function testMintRedeemBothAndFee() public {
        uint256 u = vault.mint(address(token2), 100e18, address(this));
        assertEq(u, 100e18);
        uint256 out = vault.redeem(address(token2), 100e18, address(this));
        assertEq(out, 99.95e18);
        vault.sweepFees(address(token2), address(this));
        (, uint256 shares, uint256 supply) = vault.backing();
        assertGe(shares, supply);
    }

    function testFuzzBacking(uint96 a, uint96 b) public {
        a = uint96(bound(a, 1e10, 1000e18));
        b = uint96(bound(b, 1e10, 1000e18));
        vault.mint(address(token), a, address(this));
        vault.mint(address(token2), b, address(this));
        vault.redeem(address(token), a, address(this));
        vault.redeem(address(token2), b, address(this));
        (, uint256 shares, uint256 supply) = vault.backing();
        assertGe(shares, supply);
    }

    function testPaused() public {
        registry.pause(address(adapter));
        vm.expectRevert();
        vault.mint(address(token), 1e18, address(this));
    }

    function testShortInventory() public {
        vm.expectRevert(
            abi.encodeWithSelector(CanonicalStock.InsufficientIssuerInventory.selector, address(token2), 0, 1e18)
        );
        vault.redeem(address(token2), 1e18, address(this));
    }

    function testMultiplierReprices() public {
        adapter.setSharesPerToken(2e18);
        assertEq(vault.mint(address(token), 1e18, address(this)), 2e18);
        uint256 beforeBal = vault.balanceOf(address(this));
        uint256 fee = hook.feeBpsNow(address(token));
        _swap(true, -int256(1e18));
        assertEq(vault.balanceOf(address(this)) - beforeBal, 2e18 * (10000 - fee) / 10000);
    }

    function testExactInputBothDirections() public {
        uint256 fee = hook.feeBpsNow(address(token));
        uint256 beforeBal = vault.balanceOf(address(this));
        _swap(true, -int256(10e18));
        assertEq(vault.balanceOf(address(this)) - beforeBal, 10e18 * (10000 - fee) / 10000);
        fee = hook.feeBpsNow(address(token));
        beforeBal = token.balanceOf(address(this));
        _swap(false, -int256(10e18));
        assertEq(token.balanceOf(address(this)) - beforeBal, 10e18 * (10000 - fee) / 10000);
    }

    function testExactOutputBothDirections() public {
        uint256 b = vault.balanceOf(address(this));
        _swap(true, int256(10e18));
        assertEq(vault.balanceOf(address(this)) - b, 10e18);
        b = token.balanceOf(address(this));
        _swap(false, int256(10e18));
        assertEq(token.balanceOf(address(this)) - b, 10e18);
    }

    function testFeeSweepClaims() public {
        _swap(true, -int256(10e18));
        Currency c = Currency.wrap(address(vault));
        uint256 fee = hook.feeAccrued(c);
        assertGt(fee, 0);
        uint256 beforeBal = vault.balanceOf(address(this));
        hook.sweepFees(c, address(this));
        assertEq(vault.balanceOf(address(this)) - beforeBal, fee);
        assertEq(hook.feeAccrued(c), 0);
    }

    function testSkewMonotonicAndHours() public {
        uint256 initial = hook.feeBpsNow(address(token));
        hook.withdrawInventory(Currency.wrap(address(token)), 500e18);
        uint256 half = hook.feeBpsNow(address(token));
        hook.withdrawInventory(Currency.wrap(address(token)), 400e18);
        assertGe(hook.feeBpsNow(address(token)), half);
        assertGe(half, initial);
        vm.warp(1784376000);
        assertFalse(calendar.isOpen(block.timestamp));
        assertGe(hook.feeBpsNow(address(token)), 12);
    }

    function testFallbackCurveAndFeeOverride() public {
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(-600, 600, 10000e18, 0), "");
        hook.withdrawInventory(Currency.wrap(address(vault)), 1000e18);
        uint256 b = vault.balanceOf(address(this));
        _swap(true, -int256(1e18));
        assertGt(vault.balanceOf(address(this)), b);
        (,,, uint24 storedFee) = IPoolManager(address(manager)).getSlot0(key.toId());
        assertEq(storedFee, 0);
        assertEq(hook.feeAccrued(Currency.wrap(address(vault))), 0);
    }

    function testGuardOffParity() public {
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(-60000, 60000, 5000e18, 0), "");
        hook.withdrawInventory(Currency.wrap(address(vault)), 1000e18);
        _swap(true, -int256(100e18));
        vm.expectRevert();
        _swap(true, -int256(1e18));
    }

    function testRejectStaticPool() public {
        key.fee = 500;
        vm.expectRevert();
        manager.initialize(key, uint160(1 << 96));
    }

    function testCallbackProtected() public {
        vm.expectRevert();
        hook.beforeInitialize(address(this), key, uint160(1 << 96));
    }

    function testCalendar() public {
        assertTrue(calendar.isOpen(1784037600));
        assertFalse(calendar.isOpen(1784376000));
        assertFalse(calendar.isOpen(1798210800)); // Christmas 2026, 15:00 UTC
        uint256 beforeGas = gasleft();
        uint256 next = calendar.nextTransition(1784376000);
        assertGt(next, 1784376000);
        assertLt(beforeGas - gasleft(), 500000);
        assertTrue(calendar.isOpen(next));
    }

    function testDstBoundary() public {
        assertFalse(calendar.isOpen(1772978400));
        /* Sunday March 8 */
        assertTrue(calendar.isOpen(1773063000));
        /* Monday March 9 13:30 UTC */
        assertFalse(calendar.isOpen(1773062999));
        assertTrue(calendar.isOpen(1793629800));
        /* Nov 2 14:30 UTC */
        assertFalse(calendar.isOpen(1793629799));
    }
}
