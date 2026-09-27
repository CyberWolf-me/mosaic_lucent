/**
 * The project dashboard, end to end (docs/26 A5, §8): "a project page shows
 * progress, and every blocker as a story — what it waits on, who owns it,
 * the decision behind it, the meeting that decided it." Against the running
 * app (localhost:5173 → API :4387):
 *
 *   a shared board holding a meeting-backed decision, the work it drove
 *   (blocked behind another step), one finished and one late action, in two
 *   workstreams → a project over it → its page shows the progress bar, both
 *   workstreams, the blocker story naming the meeting, and the late work →
 *   the story's pieces open where they live: the task on its board, the
 *   meeting at the turn it was decided.
 *
 *   node scripts/project-execution-check.mjs
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

// --- someone, with a shared board ----------------------------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Eli Exec");
const email = `exec_${Date.now()}@example.com`;
await page.locator('input[type="email"]').first().fill(email);
await page.locator('input[type="password"]').first().fill("exec-check-123");
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

// --- the meeting that decided, and the work it drove ------------------------------
const started = Date.now() - 2 * 86_400_000;
const meeting = await api(`/api/boards/${boardId}/meetings`, {
  method: "POST",
  body: JSON.stringify({
    startedAt: started,
    endedAt: started + 1_800_000,
    turns: [
      { speaker: "Eli", at: started + 1000, text: "Should we offer annual plans?" },
      { speaker: "Ada", at: started + 2000, text: "Yes — let's go annual, starting next quarter." },
    ],
  }),
});
const meetingId = meeting.body.id;
await api(`/api/boards/${boardId}/meetings/${meetingId}`, {
  method: "PATCH",
  body: JSON.stringify({ title: "Pricing review" }),
});
const act = (id, label, issue) => [
  { op: "CREATE_NODE", id, nodeType: "process", label },
  { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open" } },
  { op: "SET_ISSUE", id, issue: { type: "task", ...issue } },
];
const seeded = await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [
      {
        op: "CREATE_NODE",
        id: "annual",
        nodeType: "process",
        label: "Offer annual plans",
        provenance: { meetingId, turnRange: [1, 1] },
      },
      { op: "SET_STATEMENT", id: "annual", statement: { kind: "decision", status: "resolved" } },
      ...act("pricing-page", "Update the pricing page", { status: "blocked", assignee: "Ada" }),
      ...act("billing", "Change billing to annual", { status: "open", assignee: "Bo" }),
      ...act("research", "Research competitor pricing", { status: "completed", assignee: "Eli" }),
      ...act("announce", "Write the announcement", {
        status: "assigned",
        assignee: "Cy",
        dueDate: "2025-01-15",
      }),
      {
        op: "CONNECT_NODES",
        source: "billing",
        target: "pricing-page",
        relationship: "depends_on",
      },
      { op: "CONNECT_NODES", source: "annual", target: "billing", relationship: "drives" },
      { op: "CREATE_GROUP", id: "g-build", label: "Build", children: ["pricing-page", "billing"] },
      { op: "CREATE_GROUP", id: "g-launch", label: "Launch", children: ["research", "announce"] },
    ],
  }),
});
check("a board holding a decided meeting and the work it drove", seeded.status < 300 && meetingId);

// --- a project over it ------------------------------------------------------------
const orgs = await api("/api/orgs");
const orgId = orgs.body.orgs.find((o) => o.isPersonal)?.id;
const project = await api(`/api/orgs/${orgId}/projects`, {
  method: "POST",
  body: JSON.stringify({ name: "Annual plans", boardIds: [boardId] }),
});
await page.goto(`${base}/?view=projects&project=${project.body.id}`, { waitUntil: "networkidle" });
const progress = await waitFor(() => page.locator(".pexec-progress-text").textContent());
await shot("project-execution");
check(
  "the project page shows progress across its work",
  // Two blocked: the pricing page by hand, billing because it waits on it.
  /25% done · 1 of 4/.test(progress ?? "") &&
    /2 blocked/.test(progress ?? "") &&
    /1 late/.test(progress ?? ""),
  progress ?? "",
);
const streams = await page.locator(".pexec-stream-name").allTextContents();
check(
  "and each workstream",
  streams.includes("Build") && streams.includes("Launch"),
  streams.join(" | "),
);

const story = page.locator(".pexec-story").filter({ hasText: "Change billing to annual" });
const storyText = (await story.textContent()) ?? "";
check(
  "a blocker reads as a story: what it waits on, and who owns it",
  /waits on\s*Update the pricing page \(Ada\)/.test(storyText) && storyText.includes("· Bo"),
  storyText,
);
check(
  "with the decision that drove it and the meeting that decided it",
  storyText.includes("because of") &&
    storyText.includes("Offer annual plans") &&
    storyText.includes("Pricing review"),
);
const late = (await page.locator('[aria-label="Late work"]').textContent()) ?? "";
check(
  "late work is listed with its owner and due date",
  late.includes("Write the announcement") && late.includes("Cy") && late.includes("2025-01-15"),
  late,
);
check(
  "finished work never appears as blocked or late",
  !(await page.locator(".pexec-story").filter({ hasText: "Research competitor pricing" }).count()),
);

// --- every piece opens where it lives ---------------------------------------------
await story.getByRole("button", { name: /Update the pricing page/ }).click();
// `reveal` is consumed on read; what stays is the node, selected.
const onBoard = await waitFor(() =>
  page.evaluate(() => {
    if (!/view=canvas/.test(location.search)) return null;
    const title = [...document.querySelectorAll(".node-title")].find(
      (t) => t.textContent === "Update the pricing page",
    );
    let el = title;
    while (el && !/\bselected\b/.test(el.className || "")) el = el.parentElement;
    return el ? el.className : null;
  }),
);
check("a step opens on its board, selected", onBoard, onBoard ?? page.url().replace(base, ""));

await page.goto(`${base}/?view=projects&project=${project.body.id}`, { waitUntil: "networkidle" });
await page
  .locator(".pexec-story")
  .filter({ hasText: "Change billing to annual" })
  .getByRole("button", { name: /Pricing review/ })
  .click();
// `turn` is consumed on read too; what stays is the turn, marked.
const atMeeting = await waitFor(async () =>
  page.url().includes(`meeting=${meetingId}`)
    ? page.locator('.meet-turn.focused[data-turn="1"]').textContent()
    : null,
);
check(
  "the meeting opens at the turn it was decided",
  atMeeting?.includes("go annual"),
  atMeeting ?? page.url().replace(base, ""),
);
await shot("meeting-at-turn");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
