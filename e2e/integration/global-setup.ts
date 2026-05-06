import { chromium, type FullConfig } from "@playwright/test";
import fs from "fs";
import path from "path";

const STORAGE_STATE_PATH = "e2e/integration/.auth/state.json";
// Must match playwright.integration.config.ts › use.baseURL; FullConfig is not
// reliably populated when globalSetup runs ahead of webServer startup.
const BASE_URL = "http://localhost:4173";
const API_URL = "http://localhost:9091/api/v2/";
const API_TIMEOUT_MS = 5_000;
const HTTP_SERVER_ERROR_MIN = 500;
const ENV_FILE = ".env.integration.local";

// Load local credentials file if present (gitignored). Values already in
// process.env (e.g. from CI) take precedence because override is false.
if (fs.existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const email = process.env.CI_ADMIN_EMAIL;
  const password = process.env.CI_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      [
        "Integration tests require CI_ADMIN_EMAIL and CI_ADMIN_PASSWORD.",
        `Locally, create ${ENV_FILE} with:`,
        "  CI_ADMIN_EMAIL=ci-admin@example.com",
        "  CI_ADMIN_PASSWORD=<your-password>",
      ].join("\n"),
    );
  }

  // Verify the seeded account is reachable before launching a browser.
  let apiReachable = false;
  try {
    const res = await fetch(API_URL, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    apiReachable = res.status < HTTP_SERVER_ERROR_MIN;
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

    const form = page.locator('input[name="identifier"]');
    const formVisible = await form.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
    if (!formVisible) {
      await page.screenshot({ path: "e2e/integration/.auth/login-debug.png" });
      throw new Error(
        "Login form did not appear at /login.\n" +
          "The password login method may not be enabled. Ensure bootstrap-account ran\n" +
          "on a fresh database — see docs/integration-testing.md step 1.",
      );
    }

    await form.fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/overview/, { timeout: 30_000 });

    await context.storageState({ path: STORAGE_STATE_PATH });
  } finally {
    await browser.close();
  }
}
