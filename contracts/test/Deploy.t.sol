// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {EASEligibility} from "../src/EASEligibility.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {ParityHook} from "../src/ParityHook.sol";
import {WrapSwapRouter} from "../src/WrapSwapRouter.sol";
import {DarkCrossHook} from "../src/DarkCrossHook.sol";
import {IssuerRegistry} from "../src/IssuerRegistry.sol";

/// @notice Runs Deploy against the in-process chain (chainId 31337 => NETWORK=anvil) and checks the §4 manifest.
contract DeployTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    string constant COMMIT = "0123456789abcdef0123456789abcdef01234567";

    Deploy internal script;
    Deploy.Config internal cfg;
    Deploy.Deployment internal d;
    string internal json;

    function setUp() public {
        if (CREATE2_PROXY.code.length == 0) {
            vm.etch(
                CREATE2_PROXY,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
        vm.setEnv("DEPLOY_COMMIT", COMMIT);
        vm.warp(1790692200);
        script = new Deploy();
        cfg = script.config();
        d = script.deploy(cfg);
        json = _manifest();
    }

    function _manifest() internal view returns (string memory) {
        return script.manifestJson(cfg, d, Deploy.Blocks("5", '{"registry":"5","poolInitialized":"15"}', 14));
    }

    function test_manifestSchemaFields() public view {
        assertEq(vm.parseJsonUint(json, ".schemaVersion"), 1);
        assertEq(vm.parseJsonString(json, ".network"), "anvil");
        assertEq(vm.parseJsonUint(json, ".chainId"), 31337);
        assertEq(vm.parseJsonString(json, ".deployCommit"), COMMIT);
        assertEq(vm.parseJsonString(json, ".deployedAt"), "2026-09-29T14:30:00Z");
        assertEq(vm.parseJsonAddress(json, ".deployer"), 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266);
        assertEq(vm.parseJsonString(json, ".startBlock"), "5");
        assertTrue(vm.parseJsonBool(json, ".mockOracle"));
        string[17] memory keys = [
            "poolManager",
            "positionManager",
            "stateView",
            "quoter",
            "permit2",
            "universalRouter",
            "swapRouter",
            "modifyLiquidityRouter",
            "registry",
            "calendar",
            "eligibility",
            "oracle",
            "parityHook",
            "darkCrossHook",
            "wrapSwapRouter",
            "eas",
            "easIndexer"
        ];
        for (uint256 i; i < keys.length; i++) {
            assertTrue(vm.keyExistsJson(json, string.concat(".contracts.", keys[i])), keys[i]);
        }
        assertEq(vm.parseJsonKeys(json, ".contracts").length, 17);
        assertEq(vm.parseJsonAddress(json, ".contracts.wrapSwapRouter"), d.wrapSwapRouter);
        // anvil nulls.
        string[7] memory nulls = ["positionManager", "stateView", "permit2", "universalRouter", "calendar", "eas", "easIndexer"];
        for (uint256 i; i < nulls.length; i++) {
            assertTrue(vm.indexOf(json, string.concat('"', nulls[i], '":null')) != type(uint256).max, nulls[i]);
        }
        assertEq(vm.parseJsonAddress(json, ".contracts.poolManager"), d.poolManager);
        assertEq(vm.parseJsonAddress(json, ".contracts.quoter"), d.quoter);
        // Tokens.
        assertEq(vm.parseJsonString(json, ".tokens[0].symbol"), "mcbAAPL");
        assertEq(vm.parseJsonUint(json, ".tokens[0].decimals"), 6);
        assertEq(vm.parseJsonString(json, ".tokens[0].issuer"), "coinbase");
        assertEq(vm.parseJsonString(json, ".tokens[0].adapterKind"), "B20Multiplier");
        assertEq(vm.parseJsonString(json, ".tokens[0].sharesPerTokenX18"), "1012500000000000000");
        assertEq(vm.parseJsonString(json, ".tokens[0].darkRole"), "base");
        assertEq(vm.parseJsonString(json, ".tokens[1].symbol"), "mAAPLx");
        assertEq(vm.parseJsonUint(json, ".tokens[1].decimals"), 18);
        assertEq(vm.parseJsonString(json, ".tokens[1].issuer"), "xstocks");
        assertEq(vm.parseJsonString(json, ".tokens[1].adapterKind"), "XStocksMultiplier");
        assertEq(vm.parseJsonString(json, ".tokens[1].sharesPerTokenX18"), "1000000000000000000");
        assertEq(vm.parseJsonString(json, ".tokens[1].darkRole"), "quote");
        assertEq(vm.parseJsonKeys(json, ".tokens[0]").length, 11);
        // Dark.
        assertEq(vm.parseJsonAddress(json, ".dark.baseToken"), d.mcb);
        assertEq(vm.parseJsonAddress(json, ".dark.quoteToken"), d.maaplx);
        assertEq(vm.parseJsonString(json, ".dark.batchOrigin"), "14");
        assertEq(vm.parseJsonUint(json, ".dark.batchBlocks"), 20);
        assertEq(vm.parseJsonUint(json, ".dark.commitBlocks"), 12);
        assertEq(vm.parseJsonUint(json, ".dark.revealBlocks"), 6);
        assertEq(vm.parseJsonString(json, ".blocks.poolInitialized"), "15");
        // Accounts, never keys.
        assertEq(vm.parseJsonString(json, ".demoAccounts.mnemonicSource"), "anvil-default");
        assertEq(vm.parseJsonAddress(json, ".demoAccounts.accounts[4].address"), 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65);
        assertEq(vm.parseJsonString(json, ".demoAccounts.accounts[2].role"), "counterpartyA");
        assertEq(vm.parseJsonKeys(json, ".demoAccounts.accounts[0]").length, 3);
        assertFalse(vm.keyExistsJson(json, ".verification"));
        assertEq(vm.parseJsonKeys(json, ".").length, 16);
    }

    function test_manifestParityFlags() public view {
        address hook = vm.parseJsonAddress(json, ".hooks.parityHook.address");
        assertEq(hook, d.parityHook);
        assertEq(uint160(hook) & 0x3fff, 0x20c8);
        assertEq(vm.parseJsonString(json, ".hooks.parityHook.flags"), "0x20c8");
        string[] memory perms = vm.parseJsonStringArray(json, ".hooks.parityHook.permissions");
        assertEq(perms.length, 4);
        assertEq(perms[0], "beforeInitialize");
        assertEq(perms[3], "beforeSwapReturnDelta");
        assertEq(vm.parseJsonString(json, ".hooks.darkCrossHook.flags"), "0x0000");
        assertEq(vm.parseJsonStringArray(json, ".hooks.darkCrossHook.permissions").length, 0);
        assertEq(ParityHook(hook).owner(), cfg.accounts[0]);
        assertTrue(ParityHook(hook).isKeeper(cfg.accounts[0]));
    }

    function test_manifestPoolKeyMatchesChain() public view {
        PoolKey memory k = DarkCrossHook(d.darkCrossHook).parityPoolKey();
        assertEq(vm.parseJsonAddress(json, ".pool.key.currency0"), Currency.unwrap(k.currency0));
        assertEq(vm.parseJsonAddress(json, ".pool.key.currency1"), Currency.unwrap(k.currency1));
        assertLt(uint160(Currency.unwrap(k.currency0)), uint160(Currency.unwrap(k.currency1)));
        assertEq(vm.parseJsonUint(json, ".pool.key.fee"), 8388608);
        assertEq(vm.parseJsonInt(json, ".pool.key.tickSpacing"), 10);
        assertEq(vm.parseJsonAddress(json, ".pool.key.hooks"), d.parityHook);
        assertEq(vm.parseJsonBytes32(json, ".pool.id"), PoolId.unwrap(k.toId()));
        (uint160 sqrtP,,,) = IPoolManager(d.poolManager).getSlot0(k.toId());
        assertEq(sqrtP, d.initSqrtPriceX96);
        assertEq(IssuerRegistry(d.registry).adapterOf(d.mcb), vm.parseJsonAddress(json, ".tokens[0].adapter"));
    }

    function test_manifestInitSqrtMatchesSection10() public view {
        uint256 expected = d.mcb < d.maaplx ? 79721800701433069633245772272326702 : 78737580939686982353822;
        assertEq(vm.parseJsonString(json, ".pool.initSqrtPriceX96"), vm.toString(expected));
        assertEq(uint256(script.paritySqrtPriceX96(d.mcb, d.maaplx)), expected);
    }

    function test_manifestDemoModeReadFromChain() public {
        assertTrue(vm.parseJsonBool(json, ".demoMode"));
        vm.prank(cfg.accounts[0]);
        EASEligibility(d.eligibility).setDemoMode(false);
        assertFalse(vm.parseJsonBool(_manifest(), ".demoMode"));
    }

    function test_trustedRoutersConfigured() public view {
        EASEligibility e = EASEligibility(d.eligibility);
        assertTrue(e.isTrustedRouter(d.swapRouter));
        assertTrue(e.isTrustedRouter(d.darkCrossHook));
        assertTrue(e.isTrustedRouter(d.quoter));
        assertTrue(e.isTrustedRouter(d.wrapSwapRouter));
        assertEq(address(WrapSwapRouter(d.wrapSwapRouter).poolManager()), d.poolManager);
        assertFalse(e.isTrustedRouter(d.modifyLiquidityRouter));
        assertEq(e.owner(), cfg.accounts[0]);
        assertEq(e.restrictedCountry(), "US");
    }

    function test_crankIsPusher() public view {
        MockPriceOracle o = MockPriceOracle(d.oracle);
        assertTrue(o.isPusher(0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65));
        assertFalse(o.isPusher(cfg.accounts[0]));
        assertEq(o.owner(), cfg.accounts[0]);
    }

    function test_formatHelpers() public view {
        assertEq(script.isoTimestamp(0), "1970-01-01T00:00:00Z");
        assertEq(script.isoTimestamp(1790424000), "2026-09-26T12:00:00Z");
        assertEq(script.isoTimestamp(1709164800), "2024-02-29T00:00:00Z");
        assertEq(script.hexQuantity(0), "0x0");
        assertEq(script.hexQuantity(255), "0xff");
        assertEq(script.hexQuantity(4096), "0x1000");
    }
}
