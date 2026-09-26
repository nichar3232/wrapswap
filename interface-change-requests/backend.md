## CR-1: Crank health aggregation
Problem: requested API health aggregation has no field in the strict HealthResponse schema, whose `ok` rule is explicitly limited to RPC identity, DB availability and indexer lag.
Proposed change: optionally extend HealthResponse with a validated CrankStatusResponse in a later freeze. Meanwhile API `/status` proxies crank `/health`, both using CrankStatusResponse; API `/health` stays exact.
Affected sections: §5 HealthResponse, §7.
Blocking: no.

## CR-2: Illustrative deployment pool ID
Problem: the §4 worked-example pool ID is shorter than 32 bytes, and its illustrative ParityHook address has a noncanonical checksum.
Proposed change: use a full 32-byte ID and checksummed addresses in the worked example. Backend tests repair these illustrative values in memory only. Real deployment files remain schema-validated.
Affected sections: §4 worked example.
Blocking: no.
