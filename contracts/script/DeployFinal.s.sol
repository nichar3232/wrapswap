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
import {IIssuerRegistry} from "../src/interfaces/IIssuerRegistry.sol";
import {EASEligibility} from "../src/EASEligibility.sol";
import {ParityHook} from "../src/ParityHook.sol";
import {DarkCrossHook} from "../src/DarkCrossHook.sol";
import {WrapSwapRouter} from "../src/WrapSwapRouter.sol";
import {MockIssuerToken} from "../src/mocks/MockIssuerToken.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {TestShareFaucet} from "../src/mocks/TestShareFaucet.sol";

/// @title DeployFinal
/// @notice Unichain Sepolia deployment of the final fee model. Reuses the registry (AAPL/NVDA/TSLA wrappers and
///         adapters already registered), eligibility, oracle, wrappers, adapters and the v4 test routers from the
///         previous manifest; deploys ParityHook (CREATE2-mined), one pool per asset, one DarkCrossHook per asset,
///         WrapSwapRouter and TestShareFaucet; moves eligibility trust to the new router/dark hooks; seeds every pool
///         (AAPL at |skew| 0.20, NVDA/TSLA at 0.10, long the xStocks side) plus LP liquidity; refreshes oracle mids.
///         Reads deployments/unichain-sepolia.json (previous shape), writes deployments/unichain-sepolia.deploy-out.json.
/// Env: DEPLOYER_PK.
contract DeployFinal is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant PARITY_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );
    uint256 internal constant FAUCET_STOCK = 1_000_000; // whole tokens per wrapper = 1,000 claims

    struct Asset {
        string symbol;
        address coinbase;
        address xstocks;
        PoolKey key;
        uint160 sqrtPriceX96;
        address dark;
    }

    string json;
    address deployer;
    IPoolManager pm;
    ParityHook hook;
    Asset[3] assets;

    function run() external {
        json = vm.readFile("deployments/unichain-sepolia.json");
        require(block.chainid == 1301, "DeployFinal: Unichain Sepolia only");
        uint256 pk = vm.envUint("DEPLOYER_PK");
        deployer = vm.addr(pk);
        pm = IPoolManager(a(".contracts.poolManager"));
        IIssuerRegistry registry = IIssuerRegistry(a(".contracts.registry"));
        EASEligibility eligibility = EASEligibility(a(".contracts.eligibility"));
        MockPriceOracle oracle = MockPriceOracle(a(".contracts.oracle"));
        for (uint256 i; i < 3; ++i) {
            string memory base = string.concat(".assets[", vm.toString(i), "]");
            assets[i].symbol = vm.parseJsonString(json, string.concat(base, ".symbol"));
            assets[i].coinbase = vm.parseJsonAddress(json, string.concat(base, ".wrappers[0].token"));
            assets[i].xstocks = vm.parseJsonAddress(json, string.concat(base, ".wrappers[1].token"));
        }

        vm.startBroadcast(pk);
        bytes memory args = abi.encode(address(pm), address(registry), address(eligibility), deployer);
        bytes memory code = type(ParityHook).creationCode;
        (address predicted, bytes32 salt) = HookMiner.find(CREATE2_PROXY, PARITY_FLAGS, code, args);
        (bool ok,) = CREATE2_PROXY.call(abi.encodePacked(salt, code, args));
        require(ok && predicted.code.length > 0, "DeployFinal: ParityHook CREATE2 failed");
        require(uint160(predicted) & Hooks.ALL_HOOK_MASK == PARITY_FLAGS, "DeployFinal: hook flags");
        hook = ParityHook(predicted);

        WrapSwapRouter router = new WrapSwapRouter(pm);
        eligibility.setTrustedRouter(address(router), true);
        eligibility.setTrustedRouter(a(".contracts.wrapSwapRouter"), false);
        eligibility.setTrustedRouter(a(".contracts.darkCrossHook"), false);

        address[] memory faucetTokens = new address[](6);
        for (uint256 i; i < 3; ++i) {
            Asset storage x = assets[i];
            _initPool(x);
            x.dark = address(
                new DarkCrossHook(pm, hook, oracle, eligibility, x.coinbase, x.xstocks, x.key, deployer, deployer)
            );
            eligibility.setTrustedRouter(x.dark, true);
            // AAPL deliberately at |skew| 0.20 (8,000 vs 12,000 shares); NVDA/TSLA at 0.10 (9,000 vs 11,000).
            (uint256 cbShares, uint256 xsShares) = i == 0 ? (8_000e18, 12_000e18) : (9_000e18, 11_000e18);
            _seed(x, cbShares, xsShares);
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

        _write(address(router), address(faucet));
    }

    function a(string memory path) internal view returns (address) {
        return vm.parseJsonAddress(json, path);
    }

    function _spt(address token) internal view returns (uint256) {
        return MockIssuerToken(token).multiplier();
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

    /// @dev Hook inventory at the given canonical shares per side, plus ~1,000 shares a side of LP liquidity around
    ///      parity for the fall-through path.
    function _seed(Asset memory x, uint256 cbShares, uint256 xsShares) internal {
        uint256 cb = FullMath.mulDivRoundingUp(cbShares, 1e6, _spt(x.coinbase));
        uint256 xs = FullMath.mulDivRoundingUp(xsShares, 1e18, _spt(x.xstocks));
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
        uint256 cbAmt = FullMath.mulDiv(1_000e18, 1e6, _spt(x.coinbase));
        uint256 xsAmt = FullMath.mulDiv(1_000e18, 1e18, _spt(x.xstocks));
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            x.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            cbIs0 ? cbAmt : xsAmt,
            cbIs0 ? xsAmt : cbAmt
        );
        MockIssuerToken(x.coinbase).approve(router, type(uint256).max);
        MockIssuerToken(x.xstocks).approve(router, type(uint256).max);
        PoolModifyLiquidityTest(router).modifyLiquidity(
            x.key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), bytes32(0)), ""
        );
    }

    function _write(address router, address faucet) internal {
        string memory out = string.concat(
            '{"parityHook":"', vm.toString(address(hook)), '","router":"', vm.toString(router), '","faucet":"',
            vm.toString(faucet), '","protocolFeeRecipient":"', vm.toString(deployer), '","assets":['
        );
        for (uint256 i; i < 3; ++i) {
            Asset memory x = assets[i];
            out = string.concat(
                out,
                i == 0 ? "" : ",",
                '{"symbol":"', x.symbol, '","pool":"', vm.toString(PoolId.unwrap(x.key.toId())), '","darkCross":"',
                vm.toString(x.dark), '","batchOrigin":"', vm.toString(DarkCrossHook(x.dark).batchOrigin()), '"}'
            );
        }
        vm.writeFile("deployments/unichain-sepolia.deploy-out.json", string.concat(out, "]}"));
    }
}
