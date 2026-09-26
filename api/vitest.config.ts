import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["api/**/*.test.ts", "services/**/*.test.ts"],
    testTimeout: 30000,
  },
});
