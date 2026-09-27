/**
 * Ask everywhere, end to end (docs/26 A4, ADR 0048): "Why are we doing this?"
 * answers with its evidence, from wherever the question is asked. Against the
 * running app (localhost:5173 → API :4387, LUCENT_AI_PROVIDER=mock):
 *
 *   two boards — a decision on one, a meeting on the other → ⌘K finds the
 *   meeting line from the first board ("elsewhere in your workspace") and
 *   opens it → Home asks the whole workspace: an answer, how well it is
 *   supported, and evidence that opens on its own board → the canvas answers
 *   with its confidence, and the conversation is on the server afterwards →
 *   a board that lives only in this browser can be asked too → a project
 *   page asks its own boards.
 *
 *   node scripts/ask-everywhere-check.mjs
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

// --- two boards: a decision on one, a meeting on the other --------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Asha Ask");
await page.locator('input[type="email"]').first().fill(`ask_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("ask-check-123");
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
await api(`/api/boards/${pricing}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [
      { op: "CREATE_NODE", id: "pg", nodeType: "process", label: "Use Postgres for billing" },
      { op: "SET_STATEMENT", id: "pg", statement: { kind: "decision", status: "resolved" } },
      { op: "CREATE_NODE", id: "q", nodeType: "process", label: "Do we need read replicas?" },
      { op: "SET_STATEMENT", id: "q", statement: { kind: "question", status: "open" } },
    ],
  }),
});
const first = await api(`/api/boards/${pricing}`);
const infra = (
  await api("/api/boards", {
    method: "POST",
    body: JSON.stringify({
      name: "Infra",
      workspace: { ...first.body.workspace, nodes: {}, edges: {} },
    }),
  })
).body.id;
const now = Date.now();
await api(`/api/boards/${infra}/meetings`, {
  method: "POST",
  body: JSON.stringify({
    title: "Database review",
    turns: [
      { speaker: "Ada", at: now - 60_000, text: "Postgres failover still worries me." },
      {
        speaker: "Bo",
        at: now - 30_000,
        text: "We decided on Postgres because billing needs transactions.",
      },
    ],
  }),
});
check(
  "two boards — a decision on one, a meeting on the other",
  pricing && infra,
  `${pricing} · ${infra}`,
);

// --- ⌘K: the meeting line, from the other board --------------------------------------
await page.goto(`${base}/?view=canvas&board=${pricing}`, { waitUntil: "networkidle" });
await page.keyboard.press("Control+k");
await page.keyboard.type("failover");
const far = await waitFor(async () => {
  const rows = await page.locator("button").filter({ hasText: "Postgres failover" }).count();
  return rows > 0;
});
check("⌘K finds a meeting line on another board — elsewhere in your workspace", far);
await page.locator("button").filter({ hasText: "Postgres failover" }).first().click();
const opened = await waitFor(() => /view=meeting/.test(page.url()) && page.url().includes(infra));
check("and opens it in its meeting, on its board", opened, page.url().replace(base, ""));

// --- Home: ask the whole workspace ----------------------------------------------------
await page.goto(`${base}/?view=home`, { waitUntil: "networkidle" });
const composer = page.getByLabel("Describe an idea, or ask about your work");
await composer.fill("Why did we choose Postgres?");
await composer.press("Enter");
const answered = await waitFor(
  async () => (await page.locator(".scoped-ask-answer").count()) > 0,
  20000,
);
check("Home asks the whole workspace and answers in place", answered);
const confidence =
  (await page
    .locator(".scoped-ask-answer .answer-confidence")
    .textContent()
    .catch(() => "")) ?? "";
check("the answer says how well it is supported", confidence.length > 0, confidence.trim());
const cite = page
  .locator(".scoped-ask-answer .citation-chip")
  .filter({ hasText: /Pricing|Untitled|Infra|Database/ })
  .first();
check(
  "its evidence names the board it lives on",
  (await cite.count()) > 0,
  (await cite.textContent().catch(() => ""))?.trim(),
);
await shot("home-ask");
await cite.click();
const landed = await waitFor(() => /view=(canvas|meeting)/.test(page.url()));
check("a piece of evidence opens where it lives", landed, page.url().replace(base, ""));

// --- the canvas: confidence, and the conversation on the server ------------------------
await page.goto(`${base}/?view=canvas&board=${pricing}`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Ask mode" }).first().click();
const pill = page.getByLabel("Ask Lucent").first();
await pill.fill("What did we decide about billing?");
await pill.press("Enter");
// The pill keeps its conversation folded; open it to read the answer.
const openConversation = async () => {
  const toggle = page.locator(".ai-msg-count-btn");
  if (await toggle.count())
    await toggle
      .first()
      .click()
      .catch(() => {});
};
const canvasConfidence = await waitFor(async () => {
  await openConversation();
  return (await page.locator(".answer-confidence").count()) > 0
    ? ((await page.locator(".answer-confidence").last().textContent()) ?? "").trim()
    : null;
}, 20000);
check("the canvas answer carries its confidence", canvasConfidence, canvasConfidence);
const thread = await waitFor(async () => {
  const t = await api(`/api/threads?scope=${encodeURIComponent(`board:${pricing}`)}`);
  const texts = (t.body.messages ?? []).map((m) => m.text);
  return texts.includes("What did we decide about billing?") ? texts : null;
});
check(
  "and the conversation is on the server — this person's thread on the board",
  thread,
  thread?.length,
);

// --- a board that lives only in this browser ---------------------------------------------
await page.getByRole("button", { name: "New board" }).first().click();
const confirm = page.getByRole("button", { name: /start a new board|new board|discard/i });
if (await confirm.count())
  await confirm
    .first()
    .click()
    .catch(() => {});
await page.waitForTimeout(800);
await page.goto(`${base}/?view=canvas`, { waitUntil: "networkidle" });
const hero = page.getByRole("textbox").first();
await hero.fill("a checkout flow with a payment step");
await hero.press("Enter");
await page.waitForTimeout(3000);
await page
  .getByRole("button", { name: "Ask mode" })
  .first()
  .click()
  .catch(() => {});
const localPill = page.getByLabel("Ask Lucent").first();
await localPill.fill("What is on this board?");
await localPill.press("Enter");
const localAnswer = await waitFor(async () => {
  await openConversation();
  const errors = await page.getByText("Share this board first").count();
  if (errors > 0) return "refused";
  return (await page.locator(".answer-confidence").count()) > 0 ? "answered" : null;
}, 20000);
check("a board in this browser is asked too, not refused", localAnswer === "answered", localAnswer);

// --- a project asks its own boards -------------------------------------------------------
const me = await api("/api/auth/me");
const orgId = me.body.memberships?.[0]?.orgId;
const project = await api(`/api/orgs/${orgId}/projects`, {
  method: "POST",
  body: JSON.stringify({ name: "Billing", boardIds: [pricing, infra] }),
});
await page.goto(`${base}/?view=projects&project=${project.body.id}`, { waitUntil: "networkidle" });
const projectAsk = page.getByLabel(/Ask about Billing/);
await projectAsk.fill("What is still open?");
await projectAsk.press("Enter");
const projectAnswer = await waitFor(
  async () => (await page.locator(".scoped-ask-answer").count()) > 0,
  20000,
);
check("a project page asks across its own boards", projectAnswer);
await shot("project-ask");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
