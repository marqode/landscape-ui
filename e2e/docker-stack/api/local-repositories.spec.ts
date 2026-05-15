import { expect, test } from "@playwright/test";
import type { Local, LocalWritable } from "@canonical/landscape-openapi";

function validateLocalShape(repo: Local): repo is Local {
  expect(repo).toHaveProperty("name");
  return true;
}

test.describe("Local Repositories API Contract", () => {
  const testRepoName = `test-local-repo-${Date.now()}`;

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/v2/locals/${testRepoName}`);
  });

  test("POST /api/v2/locals accepts payload and returns Local shape", async ({
    request,
  }) => {
    const payload: LocalWritable = {
      displayName: "Test Repository",
      name: testRepoName,
      comment: "A test repository created by Playwright API test",
      defaultDistribution: "focal",
      defaultComponent: "main",
    };

    const response = await request.post("/api/v2/locals", { data: payload });
    expect(response.ok(), await response.text()).toBeTruthy();

    const body = await response.json();
    validateLocalShape(body);
    expect(body.name).toBe(testRepoName);
  });

  test("GET /api/v2/locals returns list containing our repo", async ({
    request,
  }) => {
    const response = await request.get("/api/v2/locals");
    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body).toHaveProperty("locals");
    expect(Array.isArray(body.locals)).toBeTruthy();

    if (body.locals.length > 0) {
      validateLocalShape(body.locals[0]);
    }

    const found = body.locals.find((repo: Local) => repo.name === testRepoName);
    expect(found).toBeDefined();
  });
});
