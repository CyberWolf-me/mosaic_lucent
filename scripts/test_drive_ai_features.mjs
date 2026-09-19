import { chromium } from "playwright";
import path from "node:path";

const ARTIFACT_DIR = "C:\\Users\\User\\.gemini\\antigravity\\brain\\2b2c4ff7-26fe-4f14-a6eb-49607cf95d6f";
const BASE_URL = "https://161.33.167.15.sslip.io";

async function run() {
  console.log("=== Live AI & Visual Workspace Browser Test Drive ===");
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

  // Listen for prompts (used by "Generate image with AI")
  page.on("dialog", async (dialog) => {
    console.log(`[Dialog ${dialog.type()}]:`, dialog.message());
    await dialog.accept("A vibrant minimalist neon diagram icon of a central neural core with connected nodes");
  });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error] ${msg.text()}`);
    }
  });

  try {
    // 1. Visit Auth & Sign up
    console.log("1. Navigating to /login...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const signupToggle = page.locator('button:has-text("Create an account"), button:has-text("Sign up")');
    if ((await signupToggle.count()) > 0) {
      console.log("Switching to Sign Up view...");
      await signupToggle.first().click();
      await page.waitForTimeout(600);
    }

    const testEmail = `ai_pilot_${Date.now()}@example.com`;
    console.log("Signing up as:", testEmail);

    const nameInput = page.locator('input[autocomplete="name"]');
    if ((await nameInput.count()) > 0) {
      await nameInput.fill("Antigravity AI Pilot");
    }

    const emailInput = page.locator('input[type="email"]');
    await emailInput.fill(testEmail);

    const passInput = page.locator('input[type="password"]');
    await passInput.fill("LucentSecure2026!Flash");

    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();

    // 2. Wait for workspace canvas & dismiss onboarding tour
    console.log("2. Waiting for workspace canvas...");
    await page.waitForTimeout(3000);

    const skipTourBtn = page.locator('button:has-text("Skip")');
    if ((await skipTourBtn.count()) > 0) {
      console.log("Dismissing onboarding tour...");
      await skipTourBtn.first().click();
      await page.waitForTimeout(600);
    }

    const blankBoardBtn = page.locator('button:has-text("start with a blank board"), button:has-text("blank board")');
    if ((await blankBoardBtn.count()) > 0) {
      console.log("Clicking 'start with a blank board'...");
      await blankBoardBtn.first().click();
      await page.waitForTimeout(800);
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // 3. Test DeepSeek-v4.1-flash Canvas Diagram Generation
    console.log("3. Testing DeepSeek-v4.1-flash Diagram Generation via AI Pill...");
    const aiInput = page.locator('.ai-pill input, input[placeholder*="describe it"], input[placeholder*="Ask Lucent"]').first();
    await aiInput.waitFor({ state: "visible", timeout: 10000 });
    await aiInput.fill("Build an event-driven architecture with API Gateway, Auth Service, Order Service, and Database");
    await page.waitForTimeout(400);
    console.log("Submitting prompt to AI generation pipeline...");
    await page.keyboard.press("Enter");

    // Wait for the AI generation to construct the nodes on canvas
    console.log("Waiting for DeepSeek to generate diagram...");
    await page.waitForTimeout(10000);

    const diagramShot = path.join(ARTIFACT_DIR, "07_deepseek_generated_diagram.png");
    await page.screenshot({ path: diagramShot, fullPage: true });
    console.log("Captured DeepSeek diagram screenshot:", diagramShot);

    // 4. Test GPT-Image-2.5 Imagine Visual Generation
    console.log("4. Testing GPT-Image-2.5 Imagine Visual Generation via ShapeToolbar...");
    const genImgBtn = page.locator('button[aria-label="Generate image with AI"], button[data-tip*="Generate image"]').first();
    if ((await genImgBtn.count()) > 0) {
      console.log("Clicking 'Generate image with AI' toolbar button...");
      await genImgBtn.click();
      console.log("Waiting for image generation from upstream gateway (gpt-image-2.5)...");
      // Upstream image generation took ~40s on our live curl test
      await page.waitForTimeout(45000);

      const imagineShot = path.join(ARTIFACT_DIR, "08_gpt_image_generated.png");
      await page.screenshot({ path: imagineShot, fullPage: true });
      console.log("Captured GPT-Image screenshot:", imagineShot);
    } else {
      console.warn("Generate image button not found in toolbar!");
    }

    // 5. Test Meeting Stage & Conversational Lease UI
    console.log("5. Testing Meeting Stage & Conversational Lease UI...");
    const presentBtn = page.locator('button:has-text("Present"), button[aria-label="Meeting mode"]').first();
    if ((await presentBtn.count()) > 0) {
      await presentBtn.click();
      console.log("Waiting for Meeting View to render...");
      await page.waitForTimeout(2500);

      const meetingStageShot = path.join(ARTIFACT_DIR, "09_meeting_conversational_stage.png");
      await page.screenshot({ path: meetingStageShot, fullPage: true });
      console.log("Captured meeting stage screenshot:", meetingStageShot);
    }

    console.log("\n=== Live Browser Test Drive Successfully Completed! ===");
  } catch (err) {
    console.error("Test drive error:", err);
    const errShot = path.join(ARTIFACT_DIR, "browser_error_screenshot.png");
    await page.screenshot({ path: errShot, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
}

run();
