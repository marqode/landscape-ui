import { test, expect } from "@playwright/test";

// Re-use the session authenticated in global-setup — no login step needed.
test.use({ storageState: "e2e/integration/.auth/state.json" });

test.describe("instances list (real backend)", () => {
  test("renders sample computers from the real API", async ({ page }) => {
    await page.goto("/instances");

    await expect(page.getByRole("main")).toBeVisible();

    // Wait for the table to mount (LoadingState replaced by InstanceList)
    await expect(page.getByRole("table")).toBeVisible({ timeout: 15_000 });

    // sample.py seeds at least one computer — assert a table row is visible.
    // The first <tr> after the header row contains a computer entry.
    const dataRows = page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasNot: page.getByRole("columnheader") });

    await expect(dataRows.first()).toBeVisible({ timeout: 15_000 });
  });
});
