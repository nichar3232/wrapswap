# Decisions
- Install Foundry 1.8.3 and pnpm 12.6.0 locally: the specified executables were absent.
- Use public Base RPC endpoints in ignored .env: no supplied RPC configuration was present.
- Normalize issuer amounts by token decimals before applying sharesPerToken: live AAPLc has 8 decimals.
- Keep deployment private key only in ignored mode-0600 .env: public repository must contain no deployer secret.
- Inspect native B20 behavior on Anvil before selecting mocks: B20 executes in the Base node rather than ordinary bytecode.

- Use MockB20 on the Base fork due to observed OpcodeNotFound; retain real adapter for Base nodes.
- v4 LP fee override affects swap fee without persisting slot0: validate charged amounts.
- Enforce trusted EAS attester, bound batch size, and currency-specific forfeits: close security/accounting ambiguities in the spec.
- Pin compatible current core/periphery commits instead of mixing stale core v4.0.0 with current periphery: the latter imports PoolOperation.sol absent from the tag.
- Use official PositionManager and Permit2 for real fork liquidity; deploy only a PoolSwapTest convenience router locally.
- Queue documentation agent D after one of A/B/C returns: only three child-agent slots are available.
