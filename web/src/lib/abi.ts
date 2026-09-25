import { parseAbi } from "viem";
export const erc20 = parseAbi([
  "function approve(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
]);
export const vaultAbi = parseAbi([
  "function mint(address,uint256,address) returns(uint256)",
  "function redeem(address,uint256,address) returns(uint256)",
]);
export const darkAbi = parseAbi([
  "function balances(address,address) view returns(uint256 available,uint256 locked)",
  "function fund(address,uint256)",
  "function withdraw(address,uint256)",
  "function commit(bytes32,address,uint256,bytes32)",
  "function reveal(bool,uint256,uint256,bool,bytes32)",
  "function settle(uint256)",
]);
export const swapAbi = parseAbi([
  "function swap((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96),(bool takeClaims,bool settleUsingBurn),bytes) returns(int256)",
]);
