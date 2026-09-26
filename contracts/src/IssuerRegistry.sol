// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IIssuerRegistry} from "./interfaces/IIssuerRegistry.sol";
import {IWrapperAdapter} from "./interfaces/IWrapperAdapter.sol";

/// @notice Owner-curated issuer tokens, each bound to one adapter and one underlying security.
contract IssuerRegistry is IIssuerRegistry, Ownable {
    address[] private _list;
    mapping(address => address) public adapterOf;
    mapping(address => bytes32) public underlyingOf;
    mapping(address => bool) public paused;

    constructor(address owner_) Ownable(owner_) {}

    function add(address adapter) external onlyOwner {
        address token = _adapterToken(adapter);
        if (adapterOf[token] != address(0)) revert AlreadyRegistered(token);
        bytes32 underlying = IWrapperAdapter(adapter).underlying();
        if (underlying == bytes32(0) || IWrapperAdapter(adapter).tokenDecimals() > 18) revert InvalidAdapter(adapter);
        (uint256 spt, bool healthy) = IWrapperAdapter(adapter).ratio();
        if (spt == 0 || !healthy) revert InvalidAdapter(adapter);
        adapterOf[token] = adapter;
        underlyingOf[token] = underlying;
        _list.push(adapter);
        emit IssuerAdded(token, adapter, underlying);
    }

    function remove(address token) external onlyOwner {
        address adapter = adapterOf[token];
        if (adapter == address(0)) revert UnknownIssuer(token);
        bytes32 underlying = underlyingOf[token];
        delete adapterOf[token];
        delete underlyingOf[token];
        delete paused[token];
        uint256 n = _list.length;
        for (uint256 i; i < n; i++) {
            if (_list[i] == adapter) {
                _list[i] = _list[n - 1];
                _list.pop();
                break;
            }
        }
        emit IssuerRemoved(token, adapter, underlying);
    }

    function setPaused(address token, bool paused_) external onlyOwner {
        if (adapterOf[token] == address(0)) revert UnknownIssuer(token);
        paused[token] = paused_;
        emit IssuerPaused(token, paused_);
    }

    function adapters() external view returns (address[] memory) {
        return _list;
    }

    function isIssuer(address token) public view returns (bool) {
        return adapterOf[token] != address(0);
    }

    function active(address token) external view returns (bool) {
        address adapter = adapterOf[token];
        if (adapter == address(0) || paused[token]) return false;
        try IWrapperAdapter(adapter).ratio() returns (uint256 spt, bool healthy) {
            return healthy && spt != 0;
        } catch {
            return false;
        }
    }

    function _adapterToken(address adapter) private view returns (address token) {
        if (adapter.code.length == 0) revert InvalidAdapter(adapter);
        try IWrapperAdapter(adapter).token() returns (address t) {
            token = t;
        } catch {
            revert InvalidAdapter(adapter);
        }
        if (token == address(0)) revert InvalidAdapter(adapter);
    }
}
