import { useEffect, useState } from "react";
import {
  routes,
  validators,
  parseDeployment,
  type RouteName,
  type RouteResponses,
} from "@wrapswap/types";
import { config } from "../config";
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
    const r = await fetch(
      (name === "crankStatus" ? config.crankUrl : config.apiUrl) + path,
      { signal },
    );
    value = await r.json();
    if (!r.ok)
      throw Error(
        (value as { error?: { message?: string } })?.error?.message ||
          `HTTP ${r.status}`,
      );
  }
  const checked = validators[route.response].assert(value);
  if (name === "deployment") {
    const d = parseDeployment(checked);
    if (d.network !== config.network)
      throw Error(`Deployment network mismatch: expected ${config.network}`);
  }
  return checked as RouteResponses[N];
}
export function useApi<N extends RouteName>(
  name: N,
  params: string | null = "",
  interval = 5000,
) {
  const [state, setState] = useState<{
    key: string;
    data?: RouteResponses[N];
    error?: string;
  }>({ key: "" });
  const key = name + ":" + params;
  useEffect(() => {
    if (params === null) return;
    const controller = new AbortController();
    const run = async () => {
      try {
        const data = await request(name, params, controller.signal);
        if (!controller.signal.aborted) setState({ key, data });
      } catch (e) {
        if (!controller.signal.aborted) setState({ key, error: String(e) });
      }
    };
    void run();
    const timer = setInterval(run, interval);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [name, params, interval, key]);
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    loading:
      params !== null && (state.key !== key || (!state.data && !state.error)),
  };
}
