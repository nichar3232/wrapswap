// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// @title IWrapSwapRouter
/// @notice Thin single-pool swap router over the v4 PoolManager with user-side slippage and deadline protection.
/// @dev Payment is a plain ERC-20 allowance from msg.sender to the router (no Permit2). The router is a trusted
///      router of the eligibility module, so it only forwards ParityHook hookData v1 naming msg.sender as swapper:
///      empty hookData is replaced with abi.encode(uint8(1), msg.sender, bytes32(0)); any other hookData must be
///      exactly that layout with swapper == msg.sender and is passed through unchanged (attestationUid preserved).
interface IWrapSwapRouter {
    struct ExactInputParams {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMin;
        address recipient;
        uint256 deadline;
        bytes hookData;
    }

    struct ExactOutputParams {
        PoolKey key;
        bool zeroForOne;
        uint128 amountOut;
        uint128 amountInMax;
        address recipient;
        uint256 deadline;
        bytes hookData;
    }

    error NotPoolManager();
    error DeadlineExpired(uint256 deadline, uint256 timestamp);
    error TooLittleReceived(uint256 amountOut, uint256 amountOutMin);
    error TooMuchRequested(uint256 amountIn, uint256 amountInMax);
    error SwapperMismatch(address swapper, address sender);
    error InvalidHookData();

    function poolManager() external view returns (IPoolManager);

    /// @notice Sells exactly `amountIn` of the input currency; reverts unless at least `amountOutMin` is received.
    function swapExactIn(ExactInputParams calldata params) external returns (uint256 amountOut);

    /// @notice Buys exactly `amountOut` of the output currency; reverts if more than `amountInMax` would be paid.
    function swapExactOut(ExactOutputParams calldata params) external returns (uint256 amountIn);
}
