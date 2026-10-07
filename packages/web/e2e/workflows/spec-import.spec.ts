import { expect, test } from "@playwright/test";

/**
 * End-to-End Workflow Scenario: Code & Specification Ingestion (Initiative 4)
 *
 * Verifies Initiative 4:
 * 1. Opening the Spec Import modal from TopBar via the "Import" button.
 * 2. Testing sample SQL DDL loading, format auto-detection, and live entity preview metrics.
 * 3. Importing SQL DDL into the canvas and verifying structured ER nodes render with column details.
 * 4. Opening the Spec Import modal and testing sample Docker Compose loading.
 * 5. Importing Docker Compose and verifying architecture service nodes render on canvas.
 */

test.describe("Workflow: Code & Specification Ingestion (Initiative 4)", () => {
  test.setTimeout(120_000);

  test("import SQL DDL schema and Docker Compose architecture into interactive canvas visuals", async ({
    page,
  }) => {
    // 1. Sign up fresh user and enter canvas
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Name").fill("Spec Engineer");
    await page.getByLabel("Email").fill(`spec-${Date.now()}@lucent.test`);
    await page.getByLabel("Password").fill("SpecPass1234!");
    await page.getByRole("button", { name: "Create account" }).click();

    // Dismiss tour if present
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

    // 2. Locate and click TopBar "Import" button
    const importBtn = page.locator('button[aria-label="Import code or specification"]');
    await expect(importBtn).toBeVisible({ timeout: 20_000 });
    await importBtn.click();

    // 3. Verify SpecImportModal opened
    const dialog = page.locator(".spec-import-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#spec-import-title")).toContainText(
      "Import Code & Specifications",
    );

    // 4. Click sample SQL button
    const sqlSampleBtn = dialog.getByRole("button", { name: "SQLDDL", exact: true });
    await expect(sqlSampleBtn).toBeVisible();
    await sqlSampleBtn.click();

    // 5. Verify live metrics preview indicates entities ready to construct
    await expect(dialog).toContainText("Ready to construct:");
    await expect(dialog).toContainText("Target: Entity Relationship (ER)");

    // 6. Click "Import to Canvas" button
    const importCanvasBtn = dialog.getByRole("button", { name: "Import to Canvas" });
    await expect(importCanvasBtn).toBeEnabled();
    await importCanvasBtn.click();

    // 7. Verify modal dismissed and canvas rendered ER entity tables
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".er-entity-head", { hasText: "users" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".er-entity-head", { hasText: "orders" })).toBeVisible();
    await expect(page.locator(".er-entity-head", { hasText: "products" })).toBeVisible();

    // 8. Re-open modal to import Docker Compose
    await importBtn.click();
    await expect(dialog).toBeVisible();

    // 9. Click sample Compose button
    const composeSampleBtn = dialog.getByRole("button", { name: "COMPOSE", exact: true });
    await expect(composeSampleBtn).toBeVisible();
    await composeSampleBtn.click();

    // 10. Verify live preview for Compose
    await expect(dialog).toContainText("Target: Architecture");
    await expect(importCanvasBtn).toBeEnabled();
    await importCanvasBtn.click();

    // 11. Verify modal dismissed and docker compose nodes rendered
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".node-title", { hasText: "gateway" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator(".node-title", { hasText: "postgres" })).toBeVisible();
    await expect(page.locator(".node-title", { hasText: "redis" })).toBeVisible();
  });
});
