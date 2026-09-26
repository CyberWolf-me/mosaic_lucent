/**
 * Headed voice-loop verification (docs/26 §7).
 *
 * Drives the REAL conversational-lease manager through cases A–E against the
 * running app (localhost:5173) and asserts the voice-state HUD reflects each
 * transition. Deterministic: it steps the lease via the debug hook exposed
 * behind ?voicehud=1 — no microphone, no AI call. Run headed to WATCH the HUD:
 *
 *   node scripts/voice-hud-check.mjs            # headless (CI-style assertions)
 *   HEADED=1 node scripts/voice-hud-check.mjs   # visible Chromium, slow, to watch
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";

const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 700 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// --- sign up + reach the meeting view with the HUD + debug hook ---
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Voice Diag");
await page.locator('input[type="email"]').first().fill(`voice_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("voice-diag-123");
await page.getByRole("button", { name: /create account/i }).click();
await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
for (let i = 0; i < 5; i++) {
  const s = page.getByRole("button", { name: /^Skip$/ });
  if (await s.count()) { await s.first().click({ force: true }).catch(() => {}); await page.waitForTimeout(300); }
  else break;
}
await page.goto(base + "/?view=meeting&voicehud=1", { waitUntil: "networkidle", timeout: 20000 });
await page.waitForFunction(() => !!window.__lucentVoiceDebug, { timeout: 10000 });

const macro = () => page.getAttribute(".voice-hud", "data-macro");
const drive = (fn, ...args) => page.evaluate(([f, a]) => window.__lucentVoiceDebug[f](...a), [fn, args]);
const state = () => page.evaluate(() => window.__lucentVoiceDebug.state());

await drive("setRecording", true);
await page.waitForTimeout(200);
check("recording → LISTENING", (await macro()) === "LISTENING");

// --- Case A: normal turn (invocation → answer → back to listening) ---
const a1 = await drive("evaluate", "alice", "Lucent, summarize the pricing decision");
check("A: invocation is heard (not ignored)", a1.action === "direct_invoke", `action=${a1.action}`);
await drive("aiStart");
await page.waitForTimeout(200);
check("A: while answering → SPEAKING", (await macro()) === "SPEAKING", `state=${await state()}`);
await drive("aiDone", "Pricing stays flat this quarter.");
await page.waitForTimeout(200);
check("A: after the answer → follow-up window open", (await state()) === "waiting_for_followup");
check("A: back to LISTENING", (await macro()) === "LISTENING");

// --- Case B: immediate follow-up, same speaker, NO re-wake ---
const b1 = await drive("evaluate", "alice", "And what about PostgreSQL?");
check("B: same-speaker follow-up answered without 'Lucent'", b1.action === "followup_query", `action=${b1.action}`);

// --- Case C: barge-in halts the answer ---
await drive("aiStart");
await page.waitForTimeout(150);
const c1 = await drive("bargeIn", "alice", "No, stop");
check("C: barge-in interrupts TTS", c1.interrupted === true);

// --- Case D: silence → lease window expires → dormant ---
// Re-open a window, then let the next turn arrive 20s later (> 15s lease).
await drive("aiDone", "Okay.");
const future = Date.now() + 20_000;
const d1 = await drive("evaluate", "alice", "Are you still there?", future);
check("D: a turn after the window expires → dormant, ignored", d1.action === "ignore" || d1.action === "dismiss", `action=${d1.action}`);
check("D: lease is dormant", (await state()) === "dormant");

// --- Case E: ordinary human conversation → Lucent stays silent ---
const e1 = await drive("evaluate", "bob", "I think we should keep PostgreSQL");
check("E: ordinary talk is not an invocation (ignored)", e1.action === "ignore", `action=${e1.action}`);
check("E: still LISTENING, lease still dormant", (await macro()) === "LISTENING" && (await state()) === "dormant");

if (headed) { console.log("\n(headed) leaving the window open 6s to watch…"); await page.waitForTimeout(6000); }
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
