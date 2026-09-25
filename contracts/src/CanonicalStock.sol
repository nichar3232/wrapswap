// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IssuerRegistry} from "./IssuerRegistry.sol";
import {IIssuerAdapter} from "./adapters/IIssuerAdapter.sol";

contract CanonicalStock is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IssuerRegistry public immutable registry;
    uint256 public constant REDEEM_FEE_BPS = 5;
    mapping(address => uint256) public fees;
    mapping(address => bool) public inventoryProvider;
    mapping(address => bool) public paused;

    struct Backing {
        address token;
        uint256 tokensHeld;
        uint256 spt;
        uint256 sharesRepresented;
    }
    error InsufficientIssuerInventory(address token, uint256 have, uint256 need);
    event Minted(address indexed issuer, address indexed from, uint256 amountIn, uint256 uMinted);
    event Redeemed(address indexed issuer, address indexed to, uint256 uAmount, uint256 out, uint256 fee);
    event BackingSnapshot(uint256 totalShares, uint256 totalSupply);

    constructor(IssuerRegistry r, address o) ERC20("Canonical Apple Share", "uAAPL") Ownable(o) {
        registry = r;
    }

    function mint(address t, uint256 a, address to) external nonReentrant returns (uint256 u) {
        _active(t);
        uint256 beforeBal = IERC20(t).balanceOf(address(this));
        IERC20(t).safeTransferFrom(msg.sender, address(this), a);
        require(IERC20(t).balanceOf(address(this)) - beforeBal == a, "transfer tax");
        u = FullMath.mulDiv(
            a, IIssuerAdapter(registry.adapterOf(t)).sharesPerToken(), 10 ** IERC20Metadata(t).decimals()
        );
        require(u > 0);
        _mint(to, u);
        emit Minted(t, msg.sender, a, u);
        _snapshot();
    }

    function redeem(address t, uint256 u, address to) external nonReentrant returns (uint256 out) {
        _active(t);
        uint256 gross =
            FullMath.mulDiv(
            u, 10 ** IERC20Metadata(t).decimals(), IIssuerAdapter(registry.adapterOf(t)).sharesPerToken()
        );
        uint256 have = IERC20(t).balanceOf(address(this));
        if (have < gross) revert InsufficientIssuerInventory(t, have, gross);
        uint256 fee = FullMath.mulDiv(gross, REDEEM_FEE_BPS, 10000);
        out = gross - fee;
        require(out > 0);
        _burn(msg.sender, u);
        fees[t] += fee;
        IERC20(t).safeTransfer(to, out);
        emit Redeemed(t, to, u, out, fee);
        _snapshot();
    }

    function backing() public view returns (Backing[] memory b, uint256 shares, uint256 supply) {
        address[] memory aa = registry.adapters();
        b = new Backing[](aa.length);
        for (uint256 i; i < aa.length; i++) {
            address t = IIssuerAdapter(aa[i]).token();
            uint256 bal = IERC20(t).balanceOf(address(this));
            uint256 r = IIssuerAdapter(aa[i]).sharesPerToken();
            uint256 s = FullMath.mulDiv(bal, r, 10 ** IERC20Metadata(t).decimals());
            b[i] = Backing(t, bal, r, s);
            shares += s;
        }
        supply = totalSupply();
    }

    function sweepFees(address t, address to) external onlyOwner nonReentrant {
        uint256 a = fees[t];
        fees[t] = 0;
        IERC20(t).safeTransfer(to, a);
        _snapshot();
    }

    function setInventoryProvider(address a, bool b) external onlyOwner {
        inventoryProvider[a] = b;
    }

    /// @notice Only surplus may leave the vault; pull rights never authorize unbacked claims.
    function pullInventory(address t, uint256 amount) external nonReentrant {
        require(inventoryProvider[msg.sender]);
        IERC20(t).safeTransfer(msg.sender, amount);
        _snapshot();
    }

    function pause(address t) external onlyOwner {
        paused[t] = true;
    }

    function _active(address t) private view {
        require(registry.active(t) && !paused[t], "issuer paused");
    }

    function _snapshot() private {
        (, uint256 s, uint256 u) = backing();
        require(s >= u, "underbacked");
        emit BackingSnapshot(s, u);
    }
}
