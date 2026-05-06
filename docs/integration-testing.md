# Integration Testing

Integration tests run Playwright against a real Landscape backend stack (landscape-server + landscape-go) running in Docker containers. They complement the existing MSW-backed E2E tests by verifying real API contract fidelity.

## What they test (Phase 1)

- Login via standalone auth with a seeded admin account
- Instances list rendered from a real `GET /api/v2/computers` response

## How to trigger in CI

1. Go to **Actions → Integration Tests** in GitHub.
2. Click **Run workflow** (this is a `workflow_dispatch`-triggered workflow).
3. The workflow accepts `server_ref` / `go_ref` inputs, but they are **reserved for future use** — the backend is currently pinned to `main` via the `landscape-packaging` submodule.

**Required secret:** `LANDSCAPE_PACKAGING_TOKEN` — a PAT with `repo` scope on `canonical/landscape-packaging` (and its submodules `canonical/landscape-server`, `canonical/landscape-go`). Set this in **Settings → Secrets and variables → Actions**.

## How to run locally

### Prerequisites

- Docker + Docker Compose v2
- Go (for `go mod vendor` — pre-installed on most dev machines; `sudo snap install go --classic` on Ubuntu)
- Access to `canonical/landscape-packaging` cloned somewhere (e.g. `~/landscape-packaging`)
- `pnpm` and Node 24 installed in this repo

### 0. Create your local credentials file (one-time)

Create `.env.integration.local` in this repo's root (gitignored):

```ini
CI_ADMIN_EMAIL=ci-admin@example.com
CI_ADMIN_PASSWORD=mysecret
```

These must match the credentials you pass to `make up` in the next step.

### 1. Start the backend stack

From your `landscape-packaging/docker/ui-dev/` directory. `LANDSCAPE_BOOTSTRAP_SCHEMA_ARGS` tells the schema script to create the admin account and seed computer data at startup:

```bash
CI_ADMIN_EMAIL=ci-admin@example.com
CI_ADMIN_PASSWORD=mysecret

LANDSCAPE_BOOTSTRAP_SCHEMA_ARGS="--with-computers --admin-email $CI_ADMIN_EMAIL --admin-name 'CI Test Admin' --admin-password $CI_ADMIN_PASSWORD" \
  make up
```

Wait until both `http://localhost:9091/api/v2/` and `http://localhost:8080/` respond.

### 2. Build landscape-ui for integration

From this repo's root. The integration vars are pre-configured in `.env.e2e`, which Vite loads automatically for this build mode:

```bash
pnpm run build:e2e
```

### 2b. Install Playwright browsers (first time or after upgrades)

```bash
pnpm exec playwright install chromium
```

### 3. Run integration tests

```bash
pnpm exec playwright test --config playwright.integration.config.ts
```

Credentials are loaded automatically from `.env.integration.local`.

The HTML report is written to `playwright-integration-report/`.

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| Separate `playwright.integration.config.ts` | Avoids conflicts with MSW-backed `playwright.config.ts` (`webServer`, `testDir`, `baseURL`) |
| `workers: 1` | Shared mutable backend; Phase 1 tests are read-only against seeded data |
| `globalSetup` writes `storageState` | Individual tests skip login; login is tested once explicitly |
| Absolute API URLs in build | `pnpm preview` doesn't run Vite's dev proxy; absolute URLs work without it |
| Explicit service list in `docker compose up` | Avoids building debarchive (not needed in Phase 1), reducing cold-start time |

## Phase 2 roadmap

- Add debarchive stack + `debarchive-seed-curl.sh` seeding
- SaaS mode matrix: requires **both** `LANDSCAPE_DEPLOYMENT_MODE=default` (compose) **and** `VITE_SELF_HOSTED_ENV=false` (UI build)
- Expand to mutation tests (create tag, run activity)
- Add nightly schedule + push-to-main triggers after stability is proven
