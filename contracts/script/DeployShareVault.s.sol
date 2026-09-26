// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {ShareVault} from "../src/ShareVault.sol";
import {IIssuerRegistry} from "../src/interfaces/IIssuerRegistry.sol";
import {IWrapSwapRouter} from "../src/interfaces/IWrapSwapRouter.sol";

/// @notice Deploys ShareVault against an existing Unison deployment manifest (default deployments/unichain-sepolia.json)
///         and authorises the keeper. Reads only; the manifest is never rewritten here.
/// Env: DEPLOYER_PRIVATE_KEY, optional SHARE_VAULT_MANIFEST, optional SHARE_VAULT_KEEPER (defaults to the deployer).
contract DeployShareVault is Script {
    function run() external returns (ShareVault vault) {
        string memory path = vm.envOr("SHARE_VAULT_MANIFEST", string("deployments/unichain-sepolia.json"));
        string memory j = vm.readFile(path);
        require(vm.parseJsonUint(j, ".chainId") == block.chainid, "manifest chainId != RPC chain");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(vm.parseJsonAddress(j, ".pool.key.currency0")),
            currency1: Currency.wrap(vm.parseJsonAddress(j, ".pool.key.currency1")),
            fee: uint24(vm.parseJsonUint(j, ".pool.key.fee")),
            tickSpacing: int24(int256(vm.parseJsonInt(j, ".pool.key.tickSpacing"))),
            hooks: IHooks(vm.parseJsonAddress(j, ".pool.key.hooks"))
        });
        IIssuerRegistry registry = IIssuerRegistry(vm.parseJsonAddress(j, ".contracts.registry"));
        IWrapSwapRouter router = IWrapSwapRouter(vm.parseJsonAddress(j, ".contracts.wrapSwapRouter"));

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address keeper = vm.envOr("SHARE_VAULT_KEEPER", deployer);

        vm.startBroadcast(pk);
        vault = new ShareVault(registry, router, key, deployer);
        vault.setKeeper(keeper, true);
        vm.stopBroadcast();

        console2.log("ShareVault", address(vault));
        console2.log("keeper", keeper);
        console2.log("block", block.number);
    }
}
