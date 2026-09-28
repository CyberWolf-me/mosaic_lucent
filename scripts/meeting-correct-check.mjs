/**
 * Correcting your own words (docs/28 §9.4): "the speaker, plus board
 * editors, may correct a transcript line; every correction shows who made
 * it." Against the running app (localhost:5173 → API :4387), two people:
 *
 *   a meeting with a line from each → the viewer can correct only their own
 *   line → the corrected line reads "edited by" them, for the owner too.
 *
 *   node scripts/meeting-correct-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });

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
async function person(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror ${name}]`, e.message));
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill(name);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill("correct-check-123");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const api = (path, init = {}) =>
    page.evaluate(
      async ([p, i]) => {
        const csrf = await (await fetch("/api/auth/csrf")).json();
        const res = await fetch(p, {
          ...i,
          headers: { "content-type": "application/json", "x-csrf-token": csrf.token },
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      },
      [path, init],
    );
  return { page, api };
}

const stamp = Date.now();
const owner = await person("Olga Owner", `olga_${stamp}@example.com`);
const viEmail = `vi_${stamp}@example.com`;
const vi = await person("Vi Viewer", viEmail);
const ownerId = (await owner.api("/api/auth/me")).body.user.id;
const viId = (await vi.api("/api/auth/me")).body.user.id;
const orgId = `org_personal_${ownerId}`;
const boardId = (
  await owner.api("/api/boards", { method: "POST", body: JSON.stringify({ name: "Sync", orgId }) })
).body.id;
await owner.api(`/api/boards/${boardId}/members`, {
  method: "POST",
  body: JSON.stringify({ email: viEmail, role: "viewer" }),
});
const started = Date.now() - 3_600_000;
const meetingId = (
  await owner.api(`/api/boards/${boardId}/meetings`, {
    method: "POST",
    body: JSON.stringify({
      startedAt: started,
      endedAt: started + 600_000,
      turns: [
        {
          speaker: "Olga Owner",
          speakerId: ownerId,
          at: started + 1000,
          text: "Let's ship Friday.",
        },
        { speaker: "Vi Viewer", speakerId: viId, at: started + 2000, text: "The docs are reddy." },
      ],
    }),
  })
).body.id;

const page = vi.page;
await page.bringToFront();
await page.goto(`${base}/?view=meeting&board=${boardId}&meeting=${meetingId}`, {
  waitUntil: "networkidle",
});
const edits = await waitFor(async () => {
  const n = await page.getByRole("button", { name: /^Correct turn \d+$/ }).count();
  return n > 0 ? n : null;
});
const mine = page.getByRole("button", { name: "Correct turn 2" });
check(
  "a viewer can correct only their own line",
  edits === 1 && (await mine.count()) === 1,
  `${edits} edit button(s)`,
);
await mine.click();
await page.getByLabel("Correct turn 2").fill("The docs are ready.");
await page.getByRole("button", { name: "Save" }).click();
const fixed = await waitFor(async () => {
  const t = await page.locator(".meet-turn-edited").first().textContent();
  return t && /edited by Vi Viewer/.test(t) ? t : null;
});
check("their correction reads as theirs", fixed, fixed);

await owner.page.bringToFront();
await owner.page.goto(`${base}/?view=meeting&board=${boardId}&meeting=${meetingId}`, {
  waitUntil: "networkidle",
});
const seen = await waitFor(async () => {
  const text = (await owner.page.locator(".meet-turn-text").allTextContents()).join(" | ");
  return /The docs are ready\. · edited by Vi Viewer/.test(text) ? text : null;
});
check("the owner sees the corrected line and who corrected it", seen, seen ?? "");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
