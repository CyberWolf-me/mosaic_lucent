/**
 * Importing a transcript, end to end (docs/28 S12): "a meeting held in Zoom
 * or Teams becomes a Lucent meeting on the board." Against the running app
 * (localhost:5173 → API :4387, LUCENT_AI_PROVIDER=mock):
 *
 *   the meeting view's Import → a Teams .vtt chosen → the preview names the
 *   tool, the lines and the speakers before anything is sent → Import → the
 *   meeting opens, named from the file, both speakers as the file named them
 *   → its summary is written → a paste the parser can't read says so, and an
 *   Otter export pasted in previews its speakers.
 *
 *   node scripts/meeting-import-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

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
const api = (path) =>
  page.evaluate(async (p) => {
    const res = await fetch(p);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }, path);

await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Ivy Import");
await page.locator('input[type="email"]').first().fill(`import_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("import-check-123");
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
await page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });

// --- a Teams export -------------------------------------------------------------------------
const teams = [
  "WEBVTT",
  "",
  "a1-1",
  "00:00:01.200 --> 00:00:03.900",
  "<v Ada Lovelace>We go annual next quarter.</v>",
  "",
  "a1-2",
  "00:00:04.000 --> 00:00:05.500",
  "<v Ada Lovelace>We decided to keep the free tier.</v>",
  "",
  "a1-3",
  "00:00:06.000 --> 00:00:08.000",
  "<v Bo Chen>I'll update the pricing page by Friday.</v>",
].join("\n");
await page
  .getByRole("button", { name: /^Import( a transcript)?$/ })
  .first()
  .click();
await page.getByLabel("Transcript file").setInputFiles({
  name: "Pricing review.vtt",
  mimeType: "text/vtt",
  buffer: Buffer.from(teams),
});
const summary = await waitFor(async () => page.locator(".import-summary").textContent());
const speakers = await page.getByRole("list", { name: "Speakers" }).locator("li").allTextContents();
check(
  "the preview names the tool, the lines and the speakers before anything is sent",
  /Looks like a Microsoft Teams transcript · 2 lines · 2 speakers/.test(summary ?? "") &&
    speakers.join(",") === "Ada Lovelace,Bo Chen",
  summary,
);
check(
  "the title comes from the file",
  (await page.getByLabel("Title").inputValue()) === "Pricing review",
);
if (shots) await page.screenshot({ path: `${shots}/import-preview.png` });
await page.getByRole("dialog").getByRole("button", { name: "Import", exact: true }).click();

const opened = await waitFor(async () => {
  const t = await page.locator("h1").first().textContent();
  return t && /Pricing review/.test(t) ? t : null;
});
const list = await api(`/api/boards/${boardId}/meetings`);
const meeting = (list.body.meetings ?? list.body ?? []).find?.((m) => m.title === "Pricing review");
check(
  "Import opens the meeting, named, with both speakers as the file named them",
  opened &&
    meeting?.endedAt &&
    meeting.turns.map((t) => t.speaker).join(",") === "Ada Lovelace,Bo Chen",
  JSON.stringify(meeting?.turns?.map((t) => [t.speaker, t.text])),
);
const recap = await waitFor(async () => {
  const one = await api(`/api/boards/${boardId}/meetings/${meeting?.id}`);
  return one.body.recap ? one.body.recap : null;
}, 30000);
check("its summary is written, as for a meeting Lucent recorded", recap);
if (shots) await page.screenshot({ path: `${shots}/import-done.png`, fullPage: true });

// --- pasted text -------------------------------------------------------------------------------------
await page
  .getByRole("button", { name: /^Import( a transcript)?$/ })
  .first()
  .click();
await page.getByText("Or paste it").click();
await page.getByLabel("Transcript text").fill("WEBVTT\n\nNOTE nothing was said");
await waitFor(async () => (await page.getByRole("dialog").getByRole("alert").count()) > 0);
const refused = await page.getByRole("dialog").getByRole("alert").first().textContent();
check(
  "a paste it can't read says so, and can't be imported",
  /couldn't find anything said/.test(refused ?? "") &&
    (await page
      .getByRole("dialog")
      .getByRole("button", { name: "Import", exact: true })
      .isDisabled()),
  refused,
);
await page
  .getByLabel("Transcript text")
  .fill("Ada Lovelace  0:03\nWe go annual.\n\nBo Chen  0:41\nAgreed.");
const otter = await waitFor(async () => page.locator(".import-summary").textContent());
check(
  "an Otter export pasted in previews its speakers",
  /Otter transcript · 2 lines · 2 speakers/.test(otter ?? ""),
  otter,
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
