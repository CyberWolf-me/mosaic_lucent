import { expect, test } from "@playwright/test";

/**
 * End-to-End Workflow Scenario: Workspace Architectural Rules & Durable Context
 *
 * Verifies Initiative 2:
 * 1. Opening the Workspace Rules modal from TopBar via the Rules button.
 * 2. Selecting an architectural preset (e.g. "GCP Cloud-Native").
 * 3. Inspecting populated fields and toggling the live <workspace-rules> preview.
 * 4. Saving the rules into workspace durable context.
 * 5. Verifying AI generation requests faithfully carry the active workspace rules.
 * 6. Verifying rules persist upon reopening the modal and can be edited.
 */

test.describe("Workflow: Workspace Architectural Rules & Durable Context", () => {
  test.setTimeout(120_000);

  test("configure architectural presets, verify preview, save, and ensure rules steer generation", async ({
    page,
  }) => {
    let capturedRules: string | null = null;

    // 1. Intercept /api/generate streaming requests to verify rules payload delivery
    await page.route(/\/api\/generate/, async (route) => {
      let postData: any = null;
      try {
        postData = route.request().postDataJSON();
      } catch {}

      if (postData?.rules) {
        capturedRules = postData.rules;
      }

      const donePayload = JSON.stringify({
        operations: [
          {
            op: "CREATE_NODE",
            id: "node_gcp_1",
            nodeType: "service",
            label: "Cloud Run: Auth Service",
          },
          {
            op: "CREATE_NODE",
            id: "node_gcp_2",
            nodeType: "database",
            label: "Cloud Spanner: User DB",
          },
          {
            op: "CONNECT_NODES",
            id: "edge_gcp_1",
            source: "node_gcp_1",
            target: "node_gcp_2",
            relationship: "reads/writes",
          },
        ],
        explanation: "Constructed GCP Cloud-Native microservices honoring workspace architectural rules.",
        reply: "I've created the Cloud Run Auth Service connected to Cloud Spanner following your GCP rules.",
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
    await page.getByLabel("Name").fill("Rules Architect");
    await page.getByLabel("Email").fill(`rules-${Date.now()}@lucent.test`);
    await page.getByLabel("Password").fill("ArchPass1234!");
    await page.getByRole("button", { name: "Create account" }).click();

    // Dismiss tour if present
    for (let i = 0; i < 5; i++) {
      const btn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if ((await btn.count()) === 0) break;
      await btn.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => localStorage.setItem("lucent.tour.seen.v1", "1"));

    // 3. Find and click the "Rules" button in TopBar
    const rulesBtn = page.locator('button[aria-label="Workspace architectural rules"]');
    await expect(rulesBtn).toBeVisible({ timeout: 20_000 });
    await rulesBtn.click();

    // 4. Verify WorkspaceRulesModal opened
    const dialog = page.locator(".workspace-rules-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#workspace-rules-title")).toContainText(
      "Workspace Architectural Rules",
    );

    // 5. Select the "GCP Cloud-Native" preset chip
    const gcpChip = dialog.locator(".rule-template-chip", { hasText: "GCP Cloud-Native" });
    await expect(gcpChip).toBeVisible();
    await gcpChip.click();

    // 6. Verify inputs populated with GCP preset
    const cloudStackInput = dialog.locator('input[placeholder*="Google Cloud Platform"]');
    await expect(cloudStackInput).toHaveValue("Google Cloud Platform (GCP)");

    const languagesInput = dialog.locator('input[placeholder*="Go 1.22"]');
    await expect(languagesInput).toHaveValue("Go 1.22, TypeScript, gRPC");

    const databasesInput = dialog.locator('input[placeholder*="PostgreSQL 16"]');
    await expect(databasesInput).toHaveValue(
      "Cloud Spanner (relational), Firestore (documents), Cloud Storage (blobs)",
    );

    // 7. Toggle live preview
    const previewToggle = dialog.locator(".rule-preview-toggle-btn");
    await expect(previewToggle).toBeVisible();
    await previewToggle.click();

    const previewBlock = dialog.locator(".rule-preview-content");
    await expect(previewBlock).toBeVisible();
    await expect(previewBlock).toContainText("workspace-rules");
    await expect(previewBlock).toContainText("Google Cloud Platform (GCP)");

    // 8. Click "Save Rules"
    const saveBtn = dialog.locator('button:has-text("Save Rules")');
    await saveBtn.click();

    // Modal should close
    await expect(dialog).not.toBeVisible();

    // 9. Send an AI prompt via hero prompt
    const heroInput = page.getByLabel("Describe what you want to build");
    await expect(heroInput).toBeVisible({ timeout: 15_000 });
    await heroInput.fill("Design user login flow");
    await heroInput.press("Enter");

    // 10. Verify intercepted generate request carried the serialized GCP rules
    await expect.poll(() => capturedRules, { timeout: 15_000 }).toBeTruthy();
    expect(capturedRules).toContain("Google Cloud Platform (GCP)");
    expect(capturedRules).toContain("Cloud Spanner");

    // 11. Verify diagram nodes appeared on canvas
    await expect(page.locator(".node").first()).toBeVisible({ timeout: 20_000 });

    // 12. Re-open Rules modal to confirm rules persisted in state
    await rulesBtn.click();
    await expect(dialog).toBeVisible();
    await expect(cloudStackInput).toHaveValue("Google Cloud Platform (GCP)");

    // Modify a field: add custom constraint
    const customTextarea = dialog.locator(".rule-field-textarea");
    await customTextarea.fill("Strictly mandate mTLS for internal communication.");

    // Save modified rules
    await saveBtn.click();
    await expect(dialog).not.toBeVisible();

    // Trigger another generation via Ask Lucent bottom bar
    capturedRules = null;
    const aiPillInput = page.getByLabel("Ask Lucent");
    await expect(aiPillInput).toBeVisible({ timeout: 15_000 });
    await aiPillInput.fill("Add payment gateway service");
    await aiPillInput.press("Enter");

    await expect.poll(() => capturedRules, { timeout: 15_000 }).toBeTruthy();
    expect(capturedRules).toContain("Strictly mandate mTLS");
  });
});
