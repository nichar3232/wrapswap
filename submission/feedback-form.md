# Uniswap hackathon feedback draft

Source: [official Hackathon Feedback form](https://developers.uniswap.org/hackathon-feedback), retrieved 2026-09-25. This document is a draft; it has not been submitted. Form topics below are paraphrased; use the live form for its exact labels and dropdown options. Personal identity, subjective ratings, consent and unobserved timing are deliberately left for the submitter.

| Form field / topic | Draft response |
| --- | --- |
| Given name (required) | Submitter's first name |
| Family name | Submitter's last name |
| Email (required) | Submitter's contact email |
| Telegram (required) | Submitter's Telegram handle |
| Hackathon (required) | ETHGlobal Tokyo 2026, as specified in the project brief; verify the event's exact official label before submitting. |
| Project completion (required) | Use the final verification status in PROGRESS.md. Do not select completed until the submission run is recorded. |
| Project description (required) | WrapSwap converts tokenized-stock issuer claims through a canonical share token and a Uniswap v4 parity hook. A second hook crosses sealed batches at an oracle midpoint and routes selected residuals to concentrated liquidity in the settlement transaction. The local Base fork uses explicit mock issuers because native B20 execution is unsupported in generic Anvil. |
| AI / agentic product (required) | No. An agent helped build it; the product's trading and settlement logic is deterministic. |
| Successful Uniswap integration (required) | Yes for the implemented v4 contracts and tests; report final fork/demo status from PROGRESS.md. The integration includes custom accounting, ERC-6909 inventory, mined hook permissions, PositionManager liquidity, V4Quoter/StateView and a swap router. |
| Time to first integration (required) | Submitter should choose the option matching actual elapsed time; no reliable start-to-success measurement has been recorded. |
| Largest blocker | Native Base B20 calls could not execute under generic Anvil, and release-tag/current-periphery compatibility required resolving the exact core/periphery revisions. We documented the B20 mock explicitly and normalized 8-decimal issuer amounts. |
| Agentic application difficulty | Not applicable: this is not an agentic trading application. |
| Documentation rating (required) | Submitter's own 1–5 rating. Evidence: exact-output custom accounting, override-fee storage behavior and hook-originated callback bypass needed source inspection. |
| Overall support rating (required) | Submitter's own 1–5 rating; no personal support interactions are claimed. |
| Continue building? (required) | Submitter's decision. Proposed next work: oracle normalization, external security review, live B20 execution, FHE matching and authenticated cross-chain settlement. |
| Support used (required) | Technical docs and code examples/templates are evidenced by this repository. Do not claim office hours, mentorship or Discord support unless the submitter actually used them. |
| Missing support | A tested release/compiler compatibility matrix, machine-readable deployment manifest, full mixed-decimal custom-accounting walkthrough, and native Base B20 fork fixture. |
| Additional feedback | Concrete source-linked feedback: https://github.com/nichar3232/wrapswap/blob/main/FEEDBACK.md . This link is valid only after the public push succeeds. |
| Follow-up consent | Submitter's choice. |
| Terms/privacy agreement (required) | Submitter must review and accept personally in the live form. |

The live form has twenty fields/topics including its terms/privacy checkbox. This draft preserves every topic without inventing personal data, ratings or consent.
