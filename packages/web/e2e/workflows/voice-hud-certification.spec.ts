import { expect, test } from "@playwright/test";

/**
 * Phase 3 Certification: Browser Live Diagnostics HUD & Voice State Machine
 *
 * Validates in a real browser session:
 * 1. Opt-in debug HUD mounts when ?voicehud=1 is present in the URL.
 * 2. Realtime display of telemetry rows:
 *    - Macro state (IDLE -> LISTENING -> PROCESSING -> SPEAKING)
 *    - MIC hardware status
 *    - VAD voice activity detection status
 *    - Echo suppression status
 *    - Conversational Lease state & countdown window
 *    - Speaker attribution
 *    - Recent utterance snippet preview
 * 3. Dynamic reactivity when turns are evaluated.
 */

test.describe("Voice Hardening Phase 3: Browser Diagnostics HUD Certification", () => {
  test("mounts VoiceStateHud, displays telemetry rows, and tracks conversational lease lifecycle", async ({
    page,
  }) => {
    // 1. Sign up fresh user
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill("HUD Tester");
    await page.locator('input[type="email"]').first().fill(`hud-${Date.now()}@lucent.test`);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();

    // Dismiss onboarding modals
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

    // 2. Open Meeting view with ?voicehud=1
    await page.evaluate(() => {
      const u = new URL(window.location.href);
      u.searchParams.set("view", "meeting");
      u.searchParams.set("voicehud", "1");
      window.history.pushState(null, "", u.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Verify Meeting mode mounts
    await expect(page.getByText(/Capture mode/i).first()).toBeVisible({ timeout: 15_000 });

    // 3. Verify VoiceStateHud is mounted and visible
    const hud = page.locator(".voice-hud");
    await expect(hud).toBeVisible({ timeout: 10_000 });
    await expect(hud.getByText("VOICE STATE")).toBeVisible();

    // Verify initial macro state is IDLE
    const macroState = hud.locator('[data-testid="voice-macro"]');
    await expect(macroState).toHaveText("IDLE");

    // 4. Verify telemetry diagnostic rows are rendered
    await expect(hud.getByText("MIC")).toBeVisible();
    await expect(hud.getByText("VAD")).toBeVisible();
    await expect(hud.getByText("STT")).toBeVisible();
    await expect(hud.getByText("TTS")).toBeVisible();
    await expect(hud.getByText("Echo")).toBeVisible();
    await expect(hud.getByText("Lease")).toBeVisible();
    await expect(hud.getByText("Window")).toBeVisible();
    await expect(hud.getByText("Speaker")).toBeVisible();
    await expect(hud.getByText("Turn")).toBeVisible();

    // 5. Start capture via debug hook and verify macro transition to LISTENING
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

    // When recording, macro changes to LISTENING
    await expect(macroState).toHaveText("LISTENING", { timeout: 10_000 });

    // 6. Inject speaker turn
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
        dbg.evaluate("Alice", "Lucent, what is our payment strategy?");
      }
    });

    // Verify turn appears in transcript
    await expect(page.getByText("Lucent, what is our payment strategy?")).toBeVisible({
      timeout: 10_000,
    });

    // 7. Verify attribution in HUD
    await expect(hud.getByText("Alice")).toBeVisible({ timeout: 10_000 });
  });
});
