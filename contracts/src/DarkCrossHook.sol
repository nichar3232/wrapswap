// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IDarkCalendar {
    function isOpen(uint256 ts) external view returns (bool);
}

interface IDarkOracle {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IDarkEAS {
    struct Attestation {
        bytes32 uid;
        bytes32 schema;
        uint64 time;
        uint64 expirationTime;
        uint64 revocationTime;
        bytes32 refUID;
        address recipient;
        address attester;
        bool revocable;
        bytes data;
    }
    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}

/// @notice Bounded commit/reveal batch crossing backed by segregated ERC20 escrow.
/// @dev Prices USD/share 1e18, shares 1e18, USDC 1e6. Permission bits 0x08c0.
contract DarkCrossHook {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    uint256 public constant BATCH_BLOCKS = 20;
    uint256 public constant FEE_BPS = 5;
    uint256 public constant FORFEIT_BPS = 10;
    uint256 public constant ORACLE_STALE_SECS = 86460;
    uint256 public constant MAX_RESIDUAL_SLIPPAGE_BPS = 100;
    address public constant TRUSTED_ATTESTER = 0x357458739F90461b99789350868CD7CF330Dd7EE;
    IPoolManager public immutable poolManager;
    address public immutable vault;
    address public immutable usdc;
    IDarkOracle public immutable oracle;
    IDarkCalendar public immutable calendar;
    IDarkEAS public immutable eas;
    bytes32 public immutable schema;
    address public immutable treasury;
    address public immutable owner;
    bool public immutable demoMode;
    uint256 public immutable batchOrigin;
    PoolKey public poolKey;
    bool public configured;
    bool private entered;
    bytes32 private constant INTERNAL_SLOT = keccak256("wrapswap.dark.internal");

    function _internalSwap() internal view returns (bool v) {
        bytes32 slot = INTERNAL_SLOT;
        assembly ("memory-safe") { v := tload(slot) }
    }

    function _setInternal(bool v) internal {
        bytes32 slot = INTERNAL_SLOT;
        assembly ("memory-safe") { tstore(slot, v) }
    }

    struct Balance {
        uint256 available;
        uint256 locked;
    }

    struct Order {
        bytes32 hash;
        Currency currency;
        uint256 locked;
        bool revealed;
        bool isBuy;
        uint256 qty;
        uint256 limitPx;
        bool routeResidual;
        uint256 crossed;
    }

    struct Observation {
        uint64 timestamp;
        int256 cumulative;
        int24 tick;
    }
    mapping(address => mapping(Currency => Balance)) public balances;
    mapping(uint256 => mapping(address => Order)) public orders;
    mapping(uint256 => address[]) private traders;
    mapping(uint256 => bool) public settled;
    Observation[64] public observations;
    uint8 public observationIndex;
    uint8 public observationCount;
    event Committed(uint256 indexed batchId, address indexed trader, bytes32 hash);
    event Revealed(
        uint256 indexed batchId, address indexed trader, bool isBuy, uint256 qty, uint256 limitPx, bool routeResidual
    );
    event MidSelected(uint256 indexed batchId, uint8 source, uint256 price);
    event Crossed(uint256 indexed batchId, address indexed trader, bool isBuy, uint256 qty, uint256 mid);
    event RoutedToLit(uint256 indexed batchId, address indexed trader, bool isBuy, uint256 qty, uint256 avgPx);
    event Forfeited(uint256 indexed batchId, address indexed trader, uint256 amount);
    event BatchSettled(uint256 indexed batchId, uint256 crossedQty, uint256 routedQty, uint256 mid);
    event ResidualSkipped(uint256 indexed batchId, address indexed trader, bytes reason);
    error SettleInProgress();
    error WrongPhase();
    error Unauthorized();
    error InvalidOrder();
    error InsufficientHistory();
    error AlreadySettled();
    modifier nonReentrant() {
        require(!entered, "REENTRANT");
        entered = true;
        _;
        entered = false;
    }
    modifier onlyManager() {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        _;
    }

    constructor(
        IPoolManager m,
        address v,
        address u,
        address o,
        address c,
        address e,
        bytes32 s,
        address t,
        address own,
        bool demo
    ) {
        require(v != u && t != address(0) && own != address(0));
        poolManager = m;
        vault = v;
        usdc = u;
        oracle = IDarkOracle(o);
        calendar = IDarkCalendar(c);
        eas = IDarkEAS(e);
        schema = s;
        treasury = t;
        owner = own;
        demoMode = demo;
        batchOrigin = block.number;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.afterSwap = true;
    }

    function configurePool(PoolKey calldata key) external {
        if (msg.sender != owner || configured) revert Unauthorized();
        require(address(key.hooks) == address(this) && key.fee == 500, "POOL");
        require(
            (Currency.unwrap(key.currency0) == vault && Currency.unwrap(key.currency1) == usdc)
                || (Currency.unwrap(key.currency1) == vault && Currency.unwrap(key.currency0) == usdc),
            "PAIR"
        );
        (uint160 sqrt, int24 tick,,) = poolManager.getSlot0(key.toId());
        require(sqrt != 0, "UNINITIALIZED");
        poolKey = key;
        configured = true;
        observations[0] = Observation(uint64(block.timestamp), 0, tick);
        observationCount = 1;
    }

    function participants(uint256 id) external view returns (address[] memory) {
        return traders[id];
    }

    function currentBatch() public view returns (uint256 batchId, uint8 phase, uint256 phaseEndsBlock) {
        uint256 n = block.number - batchOrigin;
        batchId = n / 20;
        uint256 pos = n % 20;
        phase = pos < 12 ? 0 : pos < 18 ? 1 : 2;
        phaseEndsBlock = batchOrigin + batchId * 20 + (phase == 0 ? 12 : phase == 1 ? 18 : 20);
    }

    function _currency(Currency c) internal view {
        require(Currency.unwrap(c) == vault || Currency.unwrap(c) == usdc, "CURRENCY");
    }

    function fund(Currency c, uint256 amount) external nonReentrant {
        _currency(c);
        uint256 beforeBal = IERC20(Currency.unwrap(c)).balanceOf(address(this));
        IERC20(Currency.unwrap(c)).safeTransferFrom(msg.sender, address(this), amount);
        require(IERC20(Currency.unwrap(c)).balanceOf(address(this)) - beforeBal == amount, "TRANSFER_FEE");
        balances[msg.sender][c].available += amount;
    }

    function withdraw(Currency c, uint256 amount) external nonReentrant {
        _currency(c);
        balances[msg.sender][c].available -= amount;
        IERC20(Currency.unwrap(c)).safeTransfer(msg.sender, amount);
    }

    function _gate(address recipient, bytes32 uid) internal view {
        if (demoMode) return;
        IDarkEAS.Attestation memory a = eas.getAttestation(uid);
        if (
            uid == 0 || a.uid != uid || a.schema != schema || a.recipient != recipient || a.attester != TRUSTED_ATTESTER
                || a.revocationTime != 0 || (a.expirationTime != 0 && a.expirationTime <= block.timestamp)
        ) revert Unauthorized();
    }

    function commit(bytes32 h, Currency c, uint256 amount, bytes32 uid) external nonReentrant {
        (uint256 id, uint8 phase,) = currentBatch();
        if (phase != 0) revert WrongPhase();
        _currency(c);
        _gate(msg.sender, uid);
        if (h == 0 || amount == 0 || orders[id][msg.sender].hash != 0 || traders[id].length == 64) {
            revert InvalidOrder();
        }
        Balance storage b = balances[msg.sender][c];
        b.available -= amount;
        b.locked += amount;
        orders[id][msg.sender] = Order(h, c, amount, false, false, 0, 0, false, 0);
        traders[id].push(msg.sender);
        emit Committed(id, msg.sender, h);
    }

    function requiredBuyLock(uint256 qty, uint256 price) public pure returns (uint256) {
        uint256 cost = FullMath.mulDivRoundingUp(qty, price, 1e30);
        return cost + FullMath.mulDivRoundingUp(cost, FEE_BPS, 10000);
    }

    function reveal(bool buy, uint256 qty, uint256 price, bool route, bytes32 salt) external nonReentrant {
        (uint256 id, uint8 phase,) = currentBatch();
        if (phase != 1) revert WrongPhase();
        Order storage o = orders[id][msg.sender];
        if (o.hash == 0 || o.revealed || o.hash != keccak256(abi.encode(buy, qty, price, route, salt, id, msg.sender)))
        {
            revert InvalidOrder();
        }
        o.revealed = true;
        // A valid preimage with insufficient/wrong-currency collateral drops the order, without forfeiture.
        if (
            qty == 0 || price == 0 || qty > uint256(uint128(type(int128).max))
                || Currency.unwrap(o.currency) != (buy ? usdc : vault)
                || o.locked < (buy ? requiredBuyLock(qty, price) : qty)
        ) return;
        o.isBuy = buy;
        o.qty = qty;
        o.limitPx = price;
        o.routeResidual = route;
        emit Revealed(id, msg.sender, buy, qty, price, route);
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata data)
        external
        view
        onlyManager
        returns (bytes4)
    {
        _gate(sender, demoMode ? bytes32(0) : abi.decode(data, (bytes32)));
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        view
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(configured && PoolId.unwrap(key.toId()) == PoolId.unwrap(poolKey.toId()), "POOL");
        (, uint8 phase,) = currentBatch();
        if (phase == 2 && (!_internalSwap() || sender != address(this))) revert SettleInProgress();
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyManager
        returns (bytes4, int128)
    {
        require(PoolId.unwrap(key.toId()) == PoolId.unwrap(poolKey.toId()), "POOL");
        _observe();
        return (IHooks.afterSwap.selector, 0);
    }

    function _observe() internal {
        (, int24 tick,,) = poolManager.getSlot0(poolKey.toId());
        Observation memory last = observations[observationIndex];
        int256 cumulative = last.cumulative + int256(last.tick) * int256(block.timestamp - last.timestamp);
        if (last.timestamp == block.timestamp) {
            observations[observationIndex].tick = tick;
            return;
        }
        observationIndex = (observationIndex + 1) % 64;
        observations[observationIndex] = Observation(uint64(block.timestamp), cumulative, tick);
        if (observationCount < 64) observationCount++;
    }

    function twapPrice() public view returns (uint256) {
        if (observationCount == 0 || block.timestamp < 1800) revert InsufficientHistory();
        uint256 target = block.timestamp - 1800;
        Observation memory prev;
        bool found;
        for (uint256 i; i < observationCount; i++) {
            Observation memory o = observations[i];
            if (o.timestamp <= target && (!found || o.timestamp > prev.timestamp)) {
                prev = o;
                found = true;
            }
        }
        if (!found) revert InsufficientHistory();
        // Every tick change has an observation, so this piecewise-constant integration is exact.
        int256 start = prev.cumulative + int256(prev.tick) * int256(target - prev.timestamp);
        Observation memory last = observations[observationIndex];
        int256 end = last.cumulative + int256(last.tick) * int256(block.timestamp - last.timestamp);
        int256 diff = end - start;
        int24 mean = int24(diff / 1800);
        if (diff < 0 && diff % 1800 != 0) mean--;
        uint160 sqrt = TickMath.getSqrtPriceAtTick(mean);
        if (Currency.unwrap(poolKey.currency0) == vault) {
            return FullMath.mulDiv(FullMath.mulDiv(sqrt, sqrt, 1 << 64), 1e30, 1 << 128);
        }
        // First compute inverse ratio in 1e18 units to avoid square overflow.
        uint256 ratio = FullMath.mulDiv(sqrt, sqrt, 1 << 64);
        return FullMath.mulDiv(1 << 128, 1e30, ratio);
    }

    function _mid() internal view returns (uint8 source, uint256 price) {
        if (calendar.isOpen(block.timestamp)) {
            try oracle.latestRoundData() returns (
                uint80 round, int256 answer, uint256, uint256 updated, uint80 answered
            ) {
                if (
                    answer > 0 && updated <= block.timestamp && updated + ORACLE_STALE_SECS >= block.timestamp
                        && answered >= round
                ) {
                    uint8 dec = oracle.decimals();
                    require(dec <= 18);
                    return (0, uint256(answer) * 10 ** (18 - dec));
                }
            } catch {}
        }
        return (1, twapPrice());
    }

    function settle(uint256 id) external nonReentrant {
        (uint256 nowId, uint8 phase,) = currentBatch();
        if (id > nowId || (id == nowId && phase != 2)) revert WrongPhase();
        if (settled[id]) revert AlreadySettled();
        require(configured, "POOL");
        settled[id] = true;
        (uint8 source, uint256 mid) = _mid();
        require(mid > 0, "ZERO_MID");
        emit MidSelected(id, source, mid);
        address[] storage users = traders[id];
        uint256 buys;
        uint256 sells;
        for (uint256 i; i < users.length; i++) {
            Order storage o = orders[id][users[i]];
            if (o.revealed && o.qty > 0 && (o.isBuy ? o.limitPx >= mid : o.limitPx <= mid)) {
                if (o.isBuy) buys += o.qty;
                else sells += o.qty;
            }
        }
        uint256 cross = Math.min(buys, sells);
        uint256 cumBuy;
        uint256 cumSell;
        uint256 allocatedBuy;
        uint256 allocatedSell;
        uint256 paid;
        uint256 credited;
        for (uint256 i; i < users.length; i++) {
            address user = users[i];
            Order storage o = orders[id][user];
            if (!o.revealed || o.qty == 0 || (o.isBuy ? o.limitPx < mid : o.limitPx > mid)) continue;
            uint256 q;
            if (o.isBuy) {
                cumBuy += o.qty;
                uint256 a = FullMath.mulDiv(cumBuy, cross, buys);
                q = a - allocatedBuy;
                allocatedBuy = a;
            } else {
                cumSell += o.qty;
                uint256 a = FullMath.mulDiv(cumSell, cross, sells);
                q = a - allocatedSell;
                allocatedSell = a;
            }
            o.crossed = q;
            if (q == 0) continue;
            if (o.isBuy) {
                uint256 cost = FullMath.mulDivRoundingUp(q, mid, 1e30);
                uint256 fee = FullMath.mulDivRoundingUp(cost, FEE_BPS, 10000);
                _spend(id, user, cost + fee);
                balances[user][Currency.wrap(vault)].available += q;
                paid += cost + fee;
            } else {
                uint256 cost = FullMath.mulDiv(q, mid, 1e30);
                uint256 fee = cost * FEE_BPS / 10000;
                _spend(id, user, q);
                balances[user][Currency.wrap(usdc)].available += cost - fee;
                credited += cost - fee;
            }
            emit Crossed(id, user, o.isBuy, q, mid);
        }
        balances[treasury][Currency.wrap(usdc)].available += paid - credited;
        uint256 routed = abi.decode(poolManager.unlock(abi.encode(id, mid)), (uint256));
        _forfeits(id);
        for (uint256 i; i < users.length; i++) {
            Order storage o = orders[id][users[i]];
            Balance storage b = balances[users[i]][o.currency];
            b.locked -= o.locked;
            b.available += o.locked;
            o.locked = 0;
        }
        emit BatchSettled(id, cross, routed, mid);
    }

    function _spend(uint256 id, address user, uint256 amount) internal {
        Order storage o = orders[id][user];
        o.locked -= amount;
        balances[user][o.currency].locked -= amount;
    }

    function _forfeits(uint256 id) internal {
        address[] storage users = traders[id];
        uint256 revealed;
        for (uint256 i; i < users.length; i++) {
            if (orders[id][users[i]].revealed && orders[id][users[i]].qty > 0) revealed += orders[id][users[i]].qty;
        }
        for (uint256 i; i < users.length; i++) {
            Order storage o = orders[id][users[i]];
            if (o.revealed) continue;
            uint256 penalty = o.locked * FORFEIT_BPS / 10000;
            _spend(id, users[i], penalty);
            emit Forfeited(id, users[i], penalty);
            // Weight revealed participants by share quantity, with currencies kept separate.
            uint256 distributed;
            for (uint256 j; j < users.length; j++) {
                if (orders[id][users[j]].revealed && orders[id][users[j]].qty > 0) {
                    uint256 reward = FullMath.mulDiv(penalty, orders[id][users[j]].qty, revealed);
                    balances[users[j]][o.currency].available += reward;
                    distributed += reward;
                }
            }
            balances[treasury][o.currency].available += penalty - distributed;
        }
    }

    function unlockCallback(bytes calldata data) external onlyManager returns (bytes memory) {
        require(entered, "NOT_SETTLING");
        (uint256 id, uint256 mid) = abi.decode(data, (uint256, uint256));
        uint256 routed;
        _setInternal(true);
        address[] storage users = traders[id];
        for (uint256 i; i < users.length; i++) {
            Order storage o = orders[id][users[i]];
            if (!o.revealed || !o.routeResidual || o.qty <= o.crossed || (o.isBuy ? o.limitPx < mid : o.limitPx > mid)) continue;
            // An individual unfillable limit cannot block everyone else's settlement.
            try this.executeResidual(id, users[i], mid) returns (uint256 q) {
                routed += q;
            } catch (bytes memory reason) {
                emit ResidualSkipped(id, users[i], reason);
            }
        }
        _setInternal(false);
        return abi.encode(routed);
    }

    function priceToSqrt(uint256 price) public view returns (uint160) {
        require(price > 0);
        uint256 ratioX128 = Currency.unwrap(poolKey.currency0) == vault
            ? FullMath.mulDiv(price, 1 << 128, 1e30)
            : FullMath.mulDiv(1e30, 1 << 128, price);
        uint256 result = Math.sqrt(ratioX128) << 32;
        require(result > TickMath.MIN_SQRT_PRICE && result < TickMath.MAX_SQRT_PRICE, "PRICE");
        return uint160(result);
    }

    function executeResidual(uint256 id, address user, uint256 mid) external returns (uint256 q) {
        if (msg.sender != address(this) || !_internalSwap()) revert Unauthorized();
        Order storage o = orders[id][user];
        uint256 bound = o.isBuy
            ? Math.min(o.limitPx, mid * (10000 + MAX_RESIDUAL_SLIPPAGE_BPS) / 10000)
            : Math.max(o.limitPx, mid * (10000 - MAX_RESIDUAL_SLIPPAGE_BPS) / 10000);
        bool zeroForOne =
            o.isBuy ? Currency.unwrap(poolKey.currency0) == usdc : Currency.unwrap(poolKey.currency0) == vault;
        BalanceDelta d = poolManager.swap(
            poolKey,
            SwapParams(
                zeroForOne, o.isBuy ? int256(o.qty - o.crossed) : -int256(o.qty - o.crossed), priceToSqrt(bound)
            ),
            ""
        );
        int128 stock = Currency.unwrap(poolKey.currency0) == vault ? d.amount0() : d.amount1();
        int128 cash = Currency.unwrap(poolKey.currency0) == usdc ? d.amount0() : d.amount1();
        uint256 gross;
        uint256 fee;
        if (o.isBuy) {
            require(stock > 0 && cash < 0, "NO_FILL");
            q = uint128(stock);
            gross = uint128(-cash);
            fee = FullMath.mulDivRoundingUp(gross, FEE_BPS, 10000);
            require(gross + fee <= o.locked, "LOCK");
            require(gross <= FullMath.mulDivRoundingUp(q, o.limitPx, 1e30), "LIMIT");
            _spend(id, user, gross + fee);
            balances[user][Currency.wrap(vault)].available += q;
        } else {
            require(stock < 0 && cash > 0, "NO_FILL");
            q = uint128(-stock);
            gross = uint128(cash);
            fee = gross * FEE_BPS / 10000;
            require(gross >= FullMath.mulDiv(q, o.limitPx, 1e30), "LIMIT");
            _spend(id, user, q);
            balances[user][Currency.wrap(usdc)].available += gross - fee;
        }
        balances[treasury][Currency.wrap(usdc)].available += fee;
        _resolve(poolKey.currency0, d.amount0());
        _resolve(poolKey.currency1, d.amount1());
        _observe();
        emit RoutedToLit(id, user, o.isBuy, q, FullMath.mulDiv(gross, 1e30, q));
    }

    function _resolve(Currency c, int128 delta) internal {
        if (delta < 0) {
            poolManager.sync(c);
            IERC20(Currency.unwrap(c)).safeTransfer(address(poolManager), uint128(-delta));
            poolManager.settle();
        } else if (delta > 0) {
            poolManager.take(c, address(this), uint128(delta));
        }
    }
}
