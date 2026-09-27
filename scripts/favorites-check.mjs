/**
 * Favorites and the activity feed, end to end (docs/26 A6): "what I star
 * leads Home, and Home tells me what my team changed." Against the running
 * app (localhost:5173 → API :4387):
 *
 *   an owner shares a board with a teammate, who edits it → the owner stars
 *   the board from the dashboard and a project from its page → Home lists
 *   both under Starred, and the teammate's edit under "From your team" →
 *   the feed row opens the board, the starred row opens the project →
 *   unstarring takes it off Home.
 *
 *   node scripts/favorites-check.mjs
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
  await page.locator('input[type="password"]').first().fill("favorites-check-123");
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
const owner = await person("Frida Fave", `frida_${stamp}@example.com`);
const edEmail = `eddie_${stamp}@example.com`;
const ed = await person("Eddie Editor", edEmail);
const me = await owner.api("/api/auth/me");
const orgId = `org_personal_${me.body.user.id}`;

// --- a shared board the teammate edits ------------------------------------------------------
const pricing = (
  await owner.api("/api/boards", {
    method: "POST",
    body: JSON.stringify({ name: "Pricing", orgId }),
  })
).body.id;
await owner.api("/api/boards", {
  method: "POST",
  body: JSON.stringify({ name: "Roadmap", orgId }),
});
await owner.api(`/api/boards/${pricing}/members`, {
  method: "POST",
  body: JSON.stringify({ email: edEmail, role: "editor" }),
});
const edit = await ed.api(`/api/boards/${pricing}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "Priced the annual plan",
    ops: [{ op: "CREATE_NODE", id: "annual", nodeType: "process", label: "Annual: $96" }],
  }),
});
check("the teammate can edit the shared board", edit.status === 200, `status ${edit.status}`);

// --- star from the dashboard and from a project's page ---------------------------------------
const page = owner.page;
await page.bringToFront();
await page.goto(`${base}/?view=dashboard`, { waitUntil: "networkidle" });
const star = page.getByRole("button", { name: "Star Pricing" });
await star.waitFor({ timeout: 15000 });
await star.click({ force: true });
const pressed = await waitFor(async () =>
  (await page.getByRole("button", { name: "Unstar Pricing" }).getAttribute("aria-pressed")) ===
  "true"
    ? true
    : null,
);
check("the dashboard card stars the board", pressed);
if (shots) await page.screenshot({ path: `${shots}/dashboard-star.png` });

const project = await owner.api(`/api/orgs/${orgId}/projects`, {
  method: "POST",
  body: JSON.stringify({ name: "Annual plans launch", boardIds: [pricing] }),
});
await page.goto(`${base}/?view=projects&project=${project.body.id}`, { waitUntil: "networkidle" });
const projectStar = page.getByRole("button", { name: "Star", exact: true });
await projectStar.waitFor({ timeout: 15000 });
await projectStar.click();
const projectPressed = await waitFor(async () =>
  (await page.getByRole("button", { name: "Starred", exact: true }).count()) > 0 ? true : null,
);
const favorites = await owner.api("/api/me/favorites");
check(
  "the project page stars the project",
  projectPressed && favorites.body.favorites?.length === 2,
  JSON.stringify(favorites.body.favorites?.map((f) => [f.kind, f.name])),
);

// --- Home: Starred, and what the team changed ------------------------------------------------
await page.goto(`${base}/?view=home`, { waitUntil: "networkidle" });
const starredRows = await waitFor(async () => {
  const rows = await page
    .locator(".home-board")
    .filter({ has: page.locator(".home-star") })
    .allTextContents();
  return rows.length === 2 ? rows : null;
});
check(
  "Home lists what you starred, newest first",
  starredRows && /Annual plans launch/.test(starredRows[0]) && /Pricing/.test(starredRows[1]),
  JSON.stringify(starredRows),
);
const feedRow = page.locator(".home-activity-row").filter({ hasText: "Priced the annual plan" });
const feedText = await waitFor(async () =>
  (await feedRow.count()) > 0 ? await feedRow.first().textContent() : null,
);
check(
  "Home's feed shows who changed what, and where",
  feedText && /Eddie Editor/.test(feedText) && /★ Pricing/.test(feedText),
  feedText ?? "",
);
if (shots) await page.screenshot({ path: `${shots}/home-starred-activity.png`, fullPage: true });

// Opening a board by id doesn't put it in the URL; the canvas shows it.
await feedRow.first().click();
const onBoard = await waitFor(async () =>
  /view=canvas/.test(page.url()) && (await page.getByText("Annual: $96").count()) > 0 ? true : null,
);
check("the feed row opens the board, with the teammate's change on it", onBoard, page.url());

await page.goto(`${base}/?view=home`, { waitUntil: "networkidle" });
const projectRow = page.locator(".home-board").filter({ hasText: "Annual plans launch" }).first();
await projectRow.waitFor({ timeout: 15000 });
await projectRow.click();
const onProject = await waitFor(async () =>
  /view=projects/.test(page.url()) &&
  (await page.getByRole("heading", { name: "Annual plans launch" }).count()) > 0
    ? true
    : null,
);
check("a starred project opens its page", onProject, page.url());

// --- unstar ------------------------------------------------------------------------------------
await page.goto(`${base}/?view=dashboard`, { waitUntil: "networkidle" });
const unstar = page.getByRole("button", { name: "Unstar Pricing" });
await unstar.waitFor({ timeout: 15000 });
await unstar.click({ force: true });
await waitFor(async () =>
  (await page.getByRole("button", { name: "Star Pricing" }).count()) > 0 ? true : null,
);
await page.goto(`${base}/?view=home`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const starredNames = await page
  .locator(".home-board")
  .filter({ has: page.locator(".home-star") })
  .allTextContents();
check(
  "unstarring takes it off Home",
  starredNames.length === 1 && /Annual plans launch/.test(starredNames[0]),
  JSON.stringify(starredNames),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
