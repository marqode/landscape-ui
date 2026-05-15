# API Contract Tests

Headless Playwright tests. Validate UI TypeScript interfaces against real Docker backend JSON shape. No browser UI render. Fast.

See [docs/integration-testing.md](../../docs/integration-testing.md) for architecture.

---

## Triggering in CI

Runs automatically in `.github/workflows/integration-tests.yml`. Runs *before* UI integration tests. Fails fast if backend schema changes break UI types.

---

## Running locally

### Prerequisites

- Docker + Docker Compose v2 (backend stack up)
- Admin account seeded
- Same setup as `e2e/docker-stack/ui`

### Start Backend

```bash
# In landscape-packaging/docker/ui-dev/
make up
```

### Run Tests

Run ONLY API contract tests. Skip slow browser tests.

```bash
pnpm exec playwright test --config playwright.api-contract.config.ts
```

Report writes to `playwright-api-contract-report/`.

---

## Adding new tests

Create `*.spec.ts` in `e2e/docker-stack/api/`.

```ts
// e2e/docker-stack/api/my-feature.spec.ts
import { test, expect } from "@playwright/test";

test.describe("My Feature API Contract", () => {
  test("GET /api/v2/feature returns Feature shape", async ({ request }) => {
    const res = await request.get("/api/v2/feature");
    expect(res.ok()).toBeTruthy();
    
    const body = await res.json();
    expect(body).toHaveProperty("id");
  });
});
```

`global-setup.ts` handles auth. `request` object uses session cookie automatically.
