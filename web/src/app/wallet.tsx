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
} from "../wallet";
import { humanize } from "./tx";

type Balances = { status: "loading" | "ok" | "unavailable"; values: Record<string, bigint> };

function useWalletState(d: Deployment | undefined, tokens: Token[] | undefined) {
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number | null>(null);
  const [busy, setBusy] = useState<"connect" | "switch" | null>(null);
  const [notice, setNotice] = useState("");
  const [balances, setBalances] = useState<Balances>({ status: "loading", values: {} });
  const [tick, setTick] = useState(0);
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
      setBusy("connect");
      setNotice("");
      try {
        const account = await requestAccount(d);
        setAddress(account);
        setChainId(await readChainId());
      } catch (e) {
        if (!quiet) setNotice(humanize(e));
      } finally {
        setBusy(null);
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
