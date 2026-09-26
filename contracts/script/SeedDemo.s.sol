// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IMockIssuerToken} from "../src/interfaces/IMockIssuerToken.sol";
import {IWrapperAdapter} from "../src/interfaces/IWrapperAdapter.sol";
import {IParityHook} from "../src/interfaces/IParityHook.sol";
import {IDarkCrossHook} from "../src/interfaces/IDarkCrossHook.sol";
import {IMockPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {IEligibility} from "../src/interfaces/IEligibility.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

interface ISeedLiquidityRouter {
    function modifyLiquidity(PoolKey memory, ModifyLiquidityParams memory, bytes memory) external payable returns (int256);
}

/// @notice Only frozen project interfaces; never instantiates or imports component implementations.
/// @dev RPC phase/time orchestration lives in scripts/dev/seed. No vm.warp on Unichain Sepolia.
contract SeedDemo is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    string internal json;
    string internal mnemonic;
    IMockIssuerToken internal base;
    IMockIssuerToken internal quote;
    IParityHook internal parity;
    IDarkCrossHook internal dark;
    IEligibility internal eligibility;
    PoolKey internal key;
    bytes32 constant LP_SALT = keccak256("wrapswap.section10.lp.v1");

    function load() internal {
        string memory network = vm.envString("NETWORK");
        bool local = keccak256(bytes(network)) == keccak256("anvil");
        require(local ? block.chainid == 31337 : keccak256(bytes(network)) == keccak256("unichain-sepolia") && block.chainid == 1301, "network/chain mismatch");
        mnemonic = vm.envString("DEMO_MNEMONIC");
        json = vm.readFile(string.concat("deployments/", network, ".json"));
        dark = IDarkCrossHook(a(".contracts.darkCrossHook"));
        parity = IParityHook(a(".contracts.parityHook"));
        eligibility = IEligibility(a(".contracts.eligibility"));
        base = IMockIssuerToken(dark.baseToken());
        quote = IMockIssuerToken(dark.quoteToken());
        key = dark.parityPoolKey();
        require(base.decimals() == 6 && quote.decimals() == 18, "issuer decimals boundary");
        require(key.tickSpacing == 10 && key.fee == 8388608, "pool configuration boundary");
    }
    function a(string memory path) internal view returns (address) { return vm.parseJsonAddress(json, path); }
    function account(uint32 i) internal returns (address) { return vm.addr(vm.deriveKey(mnemonic, i)); }
    function topUp(IMockIssuerToken token, address to, uint256 amount) internal {
        uint256 current = token.balanceOf(to);
        if (current < amount) token.mint(to, amount - current);
    }
    function run() external {
        load();
        // LP position is the completion marker, survives later fills and drained-inventory scenarios.
        bool forward = Currency.unwrap(key.currency0) == address(base);
        int24 lower = forward ? int24(276320) : int24(-276570);
        int24 upper = forward ? int24(276570) : int24(-276320);
        IPoolManager manager = parity.poolManager();
        address router = a(".contracts.modifyLiquidityRouter");
        (uint128 existing,,) = manager.getPositionInfo(key.toId(), router, lower, upper, LP_SALT);
        if (existing != 0) return;
        address owner = account(0);
        require(vm.addr(vm.envUint("DEPLOYER_PK")) == owner, "deployer must be mnemonic index 0");
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        base.setMultiplier(1012500000000000000);
        quote.setMultiplier(1e18);
        require(IWrapperAdapter(parity.registry().adapterOf(address(base))).sharesPerToken() == 1012500000000000000, "base adapter ratio boundary");
        require(IWrapperAdapter(parity.registry().adapterOf(address(quote))).sharesPerToken() == 1e18, "quote adapter ratio boundary");
        eligibility.setDemoMode(true);
        parity.setKeeper(owner, true);
        eligibility.setTrustedRouter(a(".contracts.swapRouter"), true);
        eligibility.setTrustedRouter(address(dark), true);
        // Unichain Sepolia gas is ~0.006 gwei; a smaller top-up keeps a lightly funded deployer able to seed.
        uint256 topUpWei = vm.envOr("SEED_GAS_TOPUP_WEI", uint256(0.01 ether));
        for (uint32 i = 1; i <= 4; ++i) {
            address who = account(i);
            if (who.balance < topUpWei) {
                (bool ok,) = payable(who).call{value: topUpWei - who.balance}("");
                require(ok, "gas funding failed");
            }
        }
        topUp(base, account(1), 500e6); topUp(quote, account(1), 500e18);
        topUp(base, account(2), 200e6); topUp(quote, account(3), 200e18);
        uint256 invBase = parity.inventory(Currency.wrap(address(base)));
        uint256 invQuote = parity.inventory(Currency.wrap(address(quote)));
        require(invBase <= 8000e6 && invQuote <= 12150e18, "unexpected existing inventory");
        topUp(base, owner, 8000e6 - invBase + 1000e6);
        topUp(quote, owner, 12150e18 - invQuote + 10125e17);
        base.approve(address(parity), type(uint256).max); quote.approve(address(parity), type(uint256).max);
        if (invBase < 8000e6) parity.depositInventory(Currency.wrap(address(base)), 8000e6 - invBase);
        if (invQuote < 12150e18) parity.depositInventory(Currency.wrap(address(quote)), 12150e18 - invQuote);
        IMockPriceOracle oracle = IMockPriceOracle(a(".contracts.oracle"));
        oracle.setPusher(account(4), true);
        oracle.setPusher(owner, true);
        oracle.setMid(address(base), address(quote), 1012500000000000000);
        (uint160 sqrt,,,) = manager.getSlot0(key.toId());
        require(sqrt == (forward ? uint160(79721800701433069633245772272326702) : uint160(78737580939686982353822)), "pool must be initialized at parity by Deploy");
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrt, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), forward ? 1000e6 : 10125e17, forward ? 10125e17 : 1000e6);
        base.approve(router, type(uint256).max); quote.approve(router, type(uint256).max);
        ISeedLiquidityRouter(router).modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), LP_SALT), "");
        vm.stopBroadcast();
    }
    /// @dev Phase-independent escrow funding, so commit() needs only the two commit txs (Unichain Sepolia's
    ///      12-block commit window is ~24 s).
    function fundEscrow() external {
        load();
        for (uint32 i = 2; i <= 3; ++i) {
            bool sell = i == 2;
            uint256 amount = sell ? 60e6 : 50625e15;
            IMockIssuerToken token = sell ? base : quote;
            (uint256 available,) = dark.balances(account(i), address(token));
            if (available >= amount) continue;
            vm.startBroadcast(vm.deriveKey(mnemonic, i));
            token.approve(address(dark), amount - available);
            dark.fund(address(token), amount - available);
            vm.stopBroadcast();
        }
    }
    function commit() external {
        load();
        (uint256 batch, IDarkCrossHook.Phase phase,) = dark.currentBatch();
        require(phase == IDarkCrossHook.Phase.COMMIT, "wait for commit phase");
        for (uint32 i = 2; i <= 3; ++i) {
            if (dark.order(batch, account(i)).commitHash != bytes32(0)) continue;
            bool sell = i == 2;
            uint256 amount = sell ? 60e6 : 50625e15;
            IMockIssuerToken token = sell ? base : quote;
            vm.startBroadcast(vm.deriveKey(mnemonic, i));
            (uint256 available,) = dark.balances(account(i), address(token));
            if (available < amount) { token.approve(address(dark), amount - available); dark.fund(address(token), amount - available); }
            require(dark.commit(dark.commitHashOf(batch, account(i), sell, amount, sell ? 101e16 : 1015e15, sell, bytes32(uint256(i))), address(token), amount, bytes32(0)), "commit rejected");
            vm.stopBroadcast();
        }
    }
    function reveal() external {
        load();
        (uint256 batch, IDarkCrossHook.Phase phase,) = dark.currentBatch();
        require(phase == IDarkCrossHook.Phase.REVEAL, "wait for reveal phase");
        for (uint32 i = 2; i <= 3; ++i) {
            if (dark.order(batch, account(i)).revealed) continue;
            vm.startBroadcast(vm.deriveKey(mnemonic, i));
            dark.reveal(i == 2, i == 2 ? 60e6 : 50625e15, i == 2 ? 101e16 : 1015e15, i == 2, bytes32(uint256(i)));
            vm.stopBroadcast();
        }
    }
    function scenario() external {
        load();
        bytes32 variant = keccak256(bytes(vm.envString("SEED_VARIANT")));
        vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        if (variant == keccak256("FALL-THROUGH")) {
            parity.withdrawInventory(Currency.wrap(address(quote)), parity.inventory(Currency.wrap(address(quote))), account(0));
        } else if (variant == keccak256("BLOCKED-PEG")) {
            base.setTransfersPaused(true);
        } else if (variant == keccak256("BLOCKED-ELIGIBILITY")) {
            eligibility.setDemoMode(false);
        } else { require(variant == keccak256("NYSE-CLOSED") || variant == keccak256("ANVIL"), "unknown seed variant"); }
        vm.stopBroadcast();
    }
}
