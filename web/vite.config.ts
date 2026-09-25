import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.API_PORT || 4000}`,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/rpc": {
        target: process.env.LOCAL_RPC || "http://127.0.0.1:8545",
        rewrite: () => "",
      },
    },
  },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
