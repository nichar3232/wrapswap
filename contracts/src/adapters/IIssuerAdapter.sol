// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IIssuerAdapter {
    function token() external view returns (address);
    function sharesPerToken() external view returns (uint256);
    function paused() external view returns (bool);
    function name() external view returns (string memory);
}
