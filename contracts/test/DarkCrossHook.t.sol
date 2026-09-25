// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DarkCrossHook,IDarkEAS} from "../src/DarkCrossHook.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {ModifyLiquidityParams,SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
contract DarkToken is ERC20 {uint8 private d;constructor(uint8 dec)ERC20("Test","T"){d=dec;}function decimals()public view override returns(uint8){return d;}function mint(address to,uint256 n)external{_mint(to,n);}}
contract DarkOracle {uint256 public updatedAt;int256 public answer=200e8;constructor(){updatedAt=block.timestamp;}function decimals()external pure returns(uint8){return 8;}function stale()external{updatedAt=0;}function latestRoundData()external view returns(uint80,int256,uint256,uint256,uint80){return(1,answer,updatedAt,updatedAt,1);}}
contract DarkCalendar {bool public open=true;function setOpen(bool b)external{open=b;}function isOpen(uint256)external view returns(bool){return open;}}
contract DarkEAS is IDarkEAS {Attestation private a;function set(Attestation memory x)external{a=x;}function getAttestation(bytes32)external view returns(Attestation memory){return a;}}
contract DarkCrossHookTest is Test {
    IPoolManager manager;DarkCrossHook hook;DarkToken stock;DarkToken cash;DarkOracle oracle;DarkCalendar calendar;DarkEAS eas;PoolKey key;PoolSwapTest router;PoolModifyLiquidityTest lp;
    address alice=address(0xa11ce);address bob=address(0xb0b);address carol=address(0xca201);address treasury=address(0xfee);bytes32 constant SALT=bytes32(uint256(42));bytes32 constant SCHEMA=bytes32(uint256(123));
    function setUp() public virtual {
        vm.warp(1790337600);manager=block.chainid==8453?IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b):IPoolManager(address(new PoolManager(address(this))));stock=new DarkToken(18);cash=new DarkToken(6);oracle=new DarkOracle();calendar=new DarkCalendar();eas=new DarkEAS();
        _deploy(true);router=new PoolSwapTest(manager);lp=new PoolModifyLiquidityTest(manager);
        stock.mint(address(this),1e30);cash.mint(address(this),1e24);stock.approve(address(lp),type(uint256).max);cash.approve(address(lp),type(uint256).max);stock.approve(address(router),type(uint256).max);cash.approve(address(router),type(uint256).max);
        lp.modifyLiquidity(key,ModifyLiquidityParams(-887220,887220,1e20,0),"");
        _fund(alice);_fund(bob);_fund(carol);
    }
    function _deploy(bool demo) internal {
        DarkCrossHook impl=new DarkCrossHook(manager,address(stock),address(cash),address(oracle),address(calendar),address(eas),SCHEMA,treasury,address(this),demo);
        address addr=address(uint160(0x100000+0x8c0));vm.etch(addr,address(impl).code);hook=DarkCrossHook(addr);
        key=PoolKey(Currency.wrap(address(stock)<address(cash)?address(stock):address(cash)),Currency.wrap(address(stock)<address(cash)?address(cash):address(stock)),500,60,IHooks(addr));
        // Runtime copy has immutable constructor parameters and empty storage, matching CREATE2 runtime.
        uint256 r=address(stock)<address(cash)?uint256(200e18)*(1<<128)/1e30:uint256(1e30)*(1<<128)/200e18;
        manager.initialize(key,uint160(Math.sqrt(r)<<32));hook.configurePool(key);
    }
    function _fund(address a)internal{vm.deal(a,100 ether);stock.mint(a,100e18);cash.mint(a,100_000e6);vm.startPrank(a);stock.approve(address(hook),type(uint256).max);cash.approve(address(hook),type(uint256).max);hook.fund(Currency.wrap(address(stock)),100e18);hook.fund(Currency.wrap(address(cash)),100_000e6);vm.stopPrank();}
    function _commit(address a,bool buy,uint256 q,uint256 p,bool route)internal { (uint256 id,,)=hook.currentBatch();bytes32 hash=keccak256(abi.encode(buy,q,p,route,SALT,id,a));uint256 lock=buy?hook.requiredBuyLock(q,p):q;vm.prank(a);hook.commit(hash,Currency.wrap(buy?address(cash):address(stock)),lock,0);}
    function _reveal(address a,bool buy,uint256 q,uint256 p,bool route)internal{vm.prank(a);hook.reveal(buy,q,p,route,SALT);}
    function _phase(uint256 pos)internal{vm.roll(hook.batchOrigin()+pos);}
    function _assertEscrow()internal view{address[4]memory users=[alice,bob,carol,treasury];uint256 s;uint256 c;for(uint256 i;i<4;i++){(uint256 a,uint256 l)=hook.balances(users[i],Currency.wrap(address(stock)));s+=a+l;(a,l)=hook.balances(users[i],Currency.wrap(address(cash)));c+=a+l;}assertEq(s,stock.balanceOf(address(hook)));assertEq(c,cash.balanceOf(address(hook)));}
    function testThreeWalletCrossAndResidualSameTx()public{
        _commit(alice,true,10e18,205e18,true);_commit(bob,true,5e18,205e18,false);_commit(carol,false,9e18,195e18,false);_phase(12);
        _reveal(alice,true,10e18,205e18,true);_reveal(bob,true,5e18,205e18,false);_reveal(carol,false,9e18,195e18,false);_phase(18);
        vm.recordLogs();hook.settle(0);Vm.Log[]memory logs=vm.getRecordedLogs();bool cross;bool route;for(uint256 i;i<logs.length;i++){if(logs[i].topics[0]==keccak256("Crossed(uint256,address,bool,uint256,uint256)"))cross=true;if(logs[i].topics[0]==keccak256("RoutedToLit(uint256,address,bool,uint256,uint256)"))route=true;}assertTrue(cross);assertTrue(route);_assertEscrow();
        (uint256 a,)=hook.balances(alice,Currency.wrap(address(stock)));assertEq(a,110e18);
    }
    function testSellResidual()public{_commit(alice,false,3e18,195e18,true);_phase(12);_reveal(alice,false,3e18,195e18,true);_phase(18);hook.settle(0);(uint256 a,)=hook.balances(alice,Currency.wrap(address(stock)));assertEq(a,97e18);_assertEscrow();}
    function testLimitExclusion()public{_commit(alice,true,3e18,190e18,true);_commit(carol,false,3e18,195e18,false);_phase(12);_reveal(alice,true,3e18,190e18,true);_reveal(carol,false,3e18,195e18,false);_phase(18);hook.settle(0);(uint256 a,)=hook.balances(alice,Currency.wrap(address(stock)));assertEq(a,100e18);_assertEscrow();}
    function testForfeit()public{_commit(alice,true,3e18,200e18,false);_commit(bob,true,3e18,200e18,false);_phase(12);_reveal(bob,true,3e18,200e18,false);_phase(18);hook.settle(0);(uint256 a,)=hook.balances(bob,Currency.wrap(address(cash)));assertGt(a,100_000e6);_assertEscrow();}
    function testExternalSwapSettleReverts()public{_phase(18);vm.expectRevert();router.swap(key,SwapParams(true,-int256(1e6),TickMath.MIN_SQRT_PRICE+1),PoolSwapTest.TestSettings(false,false),"");}
    function testWeekendTwap()public{calendar.setOpen(false);vm.warp(block.timestamp+1800);_phase(18);vm.expectEmit(true,false,false,true);emit DarkCrossHook.MidSelected(0,1,hook.twapPrice());hook.settle(0);assertApproxEqRel(hook.twapPrice(),200e18,1e14);}
    function testStaleTwap()public{oracle.stale();vm.warp(block.timestamp+1800);_phase(18);vm.expectEmit(true,false,false,true);emit DarkCrossHook.MidSelected(0,1,hook.twapPrice());hook.settle(0);}
    function testTwapMissingHistoryReverts()public{calendar.setOpen(false);_phase(18);vm.expectRevert(DarkCrossHook.InsufficientHistory.selector);hook.settle(0);}
    function testDroppedUnderfundedNoForfeit()public{bytes32 h=keccak256(abi.encode(true,3e18,200e18,false,SALT,uint256(0),alice));vm.prank(alice);hook.commit(h,Currency.wrap(address(cash)),1,0);_phase(12);_reveal(alice,true,3e18,200e18,false);_phase(18);hook.settle(0);(uint256 a,)=hook.balances(alice,Currency.wrap(address(cash)));assertEq(a,100_000e6);_assertEscrow();}
    function testCommitRevealPhaseAndReplay()public{_commit(alice,true,1e18,200e18,false);vm.prank(alice);vm.expectRevert(DarkCrossHook.InvalidOrder.selector);hook.commit(bytes32(uint256(1)),Currency.wrap(address(cash)),1,0);vm.prank(alice);vm.expectRevert(DarkCrossHook.WrongPhase.selector);hook.reveal(true,1e18,200e18,false,SALT);_phase(18);hook.settle(0);vm.expectRevert(DarkCrossHook.AlreadySettled.selector);hook.settle(0);}
    function testWithdrawAvailableOnly()public{_commit(alice,false,5e18,200e18,false);vm.prank(alice);vm.expectRevert();hook.withdraw(Currency.wrap(address(stock)),96e18);vm.prank(alice);hook.withdraw(Currency.wrap(address(stock)),95e18);_assertEscrow();}
    function testFuzzEscrowProRata(uint96 buyA,uint96 buyB,uint96 sell)public{uint256 a=bound(uint256(buyA),1e12,20e18);uint256 b=bound(uint256(buyB),1e12,20e18);uint256 s=bound(uint256(sell),1e12,20e18);_commit(alice,true,a,201e18,false);_commit(bob,true,b,201e18,false);_commit(carol,false,s,199e18,false);_phase(12);_reveal(alice,true,a,201e18,false);_reveal(bob,true,b,201e18,false);_reveal(carol,false,s,199e18,false);_phase(18);hook.settle(0);_assertEscrow();(uint256 av,uint256 locked)=hook.balances(carol,Currency.wrap(address(stock)));assertEq(av,100e18-Math.min(a+b,s));assertEq(locked,0);}
    function testGateRejectsUnattested()public{
        // Separate address ensures its pool/storage are independent of demo hook.
        DarkCrossHook impl=new DarkCrossHook(manager,address(stock),address(cash),address(oracle),address(calendar),address(eas),SCHEMA,treasury,address(this),false);address addr=address(uint160(0x200000+0x8c0));vm.etch(addr,address(impl).code);DarkCrossHook gated=DarkCrossHook(addr);
        vm.prank(alice);vm.expectRevert(DarkCrossHook.Unauthorized.selector);gated.commit(bytes32(uint256(1)),Currency.wrap(address(cash)),1,bytes32(uint256(9)));
        IDarkEAS.Attestation memory a=IDarkEAS.Attestation(bytes32(uint256(9)),SCHEMA,uint64(block.timestamp),0,0,0,alice,address(0xbad),true,"");eas.set(a);vm.prank(alice);vm.expectRevert(DarkCrossHook.Unauthorized.selector);gated.commit(bytes32(uint256(1)),Currency.wrap(address(cash)),1,bytes32(uint256(9)));
        a.attester=gated.TRUSTED_ATTESTER();eas.set(a);vm.startPrank(alice);cash.mint(alice,10);cash.approve(addr,10);gated.fund(Currency.wrap(address(cash)),10);gated.commit(bytes32(uint256(1)),Currency.wrap(address(cash)),1,bytes32(uint256(9)));vm.stopPrank();
    }
}
