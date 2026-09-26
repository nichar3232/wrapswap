// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IIssuerRegistry} from "../src/interfaces/IIssuerRegistry.sol";
import {Fixture} from "./utils/Fixture.sol";
import {WrapSwapRouter} from "../src/WrapSwapRouter.sol";
import {ShareVault} from "../src/ShareVault.sol";
import {IParityHook} from "../src/interfaces/IParityHook.sol";
import {CanonicalShares} from "../src/libraries/CanonicalShares.sol";

abstract contract ShareVaultBase is Fixture {
    WrapSwapRouter internal router;
    ShareVault internal vault;

    bytes32 constant SUI_A = bytes32(uint256(0xA11CE));
    bytes32 constant SUI_B = bytes32(uint256(0xB0B));
    address internal keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        router = new WrapSwapRouter(manager);
        eligibility.setTrustedRouter(address(router), true);
        seedInventory(8000e6, 12150e18);
        vault = new ShareVault(registry, router, key, address(this));
        vault.setKeeper(keeper, true);
        fundVault(alice, mcb, 100e6);
        fundVault(bob, maaplx, 50e18);
    }

    function fundVault(address who, MockToken t, uint256 amount) internal {
        t.mint(who, amount);
        vm.prank(who);
        t.approve(address(vault), type(uint256).max);
    }

    function depositAs(address who, MockToken t, uint256 amount, bytes32 tag) internal returns (uint256) {
        vm.prank(who);
        return vault.deposit(address(t), amount, tag);
    }

    function w(bytes32 c, address to, MockToken target, uint256 shares, uint256 maxFeeBps)
        internal
        pure
        returns (ShareVault.Withdrawal memory)
    {
        return ShareVault.Withdrawal(c, to, address(target), shares, maxFeeBps);
    }

    function settle(ShareVault.Withdrawal[] memory ws) internal {
        vm.prank(keeper);
        vault.settleWithdrawals(ws, "sui-batch-1");
    }

    function one1(ShareVault.Withdrawal memory a) internal pure returns (ShareVault.Withdrawal[] memory ws) {
        ws = new ShareVault.Withdrawal[](1);
        ws[0] = a;
    }

    function assertSolvent() internal view {
        (uint256 held, uint256 outstanding) = vault.reserves();
        assertGe(held, outstanding, "reserves invariant");
    }

    // ---------------------------------------------------------------- deposit

    function test_deposit_creditsCanonicalShares() public {
        uint256 expected = CanonicalShares.toSharesDown(100e6, 1.0125e18, 6);
        vm.expectEmit(false, true, false, true, address(vault));
        emit ShareVault.Deposited(bytes32(0), address(mcb), 100e6, expected, SUI_A);
        uint256 shares = depositAs(alice, mcb, 100e6, SUI_A);
        assertEq(shares, 101.25e18);
        assertEq(mcb.balanceOf(address(vault)), 100e6);
        assertEq(vault.sharesOutstanding(), shares);
        (uint256 held, uint256 outstanding) = vault.reserves();
        assertEq(held, outstanding);
    }

    function test_deposit_commitmentsAreUnique() public {
        vm.recordLogs();
        depositAs(alice, mcb, 10e6, SUI_A);
        depositAs(alice, mcb, 10e6, SUI_A);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = ShareVault.Deposited.selector;
        bytes32[2] memory c;
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) c[n++] = logs[i].topics[1];
        }
        assertEq(n, 2);
        assertTrue(c[0] != c[1]);
    }

    function test_deposit_rejectsUnknownToken() public {
        MockToken other = new MockToken("x", "x", 18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.UnsupportedIssuer.selector, address(other)));
        vault.deposit(address(other), 1e18, SUI_A);
    }

    function test_deposit_rejectsZero() public {
        vm.prank(alice);
        vm.expectRevert(ShareVault.ZeroAmount.selector);
        vault.deposit(address(mcb), 0, SUI_A);
    }

    // ---------------------------------------------------------------- withdrawals

    function test_withdraw_directWhenHeld() public {
        depositAs(bob, maaplx, 50e18, SUI_B);
        address carol = makeAddr("carol");
        settle(one1(w("c1", carol, maaplx, 3e18, 0)));
        assertEq(maaplx.balanceOf(carol), 3e18);
        assertEq(vault.sharesOutstanding(), 47e18);
        assertTrue(vault.settled("c1"));
        assertSolvent();
    }

    function test_withdraw_crossIssuerThroughRouterWithGrossUp() public {
        depositAs(alice, mcb, 100e6, SUI_A); // custody holds only mcbAAPL
        address carol = makeAddr("carol");
        uint256 shares = 3e18;
        (uint256 amountIn, uint256 sharesDebited, uint24 feePips, bool direct) = vault.quoteWithdrawal(address(maaplx), shares);
        assertFalse(direct);
        assertGt(feePips, 0);
        IParityHook.Quote memory q = quoteOf(true, int256(3e18));
        assertEq(amountIn, q.amountIn, "quote is the hook's exact-output quote");
        assertEq(sharesDebited, CanonicalShares.toSharesUp(q.amountIn, 1.0125e18, 6));
        assertGt(sharesDebited, shares, "gross-up debits more than face value");

        uint256 before = vault.sharesOutstanding();
        uint256 mcbBefore = mcb.balanceOf(address(vault));
        settle(one1(w("c2", carol, maaplx, shares, 25)));
        assertGe(maaplx.balanceOf(carol), 3e18, "recipient receives at least face value");
        assertEq(mcbBefore - mcb.balanceOf(address(vault)), amountIn);
        assertEq(before - vault.sharesOutstanding(), sharesDebited);
        assertEq(mcb.balanceOf(address(router)), 0);
        assertSolvent();
    }

    function test_withdraw_skipWhenFeeAboveMax_keepsBatchAlive() public {
        depositAs(alice, mcb, 100e6, SUI_A);
        depositAs(bob, maaplx, 5e18, SUI_B);
        address carol = makeAddr("carol");
        address dave = makeAddr("dave");
        // The fee of the trade the vault would actually execute (size-dependent under the skew model).
        (,, uint24 tradeFeePips, bool direct) = vault.quoteWithdrawal(address(maaplx), 10e18);
        assertFalse(direct);
        assertGe(tradeFeePips, 200);

        ShareVault.Withdrawal[] memory ws = new ShareVault.Withdrawal[](2);
        // maxFeeBps below the live fee forces a skip of the conversion...
        ws[0] = w("skip", carol, maaplx, 10e18, 1);
        // ...while a direct withdrawal in the same batch still settles.
        ws[1] = w("ok", dave, mcb, 2e18, 0);
        uint256 before = vault.sharesOutstanding();

        vm.expectEmit(true, false, false, true, address(vault));
        emit ShareVault.WithdrawalSkipped(
            "skip", abi.encodeWithSelector(ShareVault.FeeAboveMax.selector, uint256(tradeFeePips), uint256(1))
        );
        settle(ws);

        assertEq(maaplx.balanceOf(carol), 0);
        assertFalse(vault.settled("skip"), "a skipped withdrawal can be retried");
        assertEq(mcb.balanceOf(dave), CanonicalShares.fromSharesDown(2e18, 1.0125e18, 6));
        assertEq(before - vault.sharesOutstanding(), 2e18, "only the settled withdrawal is debited");
        assertSolvent();
    }

    function test_withdraw_skipsDuplicateCommitment() public {
        depositAs(bob, maaplx, 50e18, SUI_B);
        settle(one1(w("dup", bob, maaplx, 1e18, 0)));
        vm.expectEmit(true, false, false, true, address(vault));
        emit ShareVault.WithdrawalSkipped("dup", abi.encodeWithSelector(ShareVault.AlreadySettled.selector, bytes32("dup")));
        settle(one1(w("dup", bob, maaplx, 1e18, 0)));
        assertEq(vault.sharesOutstanding(), 49e18);
    }

    function test_withdraw_skipsWhenCustodyShort() public {
        depositAs(bob, maaplx, 1e18, SUI_B);
        settle(one1(w("big", bob, mcb, 1000e18, 100)));
        assertEq(vault.sharesOutstanding(), 1e18);
        assertEq(mcb.balanceOf(bob), 0);
        assertSolvent();
    }

    function test_withdraw_skipsZeroRecipient() public {
        depositAs(bob, maaplx, 5e18, SUI_B);
        vm.expectEmit(true, false, false, true, address(vault));
        emit ShareVault.WithdrawalSkipped("z", abi.encodeWithSelector(ShareVault.ZeroRecipient.selector));
        settle(one1(w("z", address(0), maaplx, 1e18, 0)));
    }

    function test_settle_onlyKeeper() public {
        ShareVault.Withdrawal[] memory ws;
        vm.expectRevert(abi.encodeWithSelector(ShareVault.NotKeeper.selector, address(this)));
        vault.settleWithdrawals(ws, "");
    }

    function test_settleOne_onlySelf() public {
        vm.prank(keeper);
        vm.expectRevert(ShareVault.OnlySelf.selector);
        vault.settleOne(w("x", bob, maaplx, 1e18, 0));
    }

    function test_setKeeper_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ShareVault.NotOwner.selector, alice));
        vault.setKeeper(alice, true);
    }

    function testFuzz_depositWithdrawStaysSolvent(uint96 mcbIn, uint96 sharesOut) public {
        uint256 amount = bound(uint256(mcbIn), 1e6, 1000e6);
        mcb.mint(alice, amount);
        uint256 credited = depositAs(alice, mcb, amount, SUI_A);
        uint256 shares = bound(uint256(sharesOut), 1e12, credited / 2);
        settle(one1(w("f", bob, maaplx, shares, 25)));
        assertSolvent();
        assertLe(vault.sharesOutstanding(), credited);
    }
}

// Fixture's MockIssuerToken, aliased for brevity.
import {MockIssuerToken as MockToken} from "../src/mocks/MockIssuerToken.sol";

contract ShareVaultMcbCurrency0Test is ShareVaultBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract ShareVaultMcbCurrency1Test is ShareVaultBase {
    function mcbIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

/// @notice Runs against a fork of the live Unichain Sepolia deployment (real PoolManager, ParityHook, router, tokens).
///         Skipped unless UNICHAIN_SEPOLIA_RPC_URL is set and a manifest is available, either the resolved
///         deployments/unichain-sepolia.resolved.json or passed inline as SHARE_VAULT_MANIFEST_JSON.
contract ShareVaultUnichainForkTest is Test {
    ShareVault internal vault;
    MockToken internal mcb;
    MockToken internal maaplx;
    address internal tokenOwner;
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        string memory rpc = vm.envOr("UNICHAIN_SEPOLIA_RPC_URL", string(""));
        string memory j = vm.envOr("SHARE_VAULT_MANIFEST_JSON", string(""));
        if (bytes(j).length == 0 && vm.exists("deployments/unichain-sepolia.resolved.json")) {
            j = vm.readFile("deployments/unichain-sepolia.resolved.json");
        }
        if (bytes(rpc).length == 0 || bytes(j).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        require(block.chainid == 1301, "not Unichain Sepolia");
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(vm.parseJsonAddress(j, ".pool.key.currency0")),
            currency1: Currency.wrap(vm.parseJsonAddress(j, ".pool.key.currency1")),
            fee: uint24(vm.parseJsonUint(j, ".pool.key.fee")),
            tickSpacing: int24(int256(vm.parseJsonInt(j, ".pool.key.tickSpacing"))),
            hooks: IHooks(vm.parseJsonAddress(j, ".pool.key.hooks"))
        });
        vault = new ShareVault(
            IIssuerRegistry(vm.parseJsonAddress(j, ".contracts.registry")),
            WrapSwapRouter(vm.parseJsonAddress(j, ".router")),
            key,
            address(this)
        );
        vault.setKeeper(keeper, true);
        (address a, address b) = (Currency.unwrap(key.currency0), Currency.unwrap(key.currency1));
        (mcb, maaplx) = MockToken(a).decimals() == 6 ? (MockToken(a), MockToken(b)) : (MockToken(b), MockToken(a));
        tokenOwner = mcb.owner();
        vm.startPrank(tokenOwner);
        mcb.mint(alice, 2e6);
        maaplx.mint(bob, 10e18);
        vm.stopPrank();
        vm.prank(alice);
        mcb.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        maaplx.approve(address(vault), type(uint256).max);
    }

    /// @dev The opposite conversion (mcbAAPL custody → mAAPLx delivery), so both skew directions are exercised.
    function test_fork_withdrawOtherDirection() public {
        vm.prank(alice);
        vault.deposit(address(mcb), 2e6, bytes32(uint256(0xA)));
        address carol = makeAddr("carol2");
        (uint256 amountIn, uint256 debit,, bool direct) = vault.quoteWithdrawal(address(maaplx), 1.5e18);
        assertFalse(direct);
        ShareVault.Withdrawal[] memory ws = new ShareVault.Withdrawal[](1);
        ws[0] = ShareVault.Withdrawal("fork-rev", carol, address(maaplx), 1.5e18, 25);
        vm.prank(keeper);
        vault.settleWithdrawals(ws, "fork-rev");
        assertTrue(vault.settled("fork-rev"), "conversion must settle, not skip");
        assertGe(maaplx.balanceOf(carol), 1.5e18, "at least face value");
        assertEq(2e6 - mcb.balanceOf(address(vault)), amountIn);
        assertEq(2.025e18 - vault.sharesOutstanding(), debit);
        (uint256 held, uint256 outstanding) = vault.reserves();
        assertGe(held, outstanding);
    }

    function test_fork_depositPayWithdrawAcrossIssuers() public {
        vm.prank(alice);
        uint256 aShares = vault.deposit(address(mcb), 2e6, bytes32(uint256(0xA)));
        vm.prank(bob);
        vault.deposit(address(maaplx), 10e18, bytes32(uint256(0xB)));
        assertEq(aShares, 2.025e18);

        // Bob withdraws more mcbAAPL than custody holds, so it must convert mAAPLx through the live ParityHook pool.
        address carol = makeAddr("carol");
        (, uint256 debit, uint24 feePips, bool direct) = vault.quoteWithdrawal(address(mcb), 3e18);
        assertFalse(direct);
        ShareVault.Withdrawal[] memory ws = new ShareVault.Withdrawal[](2);
        ws[0] = ShareVault.Withdrawal("fork-ok", carol, address(mcb), 3e18, 25);
        ws[1] = ShareVault.Withdrawal("fork-skip", carol, address(mcb), 2.5e18, 0); // below the live fee
        uint256 before = vault.sharesOutstanding();
        vm.prank(keeper);
        vault.settleWithdrawals(ws, "fork");
        assertGe(mcb.balanceOf(carol), CanonicalShares.fromSharesDown(3e18, 1.0125e18, 6));
        assertTrue(vault.settled("fork-ok"), "conversion must settle, not skip");
        assertFalse(vault.settled("fork-skip"));
        assertEq(before - vault.sharesOutstanding(), debit);
        assertGt(feePips, 0);
        (uint256 held, uint256 outstanding) = vault.reserves();
        assertGe(held, outstanding);
    }
}
