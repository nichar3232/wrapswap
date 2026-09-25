import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  use: {
    baseURL: process.env.WEB_URL || "http://127.0.0.1:5173",
    headless: true,
  },
  reporter: "list",
});
