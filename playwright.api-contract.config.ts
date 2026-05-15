import { defineConfig } from "@playwright/test";

const BASE_URL = "http://localhost:5173";

export default defineConfig({
  testDir: "e2e/docker-stack/api",
  testMatch: "**/*.spec.ts",

  workers: 1,
  fullyParallel: false,
  retries: 1,
  forbidOnly: !!process.env.CI,

  globalSetup: "./e2e/docker-stack/ui/global-setup.ts",

  reporter: [["html", { open: "never", outputFolder: "playwright-api-contract-report" }], ["list"]],

  webServer: {
    command: "vite --mode e2e",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
    storageState: "e2e/docker-stack/ui/.auth/state.json",
  },
});
