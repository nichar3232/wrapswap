// Thin client for the public Unison API (GET routes) and the demo relay (POST /demo/*). No keys, no addresses:
// everything the tools know comes from these responses.

import { readFileSync } from "node:fs";

export const DEFAULT_API_URL = "https://nichars-mac-mini.tail43cacc.ts.net/api";

/** The relay budget token for the MCP server running on the mini (MCP_RELAY_TOKEN_FILE); absent for local stdio users. */
const relayToken = (() => {
  const file = process.env.MCP_RELAY_TOKEN_FILE;
  if (!file) return undefined;
  try {
    return /^MCP_RELAY_TOKEN=([0-9a-f]{64})$/m.exec(readFileSync(file, "utf8"))?.[1];
  } catch {
    return undefined;
  }
})();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export class UnisonApi {
  readonly base: string;
  constructor(
    base = process.env.UNISON_API_URL || DEFAULT_API_URL,
    private readonly fetcher: Fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {
    this.base = base.replace(/\/$/, "");
  }

  get<T = any>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const qs = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return this.request<T>("GET", `${path}${qs}`);
  }

  post<T = any>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(relayToken && path.startsWith("/demo/") ? { "x-unison-relay-client": relayToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await r.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body, keep text */
    }
    if (!r.ok) throw new ApiError(errorMessage(json) ?? `${method} ${path} -> HTTP ${r.status}`, r.status, json);
    return json as T;
  }
}

/** Extracts the most specific human reason from an API / relay error body (incl. decoded revert reasons). */
export function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body : undefined;
  const b = body as Record<string, any>;
  const e = b.error;
  const parts = [
    typeof e === "string" ? e : [e?.code, e?.message].filter(Boolean).join(": ") || undefined,
    b.revertReason ?? b.reason ?? e?.revertReason ?? e?.reason,
    b.message,
  ].filter((x) => typeof x === "string" && x);
  return parts.length ? [...new Set(parts)].join(": ") : undefined;
}
