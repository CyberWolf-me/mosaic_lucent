import { expect, test } from "@playwright/test";

/**
 * Workflow Scenario: Unified Canvas & Multi-Lens Transformation
 *
 * Validates that:
 * 1. An authenticated user can describe and construct a semantic diagram.
 * 2. Switching across lenses (Diagram -> Kanban -> Wireframe -> Document -> Diagram)
 *    occurs seamlessly on the SAME board without opening disjointed screens
 *    or losing nodes.
 * 3. The conversational prompt pill remains active and contextual across all lenses.
 */
test.describe("Workflow: Unified Canvas & Multi-Lens Transformation", () => {
  test("construct diagram and transition across Kanban, Wireframe, Document, and Visual lenses", async ({
    page,
  }) => {
    // 1. Sign up a fresh user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("Lens User");
    await page.locator('input[type="email"]').first().fill(`lens-${Date.now()}@lucent.test`);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();

    // 2. Dismiss onboarding modals if present
    for (let i = 0; i < 5; i++) {
      const btn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if ((await btn.count()) === 0) break;
      await btn
        .first()
        .click({ force: true })
        .catch(() => {});
      await page.waitForTimeout(300);
    }

    // 3. Prompt the canvas to build a flow
    const promptInput = page.getByLabel("Describe what you want to build");
    await expect(promptInput).toBeVisible({ timeout: 30_000 });
    await promptInput.fill("E-commerce checkout: Cart, Shipping, Payment, Confirmation");
    await promptInput.press("Enter");

    // 4. Wait for nodes to appear on visual canvas
    await page.waitForSelector(".node", { timeout: 60_000 });
    const initialNodes = await page.locator(".node").count();
    expect(initialNodes).toBeGreaterThanOrEqual(1);

    // Verify visual diagram lens is active by default
    const diagramLensBtn = page.locator('.rail-lens[aria-label="Diagram lens"]');
    await expect(diagramLensBtn).toBeVisible();
    await expect(diagramLensBtn).toHaveAttribute("aria-pressed", "true");

    // 5. Switch to KANBAN lens on the SAME board
    const kanbanLensBtn = page.locator('.rail-lens[aria-label="Kanban lens"]');
    await expect(kanbanLensBtn).toBeVisible();
    await kanbanLensBtn.click();

    // Verify that the URL updates with lens=kanban
    await expect(page).toHaveURL(/lens=kanban/);

    // Verify Kanban lens button is active
    await expect(kanbanLensBtn).toHaveAttribute("aria-pressed", "true");
    await expect(diagramLensBtn).toHaveAttribute("aria-pressed", "false");

    // Verify breadcrumb shows "Kanban" on this board
    await expect(page.locator(".crumb.current")).toContainText("Kanban");

    // Verify AI pill is available with Kanban contextual placeholder
    const kanbanPillInput = page.locator("textarea");
    await expect(kanbanPillInput).toBeVisible();
    await expect(kanbanPillInput).toHaveAttribute(
      "placeholder",
      /Add a story, move a card, assign someone/i,
    );

    // 6. Switch to WIREFRAME lens on the SAME board
    const wireframeLensBtn = page.locator('.rail-lens[aria-label="Wireframe lens"]');
    await expect(wireframeLensBtn).toBeVisible();
    await wireframeLensBtn.click();

    await expect(page).toHaveURL(/lens=wireframe/);
    await expect(wireframeLensBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".crumb.current")).toContainText("Wireframe");

    // Verify AI pill is available with Wireframe placeholder
    await expect(kanbanPillInput).toHaveAttribute(
      "placeholder",
      /Describe a screen, add UI elements/i,
    );

    // 7. Switch to DOCUMENT lens on the SAME board
    const docLensBtn = page.locator('.rail-lens[aria-label="Document lens"]');
    await expect(docLensBtn).toBeVisible();
    await docLensBtn.click();

    await expect(page).toHaveURL(/lens=document/);
    await expect(docLensBtn).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".crumb.current")).toContainText("Document");

    // 8. Switch BACK to Diagram lens
    await diagramLensBtn.click();
    await expect(diagramLensBtn).toHaveAttribute("aria-pressed", "true");
    await expect(kanbanLensBtn).toHaveAttribute("aria-pressed", "false");

    // Verify the nodes are still present and intact!
    const restoredNodes = await page.locator(".node").count();
    expect(restoredNodes).toBe(initialNodes);

    // Verify the nodes are visible and interactive
    const firstNode = page.locator(".node").first();
    await expect(firstNode).toBeVisible();
    await expect(firstNode).toHaveAttribute("role", "button");
  });
});
