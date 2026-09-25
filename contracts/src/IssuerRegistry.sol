// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IIssuerAdapter} from "./adapters/IIssuerAdapter.sol";

contract IssuerRegistry is Ownable {
    address[] private list;
    mapping(address => address) public adapterOf;
    mapping(address => bool) public paused;
    event IssuerAdded(address token, address adapter);
    event IssuerRemoved(address token, address adapter);
    event IssuerPaused(address token);
    constructor(address o) Ownable(o) {}

    function add(address a) external onlyOwner {
        address t = IIssuerAdapter(a).token();
        require(t != address(0) && adapterOf[t] == address(0) && IIssuerAdapter(a).sharesPerToken() > 0);
        adapterOf[t] = a;
        list.push(a);
        paused[t] = false;
        emit IssuerAdded(t, a);
    }

    function remove(address a) external onlyOwner {
        address t = IIssuerAdapter(a).token();
        require(adapterOf[t] == a);
        delete adapterOf[t];
        for (uint256 i; i < list.length; i++) {
            if (list[i] == a) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        emit IssuerRemoved(t, a);
    }

    function pause(address a) external onlyOwner {
        address t = IIssuerAdapter(a).token();
        require(adapterOf[t] == a);
        paused[t] = true;
        emit IssuerPaused(t);
    }

    function adapters() external view returns (address[] memory) {
        return list;
    }

    function isIssuer(address t) public view returns (bool) {
        return adapterOf[t] != address(0);
    }

    function active(address t) external view returns (bool) {
        return isIssuer(t) && !paused[t] && !IIssuerAdapter(adapterOf[t]).paused();
    }
}
