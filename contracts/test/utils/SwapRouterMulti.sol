// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test router performing N swaps on one pool inside a single unlock, paying from its own balance.
contract SwapRouterMulti is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    constructor(IPoolManager m) {
        manager = m;
    }

    function swaps(PoolKey memory key, SwapParams[] memory params, bytes memory hookData)
        external
        returns (BalanceDelta[] memory deltas)
    {
        deltas = abi.decode(manager.unlock(abi.encode(key, params, hookData)), (BalanceDelta[]));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager));
        (PoolKey memory key, SwapParams[] memory params, bytes memory hookData) =
            abi.decode(data, (PoolKey, SwapParams[], bytes));
        BalanceDelta[] memory deltas = new BalanceDelta[](params.length);
        for (uint256 i; i < params.length; i++) {
            deltas[i] = manager.swap(key, params[i], hookData);
        }
        _resolve(key.currency0);
        _resolve(key.currency1);
        return abi.encode(deltas);
    }

    function _resolve(Currency c) internal {
        int256 d = manager.currencyDelta(address(this), c);
        if (d < 0) {
            manager.sync(c);
            IERC20(Currency.unwrap(c)).transfer(address(manager), uint256(-d));
            manager.settle();
        } else if (d > 0) {
            manager.take(c, address(this), uint256(d));
        }
    }
}
