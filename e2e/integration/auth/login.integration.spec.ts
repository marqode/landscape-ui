import { test, expect } from "@playwright/test";

const email = (): string => {
  const v = process.env.CI_ADMIN_EMAIL;
  if (!v) throw new Error("CI_ADMIN_EMAIL not set");
  return v;
};

const password = (): string => {
  const v = process.env.CI_ADMIN_PASSWORD;
  if (!v) throw new Error("CI_ADMIN_PASSWORD not set");
  return v;
};

test.describe("login (real backend)", () => {
  test("signs in with seeded admin credentials and lands on overview", async ({
    page,
  }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("heading", { name: /sign in/i }),
    ).toBeVisible();

    await page.locator('input[name="identifier"]').fill(email());
    await page.locator('input[name="password"]').fill(password());
    await page.locator('button[type="submit"]').click();

    await expect(page).toHaveURL(/overview/, { timeout: 30_000 });
  });
});
