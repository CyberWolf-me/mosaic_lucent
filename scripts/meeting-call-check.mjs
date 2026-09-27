/**
 * The board call, end to end (docs/28 A3.2).
 *
 * Three real accounts against the running app (localhost:5173 → API :4387)
 * and a REAL LiveKit project (the API's LUCENT_LIVEKIT_* settings). Chrome's
 * fake camera and microphone stand in for devices. It walks what a person
 * does in Zoom or Meet:
 *
 *   lobby preview, devices and "who's here" → join → see and hear each
 *   other → chat → reactions → raise and lower a hand → the host mutes
 *   someone → present a screen → the connection drops and recovers → a
 *   reload offers the call back → a second tab takes the call over → the
 *   host removes someone, who can't come back → a transcript runs → the host
 *   ends the call for everyone, and the transcript ends with it.
 *
 *   SERVER_LOG=<api log> node scripts/meeting-call-check.mjs
 *   HEADED=1 SERVER_LOG=<api log> node scripts/meeting-call-check.mjs
 *
 * SERVER_LOG is the API's log: sharing a board needs a verified email, and
 * the dev mailer logs the link there.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({
  headless: !headed,
  slowMo: headed ? 150 : 0,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const results = [];
const consoleLog = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) for (const line of consoleLog.slice(-12)) console.log(`      ${line}`);
}

/** Poll until `fn` is truthy (or the time runs out); returns the last value. */
async function waitFor(fn, timeout = 15000, every = 250) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    try {
      value = await fn();
      if (value) return value;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, every));
  }
  return value;
}

async function account(name) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["camera", "microphone"],
  });
  // A scripted recognizer in place of the browser's (headless Chrome has
  // none), so the transcript step speaks through the real capture path.
  await ctx.addInitScript(() => {
    class ScriptedRecognition {
      constructor() {
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this.results = [];
        window.__recognizer = this;
      }
      start() {}
      stop() {}
    }
    window.SpeechRecognition = ScriptedRecognition;
    window.webkitSpeechRecognition = ScriptedRecognition;
    window.__say = (text) => {
      const r = window.__recognizer;
      if (!r || !r.onresult) return false;
      const result = Object.assign([{ transcript: text }], { isFinal: true });
      r.results.push(result);
      r.onresult({ resultIndex: r.results.length - 1, results: r.results });
      return true;
    };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
  // Kept, and printed only when a check fails: LiveKit says why a transport stalled.
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      consoleLog.push(`[${name} ${m.type()}] ${m.text().slice(0, 200)}`);
    }
  });
  const email = `${name.split(" ")[0].toLowerCase()}_${Date.now()}@example.com`;
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill(name);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill("call-check-123");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  for (let i = 0; i < 5; i++) {
    const s = page.getByRole("button", { name: /^Skip$/ });
    if (!(await s.count())) break;
    await s
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(300);
  }
  return { ctx, page, email, name };
}

/** A mutating API call as this browser session: CSRF pair from the jar. */
async function post(page, path, data) {
  const mint = await page.request.get(`${base}/api/auth/csrf`);
  const { token } = await mint.json();
  const res = await page.request.post(`${base}${path}`, {
    headers: { "x-csrf-token": token, origin: base },
    data,
  });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

// --- three people on one board -------------------------------------------

const host = await account("Hana Host");
await host.page.getByRole("button", { name: "Share board" }).click();
await host.page.getByRole("button", { name: /publish & start collaborating/i }).click();
await host.page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(host.page.url()).searchParams.get("board");
check("the host published a board", !!boardId, boardId ?? "");

const log = process.env.SERVER_LOG ? readFileSync(process.env.SERVER_LOG, "utf8") : "";
const verify = log.match(
  new RegExp(`to=${host.email.replace(/[.+]/g, "\\$&")}[^\\n]*?(/verify\\?token=[\\w-]+)`),
)?.[1];
if (!verify) throw new Error("no verification link — set SERVER_LOG to the API server's log");
await host.page.goto(base + verify, { waitUntil: "networkidle" });

const guest = await account("Gus Guest");
const third = await account("Cy Viewer");
for (const [who, role] of [
  [guest, "editor"],
  [third, "viewer"],
]) {
  const link = await post(host.page, `/api/boards/${boardId}/share`, { role });
  const joined = await post(who.page, `/api/boards/${boardId}/join`, { token: link.body.token });
  check(`${who.name} joined the board as ${role}`, joined.status === 200, `${joined.status}`);
}

const meetingUrl = `${base}/?view=meeting&board=${boardId}`;
const stage = (p) => p.locator(".call-stage");
const tiles = (p) =>
  p
    .locator(".call-stage .call-tile")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));

// --- the lobby (S4) ---------------------------------------------------------

await host.page.goto(meetingUrl, { waitUntil: "networkidle" });
await host.page
  .getByRole("button", { name: /video call/i })
  .first()
  .click();
const lobby = host.page.getByRole("region", { name: "Join the call" });
await lobby.waitFor({ timeout: 10000 });
const previewPlays = await waitFor(() =>
  host.page.locator(".call-lobby-video").evaluate((v) => v.videoWidth > 0 && !v.paused),
);
check("the lobby shows your camera", previewPlays);
check(
  "the lobby has a mic level meter and device pickers",
  (await host.page.locator(".call-lobby-meter .call-meter").count()) === 1 &&
    (await host.page.locator(".call-lobby-devices select").count()) >= 2,
  `pickers=${await host.page.locator(".call-lobby-devices select").count()}`,
);
const alone = await waitFor(async () =>
  (await host.page.locator(".call-lobby-who").textContent())?.includes("No one else"),
);
check("the lobby says no one is here yet", alone);

// Camera off in the lobby, then on again, leaves the mic preview alone.
await host.page.getByRole("button", { name: "Turn off camera" }).click();
check(
  "turning the camera off in the lobby stops the preview",
  (await waitFor(async () => (await host.page.locator(".call-lobby-video").count()) === 0)) &&
    (await host.page.locator(".call-lobby-meter").count()) === 1,
);
await host.page.getByRole("button", { name: "Turn on camera" }).click();

await host.page.getByRole("button", { name: "Join now" }).click();
await stage(host.page).waitFor({ timeout: 20000 });
check("the host joined the call", await stage(host.page).isVisible());
const hostBadge = await waitFor(
  async () => (await host.page.locator(".call-tile .call-host-badge").count()) === 1,
);
check("the first person in is the host", hostBadge);

// The guest follows a joining link: it opens the lobby, it doesn't join by itself.
await guest.page.goto(`${meetingUrl}&call=1`, { waitUntil: "networkidle" });
const guestLobby = guest.page.getByRole("region", { name: "Join the call" });
await guestLobby.waitFor({ timeout: 10000 });
const whoHere = await waitFor(async () => {
  const t = await guest.page.locator(".call-lobby-who").textContent();
  return t?.includes("Hana Host is in this call") ? t : null;
});
check("a joining link opens the lobby, which says who's in", !!whoHere, whoHere ?? "");
await guest.page.getByRole("button", { name: "Join now" }).click();
await stage(guest.page).waitFor({ timeout: 20000 });

const seeEachOther = await waitFor(async () => {
  const h = await tiles(host.page);
  const g = await tiles(guest.page);
  return h.some((l) => l?.startsWith("Gus Guest")) && g.some((l) => l?.startsWith("Hana Host"));
});
check("both see each other", seeEachOther);
const guestVideo = await waitFor(() =>
  host.page
    .locator(".call-tile", { hasText: "Gus Guest" })
    .locator("video")
    .evaluate((v) => v.videoWidth > 0),
);
check("the host sees the guest's camera", guestVideo);
const heard = await waitFor(() =>
  guest.page.evaluate(() =>
    [...document.querySelectorAll("audio")].some(
      (a) => a.srcObject && a.srcObject.getAudioTracks().length > 0 && !a.paused,
    ),
  ),
);
check("the guest's page plays the host's voice", heard);

// --- chat, reactions, hands (S5) --------------------------------------------

await guest.page.getByRole("button", { name: /^Chat/ }).click();
await guest.page.getByLabel("Message everyone in the call").fill("Hello from Gus");
await guest.page.keyboard.press("Enter");
const unread = await waitFor(() =>
  host.page.getByRole("button", { name: "Chat (1 unread)" }).isVisible(),
);
check("a message shows as unread for the host", unread);
await host.page.getByRole("button", { name: /^Chat/ }).click();
const message = await waitFor(async () => {
  const text = await host.page.locator(".call-chat").textContent();
  return text?.includes("Gus Guest") && text.includes("Hello from Gus") ? text : null;
});
check("the host reads it, under the guest's name", !!message);

// Trace what arrives, so a miss says whether the packet or the render failed.
await guest.page.evaluate(() => {
  window.__packets = [];
  window.__lucentCall?.on("dataReceived", (_payload, p, _kind, topic) =>
    window.__packets.push(`${topic}:${p ? "from-participant" : "no-participant"}`),
  );
});
await host.page.getByRole("button", { name: "Send a reaction" }).click();
await host.page.getByRole("menuitem", { name: "React 🎉" }).click();
const reaction = await waitFor(
  async () => (await guest.page.getByLabel("Hana Host reacted 🎉").count()) > 0,
  5000,
  100,
);
check(
  "a reaction floats over the sender's tile",
  reaction,
  reaction ? "" : `packets: ${await guest.page.evaluate(() => window.__packets.join(", "))}`,
);

await guest.page.getByRole("button", { name: /Raise your hand/ }).click();
const toast = await waitFor(async () =>
  (await host.page.locator(".call-toast").textContent())?.includes("Gus Guest raised a hand"),
);
check("the host is told a hand went up", toast);
await host.page.getByRole("button", { name: /^People/ }).click();
check(
  "People lists raised hands first",
  await waitFor(async () =>
    (await host.page.locator(".call-panel").textContent())?.includes("Raised hands · 1"),
  ),
);
await host.page
  .locator(".call-panel")
  .getByRole("button", { name: "Host controls for Gus Guest" })
  .click();
await host.page.getByRole("menuitem", { name: "Lower hand" }).click();
check(
  "the host lowers the guest's hand",
  await waitFor(() => guest.page.getByRole("button", { name: /Raise your hand/ }).isVisible()),
);

// --- the host mutes the guest -----------------------------------------------

await host.page
  .locator(".call-panel")
  .getByRole("button", { name: "Host controls for Gus Guest" })
  .click();
await host.page.getByRole("menuitem", { name: "Mute" }).click();
const muted = await waitFor(
  async () =>
    (await guest.page.getByRole("button", { name: /Turn on microphone/ }).count()) > 0 &&
    (await guest.page.locator(".call-stage").textContent())?.includes("The host muted you"),
);
check("the guest is muted, and told who did it", muted);
check(
  "the host sees the guest muted",
  await waitFor(async () => (await tiles(host.page)).includes("Gus Guest, muted")),
);
await guest.page.getByRole("button", { name: /Turn on microphone/ }).click();
check(
  "the guest can unmute again",
  await waitFor(async () => (await tiles(host.page)).includes("Gus Guest")),
);

// --- presenting (F24) --------------------------------------------------------

await host.page.getByRole("button", { name: "Present your screen" }).click();
const presenting = await waitFor(
  async () => (await guest.page.getByLabel("Hana Host is presenting").count()) > 0,
  15000,
);
check("the guest sees the host's screen, in the spotlight", presenting);
if (presenting) {
  await host.page.getByRole("button", { name: "Stop presenting" }).click();
  check(
    "stopping takes the screen away",
    await waitFor(
      async () => (await guest.page.getByLabel("Hana Host is presenting").count()) === 0,
    ),
  );
}

// --- live captions (S5) ---------------------------------------------------------

await host.page.evaluate(() => (window.__recognizer = null));
await guest.page.getByRole("button", { name: "Turn on captions (c)" }).click();
check(
  "turning on captions tells the speaker their device transcribes them",
  await waitFor(async () =>
    (await host.page.locator(".call-banner.is-capture").textContent())?.includes(
      "Someone is reading live captions",
    ),
  ),
);
await waitFor(() => host.page.evaluate(() => !!window.__recognizer?.onresult), 10000);
await host.page.evaluate(() => window.__say("Captions check, one two three."));
check(
  "the reader sees the speaker's words as a caption, under their name",
  await waitFor(async () => {
    const text = await guest.page.locator(".call-captions").textContent();
    return text?.includes("Hana Host") && text.includes("Captions check, one two three.");
  }, 10000),
);
await guest.page.getByRole("button", { name: "Turn off captions (c)" }).click();
check(
  "turning captions off stops the speaker's transcription",
  await waitFor(async () => (await host.page.locator(".call-banner.is-capture").count()) === 0),
);

// --- the connection drops and recovers (§4.2) -------------------------------

const banner = guest.page.locator(".call-banner.is-warn");
// Record whether the banner ever appeared: a reconnect can be quicker than a poll.
await guest.page.evaluate(() => {
  window.__sawBanner = false;
  new MutationObserver(() => {
    if (document.querySelector(".call-banner.is-warn")) window.__sawBanner = true;
  }).observe(document.body, { childList: true, subtree: true });
});
// Only the signal drops: media keeps flowing, so the call carries on quietly.
await guest.page.evaluate(() => window.__lucentCall?.simulateScenario("signal-reconnect"));
const connected = () =>
  waitFor(() => guest.page.evaluate(() => window.__lucentCall?.state === "connected"), 20000);
await guest.page.waitForTimeout(500);
await connected();
check(
  "a signal-only drop doesn't interrupt the call",
  !(await guest.page.evaluate(() => window.__sawBanner)) &&
    (await tiles(guest.page)).some((l) => l?.startsWith("Hana Host")),
);
// The whole connection drops: the banner says so, and the call comes back.
await guest.page.evaluate(() => (window.__sawBanner = false));
await guest.page.evaluate(() => window.__lucentCall?.simulateScenario("full-reconnect"));
const fullBack = await waitFor(async () => {
  const g = await tiles(guest.page);
  return !(await banner.isVisible()) && g.some((l) => l?.startsWith("Hana Host"));
}, 25000);
check(
  "a full reconnect shows Reconnecting, then comes back to the same call",
  fullBack && (await guest.page.evaluate(() => window.__sawBanner)),
  fullBack
    ? ""
    : `banner seen: ${await guest.page.evaluate(() => window.__sawBanner)}; page: ${(
        await guest.page.locator("main").textContent()
      )
        ?.replace(/\s+/g, " ")
        .slice(0, 300)}`,
);

// --- reload, then rejoin (S6) ------------------------------------------------

await guest.page.reload({ waitUntil: "networkidle" });
const offer = guest.page.getByRole("complementary", { name: "Rejoin the call" });
const offered = await waitFor(() => offer.isVisible(), 10000);
check(
  "after a reload the call is offered back",
  offered,
  offered
    ? ""
    : `marker: ${await guest.page.evaluate(() => sessionStorage.getItem("lucent.call"))}`,
);
await offer.getByRole("button", { name: "Rejoin" }).click();
check(
  "Rejoin puts the guest back in the call",
  await waitFor(
    async () => (await tiles(host.page)).some((l) => l?.startsWith("Gus Guest")),
    20000,
  ),
);

// --- a second tab takes the call over ---------------------------------------

const tab2 = await guest.ctx.newPage();
await tab2.goto(`${meetingUrl}&call=1`, { waitUntil: "networkidle" });
await tab2.getByRole("button", { name: "Join now" }).click();
await stage(tab2).waitFor({ timeout: 20000 });
const replaced = await waitFor(async () =>
  (await guest.page.getByRole("status", { name: "The call ended" }).textContent())?.includes(
    "another tab",
  ),
);
check("joining from a second tab ends the call in the first, and says why", replaced);
await guest.page.close();
guest.page = tab2;
await tab2.waitForTimeout(3000);
const tab2InCall =
  (await tab2.locator(".call-stage").isVisible()) &&
  (await tiles(tab2)).some((l) => l?.startsWith("Hana Host"));
check(
  "the tab that took over stays in the call",
  tab2InCall,
  tab2InCall
    ? ""
    : ((await tab2.locator("main").textContent()) ?? "").replace(/\s+/g, " ").slice(0, 200),
);

// --- a transcript, then a viewer joins -----------------------------------------

await host.page.evaluate(() => (window.__recognizer = null));
await host.page.getByRole("button", { name: "Transcribe this meeting" }).click();
await host.page.waitForFunction(() => !!window.__recognizer?.onresult, null, { timeout: 10000 });
await host.page.evaluate(() => window.__say("We ship the call feature on Friday."));
const recChip = await waitFor(async () =>
  (await guest.page.locator(".call-head").textContent())?.includes("Lucent is transcribing"),
);
check("everyone sees that the meeting is being transcribed", recChip);

// --- the host locks the call, and lets only hosts present ---------------------------

const hostMenu = async (item) => {
  await host.page.getByRole("button", { name: "More options" }).click();
  await host.page.getByRole("menuitem", { name: item }).click();
};
await hostMenu(/Lock the call/);
check(
  "a locked call shows it",
  await waitFor(async () =>
    (await guest.page.locator(".call-head").textContent())?.includes("Locked"),
  ),
);
await third.page.goto(`${meetingUrl}&call=1`, { waitUntil: "networkidle" });
await third.page.getByRole("button", { name: "Join now" }).click();
check(
  "no one new gets into a locked call, and they're told why",
  await waitFor(async () =>
    (await third.page.locator(".call-lobby-error").textContent())?.includes(
      "The host locked this call",
    ),
  ),
);
await hostMenu(/Unlock the call/);
await hostMenu(/Only hosts can present/);
const guestShare = guest.page.getByRole("button", { name: "Only hosts can present in this call" });
check(
  "only hosts can present when the host says so",
  await waitFor(async () => (await guestShare.count()) === 1 && (await guestShare.isDisabled())),
);
await hostMenu(/Let everyone present/);
check(
  "and everyone can again when they don't",
  await waitFor(
    async () => await guest.page.getByRole("button", { name: "Present your screen" }).isEnabled(),
  ),
);

await third.page.getByRole("button", { name: /Try again|Join now/ }).click();
await stage(third.page).waitFor({ timeout: 20000 });
check(
  "a board viewer can join and speak (docs/28 §9.3)",
  await waitFor(async () => (await tiles(host.page)).some((l) => l === "Cy Viewer")),
);

// --- each person transcribed under their own name (A3.5) -----------------------

const liveTurns = async () => {
  const res = await host.page.request.get(`${base}/api/boards/${boardId}/meetings`);
  return (await res.json()).meetings?.[0]?.turns ?? [];
};
const say = (page, text) =>
  waitFor(() => page.evaluate((t) => window.__say?.(t) === true, text), 10000);
const includedBanner = async (page) =>
  (await page.locator(".call-banner.is-capture").textContent())?.includes(
    "go into the meeting's transcript under your name",
  );
check(
  "the others are told their words go into the transcript",
  (await waitFor(() => includedBanner(guest.page))) &&
    (await waitFor(() => includedBanner(third.page))),
);
await say(guest.page, "The API is ready for review.");
await say(third.page, "I will write the release notes.");
const named = await waitFor(async () => {
  const turns = await liveTurns();
  const by = (text) => turns.find((t) => t.text === text);
  const gus = by("The API is ready for review.");
  const cy = by("I will write the release notes.");
  const hana = by("We ship the call feature on Friday.");
  return gus?.speaker === "Gus Guest" &&
    cy?.speaker === "Cy Viewer" &&
    hana?.speaker === "Hana Host" &&
    gus.speakerId &&
    cy.speakerId &&
    hana.speakerId &&
    new Set([gus.speakerId, cy.speakerId, hana.speakerId]).size === 3
    ? turns
    : null;
}, 15000);
check(
  "each person's line lands in one transcript under their own name",
  !!named,
  (await liveTurns()).map((t) => `${t.speaker}: ${t.text}`).join(" | "),
);
const guestRecord = guest.page.getByRole("button", {
  name: "Hana Host is already transcribing this call",
});
check(
  "a second recording of the same call can't start",
  (await guestRecord.count()) === 1 && (await guestRecord.isDisabled()),
);

await third.page.getByRole("button", { name: "Stop transcribing me" }).click();
check(
  "opting out shows on the person's tile",
  await waitFor(async () =>
    (await host.page.locator(".call-tile", { hasText: "Cy Viewer" }).textContent())?.includes(
      "Not transcribed",
    ),
  ),
);
await third.page.evaluate(() => window.__say?.("This should stay out of the transcript."));
await host.page.waitForTimeout(2500);
check(
  "after Stop transcribing me, nothing of theirs is captured",
  !(await liveTurns()).some((t) => t.text === "This should stay out of the transcript."),
);

// --- the host removes the guest ------------------------------------------------

await host.page
  .locator(".call-panel")
  .getByRole("button", { name: "Host controls for Gus Guest" })
  .click();
await host.page.getByRole("menuitem", { name: "Remove from call" }).click();
const removed = await waitFor(async () =>
  (await guest.page.getByRole("status", { name: "The call ended" }).textContent())?.includes(
    "The host removed you",
  ),
);
check("the removed guest is told why", removed);
await guest.page.getByRole("button", { name: "Close" }).click();
await guest.page.getByRole("button", { name: "Join now" }).click();
const refused = await waitFor(async () =>
  (await guest.page.locator(".call-lobby-error").textContent())?.includes(
    "The host removed you from this call",
  ),
);
check("and can't come back into this call", refused);

// --- the host ends the call for everyone ----------------------------------------

await host.page.getByRole("button", { name: "Leave or end the call" }).click();
await host.page.getByRole("menuitem", { name: /End the call for everyone/ }).click();
const thirdEnded = await waitFor(async () =>
  (await third.page.getByRole("status", { name: "The call ended" }).textContent())?.includes(
    "The host ended the meeting for everyone",
  ),
);
check("everyone else is told the host ended it", thirdEnded);
const hostEnded = await waitFor(async () =>
  (await host.page.getByRole("status", { name: "The call ended" }).textContent())?.includes(
    "You ended the call for everyone",
  ),
);
check("the host is told they ended it", hostEnded);
const meetings = await waitFor(async () => {
  const res = await host.page.request.get(`${base}/api/boards/${boardId}/meetings`);
  const list = (await res.json()).meetings;
  return list?.length === 1 && list[0].endedAt !== null ? list : null;
});
check(
  "ending the call ends its transcript, with what was said",
  meetings?.[0]?.turns?.[0]?.text === "We ship the call feature on Friday.",
  meetings ? `${meetings[0].turns.length} turn(s)` : "still open",
);
const after = await host.page.request.get(`${base}/api/boards/${boardId}/call`);
check("the call is gone on the server", (await after.json()).live === false);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
