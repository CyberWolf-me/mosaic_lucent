/**
 * Teams, end to end (docs/26 A6): "the design team edits the design board,
 * and leaving the team ends it." Against the running app (localhost:5173 →
 * API :4387, started with LUCENT_DEV_PLAN=team so a workspace can invite;
 * API_LOG=<the API's output> is the dev mailbox the invite link comes from):
 *
 *   a teammate joins as a viewer → Admin: the owner creates "Design" and adds
 *   them → the Share dialog gives Design "Can edit" → the teammate can edit
 *   the board → removed from the team in Admin, they're a viewer again.
 *
 *   API_LOG=path/to/api.log node scripts/teams-check.mjs
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

async function person(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror ${name}]`, e.message));
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill(name);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill("teams-check-123");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  for (let i = 0; i < 5; i++) {
    const s = page.getByRole("button", { name: /^Skip$/ });
    if (!(await s.count())) break;
    await s
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(300);
  }
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

function mailedLink(email, pattern) {
  const lines = readFileSync(apiLog, "utf8")
    .split("\n")
    .filter((l) => l.includes(`to=${email}`));
  for (const line of lines.reverse()) {
    const listed = line.match(/ urls=(\[.*?\])/);
    const urls = listed ? JSON.parse(listed[1]) : [];
    const url = urls.find((u) => pattern.test(u) && !u.endsWith("…"));
    if (url) return url;
  }
  return null;
}

const stamp = Date.now();
const owner = await person("Tara Owner", `tara_${stamp}@example.com`);
const mateEmail = `dev_${stamp}@example.com`;
const orgId = `org_personal_${(await owner.api("/api/auth/me")).body.user.id}`;
await owner.api(`/api/orgs/${orgId}/invites`, {
  method: "POST",
  body: JSON.stringify({ email: mateEmail, role: "viewer" }),
});
const mate = await person("Dev Designer", mateEmail);
const link = await waitFor(() => mailedLink(mateEmail, /\/invite\?token=/));
const joined = await mate.api("/api/invites/accept", {
  method: "POST",
  body: JSON.stringify({ token: new URL(link).searchParams.get("token") }),
});
check("a teammate joins as a viewer", joined.status === 200, `status ${joined.status}`);

// --- the board ------------------------------------------------------------------------
const page = owner.page;
await page.bringToFront();
await page.getByRole("button", { name: "Share board" }).click({ force: true });
await page.getByRole("button", { name: /publish & start collaborating/i }).click();
await page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(page.url()).searchParams.get("board");
await page.keyboard.press("Escape");
const roleOf = async () => (await mate.api(`/api/boards/${boardId}/members`)).body.role;
check("on the board they're a viewer", (await roleOf()) === "viewer");

// --- Admin: the Design team ------------------------------------------------------------
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const newTeam = page.getByRole("form", { name: "New team" });
await newTeam.waitFor({ timeout: 15000 });
await newTeam.getByLabel("Team name").fill("Design");
await newTeam.getByRole("button", { name: "Create team" }).click();
const teamRow = page
  .getByRole("list", { name: "Teams" })
  .locator(".team-row")
  .filter({ hasText: "Design" });
await teamRow.waitFor({ timeout: 10000 });
await teamRow.getByLabel("Add someone to Design").selectOption({ label: "Dev Designer" });
const added = await waitFor(async () =>
  (await teamRow.locator(".team-member").filter({ hasText: "Dev Designer" }).count()) > 0
    ? true
    : null,
);
if (shots) await page.screenshot({ path: `${shots}/admin-teams.png`, fullPage: true });
check("Admin creates Design and adds them", added);

// --- the Share dialog gives the team the board -------------------------------------------
await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Share board" }).click({ force: true });
const teams = page.locator('[aria-label="Teams with access"]');
await teams.waitFor({ timeout: 15000 });
await teams.getByLabel("Team", { exact: true }).selectOption({ label: "Design" });
await teams.getByLabel("What the team can do").selectOption("editor");
await teams.getByRole("button", { name: "Add" }).click();
const listed = await waitFor(async () =>
  (await teams.locator(".share-team-row").filter({ hasText: "Design" }).count()) > 0 ? true : null,
);
if (shots) await page.screenshot({ path: `${shots}/share-teams.png` });
check("the Share dialog gives Design “Can edit”", listed);
const editor = await waitFor(async () => ((await roleOf()) === "editor" ? true : null));
check("and the teammate can now edit the board", editor);

// --- leaving the team ends it ------------------------------------------------------------
await page.keyboard.press("Escape");
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const row = page
  .getByRole("list", { name: "Teams" })
  .locator(".team-row")
  .filter({ hasText: "Design" });
await row.getByRole("button", { name: "Remove Dev Designer from Design" }).click();
const back = await waitFor(async () => ((await roleOf()) === "viewer" ? true : null));
check("removed from the team, they're a viewer again", back);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
