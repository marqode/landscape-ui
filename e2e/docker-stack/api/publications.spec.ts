import { expect, test } from "@playwright/test";
import type { Publication, PublicationWritable } from "@canonical/landscape-openapi";

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

  test("POST /api/v2/publications accepts PublicationWritable and returns Publication shape", async ({ request }) => {
    const payload: PublicationWritable = {
      name: testPubName,
      displayName: "Test Publication", // required by PublicationWritable
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
});
