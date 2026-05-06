# Design Doc: Containerised Integration Testing in CI

**Date:** 2026-05-06
**Status:** Draft
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
2. Seeds a test account via `bootstrap-account`.
3. Builds and serves landscape-ui pointing to those containers.
4. Runs a scoped set of Playwright tests that make real HTTP calls.

---

## 2. Architecture

### 2.1 High-level flow

```
┌─────────────────────── GitHub Actions runner ──────────────────────────┐
│                                                                          │
│  1. Checkout landscape-packaging (PAT) with submodules                  │
│  2. Override landscape-ui submodule with this fork's code               │
│  3. docker compose -p ls-integration-$RUN_ID up -d                     │
│         postgresql  ──healthcheck──►  builder (schema init)             │
│         rabbitmq    ──healthcheck──►  api, appserver, …                 │
│         debarchive  ──healthcheck──►  debarchive-seeder (one-shot)      │
│  4. Poll API healthcheck (http://localhost:9091/)                       │
│  5. Seed account: docker compose exec api uv run bootstrap-account      │
│  6. Build landscape-ui (pnpm build, MSW=false, self-hosted mode)        │
│  7. Run playwright test --project=integration                           │
│  8. Upload report, teardown stack                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Repository checkout strategy

`canonical/landscape-packaging` is a private monorepo that contains `landscape-server` and `landscape-go` as git submodules, and the `docker/ui-dev/` Compose stack that drives the full backend. `landscape-ui` is also a submodule there.

The workflow:

1. Checks out `canonical/landscape-packaging` (with `submodules: recursive`) into the runner's workspace root using a PAT stored as `LANDSCAPE_PACKAGING_TOKEN`. This gives us the `landscape-server/`, `landscape-go/`, and `docker/ui-dev/` trees.
2. Immediately overwrites the `landscape-ui/` subdirectory (the landscape-packaging submodule) by running a second `actions/checkout` step with `repository: ${{ github.repository }}` and `path: landscape-ui`. This replaces the pinned submodule content with the current fork's code before any Docker build occurs.

This gives us the correct docker context structure (`landscape-server/`, `landscape-go/`, `docker/ui-dev/`) with the fork's landscape-ui code in place, without duplicating or maintaining any Compose/Dockerfile files here.

### 2.3 Compose stack for CI

The existing `docker/ui-dev/compose.yaml` is used unmodified. Key points:

- The `landscape-ui` service uses `profiles: [ui]` and is excluded from `docker compose up` by default. The UI is built and served separately by the CI workflow (matching local dev practice).
- `develop.watch` is inert without the explicit `--watch` flag — no override file is needed for CI.
- A unique compose project name (`ls-integration-${{ github.run_id }}`) prevents port and volume conflicts from concurrent manual runs.

### 2.4 Account seeding

After the `api` service is healthy, a test account is created:

```bash
docker compose -p "ls-integration-${RUN_ID}" exec -T api \
  uv run bootstrap-account \
  --email "$CI_ADMIN_EMAIL" \
  --password "$CI_ADMIN_PASSWORD"
```

The password is generated fresh each run with `openssl rand -hex 16` and stored only in `$GITHUB_ENV`. It is never printed to logs and is discarded when the stack is torn down.

### 2.5 UI build and serve

landscape-ui is built with Vite and served using `pnpm preview` (port 4173). The existing `playwright.config.ts` `webServer` block already handles this in CI mode (`IS_CI=true`). The build env uses:

```
VITE_API_URL=http://localhost:9091/api/v2/
VITE_API_URL_OLD=http://localhost:9091/api/
VITE_ROOT_PATH=/
VITE_SELF_HOSTED_ENV=true
VITE_MSW_ENABLED=false
```

---

## 3. GitHub Actions Workflow

**Path:** `.github/workflows/integration-tests.yml`

**Trigger:** `workflow_dispatch` only (Phase 1). Expanding to push/schedule gates deferred until stack startup time is measured and proven stable.

**Runner:** `ubuntu-latest` (GitHub-hosted, 7 GB RAM). A commented-out `[self-hosted, Linux, large]` alternative is included — self-hosted is strongly preferred once a pool is available due to Docker layer cache and memory headroom.

**Secret required:** `LANDSCAPE_PACKAGING_TOKEN` — a fine-grained or classic PAT with `contents: read` on `canonical/landscape-packaging`, `canonical/landscape-server`, and `canonical/landscape-go`.

**Timeout:** 45 minutes (cold Docker builds on GitHub-hosted runners are slow).

**Key steps (order):**

| # | Step | Notes |
|---|------|-------|
| 1 | Checkout landscape-packaging | `token: LANDSCAPE_PACKAGING_TOKEN`, `submodules: recursive` |
| 2 | Override landscape-ui submodule | Second checkout, `path: landscape-ui`, `token: GITHUB_TOKEN` |
| 3 | Generate ephemeral password | `openssl rand -hex 16 >> $GITHUB_ENV` |
| 4 | Start backend stack | `docker compose -p ls-integration-$RUN_ID up -d` |
| 5 | Wait for API | `timeout 120 bash -c 'until curl -sf http://localhost:9091/; do sleep 3; done'` |
| 6 | Seed account | `docker compose exec -T api uv run bootstrap-account` |
| 7 | Install pnpm + Node | pnpm 10, Node 24 |
| 8 | pnpm install | `--frozen-lockfile`, working-dir `landscape-ui` |
| 9 | Build UI | `pnpm run build` with integration env vars |
| 10 | Install Playwright | `playwright install --with-deps chromium` |
| 11 | Run tests | `playwright test --project=integration` |
| 12 | Upload report | `if: always()`, 14-day retention |
| 13 | Teardown | `if: always()`, `docker compose down --remove-orphans --volumes` |

---

## 4. Playwright Integration Project

A new project entry in `playwright.config.ts`:

```ts
{
  name: "integration",
  testDir: "e2e/integration",
  testMatch: "**/*.integration.spec.ts",
  use: { ...devices["Desktop Chrome"] },
}
```

Integration tests live in `e2e/integration/` (separate from `e2e/features/`) and use the `.integration.spec.ts` suffix. This prevents the `saas` and `self-hosted` projects from accidentally matching integration tests, and prevents integration tests from running in the MSW-backed test matrix.

The integration project reads `PLAYWRIGHT_BASE_URL` (defaulting to `http://localhost:4173`) and `CI_ADMIN_EMAIL` / `CI_ADMIN_PASSWORD` for credentials. These env vars are set by the CI workflow.

---

## 5. Phase 1 Smoke Tests

Two test files, covering the minimum surface needed to verify the real API contract:

### `e2e/integration/auth/login.integration.spec.ts`

- Navigates to `/login`
- Fills email (`CI_ADMIN_EMAIL`) and password (`CI_ADMIN_PASSWORD`)
- Submits the form
- Asserts redirect to the dashboard (e.g., `/overview`)

### `e2e/integration/computers/computers.integration.spec.ts`

- Authenticates (shared login helper that reads env vars)
- Navigates to the computers list route
- Asserts that the page renders at least one computer entry (validates the real `GET /api/v2/computers` response shape makes it to the UI)

These tests do not use any MSW fixtures or mock interceptors. They make real HTTP calls to the running stack.

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
- [ ] `e2e/integration/auth/login.integration.spec.ts`
- [ ] `e2e/integration/computers/computers.integration.spec.ts`
- [ ] `docs/integration-testing.md`

### Phase 2 — Sample data and SaaS mode

- [ ] Add sample data seeding steps:
  - `sample.py` (landscape-server) for computer and activity sample resources
  - `debarchive-seed-curl.sh` (landscape-go) for debarchive sample data
- [ ] Add a matrix on `VITE_SELF_HOSTED_ENV` (true/false) to test both standalone and SaaS modes
- [ ] Expand test coverage to cover mutations (create tag, run activity)
- [ ] Measure cold-start time; add Docker layer caching or migrate to self-hosted runners

### Phase 3 — PR gating

- [ ] Add integration workflow as a required check on PRs to `dev`/`main` (after Phase 2 stability proven)
- [ ] Add per-PR branch matching for backend repos (try same branch name, fall back to `main`)
- [ ] Add nightly schedule trigger

---

## 8. Risks and Open Questions

| Risk / Question | Impact | Mitigation |
|-----------------|--------|------------|
| GitHub-hosted runner cold-start for Docker builds is slow (10–25 min) | Medium | Acceptable for workflow_dispatch; measure before expanding triggers |
| `bootstrap-account` CLI arguments change between versions | Low | Interface confirmed; seeding step tested against `main` before Phase 1 merges |
| Docker network conflicts between concurrent runs | Low | Unique project name `-p ls-integration-${{ github.run_id }}` |
| Integration tests flaky due to service startup timing | Medium | Explicit healthcheck polling + Playwright `webServer.reuseExistingServer` for the UI port |
| `LANDSCAPE_PACKAGING_TOKEN` scope must cover all three submodule repos | Medium | Use a classic PAT with `repo` scope or a fine-grained PAT scoped to the `canonical` org |
| Sensitive credentials exposed in logs | Low | Password generated per-run, stored in env, never echoed |

---

## 9. Out of Scope

- Running Vitest unit tests against a real backend (MSW-based, no real backend needed)
- Modifying `docker/ui-dev/compose.yaml` for the sole purpose of CI
- landscape-client integration (device registration, activity execution)
- Performance or load testing
- The `loki_img.tar` artifact from `docker/ui-dev/` — not required for the core stack
