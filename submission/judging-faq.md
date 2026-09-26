# Judging FAQ — WrapSwap

Short answers to likely judge questions. The citations are for us, not for reading aloud.

**1. Why not just use a normal pool?**
A normal pool prices two wrappers of the same share with a curve, so every trade pays slippage and LPs take on impermanent loss around a price that should be fixed. ParityHook fills at the adapters' share ratio from its own ERC-6909 inventory, with a fee that only moves with inventory skew and market hours ({{LINE:ParityHook.beforeSwap(address,PoolKey,SwapParams,bytes)}}; DECISIONS.md: "Fills are all-or-nothing from inventory via beforeSwapReturnDelta"). The curve is still there as the fall-through for swaps inventory can't cover, and a 50 bps peg guard bounds it.

**2. What if an adapter is wrong?**
Each adapter reports a health flag (paused or stale). If either side is unhealthy, the swap reverts with `AdapterUnhealthy` rather than pricing off a bad ratio ({{LINE:IWrapperAdapter.health()}}; DECISIONS.md: "an unhealthy adapter blocks swaps with AdapterUnhealthy"). Fall-through swaps also can't move the pool more than 50 bps from adapter parity ({{LINE:ParityHook.afterSwap(address,PoolKey,SwapParams,BalanceDelta,bytes)}}), and the registry can pause an issuer. A ratio that is wrong but still reported as healthy would misprice inventory fills against the keeper's inventory. That's why the ratio comes from the issuer token's own on-chain multiplier, not an off-chain price (INTERFACES.md §10: mcbAAPL `sharesPerToken` = B20 multiplier 1.0125; {{LINE:IWrapperAdapter.sharesPerToken()}}).

**3. What about issuer redemption risk?**
It doesn't go away, and we don't pool it. Users only ever hold real issuer tokens, so converting moves you from one issuer's claim to another's. Nothing sits in between (DECISIONS.md: "PoolKey is the two issuer tokens … ParityHook settles issuer-to-issuer directly"). The hook's inventory, supplied by keepers, is the party exposed to the mix of issuers. Keepers manage that exposure with deposits and withdrawals ({{LINE:ParityHook.withdrawInventory(Currency,uint256,address)}}).

**4. Why the non-US gate?**
Tokenized-equity wrappers carry jurisdictional distribution restrictions. We enforce the boundary in the contract rather than in a frontend. The eligibility contract checks a Coinbase Verified Country EAS attestation from the trusted Coinbase attester and denies the restricted country "US" ({{LINE:IEligibility.check(address,bytes32)}}; DECISIONS.md: "IEligibility has an EAS implementation (Coinbase Verified Country, restricted country \"US\")"). Behind a router, the swapper named in hookData is honoured only when the sender is an allowlisted router ({{LINE:IEligibility.resolveSwapper(address,address)}}).

**5. What happens when NYSE is closed?**
The hook keeps trading and prices the off-hours risk: it adds 10 bps to the fee while the on-chain NYSE calendar reports closed, capped at 25 bps total. On Base Sepolia this weekend, the canonical 100-mcbAAPL quote is 14.60 bps (2.00 base + 2.60 skew + 10.00 closed) against 4.60 bps on an open-market fork. Market hours come from the latest block timestamp, never the host clock ({{LINE:NyseCalendar.isOpen(uint256)}}; DECISIONS.md: "Fee is expressed in pips: min(200 + ceil(1300·|skew|) + (NYSE closed ? 1000 : 0), 2500)"; "Market-hours logic everywhere reads the latest block timestamp").

**6. Is the EAS gate live on testnet?**
It is enforced by the contract, but bypassed on testnet. The check is compiled into both hooks, and a denied swap reverts with `NotEligible`. On Base Sepolia and the local anvil stack, the owner has turned on `demoMode`, which makes every account eligible so judges can try it without a Coinbase attestation. That toggle is public and emits `DemoModeSet` ({{LINE:IEligibility.setDemoMode(bool)}}; DECISIONS.md: "demoMode is owner-set and emits DemoModeSet"; "reverted parity swaps cannot emit events, so the API surfaces them by simulation as BLOCKED-ELIGIBILITY").

**7. Is the dark cross actually private?**
Only partly. Orders are hashes during the commit phase and become public at reveal. The locked token and amount are visible from the start, so this is sealed-bid batching, not cryptographic privacy. What it does guarantee: crossed flow clears at one oracle mid for the whole batch, and any residual settles through ParityHook in the same `unlock` ({{LINE:DarkCrossHook.reveal(bool,uint256,uint256,bool,bytes32)}}, {{LINE:DarkCrossHook.settle(uint256)}}; DECISIONS.md: "DarkCrossHook crosses the same issuer pair at an IPriceOracle midpoint … mids older than 900 s block settlement").

**8. What's real and what's mocked in the demo?**
The Uniswap v4 PoolManager path, the hooks, ERC-6909 inventory and the dark-cross settlement are real contracts. The issuer tokens are mocks with issuer-faithful decimals and multipliers: `mcbAAPL` (6 decimals, 1.0125) and `mAAPLx` (18 decimals, 1.0). The oracle mid is a crank-pushed mock set at parity (DECISIONS.md: "Local and testnet tokens are mock issuer ERC-20s with issuer-faithful decimals and multiplier behaviour"; "The mock oracle mid is pushed by the crank at adapter parity"). We mock the tokens because Coinbase's AAPL on Base is a native B20 token that generic Anvil can't execute (DECISIONS.md: "Use MockB20 on the Base fork due to observed OpcodeNotFound").
