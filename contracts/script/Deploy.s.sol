// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script,console2} from 'forge-std/Script.sol';
import {Addresses} from './Addresses.sol';
import {IPoolManager} from 'v4-core/src/interfaces/IPoolManager.sol';
import {IHooks} from 'v4-core/src/interfaces/IHooks.sol';
import {Currency} from 'v4-core/src/types/Currency.sol';
import {PoolKey} from 'v4-core/src/types/PoolKey.sol';
import {PoolId,PoolIdLibrary} from 'v4-core/src/types/PoolId.sol';
import {Hooks} from 'v4-core/src/libraries/Hooks.sol';
import {LPFeeLibrary} from 'v4-core/src/libraries/LPFeeLibrary.sol';
import {HookMiner} from 'v4-periphery/test/shared/HookMiner.sol';
import {PoolSwapTest} from 'v4-core/src/test/PoolSwapTest.sol';
import {Math} from '@openzeppelin/contracts/utils/math/Math.sol';
import {MockOracle} from '../src/mocks/MockOracle.sol';
interface IDeployRegistry {function add(address) external;}
interface IDeployDark {function configurePool(PoolKey calldata) external;}
interface IDeployPosition {function initializePool(PoolKey calldata,uint160) external payable returns(int24);}
interface IDeployFeed {function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80);}
/// @notice Chain-aware CREATE2 hook deployment; artifacts permit separate workstreams without duplicate ABIs.
contract Deploy is Script {
 using PoolIdLibrary for PoolKey;
 address constant CREATE2_PROXY=0x4e59b44847b379578588920cA78FbF26c0B4956C;
 address constant LIVE_AAPL=0xb200000000000000000000C2e324d24d7eEcd1fb;
 bytes32 constant SCHEMA=0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9;
 address registry;address vault;address calendar;address parity;address dark;address issuer1;address issuer2;address router;address owner;
 Addresses.Network n; bool mockB20;
 function run() external {
  n=Addresses.forChain(block.chainid);uint256 pk=vm.envUint('DEPLOYER_PK');owner=vm.addr(pk);
  mockB20=block.chainid!=8453||vm.envOr('FORK_DEMO',false);
  vm.startBroadcast(pk);
  registry=_deploy('IssuerRegistry.sol:IssuerRegistry',abi.encode(owner));
  issuer1=mockB20?_deploy('MockB20.sol:MockB20',''):LIVE_AAPL;
  issuer2=_deploy('MockIssuerToken.sol:MockIssuerToken',abi.encode('Mock Apple xStock','mAAPLx',uint8(18)));
  address adapter1=_deploy('B20Adapter.sol:B20Adapter',abi.encode(issuer1));
  address adapter2=_deploy('StaticAdapter.sol:StaticAdapter',abi.encode(issuer2,'Mock Apple xStock',uint256(1e18),owner));
  IDeployRegistry(registry).add(adapter1);IDeployRegistry(registry).add(adapter2);
  vault=_deploy('CanonicalStock.sol:CanonicalStock',abi.encode(registry,owner));
  calendar=_deploy('NyseCalendar.sol:NyseCalendar',abi.encode(owner));
  if(block.chainid==84532){n.usdc=_deploy('MockIssuerToken.sol:MockIssuerToken',abi.encode('Mock USD Coin','USDC',uint8(6)));n.oracle=address(new MockOracle(33972e6));}
  bytes memory pArgs=abi.encode(n.poolManager,registry,vault,calendar,owner);
  parity=_hook('ParityHook.sol:ParityHook',pArgs,uint160(Hooks.BEFORE_INITIALIZE_FLAG|Hooks.BEFORE_SWAP_FLAG|Hooks.AFTER_SWAP_FLAG|Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG));
  bytes memory dArgs=abi.encode(n.poolManager,vault,n.usdc,n.oracle,calendar,n.eas,SCHEMA,owner,owner,true);
  dark=_hook('DarkCrossHook.sol:DarkCrossHook',dArgs,uint160(Hooks.BEFORE_SWAP_FLAG|Hooks.AFTER_SWAP_FLAG|Hooks.BEFORE_ADD_LIQUIDITY_FLAG));
  router=address(new PoolSwapTest(IPoolManager(n.poolManager)));
  PoolKey memory p1=_key(vault,issuer1,LPFeeLibrary.DYNAMIC_FEE_FLAG,parity);
  PoolKey memory p2=_key(vault,issuer2,LPFeeLibrary.DYNAMIC_FEE_FLAG,parity);
  PoolKey memory lit=_key(vault,n.usdc,500,dark);
  IDeployPosition(n.positionManager).initializePool(p1,_sqrtFor(vault,issuer1,1e18,1e8));
  IDeployPosition(n.positionManager).initializePool(p2,uint160(1<<96));
  (,int256 px,,,)=IDeployFeed(n.oracle).latestRoundData();require(px>0,'invalid oracle');
  IDeployPosition(n.positionManager).initializePool(lit,_sqrtFor(vault,n.usdc,1e18,uint256(px)/100));
  IDeployDark(dark).configurePool(lit);
  vm.stopBroadcast();
  _manifest(p1,p2,lit);
  console2.log('Registry',registry);console2.log('uAAPL',vault);console2.log('ParityHook',parity);console2.log('DarkCrossHook',dark);
 }
 function _deploy(string memory artifact,bytes memory args) internal returns(address addr){bytes memory code=abi.encodePacked(vm.getCode(artifact),args);assembly('memory-safe'){addr:=create(0,add(code,32),mload(code))}require(addr!=address(0),'deployment failed');}
 function _hook(string memory artifact,bytes memory args,uint160 flags) internal returns(address addr){bytes memory code=vm.getCode(artifact);bytes32 salt;(addr,salt)=HookMiner.find(CREATE2_PROXY,flags,code,args);bytes memory init=abi.encodePacked(salt,code,args);(bool ok,)=CREATE2_PROXY.call(init);require(ok&&addr.code.length>0,'CREATE2 failed');}
 function _key(address a,address b,uint24 fee,address hook) internal pure returns(PoolKey memory){return PoolKey(Currency.wrap(a<b?a:b),Currency.wrap(a<b?b:a),fee,60,IHooks(hook));}
 function _sqrtFor(address a,address b,uint256 amountA,uint256 amountB) internal pure returns(uint160){uint256 ratio=a<b?amountB*1e18/amountA:amountA*1e18/amountB;return uint160(Math.sqrt(ratio)*(1<<96)/1e9);}
 function _token(address a,string memory symbol,uint256 decimals_) internal view returns(string memory){return string.concat('{"address":"',vm.toString(a),'","symbol":"',symbol,'","decimals":',vm.toString(decimals_),'}');}
 function _pool(PoolKey memory k,string memory kind) internal view returns(string memory){return string.concat('{"id":"',vm.toString(PoolId.unwrap(k.toId())),'","kind":"',kind,'","key":{"currency0":"',vm.toString(Currency.unwrap(k.currency0)),'","currency1":"',vm.toString(Currency.unwrap(k.currency1)),'","fee":',vm.toString(uint256(k.fee)),',"tickSpacing":60,"hooks":"',vm.toString(address(k.hooks)),'"}}');}
 function _manifest(PoolKey memory p1,PoolKey memory p2,PoolKey memory lit) internal {
  string memory object='contracts';vm.serializeAddress(object,'poolManager',n.poolManager);vm.serializeAddress(object,'positionManager',n.positionManager);vm.serializeAddress(object,'stateView',n.stateView);vm.serializeAddress(object,'quoter',n.quoter);vm.serializeAddress(object,'universalRouter',n.universalRouter);vm.serializeAddress(object,'permit2',n.permit2);vm.serializeAddress(object,'swapRouter',router);vm.serializeAddress(object,'registry',registry);vm.serializeAddress(object,'vault',vault);vm.serializeAddress(object,'calendar',calendar);vm.serializeAddress(object,'parityHook',parity);vm.serializeAddress(object,'darkCrossHook',dark);vm.serializeAddress(object,'oracle',n.oracle);string memory contracts_=vm.serializeAddress(object,'eas',n.eas);
  string memory json=string.concat('{"chainId":',vm.toString(block.chainid),',"blockNumber":"',vm.toString(block.number),'","mockB20":',mockB20?'true':'false',',"demoMode":true,"deployer":"',vm.toString(owner),'","contracts":',contracts_,',"tokens":{"uAAPL":',_token(vault,'uAAPL',18),',"issuer1":',_token(issuer1,mockB20?'mAAPLc':'AAPLc',8),',"issuer2":',_token(issuer2,'mAAPLx',18),',"USDC":',_token(n.usdc,'USDC',6),'},"pools":[',_pool(p1,'parity'),',',_pool(p2,'parity'),',',_pool(lit,'lit'),'],"burners":[]}');
  vm.writeJson(json,block.chainid==84532?'deployments/base-sepolia.json':'deployments/local.json');
 }
}
