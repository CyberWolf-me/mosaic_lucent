/**
 * Meeting capture durability check (docs/28 F13).
 *
 * Drives the REAL meeting view against the running app (localhost:5173 →
 * API :4387) and asserts that captured lines reach the server transcript
 * WHILE the meeting runs — not only at Stop — and that Stop ends that same
 * transcript with every line. No microphone and no AI call: the browser's
 * speech recognizer is replaced by a scripted one (`window.__say(text)`), so
 * the lines travel the real path — recognizer → browser STT provider →
 * MeetingView onFinal → the server.
 *
 *   node scripts/meeting-capture-check.mjs            # headless
 *   HEADED=1 node scripts/meeting-capture-check.mjs   # watch it
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";

const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 400 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

// A scripted recognizer in place of the browser's: each __say() is one
// finalized utterance, shaped like Chrome's SpeechRecognition results.
await ctx.addInitScript(() => {
  class ScriptedRecognition {
    constructor() {
      this.lang = "";
      this.interimResults = false;
      this.continuous = false;
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
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
  }
  window.__say = (text) => {
    const r = window.__recognizer;
    if (!r || !r.onresult) return false;
    const result = Object.assign([{ transcript: text }], { isFinal: true });
    r.results.push(result);
    r.onresult({ resultIndex: r.results.length - 1, results: r.results });
    return true;
  };
});

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// --- sign up ---
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Capture Check");
await page.locator('input[type="email"]').first().fill(`capture_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("capture-check-123");
await page.getByRole("button", { name: /create account/i }).click();
await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
for (let i = 0; i < 5; i++) {
  const s = page.getByRole("button", { name: /^Skip$/ });
  if (await s.count()) {
    await s
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(300);
  } else break;
}

// --- publish the board: meetings save against a server board ---
await page.getByRole("button", { name: "Share board" }).click();
await page.getByRole("button", { name: /publish & start collaborating/i }).click();
await page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(page.url()).searchParams.get("board");
await page.keyboard.press("Escape");
check("board published", !!boardId, boardId ?? "no ?board= in the URL");

const meetings = async () => {
  const res = await page.request.get(`${base}/api/boards/${boardId}/meetings`);
  return res.ok() ? (await res.json()).meetings : null;
};
const say = async (text) => {
  const ok = await page.evaluate((t) => window.__say(t), text);
  if (!ok) throw new Error("the scripted recognizer is not listening");
  await page.waitForTimeout(700); // the append is a network round trip
};
const texts = (m) => (m?.turns ?? []).map((t) => t.text);

// --- capture 1: lines reach the server while the meeting runs ---
await page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
await page.waitForFunction(() => !!window.__recognizer?.onresult, { timeout: 10000 });
check("nothing on the server before anyone speaks", (await meetings())?.length === 0);

await say("We ship the pricing change on Friday.");
let list = await meetings();
check(
  "first line opens the transcript while recording",
  list?.length === 1 && list[0].endedAt === null && list[0].turns.length === 1,
  `meetings=${list?.length} turns=${list?.[0]?.turns.length} endedAt=${list?.[0]?.endedAt}`,
);
const firstId = list?.[0]?.id;

await say("Alice owns the rollout.");
list = await meetings();
check(
  "second line is appended to the same open transcript",
  list?.length === 1 &&
    list[0].id === firstId &&
    list[0].turns.length === 2 &&
    list[0].endedAt === null,
  `turns=${list?.[0]?.turns.length}`,
);

await page.getByRole("button", { name: /^stop$/i }).click();
await page.waitForTimeout(1200);
list = await meetings();
check(
  "Stop ends that same transcript with every line",
  list?.length === 1 &&
    list[0].id === firstId &&
    list[0].endedAt !== null &&
    texts(list[0]).join(" | ") ===
      "We ship the pricing change on Friday. | Alice owns the rollout.",
  texts(list?.[0]).join(" | "),
);

// --- A3.3: the ended meeting gets its summary, written server-side ---
// MeetingEnded → the outbox consumer → the meeting.recap job → the store;
// the saved-meeting view polls until it lands.
let summarized = false;
for (let i = 0; i < 40 && !summarized; i++) {
  await page.waitForTimeout(1000);
  const shownText = await page.locator("body").innerText();
  summarized = /summary/i.test(shownText) && !/writing the summary/i.test(shownText);
}
const withRecap = (await meetings())?.find((m) => m.id === firstId);
check(
  "the ended meeting gets its summary, written by the server",
  summarized && !!withRecap?.recap,
  `recap=${!!withRecap?.recap} by=${withRecap?.recap?.by}`,
);

// --- capture 2: a reload mid-meeting loses nothing ---
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
await page.waitForFunction(
  () => !!window.__recognizer?.onresult && window.__recognizer.results.length === 0,
  {
    timeout: 10000,
  },
);
await say("Is the migration reversible?");
await page.reload({ waitUntil: "networkidle" });
list = await meetings();
const second = list?.find((m) => m.id !== firstId);
check(
  "after a reload mid-meeting, the line said before it is on the server",
  list?.length === 2 && texts(second).join(" | ") === "Is the migration reversible?",
  `meetings=${list?.length} second=${texts(second).join(" | ")}`,
);

// --- capture 3 (F14): leaving the meeting view keeps recording ---
await page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
await page.waitForFunction(
  () => !!window.__recognizer?.onresult && window.__recognizer.results.length === 0,
  {
    timeout: 10000,
  },
);
await say("Said in the meeting view.");
// In-app navigation to the canvas: the Router's popstate path, no reload.
await page.evaluate((id) => {
  window.history.pushState(null, "", `/?view=canvas&board=${id}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}, boardId);
await page.waitForTimeout(600);
const stopInDock = page.getByRole("button", { name: "Stop recording" });
check("away from the meeting view, the dock shows the recording", await stopInDock.isVisible());
await say("Said while on the canvas.");
list = await meetings();
const third = list?.find((m) => m.endedAt === null && texts(m)[0] === "Said in the meeting view.");
check(
  "a line spoken on the canvas still reaches the open transcript",
  texts(third).join(" | ") === "Said in the meeting view. | Said while on the canvas.",
  texts(third).join(" | "),
);
await stopInDock.click();
await page.waitForTimeout(1200);
list = await meetings();
const thirdEnded = list?.find((m) => m.id === third?.id);
check(
  "Stop in the dock ends that transcript with every line",
  thirdEnded?.endedAt !== null && thirdEnded?.turns.length === 2,
  `endedAt=${thirdEnded?.endedAt} turns=${thirdEnded?.turns.length}`,
);
check("the dock goes away once the recording stops", !(await stopInDock.isVisible()));

// --- capture 4 (F16): a pending proposal holds the next batch ---
// Extraction fires on 3 new lines + a pause (meeting-extract.ts). The
// server keeps one pending proposal per board; a second batch used to
// supersede the first before anyone saw it.
const proposals = async () => {
  const res = await page.request.get(`${base}/api/boards/${boardId}/proposals`);
  return res.ok() ? (await res.json()).proposals : [];
};
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await page.waitForTimeout(500);
  }
};
const statusText = () => page.locator("body").innerText();

await page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
await page.waitForFunction(
  () => !!window.__recognizer?.onresult && window.__recognizer.results.length === 0,
  { timeout: 10000 },
);
for (const line of [
  "We agreed to move billing to Stripe.",
  "Priya owns the migration.",
  "Risk: webhooks may double-fire.",
])
  await say(line);
const firstPending = await until(
  async () => (await proposals()).find((p) => p.status === "pending"),
  15000,
);
check("a batch of meeting lines becomes a pending proposal", !!firstPending, firstPending?.id);
check(
  "the proposal is reviewable in the meeting view",
  await page.getByRole("dialog", { name: "Proposed changes" }).isVisible(),
);

for (const line of [
  "Also, the invoices move next quarter.",
  "Sam checks the tax rules.",
  "Open question: which regions first?",
])
  await say(line);
await page.waitForTimeout(22000); // past the engine's 15 s minimum gap and its triggers
const after = await proposals();
check(
  "the next batch waits instead of replacing the pending proposal",
  after.filter((p) => p.status === "pending").length === 1 &&
    after.find((p) => p.status === "pending")?.id === firstPending?.id &&
    !after.some((p) => p.status === "superseded"),
  after.map((p) => `${p.id}:${p.status}`).join(", "),
);
check(
  "the meeting view says the lines are waiting for review",
  (await statusText()).includes("Waiting for your review"),
);

await page.getByRole("button", { name: /apply all/i }).click();
const released = await until(
  async () => !(await statusText()).includes("Waiting for your review"),
  30000,
);
const decided = (await proposals()).find((p) => p.id === firstPending?.id);
check(
  "applying the proposal records the decision",
  decided?.status === "approved",
  decided?.status,
);
check("once it is decided, the held lines go out", released);
await page.getByRole("button", { name: /^stop$/i }).click();
await page.waitForTimeout(1000);

// --- capture 5 (F21): a spoken command the canvas AI must clarify ---
// The mock answers "add it…" with a question and no operations, as the real
// prompt instructs for a request with no referent. The question used to land
// only in the canvas chat.
const boardNodes = async () => {
  const res = await page.request.get(`${base}/api/boards/${boardId}`);
  const board = res.ok() ? await res.json() : {};
  return Object.values(board.workspace?.nodes ?? {}).map((n) => n.label ?? "");
};
await page.goto(`${base}/?view=meeting&board=${boardId}&voicehud=1`, {
  waitUntil: "networkidle",
});
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
await page.waitForFunction(
  () => !!window.__recognizer?.onresult && window.__recognizer.results.length === 0,
  { timeout: 10000 },
);
await say("Lucent, add it to the board.");
const asked = await until(
  async () => (await statusText()).includes("Which part of the board do you mean"),
  20000,
);
check("the clarifying question reaches the meeting view", asked);
const leaseState = () => page.evaluate(() => window.__lucentVoiceDebug?.state());
const waiting = await until(
  async () => (await leaseState()) === "waiting_for_user_response",
  20000,
);
check("the conversation waits for the speaker's answer", waiting, await leaseState());
await say("the payments service");
const answered = await until(
  async () => (await boardNodes()).some((l) => l.startsWith("add it to the board")),
  20000,
);
check(
  "the answer goes back to the canvas with the instruction it clarifies",
  answered,
  (await boardNodes()).filter((l) => l.startsWith("add it")).join(" | "),
);
await page.getByRole("button", { name: /^stop$/i }).click();
await page.waitForTimeout(1000);

// --- F25: the dock opens the recording's own board ---
// Record on board A, open board B from the dashboard mid-meeting, then use
// the dock's Open: it used to open B's meeting view, not the recording's.
const csrfPost = async (path, data) => {
  const { token } = await (await page.request.get(`${base}/api/auth/csrf`)).json();
  const res = await page.request.post(`${base}${path}`, {
    headers: { "x-csrf-token": token, origin: base },
    data,
  });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
};
const { orgs } = await (await page.request.get(`${base}/api/orgs`)).json();
// Any valid workspace will do; board A's is one.
const { workspace: validWorkspace } = await (
  await page.request.get(`${base}/api/boards/${boardId}`)
).json();
const boardB = await csrfPost("/api/boards", {
  name: "Board B",
  orgId: orgs[0].id,
  workspace: validWorkspace,
});
check(
  "a second board exists",
  boardB.status === 201,
  `${boardB.status} ${JSON.stringify(boardB.body)}`,
);

await page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
await page.waitForFunction(
  () => !!window.__recognizer?.onresult && window.__recognizer.results.length === 0,
  { timeout: 10000 },
);
await say("Said on board A before switching.");
await page.evaluate(() => {
  window.history.pushState(null, "", "/?view=dashboard");
  window.dispatchEvent(new PopStateEvent("popstate"));
});
await page.getByText("Board B", { exact: true }).first().click();
await page.waitForTimeout(1500);
await say("Said while board B is open.");
await page.getByRole("button", { name: "Open the meeting" }).click();
await page.waitForTimeout(1500);
const onA = await statusText();
// The kept-alive view shows the live lines whichever board is open; the
// board it lands on is what F25 is about (the crumb names it).
check("Open lands on the recording's board, not the one that was open", !onA.includes("Board B"));
check(
  "still recording there, with every line",
  onA.includes("Said on board A before switching.") &&
    onA.includes("Said while board B is open.") &&
    (await page.getByRole("button", { name: /^stop$/i }).isVisible()),
);
await page.getByRole("button", { name: /^stop$/i }).click();
await page.waitForTimeout(1200);
const savedOnA = (await meetings())?.find((m) =>
  texts(m).includes("Said on board A before switching."),
);
check(
  "the transcript was kept on board A, whole",
  savedOnA?.endedAt !== null && savedOnA?.turns.length === 2,
  `turns=${savedOnA?.turns.length} endedAt=${savedOnA?.endedAt}`,
);

// --- A3.1 (ADR 0045, docs/28 S1/S10): the workspace list, open, rename ---
await page.goto(`${base}/?view=meetings`, { waitUntil: "networkidle" });
const pastSection = page.getByRole("region", { name: "Past" });
await pastSection.waitFor({ timeout: 10000 }).catch(() => {});
const pastRows = pastSection.getByRole("button");
check(
  "the workspace Meetings list shows every past meeting",
  (await pastRows.count()) >= 5,
  `${await pastRows.count()} past rows`,
);
await pastRows.first().click();
await page.waitForTimeout(1200);
check(
  "a row opens that meeting on its board",
  /saved meeting/i.test(await statusText()) && new URL(page.url()).searchParams.has("meeting"),
);
const openedId = new URL(page.url()).searchParams.get("meeting");
await page.getByRole("button", { name: "Rename" }).click();
await page.getByLabel("Meeting title").fill("Pricing sync");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(800);
const renamed = (await meetings())?.find((m) => m.id === openedId);
check(
  "renaming names the meeting on the server",
  renamed?.title === "Pricing sync",
  renamed?.title,
);
await page.goto(`${base}/?view=meetings`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
check(
  "the list shows the new name",
  (await page.getByRole("region", { name: "Past" }).innerText()).includes("Pricing sync"),
);
if (process.env.SHOT_DIR)
  await page.screenshot({ path: `${process.env.SHOT_DIR}/meetings-list.png` });

// --- F22: a capture that works with less says so ---
// Ask for on-device Whisper in a page where it can't run (no MediaRecorder):
// the browser recognizer takes over, and the fallback used to be silent.
await page.evaluate(() => {
  const raw = localStorage.getItem("lucent.settings");
  const s = raw ? JSON.parse(raw) : {};
  localStorage.setItem("lucent.settings", JSON.stringify({ ...s, sttProvider: "whisper" }));
});
await page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });
await page.evaluate(() => {
  window.MediaRecorder = undefined;
});
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
const degradedNote = await until(
  async () =>
    (await statusText()).includes(
      "Browser speech recognition is transcribing: On-device Whisper isn't available here",
    ),
  10000,
);
check("a fallback is named while the capture runs", degradedNote);
await page
  .getByRole("button", { name: /^stop$/i })
  .click()
  .catch(() => {});
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("lucent.settings") ?? "{}");
  localStorage.setItem("lucent.settings", JSON.stringify({ ...s, sttProvider: "browser" }));
});

if (headed) {
  console.log("\n(headed) leaving the window open 5s…");
  await page.waitForTimeout(5000);
}
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
