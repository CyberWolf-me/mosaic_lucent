import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";

async function runParityCheck() {
  console.log("=== REDESIGN PARITY VISUAL TEST ===");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // 1. First ensure user is logged in on 5173
  console.log("Navigating to http://localhost:5173 to check auth...");
  await page.goto("http://localhost:5173/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const demoLoginBtn = page.locator('button:has-text("Continue as Alex Kim")');
  if ((await demoLoginBtn.count()) > 0 && (await demoLoginBtn.isVisible())) {
    console.log("Signing in with demo account...");
    await demoLoginBtn.click();
    await page.waitForTimeout(1500);
  }

  // 2. Take screenshots of 5173 (App)
  const appViews = [
    { name: "app_home", url: "http://localhost:5173/?view=home" },
    { name: "app_board", url: "http://localhost:5173/?view=canvas" },
    { name: "app_meeting", url: "http://localhost:5173/?view=meeting" },
    { name: "app_intelligence", url: "http://localhost:5173/?view=intelligence" },
    { name: "app_execution", url: "http://localhost:5173/?view=execution" },
    { name: "app_history", url: "http://localhost:5173/?view=history" },
    { name: "app_admin", url: "http://localhost:5173/?view=admin" },
  ];

  for (const v of appViews) {
    console.log(`Capturing App view: ${v.name} -> ${v.url}`);
    await page.goto(v.url, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const shotPath = path.join(ARTIFACT_DIR, `${v.name}.png`);
    await page.screenshot({ path: shotPath });
    console.log(`Saved screenshot: ${shotPath}`);
  }

  // 3. Take screenshots of 5174 (Reference Redesign)
  const refScreens = [
    { name: "ref_home", screen: 11 },
    { name: "ref_board", screen: 3 },
    { name: "ref_meeting_board", screen: 13 },
    { name: "ref_meeting_doc", screen: 8 },
    { name: "ref_intelligence", screen: 14 },
    { name: "ref_execution", screen: 18 },
    { name: "ref_history", screen: 7 },
    { name: "ref_admin", screen: 24 },
  ];

  for (const r of refScreens) {
    console.log(`Capturing Redesign reference screen ${r.screen} -> ${r.name}`);
    await page.goto(`http://localhost:5174/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await page.evaluate((s) => {
      if (typeof window.__lucentGo === "function") {
        window.__lucentGo(s);
      }
    }, r.screen);
    await page.waitForTimeout(600);
    const shotPath = path.join(ARTIFACT_DIR, `${r.name}.png`);
    await page.screenshot({ path: shotPath });
    console.log(`Saved screenshot: ${shotPath}`);
  }

  await browser.close();
  console.log("=== PARITY TEST COMPLETE ===");
}

runParityCheck().catch((err) => {
  console.error("Parity check failed:", err);
  process.exit(1);
});
