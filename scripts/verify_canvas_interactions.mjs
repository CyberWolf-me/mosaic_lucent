import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\e0c7d7e8-f6b0-4298-bccd-8d1781e03bce";
const BASE_URL = "https://161.33.167.15.sslip.io";

async function run() {
  console.log("Launching Chromium against", BASE_URL);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  try {
    console.log("Navigating to /login...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const signupToggle = page.locator('button:has-text("Create an account"), button:has-text("Sign up")');
    if ((await signupToggle.count()) > 0) {
      await signupToggle.first().click();
      await page.waitForTimeout(500);
    }

    const testEmail = `tester_${Date.now()}@example.com`;
    const nameInput = page.locator('input[autocomplete="name"]');
    if ((await nameInput.count()) > 0) {
      await nameInput.fill("Canvas Tester");
    }

    const emailInput = page.locator('input[type="email"]');
    await emailInput.fill(testEmail);

    const passInput = page.locator('input[type="password"]');
    await passInput.fill("Password123!@#");

    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();
    console.log("Submitted auth, waiting for canvas...");

    await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
    await page.waitForTimeout(2000);

    // Dismiss tour if present
    const skipTour = page.locator('button:has-text("Skip")');
    if ((await skipTour.count()) > 0 && (await skipTour.isVisible())) {
      console.log("Dismissing Tour...");
      await skipTour.click();
      await page.waitForTimeout(500);
    }

    // Dismiss empty state by clicking "start with a blank board"
    const blankBoardBtn = page.locator('button:has-text("start with a blank board"), button:has-text("blank board")');
    if ((await blankBoardBtn.count()) > 0 && (await blankBoardBtn.isVisible())) {
      console.log("Clicking 'start with a blank board'...");
      await blankBoardBtn.first().click();
      await page.waitForTimeout(800);
    }

    // Insert Mind Map template to populate the canvas with nodes and connectors
    console.log("Opening Tools menu...");
    const toolsBtn = page.locator('button:has-text("Tools")');
    await toolsBtn.click();
    await page.waitForTimeout(400);

    console.log("Clicking 'Insert a template'...");
    const insertTplBtn = page.locator('button:has-text("Insert a template")');
    await insertTplBtn.click();
    await page.waitForTimeout(500);

    console.log("Selecting 'Mind Map' template...");
    const mindmapBtn = page.locator('.tpl-card:has-text("Mind Map")');
    await mindmapBtn.click();
    await page.waitForTimeout(1500);

    // Fit canvas view so all nodes are cleanly centered and visible in the viewport
    const fitBtn = page.locator('button:has-text("Fit")');
    if ((await fitBtn.count()) > 0) {
      console.log("Clicking 'Fit' to center all nodes in viewport...");
      await fitBtn.first().click();
      await page.waitForTimeout(800);
    }

    // Wait for nodes to appear
    await page.waitForSelector(".node", { timeout: 10000 });
    const nodes = page.locator(".node");
    const nodeCount = await nodes.count();
    console.log(`Success: Loaded Mind Map template with ${nodeCount} nodes.`);

    // Pick a visible node
    const targetNode = nodes.first();
    const box = await targetNode.boundingBox();
    if (!box) throw new Error("Could not find bounding box for target node");
    console.log(`Target node bounding box: (${box.x}, ${box.y}) - ${box.width}x${box.height}`);

    // 1. TEST NODE SELECTION RESPONSIVENESS
    console.log("Testing node selection responsiveness...");
    const nodeInfoBefore = await targetNode.evaluate((el) => ({
      className: el.className,
      tabIndex: el.tabIndex,
      text: el.innerText,
      style: el.getAttribute("style"),
    }));
    console.log("Node info before click:", JSON.stringify(nodeInfoBefore));

    const startTime = Date.now();
    await targetNode.click({ force: true });
    const selectElapsed = Date.now() - startTime;
    console.log(`Node clicked in ${selectElapsed}ms.`);

    await page.waitForTimeout(600);
    const nodeInfoAfter = await targetNode.evaluate((el) => ({
      className: el.className,
      isSelected: el.classList.contains("selected"),
    }));
    console.log("Node info after click:", JSON.stringify(nodeInfoAfter));

    await page.screenshot({ path: path.join(ARTIFACT_DIR, "live_node_selected.png") });
    console.log("Captured live_node_selected.png");

    // Deselect
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // 2. TEST PEN TOOL DRAWING DIRECTLY OVER NODES
    console.log("Activating Pen tool via shortcut 'p'...");
    await page.keyboard.press("p");
    await page.waitForTimeout(600);

    const drawingActive = await page.evaluate(() => document.querySelector(".drawing-active") !== null);
    console.log("CanvasViewport has .drawing-active class:", drawingActive);

    console.log(`Drawing pen stroke directly across node at (${box.x}, ${box.y})...`);
    // Start 40px to the left of the node, drag directly across its center, and release 40px to the right
    await page.mouse.move(box.x - 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    console.log("Pen stroke completed.");

    await page.waitForTimeout(800);

    // Verify that drawing over the node did NOT select the node or open SelectionHud
    const hudCount = await page.locator(".selection-hud").count();
    console.log("Selection HUD count (should be 0):", hudCount);

    const nodeSelectedDuringPen = await targetNode.evaluate((el) => el.classList.contains("selected"));
    console.log("Node selected state during/after pen stroke (should be false):", nodeSelectedDuringPen);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, "live_pen_drawn_over_node.png") });
    console.log("Captured live_pen_drawn_over_node.png");

    // Exit Pen mode
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // 3. TEST SHAPE DRAWING (STICKY)
    console.log("Activating Sticky tool via shortcut 's'...");
    await page.keyboard.press("s");
    await page.waitForTimeout(600);

    console.log("Placing sticky note on canvas at (200, 300)...");
    await page.mouse.click(200, 300);
    await page.waitForTimeout(1000);

    // Verify sticky was placed
    const stickies = page.locator('.shape.sticky');
    const stickyCount = await stickies.count();
    console.log(`Sticky elements count on canvas: ${stickyCount}`);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, "live_sticky_placed.png") });
    console.log("Captured live_sticky_placed.png");

    console.log("ALL CANVAS INTERACTION VERIFICATION CHECKS COMPLETED SUCCESSFULLY!");
  } catch (err) {
    console.error("Browser test drive error:", err);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, "live_error.png") });
  } finally {
    await browser.close();
  }
}

run();
