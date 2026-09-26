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

## 2026-09-26 · no-wallet Portfolio, Liquidity as the LP screen, /developers retired into a Verify footer

- `/app` with no ?tab= opens Move → Convert when there is no browser wallet (it works through the demo relay), and
  Portfolio otherwise. Portfolio while disconnected shows one card, "Connect a wallet to see your shares", with a
  Connect button and "or try a conversion without a wallet →". No asset cards of dashes.
- Liquidity (the tab name is unchanged) is titled "Pool inventory & LP economics". A "Who supplies inventory" block
  sits above LP economics, with a disabled "Add inventory · keeper only in v1" button and a tooltip saying why.
- `/developers` is deleted, along with its nav item, the architecture lanes and the Agents page. The URL redirects to
  `/#verify` so old links (submission, README) still land on the addresses. Every page (landing and app) ends in
  the Verify footer:
  - contracts: ParityHook, DarkCross ×3, Router, ShareVault (Uniscan) and the Sui package (Suiscan), all read from
    the committed manifests
  - MCP: the endpoint and the `claude mcp add` command
  - source: GitHub
- The recorded agent run is now a 4-line callout in the landing How it works section (intro line, prompt, tools
  chosen, tx), generated from `deployments/unichain-sepolia.mcp-demo.json`.
- Dropped with the page: the six-tool list, the Claude.ai connector steps and the market-sim link. `/sim.html` is
  still served, and DEMO.md links it directly.

## 2026-09-26 · landing: pink xStocks line, flow diagram as How it works, Under the hood slide, bare header

- The xStocks AAPLx line and its legend key in "One stock. Three prices." are pink (`#ff7eb9`).
- How it works is just the flow diagram (`#how-it-works`): no heading, no product cards. All five nodes share one
  colour, and two dots ride each arrow (SVG `animateMotion`, hidden with reduced motion).
- The Verify footer is off the landing page (it stays in the app). The last slide, `#tech` "Under the hood", has five
  lines (v4 hook, fees, Dark Cross, Send, agents + the recorded MCP run tx) and Launch app, ParityHook on Uniscan and
  GitHub. "See it onchain →" and the retired `/developers` both land there.
- The header is the logo, wordmark, theme toggle and Launch app; Product and How it works are gone, along with the
  dropdowns and the mobile menu.

Tests: web unit 36/36 · Playwright mock 21/21 · live transport 12/12.

## 2026-09-26 · Recent fills show your transactions at once; every tab fits one screen

- Recent fills (Portfolio) lists every transaction sent from this page straight away: a Convert shows as
  "Convert · confirming" until the indexer lists it (Portfolio polls every 3 s meanwhile), a Dark Cross commit as
  "Dark Cross · settles with the batch", and a Send deposit as "Send · confidential via Sui". Before, a Convert took
  about 25 s to appear, and commits and sends never showed under your address. Stored per address in localStorage
  (20 entries, 24 h).
- Panels are one screen tall again: `#root` is a flex column, so `main` grew to its content and the whole page
  scrolled. Header + panels now fill `100dvh` exactly, with the Verify footer below.
- Move: Dark Cross has the same body as Convert (wrapper cards + flip, a direction line carrying the batch status,
  size, quote card, one line, the button). Settled batches is collapsed by default.
- Send: two columns (the send and its tracker on the left; steps, who sees what, use cases on the right).
- Liquidity: tighter spacing. Shorter windows (≤ 820 px) get a compact mode.
- Measured to fit at 1440×900, 1366×768 and 1280×800 (Dark Cross in commit, reveal and settle phases).

Tests: web unit 36/36 · Playwright mock 24/24 · live transport 12/12.

## 2026-09-26 · display formatting, "(mock)" issuers, Convert all to xStocks, relay limits

- Display only (raw values stay in state and tx data): shares to 2 places and tokens to 4, both rounded half-up
  (`fixed`/`fmtShares`/`fmtTokens` in `web/src/lib/format.ts`); fees as "2.00 bps · 0.02 sh"; every number's hover
  tooltip holds the exact value and the raw integer (`Sh`/`Tok`/`Bps`/`FeeBpsShares` in `web/src/app/ui.tsx`). Applies
  to the Convert receipt (In, Out, the "1 xStocks (mock) token = … sh (multiplier)" line under Out, fee), Portfolio
  holdings and recent fills, and the Convert all after-state.
- Issuers read "Coinbase (mock)" and "xStocks (mock)" across the app (`issuerLabel`).
- Portfolio: "Convert all to xStocks" converts every Coinbase (mock) holding of every asset. With a wallet it quotes,
  approves if needed and swaps each asset; with no wallet it calls the relay's new `/demo/convert-all` (one action).
  The after-state shows each leg (In, Out with the multiplier, fee, tx link), the new holdings, and a cost comparison:
  the fee actually paid vs. an illustrative sell + rebuy (0.10% taker per side + 0.25% gap = 45 bps, labelled "not a
  quote").
- Relay: the budget counter and the 100-share check are gone. Merged with `fe45732` from another session, which
  removed the relay's rate limit, budgets and size cap entirely (relay, web and MCP); the relay adds
  `/demo/convert-all` on top.
