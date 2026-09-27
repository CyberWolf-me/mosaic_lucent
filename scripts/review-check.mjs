/**
 * Trust, end to end (docs/26 A2, ADR 0047): "nothing AI-extracted becomes
 * trusted without a visible human step." Against the running app
 * (localhost:5173 → API :4387, LUCENT_AI_PROVIDER=mock):
 *
 *   an agent writes three decisions on a shared board → they arrive as
 *   suggestions (the chip on the board's Intelligence) and the board's owner
 *   is told → the Review center lists them → approve one, reword one, reject
 *   one, each through the UI → the queue empties and the board shows the
 *   result → a canvas request's run is on record, approved by the person.
 *
 *   node scripts/review-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
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

// --- someone, with a shared board ------------------------------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Rosa Review");
await page.locator('input[type="email"]').first().fill(`review_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("review-check-123");
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
await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
// Let the index learn the empty board first: what comes next is news.
await api(`/api/orgs/org_personal_${(await api("/api/auth/me")).body.user?.id}/intelligence`);
await page.waitForTimeout(1500);

// --- an agent writes three decisions ----------------------------------------------
const decision = (id, label) => [
  { op: "CREATE_NODE", id, nodeType: "process", label },
  {
    op: "SET_STATEMENT",
    id,
    // It claims more than it may — the server stamps what it really is.
    statement: { kind: "decision", status: "resolved", trust: "human-approved" },
  },
];
const wrote = await api(
  `/api/boards/${boardId}/ops`,
  {
    method: "POST",
    body: JSON.stringify({
      label: "agent",
      ops: [
        ...decision("annual", "Offer annual plans"),
        ...decision("friday", "Ship on Fridey"),
        ...decision("mistake", "Cancel the launch"),
      ],
    }),
  },
  { "x-lucent-client": "mcp" },
);
check("an agent writes three decisions", wrote.status === 200, `status ${wrote.status}`);

await page.goto(`${base}/?view=intelligence&board=${boardId}`, { waitUntil: "networkidle" });
const chips = await waitFor(async () => {
  const n = await page.locator(".trust-chip").count();
  return n === 3 ? n : null;
});
check("they arrive as suggestions — whatever the agent claimed", chips === 3, `${chips} chips`);

const nudged = await waitFor(async () => {
  const list = await api("/api/notifications");
  return (list.body.notifications ?? []).find((n) => n.kind === "review.pending");
}, 10000);
check("the board's owner is told they wait for review", nudged, nudged?.title);

// --- the Review center ---------------------------------------------------------------
await page.goto(`${base}/?view=review`, { waitUntil: "networkidle" });
const listed = await waitFor(async () => {
  const t = await page.locator(".review-item .boards-notif-title").allTextContents();
  return t.length >= 3 ? t : null;
});
check(
  "the Review center lists them",
  listed?.includes("Offer annual plans") && listed?.includes("Cancel the launch"),
  listed?.join(" | "),
);
await shot("review");

const rowOf = (label) => page.locator(".review-item").filter({ hasText: label });
await rowOf("Offer annual plans").getByRole("button", { name: "Approve", exact: true }).click();
await waitFor(async () => !(await rowOf("Offer annual plans").count()));
await rowOf("Ship on Fridey").getByRole("button", { name: "Edit" }).click();
await page.getByLabel("What it should say").fill("Ship on Friday");
await page.getByRole("button", { name: "Save" }).click();
await waitFor(async () => !(await rowOf("Ship on Fridey").count()));
await rowOf("Cancel the launch").getByRole("button", { name: "Reject" }).click();
const emptied = await waitFor(async () =>
  (await page.locator(".page-title").textContent())?.includes("Nothing waits on you"),
);
check("approve, reword, reject — and the queue empties", emptied);

const board = await api(`/api/boards/${boardId}`);
const nodes = board.body.workspace?.nodes ?? {};
check(
  "the board shows each decision as it was made",
  nodes.annual?.statement?.trust === "human-approved" &&
    nodes.friday?.label === "Ship on Friday" &&
    nodes.friday?.statement?.trust === "human-edited" &&
    !nodes.mistake,
  JSON.stringify({
    annual: nodes.annual?.statement?.trust,
    friday: [nodes.friday?.label, nodes.friday?.statement?.trust],
    mistake: Boolean(nodes.mistake),
  }),
);

// --- every AI run is on record -------------------------------------------------------
await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
const pill = page.getByLabel("Ask Lucent").first();
await pill.fill("add a payments service");
await pill.press("Enter");
await page.waitForTimeout(4000);
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const run = await waitFor(async () => {
  const rows = await page.locator('[aria-label="AI runs"] li').allTextContents();
  return rows.find((r) => r.includes("Canvas request") && r.includes("approved by")) ?? null;
});
check("a canvas request's run is on record, approved by the person who asked", run, run);
const agentRun = await page
  .locator('[aria-label="AI runs"] li')
  .filter({ hasText: "MCP agent" })
  .count();
check("and so is the agent's write, with no one's approval", agentRun >= 1, `${agentRun}`);
await shot("ai-activity");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
