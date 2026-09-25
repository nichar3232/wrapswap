# Decisions
- Install Foundry 1.8.3 and pnpm 12.6.0 locally: the specified executables were absent.
- Use public Base RPC endpoints in ignored .env: no supplied RPC configuration was present.
- Normalize issuer amounts by token decimals before applying sharesPerToken: live AAPLc has 8 decimals.
- Keep deployment private key only in ignored mode-0600 .env: public repository must contain no deployer secret.
- Inspect native B20 behavior on Anvil before selecting mocks: B20 executes in the Base node rather than ordinary bytecode.

- Use MockB20 on the Base fork due to observed OpcodeNotFound; retain real adapter for Base nodes.
- v4 LP fee override affects swap fee without persisting slot0: validate charged amounts.
- Enforce trusted EAS attester, bound batch size, and currency-specific forfeits: close security/accounting ambiguities in the spec.
