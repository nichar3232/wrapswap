import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { amount, exact, fixed, fmtShares, fmtTokens, parityOutput, short } from "./format";

const sh = (s: string) => parseUnits(s, 18);

describe("display rounding (half-up; raw values untouched)", () => {
  it("shares: two places", () => {
    expect(fmtShares(sh("99.999999"))).toBe("100.00");
    expect(fmtShares(sh("99.979999"))).toBe("99.98");
    expect(fmtShares(sh("99.975"))).toBe("99.98"); // half rounds up
    expect(fmtShares(sh("99.974999"))).toBe("99.97");
    expect(fmtShares(sh("1234.5"))).toBe("1,234.50");
    expect(fmtShares(0n)).toBe("0.00");
  });
  it("tokens: four places at the token's decimals", () => {
    expect(fmtTokens(parseUnits("98.990099", 6), 6)).toBe("98.9901");
    expect(fmtTokens(parseUnits("98.99005", 18), 18)).toBe("98.9901");
    expect(fmtTokens(parseUnits("98.99004999", 18), 18)).toBe("98.9900");
    expect(fmtTokens(parseUnits("5", 6), 6)).toBe("5.0000");
  });
  it("fewer decimals than places pads", () => {
    expect(fixed(12345n, 2, 4)).toBe("123.4500");
  });
  it("tooltip text carries every digit and the raw integer", () => {
    expect(exact(sh("99.999999"), 18, "sh")).toBe("99.999999 sh (raw 99999999000000000000)");
  });
});

it("formats raw amounts without changing units", () => {
  expect(amount("123456789", 6, 4)).toBe("123.4567");
  expect(amount(undefined)).toBe("—");
  expect(amount("1000000000000000000")).toBe("1");
  expect(short("0x1234567890abcdef")).toBe("0x1234…cdef");
});
it("quotes equal shares across 8 and 18 decimal wrappers", () =>
  expect(parityOutput(10n ** 8n, 2n * 10n ** 18n, 10n ** 18n, 8, 18)).toBe(2n * 10n ** 18n));
