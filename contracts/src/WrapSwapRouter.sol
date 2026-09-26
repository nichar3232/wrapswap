// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWrapSwapRouter} from "./interfaces/IWrapSwapRouter.sol";

/// @title WrapSwapRouter
/// @notice See IWrapSwapRouter. One swap per unlock; the input is pulled from the caller only after the pool has
///         priced the swap and the slippage bound has been checked, all inside the same unlock.
contract WrapSwapRouter is IWrapSwapRouter, IUnlockCallback {
    using SafeERC20 for IERC20;

    uint256 internal constant HOOK_DATA_V1_LENGTH = 96;

    IPoolManager public immutable poolManager;

    struct Callback {
        address payer;
        address recipient;
        PoolKey key;
        bool zeroForOne;
        bool exactInput;
        uint128 amount;
        uint128 limit; // amountOutMin (exact in) or amountInMax (exact out)
        bytes hookData;
    }

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    function swapExactIn(ExactInputParams calldata p) external returns (uint256 amountOut) {
        _checkDeadline(p.deadline);
        bytes memory hookData = _hookData(p.hookData, p.recipient);
        bytes memory result = poolManager.unlock(
            abi.encode(Callback(msg.sender, p.recipient, p.key, p.zeroForOne, true, p.amountIn, p.amountOutMin, hookData))
        );
        (, amountOut) = abi.decode(result, (uint256, uint256));
    }

    function swapExactOut(ExactOutputParams calldata p) external returns (uint256 amountIn) {
        _checkDeadline(p.deadline);
        bytes memory hookData = _hookData(p.hookData, p.recipient);
        bytes memory result = poolManager.unlock(
            abi.encode(Callback(msg.sender, p.recipient, p.key, p.zeroForOne, false, p.amountOut, p.amountInMax, hookData))
        );
        (amountIn,) = abi.decode(result, (uint256, uint256));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Callback memory c = abi.decode(raw, (Callback));

        int256 specified = c.exactInput ? -int256(uint256(c.amount)) : int256(uint256(c.amount));
        BalanceDelta delta = poolManager.swap(
            c.key,
            SwapParams({
                zeroForOne: c.zeroForOne,
                amountSpecified: specified,
                sqrtPriceLimitX96: c.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            c.hookData
        );
        (int128 inDelta, int128 outDelta) =
            c.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 amountIn = inDelta < 0 ? uint256(-int256(inDelta)) : 0;
        uint256 amountOut = outDelta > 0 ? uint256(int256(outDelta)) : 0;

        if (c.exactInput) {
            if (amountOut < c.limit) revert TooLittleReceived(amountOut, c.limit);
        } else {
            // A partial fill (price limit or exhausted liquidity) delivers less than the exact output requested.
            if (amountOut < c.amount) revert TooLittleReceived(amountOut, c.amount);
            if (amountIn > c.limit) revert TooMuchRequested(amountIn, c.limit);
        }

        (Currency input, Currency output) =
            c.zeroForOne ? (c.key.currency0, c.key.currency1) : (c.key.currency1, c.key.currency0);
        if (amountIn > 0) {
            poolManager.sync(input);
            IERC20(Currency.unwrap(input)).safeTransferFrom(c.payer, address(poolManager), amountIn);
            poolManager.settle();
        }
        if (amountOut > 0) poolManager.take(output, c.recipient, amountOut);
        return abi.encode(amountIn, amountOut);
    }

    function _checkDeadline(uint256 deadline) internal view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
    }

    /// @dev The eligibility module honours the claimed swapper only for trusted routers, so never forward a claim
    ///      for anyone but the caller. Always forwards ParityHook hookData v2 (swapper, uid, recipient); the optional
    ///      caller hookData (v1, naming msg.sender) only supplies the attestation uid.
    function _hookData(bytes calldata hookData, address recipient) internal view returns (bytes memory) {
        bytes32 uid;
        if (hookData.length != 0) {
            if (hookData.length != HOOK_DATA_V1_LENGTH) revert InvalidHookData();
            uint256 version;
            uint256 swapper;
            (version, swapper, uid) = abi.decode(hookData, (uint256, uint256, bytes32));
            if (version != 1 || swapper >> 160 != 0) revert InvalidHookData();
            if (address(uint160(swapper)) != msg.sender) revert SwapperMismatch(address(uint160(swapper)), msg.sender);
        }
        return abi.encode(uint8(2), msg.sender, uid, recipient);
    }
}
