# Debarchive Integration: Feature Context for Agents

This document captures hard-won lessons from adding the debarchive service to the
integration test stack (Phase 2). Read this before touching `integration-tests-app.yml`
or anything related to `compose.ci-override.yaml` or `landscape-go` vendoring.

---

## What was built

Phase 2 adds `canonical/landscape-go`'s debarchive service to the Docker stack so that
Playwright tests can exercise publication-targets UI flows against a real gRPC/HTTP
gateway.

**Branch:** `feature/debarchive-integration`  
**Workflow:** `.github/workflows/integration-tests-app.yml`  
**Key additions over Phase 1:**

1. `Set up Go` — installs Go 1.26 (from `landscape-go/go.mod`)
2. `Vendor landscape-go dependencies` — runs `go mod vendor` with a PAT rewrite for the
   private `landscape-proto` dependency
3. `Build debarchive CI image` — multi-stage build via `Dockerfile.e2e` (not `Dockerfile.dev`)
4. `Create debarchive database` — `createdb landscape-debarchive` before service start
5. `Wait for debarchive to be ready and seeded` — TCP probe + seeder container

---

## Pitfall map (each cost ≥1 CI iteration)

### 1. Docker Compose override opacity

**Problem:** `landscape-packaging/docker/ui-dev/compose.yaml` is authored for developer
hot-reload. It has many fields that survive a `docker compose -f ... -f override.yaml`
merge and break CI silently:

| Field in base compose.yaml | What it does | What broke |
|----------------------------|--------------|------------|
| `command: exec air …` | Starts the air file-watcher | Exit 127 — `air` not in runtime image |
| `working_dir: /app/debarchive` | Sets CWD for the container | `./server` resolved wrong path |
| `healthcheck: curl localhost:8001` | Wrong port AND wrong tool | Container marked unhealthy immediately |
| `GO_DOTENV: /app/debarchive/config/dev-docker.env` | Loads dev DB credentials | Server connected to wrong DB |
| `GOFLAGS: -mod=vendor` | Forces vendor mode | Unnecessary after real vendor/ exists |
| `pull_policy: build` | Rebuilds the dev image | Ignored our pre-built CI image |

**Fix applied:** `compose.ci-override.yaml` now explicitly overrides all of these:

```yaml
services:
  debarchive:
    image: landscape-debarchive:ci
    pull_policy: never
    command: ["/root/server"]          # absolute path; working_dir override needed too
    working_dir: /root
    environment:
      - GO_DOTENV=                     # clear dev dotenv
      - GOFLAGS=                       # clear -mod=vendor
      - DEB_ARCHIVE_DATABASE_HOST=postgresql
      - DEB_ARCHIVE_DATABASE_NAME=landscape-debarchive
      - DEB_ARCHIVE_DATABASE_USER=postgres
      - DEB_ARCHIVE_DATABASE_PASSWORD=postgres
    healthcheck:
      test: ["CMD-SHELL", "bash -c '</dev/tcp/localhost/8000' 2>/dev/null"]
      ...
```

**Rule for future agents:** When adding any new service from `landscape-packaging` to CI,
enumerate every field in that service's compose definition and explicitly override or
nullify each dev-specific one. Assume nothing is safe to inherit.

---

### 2. `curl` is not in `debian:bookworm-slim`

**Problem:** `Dockerfile.e2e` produces a `debian:bookworm-slim` runtime image. That image
ships with essentially nothing — no `curl`, no `wget`, no `nc`. Any healthcheck
`CMD-SHELL` that calls `curl` will exit 127 (command not found), immediately marking the
container unhealthy.

**Fix:** Use bash's built-in TCP redirect:

```yaml
test: ["CMD-SHELL", "bash -c '</dev/tcp/localhost/8000' 2>/dev/null"]
```

This opens a TCP connection to port 8000. Exit 0 = port accepting; non-zero = refused.
Bash is always present; no extra tools needed.

**Distinction:** The _runner shell_ (step `run:` in the workflow) has `curl`. Only the
_container_ healthcheck is affected.

---

### 3. `vendor/` is gitignored in `landscape-go`; `landscape-proto` is private

**Problem:** `landscape-go` does not commit `vendor/`. It must be generated via:

```bash
GOPRIVATE="github.com/canonical/*" go mod vendor
```

But `landscape-proto` is a private Canonical repo. On ephemeral GitHub-hosted runners,
there are no pre-existing SSH credentials. Multiple approaches failed:

| Approach | Why it failed |
|----------|---------------|
| GitHub App token (landscape-packager) | App not installed on `landscape-proto` → 422 |
| Adding `landscape-proto` to App token `repositories:` list | 422 — repo not in App installation |
| Manually patching `vendor/modules.txt` | Fragile sed; modules.txt format is Go-version-sensitive |
| Self-hosted runner | Overkill for fork-level dev; runner machine credentials not portable |

**Fix:** Fine-grained PAT with `Contents: Read` on `canonical/landscape-proto` only,
stored as `secrets.LANDSCAPE_PROTO_PAT`. In the vendor step:

```yaml
git config --global url."https://x-access-token:${{ secrets.LANDSCAPE_PROTO_PAT }}@github.com/canonical/landscape-proto".insteadOf \
  "https://github.com/canonical/landscape-proto"
```

Git uses the **longest matching prefix**, so this PAT rewrite wins over the general App
token `insteadOf` rule that covers all of `github.com`.

**Migration path to App install:** When `landscape-packager` App is installed on
`landscape-proto`, add `landscape-proto` to the `repositories:` list in the
`create-github-app-token` step and remove the PAT `git config` line. ~4 lines of diff.

**Why the landscape-packaging CI (`test-server-dev.yaml`) doesn't have this problem:**
Their workflow runs on self-hosted runners with machine-level SSH deploy keys that have
broad `canonical/*` access. They don't need to rewrite URLs — `go mod vendor` falls back
to the runner's SSH key automatically. This is not reproducible on GitHub-hosted runners
without explicit credentials.

---

### 4. Use `Dockerfile.e2e`, not `Dockerfile.dev`

`landscape-go` ships two Dockerfiles for debarchive:

| File | Purpose | Runtime deps |
|------|---------|-------------|
| `.docker/Dockerfile.dev` | Developer hot-reload with `air` | `air`, `dlv`, ptrace capability |
| `debarchive/docker/Dockerfile.e2e` | Production-like binary | `xz-utils`, `bzip2` only |

`Dockerfile.e2e` does a multi-stage build:
- **Builder:** `golang:1.26` — compiles `./debarchive/cmd/main.go` → `/app/server`
- **Runtime:** `debian:bookworm-slim` — copies binary to `/root/server`, sets WORKDIR `/root`

The build context must be the **landscape-go repo root** (not the debarchive subdirectory)
because the build step compiles from the module root.

**CMD is `["./server"]` which resolves relative to WORKDIR `/root`.**
Use the absolute path `/root/server` in compose overrides to be safe.

---

### 5. debarchive requires a pre-existing database

debarchive does **not** create its own PostgreSQL database on startup. The database must
exist before the service starts or it will fail to connect and crash-loop.

**Fix:** Add a step before starting debarchive:

```bash
docker exec landscape-postgres createdb -U postgres landscape-debarchive || true
```

The `|| true` handles re-runs where the DB already exists.

---

### 6. Seeder version drift

The `debarchive-seeder` container runs a seeding script that calls the debarchive HTTP
API. The script version may lag behind the debarchive API version — in particular, 409
conflicts (duplicate publications) are expected when the seeder tries to create entities
that already exist or uses a deprecated publication endpoint.

**Current state:** Seeder is non-blocking. A 409 is logged as a workflow warning but does
not fail the job. The seeded data (targets, locals, mirrors, partial publications) is
sufficient for Playwright tests.

**When to re-enable strict exit-code checking:** After the new seeder version (with
idempotent 409 handling) is merged into `landscape-packaging` and the submodule is
bumped.

---

## compose.ci.yaml: now vs Phase 3

The current approach uses a runtime-generated `compose.ci-override.yaml` layered on top
of the upstream `compose.yaml`. This has caused the majority of Phase 2's iteration cost.

### Option A: Keep the override approach (current)

**Pros:**
- Automatically inherits new services and network config from upstream
- Lower upfront effort
- Appropriate while the service interface is still being discovered

**Cons:**
- Every new CI-incompatible field in the base must be explicitly overridden (and
  discovered the hard way via a CI failure)
- Merge behaviour is non-obvious; `command`, `working_dir`, `pull_policy` are not reset
  by changing `image`
- Harder to reason about what the final merged config looks like

### Option B: Write a standalone `compose.ci.yaml` (this repo)

**Pros:**
- Complete ownership; no surprise inheritance
- Explicit declaration of every port, env var, and image used in CI
- Easier to audit, diff, and review
- No runtime sed/heredoc patching

**Cons:**
- Duplicates service definitions → drift risk when upstream changes ports, adds env vars,
  or renames services
- Higher initial authoring cost
- Must be maintained alongside the submodule pin

### Option C: PR to `landscape-packaging` to add a CI compose profile

**Pros:**
- Canonical solution; benefits all teams testing against these services
- Separates dev and CI concerns at the source
- Upstream owns the contract

**Cons:**
- Requires upstream review and merge; not under fork's control
- Longer timeline; blocked on upstream availability

### Recommendation

**Now (Phase 2):** Keep the override approach. The service interface is newly understood
and changing; a standalone file would need frequent updates.

**Phase 3:** Write `compose.ci.yaml` once debarchive and any new services are stable. At
that point the overhead of maintaining a duplicate is predictable.

**Longer term:** File a PR to `landscape-packaging` adding a `compose.ci.yaml` or Docker
Compose profiles (`--profile ci`). This is the right architectural fix.

---

## Credential inventory (current)

| Secret / Var | What it is | Scope |
|---|---|---|
| `vars.LANDSCAPE_PACKAGER_APP_ID` | GitHub App ID | landscape-packaging, landscape-go, landscape-server |
| `secrets.LANDSCAPE_PACKAGER_PRIVATE_KEY` | GitHub App private key (PEM) | Same repos |
| `secrets.LANDSCAPE_PROTO_PAT` | Fine-grained PAT, `Contents: Read` | `canonical/landscape-proto` only |

The PAT is the only long-lived credential. It can be replaced with an App token once the
landscape-packager App is installed on `landscape-proto`.

---

## Quick reference: adding a new service in CI

1. **Find the service definition** in `.landscape-packaging/docker/ui-dev/compose.yaml`
2. **List every field**: `image`, `build`, `command`, `working_dir`, `entrypoint`,
   `environment`, `healthcheck`, `volumes`, `depends_on`, `pull_policy`
3. **Override or nullify** each dev-specific field in `compose.ci-override.yaml`
4. **Check the runtime image** for what tools are available (healthcheck probe)
5. **Check for pre-start dependencies** (databases, sockets, other services)
6. **Check for private Go dependencies** if the service is from `landscape-go`
