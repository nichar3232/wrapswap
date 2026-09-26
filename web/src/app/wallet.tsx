import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { DEMO, type Address, type Deployment } from "@wrapswap/types";
import { config } from "../config";
import { useApi } from "../hooks/useApi";
import {
  disconnectWallet,
  expectedChain,
  readChainId,
  requestAccount,
  simulatedWallet,
  subscribeWallet,
  switchToExpectedChain,
  tokenBalances,
} from "../wallet";
import { humanize } from "./tx";

type Balances = { status: "loading" | "ok" | "unavailable"; values: Record<string, bigint> };

function useWalletState(d: Deployment | undefined) {
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

  const connect = useCallback(async () => {
    setBusy("connect");
    setNotice("");
    try {
      const account = await requestAccount(d);
      setAddress(account);
      setChainId(await readChainId());
    } catch (e) {
      setNotice(humanize(e));
    } finally {
      setBusy(null);
    }
  }, [d]);

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

  const disconnect = useCallback(() => {
    void disconnectWallet();
    setAddress(undefined);
    setChainId(null);
    setNotice("");
  }, []);

  // Issuer-token balances: demo balances in mock mode, RPC reads live (refreshed every 15 s and after transactions).
  const tokens = d?.tokens;
  useEffect(() => {
    if (!address || !tokens) return;
    if (config.useMocks || simulatedWallet()) {
      setBalances((b) =>
        b.status === "ok"
          ? b
          : {
              status: "ok",
              values: Object.fromEntries(
                tokens.map((t) => [
                  t.address,
                  DEMO.balances.demo[t.symbol as keyof typeof DEMO.balances.demo] ?? 0n,
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
  }, [address, tokens, tick]);

  /** Mock mode: apply a simulated transfer so balances move with the demo. */
  const adjust = useCallback((token: Address, delta: bigint) => {
    if (!config.useMocks && !simulatedWallet()) return setTick((t) => t + 1);
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
export function WalletProvider({ d, children }: { d: Deployment | undefined; children: ReactNode }) {
  return <Ctx.Provider value={useWalletState(d)}>{children}</Ctx.Provider>;
}
export const useWallet = () => useContext(Ctx)!;
