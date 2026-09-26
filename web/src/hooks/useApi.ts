import { useEffect, useRef, useState } from "react";
import {
  routes,
  validators,
  parseDeployment,
  type RouteName,
  type RouteResponses,
} from "@wrapswap/types";
import { config } from "../config";

/** Why a feed has no fresh data. Never carries raw exception text into the UI. */
export type FeedFailure = "unavailable" | "invalid" | "http";
export class FeedError extends Error {
  constructor(
    readonly kind: FeedFailure,
    readonly status?: number,
  ) {
    super(kind);
  }
}

/** Fetch one API route. Empty, non-JSON, non-OK or schema-invalid responses become a typed FeedError. */
export async function request<N extends RouteName>(
  name: N,
  params = "",
  signal?: AbortSignal,
): Promise<RouteResponses[N]> {
  const route = routes.find((r) => r.name === name)!;
  let value: unknown;
  if (config.useMocks) {
    const { mockResponse } = await import("../mocks/api");
    value = mockResponse(name, config.network, params);
  } else {
    const path = route.path.includes(":address")
      ? route.path.replace(":address", params)
      : route.path + (params ? "?" + params : "");
    let r: Response;
    try {
      r = await fetch(
        (name === "crankStatus" ? config.crankUrl : config.apiUrl) + path,
        { signal },
      );
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new FeedError("unavailable");
    }
    if (!r.ok) throw new FeedError("http", r.status);
    if (!(r.headers.get("content-type") ?? "").includes("json"))
      throw new FeedError("unavailable");
    const text = await r.text();
    if (!text.trim()) throw new FeedError("unavailable");
    try {
      value = JSON.parse(text);
    } catch {
      throw new FeedError("unavailable");
    }
  }
  try {
    const checked = validators[route.response].assert(value);
    if (name === "deployment") {
      const d = parseDeployment(checked);
      if (d.network !== config.network) throw new FeedError("invalid");
    }
    return checked as RouteResponses[N];
  } catch (e) {
    throw e instanceof FeedError ? e : new FeedError("invalid");
  }
}

/**
 * loading: nothing yet and still retrying · ok: fresh · stale: last good data kept while the latest refresh failed ·
 * unavailable: never loaded and several attempts failed (keeps retrying).
 */
export type FeedStatus = "loading" | "ok" | "stale" | "unavailable";
const GIVE_UP_AFTER = 3;

export function useApi<N extends RouteName>(
  name: N,
  params: string | null = "",
  interval = 5000,
) {
  const key = name + ":" + params;
  const [state, setState] = useState<{
    key: string;
    data?: RouteResponses[N];
    failures: number;
    failure?: FeedFailure;
  }>({ key, failures: 0 });
  const [tick, setTick] = useState(0);
  const failuresRef = useRef(0);
  useEffect(() => {
    if (params === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    failuresRef.current = 0;
    const run = async () => {
      try {
        const data = await request(name, params, controller.signal);
        if (controller.signal.aborted) return;
        failuresRef.current = 0;
        setState({ key, data, failures: 0 });
        timer = setTimeout(run, interval);
      } catch (e) {
        if (controller.signal.aborted) return;
        const failures = ++failuresRef.current;
        setState((s) => ({
          key,
          data: s.key === key ? s.data : undefined,
          failures,
          failure: e instanceof FeedError ? e.kind : "unavailable",
        }));
        // Back off 1 s, 2 s, 4 s … up to the polling interval.
        timer = setTimeout(run, Math.min(1000 * 2 ** (failures - 1), interval));
      }
    };
    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [name, params, interval, key, tick]);
  const mine = state.key === key;
  const data = mine ? state.data : undefined;
  const failures = mine ? state.failures : 0;
  const status: FeedStatus =
    params === null
      ? "loading"
      : data
        ? failures
          ? "stale"
          : "ok"
        : failures >= GIVE_UP_AFTER
          ? "unavailable"
          : "loading";
  return {
    data,
    status,
    failure: mine ? state.failure : undefined,
    loading: params !== null && status === "loading",
    /** Refetch now (after a transaction, for example). */
    refresh: () => setTick((t) => t + 1),
  };
}
export type Feed<N extends RouteName> = ReturnType<typeof useApi<N>>;
