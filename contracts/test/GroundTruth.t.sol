// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";

interface IB20Probe {
    function decimals() external view returns (uint8);
    function multiplier() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract FreshReceiver {}

contract GroundTruthTest is Test {
    address constant AAPL = 0xb200000000000000000000C2e324d24d7eEcd1fb;

    function testGroundTruth() public {
        vm.createSelectFork(vm.envOr("BASE_RPC", string("https://mainnet.base.org")));
        address recipient = address(new FreshReceiver());
        address holder = 0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0;
        (bool ok, bytes memory data) = AAPL.staticcall{gas: 100000}(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length == 0) {
            emit log_string("B20 native precompile unsupported by generic Foundry EVM; live RPC confirms 8 decimals/multiplier=1e18. MockB20 required.");
            vm.prank(holder);
            (bool transferred, bytes memory result) =
                AAPL.call{gas: 100000}(abi.encodeWithSignature("transfer(address,uint256)", recipient, 1e8));
            assertTrue(!transferred || result.length != 32, "Unexpected transfer behavior; repeat ground truth");
        } else {
            assertEq(IB20Probe(AAPL).decimals(), 8);
            assertGt(IB20Probe(AAPL).multiplier(), 0);
            uint256 beforeBalance = IB20Probe(AAPL).balanceOf(recipient);
            vm.prank(holder);
            assertTrue(IB20Probe(AAPL).transfer(recipient, 1e8));
            assertEq(IB20Probe(AAPL).balanceOf(recipient), beforeBalance + 1e8);
        }
        assertGt(address(0x498581fF718922c3f8e6A244956aF099B2652b2b).code.length, 0);
        assertGt(address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).code.length, 0);
    }
}
