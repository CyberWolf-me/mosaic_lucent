/**
 * A tracker's owner and due date reach the board (docs/26 A5), end to end:
 * "someone reassigns and reschedules the task in the tracker; Lucent asks
 * before the board follows." Against the running app (localhost:5173 → API
 * :4387) with the test tracker, and the API started with
 * LUCENT_DEV_FAKE_WEBHOOK=whsec_dev_inbound (the webhook's signing secret):
 *
 *   a shared board with an action (owner Ada, due Oct 1) → the test tracker
 *   connected, with that webhook secret → a sync creates and links its task
 *   → the tracker says Bo owns it and it's due Oct 15 (a signed webhook) →
 *   Review lists both, in words → accept the owner → the board says Bo,
 *   still Oct 1 → dismiss the date → the queue is empty.
 *
 *   node scripts/inbound-fields-check.mjs
 */
import { chromium } from "playwright";
import { createHmac } from "node:crypto";

const base = process.env.BASE_URL || "http://localhost:5173";
const secret = process.env.WEBHOOK_SECRET || "whsec_dev_inbound";
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

// --- an owner with a shared board holding an action --------------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Fern Fields");
await page.locator('input[type="email"]').first().fill(`fields_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("fields-check-123");
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
await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [
      { op: "CREATE_NODE", id: "launch-brief", nodeType: "task", label: "Write the launch brief" },
      { op: "SET_STATEMENT", id: "launch-brief", statement: { kind: "action", status: "open" } },
      {
        op: "SET_ISSUE",
        id: "launch-brief",
        issue: { type: "task", status: "assigned", assignee: "Ada", dueDate: "2026-10-01" },
      },
    ],
  }),
});

// --- the tracker connected, and the task synced to it --------------------------------
const orgs = await api("/api/orgs");
const orgId = orgs.body.orgs.find((o) => o.isPersonal)?.id;
const connected = await api(`/api/orgs/${orgId}/integrations/fake`, {
  method: "PUT",
  body: JSON.stringify({
    credentialRef: "LUCENT_DEV_FAKE_KEY",
    config: { webhookSecretRef: "LUCENT_DEV_FAKE_WEBHOOK" },
  }),
});
const synced = await api(`/api/boards/${boardId}/integrations/fake/sync`, { method: "POST" });
const externalId = synced.body.results?.find((r) => r.nodeId === "launch-brief")?.externalId;
check(
  "the task is created in the tracker and linked",
  connected.status === 201 && externalId,
  externalId,
);

// --- the tracker reassigns and reschedules it -----------------------------------------
const body = JSON.stringify({
  action: "update",
  type: "Issue",
  data: {
    identifier: externalId,
    state: { name: "todo" },
    assignee: { name: "Bo" },
    dueDate: "2026-10-15",
  },
});
const delivered = await fetch(`${base}/api/integrations/fake/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-signature": createHmac("sha256", secret).update(body).digest("hex"),
  },
  body,
});
check("the tracker's change is delivered", delivered.status === 200, `status ${delivered.status}`);

await page.goto(`${base}/?view=review`, { waitUntil: "networkidle" });
const owner = page.locator(".review-item").filter({ hasText: "gives it to Bo" });
const date = page.locator(".review-item").filter({ hasText: "moved its due date to 2026-10-15" });
const both = await waitFor(async () => (await owner.count()) === 1 && (await date.count()) === 1);
await shot("review-inbound-fields");
check("Review asks about the owner and the date, in words", both);

await owner.getByRole("button", { name: "Accept", exact: true }).click();
const assigned = await waitFor(async () => {
  const b = await api(`/api/boards/${boardId}`);
  const issue = b.body.workspace?.nodes?.["launch-brief"]?.issue;
  return issue?.assignee === "Bo" ? issue : null;
});
check(
  "accepting the owner gives it to Bo — and nothing else moves",
  assigned && assigned.dueDate === "2026-10-01" && assigned.status === "assigned",
  JSON.stringify(assigned),
);

await date.getByRole("button", { name: "Dismiss" }).click();
const cleared = await waitFor(
  async () =>
    (await page.locator(".review-item").filter({ hasText: "Write the launch brief" }).count()) ===
    0,
);
check("dismissing the date keeps the board's, and the queue empties", cleared);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
