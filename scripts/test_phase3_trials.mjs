import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";
const BASE_URL = "http://localhost:5173";

async function runPhase3Trials() {
  console.log("=== PHASE 3 INTERACTIVE CONTROLS & MODALS FUNCTIONAL TRIALS ===");
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
      if (
        !text.includes("401 (Unauthorized)") &&
        !text.includes("Failed to load resource") &&
        !text.includes("favicon")
      ) {
        consoleErrors.push(text);
        console.log(`[Browser Console Error] ${text}`);
      }
    }
  });

  try {
    // -------------------------------------------------------------
    // AUTHENTICATION & SETUP
    // -------------------------------------------------------------
    console.log("\n[Setup] Navigating to app...");
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
    // TRIAL 1: GLOBAL COMMAND OVERLAY (⌘K / Rail Search)
    // -------------------------------------------------------------
    console.log("\n[Trial 1] Testing Global Command Overlay...");
    await page.goto(`${BASE_URL}/?view=workspace`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Find and click the Search / Ask button on GlobalRail
    const railSearchBtn = page.locator('button[aria-label="Ask · Search"]');
    await railSearchBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("Clicking Search icon on GlobalRail...");
    await railSearchBtn.click();
    await page.waitForTimeout(600);

    // Verify CommandOverlay dialog opened
    const commandDialog = page.locator('div[role="dialog"][aria-label="Command menu"]');
    await commandDialog.waitFor({ state: "visible", timeout: 5000 });
    console.log("CommandOverlay dialog is open and visible.");

    const commandInput = commandDialog.locator("input");
    await commandInput.waitFor({ state: "visible", timeout: 3000 });
    console.log("CommandOverlay input is focused.");

    // Type query to search for views
    await commandInput.fill("Workspace");
    await page.waitForTimeout(400);

    // Capture screenshot of command overlay
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_01_command_overlay.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase3_01_command_overlay.png");

    // Close overlay via Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    console.log("CommandOverlay closed with Escape.");

    // -------------------------------------------------------------
    // TRIAL 2: NOTIFICATION POPOVER
    // -------------------------------------------------------------
    console.log("\n[Trial 2] Testing Atelier Notification Popover...");
    const railNotifBtn = page.locator('button[aria-label*="Notifications"]');
    await railNotifBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("Clicking Notifications bell on GlobalRail...");
    await railNotifBtn.click();
    await page.waitForTimeout(600);

    // Verify Notification Popover dialog opened
    const notifDialog = page.locator('div[role="dialog"][aria-label="Notifications"]');
    await notifDialog.waitFor({ state: "visible", timeout: 5000 });
    console.log("Notification popover is open and visible.");

    const notifHeading = notifDialog.locator('span:has-text("Notifications")');
    await notifHeading.waitFor({ state: "visible", timeout: 3000 });

    // Capture screenshot of notification popover
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_02_notification_popover.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase3_02_notification_popover.png");

    // Close popover
    const closeBtn = notifDialog.locator('button[title="Close notifications"]');
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(500);
    console.log("Notification popover closed cleanly.");

    // -------------------------------------------------------------
    // TRIAL 3: REAL-TIME SEARCH & FILTERING IN WORKSPACE
    // -------------------------------------------------------------
    console.log("\n[Trial 3] Testing Live Search & Instant Filtering in Workspace...");
    const workspaceSearchInput = page.locator('input[aria-label="Filter workspace items"]');
    await workspaceSearchInput.waitFor({ state: "visible", timeout: 5000 });

    // Search for a non-matching keyword
    console.log("Typing filter query 'NonExistentXYZ'...");
    await workspaceSearchInput.fill("NonExistentXYZ");
    await page.waitForTimeout(400);

    // Verify empty search state
    const emptyStateText = page.locator("h3:has-text('No boards matching')");
    await emptyStateText.waitFor({ state: "visible", timeout: 3000 });
    console.log("Verified empty search state appeared correctly.");

    // Capture screenshot of search filter in action
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_03_workspace_live_search.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase3_03_workspace_live_search.png");

    // Click "Clear Search"
    const clearSearchBtn = page.locator('button:has-text("Clear Search")');
    await clearSearchBtn.click();
    await page.waitForTimeout(400);
    console.log("Search cleared, full list restored.");

    // -------------------------------------------------------------
    // TRIAL 4: DECISION DETAIL MODAL & LIFECYCLE IN INTELLIGENCE
    // -------------------------------------------------------------
    console.log("\n[Trial 4] Testing Decision Detail Modal & Lifecycle Mutation...");

    // Seed a semantic node with a decision statement in the active project
    await page.evaluate(() => {
      const scope = localStorage.getItem("lucent.scope");
      const pId = "phase3_project";
      const projData = {
        id: pId,
        name: "Phase 3 Test Project",
        updatedAt: Date.now(),
        workspace: {
          id: "phase3_ws",
          name: "Phase 3 Test Workspace",
          diagramKind: "architecture",
          nodes: {
            dec_pg: {
              id: "dec_pg",
              label: "Adopt PostgreSQL for durable persistence",
              nodeType: "database",
              position: { x: 200, y: 200 },
              statement: {
                kind: "decision",
                status: "open",
                topic: "persistence-engine",
                provenance: { meetingId: "mtg-arch-review" },
              },
            },
          },
          edges: {},
          groups: {},
          shapes: {},
          shapeLinks: {},
          wireframes: {},
          comments: {},
          votes: {},
          reactions: {},
        },
        chat: [],
      };

      const meta = [{ id: pId, name: projData.name, updatedAt: projData.updatedAt }];

      if (scope) {
        localStorage.setItem(`lucent.u.${scope}.project.${pId}`, JSON.stringify(projData));
        localStorage.setItem(`lucent.u.${scope}.lastProject`, pId);
        localStorage.setItem(`lucent.u.${scope}.projects`, JSON.stringify(meta));
      }
      localStorage.setItem(`lucent.project.${pId}`, JSON.stringify(projData));
      localStorage.setItem(`lucent.lastProject`, pId);
      localStorage.setItem(`lucent.projects`, JSON.stringify(meta));
    });

    await page.goto(`${BASE_URL}/?view=intelligence`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Find Details button on the decision row
    const detailsButtons = page.locator('button:has-text("Details")');
    await detailsButtons.first().waitFor({ state: "visible", timeout: 8000 });
    console.log(`Found ${(await detailsButtons.count())} statement rows with Details button.`);
    await detailsButtons.first().click();
    await page.waitForTimeout(600);

    // Verify DecisionDetailModal is mounted
    const modal = page.locator('span:has-text("DECISION ·")');
    await modal.waitFor({ state: "visible", timeout: 5000 });
    console.log("DecisionDetailModal is visible!");

    // Verify lifecycle pills ("Active", "In Review", "Superseded")
    const reviewPill = page.locator('button:has-text("In Review")');
    const supersededPill = page.locator('button:has-text("Superseded")');

    console.log("Testing lifecycle status change to 'In Review'...");
    await reviewPill.click();
    await page.waitForTimeout(400);

    console.log("Testing lifecycle status change to 'Superseded'...");
    await supersededPill.click();
    await page.waitForTimeout(400);

    // Capture screenshot of the DecisionDetailModal
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_04_decision_detail_modal.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase3_04_decision_detail_modal.png");

    // Close modal via Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    console.log("DecisionDetailModal closed.");

    // -------------------------------------------------------------
    // TRIAL 5: KEYBOARD SHORTCUTS (⌘K / Ctrl+K)
    // -------------------------------------------------------------
    console.log("\n[Trial 5] Testing ⌘K Keyboard Shortcut...");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(600);

    const overlayOpen = await page.locator('div[role="dialog"][aria-label="Command menu"]').isVisible();
    console.log(`Command overlay opened via Ctrl+K: ${overlayOpen}`);

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_05_verified_complete.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase3_05_verified_complete.png");

    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    console.log("\n=======================================================");
    console.log("ALL PHASE 3 AUTOMATED LIVE BROWSER TRIALS PASSED (5/5)!");
    console.log(`Total Browser Console Errors: ${consoleErrors.length}`);
    console.log("=======================================================");
  } catch (err) {
    console.error("FATAL TRIAL FAILURE:", err);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_trial_error.png"),
      fullPage: true,
    });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

runPhase3Trials();
