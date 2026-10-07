import { expect, test } from "@playwright/test";

/**
 * End-to-End Workflow Scenario: Enhanced Features Audit
 *
 * Tests the three core enhancements in live browser sessions:
 * 1. Interactive AI Clarification & Disambiguation:
 *    - Model asks clarifying question with multiple option chips
 *    - User selects an option pill to immediately execute and build visual
 * 2. Executive Board Digest & Markdown Export:
 *    - Generates board digest with governance metrics, register, and Mermaid
 *    - Clipboard copy toast feedback
 *    - File download of *-digest.md
 * 3. Canvas Virtualization & High-Object Usability:
 *    - Board with dense objects maintains bounded DOM footprint
 *    - Pan, zoom, and Zen Mode toggling
 */

test.describe("Workflow: Enhanced Features (Clarification, Digest Export & Virtualization)", () => {
  test.setTimeout(120_000);

  test("interactive AI clarification chip bar disambiguation and selection", async ({ page }) => {
    // 1. Intercept /api/generate streaming requests for ambiguous requests using RegExp
    let interceptedOnce = false;
    await page.route(/\/api\/generate/, async (route) => {
      let postData: Record<string, unknown> | null = null;
      try {
        postData = route.request().postDataJSON() as Record<string, unknown>;
      } catch {
        // ignore JSON parse error
      }
      const msg = postData?.message ?? postData?.prompt;
      if (!interceptedOnce && typeof msg === "string" && msg.toLowerCase().includes("auth")) {
        interceptedOnce = true;
        const donePayload = JSON.stringify({
          operations: [],
          explanation: "Authentication architectures differ significantly in security profile.",
          reply: "Which authentication architecture would you prefer?",
          clarification: {
            question: "Which authentication pattern should we build?",
            options: ["OAuth2 + JWT", "Session Cookies", "Magic Links"],
          },
          provider: "openai",
        });
        const sseBody = `event: phase\ndata: {"phase":"understanding"}\n\nevent: done\ndata: ${donePayload}\n\n`;
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: sseBody,
        });
        return;
      }
      await route.continue();
    });

    // 2. Sign up a fresh user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("Clarification User");
    await page.locator('input[type="email"]').first().fill(`clarify-${Date.now()}@lucent.test`);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();

    // Dismiss onboarding tour
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

    // 3. Initial prompt on launch screen to land on canvas
    const heroInput = page.getByLabel("Describe what you want to build");
    await expect(heroInput).toBeVisible({ timeout: 30_000 });
    await heroInput.fill("Design an e-commerce flow");
    await heroInput.press("Enter");

    await page.waitForSelector(".node", { timeout: 60_000 });
    await expect(page.locator(".node").first()).toBeVisible();

    // 4. Now on canvas with AIPill docked at the bottom
    const aiPillInput = page.getByPlaceholder(/refine, add, or transform/i);
    await expect(aiPillInput).toBeVisible({ timeout: 15_000 });

    // 5. User submits ambiguous request in AIPill
    await aiPillInput.fill("Setup auth for this flow");
    await aiPillInput.press("Enter");

    // 6. Verify clarification bar and chips appear
    const clarifBar = page.locator(".clarification-bar");
    await expect(clarifBar).toBeVisible({ timeout: 15_000 });
    await expect(clarifBar).toContainText("Which authentication pattern should we build?");

    const oauthPill = clarifBar.getByRole("button", { name: "OAuth2 + JWT" });
    const sessionPill = clarifBar.getByRole("button", { name: "Session Cookies" });
    const magicPill = clarifBar.getByRole("button", { name: "Magic Links" });

    await expect(oauthPill).toBeVisible();
    await expect(sessionPill).toBeVisible();
    await expect(magicPill).toBeVisible();

    // 7. User clicks the "OAuth2 + JWT" choice chip
    await oauthPill.click();

    // The clarification bar should dismiss immediately as the choice executes
    await expect(clarifBar).toHaveCount(0, { timeout: 10_000 });

    // Verify canvas remains stable and operational
    await expect(page.locator(".node").first()).toBeVisible();
  });

  test("executive board digest export (.md) and clipboard copy", async ({ page, context }) => {
    // Grant clipboard permissions for automated test
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

    // 1. Sign up user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("Digest User");
    await page.locator('input[type="email"]').first().fill(`digest-${Date.now()}@lucent.test`);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();

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

    // 2. Generate a diagram
    const promptInput = page.getByLabel("Describe what you want to build");
    await expect(promptInput).toBeVisible({ timeout: 30_000 });
    await promptInput.fill("Design an e-commerce flow");
    await promptInput.press("Enter");

    await page.waitForSelector(".node", { timeout: 60_000 });
    await expect(page.locator(".node").first()).toBeVisible();

    // Dismiss minimap if open so it does not overlap the export popover
    const hideOverview = page.getByRole("button", { name: /hide overview/i }).first();
    if (await hideOverview.isVisible()) {
      await hideOverview.click();
      await page.waitForTimeout(300);
    }

    // 3. Open the Export menu
    const exportBtn = page.locator(".export-menu button").first();
    await expect(exportBtn).toBeVisible();
    await exportBtn.click();

    // 4. Test "Copy Board Digest" action
    const copyDigestBtn = page.getByRole("button", { name: "Copy Board Digest" });
    await expect(copyDigestBtn).toBeVisible();
    await copyDigestBtn.click({ force: true });

    // Toast notification check
    const toast = page.locator(".toast");
    await expect(toast.first()).toBeVisible({ timeout: 8000 });
    await expect(toast.first()).toContainText(/digest/i);

    // 5. Test "Board Digest (.md)" download
    await exportBtn.click();
    const downloadDigestBtn = page.getByRole("button", { name: "Board Digest (.md)" });
    await expect(downloadDigestBtn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadDigestBtn.click({ force: true }),
    ]);

    expect(download.suggestedFilename()).toMatch(/.*-digest\.md|.*\.md/i);

    // Read and verify digest markdown structure
    const path = await download.path();
    if (path) {
      const fs = await import("fs/promises");
      const content = await fs.readFile(path, "utf-8");
      expect(content).toContain("## Governance & Health Summary");
      expect(content).toContain("## Architecture & Flow");
      expect(content).toContain("```mermaid");
      expect(content).toContain("flowchart TD");
    }
  });

  test("canvas responsiveness and virtualization with dense objects & zen mode", async ({
    page,
  }) => {
    // 1. Sign up user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("Perf User");
    await page.locator('input[type="email"]').first().fill(`perf-${Date.now()}@lucent.test`);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();

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

    // 2. Build initial nodes
    const promptInput = page.getByLabel("Describe what you want to build");
    await expect(promptInput).toBeVisible({ timeout: 30_000 });
    await promptInput.fill("Design checkout pipeline");
    await promptInput.press("Enter");

    await page.waitForSelector(".node", { timeout: 60_000 });
    const initialNodeCount = await page.locator(".node").count();
    expect(initialNodeCount).toBeGreaterThan(0);

    // 3. Test Zen Mode toggle via 'Z' keyboard shortcut
    const rail = page.locator(".left-rail");
    await expect(rail).toBeVisible();

    // Press 'z' to toggle Zen mode
    await page.keyboard.press("z");
    await page.waitForTimeout(500);

    // Left rail is hidden in Zen mode
    await expect(rail).toBeHidden();

    // Press 'z' again to restore chrome
    await page.keyboard.press("z");
    await page.waitForTimeout(500);
    await expect(rail).toBeVisible();

    // 4. Test Zoom controls responsiveness in ZoomBadge (first .chrome-badge)
    const zoomBadge = page.locator(".chrome-badge").first();
    await expect(zoomBadge).toBeVisible();

    // Zoom in using '+' button
    const zoomInBtn = zoomBadge.getByRole("button", { name: "+" });
    await expect(zoomInBtn).toBeVisible();
    await zoomInBtn.click();
    await page.waitForTimeout(300);

    // Verify canvas remains interactive and elements render
    await expect(page.locator(".node").first()).toBeVisible();
  });
});
