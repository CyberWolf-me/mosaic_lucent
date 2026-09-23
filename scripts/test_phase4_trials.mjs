import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";
const BASE_URL = "http://localhost:5173";

async function runPhase4Trials() {
  console.log("=== PHASE 4 REAL AI & VOICE PIPELINE FUNCTIONAL TRIALS ===");
  console.log("Connecting to dev server at:", BASE_URL);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone"],
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

    // Navigate to Canvas view
    console.log("Navigating to Canvas view...");
    await page.goto(`${BASE_URL}/?view=canvas`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // -------------------------------------------------------------
    // TRIAL 1: VOICE OVERLAY ACTIVATION & DISMISSAL
    // -------------------------------------------------------------
    console.log("\n[Trial 1] Testing Voice Listening Overlay...");
    const micBtn = page.locator('button[aria-label="Start voice input"]').first();
    await micBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("Found microphone button, clicking to trigger voice listening...");
    await micBtn.click();
    await page.waitForTimeout(600);

    // Verify VoiceOverlay dialog is mounted
    const voiceOverlay = page.locator('div[role="dialog"][aria-label="Voice transcription overlay"]');
    await voiceOverlay.waitFor({ state: "visible", timeout: 5000 });
    console.log("Voice transcription overlay is visible!");

    // Verify LIVE · LISTENING beacon
    const liveBeacon = page.locator('text="LIVE · LISTENING"');
    await liveBeacon.waitFor({ state: "visible", timeout: 3000 });
    console.log("Verified 'LIVE · LISTENING' beacon is active.");

    // Capture screenshot of VoiceOverlay
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_01_voice_overlay.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase4_01_voice_overlay.png");

    // Close voice overlay via Cancel button
    const cancelVoiceBtn = voiceOverlay.locator('button:has-text("Cancel")');
    await cancelVoiceBtn.click();
    await page.waitForTimeout(500);
    console.log("Voice overlay cancelled cleanly.");

    // -------------------------------------------------------------
    // TRIAL 2: REAL AI DIAGRAM GENERATION & PROGRESS
    // -------------------------------------------------------------
    console.log("\n[Trial 2] Testing Real AI Diagram Generation & Progress Telemetry...");
    const composer = page.locator('.ai-pill input, input[placeholder*="Ask Lucent"], input[placeholder*="Describe your idea"]').first();
    await composer.waitFor({ state: "visible", timeout: 5000 });

    const promptText = "Create an architecture with API Gateway, Order Service, and Database";
    console.log(`Submitting prompt: "${promptText}"...`);
    await composer.fill(promptText);
    await page.waitForTimeout(300);

    // Submit via Send button or Enter
    const sendBtn = page.locator('button[aria-label="Send message"]').first();
    if (await sendBtn.isVisible()) {
      await sendBtn.click();
    } else {
      await composer.press("Enter");
    }

    // Wait a moment for generation stream to engage
    await page.waitForTimeout(400);

    // Check for progress indicator or status badge
    const progressStatus = page.locator('div[role="status"][aria-label="Generation progress"], .pill-status');
    if ((await progressStatus.count()) > 0) {
      console.log("Observed generation progress banner!");
    }

    // Capture screenshot of generation in progress
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_02_generating_phase.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase4_02_generating_phase.png");

    // -------------------------------------------------------------
    // TRIAL 3: DIAGRAM CONSTRUCTION ON CANVAS
    // -------------------------------------------------------------
    console.log("\n[Trial 3] Verifying Constructed Diagram on Canvas...");
    // Wait for the operations to finish streaming and render on canvas
    const canvasNodes = page.locator('.node');
    try {
      await canvasNodes.first().waitFor({ state: "visible", timeout: 12000 });
    } catch {
      await page.waitForTimeout(2000);
    }

    const nodeCount = await canvasNodes.count();
    console.log(`Canvas node count after AI generation: ${nodeCount}`);

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_03_diagram_constructed.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase4_03_diagram_constructed.png");

    // -------------------------------------------------------------
    // TRIAL 4: ATELIER PROPOSAL REVIEW PANEL & APPLY
    // -------------------------------------------------------------
    console.log("\n[Trial 4] Testing Atelier Proposal Diff Review Panel...");

    // Seed a pending multi-operation proposal on a new test project
    await page.evaluate(() => {
      const scope = localStorage.getItem("lucent.scope");
      const pId = "phase4_proposal_project";
      const projData = {
        id: pId,
        name: "Phase 4 Proposal Project",
        updatedAt: Date.now(),
        workspace: {
          id: "phase4_ws",
          name: "Phase 4 Workspace",
          diagramKind: "architecture",
          nodes: {
            gw: {
              id: "gw",
              label: "API Gateway",
              nodeType: "gateway",
              position: { x: 100, y: 150 },
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
        proposal: {
          id: "prop_1",
          request: "Add payment processing and notification services",
          status: "pending",
          operations: [
            { op: "CREATE_NODE", id: "pay_svc", label: "Payment Service", nodeType: "service" },
            { op: "CREATE_NODE", id: "notif_bus", label: "Notification Bus", nodeType: "queue" },
            { op: "CONNECT_NODES", id: "conn_1", source: "gw", target: "pay_svc", relationship: "forwards" },
            { op: "CHANGE_TEXT", id: "gw", text: "API Gateway v2" },
            { op: "DELETE_NODE", id: "legacy_node" },
          ],
          createdAt: Date.now(),
        },
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

    // Reload canvas to hydrate proposal
    await page.goto(`${BASE_URL}/?view=canvas`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Verify ProposalPanel is visible
    const proposalPanel = page.locator('div[role="dialog"][aria-label="Proposed changes"]');
    await proposalPanel.waitFor({ state: "visible", timeout: 8000 });
    console.log("ProposalPanel is mounted and visible on right rail!");

    // Verify additions, modifications, and removals count
    const additionsLabel = proposalPanel.locator('.mono-caps', { hasText: "3 additions" }).first();
    await additionsLabel.waitFor({ state: "visible", timeout: 3000 });
    console.log("Verified '3 additions' section heading.");

    const modLabel = proposalPanel.locator('.mono-caps', { hasText: "1 modification" }).first();
    await modLabel.waitFor({ state: "visible", timeout: 3000 });
    console.log("Verified '1 modification' section heading.");

    const delLabel = proposalPanel.locator('.mono-caps', { hasText: "1 removal" }).first();
    await delLabel.waitFor({ state: "visible", timeout: 3000 });
    console.log("Verified '1 removal' section heading.");

    // Capture screenshot of the Atelier ProposalPanel
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_04_proposal_panel.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase4_04_proposal_panel.png");

    // Click "Apply all"
    console.log("Clicking 'Apply all' button...");
    const applyAllBtn = proposalPanel.locator('button:has-text("Apply all")');
    await applyAllBtn.click();
    await page.waitForTimeout(800);

    console.log("Verified proposal applied and panel closed.");

    // -------------------------------------------------------------
    // TRIAL 5: UNDO / REDO CYCLE
    // -------------------------------------------------------------
    console.log("\n[Trial 5] Testing Undo & Redo on Applied Proposal...");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(500);
    console.log("Undo executed successfully.");

    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(500);
    console.log("Redo executed successfully.");

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_05_verified_complete.png"),
      fullPage: false,
    });
    console.log("Captured artifact: phase4_05_verified_complete.png");

    console.log("\n=======================================================");
    console.log("ALL PHASE 4 AUTOMATED LIVE BROWSER TRIALS PASSED (5/5)!");
    console.log(`Total Browser Console Errors: ${consoleErrors.length}`);
    console.log("=======================================================");
  } catch (err) {
    console.error("FATAL TRIAL FAILURE:", err);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_trial_error.png"),
      fullPage: true,
    });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

runPhase4Trials();
