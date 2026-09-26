# Submit checklist (owner, in order)

Placeholders referenced: `{{URL:repo}}`, `{{URL:video}}`, `{{URL:feedback-md}}`, `{{URL:repo-readme-integrations}}`

**Hard deadline: Sun 2026-09-27 09:00 JST = Sat 2026-09-26 24:00 UTC.** Part B has no market-hours dependency (the fee has no clock input); record any time before the deadline.

## 0. Preconditions (5 min)

- [ ] `git log` on the branch you'll submit contains the integrated contracts, web and deployment lanes. `make types` passes: it re-verifies every INTERFACES.md §10 number.
- [ ] The deployment step has resolved every LINE placeholder in `FEEDBACK.md` and `submission/*.md` to GitHub line links. Check with `grep -rn '{{LINE:' FEEDBACK.md submission/ --exclude=submit-checklist.md`, which should print nothing (re-run `scripts/dev/resolve-lines.py` after code moves).
- [ ] The README "Verify the integration" section and Contracts table show the Unichain Sepolia addresses as verified.

## 1. Record Part A on the local anvil stack (≈15 min)

- [ ] Start the recording stack with the integration lane's command, `scripts/dev/record-ready` (path from INTERFACES.md §8 `scripts/dev/`; see INTEGRATION.md for options). It must use `NETWORK=anvil`, warp to `1790692200`, seed §10 balances and inventory, and stop before any swap.
- [ ] Check the Move → Convert quote for 100 mcbAAPL → mAAPLx: **PARITY**, **2.00 bps** (base only, skew fee 0), **101.22975 mAAPLx**. If it doesn't match, re-run `record-ready`. Don't record.
- [ ] Record blocks A1–A4 of `submission/demo-script.md` (0:00–2:20), at 1080p or at least 720p, with a screen recorder and your own voice.
- [ ] Before cutting, check the Dark Cross batch shows crossed 50 mcbAAPL ↔ 50.625 mAAPLx and residual 10 mcbAAPL → 10.122975 mAAPLx at 2.00 bps.

## 2. Record Part B on the live site (≈10 min)

- [ ] Open `https://sepolia.uniscan.xyz/address/0x484bc6aa8f6D472AD67F3ce8dD86f1f8A166e0c8#code` and confirm the "verified" check shows (block B1).
- [ ] Run `scripts/dev/live-up` (Funnel serves it, DEMO.md §3) and open `https://nichars-mac-mini.tail43cacc.ts.net/app`, Move → Convert. Check chain 1301 and asset AAPL. At time of writing the 100 mcbAAPL → mAAPLx quote was **2.00 bps** / **101.22975 mAAPLx** (skew-reducing: base fee only; the reverse direction was 4.97 bps); read the live figures off the screen. **Only quote; don't execute a swap before recording.**
- [ ] Open `{{URL:repo-readme-integrations}}` (block B3).
- [ ] Record blocks B1–B3 (2:20–3:00).

## 3. Edit and upload the video (≈20 min)

- [ ] Join Part A and Part B. Final length **2:00–4:00**; aim for 3:00 or less. Intro under 20 s. No speed-up, no AI voice, no music-only sections.
- [ ] Burn in the captions from `submission/demo-script.md`, one per block.
- [ ] Upload to YouTube (Unlisted) or Loom, and copy the share URL. It becomes `{{URL:video}}`.

## 4. Fill the `{{URL:…}}` placeholders (≈10 min)

- [ ] Fill each placeholder from its source, in `submission/ethglobal.md`, `submission/feedback-form.md` and `submission/demo-script.md`:

  | Placeholder | Source |
  |---|---|
  | `{{URL:repo}}` | the public GitHub repo URL |
  | `{{URL:feedback-md}}` | `{{URL:repo}}/blob/main/FEEDBACK.md` |
  | `{{URL:repo-readme-integrations}}` | `{{URL:repo}}#uniswap-stack-integration` |
  | `{{URL:video}}` | from step 3 |
  | `{{URL:addr-*}}` | `deployments/unichain-sepolia.json` → `contracts` / `tokens` (resolved in place for Unichain Sepolia) |
  | `{{URL:uniscan-*}}` | `https://sepolia.uniscan.xyz/address/<addr>#code` (resolved in place for Unichain Sepolia) |

- [ ] Check nothing is left: `grep -rn '{{URL:' submission/` should print nothing, apart from the "Placeholders used" header lines, which you can delete.

## 5. Submit the ETHGlobal project and pick the Uniswap prize (≈15 min)

- [ ] Go to https://ethglobal.com/events/tokyo2026 → Hacker Dashboard → your project.
- [ ] Paste each field from `submission/ethglobal.md`: name, short description, description, how it's made, tech stack, AI usage, repo, live demo, video, contract addresses. Fill the AI-usage **OWNER** note honestly.
- [ ] Partner prizes: select **Uniswap — Best Uniswap Stack Contribution**. Paste the integration explanation and feedback from `ethglobal.md` → "Prize tracks".
- [ ] Submit, then confirm the project page shows the video and repo.

## 6. Submit the Uniswap feedback form (≈10 min)

- [ ] Go to https://developers.uniswap.org/hackathon-feedback.
- [ ] Fill fields 1–20 from `submission/feedback-form.md`. Answer every **OWNER** field yourself: name, email, Telegram, integration time, the two ratings, whether you'll continue building, follow-up consent, terms.
- [ ] Submit.

## 7. Afterwards

- [ ] Keep `judging-faq.md` and `pitch.md` open for the 4-minute demo and 3-minute Q&A.
