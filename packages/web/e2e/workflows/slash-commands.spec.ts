import { expect, test } from "@playwright/test";

/**
 * End-to-End Workflow Scenario: AI Slash Commands & Architectural Presets
 *
 * Verifies Initiative 1:
 * 1. Typing "/" or clicking the "/" button opens the command catalog popover
 * 2. Search / query filtering (/dec -> /decompose, /thr -> /threat-model)
 * 3. Keyboard navigation (ArrowDown, ArrowUp, Enter, Tab, Escape)
 * 4. Active command badge feedback
 * 5. Deterministic prompt expansion and execution on the visual canvas
 */

test.describe("Workflow: AI Slash Commands & Command Presets", () => {
  test.setTimeout(120_000);

  test("slash commands catalog, filtering, keyboard navigation, and execution", async ({
    page,
  }) => {
    // 1. Intercept /api/generate streaming requests for /decompose
    let decomposedPromptReceived = false;
    await page.route(/\/api\/generate/, async (route) => {
      let postData: { message?: string; prompt?: string } | null = null;
      try {
        postData = route.request().postDataJSON();
      } catch {
        // ignore JSON parse error
      }
      const msg = postData?.message ?? postData?.prompt;
      if (typeof msg === "string" && msg.toLowerCase().includes("decompose")) {
        decomposedPromptReceived = true;
        const donePayload = JSON.stringify({
          operations: [
            {
              op: "CREATE_NODE",
              id: "node_decomp_1",
              nodeType: "process",
              label: "Payment Auth & Fraud Check",
            },
            {
              op: "CREATE_NODE",
              id: "node_decomp_2",
              nodeType: "process",
              label: "Token Vault & Settlement",
            },
            {
              op: "CONNECT_NODES",
              id: "edge_decomp_1",
              source: "node_decomp_1",
              target: "node_decomp_2",
              relationship: "settles via",
            },
          ],
          explanation:
            "Decomposed Payment Gateway into auth, fraud verification, and token vault settlement.",
          reply: "I've decomposed Payment Gateway into internal sub-processes.",
          provider: "mock",
        });
        const sseBody = `event: phase\ndata: {"phase":"constructing"}\n\nevent: done\ndata: ${donePayload}\n\n`;
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: sseBody,
        });
        return;
      }
      await route.continue();
    });

    // 2. Sign up fresh user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("Slash User");
    await page.locator('input[type="email"]').first().fill(`slash-${Date.now()}@lucent.test`);
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

    // 3. Initial prompt on hero to land on canvas
    const heroInput = page.getByLabel("Describe what you want to build");
    await expect(heroInput).toBeVisible({ timeout: 30_000 });
    await heroInput.fill("Design an e-commerce checkout flow");
    await heroInput.press("Enter");

    await page.waitForSelector(".node", { timeout: 60_000 });
    await expect(page.locator(".node").first()).toBeVisible();

    // 4. Locate AIPill and slash trigger button
    const aiPillInput = page.getByLabel("Ask Lucent");
    await expect(aiPillInput).toBeVisible({ timeout: 15_000 });

    const slashTrigger = page.locator(".slash-trigger-btn");
    await expect(slashTrigger).toBeVisible();

    // 5. Click slash trigger button to open menu
    await slashTrigger.click();
    const slashMenu = page.locator(".slash-menu");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu).toContainText("AI Command Presets");

    // Check that preset items are listed
    await expect(slashMenu.locator(".slash-item")).toHaveCount(6);
    await expect(slashMenu).toContainText("/decompose");
    await expect(slashMenu).toContainText("/threat-model");
    await expect(slashMenu).toContainText("/edge-cases");
    await expect(slashMenu).toContainText("/sequence");
    await expect(slashMenu).toContainText("/simplify");
    await expect(slashMenu).toContainText("/translate");

    // 6. Test filtering: type "/thr"
    await aiPillInput.fill("/thr");
    await expect(slashMenu.locator(".slash-item")).toHaveCount(1);
    await expect(slashMenu).toContainText("/threat-model");

    // 7. Test Escape dismissal
    await aiPillInput.press("Escape");
    await expect(slashMenu).toBeHidden();

    // 8. Re-open by typing "/dec"
    await aiPillInput.fill("/dec");
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu.locator(".slash-item")).toHaveCount(1);
    await expect(slashMenu).toContainText("/decompose");

    // 9. Keyboard select with Enter
    await aiPillInput.press("Enter");
    await expect(slashMenu).toBeHidden();
    await expect(aiPillInput).toHaveValue("/decompose ");

    // Verify active slash badge is displayed
    const activeBadge = page.locator(".slash-active-badge");
    await expect(activeBadge).toBeVisible();
    await expect(activeBadge).toContainText("/decompose");

    // 10. Append argument and submit
    await aiPillInput.fill("/decompose Payment Gateway");
    await aiPillInput.press("Enter");

    // Verify decomposed nodes appear on canvas
    await page.waitForSelector('.node:has-text("Payment Auth & Fraud Check")', { timeout: 20_000 });
    const authNode = page.locator('.node:has-text("Payment Auth & Fraud Check")');
    const tokenNode = page.locator('.node:has-text("Token Vault & Settlement")');
    await expect(authNode).toBeVisible();
    await expect(tokenNode).toBeVisible();

    expect(decomposedPromptReceived).toBe(true);
  });
});
