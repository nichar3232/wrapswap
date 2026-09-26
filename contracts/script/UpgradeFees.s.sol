// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IssuerRegistry} from "../src/IssuerRegistry.sol";
import {NyseCalendar} from "../src/NyseCalendar.sol";
import {EASEligibility} from "../src/EASEligibility.sol";
import {ParityHook} from "../src/ParityHook.sol";
import {DarkCrossHook} from "../src/DarkCrossHook.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {TestShareFaucet} from "../src/mocks/TestShareFaucet.sol";
import {B20MultiplierAdapter} from "../src/adapters/B20MultiplierAdapter.sol";
import {XStocksMultiplierAdapter} from "../src/adapters/XStocksMultiplierAdapter.sol";

/// @title UpgradeFees
/// @notice Incremental Unichain Sepolia redeploy for the post-trade-skew off-hours fee (ParityHook changed). Reuses
///         every unchanged contract from deployments/unichain-sepolia.json and deploys only what depends on the hook
///         address: ParityHook (CREATE2-mined), the AAPL pool, and DarkCrossHook (it stores the pool key). Adds NVDA and
///         TSLA (a Coinbase-style and an xStocks-style mock each, adapters, registry entries, one pool each on the same
///         hook), seeds every pool's inventory at a mild ~10% skew plus LP liquidity, sets oracle mids, and deploys a
///         prefunded TestShareFaucet. Writes deployments/unichain-sepolia.upgrade.json for the manifest merge.
/// Env: DEPLOYER_PK.
contract UpgradeFees is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant PARITY_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    bytes32 internal constant LP_SALT = bytes32(0);
    uint256 internal constant FAUCET_STOCK = 1_000_000; // whole tokens per wrapper = 1,000 claims

    struct Asset {
        string symbol;
        address coinbase; // 6 decimals
        address xstocks; // 18 decimals
        address coinbaseAdapter;
        address xstocksAdapter;
        PoolKey key;
        uint160 sqrtPriceX96;
    }

    string json;
    address deployer;
    IPoolManager pm;
    ParityHook hook;
    Asset[3] assets;

    function run() external {
        json = vm.readFile("deployments/unichain-sepolia.json");
        require(block.chainid == 1301, "UpgradeFees: Unichain Sepolia only");
        uint256 pk = vm.envUint("DEPLOYER_PK");
        deployer = vm.addr(pk);
        pm = IPoolManager(a(".contracts.poolManager"));
        IssuerRegistry registry = IssuerRegistry(a(".contracts.registry"));
        EASEligibility eligibility = EASEligibility(a(".contracts.eligibility"));
        MockPriceOracle oracle = MockPriceOracle(a(".contracts.oracle"));
        address oldDark = a(".contracts.darkCrossHook");

        vm.startBroadcast(pk);
        // ParityHook (new fee model) at a mined address with the same constructor arguments as Deploy.
        bytes memory args =
            abi.encode(address(pm), address(registry), a(".contracts.calendar"), address(eligibility), deployer);
        bytes memory code = type(ParityHook).creationCode;
        (address predicted, bytes32 salt) = HookMiner.find(CREATE2_PROXY, PARITY_FLAGS, code, args);
        (bool ok,) = CREATE2_PROXY.call(abi.encodePacked(salt, code, args));
        require(ok && predicted.code.length > 0, "UpgradeFees: ParityHook CREATE2 failed");
        require(uint160(predicted) & Hooks.ALL_HOOK_MASK == PARITY_FLAGS, "UpgradeFees: hook flags");
        hook = ParityHook(predicted);

        // AAPL: existing wrappers and adapters, new pool on the new hook, new DarkCrossHook bound to it.
        assets[0].symbol = "AAPL";
        assets[0].coinbase = vm.parseJsonAddress(json, ".tokens[0].address");
        assets[0].coinbaseAdapter = vm.parseJsonAddress(json, ".tokens[0].adapter");
        assets[0].xstocks = vm.parseJsonAddress(json, ".tokens[1].address");
        assets[0].xstocksAdapter = vm.parseJsonAddress(json, ".tokens[1].adapter");
        _initPool(assets[0]);
        DarkCrossHook dark = new DarkCrossHook(
            pm, hook, oracle, eligibility, assets[0].coinbase, assets[0].xstocks, assets[0].key, deployer
        );
        eligibility.setTrustedRouter(address(dark), true);
        eligibility.setTrustedRouter(oldDark, false);

        // NVDA and TSLA: same shape as AAPL, distinct multipliers.
        _newAsset(registry, 1, "NVDA", "NVIDIA", 1.02e18, 1.005e18);
        _newAsset(registry, 2, "TSLA", "Tesla", 0.99e18, 1.01e18);

        address[] memory faucetTokens = new address[](6);
        for (uint256 i; i < 3; ++i) {
            Asset memory x = assets[i];
            _seed(x);
            oracle.setMid(x.coinbase, x.xstocks, FullMath.mulDiv(_spt(x.coinbase), 1e18, _spt(x.xstocks)));
            faucetTokens[2 * i] = x.coinbase;
            faucetTokens[2 * i + 1] = x.xstocks;
        }
        TestShareFaucet faucet = new TestShareFaucet(deployer, faucetTokens);
        for (uint256 i; i < 6; ++i) {
            MockIssuerToken t = MockIssuerToken(faucetTokens[i]);
            t.mint(address(faucet), FAUCET_STOCK * 10 ** t.decimals());
        }
        vm.stopBroadcast();

        _write(address(dark), address(faucet));
    }

    function a(string memory path) internal view returns (address) {
        return vm.parseJsonAddress(json, path);
    }

    function _spt(address token) internal view returns (uint256) {
        return MockIssuerToken(token).multiplier();
    }

    function _newAsset(
        IssuerRegistry registry,
        uint256 i,
        string memory sym,
        string memory name,
        uint256 coinbaseMultiplier,
        uint256 xstocksMultiplier
    ) internal {
        bytes32 underlying = bytes32(bytes(sym));
        Asset storage x = assets[i];
        x.symbol = sym;
        x.coinbase = address(
            new MockIssuerToken(string.concat("Mock Coinbase ", name), string.concat("mcb", sym), 6, coinbaseMultiplier)
        );
        x.xstocks = address(
            new MockIssuerToken(string.concat("Mock ", name, " xStock"), string.concat("m", sym, "x"), 18, xstocksMultiplier)
        );
        x.coinbaseAdapter = address(new B20MultiplierAdapter(x.coinbase, underlying));
        x.xstocksAdapter = address(new XStocksMultiplierAdapter(x.xstocks, underlying));
        registry.add(x.coinbaseAdapter);
        registry.add(x.xstocksAdapter);
        _initPool(x);
    }

    /// @dev Pool at share parity: sqrt(spt0 * 10^dec1 * 2^192 / (spt1 * 10^dec0)), as Deploy.paritySqrtPriceX96.
    function _initPool(Asset storage x) internal {
        (address t0, address t1) = x.coinbase < x.xstocks ? (x.coinbase, x.xstocks) : (x.xstocks, x.coinbase);
        x.key = PoolKey(Currency.wrap(t0), Currency.wrap(t1), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        uint256 num = _spt(t0) * 10 ** MockIssuerToken(t1).decimals();
        uint256 den = _spt(t1) * 10 ** MockIssuerToken(t0).decimals();
        x.sqrtPriceX96 = uint160(Math.sqrt(FullMath.mulDiv(num, 1 << 192, den)));
        pm.initialize(x.key, x.sqrtPriceX96);
    }

    /// @dev Inventory 9,000 Coinbase-side vs 11,000 xStocks-side canonical shares (|skew| = 0.10, book long xStocks),
    ///      plus a concentrated LP position worth ~1,000 shares a side around parity for fall-through.
    function _seed(Asset memory x) internal {
        uint256 cb = FullMath.mulDivRoundingUp(9_000e18, 1e6, _spt(x.coinbase));
        uint256 xs = FullMath.mulDivRoundingUp(11_000e18, 1e18, _spt(x.xstocks));
        MockIssuerToken(x.coinbase).mint(deployer, cb + 2_000e6);
        MockIssuerToken(x.xstocks).mint(deployer, xs + 2_000e18);
        MockIssuerToken(x.coinbase).approve(address(hook), cb);
        MockIssuerToken(x.xstocks).approve(address(hook), xs);
        hook.depositInventory(Currency.wrap(x.coinbase), cb);
        hook.depositInventory(Currency.wrap(x.xstocks), xs);

        address router = a(".contracts.modifyLiquidityRouter");
        int24 tick = TickMath.getTickAtSqrtPrice(x.sqrtPriceX96);
        int24 lower = (tick / 10) * 10 - 120;
        int24 upper = (tick / 10) * 10 + 130;
        bool cbIs0 = Currency.unwrap(x.key.currency0) == x.coinbase;
        uint256 amt0 = cbIs0 ? FullMath.mulDiv(1_000e18, 1e6, _spt(x.coinbase)) : FullMath.mulDiv(1_000e18, 1e18, _spt(x.xstocks));
        uint256 amt1 = cbIs0 ? FullMath.mulDiv(1_000e18, 1e18, _spt(x.xstocks)) : FullMath.mulDiv(1_000e18, 1e6, _spt(x.coinbase));
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            x.sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amt0, amt1
        );
        MockIssuerToken(x.coinbase).approve(router, type(uint256).max);
        MockIssuerToken(x.xstocks).approve(router, type(uint256).max);
        PoolModifyLiquidityTest(router).modifyLiquidity(
            x.key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), LP_SALT), ""
        );
    }

    function _write(address dark, address faucet) internal {
        string memory out = string.concat(
            '{"parityHook":"', vm.toString(address(hook)), '","darkCrossHook":"', vm.toString(dark),
            '","faucet":"', vm.toString(faucet), '","batchOrigin":"', vm.toString(DarkCrossHook(dark).batchOrigin()),
            '","assets":['
        );
        for (uint256 i; i < 3; ++i) {
            Asset memory x = assets[i];
            out = string.concat(
                out,
                i == 0 ? "" : ",",
                '{"symbol":"', x.symbol, '","coinbase":"', vm.toString(x.coinbase), '","xstocks":"',
                vm.toString(x.xstocks), '","coinbaseAdapter":"', vm.toString(x.coinbaseAdapter),
                '","xstocksAdapter":"', vm.toString(x.xstocksAdapter)
            );
            out = string.concat(
                out,
                '","coinbaseMultiplier":"', vm.toString(_spt(x.coinbase)), '","xstocksMultiplier":"',
                vm.toString(_spt(x.xstocks)), '","poolId":"', vm.toString(PoolId.unwrap(x.key.toId())),
                '","currency0":"', vm.toString(Currency.unwrap(x.key.currency0)), '","currency1":"',
                vm.toString(Currency.unwrap(x.key.currency1)), '","sqrtPriceX96":"', vm.toString(x.sqrtPriceX96), '"}'
            );
        }
        vm.writeFile("deployments/unichain-sepolia.upgrade.json", string.concat(out, "]}"));
    }
}
