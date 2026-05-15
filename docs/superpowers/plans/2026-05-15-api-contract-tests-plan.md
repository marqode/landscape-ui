# API Contract Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement fast, headless Playwright API tests to act as runtime schema validators between the `landscape-ui` frontend contracts and the real Docker backend, covering `local-repositories` and `publications`.

**Architecture:** Playwright `request` context hitting the live Docker backend API endpoints. Strict validation using the frontend's TypeScript interfaces (`Local`, `Publication`, `CreateLocalRequest`, `PublicationWritable`).

**Tech Stack:** Playwright, TypeScript, Node.js

---

### Task 1: Document Backend Test Context

**Files:**
- Create: `forks/landscape-ui/e2e/docker-stack/ui/backend-test-context.md`

- [ ] **Step 1: Write the backend test context documentation**

```markdown
# Backend Test Context for UI Developers

To avoid duplicating test coverage in the UI's Playwright integration tests, please refer to this summary of existing backend tests.

## landscape-go (debarchive & api)
- **Framework:** Standard Go `testing` package, `go-cmp`.
- **Strategy:** Heavy use of real PostgreSQL databases via `testcontainers`. Each test runs in an isolated transaction (`setupTx`).
- **Coverage:** HTTP handlers, data access layers, and core repository logic are fully tested against the database. An extensive `e2e` suite runs against a Docker stack.

## landscape-server (Python backend)
- **Framework:** Twisted Trial, `testtools`, `testresources`.
- **Strategy:** Real PostgreSQL databases via Storm ORM (`ZStormResourceManager`). Each test class receives a freshly provisioned database instance.
- **Coverage:** Full coverage of HTTP handlers (`APIHandlerTest`), REST methods (`APITest`), and database models (`ModelTest`).

## UI Integration Test Strategy (Playwright API)
Given the comprehensive backend coverage, the UI's Playwright API tests in this directory should **only** verify the JSON shape contract. Do not write tests for deep database constraints, locking scenarios, or backend business logic. Focus purely on whether the UI's TypeScript interfaces (`CreateLocalRequest`, `Local`, etc.) match the API payloads and responses.
```

- [ ] **Step 2: Commit**

```bash
git add forks/landscape-ui/e2e/docker-stack/ui/backend-test-context.md
git commit -m "docs: add backend test context summary to integration tests"
```

### Task 2: Implement Local Repositories Contract Test

**Files:**
- Create: `forks/landscape-ui/e2e/docker-stack/ui/local-repositories/local-repositories-api.integration.spec.ts`

- [ ] **Step 1: Write the test skeleton and type validation helper**

```typescript
import { expect, test } from "@playwright/test";
import type { Local, CreateLocalRequest } from "../../../src/features/local-repositories/types/LocalRepository";

// Lightweight runtime validation helper ensuring expected properties exist
function validateLocalShape(repo: any): repo is Local {
  expect(repo).toHaveProperty("name");
  expect(repo).toHaveProperty("local_id");
  expect(repo).toHaveProperty("distribution");
  expect(repo).toHaveProperty("component");
  return true;
}

test.describe("Local Repositories API Contract", () => {
  const testRepoName = `test-local-repo-${Date.now()}`;
  let createdRepoId: number | undefined;

  test.afterAll(async ({ request }) => {
    if (createdRepoId !== undefined) {
      // Teardown
      await request.delete(`/api/v2/locals/${testRepoName}`);
    }
  });

  // Tests will go here
});
```

- [ ] **Step 2: Implement POST (Create) test**

```typescript
  test("POST /api/v2/locals accepts CreateLocalRequest and returns Local shape", async ({ request }) => {
    const payload: CreateLocalRequest = {
      display_name: "Test Repository",
      name: testRepoName,
      comment: "A test repository created by Playwright API test",
      distribution: "focal",
      component: "main",
    };

    const response = await request.post("/api/v2/locals", { data: payload });
    expect(response.ok(), await response.text()).toBeTruthy();
    
    const body = await response.json();
    validateLocalShape(body);
    expect(body.name).toBe(testRepoName);
    
    createdRepoId = body.local_id;
  });
```

- [ ] **Step 3: Implement GET (List) test**

```typescript
  test("GET /api/v2/locals returns ListLocalsResponse shape", async ({ request }) => {
    const response = await request.get("/api/v2/locals");
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty("locals");
    expect(Array.isArray(body.locals)).toBeTruthy();
    
    // Validate the shape of the items
    if (body.locals.length > 0) {
      validateLocalShape(body.locals[0]);
    }
    
    // Ensure our created repo is in the list
    const found = body.locals.find((repo: any) => repo.name === testRepoName);
    expect(found).toBeDefined();
  });
```

- [ ] **Step 4: Run the test locally to verify (if backend is running) or rely on CI**
*Note: We assume the backend isn't running locally by default, but the syntax can be checked.*

```bash
npx tsc --noEmit forks/landscape-ui/e2e/docker-stack/ui/local-repositories/local-repositories-api.integration.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add forks/landscape-ui/e2e/docker-stack/ui/local-repositories/local-repositories-api.integration.spec.ts
git commit -m "test: add api contract tests for local repositories"
```

### Task 4: Implement Scripts Contract Test (landscape-server PoC)

**Files:**
- Create: `forks/landscape-ui/e2e/docker-stack/api/scripts.spec.ts`

- [ ] **Step 1: Write the test skeleton and validation helpers**

```typescript
import { expect, test } from "@playwright/test";
import type { Script } from "../../../src/features/scripts/types/Script";

// Validate script response shape matches the frontend contract
function validateScriptShape(script: any): script is Script {
  expect(script).toHaveProperty("id");
  expect(script).toHaveProperty("title");
  expect(script).toHaveProperty("code");
  // Optional/conditional properties based on the UI schema
  if ("run_as_user" in script) expect(typeof script.run_as_user).toBe("string");
  if ("timeout" in script) expect(typeof script.timeout).toBe("number");
  return true;
}

test.describe("Scripts API Contract (landscape-server)", () => {
  const testScriptTitle = `test-script-${Date.now()}`;
  let createdScriptId: number | string | undefined;

  test.afterAll(async ({ request }) => {
    // Teardown created script via redact endpoint
    if (createdScriptId !== undefined) {
      await request.post(`/api/v2/scripts/${createdScriptId}:redact`);
    }
  });

  // Tests will go here
});
```

- [ ] **Step 2: Migrate POST (Create) API validation from E2E suite**
*Note: We extract the raw API shape verification from `scripts.integration.spec.ts` where it previously required UI interaction to avoid VITE_API_VERSION complexities.*

```typescript
  test("POST /api/ (CreateScript) creates script and returns expected shape on GET", async ({ request }) => {
    // The legacy create endpoint uses form encoding
    const response = await request.post("/api/", {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({
        action: "CreateScript",
        version: "2",
        title: testScriptTitle,
        code: "#!/bin/bash\necho 'contract test'",
      }).toString()
    });
    
    // The legacy API might return XML or redirect depending on headers, 
    // so we verify success, then rely on the V2 API to validate the resulting object
    expect(response.ok()).toBeTruthy();
    
    // Verify using V2 API
    const listResponse = await request.get("/api/v2/scripts", {
      params: { search: testScriptTitle }
    });
    expect(listResponse.ok()).toBeTruthy();
    
    const listBody = await listResponse.json();
    expect(listBody).toHaveProperty("results");
    
    const createdScript = listBody.results.find((s: any) => s.title === testScriptTitle);
    expect(createdScript).toBeDefined();
    
    validateScriptShape(createdScript);
    createdScriptId = createdScript.id;
  });
```

- [ ] **Step 3: Migrate GET (List) API validation**

```typescript
  test("GET /api/v2/scripts returns paginated Script list shape", async ({ request }) => {
    const response = await request.get("/api/v2/scripts");
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty("results");
    expect(body).toHaveProperty("count");
    expect(Array.isArray(body.results)).toBeTruthy();
    
    if (body.results.length > 0) {
      validateScriptShape(body.results[0]);
    }
  });
```

- [ ] **Step 4: Refactor `scripts.integration.spec.ts`**
Remove strict API type checking and raw payload inspections from the UI integration test (`e2e/docker-stack/ui/scripts/scripts.integration.spec.ts`). The UI test should only assert that UI elements appear (e.g. "script title is visible in the list") rather than checking `body.results` or token authentication details directly. 

- [ ] **Step 5: Run typescript check**

```bash
npx tsc --noEmit forks/landscape-ui/e2e/docker-stack/api/scripts.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add forks/landscape-ui/e2e/docker-stack/api/scripts.spec.ts forks/landscape-ui/e2e/docker-stack/ui/scripts/scripts.integration.spec.ts
git commit -m "test: add api contract tests for scripts and refactor e2e tests"
```

- [ ] **Step 1: Write the test skeleton and validation helpers**

```typescript
import { expect, test } from "@playwright/test";
import type { Publication, PublicationWritable } from "../../../src/features/publications/types/Publication";

function validatePublicationShape(pub: any): pub is Publication {
  expect(pub).toHaveProperty("publicationId");
  expect(pub).toHaveProperty("name");
  expect(pub).toHaveProperty("publicationTarget");
  expect(pub).toHaveProperty("source");
  return true;
}

test.describe("Publications API Contract", () => {
  const testPubName = `test-pub-${Date.now()}`;
  const testTargetName = `test-target-${Date.now()}`; // Need a target to publish to

  test.beforeAll(async ({ request }) => {
    // Publications require a target
    await request.post("/api/v2/publication-targets", {
      data: { name: testTargetName, displayName: "Test Target" }
    });
  });

  test.afterAll(async ({ request }) => {
    // Teardown publication and target
    await request.delete(`/api/v2/publications/${testPubName}`);
    await request.delete(`/api/v2/publication-targets/${testTargetName}`);
  });

  // Tests will go here
});
```

- [ ] **Step 2: Implement POST (Create) test**

```typescript
  test("POST /api/v2/publications accepts PublicationWritable and returns Publication shape", async ({ request }) => {
    const payload: PublicationWritable = {
      name: testPubName,
      publicationTarget: testTargetName,
      source: "ubuntu", // Basic required field
      distribution: "focal",
    };

    const response = await request.post("/api/v2/publications", { data: payload });
    expect(response.ok(), await response.text()).toBeTruthy();
    
    const body = await response.json();
    validatePublicationShape(body);
    expect(body.name).toBe(testPubName);
  });
```

- [ ] **Step 3: Implement GET (List) and Publish tests**

```typescript
  test("GET /api/v2/publications returns ListPublicationsResponse shape", async ({ request }) => {
    const response = await request.get("/api/v2/publications");
    expect(response.ok()).toBeTruthy();
    
    const body = await response.json();
    expect(body).toHaveProperty("publications");
    expect(Array.isArray(body.publications)).toBeTruthy();
    
    if (body.publications.length > 0) {
      validatePublicationShape(body.publications[0]);
    }
  });

  test("POST /api/v2/publications/:name:publish returns PublishPublicationResponse", async ({ request }) => {
    const response = await request.post(`/api/v2/publications/${testPubName}:publish`);
    expect(response.ok(), await response.text()).toBeTruthy();
    
    const body = await response.json();
    // Validate task response shape
    expect(body).toHaveProperty("task");
    expect(body.task).toHaveProperty("status");
  });
```

- [ ] **Step 4: Run typescript check**

```bash
npx tsc --noEmit forks/landscape-ui/e2e/docker-stack/ui/publications/publications-api.integration.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add forks/landscape-ui/e2e/docker-stack/ui/publications/publications-api.integration.spec.ts
git commit -m "test: add api contract tests for publications"
```
