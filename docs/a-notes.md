# A decisions and progress
- Implement enabled IHooks callbacks directly because pinned v4-periphery has no BaseHook.
- Normalize all issuer amounts with ERC20 decimals; B20's multiplier remains 1e18 despite 8-decimal balances.
- Separate fee claims from spendable inventory so fills and withdrawals cannot consume accrued fees.
- Vault inventory providers may pull only surplus after checking backing; unrestricted approvals would permit unbacked uAAPL.
- Dynamic override is in millionths (bps times 100) and does not change slot0's stored LP fee.
- Calendar searches session candidates by day; weekend nextTransition remains under 500k gas.
- Adapter ratio reductions and registry removal remain privileged governance risks; mint/redeem/sweep/pull reject underbacking rather than silently allow it.
- 17 real PoolManager/vault/calendar tests pass, including 1000-run backing fuzz, exact input/output both directions, fallthrough, manipulated-price guard, multiplier repricing and 8-decimal normalization.
