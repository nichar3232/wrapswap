# UI status

## 2026-09-26 · wallet button, keeper-set inventory, Convert direction rows, landing snap deck

- **Wallet button** (`web/src/app/wallet.tsx`): reads "Connect" until clicked. The automatic connect on load (mock
  wallet / demo relay) no longer sets the busy state, so it never shows "Connecting…" by itself. A clicked attempt
  shows "Connecting…" and races a 5 s timeout (`CONNECT_TIMEOUT_MS`). On failure or timeout it returns to "Connect"
  with "Your wallet didn't respond. Retry." Reproduced before the fix: if `/api/demo/status` never answers, a click
  left "Connecting…" on screen forever.
- **Liquidity** (`keeperSetInventory` in `web/src/app/fees.ts`): shows "Inventory set by pool keeper" under the
  inventory rows when |L − R| is larger than twice the indexed conversion volume. Volume is
  `lpFees.baseShares × 1e6 / basePips`, since every Convert pays the base fee, and one conversion of v shares widens
  the gap by at most 2v.
- **Move → Convert direction rows**: already clickable. Each click sets from → to, moves the highlight and re-quotes,
  and quotes are keyed per request so nothing stale shows. No code change; added a Playwright test that clicks the
  rows themselves (only the ⇄ flip was covered before).
- **Landing snap deck** (`html.deck`, `web/src/landing/landing.css`): hero, "One stock. Three prices.", How it works,
  the Convert flow (now its own `#flow` section) and the footer are each `min-height: 100vh` with
  `scroll-snap-align: start`, under `scroll-snap-type: y mandatory`. This applies to the landing page only; Developers
  stays on proximity. A section taller than the viewport still scrolls natively inside itself. Reduced-motion turns
  snapping off. The hero is exactly one viewport at 1440×900 and 390×844. Test: one ArrowDown step (desktop) or one
  touch swipe (mobile) puts `#one-price` at top 0, 5/5 repeats green. Deep links to a How it works card now land on
  its slide, with the card in view.

Tests: web unit 40/40 · Playwright mock 22/22 · Playwright live transport 10/10 (API tests needing Postgres not run).

Screenshots (live-transport build, API served from the committed mock fixtures, no wallet injected; figures are
fixtures, not chain reads):

- `ui-shots/liquidity-no-wallet-1440.png`
- `ui-shots/liquidity-no-wallet-390.png`

## 2026-09-26 · MCP made visible: /developers#agents, landing callout, nav + footer

- `/developers#agents`: the MCP endpoint, the six tools (read / executes) with one-line descriptions, Claude.ai
  custom-connector steps, the `claude mcp add unison --transport http <url>` command, and the recorded agent run at
  `#agent-transcript`: prompt → `get_pool` → `quote_convert` → `convert` → tx on Uniscan.
- The transcript is generated, not typed. `scripts/gen-mcp-demo.py` parses `submission/mcp-demo.md`, checks its tool
  calls against the raw `mcp-demo.jsonl`, and reads the receipt from Unichain Sepolia (status 1 at block 63,592,305).
  It writes `deployments/unichain-sepolia.mcp-demo.json`, and the landing test checks the page against that file.
- Landing: a one-line callout under How it works links to the Agents section. "MCP" is in the Developers dropdown and
  the footer.
- Fix: deep links to the landing page (`/#how-it-works`, used by the nav on /developers) now land on the section.
  Before, the page rendered after the browser's hash jump and stayed on the hero.

Tests: web unit 40/40 · Playwright mock 23/23 · Playwright live transport 10/10.
