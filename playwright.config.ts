import { defineConfig, devices } from "@playwright/test";

const systemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME ? "chrome" : undefined;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: { baseURL: "http://127.0.0.1:4173", trace: "on-first-retry" },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1",
    port: 4173,
    reuseExistingServer: !process.env.CI
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: systemChrome } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: systemChrome } }
  ]
});
