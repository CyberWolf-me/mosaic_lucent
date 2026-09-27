/**
 * Managing a workspace's people (docs/26 A6), end to end: "an owner changes
 * a teammate's role and removes them, and their access ends." Against the
 * running app (localhost:5173 → API :4387; the dev mailer logs to the API's
 * output, which this reads the invite link from — API_LOG=<that file>):
 *
 *   an owner invites a teammate → the teammate signs up and accepts →
 *   Admin lists them as Editor → the owner makes them Viewer (it sticks) →
 *   the owner removes them (a second click confirms) → their access to the
 *   workspace ends.
 *
 *   API_LOG=path/to/api.log node scripts/org-members-check.mjs
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const base = process.env.BASE_URL || "http://localhost:5173";
const apiLog = process.env.API_LOG;
if (!apiLog) {
  console.error("Set API_LOG to the API server's output file (the dev mailbox).");
  process.exit(2);
}
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });

const shots = process.env.SHOTS;
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

/** A person in their own browser. */
async function person(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror ${name}]`, e.message));
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill(name);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill("members-check-123");
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

/** The newest link the dev mailbox holds for this address. */
function mailedLink(email, pattern) {
  const lines = readFileSync(apiLog, "utf8")
    .split("\n")
    .filter((l) => l.includes(`to=${email}`));
  for (const line of lines.reverse()) {
    // The full links ride `urls=[…]`; the body preview may cut one short.
    const listed = line.match(/ urls=(\[.*?\])/);
    const urls = listed ? JSON.parse(listed[1]) : (line.match(/https?:\/\/[^\s"\\]+/g) ?? []);
    const url = urls.find((u) => pattern.test(u) && !u.endsWith("…"));
    if (url) return url;
  }
  return null;
}

const stamp = Date.now();
const owner = await person("Olga Owner", `olga_${stamp}@example.com`);
const teamEmail = `tom_${stamp}@example.com`;
const me = await owner.api("/api/auth/me");
const orgId = `org_personal_${me.body.user.id}`;
const invited = await owner.api(`/api/orgs/${orgId}/invites`, {
  method: "POST",
  body: JSON.stringify({ email: teamEmail, role: "editor" }),
});
check("the owner invites a teammate", invited.status < 300, `status ${invited.status}`);

const teammate = await person("Tom Teammate", teamEmail);
const link = await waitFor(() => mailedLink(teamEmail, /\/invite\?token=/));
const token = link ? new URL(link).searchParams.get("token") : null;
let accepted = await teammate.api("/api/invites/accept", {
  method: "POST",
  body: JSON.stringify({ token }),
});
if (accepted.status === 403) {
  // A verified address first, when the server asks for one.
  const verify = await waitFor(() => mailedLink(teamEmail, /\/verify\?token=/));
  if (verify) await teammate.page.goto(verify, { waitUntil: "networkidle" });
  accepted = await teammate.api("/api/invites/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}
check("the teammate accepts and joins", accepted.status < 300, `status ${accepted.status}`);

const page = owner.page;
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const row = page.locator("tr").filter({ hasText: "Tom Teammate" });
await row.waitFor({ timeout: 15000 });
const select = row.getByRole("combobox", { name: /Role for Tom Teammate/ });
check("Admin lists them as an editor", (await select.inputValue()) === "editor");
await select.selectOption("viewer");
await waitFor(async () => (await select.isEnabled()) && (await select.inputValue()) === "viewer");
await page.reload({ waitUntil: "networkidle" });
const again = page
  .locator("tr")
  .filter({ hasText: "Tom Teammate" })
  .getByRole("combobox", { name: /Role for Tom Teammate/ });
await again.waitFor({ timeout: 15000 });
check("making them a viewer sticks", (await again.inputValue()) === "viewer");
if (shots) await page.screenshot({ path: `${shots}/org-members.png`, fullPage: true });

const liveRow = page.locator("tr").filter({ hasText: "Tom Teammate" });
await liveRow.getByRole("button", { name: "Remove", exact: true }).click();
await liveRow.getByRole("button", { name: /Remove Tom Teammate/ }).click();
const gone = await waitFor(
  async () => (await page.locator("tr").filter({ hasText: "Tom Teammate" }).count()) === 0,
);
check("removing them takes a second click, then they're gone", gone);
const after = await teammate.api(`/api/orgs/${orgId}`);
check("and their access to the workspace ends", after.status === 404, `status ${after.status}`);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
