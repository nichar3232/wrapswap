# WrapSwap interfaces (frozen for the reframe)

Status: FROZEN at tag `interfaces-frozen`. Owner: interfaces lane. Parallel lanes never edit this file, `contracts/src/interfaces/`
or `packages/types/`; they file requests in `interface-change-requests/<lane>.md` (§8).

Global conventions:

- Solidity 0.8.26, EVM cancun, via-IR. Pins: v4-core `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`, v4-periphery
  `9969eec44cfdf07e24b41de47f40276a58401976`, forge-std `ba4733c33497dd0c0983dcc033d7645576cc46e5`.
- Users only ever hold real issuer securities (mocks on anvil/Sepolia). Canonical shares are internal accounting units
  (1e18 fixed point), never a token. Pitch: "share-for-share conversion, no USDC leg."
- Token amounts are RAW units of that token. Shares, ratios and prices are 1e18 fixed point (`X18`). Fees are pips
  (1 pip = 1e-6 = 0.01 bp; 100 pips = 1 bp), which is also the v4 LP-fee unit.
- JSON: every integer that can exceed 2^53 is a decimal string; small counters (`int` in schemas) are JSON numbers.
  Addresses are EIP-55 checksummed in responses and accepted case-insensitively in requests.
- Time: all market-hours logic uses the chain's latest block timestamp, never the host clock (anvil is warped).
- Network selection: every consumer reads `NETWORK` (`anvil` | `unichain-sepolia`) and loads `deployments/${NETWORK}.json`.
  When `NETWORK` is unset, `parseNetwork` resolves `DEFAULT_NETWORK` (`unichain-sepolia`, chainId 1301).
- Ports come from env: `ANVIL_PORT`, `PG_PORT`, `API_PORT`, `WEB_PORT`, `CRANK_HEALTH_PORT`. No defaults are bound
  in lane code except as documented fallbacks for a solo developer.

## 1. Solidity interfaces

Files under `contracts/src/interfaces/` are the source of truth and are reproduced verbatim below. They compile with
`forge build`. Implementations (owned by the contracts lane) must inherit them.

### 1.1 IWrapperAdapter — `contracts/src/interfaces/IWrapperAdapter.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IWrapperAdapter
/// @notice Reads one issuer token's issuer-token -> canonical-share ratio and its health.
/// @dev sharesPerToken is the number of canonical shares (1e18 fixed point) represented by ONE WHOLE token
///      (10**tokenDecimals raw units). A healthy adapter is not paused and not stale.
interface IWrapperAdapter {
    struct Health {
        bool paused;
        bool stale;
        uint64 updatedAt;
    }

    event RatioUpdated(address indexed token, uint256 oldSharesPerToken, uint256 newSharesPerToken);
    event AdapterPaused(address indexed token, bool paused);

    error InvalidRatio(uint256 sharesPerToken);

    function token() external view returns (address);
    function underlying() external view returns (bytes32);
    function name() external view returns (string memory);
    function tokenDecimals() external view returns (uint8);
    function sharesPerToken() external view returns (uint256);
    function health() external view returns (Health memory);
    function ratio() external view returns (uint256 sharesPerToken, bool healthy);
}
```

Adapter kinds: `B20Multiplier` reads `multiplier()` from a Coinbase-B20-shaped token (mock on anvil/Sepolia);
`XStocksMultiplier` reads `multiplier()` from an xStocks-shaped token; `Static` is owner-set. `underlying` is the
right-padded ASCII ticker, e.g. `bytes32("AAPL")`. `stale` is true when the source cannot prove freshness
(static adapters: never stale; multiplier adapters: token paused ⇒ `paused`).

### 1.2 IIssuerRegistry — `contracts/src/interfaces/IIssuerRegistry.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IIssuerRegistry
/// @notice Owner-curated set of issuer tokens, each bound to one IWrapperAdapter and one underlying security.
interface IIssuerRegistry {
    event IssuerAdded(address indexed token, address indexed adapter, bytes32 indexed underlying);
    event IssuerRemoved(address indexed token, address indexed adapter, bytes32 indexed underlying);
    event IssuerPaused(address indexed token, bool paused);

    error AlreadyRegistered(address token);
    error UnknownIssuer(address token);
    error InvalidAdapter(address adapter);

    function add(address adapter) external;
    function remove(address token) external;
    function setPaused(address token, bool paused) external;

    function adapters() external view returns (address[] memory);
    function adapterOf(address token) external view returns (address);
    function underlyingOf(address token) external view returns (bytes32);
    function isIssuer(address token) external view returns (bool);
    function paused(address token) external view returns (bool);
    /// @notice Registered, not paused in the registry, and the adapter reports healthy.
    function active(address token) external view returns (bool);
}
```

### 1.3 INyseCalendar — `contracts/src/interfaces/INyseCalendar.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title INyseCalendar
/// @notice NYSE regular-session clock evaluated at a unix timestamp (always block.timestamp on-chain).
/// @dev day = floor((ts - utcOffset) / 86400) where utcOffset is 4h (EDT) or 5h (EST). Sessions 09:30-16:00 local,
///      or 09:30-earlyClose. Weekends and holidays are closed.
interface INyseCalendar {
    event HolidaySet(uint256 indexed day, bool closed);
    event EarlyCloseSet(uint256 indexed day, uint256 secondsAfterMidnight);

    error InvalidEarlyClose(uint256 secondsAfterMidnight);
    error NoTransitionWithinYear(uint256 ts);

    function isOpen(uint256 ts) external view returns (bool);
    /// @notice First timestamp strictly after ts at which isOpen flips.
    function nextTransition(uint256 ts) external view returns (uint256);
    function holidays(uint256 day) external view returns (bool);
    function earlyClose(uint256 day) external view returns (uint256);

    function setHoliday(uint256 day, bool closed) external;
    function setEarlyClose(uint256 day, uint256 secondsAfterMidnight) external;
}
```

### 1.4 IEligibility / IEASEligibility — `contracts/src/interfaces/IEligibility.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IEligibility
/// @notice Swapper eligibility gate shared by ParityHook and DarkCrossHook.
/// @dev Reason codes: 0 OK, 1 NO_ATTESTATION, 2 WRONG_SCHEMA, 3 WRONG_ATTESTER, 4 WRONG_RECIPIENT, 5 REVOKED,
///      6 EXPIRED, 7 RESTRICTED_COUNTRY. demoMode=true makes check() return (true, 0) for every account.
interface IEligibility {
    event DemoModeSet(bool enabled, address indexed setBy);
    event TrustedRouterSet(address indexed router, bool trusted);
    event EligibilityDenied(address indexed account, address indexed caller, uint8 indexed reason, bytes32 attestationUid);

    error NotEligible(address account, uint8 reason);
    error NotOwner(address caller);

    function owner() external view returns (address);
    function demoMode() external view returns (bool);
    function setDemoMode(bool enabled) external;

    /// @notice Pure read. attestationUid == 0 resolves the account's attestation through the configured indexer.
    function check(address account, bytes32 attestationUid) external view returns (bool eligible, uint8 reason);
    /// @notice Same decision as check(); on denial emits EligibilityDenied and returns false. Never reverts on denial.
    function enforce(address account, bytes32 attestationUid) external returns (bool eligible);

    function isTrustedRouter(address router) external view returns (bool);
    function setTrustedRouter(address router, bool trusted) external;
    /// @notice claimedSwapper if sender is a trusted router and claimedSwapper != 0, otherwise sender.
    function resolveSwapper(address sender, address claimedSwapper) external view returns (address);
}

/// @title IEASEligibility
/// @notice IEligibility backed by the Coinbase "Verified Country" EAS attestation; restrictedCountry is "US".
interface IEASEligibility is IEligibility {
    function eas() external view returns (address);
    function attestationIndexer() external view returns (address);
    function schemaUid() external view returns (bytes32);
    function trustedAttester() external view returns (address);
    function restrictedCountry() external view returns (string memory);
}
```

EAS decision procedure (in order; first failure is the reason): `demoMode` ⇒ OK. uid = argument, or
`attestationIndexer.getAttestationUid(account, schemaUid)` when zero; uid zero or unknown ⇒ 1. `schema != schemaUid` ⇒ 2.
`attester != trustedAttester` (Coinbase `0x357458739F90461b99789350868CD7CF330Dd7EE` on Base) ⇒ 3.
`recipient != account` ⇒ 4. `revocationTime != 0` ⇒ 5. `expirationTime != 0 && expirationTime <= block.timestamp` ⇒ 6.
`abi.decode(data, (string))` equals `restrictedCountry` (case-sensitive `"US"`) ⇒ 7. Otherwise OK.
Only hooks call `enforce`; the indexer consumes `EligibilityDenied` only when `caller` is a deployment hook address.

### 1.5 IPriceOracle / IMockPriceOracle — `contracts/src/interfaces/IPriceOracle.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IPriceOracle
/// @notice Midpoint of an issuer-token pair: whole quote tokens per ONE whole base token, 1e18 fixed point.
interface IPriceOracle {
    event MidUpdated(address indexed base, address indexed quote, uint256 midX18, uint64 updatedAt);

    error NoPrice(address base, address quote);

    /// @dev If only (quote, base) is stored, returns floor(1e36 / stored) with the stored updatedAt.
    function getMid(address base, address quote) external view returns (uint256 midX18, uint64 updatedAt);
}

/// @title IMockPriceOracle
/// @notice Settable oracle used on anvil and Unichain Sepolia; only authorized pushers may set.
interface IMockPriceOracle is IPriceOracle {
    event PusherSet(address indexed pusher, bool allowed);

    error NotPusher(address caller);
    error ZeroMid();

    function setMid(address base, address quote, uint256 midX18) external;
    function setPusher(address pusher, bool allowed) external;
    function isPusher(address pusher) external view returns (bool);
}
```

`setMid` stores `updatedAt = uint64(block.timestamp)` and emits `MidUpdated`.

### 1.6 IMockIssuerToken — `contracts/src/interfaces/IMockIssuerToken.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @title IMockIssuerToken
/// @notice Testnet/local stand-in for a real issuer security token (Coinbase B20 AAPL, Backed xStocks AAPLx).
/// @dev Issuer-faithful decimals. multiplier() is canonical shares per whole token, 1e18 fixed point.
interface IMockIssuerToken is IERC20Metadata {
    event MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier);
    event TransfersPaused(bool paused);

    error InvalidMultiplier(uint256 multiplier);
    error TokenPaused();

    function multiplier() external view returns (uint256);
    function transfersPaused() external view returns (bool);
    function mint(address to, uint256 amount) external;
    function setMultiplier(uint256 newMultiplier) external;
    function setTransfersPaused(bool paused) external;
}
```

Mock tokens on anvil and Unichain Sepolia: `mcbAAPL` (6 decimals, mock Coinbase tokenized AAPL) and `mAAPLx`
(18 decimals, mock Backed xStocks AAPLx). `mint` is owner-only. `setTransfersPaused(true)` makes every transfer revert
`TokenPaused()` and makes its adapter report `paused`.

### 1.7 IParityHook — `contracts/src/interfaces/IParityHook.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IIssuerRegistry} from "./IIssuerRegistry.sol";
import {INyseCalendar} from "./INyseCalendar.sol";
import {IEligibility} from "./IEligibility.sol";

/// @title IParityHook
/// @notice Settlement engine for pools of two real issuer tokens of the same underlying security.
/// @dev Pool: currency0/currency1 = the two issuer tokens (sorted), fee = DYNAMIC_FEE_FLAG, hooks = this.
///      Hook permissions: beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta (flags 0x20C8).
///      Inventory = ERC-6909 claims owned by this hook in the PoolManager, excluding feesAccrued.
///      beforeSwap fills all-or-nothing from inventory via BeforeSwapDelta; otherwise returns ZERO_DELTA and the
///      swap falls through to concentrated liquidity on the same pool, after which afterSwap enforces the peg guard.
///      Fees are pips (1e-6): total = min(BASE + ceil(SKEW * |skew|) + (open ? 0 : offHours), MAX), skew pre-trade.
///      offHours = ceil(OFF_HOURS_MAX * |post-trade skew|) if the trade increases |skew|, else 0 (rebalancing lag:
///      issuers cannot mint/redeem until the open). Post-trade skew moves the trade's canonical shares one-for-one
///      (exact input: input shares; exact output: net output shares). FeeBreakdown.closedPips carries offHours;
///      feeBreakdown(key) reports it for a marginal skew-increasing trade, quote() for the actual trade.
///      amountSpecified < 0 = exact input, > 0 = exact output (pinned v4-core convention).
interface IParityHook {
    struct FeeBreakdown {
        uint24 basePips;
        uint24 skewPips;
        uint24 closedPips;
        uint24 totalPips;
        /// @dev (inv0Shares - inv1Shares) * 1e18 / (inv0Shares + inv1Shares), truncated toward zero; 0 if empty.
        int256 skewX18;
        bool marketOpen;
    }

    struct Quote {
        /// @dev true: inventory fill (PARITY). false: swap would fall through to the pool's liquidity.
        bool fillable;
        uint256 amountIn;
        uint256 amountOut;
        uint256 grossOut;
        uint256 shares;
        uint256 feeAmount;
        FeeBreakdown fee;
    }

    struct PegStatus {
        /// @dev Whole-token price of currency0 in currency1, 1e18 fixed point.
        uint256 poolPriceX18;
        uint256 parityPriceX18;
        uint256 deviationBps;
        bool tripped;
    }

    /// @dev InventoryChanged.reason
    /// 0 DEPOSIT, 1 WITHDRAW, 2 FILL_IN, 3 FILL_OUT
    /// @dev FallThrough.reason
    /// 1 INSUFFICIENT_INVENTORY, 2 DUST

    event PoolRegistered(
        PoolId indexed poolId, address indexed currency0, address indexed currency1, bytes32 underlying, int24 tickSpacing
    );
    event FeeQuoted(
        PoolId indexed poolId,
        uint24 totalPips,
        uint24 basePips,
        uint24 skewPips,
        uint24 closedPips,
        int256 skewX18,
        bool marketOpen
    );
    event InventoryFill(
        PoolId indexed poolId,
        address indexed swapper,
        address indexed sender,
        bool zeroForOne,
        bool exactInput,
        uint256 amountIn,
        uint256 amountOut,
        uint256 shares,
        uint256 feeAmount,
        uint24 feePips
    );
    event FallThrough(
        PoolId indexed poolId,
        address indexed swapper,
        address indexed sender,
        bool zeroForOne,
        uint8 reason,
        int128 amount0,
        int128 amount1,
        uint24 feePips,
        uint256 deviationBpsAfter
    );
    event InventoryChanged(
        address indexed currency, address indexed actor, uint8 indexed reason, int256 delta, uint256 inventoryAfter
    );
    event FeesSwept(address indexed currency, address indexed to, uint256 amount);
    event PegGuardStatus(
        PoolId indexed poolId, bool tripped, uint256 poolPriceX18, uint256 parityPriceX18, uint256 deviationBps
    );
    event KeeperSet(address indexed keeper, bool allowed);

    error NotPoolManager();
    error NotKeeper(address caller);
    error DynamicFeeRequired(uint24 fee);
    error UnsupportedPool(address currency0, address currency1);
    error AdapterUnhealthy(address token);
    error PegGuardTripped(PoolId poolId, uint256 deviationBps);
    error InsufficientInventory(address currency, uint256 available, uint256 requested);
    error InvalidHookData();
    error ZeroAmount();

    function BASE_FEE_PIPS() external view returns (uint24);
    function SKEW_FEE_PIPS() external view returns (uint24);
    function OFF_HOURS_MAX_FEE_PIPS() external view returns (uint24);
    function MAX_FEE_PIPS() external view returns (uint24);
    function PEG_GUARD_BPS() external view returns (uint256);
    function HOOK_DATA_VERSION() external view returns (uint8);

    function poolManager() external view returns (IPoolManager);
    function registry() external view returns (IIssuerRegistry);
    function calendar() external view returns (INyseCalendar);
    function eligibility() external view returns (IEligibility);

    function isKeeper(address account) external view returns (bool);
    function setKeeper(address keeper, bool allowed) external;

    /// @notice Keeper-only. Pulls ERC20 from msg.sender and mints ERC-6909 claims to this hook.
    function depositInventory(Currency currency, uint256 amount) external;
    /// @notice Keeper-only. Burns claims and sends ERC20 to `to`. Cannot touch feesAccrued.
    function withdrawInventory(Currency currency, uint256 amount, address to) external;
    /// @notice Owner-only. Burns fee claims and sends ERC20 to `to`.
    function sweepFees(Currency currency, address to) external returns (uint256 amount);

    function inventory(Currency currency) external view returns (uint256);
    function inventoryShares(Currency currency) external view returns (uint256);
    function feesAccrued(Currency currency) external view returns (uint256);

    function feeBreakdown(PoolKey calldata key) external view returns (FeeBreakdown memory);
    function quote(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        external
        view
        returns (Quote memory);
    function pegStatus(PoolKey calldata key) external view returns (PegStatus memory);
    /// @notice Last status emitted by checkPeg for this pool.
    function pegTripped(PoolId poolId) external view returns (bool);
    /// @notice Permissionless. Emits PegGuardStatus only when the tripped state differs from pegTripped(poolId).
    function checkPeg(PoolKey calldata key) external returns (bool tripped);
}
```

Normative behaviour (the contracts lane implements exactly this):

| Constant | Value |
|---|---|
| `BASE_FEE_PIPS` | 200 (2 bps) |
| `SKEW_FEE_PIPS` | 1300 (13 bps at \|skew\| = 1) |
| `OFF_HOURS_MAX_FEE_PIPS` | 1500 (15 bps at \|post-trade skew\| = 1). While `calendar.isOpen(block.timestamp)` is false a trade that increases \|skew\| pays `ceil(1500 · |post-trade skew|)`; a trade that leaves \|skew\| unchanged or reduces it pays 0. Post-trade skew moves the trade's canonical shares one-for-one (exact input: input shares; exact output: net output shares). Rationale: a same-share swap carries no underlying price risk; off-hours the only risk is rebalancing lag (issuers cannot mint/redeem until the open), which grows with skew. `feeBreakdown(key)` reports the marginal skew-increasing premium `ceil(1500 · |skew|)`; `quote()` and `beforeSwap` use the trade's own premium |
| `MAX_FEE_PIPS` | 2500 (25 bps cap) |
| `PEG_GUARD_BPS` | 50 |
| `HOOK_DATA_VERSION` | 1 |

- `beforeInitialize`: `key.fee == DYNAMIC_FEE_FLAG` else `DynamicFeeRequired`; both currencies `registry.active` with
  equal `underlyingOf`, else `UnsupportedPool`; emits `PoolRegistered`.
- `beforeSwap`: resolve swapper (§3); `eligibility.check(swapper, uid)` false ⇒ revert `IEligibility.NotEligible`;
  either adapter unhealthy ⇒ `AdapterUnhealthy`; compute `FeeBreakdown` from PRE-swap inventory; emit `FeeQuoted`;
  compute the quote (below). If `inventory(out) >= grossOut && amountIn > 0 && amountOut > 0`: mint `amountIn` claims
  of the input currency to the hook, burn `amountOut` claims of the output currency, `feesAccrued[out] += feeAmount`,
  emit `InventoryFill` then `InventoryChanged(in, swapper, 2, +amountIn, …)` and
  `InventoryChanged(out, swapper, 3, -grossOut, …)`, return the full BeforeSwapDelta
  (exact-in: `(+amountIn, -amountOut)`; exact-out: `(-amountOut, +amountIn)`, specified/unspecified order per v4).
  Otherwise return `ZERO_DELTA`. Either way the LP-fee override is `totalPips | OVERRIDE_FEE_FLAG`.
- `afterSwap` (fall-through only): read post-swap `sqrtPriceX96`, compute `PegStatus`; `deviationBps > 50` ⇒ revert
  `PegGuardTripped`; else emit `FallThrough(reason = 1, or 2 when the quote rounded to zero)`.
- Quote, exact input (`amountSpecified = -A`): `shares = toSharesDown(A, sptIn, decIn)`,
  `grossOut = fromSharesDown(shares, sptOut, decOut)`, `feeAmount = ceil(grossOut * totalPips / 1e6)`,
  `amountOut = grossOut - feeAmount`, `amountIn = A`.
- Quote, exact output (`amountSpecified = +B`): `grossOut = ceil(B * 1e6 / (1e6 - totalPips))`,
  `feeAmount = grossOut - B`, `shares = toSharesUp(grossOut, sptOut, decOut)`,
  `amountIn = fromSharesUp(shares, sptIn, decIn)`, `amountOut = B`.
- Skew: `s_i = toSharesDown(inventory(currency_i), spt_i, dec_i)`; `skewPips = s0 + s1 == 0 ? 0 :
  ceil(1300 * |s0 - s1| / (s0 + s1))`; `totalPips = min(200 + skewPips + (open ? 0 : 1000), 2500)`.
- Peg: `parityPriceX18 = spt0 * 1e18 / spt1` (floor; whole token1 per whole token0);
  `poolPriceX18 = sqrtPriceX96² · 10^dec0 · 1e18 / (2^192 · 10^dec1)` (floor);
  `deviationBps = ceil(|pool − parity| · 1e4 / parity)`; `tripped = deviationBps > 50`.
- Every rounding choice above favours the hook.

### 1.8 IDarkCrossHook — `contracts/src/interfaces/IDarkCrossHook.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {IParityHook} from "./IParityHook.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {IEligibility} from "./IEligibility.sol";

/// @title IDarkCrossHook
/// @notice Commit-reveal batch crossing of one issuer pair (baseToken, quoteToken) at an IPriceOracle midpoint.
/// @dev Not attached to any pool (no hook permission flags). settle() runs inside one PoolManager.unlock: crossed
///      amounts move between escrow balances; each residual with routeResidual=true is swapped exact-input into the
///      ParityHook pool of the same pair, with ParityHook hookData v1 naming the trader as swapper.
///      Batch = BATCH_BLOCKS blocks from batchOrigin: COMMIT_BLOCKS commit, REVEAL_BLOCKS reveal, remainder settle.
///      Prices are whole quote tokens per whole base token, 1e18 fixed point.
interface IDarkCrossHook {
    enum Phase {
        COMMIT,
        REVEAL,
        SETTLE
    }

    struct Order {
        bytes32 commitHash;
        address lockToken;
        uint256 locked;
        bytes32 attestationUid;
        bool revealed;
        bool valid;
        bool sellBase;
        uint256 amountIn;
        uint256 limitPriceX18;
        bool routeResidual;
        uint256 crossedIn;
        uint256 residualIn;
    }

    struct BatchResult {
        bool settled;
        uint256 midX18;
        uint64 midUpdatedAt;
        uint256 crossedBase;
        uint256 crossedQuote;
        uint256 residualBaseIn;
        uint256 residualQuoteIn;
        uint32 participants;
    }

    /// @dev RevealRejected.reason: 1 WRONG_LOCK_TOKEN, 2 INSUFFICIENT_LOCK, 3 ZERO_AMOUNT, 4 ZERO_LIMIT

    event Funded(address indexed account, address indexed token, uint256 amount);
    event Withdrawn(address indexed account, address indexed token, uint256 amount);
    event Committed(
        uint256 indexed batchId, address indexed trader, bytes32 commitHash, address lockToken, uint256 locked
    );
    event Revealed(
        uint256 indexed batchId,
        address indexed trader,
        bool sellBase,
        uint256 amountIn,
        uint256 limitPriceX18,
        bool routeResidual
    );
    event RevealRejected(uint256 indexed batchId, address indexed trader, uint8 reason);
    event Crossed(
        uint256 indexed batchId,
        address indexed trader,
        bool sellBase,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeAmount,
        uint256 midX18
    );
    event ResidualRouted(
        uint256 indexed batchId,
        address indexed trader,
        PoolId indexed poolId,
        bool sellBase,
        uint256 amountIn,
        uint256 amountOut
    );
    event ResidualSkipped(uint256 indexed batchId, address indexed trader, bytes reason);
    event Forfeited(uint256 indexed batchId, address indexed trader, address token, uint256 amount);
    event BatchSettled(
        uint256 indexed batchId,
        uint256 midX18,
        uint64 midUpdatedAt,
        uint256 crossedBase,
        uint256 crossedQuote,
        uint256 residualBaseIn,
        uint256 residualQuoteIn,
        uint32 participants
    );

    error NotPoolManager();
    error Unauthorized(address caller);
    error UnsupportedToken(address token);
    error WrongPhase(Phase expected, Phase actual);
    error InvalidCommit();
    error AlreadyCommitted(uint256 batchId, address trader);
    error BatchFull(uint256 batchId);
    error UnknownCommit(uint256 batchId, address trader);
    error AlreadyRevealed(uint256 batchId, address trader);
    error CommitMismatch(uint256 batchId, address trader);
    error AlreadySettled(uint256 batchId);
    error BatchNotSettleable(uint256 batchId);
    error OracleStale(uint64 updatedAt, uint64 nowTs);
    error InsufficientEscrow(address token, uint256 available, uint256 requested);

    function BATCH_BLOCKS() external view returns (uint256);
    function COMMIT_BLOCKS() external view returns (uint256);
    function REVEAL_BLOCKS() external view returns (uint256);
    function MAX_PARTICIPANTS() external view returns (uint256);
    function CROSS_FEE_PIPS() external view returns (uint24);
    function FORFEIT_BPS() external view returns (uint256);
    function ORACLE_MAX_AGE() external view returns (uint64);

    function poolManager() external view returns (IPoolManager);
    function parityHook() external view returns (IParityHook);
    function oracle() external view returns (IPriceOracle);
    function eligibility() external view returns (IEligibility);
    function baseToken() external view returns (address);
    function quoteToken() external view returns (address);
    function parityPoolKey() external view returns (PoolKey memory);
    function treasury() external view returns (address);
    function batchOrigin() external view returns (uint256);

    function currentBatch() external view returns (uint256 batchId, Phase phase, uint256 phaseEndsBlock);
    /// @notice keccak256(abi.encode(block.chainid, address(this), batchId, trader, sellBase, amountIn,
    ///         limitPriceX18, routeResidual, salt)).
    function commitHashOf(
        uint256 batchId,
        address trader,
        bool sellBase,
        uint256 amountIn,
        uint256 limitPriceX18,
        bool routeResidual,
        bytes32 salt
    ) external view returns (bytes32);

    function fund(address token, uint256 amount) external;
    function withdraw(address token, uint256 amount) external;
    function balances(address account, address token) external view returns (uint256 available, uint256 locked);

    /// @notice COMMIT phase only. Calls eligibility.enforce(msg.sender, attestationUid); on denial returns false and
    ///         changes no state (EligibilityDenied is emitted by the eligibility contract).
    function commit(bytes32 commitHash, address lockToken, uint256 lockAmount, bytes32 attestationUid)
        external
        returns (bool accepted);
    /// @notice REVEAL phase of the batch the caller committed to.
    function reveal(bool sellBase, uint256 amountIn, uint256 limitPriceX18, bool routeResidual, bytes32 salt)
        external;
    /// @notice Permissionless. batchId < current, or batchId == current in SETTLE phase. Reverts OracleStale if the
    ///         mid is older than ORACLE_MAX_AGE at block.timestamp.
    function settle(uint256 batchId) external;

    function order(uint256 batchId, address trader) external view returns (Order memory);
    function participants(uint256 batchId) external view returns (address[] memory);
    function settled(uint256 batchId) external view returns (bool);
    function batchResult(uint256 batchId) external view returns (BatchResult memory);
}
```

| Constant | Value |
|---|---|
| `BATCH_BLOCKS` / `COMMIT_BLOCKS` / `REVEAL_BLOCKS` | 20 / 12 / 6 (settle phase = last 2 blocks) |
| `MAX_PARTICIPANTS` | 64 |
| `CROSS_FEE_PIPS` | 500 (5 bps, charged on each side's received amount, to `treasury`) |
| `FORFEIT_BPS` | 10 (of `locked`, unrevealed commits only, to `treasury`, same token) |
| `ORACLE_MAX_AGE` | 900 seconds |

Batch clock: `n = block.number - batchOrigin`, `batchId = n / 20`, `pos = n % 20`, phase `COMMIT` if `pos < 12`,
`REVEAL` if `pos < 18`, else `SETTLE`. `batchOrigin` is the hook deployment block.

Reveal validity (`valid`): `lockToken == (sellBase ? baseToken : quoteToken)`, `locked >= amountIn`, `amountIn > 0`,
`limitPriceX18 > 0`; failures emit `RevealRejected` (no forfeit). Settlement, with `mid` = `oracle.getMid(base, quote)`,
`dB`/`dQ` = decimals of base/quote:

1. Base sellers eligible iff `valid && sellBase && mid >= limit`; quote sellers iff `valid && !sellBase && mid <= limit`.
   `B = Σ amountIn(base sellers)`, `Q = Σ amountIn(quote sellers)`.
2. `QasBase = floor(Q · 1e18 · 10^dB / (mid · 10^dQ))`; `crossedBase = min(B, QasBase)`;
   `crossedQuote = floor(crossedBase · mid · 10^dQ / (1e18 · 10^dB))`.
3. Allocation in participant order with cumulative flooring: base seller i `crossedIn_i = floor(cumIn_i·crossedBase/B) −
   floor(cumIn_{i−1}·crossedBase/B)`; quote sellers likewise with `crossedQuote/Q`. Gross received: base seller
   `grossQuote_i` = cumulative floor of `crossedQuote` by `crossedIn` weight, quote seller `grossBase_j` likewise.
4. `feeAmount = ceil(gross · 500 / 1e6)` to treasury; `amountOut = gross − feeAmount` credited to escrow `available`.
5. Residual `residualIn = amountIn − crossedIn`. If `routeResidual`, swap exact-input on `parityPoolKey` inside the
   same unlock with minimum output `sellBase ? floor(r·limit·10^dQ/(1e18·10^dB)) : floor(r·1e18·10^dB/(limit·10^dQ))`;
   success ⇒ `ResidualRouted` and output credited to escrow; failure ⇒ `ResidualSkipped`, residual stays in escrow.
6. Unrevealed commits forfeit `floor(locked · 10 / 1e4)`; all remaining locks unlock; emit `BatchSettled`.

### 1.9 CanonicalShares (internal library; contracts lane implements at `contracts/src/libraries/CanonicalShares.sol`)

Signatures (not an interface file; mirrored bit-for-bit by `packages/types/src/canonical.ts`):

```solidity
library CanonicalShares {
    uint256 internal constant ONE = 1e18;       // one canonical share
    uint256 internal constant PIPS = 1e6;       // fee denominator
    function toSharesDown(uint256 amount, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256);   // floor(amount * spt / 10**dec)
    function toSharesUp(uint256 amount, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256);     // ceil
    function fromSharesDown(uint256 shares, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256); // floor(shares * 10**dec / spt)
    function fromSharesUp(uint256 shares, uint256 sharesPerToken, uint8 decimals) internal pure returns (uint256);   // ceil
    function parityPriceX18(uint256 spt0, uint256 spt1) internal pure returns (uint256);                            // floor(spt0 * 1e18 / spt1)
    function skewX18(uint256 shares0, uint256 shares1) internal pure returns (int256);                              // trunc toward zero
    function skewPips(uint256 shares0, uint256 shares1, uint24 skewFeePips) internal pure returns (uint24);         // ceil
    function offHoursPips(uint256 shares0, uint256 shares1, uint256 post0, uint256 post1) internal pure returns (uint24); // ceil(1500*|post skew|) iff |skew| grows, else 0
    function marginalOffHoursPips(uint256 shares0, uint256 shares1) internal pure returns (uint24);             // ceil(1500*|skew|)
    function postTradeShares(uint256 shares0, uint256 shares1, bool zeroForOne, uint256 shares) internal pure returns (uint256, uint256);
    function totalFeePips(uint256 shares0, uint256 shares1, uint256 post0, uint256 post1, bool marketOpen) internal pure returns (uint24); // capped
    function feeOnGross(uint256 grossOut, uint24 feePips) internal pure returns (uint256);                         // ceil(gross * pips / 1e6)
    function grossForNet(uint256 netOut, uint24 feePips) internal pure returns (uint256);                          // ceil(net * 1e6 / (1e6 - pips))
    function poolPriceX18(uint160 sqrtPriceX96, uint8 dec0, uint8 dec1) internal pure returns (uint256);           // floor
    function deviationBps(uint256 priceX18, uint256 referenceX18) internal pure returns (uint256);                 // ceil
}
```

All multiplications use `FullMath.mulDiv` / `mulDivRoundingUp` (512-bit intermediate).

## 2. Events

Every indexer-relevant state change emits one of these. Reverted transactions emit nothing: a parity swap blocked by
eligibility or by the peg guard is visible only through the API's simulation (§5 `/route`), and on-chain through
`EligibilityDenied` (dark commits) and `PegGuardStatus` (crank-driven `checkPeg`, §7). The table is generated by
`make types` from the compiled interface ABIs; topic0 = keccak256 of the canonical signature
(`PoolId` → `bytes32`, `Phase` → `uint8`).

<!-- BEGIN GENERATED: events -->
| Contract | Event (indexed params marked) | topic0 |
|---|---|---|
| IParityHook | `FallThrough(PoolId indexed poolId, address indexed swapper, address indexed sender, bool zeroForOne, uint8 reason, int128 amount0, int128 amount1, uint24 feePips, uint256 deviationBpsAfter)` | `0x08a5690319d08e67b2120f187209783d9f9feb7617e20d00a59267de8cef9d0e` |
| IParityHook | `FeeQuoted(PoolId indexed poolId, uint24 totalPips, uint24 basePips, uint24 skewPips, uint24 closedPips, int256 skewX18, bool marketOpen)` | `0x70a33abfcb089e53dfc79c5d08579d7c73a8147d2faa33ee063a481d161f4fd4` |
| IParityHook | `FeesSwept(address indexed currency, address indexed to, uint256 amount)` | `0x244e51bc38c1452fa8aaf487bcb4bca36c2baa3a5fbdb776b1eabd8dc6d277cd` |
| IParityHook | `InventoryChanged(address indexed currency, address indexed actor, uint8 indexed reason, int256 delta, uint256 inventoryAfter)` | `0x167335e2f932a38f3d0d37a40a8762d258e478d874023b84bc2dfbdc5bb71de1` |
| IParityHook | `InventoryFill(PoolId indexed poolId, address indexed swapper, address indexed sender, bool zeroForOne, bool exactInput, uint256 amountIn, uint256 amountOut, uint256 shares, uint256 feeAmount, uint24 feePips)` | `0xb3cbc8a811283975fbe6ea59fccba6de9456803108e9153f99ade1d6416afc22` |
| IParityHook | `KeeperSet(address indexed keeper, bool allowed)` | `0x8dd62d4e1f60b96148552898e743aa2b571686baa26f4f1b647565dc3996c1a7` |
| IParityHook | `PegGuardStatus(PoolId indexed poolId, bool tripped, uint256 poolPriceX18, uint256 parityPriceX18, uint256 deviationBps)` | `0xeacc7c405f52a1fed44b89ff30c353fac2c4cb13ee3cf8faf9eb6c1424d6507a` |
| IParityHook | `PoolRegistered(PoolId indexed poolId, address indexed currency0, address indexed currency1, bytes32 underlying, int24 tickSpacing)` | `0xb419fe0f6962531749e701dc0de5ed15cd668c91aac2ba9e3c43297289b62643` |
| IDarkCrossHook | `BatchSettled(uint256 indexed batchId, uint256 midX18, uint64 midUpdatedAt, uint256 crossedBase, uint256 crossedQuote, uint256 residualBaseIn, uint256 residualQuoteIn, uint32 participants)` | `0x9ad14ebbb40ae19eb62a3ebce10099ab3dc79dabd3477dd3b42906f3204b38da` |
| IDarkCrossHook | `Committed(uint256 indexed batchId, address indexed trader, bytes32 commitHash, address lockToken, uint256 locked)` | `0xbae78d1b7091b54681f1aab6629ff13d0a248169449e8de7cd772a2423e01a91` |
| IDarkCrossHook | `Crossed(uint256 indexed batchId, address indexed trader, bool sellBase, uint256 amountIn, uint256 amountOut, uint256 feeAmount, uint256 midX18)` | `0x120c141ee2d80d9ad63fc08d6f5bfee2e6cc296db28c0e47bbff2163d108765a` |
| IDarkCrossHook | `Forfeited(uint256 indexed batchId, address indexed trader, address token, uint256 amount)` | `0x0a040e9fa8d18588360122b3c43fd8e3795efab941f6925f6ef84a1729f61904` |
| IDarkCrossHook | `Funded(address indexed account, address indexed token, uint256 amount)` | `0x3b5083eec1a1116c56de5d6841cff8efc6a0aec9850e836ec509d6ce024ea561` |
| IDarkCrossHook | `ResidualRouted(uint256 indexed batchId, address indexed trader, PoolId indexed poolId, bool sellBase, uint256 amountIn, uint256 amountOut)` | `0xc867dddaeae961373512a0256d29d1ea7ac187c80f7fecd1b24cbe4d2d0b47eb` |
| IDarkCrossHook | `ResidualSkipped(uint256 indexed batchId, address indexed trader, bytes reason)` | `0xc85180a1b3169714c77f3582c5ef222e60d51f5846a365e8cf4a13a0c5a22a01` |
| IDarkCrossHook | `RevealRejected(uint256 indexed batchId, address indexed trader, uint8 reason)` | `0x5f7d0c3a3c086232797f6a9cdef85b4c6c823e780889bb5720e950bdd3c9871d` |
| IDarkCrossHook | `Revealed(uint256 indexed batchId, address indexed trader, bool sellBase, uint256 amountIn, uint256 limitPriceX18, bool routeResidual)` | `0x49b87e398756018e4521c2d4e3ca5366e380ca28626bacdd1e3a943ed553a8f2` |
| IDarkCrossHook | `Withdrawn(address indexed account, address indexed token, uint256 amount)` | `0xd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb` |
| IEligibility | `DemoModeSet(bool enabled, address indexed setBy)` | `0x8a2dd1602e01058d2ced0ff32dcbe3a5f8e0e80f1bba26755fdf1e741e02f106` |
| IEligibility | `EligibilityDenied(address indexed account, address indexed caller, uint8 indexed reason, bytes32 attestationUid)` | `0x8939d28f9ab6dc11a7e853547f0e5020ab59f18ac034eb7948472982ab3d1b48` |
| IEligibility | `TrustedRouterSet(address indexed router, bool trusted)` | `0xf03b9904b8234e041267377d7a55ddb345d1ee737d0116a2e621e3a5fad07a7d` |
| IPriceOracle | `MidUpdated(address indexed base, address indexed quote, uint256 midX18, uint64 updatedAt)` | `0xcf5cdea7aff133ae986d63374ba22676502d9ec122ec25157297d31f582ea9ab` |
| IMockPriceOracle | `PusherSet(address indexed pusher, bool allowed)` | `0x4147ca954250df42c7cb705811480eebe5491f79112dcd59f16b764587210ea3` |
| IWrapperAdapter | `AdapterPaused(address indexed token, bool paused)` | `0xefc222c55f6cd4daa0ac2dde2f7dea5ce319f2d9dce08cc9abae98c62de96493` |
| IWrapperAdapter | `RatioUpdated(address indexed token, uint256 oldSharesPerToken, uint256 newSharesPerToken)` | `0x4c5c23b4efbfea6d16c8453f565e165a02a22cda9a8dc7aac0a66f91d2304da6` |
| IMockIssuerToken | `MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier)` | `0x3c02d7351af6053255d947ce3f7b457726360edc933c441e9b1ad724f8ce5c7f` |
| IMockIssuerToken | `TransfersPaused(bool paused)` | `0x106877e810194754ee8a95268e27dbd9ad06a13e6cbf2d335b705cbaa88299b9` |
| IIssuerRegistry | `IssuerAdded(address indexed token, address indexed adapter, bytes32 indexed underlying)` | `0x9a172aaa4b741a5bfd1e350bffba82b575efb6409f5f82dbdd320d139102d3a3` |
| IIssuerRegistry | `IssuerPaused(address indexed token, bool paused)` | `0x979f4e0374470ec015c3cc6253737d7164d952442b14f03d37e8a07ee29412b2` |
| IIssuerRegistry | `IssuerRemoved(address indexed token, address indexed adapter, bytes32 indexed underlying)` | `0xdd3d7cebca8ca0e1f9767e76f4d3d7a954e35bb31f69df8b8f078c6f29ed0925` |
| INyseCalendar | `EarlyCloseSet(uint256 indexed day, uint256 secondsAfterMidnight)` | `0x2d17e58ec72408e3ae8782d6799b572c338706eb2c739bd7ad1f2e256f82ca6d` |
| INyseCalendar | `HolidaySet(uint256 indexed day, bool closed)` | `0x9b15843c04fd3c44a6e229cbc7fb2d66a1e6859d73444b1f8224b592fed25379` |
<!-- END GENERATED: events -->

Coverage of the required state changes:

| State change | Event(s) |
|---|---|
| Inventory fill | `IParityHook.InventoryFill` |
| Fall-through fill | `IParityHook.FallThrough` |
| Fee quote | `IParityHook.FeeQuoted` (every swap reaching beforeSwap) |
| Inventory change | `IParityHook.InventoryChanged`, `IParityHook.FeesSwept` |
| Peg-guard trip / clear | `IParityHook.PegGuardStatus` |
| Commit / reveal | `IDarkCrossHook.Committed`, `Revealed`, `RevealRejected` |
| Batch settlement | `IDarkCrossHook.Crossed`, `Forfeited`, `BatchSettled` |
| Residual routing | `IDarkCrossHook.ResidualRouted`, `ResidualSkipped` (+ the `InventoryFill`/`FallThrough` of the same tx) |
| demoMode toggle | `IEligibility.DemoModeSet` |
| Eligibility denial | `IEligibility.EligibilityDenied` |
| Oracle / ratio inputs | `IPriceOracle.MidUpdated`, `IWrapperAdapter.RatioUpdated`, `IMockIssuerToken.MultiplierUpdated` |

## 3. hookData encoding

### ParityHook, version 1

```
hookData = abi.encode(uint8 version, address swapper, bytes32 attestationUid)   // exactly 96 bytes, version == 1
```

- `hookData.length == 0`: swapper = `sender`, attestationUid = 0.
- `hookData.length == 96 && version == 1`: swapper = `eligibility.resolveSwapper(sender, swapper)` (the claimed address
  is honoured only when `sender` is a trusted router), attestationUid as given (0 ⇒ indexer lookup).
- Any other length or version ⇒ revert `InvalidHookData()`.
- Trusted routers at deploy: `swapRouter` (PoolSwapTest) and `darkCrossHook`; on Unichain Sepolia additionally the
  Universal Router. Changes emit `TrustedRouterSet`.
- TypeScript: `encodeParityHookData({ swapper, attestationUid })` in `@wrapswap/types`.

### DarkCrossHook

Consumes no hookData (not attached to a pool). For every residual swap it passes ParityHook v1 hookData
`abi.encode(uint8(1), trader, order.attestationUid)`; it is itself a trusted router. Its `unlockCallback` payload is
internal: `abi.encode(uint8(1), uint256 batchId)`, accepted only while `settle` is executing.

## 4. Deployment JSON

Path: `deployments/${NETWORK}.json`. `deployments/anvil.json` is generated at runtime and gitignored;
`deployments/unichain-sepolia.json` is committed by the deployment lane. `deployments/local.json` is legacy (§11).
TypeScript: `parseDeployment(json)` validates, `deploymentPath(network)` returns the relative path.

```json wrapswap:schema Address
{ "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" }
```

```json wrapswap:schema Bytes32
{ "type": "string", "pattern": "^0x[0-9a-fA-F]{64}$" }
```

```json wrapswap:schema UInt
{ "type": "string", "pattern": "^(0|[1-9][0-9]*)$" }
```

```json wrapswap:schema Int
{ "type": "string", "pattern": "^(0|-?[1-9][0-9]*)$" }
```

```json wrapswap:schema Network
{ "enum": ["anvil", "unichain-sepolia"] }
```

```json wrapswap:schema PoolKey
{
  "type": "object",
  "additionalProperties": false,
  "required": ["currency0", "currency1", "fee", "tickSpacing", "hooks"],
  "properties": {
    "currency0": { "$ref": "Address" },
    "currency1": { "$ref": "Address" },
    "fee": { "type": "integer" },
    "tickSpacing": { "type": "integer" },
    "hooks": { "$ref": "Address" }
  }
}
```

```json wrapswap:schema DeploymentToken
{
  "type": "object",
  "additionalProperties": false,
  "required": ["symbol", "name", "address", "decimals", "issuer", "underlying", "mock", "adapter", "adapterKind", "sharesPerTokenX18", "darkRole"],
  "properties": {
    "symbol": { "type": "string" },
    "name": { "type": "string" },
    "address": { "$ref": "Address" },
    "decimals": { "type": "integer" },
    "issuer": { "enum": ["coinbase", "xstocks"] },
    "underlying": { "type": "string" },
    "mock": { "type": "boolean" },
    "adapter": { "$ref": "Address" },
    "adapterKind": { "enum": ["B20Multiplier", "XStocksMultiplier", "Static"] },
    "sharesPerTokenX18": { "$ref": "UInt" },
    "darkRole": { "enum": ["base", "quote"] }
  }
}
```

```json wrapswap:schema HookDeployment
{
  "type": "object",
  "additionalProperties": false,
  "required": ["address", "flags", "permissions"],
  "properties": {
    "address": { "$ref": "Address" },
    "flags": { "type": "string", "pattern": "^0x[0-9a-f]{4}$" },
    "permissions": { "type": "array", "items": { "enum": ["beforeInitialize", "afterInitialize", "beforeAddLiquidity", "afterAddLiquidity", "beforeRemoveLiquidity", "afterRemoveLiquidity", "beforeSwap", "afterSwap", "beforeDonate", "afterDonate", "beforeSwapReturnDelta", "afterSwapReturnDelta", "afterAddLiquidityReturnDelta", "afterRemoveLiquidityReturnDelta"] } }
  }
}
```

```json wrapswap:schema Deployment
{
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "network", "chainId", "deployCommit", "deployedAt", "deployer", "startBlock", "demoMode", "mockOracle", "contracts", "tokens", "pool", "hooks", "dark", "blocks", "demoAccounts"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "network": { "$ref": "Network" },
    "chainId": { "enum": [31337, 1301] },
    "deployCommit": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "deployedAt": { "type": "string" },
    "deployer": { "$ref": "Address" },
    "startBlock": { "$ref": "UInt" },
    "demoMode": { "type": "boolean" },
    "mockOracle": { "type": "boolean" },
    "contracts": {
      "type": "object",
      "additionalProperties": false,
      "required": ["poolManager", "positionManager", "stateView", "quoter", "permit2", "universalRouter", "swapRouter", "modifyLiquidityRouter", "registry", "calendar", "eligibility", "oracle", "parityHook", "darkCrossHook", "eas", "easIndexer"],
      "properties": {
        "poolManager": { "$ref": "Address" },
        "positionManager": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{40}$" },
        "stateView": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{40}$" },
        "quoter": { "$ref": "Address" },
        "permit2": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{40}$" },
        "universalRouter": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{40}$" },
        "swapRouter": { "$ref": "Address" },
        "modifyLiquidityRouter": { "$ref": "Address" },
        "registry": { "$ref": "Address" },
        "calendar": { "$ref": "Address" },
        "eligibility": { "$ref": "Address" },
        "oracle": { "$ref": "Address" },
        "parityHook": { "$ref": "Address" },
        "darkCrossHook": { "$ref": "Address" },
        "wrapSwapRouter": { "$ref": "Address" },
        "eas": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{40}$" },
        "easIndexer": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{40}$" }
      }
    },
    "tokens": { "type": "array", "items": { "$ref": "DeploymentToken" } },
    "pool": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "key", "initSqrtPriceX96"],
      "properties": {
        "id": { "$ref": "Bytes32" },
        "key": { "$ref": "PoolKey" },
        "initSqrtPriceX96": { "$ref": "UInt" }
      }
    },
    "hooks": {
      "type": "object",
      "additionalProperties": false,
      "required": ["parityHook", "darkCrossHook"],
      "properties": {
        "parityHook": { "$ref": "HookDeployment" },
        "darkCrossHook": { "$ref": "HookDeployment" }
      }
    },
    "dark": {
      "type": "object",
      "additionalProperties": false,
      "required": ["baseToken", "quoteToken", "batchOrigin", "batchBlocks", "commitBlocks", "revealBlocks"],
      "properties": {
        "baseToken": { "$ref": "Address" },
        "quoteToken": { "$ref": "Address" },
        "batchOrigin": { "$ref": "UInt" },
        "batchBlocks": { "type": "integer" },
        "commitBlocks": { "type": "integer" },
        "revealBlocks": { "type": "integer" }
      }
    },
    "blocks": { "type": "object", "additionalProperties": { "$ref": "UInt" } },
    "demoAccounts": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mnemonicSource", "accounts"],
      "properties": {
        "mnemonicSource": { "enum": ["anvil-default", "env:DEMO_MNEMONIC"] },
        "accounts": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["role", "index", "address"],
            "properties": {
              "role": { "enum": ["deployer", "demo", "counterpartyA", "counterpartyB", "crank"] },
              "index": { "type": "integer" },
              "address": { "$ref": "Address" }
            }
          }
        }
      }
    },
    "verification": { "type": "object", "additionalProperties": { "type": "string" } },
    "router": { "$ref": "Address" },
    "faucet": { "$ref": "Address" },
    "assets": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["symbol", "wrappers", "pool", "darkCross"],
        "properties": {
          "symbol": { "type": "string" },
          "wrappers": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["platform", "symbol", "token", "adapter", "multiplier", "decimals"],
              "properties": {
                "platform": { "enum": ["Coinbase", "xStocks"] },
                "symbol": { "type": "string" },
                "token": { "$ref": "Address" },
                "adapter": { "$ref": "Address" },
                "multiplier": { "$ref": "UInt" },
                "decimals": { "type": "integer" }
              }
            }
          },
          "pool": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "key", "initSqrtPriceX96"],
            "properties": {
              "id": { "$ref": "Bytes32" },
              "key": { "$ref": "PoolKey" },
              "initSqrtPriceX96": { "$ref": "UInt" }
            }
          },
          "darkCross": { "type": "boolean" }
        }
      }
    },
    "proofs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["label", "tx"],
        "properties": { "label": { "type": "string" }, "tx": { "$ref": "Bytes32" } }
      }
    }
  }
}
```

Field rules: `startBlock` = first block the indexer scans (the registry deployment block). `blocks` maps each contract
key of `contracts` that this deployment created to its deployment block, plus `poolInitialized`. `pool.key` must equal
the on-chain PoolKey (`fee = 8388608` = DYNAMIC_FEE_FLAG, `tickSpacing = 10`, `hooks = contracts.parityHook`).
`hooks.parityHook.flags` must be `0x20c8` and equal `address & 0x3fff`; `hooks.darkCrossHook.flags` is `0x0000`
(not a pool hook). `demoAccounts` never contains private keys. `verification` maps contract key → explorer URL.
On anvil, v4 core, `V4Quoter` (as `quoter`), `PoolSwapTest` (as `swapRouter`) and `PoolModifyLiquidityTest` (as
`modifyLiquidityRouter`) are deployed by `Deploy.s.sol`; `positionManager`, `stateView`, `permit2`,
`universalRouter`, `eas`, `easIndexer` are `null`.

Worked example, anvil (illustrative addresses; values that must be exact are the constants):

```json
{
  "schemaVersion": 1,
  "network": "anvil",
  "chainId": 31337,
  "deployCommit": "0123456789abcdef0123456789abcdef01234567",
  "deployedAt": "2026-09-29T14:29:00Z",
  "deployer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "startBlock": "1",
  "demoMode": true,
  "mockOracle": true,
  "contracts": {
    "poolManager": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "positionManager": null,
    "stateView": null,
    "quoter": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    "permit2": null,
    "universalRouter": null,
    "swapRouter": "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    "modifyLiquidityRouter": "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    "registry": "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    "calendar": "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    "eligibility": "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    "oracle": "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
    "parityHook": "0x1f5a0e3B5D6c1D1d7a4D2d0a3C1b9E8F7a6B20C8",
    "darkCrossHook": "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
    "eas": null,
    "easIndexer": null
  },
  "tokens": [
    {
      "symbol": "mcbAAPL", "name": "Mock Coinbase Apple", "address": "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
      "decimals": 6, "issuer": "coinbase", "underlying": "AAPL", "mock": true,
      "adapter": "0x610178dA211FEF7D417bC0e6FeD39F05609AD788", "adapterKind": "B20Multiplier",
      "sharesPerTokenX18": "1012500000000000000", "darkRole": "base"
    },
    {
      "symbol": "mAAPLx", "name": "Mock Apple xStock", "address": "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
      "decimals": 18, "issuer": "xstocks", "underlying": "AAPL", "mock": true,
      "adapter": "0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0", "adapterKind": "XStocksMultiplier",
      "sharesPerTokenX18": "1000000000000000000", "darkRole": "quote"
    }
  ],
  "pool": {
    "id": "0x6a1b5c3a0f4e2d9c8b7a6f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a",
    "key": {
      "currency0": "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
      "currency1": "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
      "fee": 8388608,
      "tickSpacing": 10,
      "hooks": "0x1f5a0e3B5D6c1D1d7a4D2d0a3C1b9E8F7a6B20C8"
    },
    "initSqrtPriceX96": "79721800701433069633245772272326702"
  },
  "hooks": {
    "parityHook": {
      "address": "0x1f5a0e3B5D6c1D1d7a4D2d0a3C1b9E8F7a6B20C8",
      "flags": "0x20c8",
      "permissions": ["beforeInitialize", "beforeSwap", "afterSwap", "beforeSwapReturnDelta"]
    },
    "darkCrossHook": { "address": "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6", "flags": "0x0000", "permissions": [] }
  },
  "dark": {
    "baseToken": "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    "quoteToken": "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
    "batchOrigin": "14",
    "batchBlocks": 20,
    "commitBlocks": 12,
    "revealBlocks": 6
  },
  "blocks": {
    "poolManager": "1", "quoter": "2", "swapRouter": "3", "modifyLiquidityRouter": "4", "registry": "5",
    "calendar": "6", "eligibility": "7", "oracle": "8", "parityHook": "13", "darkCrossHook": "14",
    "poolInitialized": "15"
  },
  "demoAccounts": {
    "mnemonicSource": "anvil-default",
    "accounts": [
      { "role": "deployer", "index": 0, "address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
      { "role": "demo", "index": 1, "address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
      { "role": "counterpartyA", "index": 2, "address": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      { "role": "counterpartyB", "index": 3, "address": "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
      { "role": "crank", "index": 4, "address": "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" }
    ]
  }
}
```

Placeholder, unichain-sepolia (the deployment lane fills every `<…>`; `null`s shown are the values that stay null):

```json
{
  "schemaVersion": 1,
  "network": "unichain-sepolia",
  "chainId": 1301,
  "deployCommit": "<40-hex commit of the deploy>",
  "deployedAt": "<ISO-8601 UTC>",
  "deployer": "<DEMO_MNEMONIC index 0>",
  "startBlock": "<registry deploy block>",
  "demoMode": true,
  "mockOracle": true,
  "contracts": {
    "poolManager": "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    "positionManager": "0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80",
    "stateView": "0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4",
    "quoter": "0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa",
    "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "universalRouter": "0x8702463e73f74d0b6765aBceb314Ef07aCb92650",
    "swapRouter": "<PoolSwapTest>", "modifyLiquidityRouter": "<PoolModifyLiquidityTest>",
    "registry": "<>", "calendar": "<>", "eligibility": "<>", "oracle": "<>",
    "parityHook": "<address & 0x3fff == 0x20c8>", "darkCrossHook": "<>",
    "eas": "0x4200000000000000000000000000000000000021", "easIndexer": "<Coinbase indexer or null>"
  },
  "tokens": ["<mcbAAPL DeploymentToken>", "<mAAPLx DeploymentToken>"],
  "pool": { "id": "<>", "key": { "currency0": "<>", "currency1": "<>", "fee": 8388608, "tickSpacing": 10, "hooks": "<parityHook>" }, "initSqrtPriceX96": "<§10>" },
  "hooks": { "parityHook": { "address": "<>", "flags": "0x20c8", "permissions": ["beforeInitialize", "beforeSwap", "afterSwap", "beforeSwapReturnDelta"] }, "darkCrossHook": { "address": "<>", "flags": "0x0000", "permissions": [] } },
  "dark": { "baseToken": "<mcbAAPL>", "quoteToken": "<mAAPLx>", "batchOrigin": "<darkCrossHook deploy block>", "batchBlocks": 20, "commitBlocks": 12, "revealBlocks": 6 },
  "blocks": { "<contract key>": "<block>", "poolInitialized": "<block>" },
  "demoAccounts": { "mnemonicSource": "env:DEMO_MNEMONIC", "accounts": ["<role/index/address for indices 0-4>"] },
  "verification": { "<contract key>": "https://sepolia.uniscan.xyz/address/<address>#code" }
}
```

## 5. API routes

Base URL `http://127.0.0.1:${API_PORT}`; the web dev server proxies `/api/*` to it with the prefix stripped. All routes
are `GET`, no request bodies, JSON responses. Errors use HTTP 400 (invalid input), 404 (unknown id/token/route),
503 (chain RPC or Postgres unavailable), 500 (bug), always with the `ErrorResponse` body. Nothing is fabricated: a value
that cannot be read is an error, never a default. Chain-read values carry the `block` they were read at.

```json wrapswap:schema ErrorResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["error"],
  "properties": {
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message"],
      "properties": {
        "code": { "enum": ["BAD_REQUEST", "NOT_FOUND", "CHAIN_UNAVAILABLE", "DB_UNAVAILABLE", "INTERNAL"] },
        "message": { "type": "string" },
        "details": {}
      }
    }
  }
}
```

```json wrapswap:routes
[
  { "name": "health", "method": "GET", "path": "/health", "query": null, "response": "HealthResponse", "backing": "chain: eth_chainId, eth_blockNumber; table: indexer_cursor, indexer_deployments" },
  { "name": "deployment", "method": "GET", "path": "/deployment", "query": null, "response": "Deployment", "backing": "file: deployments/${NETWORK}.json" },
  { "name": "pool", "method": "GET", "path": "/pool", "query": null, "response": "PoolStateResponse", "backing": "chain: PoolManager.getSlot0/getLiquidity via extsload, ParityHook.pegStatus, pegTripped, adapters; table: parity_peg_status" },
  { "name": "inventory", "method": "GET", "path": "/inventory", "query": null, "response": "InventoryResponse", "backing": "chain: ParityHook.inventory, inventoryShares, feesAccrued, feeBreakdown" },
  { "name": "inventoryChanges", "method": "GET", "path": "/inventory/changes", "query": "PageQuery", "response": "InventoryChangesResponse", "backing": "table: parity_inventory_changes, parity_fee_sweeps" },
  { "name": "fees", "method": "GET", "path": "/fees", "query": null, "response": "FeesResponse", "backing": "chain: ParityHook.feeBreakdown; table: parity_fee_quotes (recent)" },
  { "name": "quote", "method": "GET", "path": "/quote", "query": "SwapQuery", "response": "QuoteResponse", "backing": "chain: ParityHook.quote" },
  { "name": "route", "method": "GET", "path": "/route", "query": "RouteQuery", "response": "RouteResponse", "backing": "chain: IEligibility.check, ParityHook.quote, V4Quoter simulation, DarkCrossHook.currentBatch, IPriceOracle.getMid; table: eligibility_checks (insert)" },
  { "name": "nyse", "method": "GET", "path": "/nyse", "query": null, "response": "NyseResponse", "backing": "chain: latest block timestamp, NyseCalendar.isOpen, nextTransition" },
  { "name": "currentBatch", "method": "GET", "path": "/batches/current", "query": null, "response": "CurrentBatchResponse", "backing": "chain: DarkCrossHook.currentBatch, participants, IPriceOracle.getMid" },
  { "name": "batches", "method": "GET", "path": "/batches", "query": "PageQuery", "response": "BatchListResponse", "backing": "view: v_dark_batches" },
  { "name": "batch", "method": "GET", "path": "/batches/:batchId", "query": null, "response": "BatchDetailResponse", "backing": "view: v_dark_batches, v_dark_orders, v_fills; table: dark_forfeits, dark_residual_skips" },
  { "name": "orders", "method": "GET", "path": "/orders/:address", "query": "PageQuery", "response": "OrderListResponse", "backing": "view: v_dark_orders" },
  { "name": "fills", "method": "GET", "path": "/fills", "query": "FillsQuery", "response": "FillListResponse", "backing": "view: v_fills" },
  { "name": "eligibility", "method": "GET", "path": "/eligibility/:address", "query": "EligibilityQuery", "response": "EligibilityResponse", "backing": "chain: IEligibility.check, demoMode; table: eligibility_checks (insert), eligibility_denials" },
  { "name": "crankStatus", "method": "GET", "path": "/status", "query": null, "response": "CrankStatusResponse", "backing": "crank process on CRANK_HEALTH_PORT (§7), not the API" }
]
```

Path parameters: `:batchId` is a `UInt`; `:address` is an `Address`. Pagination: `limit` 1–200 (default 50);
`cursor` is the opaque `nextCursor` of the previous page (`"<blockNumber>:<logIndex>"`, newest first).

```json wrapswap:schema PageQuery
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "limit": { "type": "string", "pattern": "^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$" },
    "cursor": { "type": "string", "pattern": "^[0-9]+:[0-9]+$" }
  }
}
```

```json wrapswap:schema SwapQuery
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tokenIn", "tokenOut", "amount"],
  "properties": {
    "tokenIn": { "$ref": "Address" },
    "tokenOut": { "$ref": "Address" },
    "amount": { "type": "string", "pattern": "^[1-9][0-9]*$" },
    "kind": { "enum": ["exactIn", "exactOut"] }
  }
}
```

```json wrapswap:schema RouteQuery
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tokenIn", "tokenOut", "amount", "swapper"],
  "properties": {
    "tokenIn": { "$ref": "Address" },
    "tokenOut": { "$ref": "Address" },
    "amount": { "type": "string", "pattern": "^[1-9][0-9]*$" },
    "kind": { "enum": ["exactIn", "exactOut"] },
    "swapper": { "$ref": "Address" },
    "attestationUid": { "$ref": "Bytes32" },
    "allowDark": { "enum": ["true", "false"] }
  }
}
```

```json wrapswap:schema FillsQuery
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "account": { "$ref": "Address" },
    "kind": { "$ref": "FillKind" },
    "limit": { "type": "string", "pattern": "^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$" },
    "cursor": { "type": "string", "pattern": "^[0-9]+:[0-9]+$" }
  }
}
```

```json wrapswap:schema EligibilityQuery
{
  "type": "object",
  "additionalProperties": false,
  "properties": { "attestationUid": { "$ref": "Bytes32" } }
}
```

`kind` defaults to `exactIn`; `allowDark` defaults to `true`. `amount` is raw units of `tokenIn` (exactIn) or
`tokenOut` (exactOut). `tokenIn`/`tokenOut` must be the two pool currencies, else 404.

### 5.1 Shared response schemas

```json wrapswap:schema FeeBreakdown
{
  "type": "object",
  "additionalProperties": false,
  "required": ["basePips", "skewPips", "closedPips", "totalPips", "totalBps", "skewX18", "marketOpen"],
  "properties": {
    "basePips": { "type": "integer" },
    "skewPips": { "type": "integer" },
    "closedPips": { "type": "integer" },
    "totalPips": { "type": "integer" },
    "totalBps": { "type": "string", "pattern": "^[0-9]+\\.[0-9]{2}$" },
    "skewX18": { "$ref": "Int" },
    "marketOpen": { "type": "boolean" }
  }
}
```

```json wrapswap:schema TokenState
{
  "type": "object",
  "additionalProperties": false,
  "required": ["symbol", "address", "decimals", "adapter", "sharesPerTokenX18", "healthy"],
  "properties": {
    "symbol": { "type": "string" },
    "address": { "$ref": "Address" },
    "decimals": { "type": "integer" },
    "adapter": { "$ref": "Address" },
    "sharesPerTokenX18": { "$ref": "UInt" },
    "healthy": { "type": "boolean" }
  }
}
```

```json wrapswap:schema Route
{ "enum": ["PARITY", "FALL-THROUGH", "DARK", "BLOCKED-PEG", "BLOCKED-ELIGIBILITY"] }
```

```json wrapswap:schema FillKind
{ "enum": ["PARITY", "FALL-THROUGH", "DARK-CROSS", "DARK-RESIDUAL"] }
```

```json wrapswap:schema EligibilityReason
{ "enum": ["OK", "NO_ATTESTATION", "WRONG_SCHEMA", "WRONG_ATTESTER", "WRONG_RECIPIENT", "REVOKED", "EXPIRED", "RESTRICTED_COUNTRY"] }
```

```json wrapswap:schema BatchPhase
{ "enum": ["COMMIT", "REVEAL", "SETTLE"] }
```

### 5.2 Route responses

`GET /health`

```json wrapswap:schema HealthResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["ok", "network", "chainId", "rpcChainId", "headBlock", "indexedBlock", "lagBlocks", "db", "demoMode", "deployCommit", "startBlock", "addresses"],
  "properties": {
    "ok": { "type": "boolean" },
    "network": { "$ref": "Network" },
    "chainId": { "type": "integer" },
    "rpcChainId": { "type": ["integer", "null"] },
    "headBlock": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "indexedBlock": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "lagBlocks": { "type": ["integer", "null"] },
    "db": { "enum": ["ok", "down"] },
    "demoMode": { "type": "boolean" },
    "deployCommit": { "type": "string" },
    "startBlock": { "$ref": "UInt" },
    "addresses": {
      "type": "object",
      "additionalProperties": false,
      "required": ["contracts", "tokens", "poolId"],
      "properties": {
        "contracts": { "type": "object", "additionalProperties": { "type": ["string", "null"] } },
        "tokens": { "type": "object", "additionalProperties": { "$ref": "Address" } },
        "poolId": { "$ref": "Bytes32" }
      }
    }
  }
}
```

`ok` is true iff `rpcChainId == chainId`, `db == "ok"` and `lagBlocks <= 10`. `/health` always answers 200 with the
reasons visible in the fields (it never 503s). `addresses.tokens` is keyed by symbol.

`GET /deployment` returns the validated `Deployment` object verbatim.

`GET /pool`

```json wrapswap:schema PoolStateResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["block", "timestamp", "poolId", "key", "token0", "token1", "sqrtPriceX96", "tick", "liquidity", "poolPriceX18", "parityPriceX18", "deviationBps", "pegGuardBps", "pegTripped", "lastPegEvent"],
  "properties": {
    "block": { "$ref": "UInt" },
    "timestamp": { "$ref": "UInt" },
    "poolId": { "$ref": "Bytes32" },
    "key": { "$ref": "PoolKey" },
    "token0": { "$ref": "TokenState" },
    "token1": { "$ref": "TokenState" },
    "sqrtPriceX96": { "$ref": "UInt" },
    "tick": { "type": "integer" },
    "liquidity": { "$ref": "UInt" },
    "poolPriceX18": { "$ref": "UInt" },
    "parityPriceX18": { "$ref": "UInt" },
    "deviationBps": { "type": "integer" },
    "pegGuardBps": { "type": "integer" },
    "pegTripped": { "type": "boolean" },
    "lastPegEvent": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["tripped", "deviationBps", "blockNumber", "txHash"],
      "properties": {
        "tripped": { "type": "boolean" },
        "deviationBps": { "type": "integer" },
        "blockNumber": { "$ref": "UInt" },
        "txHash": { "$ref": "Bytes32" }
      }
    }
  }
}
```

`pegTripped` is the live `pegStatus(key).tripped`; `lastPegEvent` is the newest `PegGuardStatus` row.

`GET /inventory`

```json wrapswap:schema InventoryResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["block", "poolId", "tokens", "totalShares", "skewX18", "fee"],
  "properties": {
    "block": { "$ref": "UInt" },
    "poolId": { "$ref": "Bytes32" },
    "tokens": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["symbol", "address", "inventory", "inventoryShares", "feesAccrued"],
        "properties": {
          "symbol": { "type": "string" },
          "address": { "$ref": "Address" },
          "inventory": { "$ref": "UInt" },
          "inventoryShares": { "$ref": "UInt" },
          "feesAccrued": { "$ref": "UInt" }
        }
      }
    },
    "totalShares": { "$ref": "UInt" },
    "skewX18": { "$ref": "Int" },
    "fee": { "$ref": "FeeBreakdown" }
  }
}
```

`tokens` is ordered `[currency0, currency1]`.

`GET /inventory/changes`

```json wrapswap:schema InventoryChangesResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["items", "nextCursor"],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "currency", "actor", "delta", "inventoryAfter", "blockNumber", "timestamp", "txHash", "logIndex"],
        "properties": {
          "kind": { "enum": ["DEPOSIT", "WITHDRAW", "FILL_IN", "FILL_OUT", "FEE_SWEEP"] },
          "currency": { "$ref": "Address" },
          "actor": { "$ref": "Address" },
          "delta": { "$ref": "Int" },
          "inventoryAfter": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
          "blockNumber": { "$ref": "UInt" },
          "timestamp": { "$ref": "UInt" },
          "txHash": { "$ref": "Bytes32" },
          "logIndex": { "type": "integer" }
        }
      }
    },
    "nextCursor": { "type": ["string", "null"] }
  }
}
```

`FEE_SWEEP` rows come from `FeesSwept` (`delta` = −amount of fee claims, `inventoryAfter` null).

`GET /fees`

```json wrapswap:schema FeesResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["block", "timestamp", "poolId", "fee", "maxFeePips", "formula"],
  "properties": {
    "block": { "$ref": "UInt" },
    "timestamp": { "$ref": "UInt" },
    "poolId": { "$ref": "Bytes32" },
    "fee": { "$ref": "FeeBreakdown" },
    "maxFeePips": { "type": "integer" },
    "formula": { "const": "min(200 + ceil(1300*|skew|) + (closed && |skew| grows ? ceil(1500*|postTradeSkew|) : 0), 2500) pips" }
  }
}
```

`GET /quote`

```json wrapswap:schema QuoteResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["block", "poolId", "tokenIn", "tokenOut", "kind", "zeroForOne", "amountSpecified", "fillable", "amountIn", "amountOut", "grossOut", "shares", "feeAmount", "feeToken", "fee"],
  "properties": {
    "block": { "$ref": "UInt" },
    "poolId": { "$ref": "Bytes32" },
    "tokenIn": { "$ref": "Address" },
    "tokenOut": { "$ref": "Address" },
    "kind": { "enum": ["exactIn", "exactOut"] },
    "zeroForOne": { "type": "boolean" },
    "amountSpecified": { "$ref": "Int" },
    "fillable": { "type": "boolean" },
    "amountIn": { "$ref": "UInt" },
    "amountOut": { "$ref": "UInt" },
    "grossOut": { "$ref": "UInt" },
    "shares": { "$ref": "UInt" },
    "feeAmount": { "$ref": "UInt" },
    "feeToken": { "$ref": "Address" },
    "fee": { "$ref": "FeeBreakdown" }
  }
}
```

The quote is `ParityHook.quote(key, zeroForOne, amountSpecified)` verbatim (`amountSpecified` negative for exactIn).

`GET /route`

```json wrapswap:schema RouteResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["route", "reason", "block", "swapper", "eligibility", "quote", "fallThrough", "dark"],
  "properties": {
    "route": { "$ref": "Route" },
    "reason": { "type": ["string", "null"] },
    "block": { "$ref": "UInt" },
    "swapper": { "$ref": "Address" },
    "eligibility": { "$ref": "EligibilityResponse" },
    "quote": { "anyOf": [{ "$ref": "QuoteResponse" }, { "type": "null" }] },
    "fallThrough": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["amountIn", "amountOut", "feePips"],
      "properties": {
        "amountIn": { "$ref": "UInt" },
        "amountOut": { "$ref": "UInt" },
        "feePips": { "type": "integer" }
      }
    },
    "dark": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["batchId", "phase", "phaseEndsBlock", "oracleMidX18", "sellBase"],
      "properties": {
        "batchId": { "$ref": "UInt" },
        "phase": { "$ref": "BatchPhase" },
        "phaseEndsBlock": { "$ref": "UInt" },
        "oracleMidX18": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
        "sellBase": { "type": "boolean" }
      }
    }
  }
}
```

Route decision, first match wins:

1. `eligibility.check(swapper, attestationUid ?? 0)` false ⇒ `BLOCKED-ELIGIBILITY` (`reason` = reason name).
2. Either adapter unhealthy ⇒ `BLOCKED-PEG` (`reason` = `"ADAPTER_UNHEALTHY"`).
3. `quote.fillable` ⇒ `PARITY`.
4. Simulate the swap through `V4Quoter` (`quoteExactInputSingle`/`quoteExactOutputSingle`, hookData v1 naming
   `swapper`). Success ⇒ `FALL-THROUGH` with `fallThrough` filled. Revert with `PegGuardTripped` or insufficient
   liquidity ⇒ `DARK` when `allowDark` (fill `dark`; the residual of a dark order routes back to the ParityHook pool),
   else `BLOCKED-PEG` (`reason` = `"PEG_GUARD"`).

`quote` is filled whenever step 3 was reached. Every `/route` call inserts one `eligibility_checks` row.

`GET /nyse`

```json wrapswap:schema NyseResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["open", "block", "chainTimestamp", "nextTransition", "nextState", "secondsUntilTransition", "closedFeePips", "source"],
  "properties": {
    "open": { "type": "boolean" },
    "block": { "$ref": "UInt" },
    "chainTimestamp": { "$ref": "UInt" },
    "nextTransition": { "$ref": "UInt" },
    "nextState": { "enum": ["OPEN", "CLOSED"] },
    "secondsUntilTransition": { "type": "integer" },
    "closedFeePips": { "type": "integer" },
    "source": { "const": "chain" }
  }
}
```

`GET /batches/current`

```json wrapswap:schema CurrentBatchResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["batchId", "phase", "phaseEndsBlock", "blockNumber", "batchOrigin", "participants", "oracle"],
  "properties": {
    "batchId": { "$ref": "UInt" },
    "phase": { "$ref": "BatchPhase" },
    "phaseEndsBlock": { "$ref": "UInt" },
    "blockNumber": { "$ref": "UInt" },
    "batchOrigin": { "$ref": "UInt" },
    "participants": { "type": "integer" },
    "oracle": {
      "type": "object",
      "additionalProperties": false,
      "required": ["midX18", "updatedAt", "stale"],
      "properties": {
        "midX18": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
        "updatedAt": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
        "stale": { "type": "boolean" }
      }
    }
  }
}
```

`GET /batches`, `GET /batches/:batchId`, `GET /orders/:address`, `GET /fills`

```json wrapswap:schema BatchSummary
{
  "type": "object",
  "additionalProperties": false,
  "required": ["batchId", "settled", "midX18", "crossedBase", "crossedQuote", "residualBaseIn", "residualQuoteIn", "participants", "settledTx", "settledBlock", "settledAt"],
  "properties": {
    "batchId": { "$ref": "UInt" },
    "settled": { "type": "boolean" },
    "midX18": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "crossedBase": { "$ref": "UInt" },
    "crossedQuote": { "$ref": "UInt" },
    "residualBaseIn": { "$ref": "UInt" },
    "residualQuoteIn": { "$ref": "UInt" },
    "participants": { "type": "integer" },
    "settledTx": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{64}$" },
    "settledBlock": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "settledAt": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" }
  }
}
```

```json wrapswap:schema OrderView
{
  "type": "object",
  "additionalProperties": false,
  "required": ["batchId", "trader", "commitHash", "lockToken", "locked", "committedTx", "revealed", "valid", "rejectReason", "sellBase", "amountIn", "limitPriceX18", "routeResidual", "forfeited"],
  "properties": {
    "batchId": { "$ref": "UInt" },
    "trader": { "$ref": "Address" },
    "commitHash": { "$ref": "Bytes32" },
    "lockToken": { "$ref": "Address" },
    "locked": { "$ref": "UInt" },
    "committedTx": { "$ref": "Bytes32" },
    "revealed": { "type": "boolean" },
    "valid": { "type": "boolean" },
    "rejectReason": { "enum": [null, "WRONG_LOCK_TOKEN", "INSUFFICIENT_LOCK", "ZERO_AMOUNT", "ZERO_LIMIT"] },
    "sellBase": { "type": ["boolean", "null"] },
    "amountIn": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "limitPriceX18": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "routeResidual": { "type": ["boolean", "null"] },
    "forfeited": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" }
  }
}
```

```json wrapswap:schema FillView
{
  "type": "object",
  "additionalProperties": false,
  "required": ["kind", "account", "tokenIn", "tokenOut", "amountIn", "amountOut", "feeAmount", "feePips", "shares", "batchId", "poolId", "blockNumber", "timestamp", "txHash", "logIndex"],
  "properties": {
    "kind": { "$ref": "FillKind" },
    "account": { "$ref": "Address" },
    "tokenIn": { "$ref": "Address" },
    "tokenOut": { "$ref": "Address" },
    "amountIn": { "$ref": "UInt" },
    "amountOut": { "$ref": "UInt" },
    "feeAmount": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "feePips": { "type": ["integer", "null"] },
    "shares": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "batchId": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "poolId": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{64}$" },
    "blockNumber": { "$ref": "UInt" },
    "timestamp": { "$ref": "UInt" },
    "txHash": { "$ref": "Bytes32" },
    "logIndex": { "type": "integer" }
  }
}
```

```json wrapswap:schema BatchListResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["items", "nextCursor"],
  "properties": {
    "items": { "type": "array", "items": { "$ref": "BatchSummary" } },
    "nextCursor": { "type": ["string", "null"] }
  }
}
```

```json wrapswap:schema BatchDetailResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["batch", "orders", "fills", "skippedResiduals"],
  "properties": {
    "batch": { "$ref": "BatchSummary" },
    "orders": { "type": "array", "items": { "$ref": "OrderView" } },
    "fills": { "type": "array", "items": { "$ref": "FillView" } },
    "skippedResiduals": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["trader", "reason", "txHash"],
        "properties": {
          "trader": { "$ref": "Address" },
          "reason": { "type": "string" },
          "txHash": { "$ref": "Bytes32" }
        }
      }
    }
  }
}
```

```json wrapswap:schema OrderListResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["items", "nextCursor"],
  "properties": {
    "items": { "type": "array", "items": { "$ref": "OrderView" } },
    "nextCursor": { "type": ["string", "null"] }
  }
}
```

```json wrapswap:schema FillListResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["items", "nextCursor"],
  "properties": {
    "items": { "type": "array", "items": { "$ref": "FillView" } },
    "nextCursor": { "type": ["string", "null"] }
  }
}
```

A batch that has commits but no `BatchSettled` yet is listed with `settled: false` and zero crossed/residual amounts.
`/batches/:batchId` for an id with no commits and no settlement ⇒ 404. `FillView.account` is the trader/swapper
(resolved, not the router). A dark residual appears once, as `DARK-RESIDUAL`; its ParityHook `InventoryFill` or
`FallThrough` in the same tx is folded into it (`feePips`, `shares` from the ParityHook event).

`GET /eligibility/:address`

```json wrapswap:schema EligibilityResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["address", "eligible", "reasonCode", "reason", "demoMode", "attestationUid", "block"],
  "properties": {
    "address": { "$ref": "Address" },
    "eligible": { "type": "boolean" },
    "reasonCode": { "type": "integer" },
    "reason": { "$ref": "EligibilityReason" },
    "demoMode": { "type": "boolean" },
    "attestationUid": { "type": ["string", "null"], "pattern": "^0x[0-9a-fA-F]{64}$" },
    "block": { "$ref": "UInt" }
  }
}
```

Crank `GET http://127.0.0.1:${CRANK_HEALTH_PORT}/status` (§7):

```json wrapswap:schema CrankStatusResponse
{
  "type": "object",
  "additionalProperties": false,
  "required": ["ok", "network", "chainId", "signer", "lastBlock", "lastSettle", "lastOraclePush", "lastPegCheck", "lastError"],
  "properties": {
    "ok": { "type": "boolean" },
    "network": { "$ref": "Network" },
    "chainId": { "type": "integer" },
    "signer": { "$ref": "Address" },
    "lastBlock": { "type": ["string", "null"], "pattern": "^(0|[1-9][0-9]*)$" },
    "lastSettle": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["batchId", "txHash"],
      "properties": { "batchId": { "$ref": "UInt" }, "txHash": { "$ref": "Bytes32" } }
    },
    "lastOraclePush": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["midX18", "txHash"],
      "properties": { "midX18": { "$ref": "UInt" }, "txHash": { "$ref": "Bytes32" } }
    },
    "lastPegCheck": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["tripped", "txHash"],
      "properties": { "tripped": { "type": "boolean" }, "txHash": { "$ref": "Bytes32" } }
    },
    "lastError": { "type": ["string", "null"] }
  }
}
```

## 6. Database schema (Postgres 16)

Owned by the backend lane as `api/src/db/schema.sql`, implementing exactly this DDL. Reorg model: every event row
references the `blocks` row (by hash) it was read from, with `ON DELETE CASCADE`. On a reorg the indexer, in one
transaction, finds the deepest common ancestor (max depth 64), deletes `blocks` above it (cascading every event row)
and rewinds `indexer_cursor`; derived state is views only, so nothing else needs repair. Logs with `removed: true` are
never inserted. getLogs windows ≤ 2000 blocks; the cursor advances only after a window commits.

```sql
CREATE TABLE indexer_deployments (
  chain_id        INTEGER PRIMARY KEY,
  network         TEXT NOT NULL CHECK (network IN ('anvil', 'unichain-sepolia')),
  identity        TEXT NOT NULL,             -- keccak256(deployCommit|startBlock|parityHook|darkCrossHook)
  deploy_commit   TEXT NOT NULL,
  start_block     NUMERIC(78,0) NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indexer_cursor (
  chain_id        INTEGER PRIMARY KEY REFERENCES indexer_deployments(chain_id) ON DELETE CASCADE,
  last_block      NUMERIC(78,0) NOT NULL,
  last_block_hash TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE blocks (
  chain_id        INTEGER NOT NULL,
  block_number    NUMERIC(78,0) NOT NULL,
  block_hash      TEXT NOT NULL,
  parent_hash     TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, block_number),
  UNIQUE (chain_id, block_hash)
);

-- Every event table below starts with these reorg/provenance columns (spelled out per table):
--   chain_id, block_number, block_hash, block_timestamp, tx_hash, log_index, contract
--   PRIMARY KEY (chain_id, tx_hash, log_index)
--   FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE

CREATE TABLE raw_logs (
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  topic0 TEXT NOT NULL, event_name TEXT NOT NULL, args JSONB NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX raw_logs_block ON raw_logs (chain_id, block_number);
CREATE INDEX raw_logs_event ON raw_logs (chain_id, event_name, block_number);

-- ParityHook
CREATE TABLE parity_pools (                       -- PoolRegistered
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, currency0 TEXT NOT NULL, currency1 TEXT NOT NULL, underlying TEXT NOT NULL,
  tick_spacing INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX parity_pools_id ON parity_pools (chain_id, pool_id);

CREATE TABLE parity_fee_quotes (                  -- FeeQuoted
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, total_pips INTEGER NOT NULL, base_pips INTEGER NOT NULL, skew_pips INTEGER NOT NULL,
  closed_pips INTEGER NOT NULL, skew_x18 NUMERIC(78,0) NOT NULL, market_open BOOLEAN NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_fee_quotes_pool ON parity_fee_quotes (chain_id, pool_id, block_number DESC, log_index DESC);

CREATE TABLE parity_fills (                       -- InventoryFill
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, swapper TEXT NOT NULL, sender TEXT NOT NULL, zero_for_one BOOLEAN NOT NULL,
  exact_input BOOLEAN NOT NULL, token_in TEXT NOT NULL, token_out TEXT NOT NULL,
  amount_in NUMERIC(78,0) NOT NULL, amount_out NUMERIC(78,0) NOT NULL, shares NUMERIC(78,0) NOT NULL,
  fee_amount NUMERIC(78,0) NOT NULL, fee_pips INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_fills_swapper ON parity_fills (chain_id, swapper, block_number DESC, log_index DESC);
CREATE INDEX parity_fills_tx ON parity_fills (chain_id, tx_hash);

CREATE TABLE parity_fallthroughs (                -- FallThrough
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, swapper TEXT NOT NULL, sender TEXT NOT NULL, zero_for_one BOOLEAN NOT NULL,
  reason SMALLINT NOT NULL, amount0 NUMERIC(78,0) NOT NULL, amount1 NUMERIC(78,0) NOT NULL,
  fee_pips INTEGER NOT NULL, deviation_bps_after NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_fallthroughs_swapper ON parity_fallthroughs (chain_id, swapper, block_number DESC, log_index DESC);
CREATE INDEX parity_fallthroughs_tx ON parity_fallthroughs (chain_id, tx_hash);

CREATE TABLE parity_inventory_changes (           -- InventoryChanged
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  currency TEXT NOT NULL, actor TEXT NOT NULL, reason SMALLINT NOT NULL CHECK (reason BETWEEN 0 AND 3),
  delta NUMERIC(78,0) NOT NULL, inventory_after NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_inventory_changes_currency ON parity_inventory_changes (chain_id, currency, block_number DESC, log_index DESC);

CREATE TABLE parity_fee_sweeps (                  -- FeesSwept
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  currency TEXT NOT NULL, recipient TEXT NOT NULL, amount NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);

CREATE TABLE parity_peg_status (                  -- PegGuardStatus
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  pool_id TEXT NOT NULL, tripped BOOLEAN NOT NULL, pool_price_x18 NUMERIC(78,0) NOT NULL,
  parity_price_x18 NUMERIC(78,0) NOT NULL, deviation_bps NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX parity_peg_status_pool ON parity_peg_status (chain_id, pool_id, block_number DESC, log_index DESC);

-- DarkCrossHook
CREATE TABLE dark_escrow_events (                 -- Funded, Withdrawn
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('FUNDED', 'WITHDRAWN')), account TEXT NOT NULL, token TEXT NOT NULL,
  amount NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_escrow_events_account ON dark_escrow_events (chain_id, account, block_number DESC);

CREATE TABLE dark_commits (                       -- Committed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, commit_hash TEXT NOT NULL, lock_token TEXT NOT NULL,
  locked NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_commits_order ON dark_commits (chain_id, batch_id, trader);
CREATE INDEX dark_commits_trader ON dark_commits (chain_id, trader, batch_id DESC);

CREATE TABLE dark_reveals (                       -- Revealed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, sell_base BOOLEAN NOT NULL, amount_in NUMERIC(78,0) NOT NULL,
  limit_price_x18 NUMERIC(78,0) NOT NULL, route_residual BOOLEAN NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_reveals_order ON dark_reveals (chain_id, batch_id, trader);

CREATE TABLE dark_reveal_rejections (             -- RevealRejected
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, reason SMALLINT NOT NULL CHECK (reason BETWEEN 1 AND 4),
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_reveal_rejections_order ON dark_reveal_rejections (chain_id, batch_id, trader);

CREATE TABLE dark_crosses (                       -- Crossed
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, sell_base BOOLEAN NOT NULL, amount_in NUMERIC(78,0) NOT NULL,
  amount_out NUMERIC(78,0) NOT NULL, fee_amount NUMERIC(78,0) NOT NULL, mid_x18 NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_crosses_batch ON dark_crosses (chain_id, batch_id);
CREATE INDEX dark_crosses_trader ON dark_crosses (chain_id, trader, block_number DESC, log_index DESC);

CREATE TABLE dark_residuals (                     -- ResidualRouted
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, pool_id TEXT NOT NULL, sell_base BOOLEAN NOT NULL,
  amount_in NUMERIC(78,0) NOT NULL, amount_out NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_residuals_batch ON dark_residuals (chain_id, batch_id);
CREATE INDEX dark_residuals_trader ON dark_residuals (chain_id, trader, block_number DESC, log_index DESC);

CREATE TABLE dark_residual_skips (                -- ResidualSkipped
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, reason TEXT NOT NULL,   -- hex revert data
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_residual_skips_batch ON dark_residual_skips (chain_id, batch_id);

CREATE TABLE dark_forfeits (                      -- Forfeited
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, trader TEXT NOT NULL, token TEXT NOT NULL, amount NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX dark_forfeits_batch ON dark_forfeits (chain_id, batch_id, trader);

CREATE TABLE dark_batches (                       -- BatchSettled
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  batch_id NUMERIC(78,0) NOT NULL, mid_x18 NUMERIC(78,0) NOT NULL, mid_updated_at NUMERIC(78,0) NOT NULL,
  crossed_base NUMERIC(78,0) NOT NULL, crossed_quote NUMERIC(78,0) NOT NULL,
  residual_base_in NUMERIC(78,0) NOT NULL, residual_quote_in NUMERIC(78,0) NOT NULL, participants INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE UNIQUE INDEX dark_batches_id ON dark_batches (chain_id, batch_id);

-- Eligibility, oracle, ratios, admin
CREATE TABLE eligibility_denials (                -- EligibilityDenied (caller must be a deployment hook)
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  account TEXT NOT NULL, caller TEXT NOT NULL, reason SMALLINT NOT NULL, attestation_uid TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX eligibility_denials_account ON eligibility_denials (chain_id, account, block_number DESC);

CREATE TABLE demo_mode_changes (                  -- DemoModeSet
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  enabled BOOLEAN NOT NULL, set_by TEXT NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX demo_mode_changes_latest ON demo_mode_changes (chain_id, block_number DESC, log_index DESC);

CREATE TABLE oracle_mids (                        -- MidUpdated
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  base TEXT NOT NULL, quote TEXT NOT NULL, mid_x18 NUMERIC(78,0) NOT NULL, updated_at NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX oracle_mids_pair ON oracle_mids (chain_id, base, quote, block_number DESC);

CREATE TABLE ratio_updates (                      -- RatioUpdated (adapter), MultiplierUpdated (mock token)
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ADAPTER', 'TOKEN')), token TEXT NOT NULL,
  old_value NUMERIC(78,0) NOT NULL, new_value NUMERIC(78,0) NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX ratio_updates_token ON ratio_updates (chain_id, token, block_number DESC);

CREATE TABLE registry_events (                    -- IssuerAdded, IssuerRemoved, IssuerPaused
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ADDED', 'REMOVED', 'PAUSED')), token TEXT NOT NULL, adapter TEXT,
  underlying TEXT, paused BOOLEAN,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX registry_events_token ON registry_events (chain_id, token, block_number DESC);

CREATE TABLE admin_events (  -- KeeperSet, TrustedRouterSet, PusherSet, HolidaySet, EarlyCloseSet, AdapterPaused, TransfersPaused
  chain_id INTEGER NOT NULL, block_number NUMERIC(78,0) NOT NULL, block_hash TEXT NOT NULL,
  block_timestamp NUMERIC(78,0) NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, contract TEXT NOT NULL,
  event_name TEXT NOT NULL, args JSONB NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, block_hash) REFERENCES blocks(chain_id, block_hash) ON DELETE CASCADE
);
CREATE INDEX admin_events_name ON admin_events (chain_id, event_name, block_number DESC);

-- Written by the API (not events; no reorg linkage)
CREATE TABLE eligibility_checks (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL, account TEXT NOT NULL, attestation_uid TEXT, eligible BOOLEAN NOT NULL,
  reason SMALLINT NOT NULL, demo_mode BOOLEAN NOT NULL, block_number NUMERIC(78,0) NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('route', 'eligibility')), checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eligibility_checks_account ON eligibility_checks (chain_id, account, checked_at DESC);

-- Derived state: views only
CREATE VIEW v_dark_orders AS
SELECT c.chain_id, c.batch_id, c.trader, c.commit_hash, c.lock_token, c.locked, c.tx_hash AS committed_tx,
       c.block_number, c.log_index,
       (r.trader IS NOT NULL OR x.trader IS NOT NULL) AS revealed, (r.trader IS NOT NULL) AS valid,
       x.reason AS reject_reason, r.sell_base, r.amount_in, r.limit_price_x18, r.route_residual,
       f.amount AS forfeited
FROM dark_commits c
LEFT JOIN dark_reveals r ON r.chain_id = c.chain_id AND r.batch_id = c.batch_id AND r.trader = c.trader
LEFT JOIN dark_reveal_rejections x ON x.chain_id = c.chain_id AND x.batch_id = c.batch_id AND x.trader = c.trader
LEFT JOIN dark_forfeits f ON f.chain_id = c.chain_id AND f.batch_id = c.batch_id AND f.trader = c.trader;

CREATE VIEW v_dark_batches AS
SELECT ids.chain_id, ids.batch_id, (b.batch_id IS NOT NULL) AS settled, b.mid_x18,
       COALESCE(b.crossed_base, 0) AS crossed_base, COALESCE(b.crossed_quote, 0) AS crossed_quote,
       COALESCE(b.residual_base_in, 0) AS residual_base_in, COALESCE(b.residual_quote_in, 0) AS residual_quote_in,
       COALESCE(b.participants, (SELECT count(*) FROM dark_commits c WHERE c.chain_id = ids.chain_id AND c.batch_id = ids.batch_id))::INTEGER AS participants,
       b.tx_hash AS settled_tx, b.block_number AS settled_block, b.block_timestamp AS settled_at
FROM (SELECT chain_id, batch_id FROM dark_commits UNION SELECT chain_id, batch_id FROM dark_batches) ids
LEFT JOIN dark_batches b ON b.chain_id = ids.chain_id AND b.batch_id = ids.batch_id;

CREATE VIEW v_fills AS
SELECT p.chain_id, 'PARITY'::TEXT AS kind, p.swapper AS account, p.token_in, p.token_out, p.amount_in, p.amount_out,
       p.fee_amount, p.fee_pips, p.shares, NULL::NUMERIC AS batch_id, p.pool_id, p.block_number, p.block_timestamp,
       p.tx_hash, p.log_index
FROM parity_fills p
WHERE NOT EXISTS (SELECT 1 FROM dark_residuals d WHERE d.chain_id = p.chain_id AND d.tx_hash = p.tx_hash AND d.trader = p.swapper)
UNION ALL
SELECT t.chain_id, 'FALL-THROUGH', t.swapper,
       CASE WHEN t.zero_for_one THEN pp.currency0 ELSE pp.currency1 END,
       CASE WHEN t.zero_for_one THEN pp.currency1 ELSE pp.currency0 END,
       ABS(CASE WHEN t.zero_for_one THEN t.amount0 ELSE t.amount1 END),
       ABS(CASE WHEN t.zero_for_one THEN t.amount1 ELSE t.amount0 END),
       NULL, t.fee_pips, NULL, NULL, t.pool_id, t.block_number, t.block_timestamp, t.tx_hash, t.log_index
FROM parity_fallthroughs t JOIN parity_pools pp ON pp.chain_id = t.chain_id AND pp.pool_id = t.pool_id
WHERE NOT EXISTS (SELECT 1 FROM dark_residuals d WHERE d.chain_id = t.chain_id AND d.tx_hash = t.tx_hash AND d.trader = t.swapper)
UNION ALL
SELECT x.chain_id, 'DARK-CROSS', x.trader,
       CASE WHEN x.sell_base THEN (SELECT base FROM v_dark_pair) ELSE (SELECT quote FROM v_dark_pair) END,
       CASE WHEN x.sell_base THEN (SELECT quote FROM v_dark_pair) ELSE (SELECT base FROM v_dark_pair) END,
       x.amount_in, x.amount_out, x.fee_amount, 500, NULL, x.batch_id, NULL, x.block_number, x.block_timestamp,
       x.tx_hash, x.log_index
FROM dark_crosses x
UNION ALL
SELECT d.chain_id, 'DARK-RESIDUAL', d.trader,
       CASE WHEN d.sell_base THEN (SELECT base FROM v_dark_pair) ELSE (SELECT quote FROM v_dark_pair) END,
       CASE WHEN d.sell_base THEN (SELECT quote FROM v_dark_pair) ELSE (SELECT base FROM v_dark_pair) END,
       d.amount_in, d.amount_out, pf.fee_amount, COALESCE(pf.fee_pips, ft.fee_pips), pf.shares, d.batch_id, d.pool_id,
       d.block_number, d.block_timestamp, d.tx_hash, d.log_index
FROM dark_residuals d
LEFT JOIN parity_fills pf ON pf.chain_id = d.chain_id AND pf.tx_hash = d.tx_hash AND pf.swapper = d.trader
     AND pf.log_index = (SELECT max(log_index) FROM parity_fills q WHERE q.chain_id = d.chain_id AND q.tx_hash = d.tx_hash AND q.swapper = d.trader AND q.log_index < d.log_index)
LEFT JOIN parity_fallthroughs ft ON ft.chain_id = d.chain_id AND ft.tx_hash = d.tx_hash AND ft.swapper = d.trader
     AND ft.log_index = (SELECT max(log_index) FROM parity_fallthroughs q WHERE q.chain_id = d.chain_id AND q.tx_hash = d.tx_hash AND q.swapper = d.trader AND q.log_index < d.log_index);
```

`v_dark_pair(base TEXT, quote TEXT)` is a one-row view the backend creates at migration from the deployment JSON
(`dark.baseToken`, `dark.quoteToken`); it is created before `v_fills`. The `DARK-CROSS` fee is the constant
`CROSS_FEE_PIPS` (500). All addresses are stored lowercase; the API checksums on output.

Coverage: every §2 event lands in exactly one table (`raw_logs` additionally journals all of them):
`PoolRegistered`→`parity_pools`; `FeeQuoted`→`parity_fee_quotes`; `InventoryFill`→`parity_fills`;
`FallThrough`→`parity_fallthroughs`; `InventoryChanged`→`parity_inventory_changes`; `FeesSwept`→`parity_fee_sweeps`;
`PegGuardStatus`→`parity_peg_status`; `Funded`/`Withdrawn`→`dark_escrow_events`; `Committed`→`dark_commits`;
`Revealed`→`dark_reveals`; `RevealRejected`→`dark_reveal_rejections`; `Crossed`→`dark_crosses`;
`ResidualRouted`→`dark_residuals`; `ResidualSkipped`→`dark_residual_skips`; `Forfeited`→`dark_forfeits`;
`BatchSettled`→`dark_batches`; `EligibilityDenied`→`eligibility_denials`; `DemoModeSet`→`demo_mode_changes`;
`MidUpdated`→`oracle_mids`; `RatioUpdated`/`MultiplierUpdated`→`ratio_updates`;
`IssuerAdded`/`IssuerRemoved`/`IssuerPaused`→`registry_events`; `KeeperSet`/`TrustedRouterSet`/`PusherSet`/
`HolidaySet`/`EarlyCloseSet`/`AdapterPaused`/`TransfersPaused`→`admin_events`.

## 7. Crank contract

One process (`services/crank`), signer = `DEMO_MNEMONIC` index 4 (anvil: `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65`;
Sepolia: `CRANK_PK` overrides the mnemonic when set). It is the oracle pusher (`setPusher`) and needs no other role.
It never commits, reveals, deposits, withdraws, mints, warps time, or holds user funds.

Loop: on every new block (poll 1 s; timestamps from the block, never the host clock):

1. **Oracle push** (only when `deployment.mockOracle`). Target `mid = floor(sptBase · 1e18 / sptQuote)` from the two
   adapters' `sharesPerToken()`. Call `setMid(base, quote, mid)` when (a) `getMid` reverts `NoPrice`, (b) stored
   `midX18 != mid`, (c) `block.timestamp − updatedAt ≥ 300`, or (d) a settle is about to be sent and
   `block.timestamp − updatedAt ≥ ORACLE_MAX_AGE − 60`. Never push while an earlier push is unconfirmed.
2. **Settle.** Candidates: every `id` in `[max(0, current − 16), current − 1]`, plus `current` when phase is `SETTLE`.
   For each ascending: skip if `settled(id)` or `participants(id).length == 0`; run step 1(d); `eth_call` `settle(id)`;
   a simulated `AlreadySettled` is success-noop; any other simulated revert is recorded in `lastError` and retried next
   block. Send, wait for the receipt, then continue.
3. **Peg check.** Every 10 blocks, and in any block containing a Swap on the pool: read `pegStatus(key).tripped`; if it
   differs from `pegTripped(poolId)`, send `checkPeg(key)` (emits `PegGuardStatus`).

Idempotency: every action is recomputed from chain state; the contract rejects duplicates (`AlreadySettled`, `checkPeg`
no-op on equal state, `setMid` with an equal value is harmless). At most one transaction in flight; the next action
waits for its receipt. Gas-price bump 20 % per retry, capped at 5 retries per action.

Restart safety: no local state. At start, wait until the signer's `pending` nonce equals its `latest` nonce (max 60 s,
then replace the stuck nonce with a 0-value self-transfer at +20 % gas), then resume the loop; step 2's 16-batch
look-back recovers anything missed while down.

Health: `GET http://127.0.0.1:${CRANK_HEALTH_PORT}/status` → `CrankStatusResponse`; `ok` is false while `lastError`
is set from the latest iteration. Logs are one JSON object per line with `event` ∈
`oracle_push | settled | peg_check | error`.

## 8. Ownership map and change requests

| Lane | Writes only |
|---|---|
| contracts | `contracts/src/**` except `contracts/src/interfaces/`, `contracts/test/`, `contracts/script/Deploy.s.sol`, `decisions/contracts.md` |
| backend | `api/`, `services/` |
| web | `web/` |
| submission | `submission/`, `FEEDBACK.md` |
| integration | `contracts/script/SeedDemo.s.sol` and seed data, `docker-compose.yml`, `scripts/dev/`, `e2e/`, `INTEGRATION.md` |
| deployment | `deployments/unichain-sepolia.json`, chain config, verification, `tools/gen-integration-table`, README integration table, `docker-compose.prod.yml`, hosting config, production env for web/api/crank, `DECISIONS.md` appends |
| interfaces | `INTERFACES.md`, `contracts/src/interfaces/`, `packages/types/` |

Shared TypeScript package: directory `packages/types`, package name `@wrapswap/types`, workspace member via
`pnpm-workspace.yaml` (`packages/*`). The root package (which contains `api/`, `services/`, `web/`) depends on it as
`"@wrapswap/types": "workspace:*"`; a lane that splits into its own package adds the same dependency. Import with
`import { abis, topics, validators, DEMO, parseDeployment } from "@wrapswap/types"`. It builds on `pnpm install`
(`prepare`) and with `make types`, which regenerates `packages/types/src/generated/` from the compiled interfaces and
this file, rebuilds, and verifies §10. Generated files are committed; `make types` on a clean tree yields no diff.

Change-request protocol: a parallel lane that needs an interface change writes only
`interface-change-requests/<lane>.md` (one `## CR-<n>: <title>` section each: problem, proposed change, affected
sections, blocking yes/no) and codes against the frozen interface meanwhile. Lanes never edit `INTERFACES.md`,
`contracts/src/interfaces/` or `packages/types/`. The interfaces owner resolves CRs in a later freeze.

## 9. Glossary

- **Canonical share**: the internal accounting unit for one share of the underlying security (1e18 = one share).
  Never a token; users never hold it.
- **Parity ratio**: an issuer token's `sharesPerToken` (canonical shares per whole token, from its adapter). The parity
  price of a pair is `spt0 / spt1` whole token1 per whole token0.
- **Skew**: `(inv0Shares − inv1Shares) / (inv0Shares + inv1Shares)` over the ParityHook's inventory of the pool's two
  tokens (fees excluded), in [−1, 1]. Fee uses `|skew|` before the swap.
- **Inventory fill (PARITY)**: a swap settled entirely from ParityHook ERC-6909 inventory at the parity ratio minus the
  dynamic fee, via `beforeSwapReturnDelta`.
- **Fall-through**: a swap the inventory cannot fill completely; the hook returns a zero delta and the swap executes
  against concentrated liquidity on the same pool, subject to the 50 bps peg guard.
- **Lit pool**: the ParityHook v4 pool itself (its concentrated liquidity plus hook inventory), as opposed to the dark
  batch. There is no separate USDC pool.
- **Residual**: the part of a revealed dark order not crossed in its batch; with `routeResidual` it is swapped into the
  lit pool inside the same `unlock` as settlement.
- **Peg guard**: post-swap check that the pool price is within 50 bps of the parity price; trips revert the swap.

## 10. Canonical demo narrative

Fixed values; `packages/types` exports them as `DEMO` and `make types` recomputes every derived number with
`packages/types/src/canonical.ts` and fails on any mismatch. Base token of the dark pair = `mcbAAPL`, quote =
`mAAPLx`. Skews below are stated as `(mcbAAPL − mAAPLx)/(sum)`; the on-chain `skewX18` has this sign when mcbAAPL is
`currency0` and the opposite sign otherwise. The fee depends only on `|skew|`.

### Shared values

- Tokens: `mcbAAPL` 6 decimals, `sharesPerToken = 1.0125e18` (B20 multiplier 1.0125); `mAAPLx` 18 decimals,
  `sharesPerToken = 1e18`. Parity: 1 mcbAAPL = 1.0125 shares = 1.0125 mAAPLx; `parityMidX18 = 1012500000000000000`.
- Pool: `tickSpacing = 10`, initialised at parity. If mcbAAPL is currency0: price(raw1/raw0) = 1.0125e12,
  `sqrtPriceX96 = 79721800701433069633245772272326702`, tick 276448. If mAAPLx is currency0:
  `sqrtPriceX96 = 78737580939686982353822`, tick −276449. (`sqrtPriceX96 = isqrt(floor(num · 2^192 / den))`.)
- Accounts (`DEMO_MNEMONIC`, anvil default mnemonic locally): index 0 deployer/owner/keeper/treasury/LP;
  1 demo wallet; 2 counterparty A; 3 counterparty B; 4 crank.
- Starting wallet balances: demo 500 mcbAAPL + 500 mAAPLx; A 200 mcbAAPL; B 200 mAAPLx.
- Hook inventory (deposited by index 0): 8,000 mcbAAPL (8,000,000,000 raw = 8,100 shares) and 12,150 mAAPLx
  (12,150e18 raw = 12,150 shares). Total 20,250 shares. Skew₀ = (8,100 − 12,150)/20,250 = **−0.2** → skewPips =
  ceil(1300 · 4,050/20,250) = ceil(260) = 260.
- LP position for fall-through (index 0 via `modifyLiquidityRouter`): up to 1,000 mcbAAPL and 1,012.5 mAAPLx, ticks
  [276320, 276570] (mcbAAPL currency0) or [−276570, −276320] (mAAPLx currency0): parity tick ±120 rounded outward to
  spacing 10.
- Step 1, parity fill: demo wallet swaps exact-input 100 mcbAAPL → mAAPLx (`amountSpecified = −100000000`).
  shares = floor(100,000,000 · 1.0125e18 / 1e6) = 101.25e18; grossOut = floor(101.25e18 · 1e18 / 1e18) = 101.25e18 mAAPLx
  raw. Inventory after: mcbAAPL 8,100 (8,201.25 shares), mAAPLx 12,048.75 (12,048.75 shares). Skew₁ =
  −3,847.5/20,250 = **−0.19** → next skewPips = ceil(1300 · 0.19) = 247.
- Step 2, dark batch (oracle mid pushed by the crank = parity 1.0125e18):
  A commits+reveals `sellBase=true, amountIn=60 mcbAAPL (60000000), limit=1.0100e18, routeResidual=true` (locks 60 mcbAAPL);
  B commits+reveals `sellBase=false, amountIn=50.625 mAAPLx (50625000000000000000), limit=1.0150e18, routeResidual=false`.
  Both limits pass (1.0125 ≥ 1.0100; 1.0125 ≤ 1.0150). QasBase = floor(50.625e18 · 1e18 · 1e6 / (1.0125e18 · 1e18)) =
  50,000,000; crossedBase = min(60,000,000, 50,000,000) = 50,000,000 (50 mcbAAPL); crossedQuote =
  floor(50,000,000 · 1.0125e18 · 1e18 / (1e18 · 1e6)) = 50.625e18.
  Cross fees (500 pips, ceil): A receives 50.625e18 − 25,312,500,000,000,000 = 50,599,687,500,000,000,000 mAAPLx;
  B receives 50,000,000 − 25,000 = 49,975,000 mcbAAPL. Treasury: 25,312,500,000,000,000 mAAPLx + 25,000 mcbAAPL.
  Residual: A's 10 mcbAAPL (10,000,000) routed exact-input into the ParityHook pool; shares = grossOut = 10.125e18;
  minOut = floor(10,000,000 · 1.01e18 · 1e18 / (1e18 · 1e6)) = 10.1e18. Inventory after: mcbAAPL 8,110 (8,211.375 shares),
  mAAPLx 12,038.625. Skew₂ = −3,827.25/20,250 = **−0.189**.

### Variant ANVIL (video, NYSE OPEN)

Warp the next block to `1790692200` (Tue 2026-09-29 14:30:00 UTC = 10:30 EDT, a regular session day) before Step 1.

- Step 1 fee: 200 + 260 + 0 = **460 pips = 4.60 bps**; feeAmount = ceil(101.25e18 · 460 / 1e6) =
  **46,575,000,000,000,000 wei** (0.046575 mAAPLx); amountOut = **101,203,425,000,000,000,000** (101.203425 mAAPLx).
- Step 2 residual fee: 200 + 247 = 447 pips = 4.47 bps; feeAmount = ceil(10.125e18 · 447 / 1e6) = 4,525,875,000,000,000;
  amountOut = 10,120,474,125,000,000,000 (≥ minOut 10.1e18).
- End state: demo wallet 400 mcbAAPL + 601.203425 mAAPLx; A escrow 60.720161625 mAAPLx; B escrow 49.975 mcbAAPL;
  hook feesAccrued(mAAPLx) = 51,100,875,000,000,000.

### Variant UNICHAIN-SEPOLIA (live, real clock, NYSE CLOSED Sat 2026-09-26 – Mon 2026-09-28 13:30 UTC)

Real clock; while `isOpen` is false the off-hours premium applies to skew-increasing trades only (next open `1790602200`, Mon 2026-09-28 13:30 UTC). Both §10 trades sell mcbAAPL into a book long mAAPLx (|skew| 0.20 → 0.19 → 0.189), so neither pays it: the numbers equal Variant ANVIL. The trade-less `feeBreakdown` shows closedPips = ceil(1500 · 0.2) = 300 (what a skew-increasing trade would pay).

- Step 1 fee: 200 + 260 + 0 = **460 pips = 4.60 bps**; feeAmount = 46,575,000,000,000,000; amountOut = **101,203,425,000,000,000,000**.
- Step 2 residual fee: 200 + 247 + 0 = 447 pips = 4.47 bps; feeAmount = 4,525,875,000,000,000;
  amountOut = 10,120,474,125,000,000,000 (≥ minOut).
- End state: demo wallet 400 mcbAAPL + 601.203425 mAAPLx; A escrow 60.720161625 mAAPLx; B escrow 49.975 mcbAAPL;
  hook feesAccrued(mAAPLx) = 51,100,875,000,000,000.

Machine-readable constants (source of `DEMO` in `@wrapswap/types`; digit strings become `bigint`):

```json wrapswap:demo
{
  "tokens": {
    "mcbAAPL": { "decimals": 6, "sharesPerTokenX18": "1012500000000000000", "issuer": "coinbase", "darkRole": "base" },
    "mAAPLx": { "decimals": 18, "sharesPerTokenX18": "1000000000000000000", "issuer": "xstocks", "darkRole": "quote" }
  },
  "parityMidX18": "1012500000000000000",
  "pool": {
    "tickSpacing": 10,
    "mcbAAPLIsCurrency0": { "sqrtPriceX96": "79721800701433069633245772272326702", "tick": 276448, "lpTickLower": 276320, "lpTickUpper": 276570 },
    "mAAPLxIsCurrency0": { "sqrtPriceX96": "78737580939686982353822", "tick": -276449, "lpTickLower": -276570, "lpTickUpper": -276320 }
  },
  "accounts": {
    "deployer": { "index": 0, "anvilAddress": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
    "demo": { "index": 1, "anvilAddress": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    "counterpartyA": { "index": 2, "anvilAddress": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
    "counterpartyB": { "index": 3, "anvilAddress": "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
    "crank": { "index": 4, "anvilAddress": "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" }
  },
  "balances": {
    "demo": { "mcbAAPL": "500000000", "mAAPLx": "500000000000000000000" },
    "counterpartyA": { "mcbAAPL": "200000000", "mAAPLx": "0" },
    "counterpartyB": { "mcbAAPL": "0", "mAAPLx": "200000000000000000000" }
  },
  "inventory": { "mcbAAPL": "8000000000", "mAAPLx": "12150000000000000000000" },
  "lp": { "mcbAAPLMax": "1000000000", "mAAPLxMax": "1012500000000000000000" },
  "skewX18": { "initial": "-200000000000000000", "afterParityFill": "-190000000000000000", "afterDarkResidual": "-189000000000000000" },
  "parityFill": {
    "account": "demo", "tokenIn": "mcbAAPL", "tokenOut": "mAAPLx", "kind": "exactIn",
    "amountSpecified": "-100000000", "amountIn": "100000000", "shares": "101250000000000000000",
    "grossOut": "101250000000000000000", "skewPips": 260
  },
  "dark": {
    "oracleMidX18": "1012500000000000000",
    "crossFeePips": 500,
    "orders": {
      "counterpartyA": { "sellBase": true, "lockToken": "mcbAAPL", "amountIn": "60000000", "limitPriceX18": "1010000000000000000", "routeResidual": true },
      "counterpartyB": { "sellBase": false, "lockToken": "mAAPLx", "amountIn": "50625000000000000000", "limitPriceX18": "1015000000000000000", "routeResidual": false }
    },
    "crossedBase": "50000000",
    "crossedQuote": "50625000000000000000",
    "crossFees": { "counterpartyA": "25312500000000000", "counterpartyB": "25000" },
    "crossOut": { "counterpartyA": "50599687500000000000", "counterpartyB": "49975000" },
    "residual": {
      "account": "counterpartyA", "tokenIn": "mcbAAPL", "tokenOut": "mAAPLx", "amountIn": "10000000",
      "shares": "10125000000000000000", "grossOut": "10125000000000000000", "minOut": "10100000000000000000", "skewPips": 247
    }
  },
  "variants": {
    "anvil": {
      "network": "anvil", "chainId": 31337, "warpTimestamp": 1790692200, "marketOpen": true,
      "parityFill": { "feePips": 460, "feeBps": "4.60", "feeAmount": "46575000000000000", "amountOut": "101203425000000000000" },
      "residual": { "feePips": 447, "feeBps": "4.47", "feeAmount": "4525875000000000", "amountOut": "10120474125000000000" },
      "end": { "demoMAAPLx": "601203425000000000000", "demoMcbAAPL": "400000000", "counterpartyAEscrowMAAPLx": "60720161625000000000", "counterpartyBEscrowMcbAAPL": "49975000", "hookFeesMAAPLx": "51100875000000000" }
    },
    "unichain-sepolia": {
      "network": "unichain-sepolia", "chainId": 1301, "warpTimestamp": null, "marketOpen": false, "nextOpen": 1790602200,
      "parityFill": { "feePips": 460, "feeBps": "4.60", "feeAmount": "46575000000000000", "amountOut": "101203425000000000000" },
      "residual": { "feePips": 447, "feeBps": "4.47", "feeAmount": "4525875000000000", "amountOut": "10120474125000000000" },
      "end": { "demoMAAPLx": "601203425000000000000", "demoMcbAAPL": "400000000", "counterpartyAEscrowMAAPLx": "60720161625000000000", "counterpartyBEscrowMcbAAPL": "49975000", "hookFeesMAAPLx": "51100875000000000" }
    }
  }
}
```

## 11. Known breakage (implementations not yet matching; owner lane in brackets)

- `contracts/src/ParityHook.sol` pairs an issuer with `CanonicalStock`, not two issuer tokens; lacks `IParityHook`, pips fee, `quote`, `checkPeg`, eligibility, hookData, and uses a different fee formula [contracts].
- `contracts/src/DarkCrossHook.sol` crosses uAAPL/USDC with a Chainlink/TWAP mid and its own lit pool; must become the `IDarkCrossHook` issuer-pair settlement contract routing residuals into the ParityHook pool [contracts].
- `contracts/src/CanonicalStock.sol` is a user-facing ERC20 (uAAPL); it must not be deployed as a user token (share accounting moves to `CanonicalShares`) [contracts].
- `contracts/src/IssuerRegistry.sol` has no `underlyingOf`, takes an adapter in `pause`/`remove`, non-indexed events [contracts].
- `contracts/src/adapters/*` implement the legacy `IIssuerAdapter` (no `underlying`, `tokenDecimals`, `health`, `ratio`) [contracts].
- `contracts/src/NyseCalendar.sol` lacks `EarlyCloseSet`, custom errors, and indexed `HolidaySet.day` [contracts].
- `contracts/src/mocks/MockB20.sol` / `MockIssuerToken.sol` use 8 decimals / `sharesPerToken` instead of `IMockIssuerToken` (mcbAAPL 6 decimals, `multiplier`) [contracts].
- `contracts/src/mocks/MockOracle.sol` is an AggregatorV3 mock, not `IMockPriceOracle`; no `IEligibility` implementation exists [contracts].
- `contracts/test/ParityVault.t.sol`, `contracts/test/DarkCrossHook.t.sol` test the legacy vault/USDC design; they compile but will not exercise the frozen interfaces [contracts].
- `contracts/script/Deploy.s.sol` writes `deployments/local.json` / `unichain-sepolia.json` in the legacy shape, deploys a USDC lit pool, uses tickSpacing 60 [contracts].
- `contracts/script/Seed.s.sol`, `scripts/seed.sh`, `scripts/demo-flow.ts`, `scripts/deploy-local.sh`, `scripts/export-abis.sh` assume the Base-fork legacy flow on port 8545 [integration].
- `deployments/local.json`, `deployments/abis/*` are legacy artifacts; consumers must move to `deployments/${NETWORK}.json` and `@wrapswap/types` ABIs [integration/backend/web].
- `api/src/chain/client.ts` reads `DEPLOYMENT_FILE`/`deployments/local.json` and `LOCAL_RPC`; must use `NETWORK` [backend].
- `api/src/routes/index.ts` serves the legacy routes (`/parity`, `/backing`, `/hours`, `/oracle`, `/metrics`, …) with `{error:string}` errors [backend].
- `api/src/db/schema.sql` and `api/src/indexer/*` implement the legacy tables without block-hash cascade [backend].
- `services/crank/index.ts` settles only, uses `CRANK_PORT`/deployer key, no oracle push or peg check [backend].
- `web/src/main.tsx`, `web/src/lib/abi.ts` call vault mint/redeem and USDC dark flows; must use `@wrapswap/types` and the §5 routes [web].
- `web/tests/smoke.spec.ts` and `scripts/fresh-clone-check.sh` assert the legacy UI/flow [web/integration].
- `submission/*` and `README.md` describe uAAPL and the USDC dark pool [submission].
- `Makefile` `fork`/`demo` targets bind port 8545 [integration].

## 12. Settled decisions → enforcing interface element

| Settled decision | Enforced by |
|---|---|
| ParityHook runs directly on pools of two real issuer tokens | `IParityHook` natspec + `beforeInitialize` rule (`UnsupportedPool` unless both `IIssuerRegistry.active` with equal `underlyingOf`); `Deployment.pool.key` currencies = the two `tokens`; `DeploymentToken.issuer` ∈ {coinbase, xstocks} |
| uAAPL/CanonicalStock only internal share accounting, never user-facing | `CanonicalShares` library (§1.9) + `IWrapperAdapter.sharesPerToken`; no share token in `Deployment.contracts`/`tokens`; `Quote.shares`, `InventoryFill.shares` are accounting fields only |
| Users only hold real issuer securities | `DeploymentToken` (issuer tokens only); dark escrow `IDarkCrossHook.fund/withdraw` accept only `baseToken`/`quoteToken` (`UnsupportedToken`) |
| Pitch "share-for-share conversion, no USDC leg" | PoolKey = two issuer tokens; `IDarkCrossHook` prices are issuer-token-per-issuer-token (`midX18`), no USDC anywhere in §1/§4 |
| The hook is the settlement engine | `IParityHook` `beforeSwapReturnDelta` inventory fill; `IDarkCrossHook.settle` routes residuals into the ParityHook pool inside one `unlock` (`ResidualRouted`) |
| Eligibility: Coinbase Verified Country (non-US) EAS, demoMode retained | `IEASEligibility` (`schemaUid`, `trustedAttester`, `restrictedCountry = "US"`), `IEligibility.demoMode/setDemoMode` + `DemoModeSet`; hooks revert `NotEligible` / commit returns false |
| Demo video on local anvil with NYSE warped to OPEN | §10 Variant ANVIL `warpTimestamp = 1790692200`; `INyseCalendar.isOpen(block.timestamp)`; API `/nyse` `source: "chain"` |
| Live Unichain Sepolia on real clock; off-hours premium (15 bps · \|post-trade skew\|, skew-increasing trades only) shown as a feature | `IParityHook.OFF_HOURS_MAX_FEE_PIPS = 1500`, `FeeBreakdown.closedPips/marketOpen`, `FeeQuoted`; §10 Variant UNICHAIN-SEPOLIA; `/fees`, `/nyse` |
| PoolKey sorted, DYNAMIC_FEE_FLAG, hooks = ParityHook | `beforeInitialize` `DynamicFeeRequired`; `Deployment.pool.key` rule (fee 8388608, hooks = parityHook) |
| Inventory = hook-owned ERC-6909 claims, keeper deposit/withdraw | `IParityHook.depositInventory/withdrawInventory/isKeeper/setKeeper`, `inventory`, `InventoryChanged` |
| All-or-nothing fill, else zero-delta fall-through; afterSwap 50 bps peg guard | `Quote.fillable`, `InventoryFill` vs `FallThrough`, `PEG_GUARD_BPS = 50`, `PegGuardTripped`, `pegStatus`, `checkPeg`/`PegGuardStatus` |
| Fee = 2 + 13·\|skew\| + (closed and skew-increasing ? 15·\|post-trade skew\| : 0), cap 25 bps, skew in canonical shares | `BASE_FEE_PIPS/SKEW_FEE_PIPS/OFF_HOURS_MAX_FEE_PIPS/MAX_FEE_PIPS`, `FeeBreakdown`, `CanonicalShares.skewPips/offHoursPips/totalFeePips` |
| Rounding favours the hook; exact-in and exact-out with pinned sign convention | §1.7 quote rules, `CanonicalShares` Down/Up pairs, `IParityHook.quote(key, zeroForOne, int256 amountSpecified)` |
| Adapters expose ratio (18-dec) and staleness/health | `IWrapperAdapter.sharesPerToken/ratio/health`, `AdapterUnhealthy`, `IIssuerRegistry.active` |
| DarkCrossHook commit-reveal at IPriceOracle mid, residual into ParityHook pool in the same unlock | `IDarkCrossHook.commit/reveal/settle`, `IPriceOracle.getMid`, `ORACLE_MAX_AGE`, `ResidualRouted`, `parityPoolKey` |
| IEligibility with EAS impl; swapper from hookData only for allowlisted routers; demoMode owner-set with event | `IEligibility.resolveSwapper/isTrustedRouter/setTrustedRouter`, §3 hookData v1, `setDemoMode` + `DemoModeSet` |
| Mock issuer ERC-20s with issuer-faithful decimals and multiplier | `IMockIssuerToken.multiplier/setMultiplier`, §10 decimals 6/18 |
| Deployment files by network, consumers use NETWORK | §4 `Deployment.network/chainId`, `deploymentPath(network)`, `.gitignore` `deployments/anvil.json` |
| Demo accounts from DEMO_MNEMONIC by fixed index | `Deployment.demoAccounts` (`mnemonicSource`, `index`), §10 accounts, §7 crank index 4 |

## 13. Addendum (2026-09-26, post-freeze): WrapSwapRouter

Additive change closing `interface-change-requests/web.md` (live Convert had no router with a minimum output). No
frozen element changes meaning; `Deployment.contracts.wrapSwapRouter` is a new **optional** key so older manifests and
fixtures stay valid. Every deployment from `Deploy.s.sol` writes it, and consumers treat its absence as "live Convert
unavailable".

### 13.1 IWrapSwapRouter — `contracts/src/interfaces/IWrapSwapRouter.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// @title IWrapSwapRouter
/// @notice Thin single-pool swap router over the v4 PoolManager with user-side slippage and deadline protection.
/// @dev Payment is a plain ERC-20 allowance from msg.sender to the router (no Permit2). The router is a trusted
///      router of the eligibility module, so it only forwards ParityHook hookData v1 naming msg.sender as swapper:
///      empty hookData is replaced with abi.encode(uint8(1), msg.sender, bytes32(0)); any other hookData must be
///      exactly that layout with swapper == msg.sender and is passed through unchanged (attestationUid preserved).
interface IWrapSwapRouter {
    struct ExactInputParams {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMin;
        address recipient;
        uint256 deadline;
        bytes hookData;
    }

    struct ExactOutputParams {
        PoolKey key;
        bool zeroForOne;
        uint128 amountOut;
        uint128 amountInMax;
        address recipient;
        uint256 deadline;
        bytes hookData;
    }

    error NotPoolManager();
    error DeadlineExpired(uint256 deadline, uint256 timestamp);
    error TooLittleReceived(uint256 amountOut, uint256 amountOutMin);
    error TooMuchRequested(uint256 amountIn, uint256 amountInMax);
    error SwapperMismatch(address swapper, address sender);
    error InvalidHookData();

    function poolManager() external view returns (IPoolManager);

    /// @notice Sells exactly `amountIn` of the input currency; reverts unless at least `amountOutMin` is received.
    function swapExactIn(ExactInputParams calldata params) external returns (uint256 amountOut);

    /// @notice Buys exactly `amountOut` of the output currency; reverts if more than `amountInMax` would be paid.
    function swapExactOut(ExactOutputParams calldata params) external returns (uint256 amountIn);
}
```

### 13.2 Semantics

- One swap per `PoolManager.unlock`. The swap runs with the extreme price limit (`MIN_SQRT_PRICE + 1` /
  `MAX_SQRT_PRICE - 1`), and the slippage bound is checked on the resulting delta. The input is then pulled with
  `transferFrom(msg.sender → PoolManager)` (`sync`/`settle`), and the output is `take`n to `recipient`. The router
  holds no balances between calls.
- Exact input: `amountSpecified = -amountIn`. Reverts `TooLittleReceived(out, amountOutMin)` when `out < amountOutMin`.
- Exact output: `amountSpecified = +amountOut`. Reverts `TooLittleReceived(out, amountOut)` on a partial fill and
  `TooMuchRequested(in, amountInMax)` when `in > amountInMax`.
- `block.timestamp > deadline` reverts `DeadlineExpired(deadline, timestamp)` before unlocking.
- hookData: empty becomes ParityHook v1 `abi.encode(uint8(1), msg.sender, bytes32(0))`. Otherwise it must be exactly
  96 bytes of v1 with `swapper == msg.sender` (`SwapperMismatch`), and it is forwarded unchanged, which is how a caller
  supplies its `attestationUid`. Anything else reverts `InvalidHookData()`.
- Hook reverts (`NotEligible`, `PegGuardTripped`, `AdapterUnhealthy`, …) surface wrapped by the PoolManager, as with
  PoolSwapTest.
- Approval: plain ERC-20 `approve(wrapSwapRouter, amountIn)` (or `amountInMax`). Permit2 is not supported.

### 13.3 Deployment and trust

- `Deploy.s.sol` creates `WrapSwapRouter(poolManager)` immediately after `DarkCrossHook`, so every earlier address
  and the §10 currency ordering are unchanged. It calls `eligibility.setTrustedRouter(wrapSwapRouter, true)` and
  writes `contracts.wrapSwapRouter` and `blocks.wrapSwapRouter`.
- `swapRouter` (PoolSwapTest) is kept for seeding and tests; user-facing Convert uses `wrapSwapRouter`.

### 13.4 TypeScript

`@wrapswap/types` exports `IWrapSwapRouterAbi` (also `abis.IWrapSwapRouter`), generated like the other §1 interfaces.
Web live Convert, exact input: `approve(tokenIn, wrapSwapRouter, amountIn)`, then
`swapExactIn({ key: pool.key, zeroForOne: tokenIn == currency0, amountIn, amountOutMin, recipient: account,
deadline: now + 600, hookData: encodeParityHookData({ swapper: account, attestationUid }) })`, where `amountOutMin`
is the displayed minimum output (quote − 0.5%).
