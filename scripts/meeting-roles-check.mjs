/**
 * Meeting permissions check (docs/28 §6, F19).
 *
 * Two real accounts against the running app (localhost:5173 → API :4387):
 * an owner publishes a board and adds a second account as a VIEWER; the
 * viewer opens the meeting view. A viewer's capture could never be saved
 * (the server refuses it), so the recording controls must be disabled up
 * front, with the reason on screen — not discovered at Stop.
 *
 *   node scripts/meeting-roles-check.mjs            # headless
 *   HEADED=1 node scripts/meeting-roles-check.mjs   # watch it
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 300 : 0 });

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function account(label) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${label} pageerror]`, e.message));
  const email = `${label}_${Date.now()}@example.com`;
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill(label);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill("roles-check-123");
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
  return { ctx, page, email };
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

const owner = await account("owner");
await owner.page.getByRole("button", { name: "Share board" }).click();
await owner.page.getByRole("button", { name: /publish & start collaborating/i }).click();
await owner.page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(owner.page.url()).searchParams.get("board");
check("owner published a board", !!boardId, boardId ?? "");

// Sharing needs a verified email. The dev server's console mailer logs the
// link; SERVER_LOG points at that log.
const log = process.env.SERVER_LOG ? readFileSync(process.env.SERVER_LOG, "utf8") : "";
const verify = log.match(
  new RegExp(`to=${owner.email.replace(/[.+]/g, "\\$&")}[^\\n]*?(/verify\\?token=[\\w-]+)`),
)?.[1];
if (!verify)
  throw new Error("no verification link for the owner — set SERVER_LOG to the API server's log");
await owner.page.goto(base + verify, { waitUntil: "networkidle" });
const link = await post(owner.page, `/api/boards/${boardId}/share`, { role: "viewer" });
check("owner minted a viewer link", link.status < 300 && !!link.body.token, `${link.status}`);

const viewer = await account("viewer");
await viewer.page.goto(`${base}/?board=${boardId}&invite=${link.body.token}`, {
  waitUntil: "networkidle",
});
await viewer.page.waitForTimeout(1500);
await viewer.page.evaluate(() => {
  window.history.pushState(
    null,
    "",
    `${window.location.pathname}${window.location.search}`.replace(/view=[a-z]+/, "") +
      "&view=meeting",
  );
  window.dispatchEvent(new PopStateEvent("popstate"));
});
await viewer.page.waitForTimeout(1500);
const start = viewer.page.getByRole("button", { name: /start recording|new recording/i }).first();
check("the viewer's record button is disabled", await start.isDisabled());
const body = await viewer.page.locator("body").innerText();
check(
  "the viewer is told why, up front",
  body.includes("only editors record, save or extract meetings"),
);

await owner.page.goto(`${base}/?view=meeting&board=${boardId}`, { waitUntil: "networkidle" });
await owner.page.waitForTimeout(800);
check(
  "the owner's record button is enabled",
  !(await owner.page
    .getByRole("button", { name: /start recording|new recording/i })
    .first()
    .isDisabled()),
);

if (headed) await viewer.page.waitForTimeout(4000);
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
