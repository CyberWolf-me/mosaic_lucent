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

if (headed) {
  console.log("\n(headed) leaving the window open 5s…");
  await page.waitForTimeout(5000);
}
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
