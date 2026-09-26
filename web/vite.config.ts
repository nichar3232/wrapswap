import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    root: "web",
    envDir: "..",
    plugins: [react()],
    preview: {
      host: "127.0.0.1",
      port: Number(env.WEB_PORT || 13005),
      strictPort: true,
    },
    server: {
      host: "127.0.0.1",
      port: Number(env.WEB_PORT || 13005),
      strictPort: true,
      proxy: {
        // Demo relay (services/relay), served as /api/demo/* like scripts/dev/serve-web.mjs. Listed before /api.
        "/api/demo": {
          target: `http://127.0.0.1:${env.RELAY_PORT || 18210}`,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
        "/api": {
          target: `http://127.0.0.1:${env.API_PORT || 18005}`,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
        "/crank": {
          target: `http://127.0.0.1:${env.CRANK_HEALTH_PORT || 18105}`,
          rewrite: (p) => p.replace(/^\/crank/, ""),
        },
        "/rpc": {
          target:
            env.VITE_RPC_URL || `http://127.0.0.1:${env.ANVIL_PORT || 18505}`,
          rewrite: () => "",
        },
      },
    },
    build: { outDir: "../dist/web", emptyOutDir: true },
  };
});
