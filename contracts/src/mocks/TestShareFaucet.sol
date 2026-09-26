// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Testnet-only faucet: 1,000 whole tokens of every listed mock issuer wrapper to msg.sender, at most once per
///         address per 24 h. Prefunded by the owner (the mocks' mint stays onlyOwner so the deployer keeps its
///         multiplier admin); a claim reverts if any balance is short, so it is all-or-nothing.
contract TestShareFaucet is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant COOLDOWN = 1 days;
    uint256 public constant WHOLE_TOKENS_PER_CLAIM = 1000;

    address[] internal _tokens;
    mapping(address => bool) public listed;
    mapping(address => uint256) public lastClaimAt;

    event TokenListed(address indexed token);
    event Claimed(address indexed account, uint256 timestamp);

    error CooldownActive(uint256 nextClaimAt);
    error AlreadyListed(address token);

    constructor(address owner_, address[] memory tokens_) Ownable(owner_) {
        for (uint256 i; i < tokens_.length; ++i) _list(tokens_[i]);
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function amountOf(address token) public view returns (uint256) {
        return WHOLE_TOKENS_PER_CLAIM * 10 ** IERC20Metadata(token).decimals();
    }

    /// @notice 0 when the account can claim now.
    function nextClaimAt(address account) public view returns (uint256) {
        uint256 last = lastClaimAt[account];
        return last == 0 || block.timestamp >= last + COOLDOWN ? 0 : last + COOLDOWN;
    }

    function claim() external {
        uint256 next = nextClaimAt(msg.sender);
        if (next != 0) revert CooldownActive(next);
        lastClaimAt[msg.sender] = block.timestamp;
        for (uint256 i; i < _tokens.length; ++i) {
            IERC20(_tokens[i]).safeTransfer(msg.sender, amountOf(_tokens[i]));
        }
        emit Claimed(msg.sender, block.timestamp);
    }

    function list(address token) external onlyOwner {
        _list(token);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
    }

    function _list(address token) internal {
        if (listed[token]) revert AlreadyListed(token);
        listed[token] = true;
        _tokens.push(token);
        emit TokenListed(token);
    }
}
