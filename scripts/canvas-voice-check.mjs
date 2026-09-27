/**
 * Talking with Lucent on the canvas, end to end — "the agent is not
 * interacting, it only reads out the changes it made" and "STT only gets
 * about four words, then resets". Against the running app (localhost:5173 →
 * API :4387, LUCENT_AI_PROVIDER=mock), with a scripted speech recognizer and
 * a recording speech synthesizer:
 *
 *   tap the mic once → say something → a pause ends the turn → Lucent answers
 *   OUT LOUD with its conversational reply (a question back, not the change
 *   list) → it listens again by itself → a phrase the recognizer never
 *   finalized, split across its own restart, still arrives whole → "that's
 *   all" ends the conversation.
 *
 *   node scripts/canvas-voice-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await ctx.addInitScript(() => {
  window.__recognizers = 0;
  class ScriptedRecognition {
    constructor() {
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.results = [];
      window.__recognizer = this;
      window.__recognizers++;
    }
    start() {}
    stop() {}
  }
  window.SpeechRecognition = ScriptedRecognition;
  window.webkitSpeechRecognition = ScriptedRecognition;
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
  }
  const push = (text, isFinal) => {
    const r = window.__recognizer;
    if (!r || !r.onresult) return false;
    const result = Object.assign([{ transcript: text }], { isFinal });
    // An interim result is replaced by the next one at the same index.
    const last = r.results[r.results.length - 1];
    if (last && !last.isFinal) r.results[r.results.length - 1] = result;
    else r.results.push(result);
    r.onresult({ resultIndex: r.results.length - 1, results: r.results });
    return true;
  };
  window.__say = (text) => push(text, true);
  window.__hear = (text) => push(text, false);
  // Chrome ending its own session mid-phrase, without finalizing it.
  window.__drop = () => {
    const r = window.__recognizer;
    if (!r || !r.onend) return false;
    r.onend();
    return true;
  };

  // The speaker: record what Lucent says, and "finish" after a moment.
  window.__spoken = [];
  class Utterance {
    constructor(text) {
      this.text = text;
      this.onend = null;
      this.onerror = null;
    }
  }
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    value: Utterance,
    configurable: true,
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      speaking: false,
      speak(u) {
        window.__spoken.push(u.text);
        setTimeout(() => u.onend?.(), 400);
      },
      cancel() {},
      getVoices: () => [],
    },
  });
});

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function waitFor(fn, timeout = 15000, every = 200) {
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

// A deployment with server voice (Deepgram) speaks through /api/tts/speak
// first. This check is about the conversation, not the vendor: answer 503
// ("no server voice") so the answer falls through to the recording speaker.
await page.route("**/api/tts/speak", (route) =>
  route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "unconfigured" }),
  }),
);

// What the canvas sends to the model, turn by turn.
const sent = [];
page.on("request", (req) => {
  if (!/\/api\/generate(\/stream)?$/.test(new URL(req.url()).pathname)) return;
  try {
    sent.push(JSON.parse(req.postData() ?? "{}").message);
  } catch {
    /* not JSON */
  }
});

await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Vera Voice");
await page.locator('input[type="email"]').first().fill(`voice_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("voice-check-123");
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

// The pill's status line on a board; on the empty first screen, the hero's chip.
const phase = async () => {
  const line = page.locator(".voice-phase");
  if (await line.count()) return ((await line.first().textContent()) ?? "").trim();
  const chip = page.locator(".hero-chip[aria-pressed='true']");
  if (await chip.count()) return ((await chip.first().textContent()) ?? "").trim();
  return "";
};
const spoken = () => page.evaluate(() => window.__spoken.slice());
const listeningAgain = (before) =>
  waitFor(async () => {
    const n = await page.evaluate(() => window.__recognizers);
    return n > before && (await phase()).startsWith("Listening");
  });

// --- one tap starts a conversation --------------------------------------------------
await page.getByRole("button", { name: "Talk with Lucent" }).first().click();
check(
  "one tap on the mic starts listening",
  await waitFor(async () => (await phase()).startsWith("Listening")),
  await phase(),
);
check(
  "the mic now reads as a conversation in progress",
  (await page.getByRole("button", { name: "End the voice conversation" }).count()) > 0,
);

// --- turn 1: a pause ends the turn; Lucent answers out loud, then listens -------------
let recognizers = await page.evaluate(() => window.__recognizers);
await waitFor(() => page.evaluate(() => window.__say("build a login flow")));
check(
  "a pause after speaking sends the turn by itself",
  await waitFor(() => sent.includes("build a login flow"), 8000),
  JSON.stringify(sent),
);
const firstReply = await waitFor(async () => (await spoken())[0], 15000);
check(
  "Lucent answers out loud",
  typeof firstReply === "string" && firstReply.length > 0,
  firstReply,
);
check(
  "and talks with the person — a question back, not the change list",
  /\?$/.test(firstReply ?? "") && !/^(Created|Added|Built)\b/.test(firstReply ?? ""),
  firstReply,
);
check("then listens again without a tap", await listeningAgain(recognizers), await phase());

// --- turn 2: a phrase never finalized, split by the recognizer's own restart ----------
recognizers = await page.evaluate(() => window.__recognizers);
await page.evaluate(() => window.__hear("so the first thing we need"));
await page.waitForTimeout(300);
await page.evaluate(() => window.__drop());
await waitFor(async () => (await page.evaluate(() => window.__recognizers)) > recognizers, 4000);
await page.evaluate(() => window.__hear("is a password reset"));
await page.waitForTimeout(300);
await page.evaluate(() => window.__drop());
const whole = "so the first thing we need is a password reset";
check(
  "words the recognizer never finalized still arrive whole, across its restart",
  await waitFor(() => sent.includes(whole), 10000),
  JSON.stringify(sent.slice(-1)),
);
check(
  "and Lucent answers that turn too",
  await waitFor(async () => (await spoken()).length >= 2, 15000),
  (await spoken()).at(-1),
);

// --- "that's all" ends it ---------------------------------------------------------------
recognizers = await page.evaluate(() => window.__recognizers);
await listeningAgain(recognizers - 1);
const beforeEnd = sent.length;
await waitFor(() => page.evaluate(() => window.__say("that's all, thanks")));
check(
  '"that\'s all" ends the conversation',
  await waitFor(
    async () => (await page.getByRole("button", { name: "Talk with Lucent" }).count()) > 0,
    8000,
  ),
);
check("and isn't sent to the model as a request", sent.length === beforeEnd, JSON.stringify(sent));
check(
  "Lucent says goodbye",
  await waitFor(async () => /here when you need me/i.test((await spoken()).at(-1) ?? "")),
  (await spoken()).at(-1),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
