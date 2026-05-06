import { defineConfig } from "@playwright/test";

const BASE_URL = "http://localhost:4173";

export default defineConfig({
  testDir: "e2e/integration",
  testMatch: "**/*.integration.spec.ts",

  // Shared backend is mutable; read-only tests only in Phase 1
  workers: 1,
  fullyParallel: false,
  retries: 1,
  forbidOnly: !!process.env.CI,

  globalSetup: "./e2e/integration/global-setup.ts",

  reporter: [["html", { open: "never", outputFolder: "playwright-integration-report" }], ["list"]],

  // Playwright owns the preview server lifecycle.
  // Run `pnpm run build:e2e` with integration env vars before running tests.
  webServer: {
    command: "pnpm preview",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: ["--disable-web-security"],
    },
  },
});
