import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * The plan-promised E2E (H): the first-minute story against the real stack —
 * Vite dev server proxying to the backend, mock provider, auth on.
 *
 * 1. Anonymous visitor → the sign-in screen (rendered at `/`, no redirect).
 * 2. Sign up → the canvas with its hero prompt.
 * 3. Describe an e-commerce flow → the mock provider's seed graph paints.
 * 4. An axe scan on each screen a first-time user actually sees.
 *
 * Kept deliberately small: this is the smoke the CI runs on every push. The
 * deep collaboration flows live in the server's own e2e suite; duplicating
 * them through a browser would test Playwright more than the product.
 */
test("signup → describe → mock generation paints the canvas", async ({ page }) => {
  await page.goto("/");

  // Anonymous: the app shows its auth card without moving the URL.
  await expect(page.getByRole("button", { name: "Create an account" })).toBeVisible({
    timeout: 30_000,
  });
  const auth = await new AxeBuilder({ page }).analyze();
  expect(auth.violations.filter((v) => v.impact === "critical")).toEqual([]);

  // Sign up (email is not verified; basic signup works without it).
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(`e2e-${Date.now()}@lucent.test`);
  await page.getByLabel("Password").fill("password-long-enough");
  await page.getByRole("button", { name: "Create account" }).click();

  // A fresh user lands on the canvas, which shows the hero prompt while empty.
  const prompt = page.getByPlaceholder(/I'm building an e-commerce platform/i);
  await expect(prompt).toBeVisible({ timeout: 30_000 });

  // Describe something. The mock provider answers with the e-commerce seed.
  await prompt.fill("Design an e-commerce flow");
  await prompt.press("Enter");

  // The graph the mock builds: the Customer actor and its first edge.
  await expect(page.getByText("Customer").first()).toBeVisible({ timeout: 60_000 });

  // The surface users spend their day on.
  const canvas = await new AxeBuilder({ page }).analyze();
  expect(canvas.violations.filter((v) => v.impact === "critical")).toEqual([]);
});

test("an anonymous visitor sees the sign-in card, not the workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 30_000 });
  // And the workspace chrome is not mounted for them.
  await expect(page.getByRole("button", { name: "Meeting mode" })).toHaveCount(0);
});
