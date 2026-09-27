/**
 * The Live call, for real (docs/25 V10): a person speaks, the LiveKit voice
 * agent hears them through Deepgram, changes the board through the governed
 * route, and talks back — a conversation, not a readout of the diff.
 *
 * Needs, all running: the app (localhost:5173 → API :4387) with LiveKit
 * configured, and the voice-agent worker (`npm run dev -w @lucent/voice-agent`)
 * with DEEPGRAM_API_KEY and an AI key, registered under the same
 * LUCENT_VOICE_AGENT_NAME the server dispatches by. The "microphone" is a
 * WAV file Chromium plays as its fake capture device:
 *
 *   AUDIO_FILE=/path/ask.wav node scripts/voice-agent-live-check.mjs
 *
 * The WAV should say something like "Please add a login page that leads to a
 * dashboard", followed by silence (Chromium loops the file).
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const audio = process.env.AUDIO_FILE;
if (!audio) throw new Error("set AUDIO_FILE to a WAV of someone asking for a change");
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({
  headless: !headed,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${audio}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ["microphone"],
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function waitFor(fn, timeout = 30000, every = 500) {
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

await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Liam Live");
await page.locator('input[type="email"]').first().fill(`live_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("live-check-123");
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
check("a shared board", !!boardId, boardId ?? "");
// The share dialog stays open; open the board fresh.
await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });

// Whatever the agent chose to build it with: diagram nodes, wireframe
// screens, or frames and notes.
const labels = async () => {
  const res = await page.request.get(`${base}/api/boards/${boardId}`);
  const ws = (await res.json()).workspace ?? {};
  return [
    ...Object.values(ws.nodes ?? {}).map((n) => String(n.label ?? "")),
    ...Object.values(ws.wireframes ?? {}).map((w) => String(w.title ?? "")),
    ...Object.values(ws.shapes ?? {}).map((s) => String(s.text ?? s.label ?? s.title ?? "")),
  ].filter(Boolean);
};
const before = (await labels()).length;

// --- call Lucent ------------------------------------------------------------------
await page
  .getByRole("button", { name: /live (voice )?call/i })
  .first()
  .click();
const transcript = page.getByLabel("Call transcript");
const heard = await waitFor(async () => {
  const text = (await transcript.textContent()) ?? "";
  return /You:.*login/i.test(text) ? text : null;
}, 60000);
check("the agent joins and hears the person (Deepgram)", heard, heard?.slice(0, 160));

const changed = await waitFor(async () => {
  const now = await labels();
  return now.length > before && now.some((l) => /login|dashboard/i.test(l)) ? now : null;
}, 60000);
check(
  "it changes the board through the governed route",
  changed,
  (changed ?? (await labels())).join(" · ") || "board is empty",
);

const said = await waitFor(async () => {
  const lines = await transcript.locator("p").allTextContents();
  const lucent = lines.filter((l) => l.startsWith("Lucent:"));
  return lucent.length > 0 ? lucent.join(" | ") : null;
}, 60000);
check("and talks back", said, said);
check(
  "a conversation, not a readout of the change list",
  said && !/\b(CREATE_NODE|CONNECT_NODES|operations?)\b/.test(said),
  said,
);

await page
  .getByRole("button", { name: /end call|hang up|leave/i })
  .first()
  .click()
  .catch(() => {});
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
