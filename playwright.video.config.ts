import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/video',
  workers: 1,
  timeout: 180000,
  use: { video: { mode: 'on', size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 }, launchOptions: { slowMo: 1500 } },
});
