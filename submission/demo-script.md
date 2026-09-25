# Three-minute video script

Record only after `make test`, `DEMO_CHECK=1 make demo` and `make fresh-clone-check` have succeeded. Use a fresh local `make demo` session and its seeded accounts; keep RPC URLs and the deployer private key off screen. This script follows the existing tab/control labels and may need a final reference refresh after integration. The bridge is not part of the recorded working demo.

| Time | Exact action | Narration / evidence |
| --- | --- | --- |
| 0:00–0:18 | Show the terminal's successful scripted demo receipts and summary; show `http://localhost:5173`. | “WrapSwap is a conversion layer between issuers of the same stock. Our demo uses explicit issuer mocks because generic Anvil cannot execute native Base B20, with real Base Uniswap contracts.” |
| 0:18–0:35 | Open the URL; choose the first account in the Demo burner selector. Stay on Convert. | Show the chain, NYSE status, oracle freshness and hook inventory. “uAAPL counts shares, while adapters handle each wrapper's decimals and multiplier.” |
| 0:35–1:00 | On Convert, choose mAAPLc as From and uAAPL as To; enter `10`; click Approve & convert once. Wait for approval and conversion receipt. | Point to expected output, fee and route, then the transaction hash. “This converts shares without a USDC leg.” |
| 1:00–1:20 | Choose uAAPL as From and mAAPLx as To; enter `1`; click Approve & convert. | Show ParityHook route and the resulting conversion history. “The hook fills from ERC-6909 inventory; the scripted run also drained inventory and proved curve fall-through.” |
| 1:20–1:45 | Click Dark pool. Show funded escrow, current batch and existing fills from the scripted three-wallet flow. | Highlight a shared batch with cross and lit fills. “Commitments reveal in a later phase. One settlement transaction crosses matched shares and routes the selected remainder to the lit pool.” |
| 1:45–2:05 | Point to the `Crossed` and `RoutedToLit` receipt assertions in the terminal, then return to Dark pool. | “This is atomic residual routing through unlock, swap and settlement. The public lock currency and amount remain visible; commit-reveal is not full cryptographic privacy.” |
| 2:05–2:25 | Click Backing. Show the two issuer rows, total shares, supply and invariant indicator. | “Issuers remain distinct risks. The vault tracks backing in shares, applies the current multiplier and charges five basis points on redemption.” |
| 2:25–2:42 | Click Metrics. Show conversion volume, crossed/routed totals and settled batches. | “The indexer backfills chain events into local Postgres; these numbers come from transactions, not canned UI data.” |
| 2:42–3:00 | Show README's integration table and FEEDBACK.md in the public repository. | “Next: hardened oracle normalization, FHE matching, and an authenticated intent bridge. The repository includes tests, a clean-clone demo and concrete Uniswap developer feedback.” |

If the UI labels change, synchronize this script before recording. Do not present an unsuccessful or pending verification as green. A new live order can be committed in the UI, but waiting through the 20-block cycle is unnecessary for this three-minute cut because the scripted three-wallet batch already supplies auditable receipts.
