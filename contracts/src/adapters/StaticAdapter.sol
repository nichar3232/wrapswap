// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IIssuerAdapter} from "./IIssuerAdapter.sol";

contract StaticAdapter is IIssuerAdapter, Ownable {
    address public immutable token;
    string public name;
    uint256 public sharesPerToken;
    bool public paused;

    constructor(address t, string memory n, uint256 r, address o) Ownable(o) {
        require(t != address(0) && r > 0);
        token = t;
        name = n;
        sharesPerToken = r;
    }

    function setSharesPerToken(uint256 r) external onlyOwner {
        require(r > 0);
        sharesPerToken = r;
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
    }
}

contract MockAdapter is StaticAdapter {
    constructor(address t, string memory n, uint256 r, address o) StaticAdapter(t, n, r, o) {}
}
