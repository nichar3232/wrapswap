// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IssuerRegistry} from "./IssuerRegistry.sol";
import {CanonicalStock} from "./CanonicalStock.sol";
import {NyseCalendar} from "./NyseCalendar.sol";
import {IIssuerAdapter} from "./adapters/IIssuerAdapter.sol";

/// @notice Full custom-accounting parity fills backed exclusively by ERC6909 claims.
contract ParityHook is Ownable {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    IPoolManager public immutable poolManager;
    IssuerRegistry public immutable registry;
    CanonicalStock public immutable vault;
    NyseCalendar public immutable calendar;
    uint256 public constant PEG_GUARD_BPS = 50;
    mapping(address => bool) public providers;
    mapping(Currency => uint256) public feeAccrued;
    error OffParity(uint256 deviationBps);
    event Converted(
        address indexed fromToken, address indexed toToken, uint256 sharesMoved, uint24 feeBps, bool filledByHook
    );
    modifier onlyManager() {
        require(msg.sender == address(poolManager), "manager only");
        _;
    }

    constructor(IPoolManager m, IssuerRegistry r, CanonicalStock v, NyseCalendar c, address o) Ownable(o) {
        poolManager = m;
        registry = r;
        vault = v;
        calendar = c;
        providers[o] = true;
        providers[address(v)] = true;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    function setProvider(address a, bool allowed) external onlyOwner {
        providers[a] = allowed;
    }

    function inventory(Currency c) public view returns (uint256) {
        return poolManager.balanceOf(address(this), c.toId()) - feeAccrued[c];
    }

    function depositInventory(Currency c, uint256 a) external {
        require(providers[msg.sender]);
        require(Currency.unwrap(c) != address(0));
        poolManager.unlock(abi.encode(true, c, a, msg.sender));
    }

    function withdrawInventory(Currency c, uint256 a) external onlyOwner {
        require(a <= inventory(c));
        poolManager.unlock(abi.encode(false, c, a, msg.sender));
    }

    function sweepFees(Currency c, address to) external onlyOwner {
        uint256 a = feeAccrued[c];
        feeAccrued[c] = 0;
        poolManager.unlock(abi.encode(false, c, a, to));
    }

    function unlockCallback(bytes calldata data) external onlyManager returns (bytes memory) {
        (bool deposit, Currency c, uint256 a, address who) = abi.decode(data, (bool, Currency, uint256, address));
        if (deposit) {
            poolManager.sync(c);
            IERC20(Currency.unwrap(c)).safeTransferFrom(who, address(poolManager), a);
            require(poolManager.settle() == a, "transfer tax");
            poolManager.mint(address(this), c.toId(), a);
        } else {
            poolManager.burn(address(this), c.toId(), a);
            poolManager.take(c, who, a);
        }
        return "";
    }

    function beforeInitialize(address, PoolKey calldata key, uint160) external onlyManager returns (bytes4) {
        require(key.fee == LPFeeLibrary.DYNAMIC_FEE_FLAG, "dynamic fee required");
        _issuer(key);
        return this.beforeInitialize.selector;
    }

    function _issuer(PoolKey memory key) private view returns (address t) {
        address a = Currency.unwrap(key.currency0);
        address b = Currency.unwrap(key.currency1);
        require(a == address(vault) || b == address(vault), "canonical side required");
        t = a == address(vault) ? b : a;
        require(registry.active(t), "inactive issuer");
    }

    function feeBpsNow(address issuer) public view returns (uint24) {
        uint256 r = IIssuerAdapter(registry.adapterOf(issuer)).sharesPerToken();
        uint256 a = inventory(Currency.wrap(address(vault)));
        uint256 b = FullMath.mulDiv(inventory(Currency.wrap(issuer)), r, 10 ** IERC20Metadata(issuer).decimals());
        uint256 skew;
        if (a + b > 0) {
            uint256 diff = a > b ? a - b : b - a;
            skew = FullMath.mulDiv(diff, 13 * 10000, (a + b) * 8000);
            if (skew > 13) skew = 13;
        }
        return uint24(2 + skew + (calendar.isOpen(block.timestamp) ? 0 : 10));
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata p, bytes calldata)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        address issuer = _issuer(key);
        Currency ci = p.zeroForOne ? key.currency0 : key.currency1;
        Currency co = p.zeroForOne ? key.currency1 : key.currency0;
        uint256 r = IIssuerAdapter(registry.adapterOf(issuer)).sharesPerToken();
        uint256 unit = 10 ** IERC20Metadata(issuer).decimals();
        bool intoVault = Currency.unwrap(co) == address(vault);
        uint256 num = intoVault ? r : unit;
        uint256 den = intoVault ? unit : r;
        uint24 bps = feeBpsNow(issuer);
        uint256 input;
        uint256 output;
        uint256 gross;
        if (p.amountSpecified < 0) {
            input = uint256(-p.amountSpecified);
            gross = FullMath.mulDiv(input, num, den);
            output = FullMath.mulDiv(gross, 10000 - bps, 10000);
        } else {
            output = uint256(p.amountSpecified);
            gross = FullMath.mulDivRoundingUp(output, 10000, 10000 - bps);
            input = FullMath.mulDivRoundingUp(gross, den, num);
        }
        uint24 overrideFee = bps * 100 | LPFeeLibrary.OVERRIDE_FEE_FLAG;
        if (inventory(co) >= gross) {
            require(output > 0, "dust");
            poolManager.mint(address(this), ci.toId(), input);
            poolManager.burn(address(this), co.toId(), output);
            feeAccrued[co] += gross - output;
            uint256 shares = intoVault ? gross : input;
            assembly ("memory-safe") {
                tstore(0, 1)
                tstore(1, bps)
                tstore(2, shares)
            }
            return (
                this.beforeSwap.selector,
                p.amountSpecified < 0
                    ? toBeforeSwapDelta(input.toInt128(), -output.toInt128())
                    : toBeforeSwapDelta(-output.toInt128(), input.toInt128()),
                overrideFee
            );
        }
        (uint160 sqrt,,,) = poolManager.getSlot0(key.toId());
        uint256 actual = FullMath.mulDiv(uint256(sqrt), uint256(sqrt), 1 << 96);
        uint256 expected =
            Currency.unwrap(key.currency0) == address(vault)
            ? FullMath.mulDiv(unit, 1 << 96, r)
            : FullMath.mulDiv(r, 1 << 96, unit);
        uint256 diff = actual > expected ? actual - expected : expected - actual;
        uint256 deviation = FullMath.mulDiv(diff, 10000, expected);
        if (deviation > PEG_GUARD_BPS) revert OffParity(deviation);
        assembly ("memory-safe") {
            tstore(0, 0)
            tstore(1, bps)
            tstore(2, 0)
        }
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, overrideFee);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata p, BalanceDelta delta, bytes calldata)
        external
        onlyManager
        returns (bytes4, int128)
    {
        uint256 filled;
        uint256 fee;
        uint256 shares;
        assembly ("memory-safe") {
            filled := tload(0)
            fee := tload(1)
            shares := tload(2)
            tstore(0, 0)
            tstore(1, 0)
            tstore(2, 0)
        }
        if (filled == 0) {
            int128 d = Currency.unwrap(key.currency0) == address(vault) ? delta.amount0() : delta.amount1();
            shares = uint128(d < 0 ? -d : d);
        }
        emit Converted(
            Currency.unwrap(p.zeroForOne ? key.currency0 : key.currency1),
            Currency.unwrap(p.zeroForOne ? key.currency1 : key.currency0),
            shares,
            uint24(fee),
            filled == 1
        );
        return (this.afterSwap.selector, 0);
    }
}
