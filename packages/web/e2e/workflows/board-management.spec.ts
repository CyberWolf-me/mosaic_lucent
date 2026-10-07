import { expect, test } from "@playwright/test";

/**
 * Workflow Scenario: Multi-Board Creation, Inline Renaming & Workspace Isolation
 *
 * Validates that:
 * 1. An authenticated user can inline rename a board via the breadcrumb header.
 * 2. Generating nodes constructs the structured semantic model on Board 1.
 * 3. Creating a new board (Board 2) from Dashboard/Rail produces an isolated clean canvas.
 * 4. Inline renaming and node construction on Board 2 succeeds.
 * 5. The Dashboard lists both boards distinctly.
 * 6. Switching between Board 1 and Board 2 seamlessly restores each board's distinct
 *    semantic graph and title without leaking nodes or state across boards.
 */
test.describe("Workflow: Multi-Board Management & Workspace Isolation", () => {
  test("create, rename, construct nodes, and switch between isolated boards", async ({ page }) => {
    // 1. Sign up a fresh user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("Board User");
    await page.locator('input[type="email"]').first().fill(`board-${Date.now()}@lucent.test`);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();

    // Dismiss any onboarding modals
    for (let i = 0; i < 5; i++) {
      const btn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if ((await btn.count()) === 0) break;
      await btn
        .first()
        .click({ force: true })
        .catch(() => {});
      await page.waitForTimeout(300);
    }

    await page.evaluate(() => {
      localStorage.setItem("lucent.tour.seen.v1", "1");
    });

    // Wait for canvas to mount
    const promptInput = page.getByLabel("Describe what you want to build");
    await expect(promptInput).toBeVisible({ timeout: 30_000 });

    // 2. Rename Board 1 to "Architecture Alpha" via inline breadcrumb
    const crumbTitle = page.locator(".crumb.current.editable");
    await expect(crumbTitle).toBeVisible();
    await crumbTitle.click();

    const titleInput = page.locator(".crumb-title-input");
    await expect(titleInput).toBeVisible();
    await titleInput.fill("Architecture Alpha");
    await titleInput.press("Enter");

    await expect(page.locator(".crumb.current")).toContainText("Architecture Alpha");

    // 3. Construct diagram on Board 1
    await promptInput.fill("Define pricing model for our platform");
    await promptInput.press("Enter");

    await page.waitForSelector(".node", { timeout: 60_000 });
    await expect(page.locator(".node").first()).toBeVisible();
    await expect(page.getByText(/Pricing Model/i).first()).toBeVisible();

    // 4. Navigate to Boards Dashboard
    const boardsNavBtn = page.locator('.rail-btn[aria-label="Boards"]:visible');
    await boardsNavBtn.click();
    await expect(page).toHaveURL(/view=dashboard/);

    // Verify Board 1 appears in the Dashboard list
    await expect(page.locator(".boards-card-name", { hasText: "Architecture Alpha" })).toBeVisible({
      timeout: 15_000,
    });

    // 5. Create a new board (Board 2)
    const newBoardBtn = page.locator(".page-header").getByRole("button", { name: "New board" });
    if ((await newBoardBtn.count()) > 0) {
      await newBoardBtn.first().click();
    } else {
      await page.locator(".rail-new").first().click();
    }

    const confirmWorkspaceBtn = page.getByRole("button", { name: /new workspace/i });
    if ((await confirmWorkspaceBtn.count()) > 0) {
      await confirmWorkspaceBtn.first().click();
    }

    // Verify redirected to Canvas with a fresh empty state
    await expect(page).toHaveURL(/view=canvas/);

    // Dismiss tour dialog if triggered
    const skipBtn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close)$/i });
    if ((await skipBtn.count()) > 0) {
      await skipBtn
        .first()
        .click()
        .catch(() => {});
    }

    // 6. Rename Board 2 to "Checkout Flow"
    await expect(crumbTitle).toBeVisible();
    await crumbTitle.click();
    await expect(titleInput).toBeVisible();
    await titleInput.fill("Checkout Flow");
    await titleInput.press("Enter");
    await expect(page.locator(".crumb.current")).toContainText("Checkout Flow");

    // 7. Construct diagram on Board 2
    const board2PromptInput = page.getByLabel("Describe what you want to build");
    await expect(board2PromptInput).toBeVisible();
    await board2PromptInput.fill(
      "Build an e-commerce online store with shopping cart and checkout",
    );
    await board2PromptInput.press("Enter");

    await page.waitForSelector(".node", { timeout: 60_000 });
    await expect(page.locator(".node").first()).toBeVisible();
    await expect(page.getByText(/Cart/i).first()).toBeVisible();
    await expect(page.getByText(/Checkout|Payment|Store|Shop|Order/i).first()).toBeVisible();

    // Board 2 must NOT have nodes from Board 1
    await expect(page.getByText(/Pricing Model/i)).toHaveCount(0);

    // 8. Navigate back to Boards Dashboard
    await boardsNavBtn.click();
    await expect(page).toHaveURL(/view=dashboard/);

    // Verify both boards are present in the list
    const alphaCard = page.locator(".boards-card", { hasText: "Architecture Alpha" });
    const checkoutCard = page.locator(".boards-card", { hasText: "Checkout Flow" });
    await expect(alphaCard).toBeVisible({ timeout: 15_000 });
    await expect(checkoutCard).toBeVisible({ timeout: 15_000 });

    // 9. Switch back to Board 1 ("Architecture Alpha")
    await alphaCard.locator(".boards-card-open").click();
    await expect(page).toHaveURL(/view=canvas/);

    // Verify Board 1 state: correct title and nodes restored
    await expect(page.locator(".crumb.current")).toContainText("Architecture Alpha");
    await page.waitForSelector(".node", { timeout: 15_000 });
    await expect(page.getByText(/Pricing Model/i).first()).toBeVisible();
    // Board 1 must NOT contain Board 2's nodes
    await expect(page.getByText(/Cart/i)).toHaveCount(0);

    // 10. Switch back to Board 2 ("Checkout Flow")
    await boardsNavBtn.click();
    await expect(page).toHaveURL(/view=dashboard/);

    await checkoutCard.locator(".boards-card-open").click();
    await expect(page).toHaveURL(/view=canvas/);

    // Verify Board 2 state: correct title and nodes restored
    await expect(page.locator(".crumb.current")).toContainText("Checkout Flow");
    await page.waitForSelector(".node", { timeout: 15_000 });
    await expect(page.getByText(/Cart/i).first()).toBeVisible();
    await expect(page.getByText(/Pricing Model/i)).toHaveCount(0);
  });
});
