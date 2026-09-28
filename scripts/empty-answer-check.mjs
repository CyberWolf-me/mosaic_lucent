/**
 * A generation from the launch screen that draws nothing must say so, not
 * quietly drop back to the start with the request gone. Two answers a model
 * gives (the gateway's is faked, so this runs in seconds):
 *
 *   - nothing at all: "That didn't work", and Try again puts the prompt back;
 *   - a question instead of a diagram: the question, to answer in the box.
 *
 * Against the running app (localhost:5173 → API :4387).
 *
 *   node scripts/empty-answer-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const PROMPT = "A flowchart for user signup with email verification";

async function attempt(label, done) {
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.route("**/api/generate/stream", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        'event: start\ndata: {"provider":"gateway","streaming":true}\n\n' +
        'event: phase\ndata: {"phase":"understanding"}\n\n' +
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
    });
  });
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill("Eve Empty");
  await page
    .locator('input[type="email"]')
    .first()
    .fill(`empty_${label}_${Date.now()}@example.com`);
  await page.locator('input[type="password"]').first().fill("empty-answer-123");
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
  const box = page.locator("#empty-state-prompt");
  await box.fill(PROMPT);
  await page.keyboard.press("Enter");
  const notice = page.locator(".hero-failure");
  await notice.waitFor({ timeout: 15000 }).catch(() => {});
  return { page, box, notice };
}

// --- the model returned nothing at all -------------------------------------------------------
{
  const { page, box, notice } = await attempt("nothing", {
    operations: [],
    explanation: null,
    reply: null,
    provider: "gateway",
  });
  const text = (await notice.textContent().catch(() => "")) ?? "";
  check(
    "an answer with nothing in it says so on the launch screen",
    /That didn't work/.test(text) && /drew nothing/.test(text),
    text.replace(/\s+/g, " ").trim().slice(0, 140),
  );
  if (shots) await page.screenshot({ path: `${shots}/empty-answer-nothing.png` });
  await page.getByRole("button", { name: "Try again" }).click();
  check("Try again puts the request back in the box", (await box.inputValue()) === PROMPT);
  await page.context().close();
}

// --- the model asked a question instead ------------------------------------------------------
{
  const question = "Should signup also collect a phone number, or email only?";
  const { page, notice } = await attempt("question", {
    operations: [],
    explanation: "Asked which fields signup collects.",
    reply: question,
    provider: "gateway",
  });
  const text = (await notice.textContent().catch(() => "")) ?? "";
  check(
    "a reply in words instead of a diagram is shown, to write back to",
    /Lucent replied/.test(text) && text.includes(question),
    text.replace(/\s+/g, " ").trim().slice(0, 140),
  );
  if (shots) await page.screenshot({ path: `${shots}/empty-answer-question.png` });
  await page.context().close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
