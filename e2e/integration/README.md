# Integration Tests

Playwright tests that run against the Landscape backend stack in Docker.

For full architecture details, design decisions, and Phase 3 roadmap, see
[docs/integration-testing.md](../../docs/integration-testing.md).

---

## Triggering in CI

The **Integration Tests** workflow (`.github/workflows/integration-tests.yml`) runs
automatically on:

- PRs targeting `dev` (code changes only — docs/markdown paths are ignored)
- Pushes to `main` (same path filter)
- Nightly at 02:00 UTC (catches upstream backend regressions)

**Manual trigger with a custom backend ref:**

1. Go to **Actions → Integration Tests** in GitHub
2. Click **Run workflow**
3. Set `packaging_ref` to any branch, tag, or SHA from `canonical/landscape-packaging`
   (leave blank to use `main`)

> `packaging_ref` pins the backend stack. `landscape-go` and `landscape-server`
> are submodules of `landscape-packaging`, so one input controls all three.

---

## Test suites

| Suite | Config | Matches | Backend required |
|-------|--------|---------|-----------------|
| Self-hosted | `playwright.integration.config.ts` | `*.integration.spec.ts` | Yes |
| SaaS mode | `playwright.integration.saas.config.ts` | `*.saas.integration.spec.ts` | Yes |

Both suites run against the **same backend** (landscape-server + landscape-go). The
difference is the Vite build mode:

- **Self-hosted** (`--mode e2e`): `VITE_SELF_HOSTED_ENV=true`. Tests features only
  available in self-hosted deployments (debarchive, repository management, etc.).
- **SaaS mode** (`--mode e2e.saas`): `VITE_SELF_HOSTED_ENV=false`. Tests that core
  features still work via real API calls, and that self-hosted-only routes redirect to
  `/env-error` rather than rendering.

SaaS tests navigate to a page that makes a real API call first (confirming the session
and proxy are healthy under the SaaS flag), then assert on SaaS-specific behaviour. This
distinguishes frontend guard failures from backend or auth failures.

> **Future:** If the Landscape API introduces server-side SaaS feature gating, SaaS
> tests may need a dedicated SaaS backend instance. For now the same server serves both.

The naming convention is enforced by `testIgnore` in the self-hosted config — any file
ending in `.saas.integration.spec.ts` is excluded from the self-hosted run and picked up
only by the SaaS config.

---

## Running locally

### Prerequisites

- Docker + Docker Compose v2
- `canonical/landscape-packaging` cloned with submodules (e.g. `~/landscape-packaging`)
- `pnpm` + Node 24

### 1. Start the backend

```bash
# From your landscape-packaging/docker/ui-dev/ directory
make up
```

Wait for both services to respond:

```bash
curl -sf http://localhost:9091/api/v2/login/methods
curl -sf http://localhost:8080/
```

### 2. Seed the admin account (once per fresh stack)

```bash
docker exec landscape-api \
  uv run python bootstrap-account \
    --admin_email "ci-admin@example.com" \
    --admin_name "CI Test Admin" \
    --admin_password "mysecret" \
    --root_url "http://localhost:5173/"
```

Create `.env.integration.local` in the repo root (gitignored):

```ini
CI_ADMIN_EMAIL=ci-admin@example.com
CI_ADMIN_PASSWORD=mysecret
```

### 3. Install browsers (first time or after Playwright upgrades)

```bash
pnpm exec playwright install chromium
```

### 4. Run the tests

```bash
# Self-hosted mode (live backend required)
pnpm exec playwright test --config playwright.integration.config.ts

# SaaS mode (same backend, VITE_SELF_HOSTED_ENV=false)
pnpm exec playwright test --config playwright.integration.saas.config.ts
```

Reports are written to `playwright-integration-report/` and
`playwright-integration-saas-report/`.

---

## Adding new tests

### Self-hosted test

Create a file matching `*.integration.spec.ts` anywhere under `e2e/integration/`.

```ts
// e2e/integration/my-feature/my-feature.integration.spec.ts
import { test, expect } from "@playwright/test";

test.describe("my feature (real backend)", () => {
  test("does something real", async ({ page }) => {
    await page.goto("/my-feature");
    await expect(
      page.getByRole("heading", { name: "My Feature" }),
    ).toBeVisible();
  });
});
```

The global setup has already authenticated — `storageState` is applied automatically via
the Playwright config, so tests start logged in.

### SaaS mode test

Name the file `*.saas.integration.spec.ts`. These tests run with
`VITE_SELF_HOSTED_ENV=false` and do not require a live backend.

```ts
// e2e/integration/routing/my-guard.saas.integration.spec.ts
import { test, expect } from "@playwright/test";

test("self-hosted-only route redirects to /env-error in SaaS mode", async ({
  page,
}) => {
  await page.goto("/my-self-hosted-only-route");
  await page.waitForURL("**/env-error", { timeout: 10_000 });
  await expect(page).toHaveURL(/\/env-error/);
});
```

---

## Required secrets

| Secret / Variable                        | Purpose                                                         |
| ---------------------------------------- | --------------------------------------------------------------- |
| `vars.LANDSCAPE_PACKAGER_APP_ID`         | GitHub App ID                                                   |
| `secrets.LANDSCAPE_PACKAGER_PRIVATE_KEY` | GitHub App private key (PEM)                                    |
| `secrets.LANDSCAPE_PROTO_PAT`            | Fine-grained PAT for `canonical/landscape-proto` (Go vendoring) |

The GitHub App must be installed on `canonical/landscape-packaging`,
`canonical/landscape-go`, and `canonical/landscape-server`.
