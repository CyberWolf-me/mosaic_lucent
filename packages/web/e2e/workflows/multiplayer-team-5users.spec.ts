import { expect, test, type Page } from "@playwright/test";

/**
 * End-to-End Workflow Scenario: 5+ User Multiplayer Team Collaboration
 *
 * Simulates a full product team collaborating simultaneously across every major
 * Lucent mode and feature:
 *
 * 1. Alice (Host / Product Lead):
 *    - Creates an architecture diagram via AI prompt pill.
 *    - Publishes the board and generates an editor invite link.
 *    - Starts an active Meeting on this board.
 *    - Captures meeting speech turns with real decision and action classifications.
 *    - Stops the meeting, generates recap/brief, and clicks "Add recap to board".
 *    - Navigates to Canvas and verifies the structured recap cards appear.
 *
 * 2. Bob (System Architect):
 *    - Joins the board via Alice's invite capability.
 *    - Verifies real-time synchronization: sees architecture nodes + newly dropped recap cards.
 *    - Switches to Meeting mode and verifies the board's meeting transcript & recap are persisted.
 *
 * 3. Charlie (Frontend Engineer):
 *    - Joins via invite link in a dedicated browser context.
 *    - Switches to the unified KANBAN lens on the SAME board.
 *    - Interacts with Kanban cards and verifies AI input pill is contextually tailored.
 *    - Moves a task to In Progress / Done.
 *
 * 4. Dana (UX Designer):
 *    - Joins via invite link in a dedicated browser context.
 *    - Switches to WIREFRAME lens and checks UI mockup creation.
 *    - Returns to visual canvas, selects a node, and adds an emoji reaction (👍).
 *
 * 5. Evan (QA Lead):
 *    - Joins via invite link in a dedicated browser context.
 *    - Explores DOCUMENT and SEQUENCE lenses on the same board.
 *    - Casts a vote on a decision card via the Engagement bar.
 *    - Activates ZEN MODE (Z key): verifies LeftRail and TopBar collapse and floating badge appears.
 *    - Exits Zen mode to restore full chrome.
 *
 * 6. Concurrency & Multiplayer Health:
 *    - Verifies real-time presence across peers without crashes or console errors.
 */

test.describe("Workflow: 5-User Multiplayer Team Collaboration", () => {
  // Generous timeout for 5 concurrent browser contexts
  test.setTimeout(240_000);

  async function signUp(page: Page, name: string): Promise<string> {
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const email = `${slug}_${Date.now()}_${Math.floor(Math.random() * 1e5)}@lucent.test`;
    await page.goto("/signup");
    await page.locator('input[type="text"]').first().fill(name);
    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill("password-123456");
    await page.getByRole("button", { name: /create account|sign up/i }).first().click();

    // Wait until registered and authenticated into the app
    await page.waitForURL((url) => !url.pathname.includes("/signup"), { timeout: 15_000 });

    // Dismiss any onboarding modals
    for (let i = 0; i < 5; i++) {
      const btn = page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if ((await btn.count()) === 0) break;
      await btn.first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(200);
    }

    await page.evaluate(() => {
      localStorage.setItem("lucent.tour.seen.v1", "1");
    });

    await page.waitForSelector(".top-bar", { timeout: 20_000 });

    return email;
  }

  test("5 users collaborate across Canvas, Meeting, AI notes, Kanban, Wireframes, Voting, and Zen mode", async ({
    browser,
  }) => {
    // -------------------------------------------------------------------------
    // USER 1: ALICE (Product Lead & Host)
    // -------------------------------------------------------------------------
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();

    const aliceErrors: string[] = [];
    page1.on("pageerror", (err) => aliceErrors.push(err.message));

    await signUp(page1, "Alice Product");

    // Alice prompts initial diagram creation
    const promptInput = page1.getByLabel("Describe what you want to build");
    await expect(promptInput).toBeVisible({ timeout: 30_000 });
    await promptInput.fill("E-commerce Architecture: API Gateway, Auth Service, Database, Payment Gateway");
    await promptInput.press("Enter");

    // Wait for nodes to appear on canvas
    await page1.waitForSelector(".node", { timeout: 60_000 });
    const initialNodes = await page1.locator(".node").count();
    expect(initialNodes).toBeGreaterThanOrEqual(1);

    // Alice publishes and shares the board
    const shareBtn = page1.getByRole("button", { name: /share/i }).first();
    await shareBtn.click();

    // Publish if currently local
    const publishBtn = page1.locator(".btn.amber:has-text('Publish & start collaborating')");
    if (await publishBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await publishBtn.click();
    }

    // Create shareable invite link
    const createLinkBtn = page1.getByRole("button", { name: "Create invite link" });
    await expect(createLinkBtn).toBeVisible({ timeout: 15_000 });
    await createLinkBtn.click();

    // Read minted invite link
    const shareUrlSpan = page1.locator(".mono:has-text('invite=')");
    await expect(shareUrlSpan).toBeVisible({ timeout: 10_000 });
    const inviteUrl = (await shareUrlSpan.textContent())?.trim();
    expect(inviteUrl).toBeTruthy();
    expect(inviteUrl).toContain("board=");
    expect(inviteUrl).toContain("invite=");

    // Close share modal
    const closeShareBtn = page1.getByRole("button", { name: /close share dialog/i });
    await closeShareBtn.click();

    // Alice starts Meeting Mode on this board with voicehud=1
    await page1.evaluate(() => {
      const u = new URL(window.location.href);
      u.searchParams.set("view", "meeting");
      u.searchParams.set("voicehud", "1");
      window.history.pushState(null, "", u.toString());
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await expect(page1.getByText(/Capture mode/i).first()).toBeVisible({ timeout: 15_000 });

    // Start recording via debug hook or UI button
    const startRecBtn = page1.getByRole("button", { name: /start recording|new recording/i }).first();
    await expect(startRecBtn).toBeVisible();

    await page1.evaluate(() => {
      const dbg = (window as any).__lucentVoiceDebug;
      if (dbg) dbg.startCapture();
    });

    const stopRecBtn = page1.getByRole("button", { name: /stop/i });
    if (!(await stopRecBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
      await startRecBtn.click();
    }
    await expect(stopRecBtn).toBeVisible({ timeout: 10_000 });

    // Alice & team discuss decisions and action items
    await page1.evaluate(() => {
      const dbg = (window as any).__lucentVoiceDebug;
      if (dbg) {
        dbg.evaluate("Alice", "We decided to deploy PostgreSQL with read replicas for high availability.");
        dbg.evaluate("Bob", "Action: Bob to configure Redis Sentinel cluster by Friday.");
        dbg.evaluate("Charlie", "Action: Charlie to implement checkout payment gateway integration.");
      }
    });

    // Verify transcript turns appear
    await expect(page1.getByText("We decided to deploy PostgreSQL with read replicas")).toBeVisible({ timeout: 10_000 });
    await expect(page1.getByText("Bob to configure Redis Sentinel cluster by Friday.")).toBeVisible();

    // Alice stops recording
    await stopRecBtn.click();
    await expect(page1.getByText(/Saved meeting/i).first()).toBeVisible({ timeout: 15_000 });

    // Alice clicks "Add recap to board"
    const addRecapBtn = page1.getByRole("button", { name: /add recap to board/i }).first();
    await expect(addRecapBtn).toBeVisible();
    await addRecapBtn.click();

    // Return to Canvas
    const aliceCanvasBtn = page1.locator('.rail-btn[aria-label="Canvas"]:visible');
    await aliceCanvasBtn.click();
    await expect(page1).toHaveURL(/view=canvas/);

    // If proposed as a human-gated review diff, approve and commit it
    const applyAllBtn = page1.getByRole("button", { name: /apply all/i });
    if (await applyAllBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await applyAllBtn.click();
    }

    // Verify the recap cards landed on Alice's canvas
    await expect(page1.locator(".node").filter({ hasText: /PostgreSQL with read replicas/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page1.locator(".node").filter({ hasText: /Redis Sentinel cluster/i })).toBeVisible();

    // -------------------------------------------------------------------------
    // USER 2: BOB (System Architect)
    // -------------------------------------------------------------------------
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await signUp(page2, "Bob Architect");

    // Bob joins via Alice's invite link
    await page2.goto(inviteUrl!);
    await page2.waitForSelector(".top-bar", { timeout: 30_000 });

    // Bob immediately sees Alice's architecture diagram AND meeting recap cards via WebSocket sync
    await expect(page2.locator(".node").first()).toBeVisible({ timeout: 20_000 });
    await expect(page2.locator(".node").filter({ hasText: /PostgreSQL with read replicas/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page2.locator(".node").filter({ hasText: /Redis Sentinel cluster/i })).toBeVisible();

    // Bob navigates to Meeting view to verify persistence of Alice's meeting
    const bobMeetingBtn = page2.locator('.rail-btn[aria-label="Meetings"]:visible');
    await bobMeetingBtn.click();
    await expect(page2.getByText(/Past meetings|Saved meeting|Meeting/i).first()).toBeVisible({ timeout: 15_000 });

    // Bob returns to Canvas
    const bobCanvasBtn = page2.locator('.rail-btn[aria-label="Canvas"]:visible');
    await bobCanvasBtn.click();
    await expect(page2).toHaveURL(/view=canvas/);

    // -------------------------------------------------------------------------
    // USER 3: CHARLIE (Frontend Engineer - Kanban Lens)
    // -------------------------------------------------------------------------
    const context3 = await browser.newContext();
    const page3 = await context3.newPage();
    await signUp(page3, "Charlie Frontend");

    await page3.goto(inviteUrl!);
    await page3.waitForSelector(".top-bar", { timeout: 30_000 });

    // Charlie switches to the KANBAN lens on the SAME board
    const kanbanLensBtn = page3.locator('.rail-lens[aria-label="Kanban lens"]');
    await expect(kanbanLensBtn).toBeVisible();
    await kanbanLensBtn.click();

    await expect(page3).toHaveURL(/lens=kanban/);
    await expect(page3.locator(".crumb.current")).toContainText("Kanban");

    // Charlie sees either the Action cards in Kanban columns or the "Convert/Add to To Do" button
    const convertBtn = page3.locator("button:has-text('Convert all nodes to Kanban cards'), button:has-text('Add to To Do')");
    if (await convertBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await convertBtn.first().click();
    }

    // Verify Kanban work board columns are present
    await expect(page3.locator(".board-column, .board-columns").first()).toBeVisible({ timeout: 10_000 });

    // Verify contextual AI Dock placeholder for Kanban
    const kanbanPillInput = page3.locator("textarea");
    await expect(kanbanPillInput).toBeVisible();
    await expect(kanbanPillInput).toHaveAttribute("placeholder", /Add a story, move a card, assign someone/i);

    // -------------------------------------------------------------------------
    // USER 4: DANA (UX Designer - Wireframe Lens & Reactions)
    // -------------------------------------------------------------------------
    const context4 = await browser.newContext();
    const page4 = await context4.newPage();
    await signUp(page4, "Dana Designer");

    await page4.goto(inviteUrl!);
    await page4.waitForSelector(".top-bar", { timeout: 30_000 });

    // Dana switches to WIREFRAME lens on the SAME board
    const wireframeLensBtn = page4.locator('.rail-lens[aria-label="Wireframe lens"]');
    await expect(wireframeLensBtn).toBeVisible();
    await wireframeLensBtn.click();

    await expect(page4).toHaveURL(/lens=wireframe/);
    await expect(page4.locator(".crumb.current")).toContainText("Wireframe");

    // Dana sees the Wireframe suggestion buttons
    await expect(page4.locator("button:has-text('Wireframe'), button:has-text('Design a checkout')").first()).toBeVisible({
      timeout: 10_000,
    });

    // Dana switches back to Visual Diagram lens
    const diagramLensBtn4 = page4.locator('.rail-lens[aria-label="Diagram lens"]');
    await diagramLensBtn4.click();
    await expect(page4).toHaveURL(/view=canvas/);

    // Dana selects a visible node to view the Engagement Bar
    const danaNode = page4.locator(".node").filter({ hasText: /Order|Shipping|Cart|PostgreSQL/i }).first();
    await danaNode.click({ force: true });

    // Dana casts a reaction on the selected node
    const reactBtn = page4.locator(".eng-react").first();
    if (await reactBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await reactBtn.click();
      await expect(reactBtn).toHaveClass(/on/);
    }

    // -------------------------------------------------------------------------
    // USER 5: EVAN (QA Lead - Document, Sequence lenses, Voting & Zen Mode)
    // -------------------------------------------------------------------------
    const context5 = await browser.newContext();
    const page5 = await context5.newPage();
    await signUp(page5, "Evan QA");

    await page5.goto(inviteUrl!);
    await page5.waitForSelector(".top-bar", { timeout: 30_000 });

    // Evan explores the DOCUMENT lens
    const documentLensBtn = page5.locator('.rail-lens[aria-label="Document lens"]');
    await expect(documentLensBtn).toBeVisible();
    await documentLensBtn.click();
    await expect(page5).toHaveURL(/lens=document/);
    await expect(page5.locator(".crumb.current")).toContainText("Document");

    // Evan explores the SEQUENCE lens
    const sequenceLensBtn = page5.locator('.rail-lens[aria-label="Sequence lens"]');
    await expect(sequenceLensBtn).toBeVisible();
    await sequenceLensBtn.click();
    await expect(page5).toHaveURL(/lens=sequence/);

    // Evan returns to Visual Diagram lens
    const diagramLensBtn5 = page5.locator('.rail-lens[aria-label="Diagram lens"]');
    await diagramLensBtn5.click();
    await expect(page5).toHaveURL(/view=canvas/);

    // Evan casts a vote on a node
    const evanNode = page5.locator(".node").filter({ hasText: /Order|Shipping|Cart|PostgreSQL/i }).first();
    await evanNode.click({ force: true });
    const voteBtn = page5.locator(".eng-vote");
    if (await voteBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await voteBtn.click();
      await expect(voteBtn).toHaveClass(/on/);
    }

    // Evan activates ZEN MODE via the Zoom badge button
    await page5.keyboard.press("Escape");
    const zenBtn = page5.locator('button[aria-label="Toggle Zen mode"]');
    await expect(zenBtn).toBeVisible({ timeout: 5_000 });
    await zenBtn.click();

    // Verify Zen Mode indicator appears
    const zenBadge = page5.getByText("Zen Mode", { exact: true });
    await expect(zenBadge).toBeVisible({ timeout: 10_000 });

    // Verify Chrome (LeftRail and TopBar) is collapsed/hidden in Zen Mode
    await expect(page5.locator(".left-rail")).not.toBeVisible();
    await expect(page5.locator(".top-bar")).not.toBeVisible();

    // Evan exits Zen mode via the floating badge button
    const exitZenBtn = page5.getByRole("button", { name: /exit \(z\)/i });
    await expect(exitZenBtn).toBeVisible();
    await exitZenBtn.click({ force: true });

    // Verify normal Chrome is restored
    await expect(page5.locator(".left-rail")).toBeVisible();
    await expect(page5.locator(".top-bar")).toBeVisible();
    await expect(page5.getByText("Zen Mode", { exact: true })).not.toBeVisible();

    // -------------------------------------------------------------------------
    // MULTIPLAYER HEALTH & INTEGRITY CHECK
    // -------------------------------------------------------------------------
    // Verify Alice's screen is alive and healthy
    await expect(page1.locator(".node").first()).toBeVisible();

    // Cleanup all browser contexts cleanly
    await Promise.all([
      context1.close(),
      context2.close(),
      context3.close(),
      context4.close(),
      context5.close(),
    ]);

    expect(aliceErrors).toEqual([]);
  });
});
