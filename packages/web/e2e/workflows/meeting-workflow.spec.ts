import { expect, test } from "@playwright/test";

/**
 * Workflow Scenario: Meeting Mode Lifecycle, Voice Simulation & View Persistence
 *
 * Validates:
 * 1. An authenticated user opens Meeting mode and can toggle capture profiles
 *    (Assistant, Intelligence, Participant).
 * 2. Starting recording captures turns (evaluated with real classification into decisions/actions).
 * 3. Stopping recording saves the meeting to local/board storage and renders the brief & transcript.
 * 4. Navigating away to Canvas, Projects, or Dashboard and returning to Meeting mode
 *    PERSISTS all meeting data without resetting to "No meeting captured on this board yet".
 * 5. The "+ New meeting" action allows starting a new session while past meetings
 *    remain accessible in the past meetings list.
 */
test.describe("Workflow: Meeting Mode Lifecycle & View Persistence", () => {
  test("capture meeting turns, stop, switch views, and verify state persistence", async ({
    page,
  }) => {
    // 1. Sign up a fresh user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("Meeting User");
    await page.locator('input[type="email"]').first().fill(`meet-${Date.now()}@lucent.test`);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();

    // Dismiss any onboarding modals
    for (let i = 0; i < 5; i++) {
      const btn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if ((await btn.count()) === 0) break;
      await btn
        .first()
        .click({ force: true })
        .catch(() => {});
      await page.waitForTimeout(300);
    }

    await page.evaluate(() => {
      localStorage.setItem("lucent.tour.seen.v1", "1");
    });

    // Wait for authenticated canvas to mount
    const promptInput = page.getByLabel("Describe what you want to build");
    await expect(promptInput).toBeVisible({ timeout: 30_000 });

    // 3. Switch to Meeting mode with voicehud enabled
    await page.evaluate(() => {
      const u = new URL(window.location.href);
      u.searchParams.set("view", "meeting");
      u.searchParams.set("voicehud", "1");
      window.history.pushState(null, "", u.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Verify initial Meeting mode view loads
    await expect(page.getByText(/Capture mode/i).first()).toBeVisible({ timeout: 15_000 });

    // 4. Verify mode switching across profiles
    const modeSeg = page.locator(".meet-seg");
    const intelligenceBtn = modeSeg.getByRole("button", { name: "Intelligence" });
    const participantBtn = modeSeg.getByRole("button", { name: "Participant" });
    const assistantBtn = modeSeg.getByRole("button", { name: "Assistant" });

    await expect(assistantBtn).toBeVisible();
    await intelligenceBtn.click();
    await expect(intelligenceBtn).toHaveClass(/on/);

    await participantBtn.click();
    await expect(participantBtn).toHaveClass(/on/);

    await assistantBtn.click();
    await expect(assistantBtn).toHaveClass(/on/);

    // 5. Start recording
    const startBtn = page.getByRole("button", { name: /start recording|new recording/i }).first();
    await expect(startBtn).toBeVisible();

    // Start capture via debug hook (resilient in headless mode without microphone hardware)
    await page.evaluate(() => {
      const dbg = (
        window as unknown as {
          __lucentVoiceDebug?: {
            startCapture: () => void;
            evaluate: (s: string, t: string) => void;
          };
        }
      ).__lucentVoiceDebug;
      if (dbg) {
        dbg.startCapture();
      }
    });

    // Verify REC pill or Stop button is visible
    const stopBtn = page.getByRole("button", { name: /stop/i });
    await expect(stopBtn).toBeVisible({ timeout: 10_000 });

    // 6. Inject simulated speech turns using the real conversational debug hook
    await page.evaluate(() => {
      const dbg = (
        window as unknown as {
          __lucentVoiceDebug?: {
            startCapture: () => void;
            evaluate: (s: string, t: string) => void;
          };
        }
      ).__lucentVoiceDebug;
      if (dbg) {
        dbg.evaluate("Alice", "We decided to migrate our infrastructure to Oracle Cloud.");
        dbg.evaluate("Bob", "I will handle the Nginx reverse proxy configuration by Friday.");
      }
    });

    // Verify turns appear in the transcript panel
    await expect(
      page.getByText("We decided to migrate our infrastructure to Oracle Cloud."),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("I will handle the Nginx reverse proxy configuration by Friday."),
    ).toBeVisible({ timeout: 10_000 });

    // 7. Stop recording
    await stopBtn.click();

    // Verify meeting transitions to saved state
    await expect(page.getByText(/Saved meeting/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /new meeting/i })).toBeVisible();

    // Verify the transcript turns are retained in the saved document
    await expect(
      page.getByText("We decided to migrate our infrastructure to Oracle Cloud."),
    ).toBeVisible();

    // 8. THE CRITICAL VIEW-SWITCH TEST:
    // Navigate away to Canvas view
    const canvasNavBtn = page.locator('.rail-btn[aria-label="Canvas"]:visible');
    await canvasNavBtn.click();
    await expect(page).toHaveURL(/view=canvas/);

    const skipBtn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close)$/i });
    if ((await skipBtn.count()) > 0) {
      await skipBtn
        .first()
        .click()
        .catch(() => {});
    }

    // Navigate to Projects view
    const projectsNavBtn = page.locator('.rail-btn[aria-label="Projects"]:visible');
    await projectsNavBtn.click();
    await expect(page).toHaveURL(/view=projects/);

    // Navigate to Boards dashboard
    const boardsNavBtn = page.locator('.rail-btn[aria-label="Boards"]:visible');
    await boardsNavBtn.click();
    await expect(page).toHaveURL(/view=dashboard/);

    // 9. RETURN TO MEETING MODE
    // The previous bug caused the state to be wiped and showed empty "No meeting captured"
    const meetingsNavBtn = page.locator('.rail-btn[aria-label="Meetings"]:visible');
    await meetingsNavBtn.click();

    // In Meetings list, click the saved meeting row or the "Meet on board" button if present
    const openMeetingTrigger = page
      .locator(".boards-notif-row, button:has-text('Meet on'), button:has-text('Start a meeting')")
      .first();
    if ((await openMeetingTrigger.count()) > 0) {
      await openMeetingTrigger.click().catch(() => {});
    }

    // ASSERTION: Meeting data is still intact!
    await expect(page.getByText(/Saved meeting/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("We decided to migrate our infrastructure to Oracle Cloud."),
    ).toBeVisible();
    await expect(
      page.getByText("I will handle the Nginx reverse proxy configuration by Friday."),
    ).toBeVisible();

    // Verify it does NOT show the empty state message
    await expect(page.getByText("No meeting captured on this board yet")).toHaveCount(0);

    // 10. Start a new meeting using "+ New meeting" button
    const newMeetingBtn = page.getByRole("button", { name: /new meeting/i });
    await newMeetingBtn.click();

    // Verify empty state is now displayed, ready for a new recording
    await expect(
      page.getByRole("button", { name: /start recording|new recording/i }).first(),
    ).toBeVisible();

    // Verify the previous meeting is listed under "Past meetings"
    await expect(page.getByText(/Past meetings/i)).toBeVisible();
    const pastMeetingItem = page.locator(".meet-past").first();
    await expect(pastMeetingItem).toBeVisible();

    // Clicking the past meeting restores it!
    await pastMeetingItem.click();
    await expect(page.getByText(/Saved meeting/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText("We decided to migrate our infrastructure to Oracle Cloud."),
    ).toBeVisible();
  });
});
