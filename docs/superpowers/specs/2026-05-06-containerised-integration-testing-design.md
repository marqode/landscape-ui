# Design Doc: Containerised Integration Testing in CI

**Date:** 2026-05-06\
**Status:** Draft\
**Scope:** `landscape-ui` CI pipeline — adds a `workflow_dispatch`-triggered integration test workflow that spins up the full backend stack (landscape-server + landscape-go) in containers and runs Playwright tests against it.

---

## 1. Problem Statement

All Playwright tests today run against an external pre-existing environment injected via GitHub Actions environment variables. That environment is:

- Shared and mutable — no isolation between runs.
- Not guaranteed to be at `main` — its version is opaque to CI.
- Unavailable for contributors without access to Canonical's self-hosted Landscape environment.

Vitest unit tests use MSW and have no integration gap, but Playwright tests cannot safely assert end-to-end API contract fidelity.

The goal is a CI job that:

1. Boots landscape-server and landscape-go from their `main` branches as containers.
2. Seeds a test account and sample data.
3. Builds and previews landscape-ui pointing to those containers.
4. Runs a scoped set of Playwright tests that make real HTTP calls.

---

## 2. Architecture

### 2.1 High-level flow

```
┌─────────────────────── GitHub Actions runner ───────────────────────────┐
│                                                                         │
│  1. Checkout landscape-ui (this repo, current branch) → workspace root  │
│  2. Checkout landscape-packaging (PAT) → .landscape-packaging/          │
│  3. docker compose up -d (Phase 1 service list, no debarchive)          │
│         postgresql  ──healthcheck──►  builder (schema init)             │
│         rabbitmq    ──healthcheck──►  api, appserver, …                 │
│  4. Wait for auth path to be ready                                      │
│  5. Seed: bootstrap-account → sample.py                                 │
│  6. pnpm build:e2e + pnpm preview (Playwright owns the server)          │
│  7. playwright test --config playwright.integration.config.ts           │
│  8. Upload report, teardown stack                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Repository checkout strategy

The workflow checks out two repositories independently:

1. **This repo** — normal `actions/checkout` into the workspace root. This is the landscape-ui being tested.
2. **`canonical/landscape-packaging`** — checked out with `submodules: recursive` using `LANDSCAPE_PACKAGING_TOKEN` into `path: .landscape-packaging`. This provides `landscape-server/`, `landscape-go/`, and `docker/ui-dev/` without any submodule patching.

Docker Compose is then run from `.landscape-packaging/docker/ui-dev/`. The `landscape-ui` service inside the compose stack is excluded by its `profiles: [ui]` guard and is never built or started — the workflow uses the normally-checked-out repo instead.

This replaces the previous submodule-override approach, which was unnecessary: CI never starts the `landscape-ui` Docker container.

### 2.3 Compose stack for CI

`docker/ui-dev/compose.yaml` is used unmodified. Key points:

- The `landscape-ui` service uses `profiles: [ui]` — excluded by default. ✓
- `develop.watch` is inert without the explicit `--watch` flag. ✓
- A unique project name (`ls-integration-${{ github.run_id }}`) isolates concurrent runs.

**Phase 1 service list** — only services required by login and computers-list flows:

```bash
docker compose -p "ls-integration-${RUN_ID}" up -d \
  postgresql rabbitmq rsyslog builder \
  package-search api appserver fake-openid
```

`async-frontend`, `hostagent-messenger`, `hostagent-consumer`, `pingserver`, `message-server`, `job-handler`, `package-upload`, `debarchive`, `debarchive-seeder`, `haproxy`, and `cert-generator` are excluded. Each excluded service is either not needed for the tested flows or adds startup time without providing contract value in Phase 1. The debarchive stack (including its seeder) is added in Phase 2 when debarchive flows are tested.

### 2.4 Readiness and account seeding

Waiting on `http://localhost:9091/` alone does not confirm the auth path is fully operational. The workflow polls both the API and appserver before proceeding:

```bash
timeout 180 bash -c 'until curl -sf http://localhost:9091/ && curl -sf http://localhost:8080/; do sleep 5; done'
```

Once both are healthy, seeding runs in two steps:

**Step 1 — Account bootstrap:**
```bash
docker compose -p "ls-integration-${RUN_ID}" exec -T api \
  uv run bootstrap-account \
  --admin_email "$CI_ADMIN_EMAIL" \
  --admin_name "CI Test Admin" \
  --admin_password "$CI_ADMIN_PASSWORD" \
  --root_url "http://localhost:4173/"
```

**Step 2 — Sample data:**
```bash
docker compose -p "ls-integration-${RUN_ID}" exec -T api \
  uv run sample
```

`sample.py` creates deterministic sample computers and activities that integration tests can assert against. Including it in Phase 1 makes the computers-list smoke test viable without further setup, and mirrors how the landscape-packaging local dev environment is bootstrapped.

The password is generated once per run with `openssl rand -hex 16`, stored in `$GITHUB_ENV`, and never printed. `CI_ADMIN_EMAIL` is a fixed known value (e.g. `ci-admin@example.com`) set as a workflow-level env var.

### 2.5 UI build and serve

`pnpm build:e2e` compiles the app with absolute API URLs baked in, then Playwright owns the preview server lifecycle via its `webServer` block in `playwright.integration.config.ts`.

Build env vars (no proxy needed — absolute URLs only):

```
VITE_API_URL=http://localhost:9091/api/v2/
VITE_API_URL_OLD=http://localhost:9091/api/
VITE_API_URL_DEB_ARCHIVE=http://localhost:8000/v1beta1/
VITE_ROOT_PATH=/
VITE_SELF_HOSTED_ENV=true
VITE_MSW_ENABLED=false
```

`VITE_API_PROXY_TARGET` and `VITE_API_DEBARCHIVE_PROXY_TARGET` are omitted — they are only meaningful for the Vite dev server proxy and have no effect on a production preview build. `VITE_API_URL_DEB_ARCHIVE` is included for completeness; debarchive is not in the Phase 1 stack but the build value is correct for Phase 2.

---

## 3. GitHub Actions Workflow

**Path:** `.github/workflows/integration-tests.yml`

**Trigger:** `workflow_dispatch` only (Phase 1). Expanding to push/schedule gates deferred until stack startup time is measured and proven stable.

**Runner:** `ubuntu-latest` (GitHub-hosted, 7 GB RAM). A commented-out `[self-hosted, Linux, large]` alternative is included — self-hosted is strongly preferred once a pool is available due to Docker layer cache and memory headroom.

**Secret required:** `LANDSCAPE_PACKAGING_TOKEN` — a fine-grained or classic PAT with `contents: read` on `canonical/landscape-packaging`, `canonical/landscape-server`, and `canonical/landscape-go`.

**Timeout:** 45 minutes (cold Docker builds on GitHub-hosted runners are slow).

**Key steps (order):**

| #   | Step                               | Notes                                                                                    |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Checkout landscape-ui              | Normal checkout, workspace root, current branch                                          |
| 2   | Checkout landscape-packaging       | `token: LANDSCAPE_PACKAGING_TOKEN`, `submodules: recursive`, `path: .landscape-packaging` |
| 3   | Generate ephemeral password        | `openssl rand -hex 16 >> $GITHUB_ENV`                                                    |
| 4   | Start backend stack                | `docker compose up -d` with explicit Phase 1 service list                                |
| 5   | Wait for API + appserver           | Poll both `:9091` and `:8080` before proceeding                                          |
| 6   | Seed: bootstrap-account            | `docker compose exec -T api uv run bootstrap-account` (underscored flags)                |
| 7   | Seed: sample data                  | `docker compose exec -T api uv run sample`                                               |
| 8   | Install pnpm + Node                | pnpm 10, Node 24                                                                         |
| 9   | pnpm install                       | `--frozen-lockfile`                                                                      |
| 10  | Build UI                           | `pnpm run build:e2e` with absolute integration env vars                                  |
| 11  | Install Playwright                 | `playwright install --with-deps chromium`                                                |
| 12  | Run tests                          | `playwright test --config playwright.integration.config.ts`                              |
| 13  | Upload report                      | `if: always()`, 14-day retention                                                         |
| 14  | Teardown                           | `if: always()`, `docker compose down --remove-orphans --volumes`                         |

---

## 4. Playwright Integration Config

Integration tests use a **separate config file** (`playwright.integration.config.ts`) rather than a new project entry in the existing `playwright.config.ts`. This avoids conflicts with the global `webServer`, `testDir`, `testMatch`, and `baseURL` settings that assume the MSW-backed stack.

Key config:

```ts
// playwright.integration.config.ts
export default defineConfig({
  testDir: "e2e/docker-stack/ui",
  testMatch: "**/*.integration.spec.ts",
  workers: 1,           // shared backend state; no parallel mutation
  retries: 1,
  globalSetup: "./e2e/docker-stack/ui/global-setup.ts",

  webServer: {
    command: "pnpm preview",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 60_000,
  },

  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
});
```

**`global-setup.ts`** runs before any test and:
1. Validates `CI_ADMIN_EMAIL` and `CI_ADMIN_PASSWORD` are set — fails fast if missing.
2. Makes one authenticated API request to confirm the seeded account is reachable.
3. Logs in via Playwright and writes `storageState` to `e2e/docker-stack/ui/.auth/state.json` so individual tests skip the login flow.

**`workers: 1`** is required in Phase 1. The backend is a shared mutable instance; parallel writes would introduce flakiness immediately. Tests are read-only against sample data.

---

## 5. Phase 1 Smoke Tests

Two test files. Both reuse the `storageState` written by `global-setup.ts` — no per-test login needed.

### `e2e/docker-stack/ui/auth/login.integration.spec.ts`

Does **not** use storageState (explicitly tests the login flow itself):
- Navigates to `/login` in a fresh browser context
- Fills `CI_ADMIN_EMAIL` and `CI_ADMIN_PASSWORD` from env
- Submits the form
- Asserts redirect to dashboard (`/overview`)

### `e2e/docker-stack/ui/computers/computers.integration.spec.ts`

Uses storageState (authenticated):
- Navigates to the computers list route
- Asserts that the page renders the sample computer(s) created by `uv run sample`
- Verifies visible computer name/status (deterministic against seeded data)

This validates the real `GET /api/v2/computers` response shape makes it to the UI. Tests do not use any MSW fixtures or route interceptors. Integration fixtures must not reuse `e2e/support/fixtures/auth.ts` — that file mocks `**/standalone-account` by default and hardcodes credentials from `constants.ts`.

---

## 6. Documentation

`docs/integration-testing.md` covers:

- What the integration tests are and why they exist
- How to trigger the workflow (GitHub Actions → workflow_dispatch)
- How to run locally (using the `docker/ui-dev` stack + `pnpm dev` in landscape-ui)
- Required secret (`LANDSCAPE_PACKAGING_TOKEN`) and how to set it
- Phase 1 scope and known limitations
- Phase 2 roadmap items

---

## 7. Implementation Phases

### Phase 1 — Foundation (this PR)

- [ ] `.github/workflows/integration-tests.yml` (workflow_dispatch trigger)
- [ ] Add `integration` project to `playwright.config.ts`
- [ ] `e2e/docker-stack/ui/auth/login.integration.spec.ts`
- [ ] `e2e/docker-stack/ui/computers/computers.integration.spec.ts`
- [ ] `docs/integration-testing.md`

### Phase 2 — Sample data expansion and SaaS mode

- [ ] Add debarchive stack to the service list and run `debarchive-seed-curl.sh` after `sample.py`
- [ ] Add matrix for SaaS mode — requires switching **both** `LANDSCAPE_DEPLOYMENT_MODE=default` (compose env) **and** `VITE_SELF_HOSTED_ENV=false` (UI build). Flipping only the UI env against a standalone backend is invalid.
- [ ] Expand test coverage to cover mutations (create tag, run activity)
- [ ] Measure cold-start time; investigate Docker layer caching on self-hosted runners

### Phase 3 — PR gating

- [ ] Add integration workflow as a required check on PRs to `dev`/`main` (after Phase 2 stability proven)
- [ ] Add per-PR branch matching for backend repos (try same branch name, fall back to `main`)
- [ ] Add nightly schedule trigger

---

## 8. Risks and Open Questions

| Risk / Question | Impact | Mitigation |
|-----------------|--------|------------|
| Non-determinism from shared mutable backend | High | `workers: 1`; Phase 1 tests are read-only against seeded data |
| GitHub-hosted runner cold-start for Docker builds (10–25 min) | Medium | Acceptable for workflow_dispatch; measure before adding push/schedule triggers |
| `uv run sample` command interface not verified | Medium | Verify against landscape-server main before Phase 1 merges |
| Docker network conflicts between concurrent runs | Low | Unique project name `-p ls-integration-${{ github.run_id }}` |
| `LANDSCAPE_PACKAGING_TOKEN` scope must cover submodule repos | Medium | Use a classic PAT with `repo` scope or org-scoped fine-grained PAT |
| SaaS mode requires full-stack switch, not just UI flag | High (Phase 2) | Matrix both `LANDSCAPE_DEPLOYMENT_MODE` and `VITE_SELF_HOSTED_ENV` together |
| Sensitive credentials exposed in logs | Low | Password generated per-run, stored in env, never echoed |

---

## 9. Out of Scope

- Running Vitest unit tests against a real backend (MSW-based, no real backend needed)
- Modifying `docker/ui-dev/compose.yaml` for the sole purpose of CI
- landscape-client integration (device registration, activity execution)
- Performance or load testing
- The `loki_img.tar` artifact from `docker/ui-dev/` — not required for the core stack
