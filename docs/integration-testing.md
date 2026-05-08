# Integration Testing

Integration tests run Playwright against a real Landscape backend stack (landscape-server + landscape-go) running in Docker containers. They complement the existing MSW-backed Vitest tests by verifying real API contract fidelity.

## What they test (Phase 1)

- Login via standalone auth with a seeded admin account
- Instances list rendered from a real `GET /api/v2/computers` response
- Tag creation round-trip through the real API

## Workflows

Two parallel CI implementations exist while the GitHub App approach is being validated:

| Workflow | Auth | File | Status |
|----------|------|------|--------|
| **Integration Tests (GitHub App)** | GitHub App short-lived token | `integration-tests-app.yml` | **Primary** |
| Integration Tests (PAT) | Classic PAT `LANDSCAPE_PACKAGER_TOKEN` | `integration-tests.yml` | Reference / fallback |

Both are `workflow_dispatch`-only. Nightly + push-to-main triggers are deferred to Phase 2 after stability is confirmed.

## How to trigger in CI

1. Go to **Actions → Integration Tests (GitHub App)** in GitHub.
2. Click **Run workflow**.

**Required credentials (GitHub App workflow):**
- `vars.LANDSCAPE_PACKAGER_APP_ID` — GitHub App ID (repository variable, not a secret)
- `secrets.LANDSCAPE_PACKAGER_PRIVATE_KEY` — GitHub App private key (PEM format)
- `secrets.LANDSCAPE_PROTO_PAT` — fine-grained PAT with `Contents: Read` on `canonical/landscape-proto` only *(Phase 2+; required for Go vendoring)*

The App must be installed on `canonical/landscape-packaging`, `canonical/landscape-go`, and `canonical/landscape-server`.

> **Note on `LANDSCAPE_PROTO_PAT`:** `landscape-proto` is not covered by the GitHub App
> installation. A separate fine-grained PAT is used to vendor this private Go dependency
> in CI. The PAT is applied as a `git url.insteadOf` rewrite scoped to
> `github.com/canonical/landscape-proto` only, so it never touches other repos.
> Migration path: once the landscape-packager App is installed on `landscape-proto`,
> add it to the `repositories:` list in `create-github-app-token` and remove the PAT
> `git config` line (~4 lines of diff). See [debarchive-feature-context.md](debarchive-feature-context.md).

**Required credentials (PAT fallback workflow):**
- `secrets.LANDSCAPE_PACKAGER_TOKEN` — classic PAT with `repo: Contents: Read` on the three repos above.

## Cold-start time (GitHub-hosted `ubuntu-latest`, run #4)

| Step | Duration |
|------|----------|
| Initialise submodules | 10 s |
| **Start backend stack** (cold Docker image build) | **4 min 32 s** |
| Wait for API ready (after builder exits) | 10 s |
| Seed admin account | 4 s |
| Install Playwright browsers | 2 min 49 s |
| Run integration tests | 17 s |
| **Total** | **~8 min 16 s** |

The dominant cost is the cold Docker image build (~4.5 min). A self-hosted runner with cached images would reduce this to seconds. Measured on `ubuntu-latest` with no Docker layer cache.

## How to run locally

### Prerequisites

- Docker + Docker Compose v2
- Access to `canonical/landscape-packaging` cloned with submodules (e.g. `~/landscape-packaging`)
- `pnpm` and Node 24 installed in this repo

### 0. Create your local credentials file (one-time)

Create `.env.integration.local` in this repo's root (gitignored):

```ini
CI_ADMIN_EMAIL=ci-admin@example.com
CI_ADMIN_PASSWORD=mysecret
```

### 1. Start the backend stack

From your `landscape-packaging/docker/ui-dev/` directory:

```bash
make up
```

Wait until `http://localhost:9091/api/v2/login/methods` and `http://localhost:8080/` both respond with 200.

### 1b. Seed the admin account

```bash
docker exec landscape-api \
  uv run python bootstrap-account \
  --admin_email "ci-admin@example.com" \
  --admin_name "CI Test Admin" \
  --admin_password "mysecret" \
  --root_url "http://localhost:5173/"
```

### 2. Install Playwright browsers (first time or after upgrades)

```bash
pnpm exec playwright install chromium
```

### 3. Run integration tests

```bash
pnpm exec playwright test --config playwright.integration.config.ts
```

Credentials are loaded from `.env.integration.local`. The HTML report is written to `playwright-integration-report/`.

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| Separate `playwright.integration.config.ts` | Avoids conflicts with MSW-backed `playwright.config.ts` (`webServer`, `testDir`, `baseURL`) |
| `workers: 1` | Shared mutable backend; tests must not race against each other |
| `globalSetup` writes `storageState` | Individual tests reuse the authenticated session; login is tested once explicitly |
| **`vite --mode e2e` (dev server, not `vite preview`)** | The dev server activates Vite's proxy (`/api` → `localhost:9091`), making all API calls same-origin. This is required for session cookie auth: `GET /api/v2/me` uses `publicFetch` (no `withCredentials`), so cookies are only sent when the request is same-origin. `vite preview` serves cross-origin, breaking authentication silently. |
| Relative API URLs in `.env.e2e` | `/api/v2/`, `/api/`, `/v1beta1/` route through the Vite proxy. `VITE_API_PROXY_TARGET=http://localhost:9091` and `VITE_API_DEBARCHIVE_PROXY_TARGET=http://localhost:8000` configure the proxy targets. |
| Explicit service list in `docker compose up` | Starts only the services needed for standalone mode; avoids building debarchive (Phase 2). |
| GitHub App token instead of PAT | Short-lived (≤1 h), scoped to specific repos, no human credentials. SSH submodule URLs rewritten to HTTPS via `url.insteadOf` after checkout (must run after `actions/checkout` resets git config). |
| `docker wait landscape-builder` (not `docker compose wait`) | `docker compose wait` resolves the project by file path and fails when the working directory differs between the `up` step and the wait step. `docker wait` operates on the container name directly. |
| `landscape-go` vendor directory generated via PAT | `vendor/` is gitignored in landscape-go. It is regenerated in CI via `GOPRIVATE=... go mod vendor` using a fine-grained PAT (`LANDSCAPE_PROTO_PAT`) for the private `landscape-proto` dependency. See [debarchive-feature-context.md](debarchive-feature-context.md) for the full credential chain and migration path to App install. |

## Phase 2 roadmap

- Add nightly schedule + push-to-main triggers (after stability confirmed) ✅
- Add debarchive stack + seeding ✅ (`feature/debarchive-integration`)
- SaaS mode matrix (`LANDSCAPE_DEPLOYMENT_MODE=default` + `VITE_SELF_HOSTED_ENV=false`)
- Evaluate self-hosted runner for Docker layer caching (would cut cold-start from ~4.5 min to seconds)

See [debarchive-feature-context.md](debarchive-feature-context.md) for all Phase 2 lessons and pitfalls.

## Phase 3 roadmap

- **Per-PR branch matching for backend repos.** When a UI PR branch exists in
  `landscape-packaging` under the same name, check out that branch instead of `main`.
  Achievable with the existing GitHub App token — use `git ls-remote` against the
  authenticated remote to probe branch existence before checkout, then fall back to
  `main`. Example:
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
  The App token scope already covers `landscape-packaging`; no credential changes needed.
- **Replace `compose.ci-override.yaml` with a standalone `compose.ci.yaml`** owned by this
  repo. The override approach has required explicit workarounds for every dev-specific field
  that bleeds through from the upstream `landscape-packaging` compose file (`command`,
  `working_dir`, `healthcheck`, `pull_policy`, `GO_DOTENV`, `GOFLAGS`). A standalone file
  eliminates this class of issue entirely. Defer until the service set is stable (post-Phase 2)
  to avoid maintaining a copy that changes frequently. Alternatively, file a PR to
  `landscape-packaging` to add a `--profile ci` compose variant upstream.
- **Migrate `LANDSCAPE_PROTO_PAT` to App install.** When the `landscape-packager` GitHub App
  is installed on `canonical/landscape-proto`, add it to the `repositories:` list in the
  `create-github-app-token` step and remove the `git config url.insteadOf` line for
  landscape-proto. The PAT can then be deleted.
- Add nightly + push-to-main triggers once Phase 2 stability is confirmed
- SaaS mode matrix (`VITE_SELF_HOSTED_ENV=false`)

