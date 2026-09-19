import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR =
  "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";
const BASE_URL = "https://161.33.167.15.sslip.io";

async function run() {
  console.log("Starting Comprehensive Browser Test Drive against", BASE_URL);
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
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone", "camera"],
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  try {
    // 1. Visit Auth Screen
    console.log("1. Navigating to /login...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const authShot = path.join(ARTIFACT_DIR, "01_auth_screen.png");
    await page.screenshot({ path: authShot, fullPage: true });
    console.log("Captured:", authShot);

    // Switch to Sign Up
    const signupToggle = page.locator(
      'button:has-text("Create an account"), button:has-text("Sign up")',
    );
    if ((await signupToggle.count()) > 0) {
      console.log("Switching to Sign Up view...");
      await signupToggle.first().click();
      await page.waitForTimeout(1000);
    }

    const testEmail = `pilot_${Date.now()}@example.com`;
    console.log("Signing up as:", testEmail);

    const nameInput = page.locator('input[autocomplete="name"]');
    if ((await nameInput.count()) > 0) {
      await nameInput.fill("Antigravity Pilot");
    }

    const emailInput = page.locator('input[type="email"]');
    await emailInput.fill(testEmail);

    const passInput = page.locator('input[type="password"]');
    await passInput.fill("TokyoSuperCluster2026!");

    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();

    // 2. Wait for workspace canvas & dismiss onboarding tour / empty state
    console.log("2. Waiting for workspace canvas...");
    await page.waitForTimeout(3000);

    // Dismiss tour if present
    const skipTourBtn = page.locator('button:has-text("Skip")');
    if ((await skipTourBtn.count()) > 0) {
      console.log("Dismissing onboarding tour...");
      await skipTourBtn.first().click();
      await page.waitForTimeout(800);
    }

    // Dismiss empty state hero prompt if present
    const blankBoardBtn = page.locator(
      'button:has-text("start with a blank board"), button:has-text("blank board")',
    );
    if ((await blankBoardBtn.count()) > 0) {
      console.log("Clicking 'start with a blank board'...");
      await blankBoardBtn.first().click();
      await page.waitForTimeout(1000);
    }

    const canvasShot = path.join(ARTIFACT_DIR, "02_canvas_view.png");
    await page.screenshot({ path: canvasShot, fullPage: true });
    console.log("Captured:", canvasShot);

    // Deselect any active selection
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    // 3. Test Sticky Note Placement
    console.log("3. Testing Sticky Note Placement...");
    const stickyBtn = page.locator('button[data-tip*="Sticky"], button[aria-label*="Sticky"]');
    if ((await stickyBtn.count()) > 0) {
      console.log("Clicking Sticky note tool in shape dock...");
      await stickyBtn.first().click();
    } else {
      console.log("Pressing 's' shortcut for Sticky note tool...");
      await page.keyboard.press("s");
    }
    await page.waitForTimeout(600);

    console.log("Dropping sticky note onto canvas at (550, 380)...");
    await page.mouse.click(550, 380);
    await page.waitForTimeout(600);

    // Type text into the sticky note
    await page.keyboard.type(
      "Lucent Production Hardened\n✓ PM2 4-Worker Cluster\n✓ 65,535 Socket Descriptors\n✓ Conversational Lease Active",
    );
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    const shapeShot = path.join(ARTIFACT_DIR, "04_shape_placed.png");
    await page.screenshot({ path: shapeShot, fullPage: true });
    console.log("Captured:", shapeShot);

    // 4. Test Continuous Pen Drawing Tool
    console.log("4. Testing Continuous Pen Drawing...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const penButton = page.locator('button[data-tip*="Pen"], button[aria-label*="Pen"]');
    if ((await penButton.count()) > 0) {
      console.log("Clicking Pen tool button in bottom shape dock...");
      await penButton.first().click();
    } else {
      console.log("Pressing 'p' shortcut for Pen tool...");
      await page.keyboard.press("p");
    }
    await page.waitForTimeout(800);

    // Draw an annotation curve across the canvas
    console.log("Drawing stroke on canvas...");
    await page.mouse.move(400, 200);
    await page.mouse.down();
    await page.mouse.move(550, 250, { steps: 5 });
    await page.mouse.move(700, 200, { steps: 5 });
    await page.mouse.move(800, 280, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(800);

    const penShot = path.join(ARTIFACT_DIR, "03_pen_drawing.png");
    await page.screenshot({ path: penShot, fullPage: true });
    console.log("Captured:", penShot);

    // Exit Pen mode
    console.log("Exiting pen drawing mode...");
    const doneBtn = page.locator('button:has-text("Done")');
    if ((await doneBtn.count()) > 0) {
      await doneBtn.first().click({ force: true });
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    // 5. Test Meeting Room Lobby & Join Call
    console.log("5. Navigating to Meeting View...");
    const meetingBtn = page.locator('button[aria-label="Meeting"], button[title="Meeting"]');
    if ((await meetingBtn.count()) > 0) {
      await meetingBtn.first().click();
      console.log("Waiting for Meeting lobby to mount...");
      await page.waitForTimeout(2500);

      const meetingShot = path.join(ARTIFACT_DIR, "05_meeting_stage.png");
      await page.screenshot({ path: meetingShot, fullPage: true });
      console.log("Captured lobby:", meetingShot);

      // Join the live video meeting room
      const joinBtn = page.locator('button:has-text("Join Meeting Now")');
      if ((await joinBtn.count()) > 0) {
        console.log("Clicking 'Join Meeting Now'...");
        await joinBtn.first().click();
        console.log("Waiting for LiveKit connection to become active...");
        await page.waitForTimeout(5000);

        const liveCallShot = path.join(ARTIFACT_DIR, "05b_live_call_stage.png");
        await page.screenshot({ path: liveCallShot, fullPage: true });
        console.log("Captured live call stage:", liveCallShot);
      }

      // 6. Test Persistent Canvas Huddle Dock (Navigate back to Canvas)
      console.log("6. Switching back to Canvas to verify Persistent Huddle Dock...");
      const canvasBtn = page.locator('button[aria-label="Canvas"], button[title="Canvas"]');
      if ((await canvasBtn.count()) > 0) {
        await canvasBtn.first().click();
        console.log("Waiting for Canvas view to render with floating Huddle Dock...");
        await page.waitForTimeout(3000);

        const huddleShot = path.join(ARTIFACT_DIR, "06_canvas_huddle_dock.png");
        await page.screenshot({ path: huddleShot, fullPage: true });
        console.log("Captured persistent huddle dock:", huddleShot);
      }
    }

    console.log("All test drive steps finished successfully!");
  } catch (err) {
    console.error("Test drive error:", err);
    const errShot = path.join(ARTIFACT_DIR, "error_screenshot.png");
    await page.screenshot({ path: errShot, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
}

run();
