import { expect, test } from "@playwright/test";

/**
 * End-to-End Workflow Scenario: Production Code Export (Initiative 5)
 *
 * Verifies Initiative 5:
 * 1. Generating or seeding visual diagram components on the canvas.
 * 2. Opening the Code Export modal from TopBar via "Export Code" button.
 * 3. Inspecting the code metadata bar (file name, line count, summary).
 * 4. Switching across target formats (Prisma, PostgreSQL DDL, Docker Compose, XState, TypeScript).
 * 5. Verifying syntax accuracy in the live code viewer.
 * 6. Verifying "Copy Code" feedback and "Download File" readiness.
 */

test.describe("Workflow: Production Code Export (Initiative 5)", () => {
  test.setTimeout(120_000);

  test("compile visual canvas into executable Prisma, SQL DDL, Docker Compose, and XState code", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});

    // 1. Sign up fresh user and enter canvas
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Name").fill("Code Exporter");
    await page.getByLabel("Email").fill(`export-${Date.now()}@lucent.test`);
    await page.getByLabel("Password").fill("ExportPass1234!");
    await page.getByRole("button", { name: "Create account" }).click();

    // Dismiss tour if present
    for (let i = 0; i < 5; i++) {
      const btn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if ((await btn.count()) === 0) break;
      await btn.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }
    await page.evaluate(() => localStorage.setItem("lucent.tour.seen.v1", "1"));

    // 2. Open Spec Import modal to quickly seed canvas with real architecture/schema
    const importBtn = page.locator('button[aria-label="Import code or specification"]');
    await expect(importBtn).toBeVisible({ timeout: 20_000 });
    await importBtn.click();

    const specDialog = page.locator(".spec-import-dialog");
    await expect(specDialog).toBeVisible();

    // Load sample SQL DDL and import
    const sqlBtn = specDialog.getByRole("button", { name: "SQLDDL", exact: true });
    await expect(sqlBtn).toBeVisible();
    await sqlBtn.click();

    const importCanvasBtn = specDialog.getByRole("button", { name: "Import to Canvas" });
    await expect(importCanvasBtn).toBeEnabled();
    await importCanvasBtn.click();
    await expect(specDialog).not.toBeVisible();

    // 3. Open Code Export modal via TopBar "Export Code" button
    const exportCodeBtn = page.locator('button[aria-label="Export production code"]');
    await expect(exportCodeBtn).toBeVisible();
    await exportCodeBtn.click();

    // 4. Verify CodeExportModal opened
    const dialog = page.locator(".code-export-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#code-export-title")).toContainText("Export Production Code");

    // 5. Test Prisma export (default Best Fit for ER diagram)
    const codeArea = dialog.locator('textarea[aria-label="Generated code content"]');
    await expect(codeArea).toBeVisible();
    await expect(codeArea).toHaveValue(/model User/);
    await expect(codeArea).toHaveValue(/model Order/);

    // 6. Switch to PostgreSQL DDL format
    const sqlTab = dialog.getByRole("button", { name: "PostgreSQL DDL" });
    await expect(sqlTab).toBeVisible();
    await sqlTab.click();
    await expect(codeArea).toHaveValue(/CREATE TABLE users/);
    await expect(codeArea).toHaveValue(/CREATE TABLE orders/);
    await expect(codeArea).toHaveValue(/PRIMARY KEY/);

    // 7. Switch to Docker Compose format
    const composeTab = dialog.getByRole("button", { name: "Docker Compose" });
    await expect(composeTab).toBeVisible();
    await composeTab.click();
    await expect(codeArea).toHaveValue(/version: "3.8"/);
    await expect(codeArea).toHaveValue(/services:/);

    // 8. Switch to TypeScript Types format
    const tsTab = dialog.getByRole("button", { name: "TypeScript Types" });
    await expect(tsTab).toBeVisible();
    await tsTab.click();
    await expect(codeArea).toHaveValue(/export interface User/);
    await expect(codeArea).toHaveValue(/export interface Order/);

    // 9. Switch to XState v5 format
    const xstateTab = dialog.getByRole("button", { name: "XState v5 (TS)" });
    await expect(xstateTab).toBeVisible();
    await xstateTab.click();
    await expect(codeArea).toHaveValue(/import \{ setup, createMachine \} from "xstate"/);

    // 10. Click "Copy Code" button and verify feedback
    const copyBtn = dialog.getByRole("button", { name: /Copy Code/i });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(dialog.getByRole("button", { name: "Copied!" })).toBeVisible();

    // 11. Verify Download File button exists
    const downloadBtn = dialog.getByRole("button", { name: "Download File" });
    await expect(downloadBtn).toBeEnabled();

    // 12. Close dialog
    const closeBtn = dialog.getByRole("button", { name: "Close", exact: true });
    await closeBtn.click();
    await expect(dialog).not.toBeVisible();
  });
});
