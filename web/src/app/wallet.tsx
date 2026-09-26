import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DEMO, type Address, type Deployment } from "@wrapswap/types";
import { config } from "../config";
import { useApi } from "../hooks/useApi";
import type { Token } from "./assets";
import {
  disconnectWallet,
  expectedChain,
  injected,
  isDemo,
  readChainId,
  relayInfo,
  requestAccount,
  simulatedWallet,
  subscribeWallet,
  switchToExpectedChain,
  tokenBalances,
  WalletError,
} from "../wallet";
import { humanize } from "./tx";

/** A connect attempt that hasn't answered in this long fails, so the button never sits on "Connecting…". */
export const CONNECT_TIMEOUT_MS = 5000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new WalletError("timeout")), ms))),
  ]).finally(() => clearTimeout(timer));
}

/**
 * This browser's own transactions, shown at the top of Recent fills from the moment they are sent: the indexer takes a
 * few seconds to list a Convert, a Dark Cross commit only becomes a fill when its batch settles, and a Send's legs are
 * made by the ShareVault. Per address in localStorage (a per-viewer convenience), 20 entries, 24 hours.
 */
export type Activity = { hash: string; kind: "PARITY" | "DARK-COMMIT" | "SEND"; text: string; at: number; simulated: boolean };
const ACTIVITY_TTL = 86_400_000;
const activityKey = (a: string) => `unison:activity:${a.toLowerCase()}`;
function loadActivity(a: string): Activity[] {
  try {
    const list = JSON.parse(localStorage.getItem(activityKey(a)) ?? "[]") as Activity[];
    return Array.isArray(list) ? list.filter((x) => x && typeof x.hash === "string" && Date.now() - x.at < ACTIVITY_TTL) : [];
  } catch {
    return [];
  }
}
function saveActivity(a: string, list: Activity[]) {
  try {
    localStorage.setItem(activityKey(a), JSON.stringify(list));
  } catch {
    /* private window or blocked storage: the list still lives for this page */
  }
}

type Balances = { status: "loading" | "ok" | "unavailable"; values: Record<string, bigint> };

function useWalletState(d: Deployment | undefined, tokens: Token[] | undefined) {
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number | null>(null);
  const [busy, setBusy] = useState<"connect" | "switch" | null>(null);
  const [notice, setNotice] = useState("");
  const [balances, setBalances] = useState<Balances>({ status: "loading", values: {} });
  const [tick, setTick] = useState(0);
  const [activity, setActivity] = useState<Activity[]>([]);
  useEffect(() => setActivity(address ? loadActivity(address) : []), [address]);
  const record = useCallback(
    (a: Omit<Activity, "at">) => {
      if (!address) return;
      setActivity((list) => {
        const next = [{ ...a, at: Date.now() }, ...list.filter((x) => x.hash.toLowerCase() !== a.hash.toLowerCase())].slice(0, 20);
        saveActivity(address, next);
        return next;
      });
    },
    [address],
  );
  const eligibility = useApi("eligibility", address || null);
  const expected = expectedChain();
  const wrongChain = !!address && chainId !== null && chainId !== expected.id;

  useEffect(
    () =>
      subscribeWallet({
        accounts: (a) => {
          setAddress((cur) => (cur ? a[0] : cur));
          if (!a[0]) setNotice("");
        },
        chain: (id) => setChainId(id),
      }),
    [],
  );

  const connect = useCallback(
    async (quiet = false) => {
      // A quiet (automatic) attempt leaves the button on "Connect": only a click shows "Connecting…".
      if (!quiet) setBusy("connect");
      setNotice("");
      try {
        const account = await withTimeout(requestAccount(d), CONNECT_TIMEOUT_MS);
        setAddress(account);
        setChainId(await withTimeout(readChainId(), CONNECT_TIMEOUT_MS).catch(() => null));
      } catch (e) {
        if (!quiet) setNotice(humanize(e));
      } finally {
        if (!quiet) setBusy(null);
      }
    },
    [d],
  );

  const switchChain = useCallback(async () => {
    setBusy("switch");
    setNotice("");
    try {
      await switchToExpectedChain();
      setChainId(await readChainId());
    } catch (e) {
      setNotice(humanize(e));
    } finally {
      setBusy(null);
    }
  }, []);

  // Demo: with no injected wallet, the mock wallet (tests) or the demo relay (live) connects itself once.
  const autoTried = useRef(false);
  const [relay, setRelay] = useState(false);
  useEffect(() => {
    if (autoTried.current || !d || injected()) return;
    autoTried.current = true;
    if (simulatedWallet()) return void connect(true);
    void relayInfo().then((r) => {
      setRelay(!!r);
      if (r) void connect(true);
    });
  }, [d, connect]);

  const disconnect = useCallback(() => {
    void disconnectWallet();
    setAddress(undefined);
    setChainId(null);
    setNotice("");
  }, []);

  // Wrapper balances for every asset: demo balances in mock mode, RPC reads live (every 15 s and after transactions).
  const tokenKey = tokens?.map((t) => t.address).join() ?? "";
  useEffect(() => {
    if (!address || !tokens?.length) return;
    if (config.useMocks) {
      setBalances((b) =>
        b.status === "ok"
          ? b
          : {
              status: "ok",
              values: Object.fromEntries(
                tokens.map((t) => [
                  t.address,
                  DEMO.balances.demo[t.symbol as keyof typeof DEMO.balances.demo] ??
                    (t.decimals === 6 ? 400_000000n : 400n * 10n ** 18n),
                ]),
              ),
            },
      );
      return;
    }
    let live = true;
    const read = () =>
      tokenBalances(address, tokens.map((t) => t.address)).then(
        (v) =>
          live &&
          setBalances({
            status: "ok",
            values: Object.fromEntries(tokens.map((t, i) => [t.address, v[i]])),
          }),
        () => live && setBalances((b) => ({ ...b, status: b.status === "ok" ? "ok" : "unavailable" })),
      );
    void read();
    const timer = setInterval(read, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, tokenKey, tick]);

  /** Mock mode: apply a simulated transfer so balances move with the demo. */
  const adjust = useCallback((token: Address, delta: bigint) => {
    if (!config.useMocks) return setTick((t) => t + 1);
    setBalances((b) => ({
      ...b,
      values: { ...b.values, [token]: (b.values[token] ?? 0n) + delta },
    }));
  }, []);

  return {
    address,
    chainId,
    expected,
    wrongChain,
    ready: !!address && !wrongChain,
    simulated: simulatedWallet(),
    /** Signing through the demo relay (no injected wallet). */
    relay: relay && !!address && !injected(),
    demo: isDemo(),
    busy,
    notice,
    clearNotice: () => setNotice(""),
    eligibility,
    eligible: !!eligibility.data?.eligible,
    uid: (eligibility.data?.attestationUid || undefined) as Address | undefined,
    balances,
    adjust,
    refreshBalances: () => setTick((t) => t + 1),
    activity,
    record,
    connect,
    switchChain,
    disconnect,
  };
}
export type WalletApi = ReturnType<typeof useWalletState>;
const Ctx = createContext<WalletApi | null>(null);
export function WalletProvider({ d, tokens, children }: { d: Deployment | undefined; tokens: Token[]; children: ReactNode }) {
  return <Ctx.Provider value={useWalletState(d, tokens)}>{children}</Ctx.Provider>;
}
export const useWallet = () => useContext(Ctx)!;
