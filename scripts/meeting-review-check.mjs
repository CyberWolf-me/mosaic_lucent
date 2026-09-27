/**
 * Review after a meeting, end to end (docs/28 S9): "a meeting ends into its
 * suggestions, and each gets a person's call, right there." Against the
 * running app (localhost:5173 → API :4387):
 *
 *   a saved meeting whose five statements Lucent suggested → its page says
 *   0 of 5 reviewed, each marked Suggested → approve both decisions at once →
 *   assign an action (owner and due date) → reword the other → reject the
 *   question → "All reviewed", and the board holds the results.
 *
 *   node scripts/meeting-review-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

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

await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Mona Meeting");
await page.locator('input[type="email"]').first().fill(`mreview_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("meeting-review-123");
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

// --- a saved meeting, and what Lucent suggested from it ----------------------------------------
const started = Date.now() - 3_600_000;
const turns = [
  "We go annual, starting next quarter.",
  "And we keep the free tier.",
  "Someone needs to update the pricing page.",
  "Billing has to support annual invoices.",
  "Do we grandfather existing customers?",
].map((text, i) => ({ speaker: i % 2 ? "Bo" : "Ada", at: started + (i + 1) * 1000, text }));
const meeting = await api(`/api/boards/${boardId}/meetings`, {
  method: "POST",
  body: JSON.stringify({ startedAt: started, endedAt: started + 1_800_000, turns }),
});
const meetingId = meeting.body.id;
const said = (id, kind, label, turn, status = "open") => [
  {
    op: "CREATE_NODE",
    id,
    nodeType: "process",
    label,
    provenance: { meetingId, turnRange: [turn, turn] },
  },
  { op: "SET_STATEMENT", id, statement: { kind, status } },
];
// Written as an agent writes them: they arrive as suggestions (ADR 0047).
const wrote = await api(
  `/api/boards/${boardId}/ops`,
  {
    method: "POST",
    body: JSON.stringify({
      label: "meeting extraction",
      ops: [
        ...said("annual", "decision", "Go annual next quarter", 0, "resolved"),
        ...said("free", "decision", "Keep the free tier", 1, "resolved"),
        ...said("page", "action", "Update the pricing page", 2),
        ...said("invoices", "action", "Annual invoices in billing", 3),
        ...said("grandfather", "question", "Grandfather existing customers?", 4),
      ],
    }),
  },
  { "x-lucent-client": "mcp" },
);
check("the meeting's five statements are on the board", wrote.status === 200);

await page.goto(`${base}/?view=meeting&board=${boardId}&meeting=${meetingId}`, {
  waitUntil: "networkidle",
});
const count = () => page.locator(".meet-review-count").textContent();
const first = await waitFor(async () => {
  const t = await count();
  return t && /0 of 5 reviewed/.test(t) ? t : null;
});
const chips = await page.locator("#meet-brief .trust-chip").count();
check("its page says 0 of 5 reviewed, each marked Suggested", first && chips === 5, first);
if (shots) await page.screenshot({ path: `${shots}/meeting-review-start.png`, fullPage: true });

const item = (label) => page.locator("#meet-brief .meet-item").filter({ hasText: label });

// Both decisions at once.
await page.getByRole("button", { name: "Approve all 2 decisions" }).click();
const two = await waitFor(async () => /2 of 5 reviewed/.test((await count()) ?? ""));
check("Approve all takes both decisions", two, await count());

// An action: owner and due date.
await item("Update the pricing page").getByRole("button", { name: "Assign" }).click();
await page.getByLabel("Owner of “Update the pricing page”").fill("Ada");
await page.getByLabel("Due date of “Update the pricing page”").fill("2026-11-02");
await item("Update the pricing page").getByRole("button", { name: "Assign" }).click();
const assigned = await waitFor(async () => {
  const t = await item("Update the pricing page").textContent();
  return /Ada/.test(t ?? "") && /3 of 5 reviewed/.test((await count()) ?? "") ? t : null;
});
check("Assign gives it an owner and a date, and counts as reviewed", assigned, assigned ?? "");

// Another in better words.
await item("Annual invoices in billing").getByRole("button", { name: "Edit" }).click();
await page
  .getByLabel("What “Annual invoices in billing” should say")
  .fill("Billing sends annual invoices");
await item("Annual invoices in billing").getByRole("button", { name: "Save" }).click();
const reworded = await waitFor(async () =>
  (await item("Billing sends annual invoices").count()) > 0 &&
  /4 of 5 reviewed/.test((await count()) ?? "")
    ? true
    : null,
);
check("Edit rewords it", reworded, await count());

// The question wasn't really asked.
await item("Grandfather existing customers?").getByRole("button", { name: "Reject" }).click();
const done = await waitFor(async () => {
  const t = await count();
  return t && /All reviewed/.test(t) && (await item("Grandfather").count()) === 0 ? t : null;
});
check("Reject removes it, and the meeting reads All reviewed", done, await count());
if (shots) await page.screenshot({ path: `${shots}/meeting-review-done.png`, fullPage: true });

const board = await api(`/api/boards/${boardId}`);
const nodes = board.body.workspace?.nodes ?? {};
check(
  "the board holds the results",
  nodes.annual?.statement?.trust === "human-approved" &&
    nodes.page?.issue?.assignee === "Ada" &&
    nodes.page?.issue?.dueDate === "2026-11-02" &&
    nodes.invoices?.label === "Billing sends annual invoices" &&
    nodes.invoices?.statement?.trust === "human-edited" &&
    !nodes.grandfather,
  JSON.stringify({
    annual: nodes.annual?.statement?.trust,
    page: nodes.page?.issue,
    invoices: [nodes.invoices?.label, nodes.invoices?.statement?.trust],
    grandfather: Boolean(nodes.grandfather),
  }),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
