import { parseNetwork } from "@wrapswap/types";
const env = import.meta.env;
export const config = {
  network: parseNetwork(env.VITE_NETWORK),
  apiUrl: (env.VITE_API_URL || "/api").replace(/\/$/, ""),
  crankUrl: (env.VITE_CRANK_URL || "/crank").replace(/\/$/, ""),
  rpcUrl: env.VITE_RPC_URL || "/rpc",
  useMocks: env.VITE_USE_MOCKS === "true",
};
