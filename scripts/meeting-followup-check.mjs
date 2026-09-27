/**
 * Follow-up after a meeting, end to end (docs/28 S11): "once it's reviewed,
 * the meeting's page offers what comes next." Against the running app
 * (localhost:5173 → API :4387, the API's log at API_LOG for the dev mailbox):
 *
 *   a reviewed meeting with three owned actions → its page offers Create
 *   tasks (no tracker: "Connect…"), Schedule, Notify owners, Add a board
 *   section → Notify owners tells the teammate and names the owner nobody
 *   matches → the teammate has it → the section is proposed and, approved,
 *   groups the meeting on the board → Schedule opens titled as a follow-up,
 *   inviting who spoke → the teammate is invited.
 *
 *   API_LOG=path/to/api.log node scripts/meeting-followup-check.mjs
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const apiLog = process.env.API_LOG;
if (!apiLog) throw new Error("API_LOG must name the API's log file (the dev mailbox)");
const headed = process.env.HEADED === "1";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });

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
  await page.locator('input[type="password"]').first().fill("followup-check-123");
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
function mailedLink(email, pattern) {
  const lines = readFileSync(apiLog, "utf8")
    .split("\n")
    .filter((l) => l.includes(`to=${email}`));
  for (const line of lines.reverse()) {
    const listed = line.match(/ urls=(\[.*?\])/);
    const urls = listed ? JSON.parse(listed[1]) : (line.match(/https?:\/\/[^\s"\\]+/g) ?? []);
    const url = urls.find((u) => pattern.test(u) && !u.endsWith("…"));
    if (url) return url;
  }
  return null;
}

// --- an owner, and a teammate in the workspace --------------------------------------------------
const stamp = Date.now();
const owner = await person("Fay Follow", `fay_${stamp}@example.com`);
const edEmail = `ed_${stamp}@example.com`;
const me = await owner.api("/api/auth/me");
const orgId = `org_personal_${me.body.user.id}`;
await owner.api(`/api/orgs/${orgId}/invites`, {
  method: "POST",
  body: JSON.stringify({ email: edEmail, role: "editor" }),
});
const ed = await person("Ed Owner", edEmail);
const link = await waitFor(() => mailedLink(edEmail, /\/invite\?token=/));
const token = link ? new URL(link).searchParams.get("token") : null;
let accepted = await ed.api("/api/invites/accept", {
  method: "POST",
  body: JSON.stringify({ token }),
});
if (accepted.status === 403) {
  const verify = await waitFor(() => mailedLink(edEmail, /\/verify\?token=/));
  if (verify) await ed.page.goto(verify, { waitUntil: "networkidle" });
  accepted = await ed.api("/api/invites/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}
check("the teammate joins the workspace", accepted.status < 300, `status ${accepted.status}`);

// --- a reviewed meeting ----------------------------------------------------------------------------
const page = owner.page;
await page.bringToFront();
const boardId = (
  await owner.api("/api/boards", {
    method: "POST",
    body: JSON.stringify({ name: "Pricing", orgId }),
  })
).body.id;
const started = Date.now() - 3_600_000;
const meetingId = (
  await owner.api(`/api/boards/${boardId}/meetings`, {
    method: "POST",
    body: JSON.stringify({
      startedAt: started,
      endedAt: started + 1_800_000,
      turns: [
        { speaker: "Fay Follow", at: started + 1000, text: "We go annual next quarter." },
        { speaker: "Ed Owner", at: started + 2000, text: "I'll update the pricing page." },
      ],
    }),
  })
).body.id;
await owner.api(`/api/boards/${boardId}/meetings/${meetingId}`, {
  method: "PATCH",
  body: JSON.stringify({ title: "Pricing review" }),
});
const stated = (id, kind, label, extra = []) => [
  {
    op: "CREATE_NODE",
    id,
    nodeType: "process",
    label,
    provenance: { meetingId, turnRange: [0, 1] },
  },
  {
    op: "SET_STATEMENT",
    id,
    statement: { kind, status: kind === "decision" ? "resolved" : "open" },
  },
  ...extra,
];
const owns = (id, assignee) => ({
  op: "SET_ISSUE",
  id,
  issue: { type: "task", status: "assigned", assignee },
});
await owner.api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "reviewed",
    ops: [
      ...stated("annual", "decision", "Go annual next quarter"),
      ...stated("page", "action", "Update the pricing page", [owns("page", "Ed Owner")]),
      ...stated("invoices", "action", "Annual invoices", [owns("invoices", "Fay Follow")]),
      ...stated("legal", "action", "Legal review of the terms", [owns("legal", "Zed")]),
    ],
  }),
});

await page.goto(`${base}/?view=meeting&board=${boardId}&meeting=${meetingId}`, {
  waitUntil: "networkidle",
});
const section = page.locator(".meet-followup");
await section.waitFor({ timeout: 15000 });
const offers = await section.locator(".meet-offer-title").allTextContents();
check(
  "a reviewed meeting offers what comes next",
  ["Create tasks", "Schedule the next meeting", "Notify owners", "Add a board section"].every((o) =>
    offers.includes(o),
  ) &&
    (await section.getByRole("button", { name: "Connect Linear, Jira or GitHub" }).count()) === 1,
  JSON.stringify(offers),
);
if (shots) await page.screenshot({ path: `${shots}/meeting-followup.png`, fullPage: true });

// --- Notify owners -------------------------------------------------------------------------------------
await section.getByRole("button", { name: "Notify owners" }).click();
const note = await waitFor(async () => {
  const n = section.locator(".meet-offer-note");
  return (await n.count()) > 0 ? await n.first().textContent() : null;
});
check(
  "Notify owners tells the teammate, and names the owner nobody matches",
  note && /Told Ed Owner \(1 action\)/.test(note) && /Zed matches no one/.test(note),
  note ?? "",
);
const heard = await waitFor(async () => {
  const list = await ed.api("/api/notifications");
  return (list.body.notifications ?? []).find((n) => n.kind === "meeting.followup");
});
check(
  "the teammate has it",
  heard && heard.title === 'Fay Follow sent you your action from "Pricing review"',
  heard?.title,
);

// --- Add a board section ---------------------------------------------------------------------------------
await section.getByRole("button", { name: "Propose" }).click();
const apply = page.getByRole("button", { name: /Apply all/ });
await apply.waitFor({ timeout: 15000 });
await apply.click();
const grouped = await waitFor(async () => {
  const board = await owner.api(`/api/boards/${boardId}`);
  const group = board.body.workspace?.groups?.[`sec-${meetingId}`];
  return group && group.children.length === 4 ? group : null;
});
check(
  "the section, approved, groups the meeting on the board",
  grouped?.label === "Pricing review",
  JSON.stringify(grouped),
);

// --- Schedule the next one -----------------------------------------------------------------------------
await section.getByRole("button", { name: "Schedule" }).click();
const titleField = page.getByLabel("Title");
await titleField.waitFor({ timeout: 10000 });
const edBox = page.locator(".sched-list li").filter({ hasText: "Ed Owner" }).locator("input");
await edBox.waitFor({ timeout: 10000 });
check(
  "Schedule opens titled as a follow-up, inviting who spoke",
  (await titleField.inputValue()) === "Follow-up: Pricing review" && (await edBox.isChecked()),
  await titleField.inputValue(),
);
await page.getByRole("dialog").getByRole("button", { name: "Schedule", exact: true }).click();
const invited = await waitFor(async () => {
  const list = await ed.api("/api/notifications");
  return (list.body.notifications ?? []).find((n) => n.kind === "meeting.invited");
});
check("and the teammate is invited", invited, invited?.title);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
