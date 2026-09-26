// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IssuerRegistry} from "../src/IssuerRegistry.sol";
import {NyseCalendar} from "../src/NyseCalendar.sol";
import {EASEligibility} from "../src/EASEligibility.sol";
import {ParityHook} from "../src/ParityHook.sol";
import {DarkCrossHook} from "../src/DarkCrossHook.sol";
import {WrapSwapRouter} from "../src/WrapSwapRouter.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {B20MultiplierAdapter} from "../src/adapters/B20MultiplierAdapter.sol";
import {XStocksMultiplierAdapter} from "../src/adapters/XStocksMultiplierAdapter.sol";

/// @title Deploy
/// @notice Deploys the WrapSwap reframe (no seeding) and writes deployments/<network>.json in the INTERFACES.md §4
///         shape. Network is derived from chainId: 31337 -> anvil, 1301 -> unichain-sepolia (NETWORK, if set, must agree).
///
/// Usage (two phases; forge simulates every broadcast at one block, so block numbers need a read-only pass):
///   DEPLOY_COMMIT=$(git rev-parse HEAD) forge script contracts/script/Deploy.s.sol \
///       --rpc-url http://127.0.0.1:$ANVIL_PORT --broadcast
///   DEPLOY_COMMIT=$(git rev-parse HEAD) forge script contracts/script/Deploy.s.sol --sig 'manifest()' \
///       --rpc-url http://127.0.0.1:$ANVIL_PORT
/// Phase 1 writes a schema-valid file with startBlock = the pre-deploy head (a safe lower bound) and empty blocks.
/// Phase 2 re-reads every value from chain, resolves each contract's creation block by eth_getCode bisection and
/// rewrites the file with exact blocks, startBlock = blocks.registry and the on-chain batchOrigin.
///
/// Env: DEPLOY_COMMIT (required, 40 lowercase hex), DEPLOYED_AT (optional ISO-8601; default from block.timestamp),
///      DEMO_MNEMONIC (required off anvil; anvil default mnemonic on 31337), DEPLOYER_PK (optional, overrides index 0),
///      DEMO_MODE (required off anvil; default true on anvil),
///      POOL_MANAGER, V4_QUOTER (required on unichain-sepolia; deployed locally on anvil),
///      EAS, EAS_SCHEMA_UID, EAS_TRUSTED_ATTESTER (required on unichain-sepolia; optional on anvil),
///      EAS_INDEXER, POSITION_MANAGER, STATE_VIEW, PERMIT2, UNIVERSAL_ROUTER (optional; null when unset),
///      DEPLOY_FROM_BLOCK (optional, manifest() search lower bound; default the phase-1 startBlock).
contract Deploy is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    uint160 internal constant PARITY_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    bytes32 internal constant AAPL = "AAPL";
    uint256 internal constant MCB_MULTIPLIER = 1.0125e18;
    uint256 internal constant MAAPLX_MULTIPLIER = 1e18;
    uint160 internal constant SQRT_MCB_C0 = 79721800701433069633245772272326702;
    uint160 internal constant SQRT_MAAPLX_C0 = 78737580939686982353822;

    struct Config {
        string network;
        bool anvil;
        string deployCommit;
        string deployedAt;
        string mnemonicSource;
        uint256 deployerPk;
        address[5] accounts; // deployer, demo, counterpartyA, counterpartyB, crank
        bool demoMode;
        address eas;
        address easIndexer;
        bytes32 schemaUid;
        address trustedAttester;
        address positionManager;
        address stateView;
        address permit2;
        address universalRouter;
        address poolManager; // external on unichain-sepolia
        address quoter; // external on unichain-sepolia
    }

    struct Deployment {
        address poolManager;
        address quoter;
        address swapRouter;
        address modifyLiquidityRouter;
        address registry;
        address calendar;
        address eligibility;
        address oracle;
        address mcb;
        address maaplx;
        address mcbAdapter;
        address maaplxAdapter;
        address parityHook;
        address darkCrossHook;
        address wrapSwapRouter;
        PoolKey key;
        uint160 initSqrtPriceX96;
    }

    struct Blocks {
        string startBlock;
        string json; // the `blocks` object
        uint256 batchOrigin;
    }

    // ---------------------------------------------------------------- entry points

    function run() external {
        Config memory c = config();
        uint256 head = block.number;
        Deployment memory d = deploy(c);
        Blocks memory b = Blocks(vm.toString(head), "{}", DarkCrossHook(d.darkCrossHook).batchOrigin());
        vm.writeFile(_path(c.network), manifestJson(c, d, b));
    }

    /// @notice Read-only second phase: rebuilds the manifest from chain state with exact creation blocks.
    function manifest() external {
        Config memory c = config();
        string memory path = _path(c.network);
        string memory prev = vm.readFile(path);
        c.deployedAt = vm.parseJsonString(prev, ".deployedAt");
        Deployment memory d = _fromJson(prev);
        uint256 from = vm.envOr("DEPLOY_FROM_BLOCK", vm.parseUint(vm.parseJsonString(prev, ".startBlock")));
        uint256 head = block.number;
        string[12] memory keys = [
            "poolManager",
            "quoter",
            "swapRouter",
            "modifyLiquidityRouter",
            "registry",
            "calendar",
            "eligibility",
            "oracle",
            "parityHook",
            "darkCrossHook",
            "wrapSwapRouter",
            "poolInitialized"
        ];
        address[11] memory addrs = [
            d.poolManager,
            d.quoter,
            d.swapRouter,
            d.modifyLiquidityRouter,
            d.registry,
            d.calendar,
            d.eligibility,
            d.oracle,
            d.parityHook,
            d.darkCrossHook,
            d.wrapSwapRouter
        ];
        string memory obj = "{";
        uint256 registryBlock;
        for (uint256 i; i < 11; i++) {
            if (!c.anvil && i < 2) continue; // canonical PoolManager / V4Quoter are not created by this deployment
            uint256 n = _firstBlockWithCode(addrs[i], from, head);
            if (i == 4) registryBlock = n;
            obj = string.concat(obj, bytes(obj).length > 1 ? "," : "", '"', keys[i], '":"', vm.toString(n), '"');
        }
        uint256 initBlock = _firstBlockInitialized(d.poolManager, d.key.toId(), from, head);
        obj = string.concat(obj, ',"', keys[11], '":"', vm.toString(initBlock), '"}');
        Blocks memory b = Blocks(vm.toString(registryBlock), obj, DarkCrossHook(d.darkCrossHook).batchOrigin());
        vm.writeFile(path, manifestJson(c, d, b));
    }

    // ---------------------------------------------------------------- configuration

    function config() public view returns (Config memory c) {
        if (block.chainid == 31337) c.network = "anvil";
        else if (block.chainid == 1301) c.network = "unichain-sepolia";
        else revert("Deploy: unsupported chainId (31337 anvil, 1301 unichain-sepolia)");
        c.anvil = block.chainid == 31337;
        string memory declared = vm.envOr("NETWORK", c.network);
        require(keccak256(bytes(declared)) == keccak256(bytes(c.network)), "Deploy: NETWORK disagrees with chainId");

        c.deployCommit = vm.envString("DEPLOY_COMMIT");
        require(_isLowerHex(c.deployCommit, 40), "Deploy: DEPLOY_COMMIT must be 40 lowercase hex characters");
        c.deployedAt = vm.envOr("DEPLOYED_AT", _isoTimestamp(block.timestamp));

        string memory mnemonic;
        if (c.anvil) {
            mnemonic = vm.envOr("DEMO_MNEMONIC", string(ANVIL_MNEMONIC));
        } else {
            mnemonic = vm.envString("DEMO_MNEMONIC");
        }
        c.mnemonicSource = keccak256(bytes(mnemonic)) == keccak256(bytes(ANVIL_MNEMONIC)) && c.anvil
            ? "anvil-default"
            : "env:DEMO_MNEMONIC";
        for (uint32 i; i < 5; i++) {
            c.accounts[i] = vm.addr(vm.deriveKey(mnemonic, i));
        }
        c.deployerPk = vm.envOr("DEPLOYER_PK", vm.deriveKey(mnemonic, 0));
        c.accounts[0] = vm.addr(c.deployerPk);

        c.demoMode = c.anvil ? vm.envOr("DEMO_MODE", true) : vm.envBool("DEMO_MODE");
        c.positionManager = vm.envOr("POSITION_MANAGER", address(0));
        c.stateView = vm.envOr("STATE_VIEW", address(0));
        c.permit2 = vm.envOr("PERMIT2", address(0));
        c.universalRouter = vm.envOr("UNIVERSAL_ROUTER", address(0));
        c.easIndexer = vm.envOr("EAS_INDEXER", address(0));
        if (c.anvil) {
            c.eas = vm.envOr("EAS", address(0));
            c.schemaUid = vm.envOr("EAS_SCHEMA_UID", bytes32(0));
            c.trustedAttester = vm.envOr("EAS_TRUSTED_ATTESTER", address(0));
        } else {
            c.poolManager = vm.envAddress("POOL_MANAGER");
            c.quoter = vm.envAddress("V4_QUOTER");
            c.eas = vm.envAddress("EAS");
            c.schemaUid = vm.envBytes32("EAS_SCHEMA_UID");
            c.trustedAttester = vm.envAddress("EAS_TRUSTED_ATTESTER");
        }
    }

    // ---------------------------------------------------------------- deployment

    function deploy(Config memory c) public returns (Deployment memory d) {
        address deployer = c.accounts[0];
        require(CREATE2_PROXY.code.length > 0, "Deploy: CREATE2 deployer proxy missing");
        vm.startBroadcast(c.deployerPk);

        if (c.anvil) {
            d.poolManager = address(new PoolManager(deployer));
            d.quoter = address(new V4Quoter(IPoolManager(d.poolManager)));
        } else {
            d.poolManager = c.poolManager;
            d.quoter = c.quoter;
        }
        IPoolManager pm = IPoolManager(d.poolManager);
        d.swapRouter = address(new PoolSwapTest(pm));
        d.modifyLiquidityRouter = address(new PoolModifyLiquidityTest(pm));

        IssuerRegistry registry = new IssuerRegistry(deployer);
        d.registry = address(registry);
        d.calendar = address(new NyseCalendar(deployer));
        EASEligibility eligibility =
            new EASEligibility(deployer, c.eas, c.easIndexer, c.schemaUid, c.trustedAttester, "US");
        d.eligibility = address(eligibility);
        MockPriceOracle oracle = new MockPriceOracle(deployer);
        d.oracle = address(oracle);

        d.mcb = address(new MockIssuerToken("Mock Coinbase Apple", "mcbAAPL", 6, MCB_MULTIPLIER));
        d.maaplx = address(new MockIssuerToken("Mock Apple xStock", "mAAPLx", 18, MAAPLX_MULTIPLIER));
        d.mcbAdapter = address(new B20MultiplierAdapter(d.mcb, AAPL));
        d.maaplxAdapter = address(new XStocksMultiplierAdapter(d.maaplx, AAPL));
        registry.add(d.mcbAdapter);
        registry.add(d.maaplxAdapter);

        bytes memory args = abi.encode(d.poolManager, d.registry, d.eligibility, deployer);
        bytes memory code = type(ParityHook).creationCode;
        (address predicted, bytes32 salt) = HookMiner.find(CREATE2_PROXY, PARITY_FLAGS, code, args);
        (bool ok,) = CREATE2_PROXY.call(abi.encodePacked(salt, code, args));
        require(ok && predicted.code.length > 0, "Deploy: ParityHook CREATE2 failed");
        d.parityHook = predicted;
        require(uint160(d.parityHook) & Hooks.ALL_HOOK_MASK == PARITY_FLAGS, "Deploy: hook flags");

        (address lo, address hi) = d.mcb < d.maaplx ? (d.mcb, d.maaplx) : (d.maaplx, d.mcb);
        d.key = PoolKey(Currency.wrap(lo), Currency.wrap(hi), LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(d.parityHook));
        d.darkCrossHook = address(
            new DarkCrossHook(pm, ParityHook(d.parityHook), oracle, eligibility, d.mcb, d.maaplx, d.key, deployer, deployer)
        );
        // Created last so every earlier address (and the §10 currency ordering) is unchanged.
        d.wrapSwapRouter = address(new WrapSwapRouter(pm));

        eligibility.setTrustedRouter(d.swapRouter, true);
        eligibility.setTrustedRouter(d.darkCrossHook, true);
        eligibility.setTrustedRouter(d.wrapSwapRouter, true);
        eligibility.setTrustedRouter(d.quoter, true);
        if (c.universalRouter != address(0)) eligibility.setTrustedRouter(c.universalRouter, true);
        oracle.setPusher(c.accounts[4], true);
        eligibility.setDemoMode(c.demoMode);

        d.initSqrtPriceX96 = paritySqrtPriceX96(d.mcb, d.maaplx);
        require(d.initSqrtPriceX96 == (d.mcb < d.maaplx ? SQRT_MCB_C0 : SQRT_MAAPLX_C0), "Deploy: sqrt != section 10");
        pm.initialize(d.key, d.initSqrtPriceX96);
        vm.stopBroadcast();
    }

    /// @dev isqrt(floor(spt0 * 10^dec1 * 2^192 / (spt1 * 10^dec0))), INTERFACES.md §10.
    function paritySqrtPriceX96(address mcb, address maaplx) public view returns (uint160) {
        (address t0, address t1) = mcb < maaplx ? (mcb, maaplx) : (maaplx, mcb);
        uint256 num = MockIssuerToken(t0).multiplier() * 10 ** MockIssuerToken(t1).decimals();
        uint256 den = MockIssuerToken(t1).multiplier() * 10 ** MockIssuerToken(t0).decimals();
        return uint160(Math.sqrt(FullMath.mulDiv(num, 1 << 192, den)));
    }

    // ---------------------------------------------------------------- manifest

    function manifestJson(Config memory c, Deployment memory d, Blocks memory b) public view returns (string memory) {
        string memory head = string.concat(
            '{"schemaVersion":1,"network":"',
            c.network,
            '","chainId":',
            vm.toString(block.chainid),
            ',"deployCommit":"',
            c.deployCommit,
            '","deployedAt":"',
            c.deployedAt,
            '","deployer":"',
            vm.toString(c.accounts[0]),
            '","startBlock":"',
            b.startBlock,
            '","demoMode":',
            EASEligibility(d.eligibility).demoMode() ? "true" : "false",
            ',"mockOracle":true,'
        );
        return string.concat(
            head,
            _contractsJson(c, d),
            ',"tokens":[',
            _tokenJson(d.mcb, d.mcbAdapter, "coinbase", "B20Multiplier", "base"),
            ",",
            _tokenJson(d.maaplx, d.maaplxAdapter, "xstocks", "XStocksMultiplier", "quote"),
            "],",
            _poolJson(d),
            ",",
            _hooksJson(d),
            ",",
            _darkJson(d, b.batchOrigin),
            ',"blocks":',
            b.json,
            ",",
            _accountsJson(c),
            "}"
        );
    }

    function _contractsJson(Config memory c, Deployment memory d) internal pure returns (string memory) {
        string memory a = string.concat(
            '"contracts":{"poolManager":',
            _addr(d.poolManager),
            ',"positionManager":',
            _nullable(c.positionManager),
            ',"stateView":',
            _nullable(c.stateView),
            ',"quoter":',
            _addr(d.quoter),
            ',"permit2":',
            _nullable(c.permit2),
            ',"universalRouter":',
            _nullable(c.universalRouter),
            ',"swapRouter":',
            _addr(d.swapRouter),
            ',"modifyLiquidityRouter":',
            _addr(d.modifyLiquidityRouter)
        );
        return string.concat(
            a,
            ',"registry":',
            _addr(d.registry),
            ',"calendar":',
            _addr(d.calendar),
            ',"eligibility":',
            _addr(d.eligibility),
            ',"oracle":',
            _addr(d.oracle),
            ',"parityHook":',
            _addr(d.parityHook),
            ',"darkCrossHook":',
            _addr(d.darkCrossHook),
            ',"wrapSwapRouter":',
            _addr(d.wrapSwapRouter),
            ',"eas":',
            _nullable(c.eas),
            ',"easIndexer":',
            _nullable(c.easIndexer),
            "}"
        );
    }

    function _tokenJson(
        address token,
        address adapter,
        string memory issuer,
        string memory kind,
        string memory darkRole
    ) internal view returns (string memory) {
        MockIssuerToken t = MockIssuerToken(token);
        string memory a = string.concat(
            '{"symbol":"',
            t.symbol(),
            '","name":"',
            t.name(),
            '","address":',
            _addr(token),
            ',"decimals":',
            vm.toString(uint256(t.decimals())),
            ',"issuer":"',
            issuer,
            '","underlying":"AAPL","mock":true,"adapter":',
            _addr(adapter)
        );
        return string.concat(
            a,
            ',"adapterKind":"',
            kind,
            '","sharesPerTokenX18":"',
            vm.toString(B20MultiplierAdapter(adapter).sharesPerToken()),
            '","darkRole":"',
            darkRole,
            '"}'
        );
    }

    function _poolJson(Deployment memory d) internal pure returns (string memory) {
        return string.concat(
            '"pool":{"id":"',
            vm.toString(PoolId.unwrap(d.key.toId())),
            '","key":{"currency0":',
            _addr(Currency.unwrap(d.key.currency0)),
            ',"currency1":',
            _addr(Currency.unwrap(d.key.currency1)),
            ',"fee":',
            vm.toString(uint256(d.key.fee)),
            ',"tickSpacing":',
            vm.toString(int256(d.key.tickSpacing)),
            ',"hooks":',
            _addr(address(d.key.hooks)),
            '},"initSqrtPriceX96":"',
            vm.toString(uint256(d.initSqrtPriceX96)),
            '"}'
        );
    }

    function _hooksJson(Deployment memory d) internal pure returns (string memory) {
        require(uint160(d.parityHook) & 0x3fff == 0x20c8, "Deploy: parityHook flags != 0x20c8");
        return string.concat(
            '"hooks":{"parityHook":{"address":',
            _addr(d.parityHook),
            ',"flags":"0x20c8","permissions":["beforeInitialize","beforeSwap","afterSwap","beforeSwapReturnDelta"]},',
            '"darkCrossHook":{"address":',
            _addr(d.darkCrossHook),
            ',"flags":"0x0000","permissions":[]}}'
        );
    }

    function _darkJson(Deployment memory d, uint256 batchOrigin) internal view returns (string memory) {
        DarkCrossHook dark = DarkCrossHook(d.darkCrossHook);
        return string.concat(
            '"dark":{"baseToken":',
            _addr(dark.baseToken()),
            ',"quoteToken":',
            _addr(dark.quoteToken()),
            ',"batchOrigin":"',
            vm.toString(batchOrigin),
            '","batchBlocks":',
            vm.toString(dark.BATCH_BLOCKS()),
            ',"commitBlocks":',
            vm.toString(dark.COMMIT_BLOCKS()),
            ',"revealBlocks":',
            vm.toString(dark.REVEAL_BLOCKS()),
            "}"
        );
    }

    function _accountsJson(Config memory c) internal pure returns (string memory s) {
        string[5] memory roles = ["deployer", "demo", "counterpartyA", "counterpartyB", "crank"];
        s = string.concat('"demoAccounts":{"mnemonicSource":"', c.mnemonicSource, '","accounts":[');
        for (uint256 i; i < 5; i++) {
            s = string.concat(
                s,
                i == 0 ? "" : ",",
                '{"role":"',
                roles[i],
                '","index":',
                vm.toString(i),
                ',"address":',
                _addr(c.accounts[i]),
                "}"
            );
        }
        s = string.concat(s, "]}");
    }

    // ---------------------------------------------------------------- manifest(): chain reads

    function _fromJson(string memory j) internal view returns (Deployment memory d) {
        d.poolManager = vm.parseJsonAddress(j, ".contracts.poolManager");
        d.quoter = vm.parseJsonAddress(j, ".contracts.quoter");
        d.swapRouter = vm.parseJsonAddress(j, ".contracts.swapRouter");
        d.modifyLiquidityRouter = vm.parseJsonAddress(j, ".contracts.modifyLiquidityRouter");
        d.registry = vm.parseJsonAddress(j, ".contracts.registry");
        d.calendar = vm.parseJsonAddress(j, ".contracts.calendar");
        d.eligibility = vm.parseJsonAddress(j, ".contracts.eligibility");
        d.oracle = vm.parseJsonAddress(j, ".contracts.oracle");
        d.parityHook = vm.parseJsonAddress(j, ".contracts.parityHook");
        d.darkCrossHook = vm.parseJsonAddress(j, ".contracts.darkCrossHook");
        d.wrapSwapRouter = vm.parseJsonAddress(j, ".contracts.wrapSwapRouter");
        DarkCrossHook dark = DarkCrossHook(d.darkCrossHook);
        d.mcb = dark.baseToken();
        d.maaplx = dark.quoteToken();
        IssuerRegistry registry = IssuerRegistry(d.registry);
        d.mcbAdapter = registry.adapterOf(d.mcb);
        d.maaplxAdapter = registry.adapterOf(d.maaplx);
        d.key = dark.parityPoolKey();
        d.initSqrtPriceX96 = uint160(vm.parseUint(vm.parseJsonString(j, ".pool.initSqrtPriceX96")));
    }

    function _firstBlockWithCode(address a, uint256 lo, uint256 hi) internal returns (uint256) {
        require(_codeAt(a, hi), "Deploy: contract has no code at head");
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_codeAt(a, mid)) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    function _codeAt(address a, uint256 n) internal returns (bool) {
        bytes memory code =
            vm.rpc("eth_getCode", string.concat('["', vm.toString(a), '","', _hexQuantity(n), '"]'));
        return code.length > 0;
    }

    function _firstBlockInitialized(address pm, PoolId id, uint256 lo, uint256 hi) internal returns (uint256) {
        bytes32 slot = keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6))));
        string memory data = vm.toString(abi.encodeWithSignature("extsload(bytes32)", slot));
        require(_initializedAt(pm, data, hi), "Deploy: pool not initialized at head");
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_initializedAt(pm, data, mid)) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    function _initializedAt(address pm, string memory data, uint256 n) internal returns (bool) {
        if (!_codeAt(pm, n)) return false;
        bytes memory word = vm.rpc(
            "eth_call",
            string.concat('[{"to":"', vm.toString(pm), '","data":"', data, '"},"', _hexQuantity(n), '"]')
        );
        return word.length == 32 && uint160(uint256(bytes32(word))) != 0;
    }

    // ---------------------------------------------------------------- formatting helpers

    function _path(string memory network) internal pure returns (string memory) {
        return string.concat("deployments/", network, ".json");
    }

    function _addr(address a) internal pure returns (string memory) {
        return string.concat('"', vm.toString(a), '"');
    }

    function _nullable(address a) internal pure returns (string memory) {
        return a == address(0) ? "null" : _addr(a);
    }

    function _isLowerHex(string memory s, uint256 len) internal pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length != len) return false;
        for (uint256 i; i < b.length; i++) {
            bytes1 ch = b[i];
            if (!((ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f"))) return false;
        }
        return true;
    }

    function _hexQuantity(uint256 n) internal pure returns (string memory) {
        if (n == 0) return "0x0";
        bytes memory digits = "0123456789abcdef";
        uint256 len;
        for (uint256 t = n; t != 0; t >>= 4) {
            len++;
        }
        bytes memory out = new bytes(len);
        for (uint256 i = len; i > 0; i--) {
            out[i - 1] = digits[n & 0xf];
            n >>= 4;
        }
        return string.concat("0x", string(out));
    }

    /// @dev ISO-8601 UTC "YYYY-MM-DDTHH:MM:SSZ" via Howard Hinnant's civil-from-days.
    function _isoTimestamp(uint256 ts) internal pure returns (string memory) {
        uint256 z = ts / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 day = doy - (153 * mp + 2) / 5 + 1;
        uint256 month = mp < 10 ? mp + 3 : mp - 9;
        uint256 year = yoe + era * 400 + (month <= 2 ? 1 : 0);
        uint256 secs = ts % 86400;
        return string.concat(
            vm.toString(year),
            "-",
            _two(month),
            "-",
            _two(day),
            "T",
            _two(secs / 3600),
            ":",
            _two((secs % 3600) / 60),
            ":",
            _two(secs % 60),
            "Z"
        );
    }

    function _two(uint256 v) internal pure returns (string memory) {
        return v < 10 ? string.concat("0", vm.toString(v)) : vm.toString(v);
    }

    /// @dev Exposed for Deploy.t.sol.
    function isoTimestamp(uint256 ts) external pure returns (string memory) {
        return _isoTimestamp(ts);
    }

    function hexQuantity(uint256 n) external pure returns (string memory) {
        return _hexQuantity(n);
    }
}
