## CR-1: Live demo sequencing and deterministic acceptance prerequisites

Problem: §10 residual fees (447/1447 pips) assume the 100 mcbAAPL conversion happens
before the dark settlement. A fresh live seed leaves the demo wallet at 500/500 and
reveals orders for the next epoch, while §7 requires the crank to settle immediately.
A visitor arriving after that epoch cannot reproduce the §10 order of operations.

Proposed clarification: define live seed as a starting-state fixture, with displayed
live residual fees derived from the actual inventory; require an explicitly coordinated
conversion before reveal when verifying the exact §10 BASE-SEPOLIA end-state numbers.
Do not change contract formulas. ANVIL remains deterministic with explicit phase mining.
Affected: §7 and §10. Blocking: yes for unconditional exact live narrative; no for local replay.

The literal acceptance command also invokes `npx`, which is unavailable on a machine
with only Docker and Foundry. The runbook states Node/Corepack/Playwright prerequisites
for that host command instead of claiming they come from Docker. This is a task-level
prerequisite conflict, not a proposed change to an ABI or API.

No legacy component mismatch is an interface-change request. Components must implement
the frozen interfaces; integration has not substituted legacy schemas or mock responses.
