import { chromium, type FullConfig } from "@playwright/test";
import fs from "fs";
import path from "path";

const STORAGE_STATE_PATH = "e2e/integration/.auth/state.json";
// Must match playwright.integration.config.ts › use.baseURL; FullConfig is not
// reliably populated when globalSetup runs ahead of webServer startup.
const BASE_URL = "http://localhost:4173";
const API_URL = "http://localhost:9091/api/v2/";

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const email = process.env.CI_ADMIN_EMAIL;
  const password = process.env.CI_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      [
        "Integration tests require CI_ADMIN_EMAIL and CI_ADMIN_PASSWORD.",
        "In CI these are set by the workflow. Locally, export them before running:",
        "  export CI_ADMIN_EMAIL=ci-admin@example.com",
        "  export CI_ADMIN_PASSWORD=<your-password>",
      ].join("\n"),
    );
  }

  // Verify the seeded account is reachable before launching a browser.
  let apiReachable = false;
  try {
    const res = await fetch(API_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    apiReachable = res.status < 500;
  } catch {
    // intentional
  }
  if (!apiReachable) {
    throw new Error(
      `Backend API not reachable at ${API_URL}.\n` +
        "Ensure the backend stack is running: see docs/integration-testing.md",
    );
  }

  // Log in once and write storageState so individual tests skip the login flow.
  fs.mkdirSync(path.dirname(STORAGE_STATE_PATH), { recursive: true });

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();

    await page.goto("/login");
    await page.locator('input[name="identifier"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/overview/, { timeout: 30_000 });

    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await browser.close();
  }
}
