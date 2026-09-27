/**
 * Automation v1, end to end (docs/26 A5, ADR 0049): "the owner turns a rule
 * on in Admin, and what it produces waits for a person." Against the running
 * app (localhost:5173 → API :4387):
 *
 *   Admin → Automation lists the four rules with their defaults (only the
 *   overdue reminder on) → the owner turns "decision approved → plan" on in
 *   the UI, and it survives a reload → a suggested decision approved in the
 *   Review center → the plan arrives as a pending proposal on its board,
 *   nothing applied, and the owner is told.
 *
 * The plan is written by the API's job runner (the outbox → `decision.plan`
 * job), so this check waits for it rather than calling anything directly.
 *
 *   node scripts/automation-check.mjs
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
const api = (path, init = {}, headers = {}) =>
  page.evaluate(
    async ([p, i, h]) => {
      const csrf = await (await fetch("/api/auth/csrf")).json();
      const res = await fetch(p, {
        ...i,
        headers: { "content-type": "application/json", "x-csrf-token": csrf.token, ...h },
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    [path, init, headers],
  );

// --- an owner with a shared board ------------------------------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Ava Auto");
const email = `auto_${Date.now()}@example.com`;
await page.locator('input[type="email"]').first().fill(email);
await page.locator('input[type="password"]').first().fill("auto-check-123");
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

// --- Admin → Automation ----------------------------------------------------------
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const rules = page.getByRole("list", { name: "Automation rules" });
await rules.waitFor({ timeout: 15000 });
await shot("admin-automation");
const boxes = rules.getByRole("checkbox");
const states = [];
for (let i = 0; i < (await boxes.count()); i++) states.push(await boxes.nth(i).isChecked());
check(
  "Admin lists four rules; only the overdue reminder is on by default",
  JSON.stringify(states) === JSON.stringify([false, false, true, false]),
  JSON.stringify(states),
);
const planRule = rules.getByRole("checkbox", { name: /decision is approved in Review/ });
await planRule.check();
await waitFor(async () => (await planRule.isEnabled()) && (await planRule.isChecked()));
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("list", { name: "Automation rules" }).waitFor();
check(
  "turning a rule on in the UI is saved",
  await page
    .getByRole("list", { name: "Automation rules" })
    .getByRole("checkbox", { name: /decision is approved in Review/ })
    .isChecked(),
);

// --- a suggested decision, approved in Review -------------------------------------
// An agent's write arrives as a suggestion, whatever it claims (ADR 0047).
const seeded = await api(
  `/api/boards/${boardId}/ops`,
  {
    method: "POST",
    body: JSON.stringify({
      label: "agent",
      ops: [
        { op: "CREATE_NODE", id: "go-annual", nodeType: "process", label: "Offer annual plans" },
        {
          op: "SET_STATEMENT",
          id: "go-annual",
          statement: { kind: "decision", status: "resolved" },
        },
        {
          op: "CREATE_NODE",
          id: "annual-billing",
          nodeType: "process",
          label: "Billing takes annual",
        },
        {
          op: "SET_STATEMENT",
          id: "annual-billing",
          statement: { kind: "requirement", status: "open" },
        },
      ],
    }),
  },
  { "x-lucent-client": "mcp" },
);
check("a board holding a suggested decision", seeded.status < 300);

await page.goto(`${base}/?view=review`, { waitUntil: "networkidle" });
const row = page.locator(".review-item").filter({ hasText: "Offer annual plans" });
await row.waitFor({ timeout: 15000 });
await shot("review");
await row.getByRole("button", { name: "Approve", exact: true }).click();
const gone = await waitFor(
  async () =>
    (await page.locator(".review-item").filter({ hasText: "Offer annual plans" }).count()) === 0,
);
check("the decision is approved in the Review center", gone);

// --- the plan arrives as a proposal ------------------------------------------------
const pending = await waitFor(
  async () => {
    const list = await api(`/api/boards/${boardId}/proposals`);
    return list.body.proposals?.find((p) => p.status === "pending");
  },
  30000,
  1000,
);
check(
  "its plan arrives as a pending proposal, for the approver",
  pending && /Automation — the plan for "Offer annual plans"/.test(pending.request),
  pending?.request,
);
const board = await api(`/api/boards/${boardId}`);
check(
  "nothing it proposed is on the board yet",
  !Object.keys(board.body.workspace?.nodes ?? {}).some((id) => id.endsWith("-action")),
  Object.keys(board.body.workspace?.nodes ?? {}).join(", "),
);
const told = await waitFor(async () => {
  const n = await api("/api/notifications?limit=20");
  return n.body.notifications?.find((x) => x.kind === "automation.proposed");
});
check("the owner is told", told, told?.title);

await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
const panel = await waitFor(async () =>
  (await page.getByText(/Automation — the plan for/).count()) > 0 ? true : null,
);
await shot("proposal-on-board");
check("and the proposal shows on the board for review", panel);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
