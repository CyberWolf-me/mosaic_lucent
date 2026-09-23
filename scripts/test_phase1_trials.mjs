import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";
const BASE_URL = "http://localhost:5173";

async function runPhase1Trials() {
  console.log("=== PHASE 1 LIVE FUNCTIONAL TRIALS ===");
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

  page.on("dialog", async (dialog) => {
    console.log(`[Browser Dialog]: ${dialog.message()}`);
    await dialog.accept("High quality architecture diagram icon");
  });

  page.on("console", (msg) => {
    const text = msg.text();
    consoleLogs.push({ type: msg.type(), text });
    if (msg.type() === "error") {
      // Ignore routine 401s during unauthenticated boot
      if (!text.includes("401 (Unauthorized)")) {
        consoleErrors.push(text);
        console.log(`[Browser Console Error] ${text}`);
      }
    }
  });

  page.on("response", (res) => {
    if (res.status() >= 400 && res.status() !== 401) {
      console.log(`[HTTP ${res.status()}]: ${res.request().method()} ${res.url()}`);
    }
  });

  try {
    // -------------------------------------------------------------
    // AUTHENTICATION STEP
    // -------------------------------------------------------------
    console.log("Navigating to app...");
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const demoLoginBtn = page.locator('button:has-text("Continue as Alex Kim")');
    if ((await demoLoginBtn.count()) > 0 && (await demoLoginBtn.isVisible())) {
      console.log("Clicking 'Continue as Alex Kim (Demo)'...");
      await demoLoginBtn.click();
      await page.waitForTimeout(1500);
    } else {
      const emailInput = page.locator('input[type="email"]');
      if ((await emailInput.count()) > 0 && (await emailInput.isVisible())) {
        console.log("Signing in with test credentials...");
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
    // STEP 1: TEST ATELIER EMPTY STATE (?view=empty)
    // -------------------------------------------------------------
    console.log("\n[Trial 1] Testing Atelier Empty State (?view=empty)...");
    await page.goto(`${BASE_URL}/?view=empty`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Check for empty state elements
    const emptyTitle = page.locator('text="What should we"');
    await emptyTitle.waitFor({ state: "visible", timeout: 8000 });
    console.log("Found 'What should we build?' title!");

    const blankPageSub = page.locator('text="Fig. 01 · Untitled · a blank page"');
    console.log("Found 'Fig. 01 · Untitled · a blank page' subtitle:", await blankPageSub.isVisible());

    const suggestionButtons = page.locator('button:has-text("Design an e-commerce checkout flow"), button:has-text("Architect a real-time chat app")');
    const suggCount = await suggestionButtons.count();
    console.log(`Found ${suggCount} suggestion prompt buttons.`);

    const blankBoardBtn = page.locator('button:has-text("+ Start with a blank board")');
    const hasBlankBtn = await blankBoardBtn.isVisible();
    console.log("'+ Start with a blank board' button visible:", hasBlankBtn);

    const emptyStateShot = path.join(ARTIFACT_DIR, "phase1_01_empty_state.png");
    await page.screenshot({ path: emptyStateShot });
    console.log("Saved screenshot:", emptyStateShot);

    // -------------------------------------------------------------
    // STEP 2: TRANSITION TO BLANK BOARD & VERIFY ATELIER TOOLBAR
    // -------------------------------------------------------------
    console.log("\n[Trial 2] Transitioning to Blank Board & Verifying Atelier Toolbar...");
    await blankBoardBtn.click();
    await page.waitForTimeout(1000);

    // Check Atelier Board Toolbar is present
    const toolbar = page.locator('[role="toolbar"]');
    await toolbar.waitFor({ state: "visible", timeout: 8000 });
    console.log("AtelierBoardToolbar is visible on canvas!");

    // Check all 15 tool buttons and clusters
    const toolTips = [
      "Select · V",
      "Hand / Pan · H",
      "Rectangle · R",
      "Ellipse · O",
      "Diamond · D",
      "Arrow / Connect · A",
      "Sticky note · S",
      "Text · T",
      "Pen drawing · P",
      "Generate image with AI",
      "Frame · F",
      "Embed media / link",
      "Comment · C",
      "Undo · ⌘Z",
      "Redo · ⇧⌘Z",
    ];

    let foundTools = 0;
    for (const tip of toolTips) {
      const btn = toolbar.locator(`button[title="${tip}"]`);
      const count = await btn.count();
      if (count > 0) {
        foundTools++;
      } else {
        console.warn(`Warning: Tool button "${tip}" not found in toolbar.`);
      }
    }
    console.log(`Verified ${foundTools} of ${toolTips.length} toolbar buttons with exact tooltips.`);

    // Check GlobalRail with board active
    const activeRailBoard = page.locator('.rail-btn[title="Board"].active');
    console.log("GlobalRail has 'Board' active:", (await activeRailBoard.count()) > 0);

    // Check TopBar brand and current title
    const brandText = page.locator('.top-bar span.serif:has-text("Lucent")');
    console.log("TopBar brand 'Lucent' present:", (await brandText.count()) > 0);

    const blankBoardShot = path.join(ARTIFACT_DIR, "phase1_02_blank_board_toolbar.png");
    await page.screenshot({ path: blankBoardShot });
    console.log("Saved screenshot:", blankBoardShot);

    // -------------------------------------------------------------
    // STEP 3: DRAW RECTANGLE ON CANVAS
    // -------------------------------------------------------------
    console.log("\n[Trial 3] Drawing Rectangle shape on Canvas...");
    const rectToolBtn = toolbar.locator('button[title="Rectangle · R"]');
    await rectToolBtn.click();
    await page.waitForTimeout(400);

    const canvasViewport = page.locator(".canvas-viewport");
    await canvasViewport.waitFor({ state: "visible" });
    const viewBBox = await canvasViewport.boundingBox();

    const startX = viewBBox.x + 350;
    const startY = viewBBox.y + 220;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 200, startY + 120, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(600);

    const shapeCount = await page.locator(".shape").count();
    console.log(`Shapes on canvas after drawing rectangle: ${shapeCount}`);

    const rectShot = path.join(ARTIFACT_DIR, "phase1_03_rect_drawn.png");
    await page.screenshot({ path: rectShot });
    console.log("Saved screenshot:", rectShot);

    // -------------------------------------------------------------
    // STEP 4: PLACE STICKY NOTE ON CANVAS
    // -------------------------------------------------------------
    console.log("\n[Trial 4] Placing Sticky Note on Canvas...");
    const stickyToolBtn = toolbar.locator('button[title="Sticky note · S"]');
    await stickyToolBtn.click();
    await page.waitForTimeout(400);

    await page.mouse.click(startX + 280, startY + 40);
    await page.waitForTimeout(600);

    const stickyCount = await page.locator(".shape.sticky").count();
    console.log(`Sticky notes on canvas: ${stickyCount}`);

    const stickyShot = path.join(ARTIFACT_DIR, "phase1_04_sticky_placed.png");
    await page.screenshot({ path: stickyShot });
    console.log("Saved screenshot:", stickyShot);

    // Deselect sticky note
    await page.mouse.click(150, 150);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);

    // -------------------------------------------------------------
    // STEP 5: POPULATE SEMANTIC GRAPH VIA TEMPLATE
    // -------------------------------------------------------------
    console.log("\n[Trial 5] Populating Semantic Graph with Flowchart / Mind Map Template...");
    const toolsMenuBtn = page.locator('button:has-text("Tools")');
    if (await toolsMenuBtn.count() > 0) {
      await toolsMenuBtn.click();
      await page.waitForTimeout(400);
      const insertTplBtn = page.locator('button:has-text("Insert a template")');
      if (await insertTplBtn.count() > 0) {
        await insertTplBtn.click();
        await page.waitForTimeout(500);
        const tplOption = page.locator('.tpl-card:has-text("Mind Map"), button:has-text("Mind Map")').first();
        if (await tplOption.count() > 0) {
          await tplOption.click();
          await page.waitForTimeout(1500);
        }
      }
    }

    // Fit view
    const fitBtn = page.locator('button:has-text("Fit")');
    if ((await fitBtn.count()) > 0) {
      await fitBtn.first().click();
      await page.waitForTimeout(600);
    }

    // Wait for nodes to be present
    await page.waitForSelector(".node", { timeout: 10000 });
    let nodes = page.locator(".node");
    let nodeCount = await nodes.count();
    console.log(`Nodes count on canvas after template insert: ${nodeCount}`);

    // -------------------------------------------------------------
    // STEP 6: SELECT NODE & VERIFY ATELIER NODE INSPECTOR
    // -------------------------------------------------------------
    console.log("\n[Trial 6] Selecting Node & Verifying AtelierNodeInspector...");
    if (nodeCount > 0) {
      const firstNode = nodes.first();
      await firstNode.click({ force: true });
      await page.waitForTimeout(800);

      const inspector = page.locator('.right-panel[aria-label="Node Inspector"]');
      const inspectorVisible = await inspector.isVisible();
      console.log("AtelierNodeInspector visible:", inspectorVisible);

      if (inspectorVisible) {
        const inspectorTitle = await inspector.locator(".panel-title").innerText();
        console.log(`Selected Node Title in Inspector: "${inspectorTitle}"`);

        // Check "Connected With" chips
        const connectedWithSection = inspector.locator('text="Connected With"');
        console.log("Connected With section present:", (await connectedWithSection.count()) > 0);

        const connectedChips = inspector.locator('.panel-body button[title^="Select "]');
        const chipCount = await connectedChips.count();
        console.log(`Connected dependency chips count: ${chipCount}`);

        // Check Explain node button
        const explainBtn = inspector.locator('button:has-text("Explain node")');
        console.log("Explain node button present:", (await explainBtn.count()) > 0);

        // Check Delete button
        const deleteBtn = inspector.locator('button:has-text("Delete")');
        console.log("Delete button present:", (await deleteBtn.count()) > 0);

        // -------------------------------------------------------------
        // STEP 7: TEST NODE RENAMING IN INSPECTOR
        // -------------------------------------------------------------
        console.log("\n[Trial 7] Testing Node Renaming in Inspector...");
        const renameBtn = inspector.locator('button[title="Rename node"]');
        await renameBtn.click();
        await page.waitForTimeout(300);

        const renameInput = inspector.locator('input[type="text"]');
        await renameInput.fill("Refactored Core Gateway");
        await renameInput.press("Enter");
        await page.waitForTimeout(600);

        const updatedTitle = await inspector.locator(".panel-title").innerText();
        console.log(`Updated Node Title after edit: "${updatedTitle}"`);

        const inspectorShot = path.join(ARTIFACT_DIR, "phase1_05_node_inspector.png");
        await page.screenshot({ path: inspectorShot });
        console.log("Saved screenshot:", inspectorShot);

        // -------------------------------------------------------------
        // STEP 8: TEST UNDO AND REDO TOOLBAR ACTIONS
        // -------------------------------------------------------------
        console.log("\n[Trial 8] Testing Undo & Redo Toolbar Actions...");
        const undoBtn = toolbar.locator('button[title="Undo · ⌘Z"]');
        await undoBtn.click();
        await page.waitForTimeout(600);

        const titleAfterUndo = await inspector.locator(".panel-title").innerText();
        console.log(`Title after Undo: "${titleAfterUndo}"`);

        const redoBtn = toolbar.locator('button[title="Redo · ⇧⌘Z"]');
        await redoBtn.click();
        await page.waitForTimeout(600);

        const titleAfterRedo = await inspector.locator(".panel-title").innerText();
        console.log(`Title after Redo: "${titleAfterRedo}"`);

        const undoRedoShot = path.join(ARTIFACT_DIR, "phase1_06_undo_redo_verified.png");
        await page.screenshot({ path: undoRedoShot });
        console.log("Saved screenshot:", undoRedoShot);

        // -------------------------------------------------------------
        // STEP 9: TEST CONNECTED CHIP NAVIGATION
        // -------------------------------------------------------------
        if (chipCount > 0) {
          console.log("\n[Trial 9] Testing Connected Chip Navigation...");
          const firstChip = connectedChips.first();
          const targetTitle = await firstChip.innerText();
          console.log(`Clicking connected chip for: "${targetTitle.trim()}"`);
          await firstChip.click();
          await page.waitForTimeout(600);

          const newInspectorTitle = await inspector.locator(".panel-title").innerText();
          console.log(`Active Node in Inspector after chip click: "${newInspectorTitle}"`);
        }
      }
    }

    console.log("\n=== CONSOLE ERROR AUDIT ===");
    console.log(`Total Console Messages: ${consoleLogs.length}`);
    console.log(`Total Console Errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      console.log("Console Errors found:");
      consoleErrors.forEach((err, idx) => console.log(`  ${idx + 1}. ${err}`));
    } else {
      console.log("Clean console: 0 unhandled application errors!");
    }

    console.log("\n=== ALL PHASE 1 LIVE TRIALS FINISHED SUCCESSFULLY! ===");
  } catch (err) {
    console.error("Phase 1 Trial Failed with Error:", err);
    const errShot = path.join(ARTIFACT_DIR, "phase1_trial_error.png");
    await page.screenshot({ path: errShot });
    console.log("Saved failure screenshot to:", errShot);
    throw err;
  } finally {
    await browser.close();
  }
}

runPhase1Trials().catch((err) => {
  console.error(err);
  process.exit(1);
});
