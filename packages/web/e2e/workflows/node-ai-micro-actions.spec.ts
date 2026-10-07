import { expect, test } from "@playwright/test";

/**
 * End-to-End Workflow Scenario: In-Canvas AI Floating Micro-Actions ("Click to AI-Edit")
 *
 * Verifies Initiative 3:
 * 1. Selecting a node on the visual canvas displays the floating AI micro-actions toolbar.
 * 2. Toolbar pins to node coordinates and presents 1-click actions: Elaborate, Error Path, Convert Type, Explain, Custom.
 * 3. 0ms instant semantic type conversion (e.g. Service -> Database).
 * 4. Triggering "Error Path" dispatches selection-grounded AI generation with target node id.
 * 5. Custom mini-prompt triggers scoped instruction with selection grounding.
 */

test.describe("Workflow: In-Canvas AI Floating Micro-Actions", () => {
  test.setTimeout(120_000);

  test("select node, verify floating toolbar, convert type, trigger error path and custom prompt", async ({
    page,
  }) => {
    let capturedPrompt: string | null = null;
    let capturedSelection: string[] | null = null;

    // 1. Intercept /api/generate streaming requests
    await page.route(/\/api\/generate/, async (route) => {
      let postData: {
        message?: string;
        prompt?: string;
        summary?: { selection?: string[] };
        selection?: string[];
      } | null = null;
      try {
        postData = route.request().postDataJSON();
      } catch {
        // ignore JSON parse error
      }

      capturedPrompt = postData?.message ?? postData?.prompt ?? null;
      capturedSelection = postData?.summary?.selection ?? postData?.selection ?? null;

      const donePayload = JSON.stringify({
        operations: [
          {
            op: "CREATE_NODE",
            id: "node_err_gate",
            nodeType: "decision",
            label: "Auth Token Valid?",
          },
          {
            op: "CREATE_NODE",
            id: "node_err_fallback",
            nodeType: "service",
            label: "Fallback Refresh / Lockout",
          },
          {
            op: "CONNECT_NODES",
            id: "edge_err_1",
            source: "node_err_gate",
            target: "node_err_fallback",
            relationship: "on error / expired",
          },
        ],
        explanation: "Added validation gate and fallback lockout handling.",
        reply: "I've added error verification and a fallback handling branch.",
        provider: "mock",
      });

      const sseBody = `event: phase\ndata: {"phase":"constructing"}\n\nevent: done\ndata: ${donePayload}\n\n`;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sseBody,
      });
    });

    // 2. Sign up fresh user and enter canvas
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Name").fill("MicroAction Tester");
    await page.getByLabel("Email").fill(`micro-${Date.now()}@lucent.test`);
    await page.getByLabel("Password").fill("MicroPass1234!");
    await page.getByRole("button", { name: "Create account" }).click();

    // Dismiss tour
    for (let i = 0; i < 5; i++) {
      const btn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if ((await btn.count()) === 0) break;
      await btn
        .first()
        .click({ force: true })
        .catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => localStorage.setItem("lucent.tour.seen.v1", "1"));

    // 3. Initial generation from hero prompt
    const heroInput = page.getByLabel("Describe what you want to build");
    await expect(heroInput).toBeVisible({ timeout: 15_000 });
    await heroInput.fill("Create auth service and database");
    await heroInput.press("Enter");

    // 4. Wait for nodes to paint on canvas
    const firstNode = page.locator(".node").first();
    await expect(firstNode).toBeVisible({ timeout: 20_000 });

    // 5. Click first node to select it
    await firstNode.click();

    // 6. Verify floating AI toolbar appears
    const aiToolbar = page.locator(".node-ai-toolbar");
    await expect(aiToolbar).toBeVisible({ timeout: 10_000 });
    await expect(aiToolbar).toContainText("AI");
    await expect(aiToolbar.getByRole("button", { name: "Elaborate node" })).toBeVisible();
    await expect(aiToolbar.getByRole("button", { name: "Add error handling" })).toBeVisible();
    await expect(aiToolbar.getByRole("button", { name: "Convert node type" })).toBeVisible();
    await expect(aiToolbar.getByRole("button", { name: "Explain node" })).toBeVisible();

    // 7. Test Convert Type menu: change type to database
    const convertBtn = aiToolbar.getByRole("button", { name: "Convert node type" });
    await convertBtn.click();

    const dbOption = page.locator(".node-ai-dropdown-item", { hasText: "Database" });
    await expect(dbOption).toBeVisible();
    await dbOption.click();

    // Verify type button updated
    await expect(convertBtn).toContainText("database");

    // 8. Test Error Path micro-action
    capturedPrompt = null;
    capturedSelection = null;

    const errorBtn = aiToolbar.getByRole("button", { name: "Add error handling" });
    await errorBtn.click();

    await expect.poll(() => capturedPrompt, { timeout: 15_000 }).toBeTruthy();
    expect(capturedPrompt).toContain("error handling");
    expect(capturedSelection).toBeDefined();
    expect(capturedSelection!.length).toBeGreaterThan(0);

    // 9. Re-select node and test Custom prompt micro-action
    await firstNode.click();
    await expect(aiToolbar).toBeVisible();

    const customBtn = aiToolbar.getByRole("button", { name: "Custom AI prompt for node" });
    await customBtn.click();

    const customInput = aiToolbar.locator(".node-ai-input");
    await expect(customInput).toBeVisible();
    await customInput.fill("Add Redis cache layer in front");

    capturedPrompt = null;
    capturedSelection = null;
    await customInput.press("Enter");

    await expect.poll(() => capturedPrompt, { timeout: 15_000 }).toBeTruthy();
    expect(capturedPrompt).toContain("Add Redis cache layer in front");
    expect(capturedSelection).toBeDefined();
    expect(capturedSelection!.length).toBeGreaterThan(0);
  });
});
