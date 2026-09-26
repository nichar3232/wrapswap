import { defineConfig } from "@playwright/test";
const port = Number(process.env.WEB_PORT || 13005);
export default defineConfig({
  testDir: "tests",
  testMatch:
    process.env.VITE_USE_MOCKS === "false" ? "api.spec.ts" : "smoke.spec.ts",
  fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  reporter: "list",
  webServer: {
    command: "node node_modules/vite/bin/vite.js --config web/vite.config.ts",
    cwd: "..",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: {
      WEB_PORT: String(port),
      VITE_USE_MOCKS: process.env.VITE_USE_MOCKS || "true",
      VITE_NETWORK: process.env.VITE_NETWORK || "anvil",
    },
  },
});
