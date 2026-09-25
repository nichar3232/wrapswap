// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script,console2} from 'forge-std/Script.sol';
import {Currency} from 'v4-core/src/types/Currency.sol';
import {PoolKey} from 'v4-core/src/types/PoolKey.sol';
import {PoolId,PoolIdLibrary} from 'v4-core/src/types/PoolId.sol';
import {IHooks} from 'v4-core/src/interfaces/IHooks.sol';
import {TickMath} from 'v4-core/src/libraries/TickMath.sol';
import {LiquidityAmounts} from 'v4-periphery/src/libraries/LiquidityAmounts.sol';
import {Actions} from 'v4-periphery/src/libraries/Actions.sol';
import {IAllowanceTransfer} from 'permit2/src/interfaces/IAllowanceTransfer.sol';
interface ISeedToken {function mint(address,uint256) external;function approve(address,uint256) external returns(bool);function transfer(address,uint256) external returns(bool);}
interface ISeedVault {function mint(address,uint256,address) external returns(uint256);}
interface ISeedParity {function depositInventory(Currency,uint256) external;}
interface ISeedDark {function fund(Currency,uint256) external;}
interface ISeedPosition {function modifyLiquidities(bytes calldata,uint256) external payable;}
interface ISeedState {function getSlot0(PoolId) external view returns(uint160,int24,uint24,uint24);}
contract Seed is Script {
 using PoolIdLibrary for PoolKey;
 string json;address owner;address vault;address issuer1;address issuer2;address usdc;address parity;address dark;address posm;address permit2;address stateView;
 function run() external {
  require(block.chainid==8453&&vm.envOr('FORK_DEMO',false),'fork only');json=vm.readFile('deployments/local.json');
  uint pk=vm.envUint('DEPLOYER_PK');owner=vm.addr(pk);vault=_a('.contracts.vault');issuer1=_a('.tokens.issuer1.address');issuer2=_a('.tokens.issuer2.address');usdc=_a('.tokens.USDC.address');parity=_a('.contracts.parityHook');dark=_a('.contracts.darkCrossHook');posm=_a('.contracts.positionManager');permit2=_a('.contracts.permit2');stateView=_a('.contracts.stateView');
  vm.startBroadcast(pk);
  ISeedToken(issuer1).mint(owner,200000e8);ISeedToken(issuer2).mint(owner,200000e18);
  ISeedToken(issuer1).approve(vault,type(uint256).max);ISeedToken(issuer2).approve(vault,type(uint256).max);
  ISeedVault(vault).mint(issuer1,100000e8,owner);ISeedVault(vault).mint(issuer2,100000e18,owner);
  _inventory(vault,40000e18);_inventory(issuer1,20000e8);_inventory(issuer2,20000e18);
  address[4] memory tokens=[vault,issuer1,issuer2,usdc];
  for(uint i;i<4;i++){ISeedToken(tokens[i]).approve(permit2,type(uint256).max);IAllowanceTransfer(permit2).approve(tokens[i],posm,type(uint160).max,type(uint48).max);}
  _liquidity(_pool(0),5000e18,5000e8,600);
  _liquidity(_pool(1),5000e18,5000e18,600);
  _liquidity(_pool(2),1000e18,500000e6,240);
  for(uint i;i<3;i++){
   (address burner,)=_burner(i);
   ISeedToken(vault).transfer(burner,1000e18);ISeedToken(issuer1).transfer(burner,100e8);ISeedToken(issuer2).transfer(burner,100e18);ISeedToken(usdc).transfer(burner,100000e6);
   payable(burner).transfer(10 ether);
  }
  vm.stopBroadcast();
  string memory burners='[';
  for(uint i;i<3;i++){
   (address burner,uint burnerPk)=_burner(i);vm.startBroadcast(burnerPk);
   ISeedToken(vault).approve(dark,type(uint256).max);ISeedToken(usdc).approve(dark,type(uint256).max);
   ISeedDark(dark).fund(Currency.wrap(vault),100e18);ISeedDark(dark).fund(Currency.wrap(usdc),10000e6);vm.stopBroadcast();
   burners=string.concat(burners,i==0?'':',','{"address":"',vm.toString(burner),'","privateKey":"',vm.toString(bytes32(burnerPk)),'"}');
  }
  burners=string.concat(burners,']');vm.writeJson(burners,'deployments/local.json','.burners');console2.log('Seed complete: real PositionManager positions, ERC6909 inventory, three funded escrows');
 }
 function _a(string memory path) internal view returns(address){return vm.parseJsonAddress(json,path);}
 function _burner(uint i) internal pure returns(address,uint256){uint pk=uint256(keccak256(abi.encode('WrapSwap PUBLIC LOCAL FORK ONLY burner',i)));return(vm.addr(pk),pk);}
 function _inventory(address token,uint amount) internal{ISeedToken(token).approve(parity,amount);ISeedParity(parity).depositInventory(Currency.wrap(token),amount);}
 function _pool(uint i) internal view returns(PoolKey memory){string memory p=string.concat('.pools[',vm.toString(i),'].key');return PoolKey(Currency.wrap(_a(string.concat(p,'.currency0'))),Currency.wrap(_a(string.concat(p,'.currency1'))),uint24(vm.parseJsonUint(json,string.concat(p,'.fee'))),int24(int256(vm.parseJsonUint(json,string.concat(p,'.tickSpacing')))),IHooks(_a(string.concat(p,'.hooks'))));}
 function _liquidity(PoolKey memory key,uint256 vaultAmount,uint256 otherAmount,int24 width) internal {
  (uint160 sqrt,int24 tick,,)=ISeedState(stateView).getSlot0(key.toId());int24 center=(tick/60)*60;if(tick<0&&tick%60!=0)center-=60;
  int24 lower=center-width;int24 upper=center+width;
  if(key.fee==500){
   // sqrt(0.98), sqrt(1.02), rounded outward at tickSpacing=1.
   lower=TickMath.getTickAtSqrtPrice(uint160(uint256(sqrt)*989949493661166534/1e18));
   upper=TickMath.getTickAtSqrtPrice(uint160(uint256(sqrt)*1009950493836207795/1e18))+1;
  }
  uint256 amount0=Currency.unwrap(key.currency0)==vault?vaultAmount:otherAmount;uint256 amount1=Currency.unwrap(key.currency1)==vault?vaultAmount:otherAmount;
  uint128 liquidity=LiquidityAmounts.getLiquidityForAmounts(sqrt,TickMath.getSqrtPriceAtTick(lower),TickMath.getSqrtPriceAtTick(upper),amount0,amount1);
  bytes memory actions=abi.encodePacked(uint8(Actions.MINT_POSITION),uint8(Actions.SETTLE_PAIR));bytes[] memory params=new bytes[](2);
  params[0]=abi.encode(key,lower,upper,uint256(liquidity),uint128(amount0+1),uint128(amount1+1),owner,bytes(''));params[1]=abi.encode(key.currency0,key.currency1);
  ISeedPosition(posm).modifyLiquidities(abi.encode(actions,params),block.timestamp+1 hours);
 }
}
