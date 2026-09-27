/**
 * The workspace spine, end to end (docs/26 A1, ADR 0046): "a user sees every
 * decision, meeting and open question across boards." Against the running
 * app (localhost:5173 → API :4387):
 *
 *   two shared boards, each holding statements → a project gathering one of
 *   them (created in the UI) → its page counts and lists that board's
 *   statements only → a statement opens on its board → Home names the
 *   project and counts the board it never loaded → Intelligence, workspace
 *   scope, lists both boards' statements; "assigned to me" narrows it.
 *
 *   node scripts/workspace-spine-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

// SHOTS=<dir> saves a screenshot of each screen, for a look at the layout.
const shots = process.env.SHOTS;
const shot = async (name) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
};

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

/** A same-origin API call from the page, with the session and a CSRF token. */
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

// --- someone, with two shared boards full of statements -------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Sana Spine");
const email = `spine_${Date.now()}@example.com`;
await page.locator('input[type="email"]').first().fill(email);
await page.locator('input[type="password"]').first().fill("spine-check-123");
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
const pricing = new URL(page.url()).searchParams.get("board");
await page.goto(`${base}/?view=canvas&board=${pricing}`, { waitUntil: "networkidle" });

const stmt = (id, kind, label, extra = []) => [
  { op: "CREATE_NODE", id, nodeType: "process", label },
  { op: "SET_STATEMENT", id, statement: { kind, status: "open" } },
  ...extra,
];
await api(`/api/boards/${pricing}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [
      ...stmt("tier-q", "question", "Do we grandfather existing customers?"),
      ...stmt("annual", "decision", "Offer annual plans"),
    ],
  }),
});
const first = await api(`/api/boards/${pricing}`);
const created = await api("/api/boards", {
  method: "POST",
  body: JSON.stringify({
    name: "Launch",
    workspace: { ...first.body.workspace, nodes: {}, edges: {} },
  }),
});
const launch = created.body.id;
await api(`/api/boards/${launch}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: stmt("announce", "action", "Write the announcement", [
      {
        op: "SET_ISSUE",
        id: "announce",
        issue: { type: "task", status: "open", assignee: "Sana Spine" },
      },
    ]),
  }),
});
check("two shared boards, each holding statements", pricing && launch, `${pricing} · ${launch}`);

// --- a project, made in the UI ---------------------------------------------------
await page.goto(`${base}/?view=projects`, { waitUntil: "networkidle" });
await shot("projects-empty");
await page
  .getByRole("button", { name: /new project/i })
  .first()
  .click();
await page.getByLabel("Name").fill("Q4 pricing");
await page.getByLabel("Objective").fill("Ship annual plans without losing early customers");
const boardName = (await first.body.name) || "Untitled workspace";
await page.getByRole("checkbox", { name: boardName }).check();
await page.getByRole("button", { name: "Create project" }).click();
const onPage = await waitFor(async () =>
  (await page.locator(".page-title").textContent())?.includes("Q4 pricing"),
);
check("a project is created from the Projects view and opens on its page", onPage);
const questionTile = await waitFor(async () => {
  const t = await page.locator(".stat-tile").filter({ hasText: "Open questions" }).textContent();
  return t?.includes("1") ? t : null;
});
check("its page counts the linked board's statements", questionTile, questionTile ?? "");
await shot("project-page");
const listed = await page.locator(".boards-notif-title").allTextContents();
check(
  "and lists them — only the linked board's",
  listed.includes("Do we grandfather existing customers?") &&
    listed.includes("Offer annual plans") &&
    !listed.includes("Write the announcement"),
  listed.join(" | "),
);
await page.getByRole("button", { name: /Do we grandfather existing customers/ }).click();
const revealed = await waitFor(
  () => page.url().includes("reveal=tier-q") || /view=canvas/.test(page.url()),
);
check("a statement opens on its board", revealed, page.url().replace(base, ""));

// --- Home: the project, and a board it never loaded ------------------------------
await page.goto(`${base}/?view=home`, { waitUntil: "networkidle" });
const projectOnHome = await waitFor(async () =>
  (await page.locator(".home-board-name").allTextContents()).includes("Q4 pricing"),
);
check("Home names the project", projectOnHome);
await shot("home");
const needs = await waitFor(async () => {
  const rows = await page.locator(".home-needs").textContent();
  return rows?.includes("Write the announcement") ? rows : null;
});
check("and counts work from a board this browser never opened (the index)", needs);

// --- Intelligence, across the workspace ------------------------------------------
await page.goto(`${base}/?view=intelligence&scope=workspace`, { waitUntil: "networkidle" });
const all = await waitFor(async () => {
  const titles = await page.locator(".boards-notif-title").allTextContents();
  return titles.length >= 3 ? titles : null;
});
await shot("workspace-intelligence");
check(
  "Intelligence, workspace scope, lists every board's statements",
  all?.includes("Write the announcement") && all?.includes("Do we grandfather existing customers?"),
  all?.join(" | "),
);
await page.getByLabel("Assigned to me").check();
const mine = await waitFor(async () => {
  const titles = await page.locator(".boards-notif-title").allTextContents();
  return titles.length === 1 ? titles : null;
});
check(
  "“Assigned to me” narrows it to this person's work",
  mine?.[0] === "Write the announcement",
  mine?.join(" | "),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
