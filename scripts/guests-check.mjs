/**
 * A client guest, end to end (docs/26 A6): "an owner shares one board with
 * someone outside the workspace; they find it and nothing else, and the
 * owner can see and end it." Against the running app (localhost:5173 → API
 * :4387):
 *
 *   the owner shares a board by email → the Share dialog marks the client
 *   as a Guest → the client finds it under "Shared with me" and opens it →
 *   the workspace itself stays closed to them → Admin → Guests lists them
 *   with the board → End access → the board is closed to them.
 *
 *   node scripts/guests-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
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
  await page.locator('input[type="password"]').first().fill("guests-check-123");
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

const stamp = Date.now();
const owner = await person("Oona Owner", `oona_${stamp}@example.com`);
const clientEmail = `cleo_${stamp}@client.example`;
const client = await person("Cleo Client", clientEmail);

// --- the owner shares a board by email ------------------------------------------------
const page = owner.page;
await page.bringToFront();
await page.getByRole("button", { name: "Share board" }).click({ force: true });
await page.getByRole("button", { name: /publish & start collaborating/i }).click();
await page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(page.url()).searchParams.get("board");
// Publishing leaves the Share dialog open, now with the owner's controls.
// (The owner's controls appear once the room confirms the role.)
const form = page.getByRole("form", { name: "Share by email" });
await form.waitFor({ timeout: 10000 });
await form.getByLabel("Email address").fill(clientEmail);
await form.getByLabel("What they can do").selectOption("commenter");
await form.getByRole("button", { name: "Share" }).click();
const note = await waitFor(async () => {
  const t = await form.getByRole("status").textContent();
  return t && /as a guest/.test(t) ? t : null;
});
check("sharing by email with an outsider says they'll be a guest", note, note);
const chip = await waitFor(async () =>
  (await page.locator(".share-guest-chip").count()) > 0 ? true : null,
);
if (shots) await page.screenshot({ path: `${shots}/share-guest.png` });
check("the Share dialog marks them as a Guest", chip);
await page.keyboard.press("Escape");

// --- the client finds it, and only it -------------------------------------------------
await client.page.goto(`${base}/?view=dashboard`, { waitUntil: "networkidle" });
const card = await waitFor(async () => {
  const hit = client.page.getByText("Untitled workspace").first();
  return (await hit.count()) > 0 ? hit : null;
});
const shared = await client.api("/api/boards/shared-with-me");
check(
  "the client finds the board under what's shared with them",
  card && shared.body.boards?.some((b) => b.id === boardId && b.role === "commenter"),
  JSON.stringify(shared.body.boards?.map((b) => [b.name, b.orgName, b.role])),
);
const opened = await client.api(`/api/boards/${boardId}`);
const workspace = await client.api(
  `/api/orgs/org_personal_${(await owner.api("/api/auth/me")).body.user.id}`,
);
check(
  "they can open the board, and the workspace stays closed",
  opened.status === 200 && workspace.status === 404,
  `board ${opened.status} · workspace ${workspace.status}`,
);

// --- the owner sees the guest and ends it ---------------------------------------------
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const guests = page.getByRole("list", { name: "Guests" });
await guests.waitFor({ timeout: 15000 });
const row = guests.locator(".guest-row").filter({ hasText: "Cleo Client" });
check(
  "Admin → Guests lists them with the board",
  /Untitled workspace \(commenter\)/.test((await row.textContent()) ?? ""),
  (await row.textContent()) ?? "",
);
if (shots) await page.screenshot({ path: `${shots}/admin-guests.png`, fullPage: true });
await row.getByRole("button", { name: "End access" }).click();
await waitFor(async () => (await guests.locator(".guest-row").count()) === 0 || null);
const after = await client.api(`/api/boards/${boardId}`);
check("ending it closes the board to them", after.status === 404, `status ${after.status}`);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
