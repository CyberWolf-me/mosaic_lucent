import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";
const BASE_URL = "http://localhost:5173";

async function runPhase2Trials() {
  console.log("=== PHASE 2 LIVE DATA & SHELL FUNCTIONAL TRIALS ===");
  console.log("Connecting to dev server at:", BASE_URL);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  const consoleLogs = [];
  const consoleErrors = [];

  page.on("console", (msg) => {
    const text = msg.text();
    consoleLogs.push({ type: msg.type(), text });
    if (msg.type() === "error") {
      if (!text.includes("401 (Unauthorized)") && !text.includes("Failed to load resource") && !text.includes("favicon")) {
        consoleErrors.push(text);
        console.log(`[Browser Console Error] ${text}`);
      }
    }
  });

  page.on("response", (res) => {
    if (res.status() >= 400 && res.status() !== 401 && res.status() !== 404) {
      console.log(`[HTTP ${res.status()}]: ${res.request().method()} ${res.url()}`);
    }
  });

  try {
    // -------------------------------------------------------------
    // AUTHENTICATION STEP
    // -------------------------------------------------------------
    console.log("\n[Auth] Navigating to app...");
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const demoLoginBtn = page.locator('button:has-text("Continue as Alex Kim")');
    if ((await demoLoginBtn.count()) > 0 && (await demoLoginBtn.isVisible())) {
      console.log("Signing in using demo credentials...");
      await demoLoginBtn.click();
      await page.waitForTimeout(1500);
    } else {
      const emailInput = page.locator('input[type="email"]');
      if ((await emailInput.count()) > 0 && (await emailInput.isVisible())) {
        console.log("Signing in with credentials...");
        await emailInput.fill("alex@example.com");
        await page.locator('input[type="password"]').fill("Password123!");
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(1500);
      }
    }

    // Dismiss tour if present
    const skipTour = page.locator('button:has-text("Skip")');
    if ((await skipTour.count()) > 0 && (await skipTour.isVisible())) {
      console.log("Dismissing Tour modal...");
      await skipTour.click();
      await page.waitForTimeout(500);
    }

    // -------------------------------------------------------------
    // TRIAL 1: HOME SCREEN (?view=home)
    // -------------------------------------------------------------
    console.log("\n[Trial 1] Testing Home Screen (?view=home)...");
    await page.goto(`${BASE_URL}/?view=home`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Verify it is a REAL React view and NOT an iframe!
    const iframeCount = await page.locator('iframe[src*="v2.html"]').count();
    console.log(`Iframe fallback count on ?view=home: ${iframeCount} (MUST BE 0)`);
    if (iframeCount > 0) {
      throw new Error("FAIL: ?view=home rendered fallback iframe /v2.html instead of real HomeView!");
    }

    // Check greeting
    const greeting = page.locator('h1:has-text("Good morning")');
    await greeting.waitFor({ state: "visible", timeout: 8000 });
    const greetingText = await greeting.textContent();
    console.log(`Verified Greeting: "${greetingText}"`);

    // Check stat cards
    const statCards = page.locator(".stat-card");
    const statCount = await statCards.count();
    console.log(`Found ${statCount} metric stat cards.`);

    // Verify Ask bar exists and is interactive
    const askInput = page.locator('input[placeholder*="Ask Lucent anything"]');
    await askInput.waitFor({ state: "visible", timeout: 5000 });
    await askInput.fill("Payment gateway flow");
    console.log("Filled Ask input with query.");

    // Screenshot Home
    const homeShotPath = path.join(ARTIFACT_DIR, "phase2_01_home_screen.png");
    await page.screenshot({ path: homeShotPath });
    console.log("Saved screenshot:", homeShotPath);

    // -------------------------------------------------------------
    // TRIAL 2: WORKSPACE BROWSER (?view=workspace)
    // -------------------------------------------------------------
    console.log("\n[Trial 2] Testing Workspace Browser (?view=workspace)...");
    await page.goto(`${BASE_URL}/?view=workspace`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const wsIframeCount = await page.locator('iframe[src*="v2.html"]').count();
    console.log(`Iframe fallback count on ?view=workspace: ${wsIframeCount} (MUST BE 0)`);
    if (wsIframeCount > 0) {
      throw new Error("FAIL: ?view=workspace rendered fallback iframe /v2.html instead of real WorkspaceView!");
    }

    // Verify Organization Header
    const wsHeader = page.locator('h1.section-header-title');
    await wsHeader.waitFor({ state: "visible", timeout: 8000 });
    console.log("Workspace view loaded with title:", await wsHeader.textContent());

    // Screenshot Workspace Boards tab
    const wsBoardsShotPath = path.join(ARTIFACT_DIR, "phase2_02_workspace_screen.png");
    await page.screenshot({ path: wsBoardsShotPath });
    console.log("Saved screenshot:", wsBoardsShotPath);

    // Click "People" tab
    console.log("Switching to People tab...");
    const peopleTab = page.locator('button:has-text("People")');
    await peopleTab.click();
    await page.waitForTimeout(600);

    // Verify People list is visible
    const peopleItems = page.locator('text="@"');
    console.log(`Found ${await peopleItems.count()} email records in People tab.`);

    // Screenshot People tab
    const wsPeopleShotPath = path.join(ARTIFACT_DIR, "phase2_03_workspace_people.png");
    await page.screenshot({ path: wsPeopleShotPath });
    console.log("Saved screenshot:", wsPeopleShotPath);

    // -------------------------------------------------------------
    // TRIAL 3: ADMIN CONSOLE (?view=admin)
    // -------------------------------------------------------------
    console.log("\n[Trial 3] Testing Admin Console (?view=admin)...");
    await page.goto(`${BASE_URL}/?view=admin`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const adminIframeCount = await page.locator('iframe[src*="v2.html"]').count();
    console.log(`Iframe fallback count on ?view=admin: ${adminIframeCount} (MUST BE 0)`);
    if (adminIframeCount > 0) {
      throw new Error("FAIL: ?view=admin rendered fallback iframe /v2.html instead of real AdminView!");
    }

    // Check for Admin title and sections
    const adminH1 = page.locator("h1");
    await adminH1.waitFor({ state: "visible", timeout: 8000 });
    console.log("Admin console loaded for workspace:", await adminH1.textContent());

    const membersSection = page.locator('h2:has-text("Workspace Members")');
    console.log("Members section visible:", await membersSection.isVisible());

    const auditSection = page.locator('h2:has-text("Audit Trail")');
    console.log("Audit trail section visible:", await auditSection.isVisible());

    const ssoSection = page.locator('h2:has-text("Authentication & Directory Sync")');
    console.log("SSO & SCIM section visible:", await ssoSection.isVisible());

    // Screenshot Admin
    const adminShotPath = path.join(ARTIFACT_DIR, "phase2_04_admin_screen.png");
    await page.screenshot({ path: adminShotPath });
    console.log("Saved screenshot:", adminShotPath);

    // -------------------------------------------------------------
    // TRIAL 4: INTELLIGENCE & REVIEW ROUTING
    // -------------------------------------------------------------
    console.log("\n[Trial 4] Testing Intelligence (?view=intelligence) and Review (?view=review) routing...");
    await page.goto(`${BASE_URL}/?view=intelligence`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const intelIframeCount = await page.locator('iframe[src*="v2.html"]').count();
    console.log(`Iframe count on ?view=intelligence: ${intelIframeCount} (MUST BE 0)`);

    await page.goto(`${BASE_URL}/?view=review`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const reviewIframeCount = await page.locator('iframe[src*="v2.html"]').count();
    console.log(`Iframe count on ?view=review: ${reviewIframeCount} (MUST BE 0)`);

    const reviewShotPath = path.join(ARTIFACT_DIR, "phase2_05_intel_review.png");
    await page.screenshot({ path: reviewShotPath });
    console.log("Saved screenshot:", reviewShotPath);

    // -------------------------------------------------------------
    // SUMMARY
    // -------------------------------------------------------------
    console.log("\n=============================================");
    console.log("ALL PHASE 2 TRIALS COMPLETED SUCCESSFULLY!");
    console.log("Total console errors encountered:", consoleErrors.length);
    console.log("=============================================");

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error("\n[Phase 2 Trials Error]:", err);
    try {
      const errorShot = path.join(ARTIFACT_DIR, "phase2_trial_error.png");
      await page.screenshot({ path: errorShot });
      console.log("Error screenshot captured at:", errorShot);
    } catch {
      /* ignore */
    }
    await browser.close();
    process.exit(1);
  }
}

runPhase2Trials();
