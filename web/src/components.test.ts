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
import { Fees, RouteBadge } from "./components";
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
      for (const name of [...Object.keys(f), "quote", "route"]) {
        const r = routes.find((r) => r.name === name)!;
        expect(() =>
          validators[r.response].assert(mockResponse(r.name, network)),
        ).not.toThrow();
      }
    });
    it("renders exact demo fee and closed-market premium", () => {
      const fee = fixtures(network).fees.fee;
      const html = renderToStaticMarkup(React.createElement(Fees, { fee }));
      expect(html).toContain("2 bps");
      expect(html).toContain("2.60 bps");
      expect(html).toContain(demoVariant(network).parityFill.feeBps + " bps");
      expect(html.includes("NYSE closed: +10 bps off-hours premium")).toBe(
        !demoVariant(network).marketOpen,
      );
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
it("fee curve boundary cases show zero skew and maximum closed fee", () => {
  for (const [skewPips, closedPips, totalBps] of [
    [0, 0, "2.00"],
    [1300, 0, "15.00"],
    [0, 1000, "12.00"],
    [1300, 1000, "25.00"],
  ] as const) {
    const html = renderToStaticMarkup(
      React.createElement(Fees, {
        fee: {
          basePips: 200,
          skewPips,
          closedPips,
          totalPips: Number(totalBps) * 100,
          totalBps,
          skewX18: "0",
          marketOpen: !closedPips,
        },
      }),
    );
    expect(html).toContain(totalBps + " bps");
    expect(html.includes("off-hours premium")).toBe(!!closedPips);
  }
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
