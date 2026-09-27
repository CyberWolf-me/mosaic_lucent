/**
 * Meeting notes, end to end (docs/27 N1) — "we don't even know if the note
 * taking section works". Against the running app (localhost:5173 → API
 * :4387, LUCENT_AI_PROVIDER=mock), with a scripted speech recognizer:
 *
 *   record a meeting → type private notes while it runs (they save, stamped
 *   against the transcript) → stop → the note enhances itself: your lines in
 *   ink, Lucent's cited to the turns → reload: all of it is still there →
 *   edit one of Lucent's lines (it becomes yours, and saves) → copy as
 *   Markdown → a viewer can't read someone else's notes.
 *
 *   node scripts/meeting-notes-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 200 : 0 });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

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

// --- a shared board ---------------------------------------------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Nora Notes");
await page.locator('input[type="email"]').first().fill(`notes_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("notes-check-123");
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
await page.getByRole("button", { name: "Share board" }).click();
await page.getByRole("button", { name: /publish & start collaborating/i }).click();
await page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(page.url()).searchParams.get("board");
await page.keyboard.press("Escape");
check("a shared board", !!boardId, boardId ?? "");

const meetingsOnBoard = async () => {
  const res = await page.request.get(`${base}/api/boards/${boardId}/meetings`);
  return (await res.json()).meetings ?? [];
};
const say = async (text) => {
  const ok = await waitFor(() => page.evaluate((t) => window.__say(t), text), 10000);
  if (!ok) throw new Error("the scripted recognizer is not listening");
  await page.waitForTimeout(600);
};

// --- record, and take notes while it runs --------------------------------------------
await page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });
await page
  .getByRole("button", { name: /start recording|new recording/i })
  .first()
  .click();
await say("We ship the pricing change on Friday.");
await say("Alice owns the rollout and the announcement.");
await say("Open question: do we grandfather existing customers?");

await page.getByRole("tab", { name: "Notes" }).click();
const pad = page.getByLabel("Your notes");
await pad.waitFor({ timeout: 10000 });
await pad.fill("pricing Friday\nAlice = rollout");
const saved = await waitFor(async () =>
  (await page.locator(".mn-state").textContent())?.includes("Private to you"),
);
check("notes typed during the meeting save", saved);
const meetingId = (await meetingsOnBoard())[0]?.id;
const stored = await waitFor(async () => {
  const res = await page.request.get(`${base}/api/boards/${boardId}/meetings/${meetingId}/notes`);
  if (!res.ok()) return null;
  const n = await res.json();
  return n.lines?.map((l) => l.text).join("|") === "pricing Friday|Alice = rollout" ? n : null;
});
check(
  "the server holds them, each line stamped with the turn it came after",
  stored && stored.lines.every((l) => typeof l.turn === "number" && l.turn > 0),
  stored ? JSON.stringify(stored.lines.map((l) => l.turn)) : "not stored",
);

// --- stop: the note writes itself ------------------------------------------------------
await page.getByRole("button", { name: /^stop$/i }).click();
const enhanced = await waitFor(async () => (await page.locator(".mn-note").count()) > 0, 20000);
check("when the meeting ends, the note enhances itself", enhanced);
const mine = await page.locator(".mn-item.user").allTextContents();
const added = await page.locator(".mn-item.ai").count();
const cites = await page.locator(".mn-item.ai .mn-cite").count();
check(
  "your lines stay yours, in your words",
  mine.some((t) => t.includes("pricing Friday")) && mine.some((t) => t.includes("Alice = rollout")),
  mine.join(" | "),
);
check(
  "Lucent's lines each cite the turns they came from",
  added > 0 && cites === added,
  `${added} added, ${cites} cited`,
);

// --- reload: nothing is lost ---------------------------------------------------------
await page.goto(`${base}/?view=meeting&board=${boardId}&meeting=${meetingId}`, {
  waitUntil: "networkidle",
});
await page.getByRole("tab", { name: "Notes" }).click();
const reloaded = await waitFor(async () => {
  const text = await page.getByLabel("Your notes").inputValue();
  return text === "pricing Friday\nAlice = rollout";
});
check("after a reload, the notes are still there", reloaded);
await page.getByRole("tab", { name: "Enhanced" }).click();
check(
  "and so is the enhanced note",
  await waitFor(async () => (await page.locator(".mn-item.ai").count()) === added),
);

// --- edit one of Lucent's lines: it becomes yours ------------------------------------
const firstAi = page.locator(".mn-item.ai .mn-text").first();
await firstAi.dblclick();
const editor = page.getByLabel("Edit this line");
await editor.fill("Pricing ships Friday — confirmed by Alice");
await editor.press("Enter");
check(
  "an edited line becomes yours",
  await waitFor(async () =>
    (await page.locator(".mn-item.user").allTextContents()).some((t) =>
      t.includes("confirmed by Alice"),
    ),
  ),
);
const editSaved = await waitFor(async () => {
  const res = await page.request.get(`${base}/api/boards/${boardId}/meetings/${meetingId}/notes`);
  const n = await res.json();
  return n.enhanced?.sections
    ?.flatMap((s) => s.items)
    .some((i) => i.text.includes("confirmed by Alice") && i.source === "user");
});
check("and the edit is saved", editSaved);

// --- copy out ------------------------------------------------------------------------
await page.getByRole("button", { name: "Copy as Markdown" }).click();
const markdown = await waitFor(() => page.evaluate(() => navigator.clipboard.readText()));
check(
  "Copy as Markdown gives the whole note",
  markdown?.startsWith("#") && markdown.includes("confirmed by Alice"),
  markdown?.split("\n")[0],
);

// --- private: another member can't read them -------------------------------------------
const other = await browser.newContext();
const otherPage = await other.newPage();
await otherPage.goto(base + "/signup", { waitUntil: "networkidle" });
await otherPage.locator('input[type="text"]').first().fill("Omar Other");
await otherPage.locator('input[type="email"]').first().fill(`other_${Date.now()}@example.com`);
await otherPage.locator('input[type="password"]').first().fill("notes-check-123");
await otherPage.getByRole("button", { name: /create account/i }).click();
await otherPage.waitForTimeout(1500);
const theirs = await otherPage.request.get(
  `${base}/api/boards/${boardId}/meetings/${meetingId}/notes`,
);
check("someone without the board can't read them", theirs.status() === 404, `${theirs.status()}`);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
