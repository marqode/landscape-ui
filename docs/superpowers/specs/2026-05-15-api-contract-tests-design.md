# API Contract Tests Specification (UI 🤝 Backend)

## 1. Context and Problem Statement
The Landscape ecosystem consists of multiple repositories (`landscape-go`, `landscape-server`, `landscape-ui`). A major challenge in this decoupled architecture is preventing "contract drift" — when the frontend expects a specific JSON shape but the backend sends something else.

**The Current State:**
* `landscape-ui` relies on MSW for component isolation testing. MSW handlers often drift from reality.
* The `integration-tests.yml` workflow spins up the real Docker stack (PostgreSQL, RabbitMQ, Go, Python) and runs Playwright UI tests. This catches drift but browser automation is slow.
* **Crucially**, `debarchive` endpoints (written in Go) are defined by Protobufs stored in `landscape-proto`. The UI imports these types via the `@canonical/landscape-openapi` npm package.
* Python endpoints (legacy) use plain JSON with no shared types.

## 2. Collaboration Workflow

To ensure seamless collaboration between Frontend and Backend teams, we define two contract management paradigms:

### A. The "Strict Contract" Workflow (Go / `debarchive` / Protobuf)
* **Source of Truth:** `landscape-proto` repository.
* **Process:** 
  1. Backend developer adds/modifies an endpoint in a `.proto` file.
  2. This triggers a build of the `@canonical/landscape-openapi` npm package.
  3. Frontend updates the package version in `package.json`. TypeScript catches missing fields or payload errors at compile-time.
* **Testing Role:** The Playwright API tests act as a runtime sanity check to guarantee the running Go backend in Docker is actually serving the expected protobuf version.

### B. The "Loose Contract" Workflow (Python / Legacy API)
* **Source of Truth:** The running Python code.
* **Process:** Frontend developers manually write TypeScript interfaces to map the Python endpoints.
* **Testing Role:** The Playwright API tests are the *primary defense* against drift here. They validate the Python backend's JSON directly against the UI's manual schemas.

## 3. Architecture of API Contract Tests
We will implement **Headless Playwright API Tests**. 

* **Location:** `e2e/docker-stack/api/`
* **Execution:** Run via `request.get()` and `request.post()`, skipping browser rendering entirely.
* **Fail-Fast CI Pipeline:** These tests will execute as a distinct, separate step in `.github/workflows/integration-tests.yml` **before** the traditional UI E2E tests. This ensures high discoverability for developers (they see an "API Contract Tests" job fail instantly) and saves 15+ minutes of compute time if a payload shape is broken.

## 4. PoC Scope: Local Repositories
The Proof of Concept will target the `local-repositories` domain.
* It will import the generated types from `@canonical/landscape-openapi`.
* It will send a POST request to create a repository and assert the response shape matches the OpenAPI definitions.
* It will send a GET request and validate the pagination shape.

## 5. Division of Testing Labor (No Duplication)
To avoid duplicating test coverage, UI developers must refer to `backend-test-context.md`.
* `landscape-go` and `landscape-server` already test deep database logic, row-locking, and complex state mutations.
* The UI API Contract tests should **only** test the "happy path" mapping between the UI's expected types and the backend's JSON output.