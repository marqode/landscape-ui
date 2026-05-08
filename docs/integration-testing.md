# Integration Testing

Integration tests run Playwright against a real Landscape backend stack (landscape-server + landscape-go) running in Docker containers. They complement the existing MSW-backed Vitest tests by verifying real API contract fidelity.

See [e2e/integration/README.md](../e2e/integration/README.md) for a quick-start guide (triggering, running locally, adding tests).

## What they test

**Self-hosted mode** (`*.integration.spec.ts`)

- Login via standalone auth with a seeded admin account
- Instances list rendered from a real `GET /api/v2/computers` response
- Preferences mutation round-trip through the real API
- Debarchive publication targets listed from a seeded debarchive service

**SaaS mode** (`*.saas.integration.spec.ts`)

Both suites run against the same backend. SaaS tests use `VITE_SELF_HOSTED_ENV=false` and
navigate to a real API page first (to confirm the session and proxy are healthy), then
assert on SaaS-specific behaviour:

- Instances page loads real API data with `VITE_SELF_HOSTED_ENV=false`
- Self-hosted-only repository routes (`/repositories/publication-targets`, etc.) redirect to `/env-error`

> If the API introduces server-side SaaS feature gating, SaaS tests may need a dedicated
> backend instance. For now the same landscape-server serves both modes.

## Workflow

A single workflow, **Integration Tests** (`.github/workflows/integration-tests.yml`), runs both test suites.

**Triggers:**

| Event | Behaviour |
|-------|-----------|
| PR → `dev` | Runs on code changes (docs/markdown/debian paths ignored) |
| Push → `main` | Runs on code changes (same path filter) |
| Nightly 02:00 UTC | Always runs — catches upstream backend regressions |
| `workflow_dispatch` | Manual; accepts `packaging_ref` input |

**Concurrency:** PRs cancel superseded runs on the same branch. Push and nightly runs always complete.

## Credentials

| Secret / Variable | Type | Purpose |
|-------------------|------|---------|
| `vars.LANDSCAPE_PACKAGER_APP_ID` | Repository variable | GitHub App ID |
| `secrets.LANDSCAPE_PACKAGER_PRIVATE_KEY` | Secret | GitHub App private key (PEM) |
| `secrets.LANDSCAPE_PROTO_PAT` | Secret | Fine-grained PAT — `Contents: Read` on `canonical/landscape-proto` only |

The GitHub App must be installed on `canonical/landscape-packaging`, `canonical/landscape-go`, and `canonical/landscape-server`.

> **`LANDSCAPE_PROTO_PAT` migration path:** `landscape-proto` is not yet covered by the App
> installation. A fine-grained PAT is used as a temporary workaround. Once the App is
> installed on `landscape-proto`, add it to the `repositories:` list in the
> `create-github-app-token` step and remove the `git config url.insteadOf` line (~4 lines).
> See [debarchive-feature-context.md](debarchive-feature-context.md) for the full credential chain.

## dispatch input: `packaging_ref`

`workflow_dispatch` exposes one input:

```
packaging_ref: landscape-packaging branch/tag/SHA to test against (default: main)
```

Since `landscape-go` and `landscape-server` are submodules of `landscape-packaging`, this single input pins the entire backend stack. On automatic triggers (PR, push, nightly) it always resolves to `main`.

## Cold-start time (GitHub-hosted `ubuntu-latest`)

| Step | Duration |
|------|----------|
| Initialise submodules | 10 s |
| **Start backend stack** (cold Docker image build) | **4 min 32 s** |
| Wait for API ready (after builder exits) | 10 s |
| Seed admin account | 4 s |
| Install Playwright browsers | 2 min 49 s |
| Run integration tests | ~30 s |
| **Total** | **~8 min** |

The dominant cost is the cold Docker image build. A self-hosted runner with cached images would reduce this to seconds.

## How to run locally

### Prerequisites

- Docker + Docker Compose v2
- `canonical/landscape-packaging` cloned with submodules (e.g. `~/landscape-packaging`)
- `pnpm` and Node 24

### 1. Start the backend stack

From your `landscape-packaging/docker/ui-dev/` directory:

```bash
make up
```

Wait until both of these respond:

```bash
curl -sf http://localhost:9091/api/v2/login/methods
curl -sf http://localhost:8080/
```

### 2. Seed the admin account (one-time per fresh stack)

```bash
docker exec landscape-api \
  uv run python bootstrap-account \
  --admin_email "ci-admin@example.com" \
  --admin_name "CI Test Admin" \
  --admin_password "mysecret" \
  --root_url "http://localhost:5173/"
```

Create `.env.integration.local` in this repo root (gitignored):

```ini
CI_ADMIN_EMAIL=ci-admin@example.com
CI_ADMIN_PASSWORD=mysecret
```

### 3. Install Playwright browsers (first time or after upgrades)

```bash
pnpm exec playwright install chromium
```

### 4. Run integration tests

```bash
# Self-hosted mode (requires live backend)
pnpm exec playwright test --config playwright.integration.config.ts

# SaaS mode (same backend, VITE_SELF_HOSTED_ENV=false)
pnpm exec playwright test --config playwright.integration.saas.config.ts
```

Reports are written to `playwright-integration-report/` and `playwright-integration-saas-report/`.

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| Separate `playwright.integration.config.ts` | Avoids conflicts with MSW-backed `playwright.config.ts` (`webServer`, `testDir`, `baseURL`) |
| `workers: 1` | Shared mutable backend; tests must not race against each other |
| `globalSetup` writes `storageState` | Individual tests reuse the authenticated session; login is tested once explicitly |
| **`vite --mode e2e` (dev server, not `vite preview`)** | The dev server activates Vite's proxy (`/api` → `localhost:9091`), making all API calls same-origin. Required for session cookie auth: `GET /api/v2/me` uses `publicFetch` (no `withCredentials`), so cookies are only sent when the request is same-origin. `vite preview` serves cross-origin, breaking authentication silently. |
| `*.saas.integration.spec.ts` naming | Excluded from self-hosted config via `testIgnore`; picked up only by `playwright.integration.saas.config.ts`. The naming convention is self-documenting and requires no per-test config. |
| Relative API URLs in `.env.e2e` | `/api/v2/`, `/api/`, `/v1beta1/` route through the Vite proxy. `VITE_API_PROXY_TARGET` and `VITE_API_DEBARCHIVE_PROXY_TARGET` configure the targets. |
| Explicit service list in `docker compose up` | Starts only services needed for standalone mode; avoids building debarchive unless explicitly included. |
| GitHub App token instead of PAT | Short-lived (≤1 h), scoped to specific repos, no human credentials. SSH submodule URLs rewritten to HTTPS via `url.insteadOf` after checkout. |
| `docker wait landscape-builder` (not `docker compose wait`) | `docker compose wait` resolves the project by file path and fails when the working directory differs between steps. `docker wait` operates on the container name directly. |
| `landscape-go` vendor directory generated in CI | `vendor/` is gitignored in landscape-go. Regenerated via `GOPRIVATE=... go mod vendor` using `LANDSCAPE_PROTO_PAT`. See [debarchive-feature-context.md](debarchive-feature-context.md). |

## Phase 2 — complete ✅

- Nightly schedule + push-to-main triggers ✅
- Debarchive stack + seeding ✅
- SaaS mode PoC (route guard tests) ✅
- Retired PAT-based fallback workflow ✅
- `packaging_ref` dispatch input for manual backend override ✅
- Path-based trigger filters (docs/markdown changes don't trigger runs) ✅

See [debarchive-feature-context.md](debarchive-feature-context.md) for all Phase 2 lessons and pitfalls.

## Phase 3 roadmap

- **Per-PR branch matching.** Probe `landscape-packaging` for a branch matching the UI PR's
  head ref; fall back to `main` if absent. The `packaging_ref` manual override already covers
  the urgent case. Implementation uses `git ls-remote` with the App token:
  ```yaml
  - name: Resolve backend branch
    id: backend-branch
    run: |
      BRANCH="${{ github.head_ref || github.ref_name }}"
      if git ls-remote --exit-code --heads \
           "https://x-access-token:${{ steps.token.outputs.token }}@github.com/canonical/landscape-packaging.git" \
           "$BRANCH" >/dev/null 2>&1; then
        echo "ref=$BRANCH" >> $GITHUB_OUTPUT
      else
        echo "ref=main" >> $GITHUB_OUTPUT
      fi
  ```
- **Standalone `compose.ci.yaml`** owned by this repo. The current `compose.ci-override.yaml`
  approach requires explicit workarounds for every dev-specific field that bleeds through from
  upstream (`command`, `working_dir`, `healthcheck`, `pull_policy`, `GO_DOTENV`, `GOFLAGS`).
  A standalone file eliminates this class of issue entirely. Defer until the debarchive API
  stabilises to avoid maintaining a copy that changes frequently.
  Alternative: upstream PR to `landscape-packaging` adding a `--profile ci` compose variant.
- **Migrate `LANDSCAPE_PROTO_PAT` to App install.** When the `landscape-packager` App is
  installed on `canonical/landscape-proto`, add it to `repositories:` in the token step and
  remove the `git config url.insteadOf` line for landscape-proto (~4 lines).
- **Self-hosted runner evaluation.** Docker layer cache would cut cold-start from ~4.5 min to
  seconds. Unblocks faster iteration on new test suites.


