import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";

async function runTest() {
  console.log("=== TESTING SETTINGS & MEETING REDESIGN ===");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // 1. Check auth on 5173
  console.log("Navigating to http://localhost:5173...");
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const demoLoginBtn = page.locator('button:has-text("Continue as Alex Kim")');
  if ((await demoLoginBtn.count()) > 0 && (await demoLoginBtn.isVisible())) {
    console.log("Signing in with demo account...");
    await demoLoginBtn.click();
    await page.waitForTimeout(1500);
  }

  // 2. Test Settings Modal
  console.log("Opening Settings Modal via keyboard shortcut...");
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(600);

  const modal = page.locator('.settings-modal');
  if (!(await modal.isVisible())) {
    console.log("Pressing Meta+, or clicking settings button...");
    await page.keyboard.press("Meta+,");
    await page.waitForTimeout(600);
  }

  if (await modal.isVisible()) {
    console.log("Capturing Settings Modal (Appearance)...");
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "app_settings_appearance.png") });

    // Click Canvas tab
    const canvasTab = page.locator('.settings-nav button:has-text("Canvas")');
    if (await canvasTab.count() > 0) {
      await canvasTab.click({ force: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "app_settings_canvas.png") });
    }

    // Click AI & voice tab
    const aiTab = page.locator('.settings-nav button:has-text("AI & voice")');
    if (await aiTab.count() > 0) {
      await aiTab.click({ force: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "app_settings_ai.png") });
    }

    // Click Plan & usage tab
    const billingTab = page.locator('.settings-nav button:has-text("Plan & usage")');
    if (await billingTab.count() > 0) {
      await billingTab.click({ force: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(ARTIFACT_DIR, "app_settings_billing.png") });
    }

    // Close settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // 3. Test Meeting View - Notes surface (Screen 08)
  console.log("Navigating to Meeting View (Notes surface)...");
  await page.goto("http://localhost:5173/?view=meeting", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, "app_meeting_notes.png") });

  // 4. Test Meeting View - Video Call surface
  console.log("Switching to Video Call surface...");
  const callBtn = page.locator('button:has-text("Video Call")');
  if (await callBtn.count() > 0) {
    await callBtn.click({ force: true });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "app_meeting_call.png") });
  }

  await browser.close();
  console.log("=== ALL TESTS & SCREENSHOTS COMPLETE ===");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
