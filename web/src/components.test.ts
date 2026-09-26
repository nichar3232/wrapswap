import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEMO,
  routes,
  validators,
  type Route,
  type Network,
} from "@wrapswap/types";
import { FeeRows, RouteBadge } from "./components";
import { Val } from "./app/ui";
import { demoVariant, fixtures, mockResponse } from "./mocks/api";
describe("route badges", () => {
  for (const route of [
    "PARITY",
    "FALL-THROUGH",
    "DARK",
    "BLOCKED-PEG",
    "BLOCKED-ELIGIBILITY",
  ] as Route[])
    it(route, () => {
      const html = renderToStaticMarkup(
        React.createElement(RouteBadge, { route }),
      );
      expect(html).toContain(route);
      expect(html).toContain(route.startsWith("BLOCKED") ? "error" : "good");
    });
});
for (const network of ["anvil", "unichain-sepolia"] as Network[])
  describe(network, () => {
    it("schema-valid fixtures for every mocked route", () => {
      const f = fixtures(network);
      const params: Record<string, string> = { poolAsset: "NVDA", faucet: DEMO.accounts.demo.anvilAddress, batch: "7?asset=AAPL", currentBatch: "asset=TSLA", batches: "asset=AAPL&settled=true", stats: "address=0x0000000000000000000000000000000000000001" };
      for (const name of [...Object.keys(f).filter((k) => k !== "assetsList"), "quote", "route", ...Object.keys(params)]) {
        const r = routes.find((r) => r.name === name)!;
        expect(() =>
          validators[r.response].assert(mockResponse(r.name, network, params[name] ?? "")),
        ).not.toThrow();
      }
    });
    it("fee rows: base and skew to LP; a rebalancing trade shows skew 0 and says so", () => {
      const rows = (skewPips: number, reduces: boolean) =>
        renderToStaticMarkup(
          React.createElement(FeeRows, { basePips: 200, skewPips, baseFee: 20250000000000000n, skewFee: reduces ? 0n : 16281510165745857n, reducesImbalance: reduces }),
        );
      expect(rows(0, true)).toContain("2.00 bps · to LP");
      expect(rows(0, true)).toContain("0 — this trade rebalances the pool");
      expect(rows(162, false)).toContain("1.62 bps · to LP");
      expect(rows(162, false)).toContain("0.0162");
      for (const html of [rows(0, true), rows(162, false)]) expect(html).not.toMatch(/off-hours|closed|NYSE|\$|USD/);
    });
    it("quotes both token directions with exact canonical rounding", () => {
      const f = fixtures(network),
        v = demoVariant(network);
      const quote = mockResponse("quote", network) as { amountOut: string };
      expect(quote.amountOut).toBe(v.parityFill.amountOut.toString());
      const reverse = mockResponse(
        "quote",
        network,
        new URLSearchParams({
          tokenIn: f.deployment.tokens[1].address,
          amount: "101250000000000000000",
        }).toString(),
      ) as { grossOut: string };
      expect(reverse.grossOut).toBe("100000000");
    });
  });
it("feed values render skeleton, unavailable or data, never raw errors", () => {
  const html = (status: "loading" | "ok" | "stale" | "unavailable") =>
    renderToStaticMarkup(React.createElement(Val, { status, children: "14.60 bps" }));
  expect(html("loading")).toContain("skeleton");
  expect(html("loading")).not.toContain("14.60");
  expect(html("unavailable")).toContain("unavailable");
  expect(html("unavailable")).not.toMatch(/error|syntax|http/i);
  expect(html("ok")).toBe("14.60 bps");
  expect(html("stale")).toBe("14.60 bps");
});
