/**
 * Integration test: scripts page render and create/list round-trip
 *
 * WHAT IS TESTED
 * ──────────────
 * 1. The /scripts route renders and shows the "Scripts" heading when the real
 *    backend is available (even with an empty scripts list).
 * 2. A script created through the UI (Add script side panel) appears in the
 *    list immediately after submission — confirming the POST → list refresh
 *    round-trip works end-to-end.
 *
 * WHY UI CREATION (NOT DIRECT API)
 * ─────────────────────────────────
 * The create endpoint is the *old* API: POST /api/ with
 * ?action=CreateScript&version=2 and form-encoded body. Constructing that
 * request correctly from a test requires knowing the exact version constant
 * (VITE_API_VERSION, which may be undefined in the e2e env). Using the UI
 * avoids that fragility and also exercises the real form submission path.
 *
 * MONACO EDITOR INTERACTION
 * ──────────────────────────
 * The Code field is a Monaco editor rendered as a plain div (no iframe).
 * We click the `.monaco-editor` container to focus it, then use
 * `page.keyboard.type()` to inject script content. This is the standard
 * Playwright approach for Monaco.
 *
 * AUTH STRATEGY
 * ─────────────
 * `test.use({ storageState })` re-uses the session cookie written by
 * global-setup. No explicit login step is needed. For API-level cleanup in
 * afterAll we call `GET /api/v2/me` (cookie-authenticated) to obtain the JWT,
 * then `POST /api/v2/scripts/<id>:redact` with `Authorization: Bearer <token>`.
 */
import { expect, test } from "@playwright/test";

// Re-use the session authenticated in global-setup.
test.use({ storageState: "e2e/integration/.auth/state.json" });

// ─── helpers ────────────────────────────────────────────────────────────────

interface AuthUser {
  token: string;
  [key: string]: unknown;
}

/** Fetch the JWT for subsequent authenticated API calls. */
async function getAuthToken(
  request: import("@playwright/test").APIRequestContext,
): Promise<string> {
  const res = await request.get("/api/v2/me");
  expect(res.ok(), `GET /api/v2/me failed: ${res.status()}`).toBe(true);
  const body = (await res.json()) as AuthUser;
  expect(
    typeof body.token,
    "GET /api/v2/me did not return a token — is the session cookie valid?",
  ).toBe("string");
  return body.token;
}

/** Redact (delete) a script by id via the v2 API. */
async function redactScript(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  scriptId: number | string,
): Promise<void> {
  const res = await request.post(`/api/v2/scripts/${scriptId}:redact`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // 404 is acceptable if the script was already removed.
  expect(
    res.ok() || res.status() === 404,
    `POST /api/v2/scripts/${scriptId}:redact failed: ${res.status()} ${await res.text()}`,
  ).toBe(true);
}

// ─── tests ───────────────────────────────────────────────────────────────────

test.describe("scripts page (real backend)", () => {
  // Shared state across tests in this describe block (workers=1, sequential).
  let createdScriptId: number | string | null = null;

  test.afterAll(async ({ request }) => {
    // Clean up the script created in test 2 if it wasn't already removed.
    if (createdScriptId !== null) {
      const token = await getAuthToken(request);
      await redactScript(request, token, createdScriptId);
      createdScriptId = null;
    }
  });

  test("page renders and shows Scripts heading", async ({ page }) => {
    await page.goto("/scripts");
    await expect(page.getByRole("main")).toBeVisible();
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /scripts/i }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("script created via UI appears in the list", async ({
    page,
    request,
  }) => {
    const scriptTitle = `ci-test-script-${Date.now()}`;
    const scriptCode = "#!/bin/bash\necho 'integration test'";

    // ── 1. Navigate to /scripts ─────────────────────────────────────────────
    await page.goto("/scripts");
    await page.waitForLoadState("networkidle");

    // ── 2. Open the Add script side panel ───────────────────────────────────
    await page.getByRole("button", { name: /add script/i }).click();

    // ── 3. Fill the Title field ──────────────────────────────────────────────
    await page.getByLabel("Title").fill(scriptTitle);

    // ── 4. Fill the Code field (Monaco editor) ───────────────────────────────
    // Monaco renders as a plain div — click to focus, then type.
    const monacoEditor = page.locator(".monaco-editor").first();
    await monacoEditor.click();
    await page.keyboard.type(scriptCode);

    // ── 5. Submit the form ───────────────────────────────────────────────────
    // The submit button inside the side panel has text "Add script".
    await page
      .locator("[data-testid='side-panel'], [role='dialog'], aside")
      .first()
      .getByRole("button", { name: /add script/i })
      .click()
      .catch(async () => {
        // Fallback: find any visible "Add script" button that is not the header one.
        const buttons = page.getByRole("button", { name: /add script/i });
        const count = await buttons.count();
        // Click the last one (the submit button inside the panel).
        await buttons.nth(count - 1).click();
      });

    // ── 6. Wait for the panel to close and the list to refresh ───────────────
    await page.waitForLoadState("networkidle");

    // ── 7. Verify the new script title appears in the list ───────────────────
    await expect(page.getByText(scriptTitle)).toBeVisible({ timeout: 15_000 });

    // ── 8. Capture the script id for cleanup ─────────────────────────────────
    // Fetch the list from the API to find the id of the script we just created.
    const token = await getAuthToken(request);
    const listRes = await request.get("/api/v2/scripts", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (listRes.ok()) {
      interface ScriptItem {
        id: number | string;
        title: string;
        [key: string]: unknown;
      }
      interface ScriptList {
        results?: ScriptItem[];
        [key: string]: unknown;
      }
      const body = (await listRes.json()) as ScriptList;
      const scripts: ScriptItem[] = Array.isArray(body)
        ? (body as ScriptItem[])
        : (body.results ?? []);
      const created = scripts.find((s) => s.title === scriptTitle);
      if (created) {
        createdScriptId = created.id;
      }
    }
  });
});
