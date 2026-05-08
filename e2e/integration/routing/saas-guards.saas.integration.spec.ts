/**
 * SaaS mode route guards
 *
 * WHAT THIS TESTS
 * ───────────────
 * Verifies that self-hosted-only routes redirect to /env-error when the
 * dashboard runs in SaaS mode (VITE_SELF_HOSTED_ENV=false).
 *
 * All /repositories/* routes are wrapped in <SelfHostedGuard>. When
 * isSelfHosted is false the guard calls navigate('/env-error', { replace: true })
 * before rendering any page content.
 *
 * This test does NOT exercise the debarchive service — it relies entirely on
 * the Vite dev server mode. Replace or extend with live SaaS API tests in
 * Phase 3 once a SaaS backend environment is available.
 *
 * AUTH
 * ────
 * Auth is still required (the auth guard fires before the self-hosted guard).
 * The storageState from global-setup is reused — the same Phase 1 backend
 * serves the login flow.
 */
import { expect, test } from "@playwright/test";

test.use({ storageState: "e2e/integration/.auth/state.json" });

const SELF_HOSTED_ONLY_ROUTES = [
  "/repositories/publication-targets",
  "/repositories/publications",
  "/repositories/mirrors",
  "/repositories/local-repositories",
];

test.describe("SaaS mode route guards", () => {
  for (const route of SELF_HOSTED_ONLY_ROUTES) {
    test(`${route} redirects to /env-error`, async ({ page }) => {
      await page.goto(route);
      await page.waitForURL("**/env-error", { timeout: 10_000 });
      await expect(page).toHaveURL(/\/env-error/);
    });
  }
});
