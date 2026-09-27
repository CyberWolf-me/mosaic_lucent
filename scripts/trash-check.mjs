/**
 * The trash, end to end (docs/26 A6): "a deleted board or project waits 30
 * days, and comes back as it was." Against the running app (localhost:5173
 * → API :4387):
 *
 *   a team board with content → the dashboard moves it to the trash (a
 *   dialog says what that means) → it's gone from the dashboard and won't
 *   open → Admin → Trash lists it → Restore → it opens again, content
 *   intact → a project deleted from its page lands in the trash too, and
 *   comes back.
 *
 *   node scripts/trash-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
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

await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Tess Trash");
await page.locator('input[type="email"]').first().fill(`trash_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("trash-check-123");
await page.getByRole("button", { name: /create account/i }).click();
await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(600);
const me = await api("/api/auth/me");
const orgId = `org_personal_${me.body.user.id}`;

// --- a team board with content ------------------------------------------------------------
const created = await api("/api/boards", {
  method: "POST",
  body: JSON.stringify({ name: "Q4 roadmap", orgId }),
});
const boardId = created.body.id;
await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [{ op: "CREATE_NODE", id: "keep", nodeType: "process", label: "Ship annual plans" }],
  }),
});

// --- the dashboard moves it to the trash -----------------------------------------------------
await page.goto(`${base}/?view=dashboard`, { waitUntil: "networkidle" });
const del = page.getByRole("button", { name: "Delete Q4 roadmap" });
await del.waitFor({ timeout: 15000 });
await del.click({ force: true });
const dialog = page.getByRole("dialog");
check(
  "the dialog says it goes to the trash for 30 days",
  /trash for 30 days/.test((await dialog.textContent()) ?? ""),
);
await dialog.getByRole("button", { name: "Move to trash" }).click();
const gone = await waitFor(async () =>
  (await page.getByRole("button", { name: "Delete Q4 roadmap" }).count()) === 0 ? true : null,
);
const opened = await api(`/api/boards/${boardId}`);
check(
  "it leaves the dashboard and won't open",
  gone && opened.status === 404,
  `status ${opened.status}`,
);

// --- Admin → Trash → Restore -------------------------------------------------------------------
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const trash = page.getByRole("list", { name: "Trash" });
await trash.waitFor({ timeout: 15000 });
const row = trash.locator(".trash-row").filter({ hasText: "Q4 roadmap" });
check(
  "Admin → Trash lists it, with how long it has left",
  /deleted by Tess Trash · gone in 30 days/.test((await row.textContent()) ?? ""),
  (await row.textContent()) ?? "",
);
if (shots) await page.screenshot({ path: `${shots}/admin-trash.png`, fullPage: true });
await row.getByRole("button", { name: "Restore" }).click();
const back = await waitFor(async () => {
  const b = await api(`/api/boards/${boardId}`);
  return b.status === 200 ? b.body : null;
});
check(
  "Restore brings it back as it was",
  back?.workspace?.nodes?.keep?.label === "Ship annual plans",
);

// --- a project, from its page ------------------------------------------------------------------
const project = await api(`/api/orgs/${orgId}/projects`, {
  method: "POST",
  body: JSON.stringify({ name: "Annual plans", boardIds: [boardId] }),
});
await page.goto(`${base}/?view=projects&project=${project.body.id}`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Edit", exact: true }).click();
await page.getByRole("button", { name: "Delete project" }).click();
await page.getByRole("button", { name: "Move to trash" }).click();
const projectGone = await waitFor(async () =>
  (await api(`/api/orgs/${orgId}/projects/${project.body.id}`)).status === 404 ? true : null,
);
check("a project deleted from its page leaves", projectGone);
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const projectRow = page.getByRole("list", { name: "Trash" }).locator(".trash-row").filter({
  hasText: "Annual plans",
});
await projectRow.getByRole("button", { name: "Restore" }).click();
const projectBack = await waitFor(async () =>
  (await api(`/api/orgs/${orgId}/projects/${project.body.id}`)).status === 200 ? true : null,
);
check("and comes back from the trash", projectBack);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
