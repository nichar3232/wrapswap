// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IParityHook} from "../../src/interfaces/IParityHook.sol";

/// @notice Opens its own unlock and, inside it, calls ParityHook.depositInventory (S3b).
contract ForeignUnlocker is IUnlockCallback {
    IPoolManager public immutable manager;
    IParityHook public immutable hook;

    constructor(IPoolManager m, IParityHook h) {
        manager = m;
        hook = h;
    }

    function run(Currency c, uint256 amount) external {
        IERC20(Currency.unwrap(c)).approve(address(hook), amount);
        manager.unlock(abi.encode(c, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (Currency c, uint256 amount) = abi.decode(data, (Currency, uint256));
        hook.depositInventory(c, amount);
        return "";
    }
}

/// @notice Mints ERC-6909 claims directly to a recipient inside its own unlock (S2 donation).
contract ClaimDonor is IUnlockCallback {
    IPoolManager public immutable manager;

    constructor(IPoolManager m) {
        manager = m;
    }

    function donate(Currency c, address to, uint256 amount) external {
        manager.unlock(abi.encode(c, to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (Currency c, address to, uint256 amount) = abi.decode(data, (Currency, address, uint256));
        manager.sync(c);
        IERC20(Currency.unwrap(c)).transfer(address(manager), amount);
        manager.settle();
        manager.mint(to, c.toId(), amount);
        return "";
    }
}

library RevertDecoder {
    /// @dev Splits CustomRevert.WrappedError(target, selector, reason, details) into its parts.
    function unwrap(bytes memory err)
        internal
        pure
        returns (bytes4 outer, address target, bytes4 selector, bytes memory reason)
    {
        assembly ("memory-safe") {
            outer := mload(add(err, 32))
        }
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; i++) {
            body[i] = err[i + 4];
        }
        (target, selector, reason,) = abi.decode(body, (address, bytes4, bytes, bytes));
    }

    function selectorOf(bytes memory err) internal pure returns (bytes4 s) {
        assembly ("memory-safe") {
            s := mload(add(err, 32))
        }
    }
}
