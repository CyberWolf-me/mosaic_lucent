/**
 * More of the canvas editor (docs/26 §6.4): the highlighter, minimal rich
 * text (with code blocks), and connectors between a shape and a diagram node.
 * Against the running app (localhost:5173 → API :4387), on a shared board.
 *
 *   node scripts/editor-more-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 100 : 0 });
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
await page.locator('input[type="text"]').first().fill("Hal Highlight");
await page.locator('input[type="email"]').first().fill(`hl_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("editor-more-123");
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
await page.keyboard.press("Escape");

const note = [
  "# Launch plan",
  "- **Ship** on Friday",
  "- see https://example.com/runbook",
  "```",
  "npm run deploy",
  "```",
].join("\n");
await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [
      { op: "CREATE_NODE", id: "checkout", nodeType: "process", label: "Checkout" },
      { op: "MOVE_NODE", id: "checkout", position: { x: 500, y: 100 }, pinned: true },
      {
        op: "CREATE_SHAPE",
        id: "plan",
        kind: "sticky",
        position: { x: 0, y: 60 },
        size: { width: 260, height: 220 },
        text: note,
        z: 3,
      },
    ],
  }),
});
await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
const sticky = page.locator(".shape").filter({ hasText: "Launch plan" }).first();
await sticky.waitFor({ timeout: 15000 });
await page.keyboard.press("Shift+1");
await page.waitForTimeout(800);

// --- rich text ----------------------------------------------------------------------------
const rich = {
  heading: await sticky.locator(".rt-h1").textContent(),
  bold: await sticky.locator("strong").first().textContent(),
  code: await sticky.locator("pre.rt-pre").textContent(),
  link: await sticky.locator("a.rt-link").getAttribute("href"),
};
check(
  "a note's markup draws: a heading, bold, a code block, a safe link",
  rich.heading === "Launch plan" &&
    rich.bold === "Ship" &&
    rich.code === "npm run deploy" &&
    rich.link === "https://example.com/runbook",
  JSON.stringify(rich),
);
if (shots) await page.screenshot({ path: `${shots}/editor-rich.png` });

// --- the highlighter -------------------------------------------------------------------------
await page.mouse.click(1000, 600);
await page.keyboard.press("i");
const hud = await waitFor(async () =>
  /Highlighter/.test(
    (await page
      .locator(".pen-hud")
      .textContent()
      .catch(() => "")) ?? "",
  ),
);
const sb = await sticky.boundingBox();
await page.mouse.move(sb.x + 20, sb.y + 40);
await page.mouse.down();
await page.mouse.move(sb.x + 200, sb.y + 42, { steps: 10 });
await page.mouse.up();
await page.keyboard.press("Escape");
const marked = await waitFor(async () => {
  const shapes = (await api(`/api/boards/${boardId}`)).body.workspace.shapes;
  const strokes = Object.values(shapes).filter((s) => s.kind === "draw");
  return strokes.length > 0 ? { strokes, plan: shapes.plan } : null;
});
const stroke = marked?.strokes[0];
check(
  "I is the highlighter: one broad, see-through stroke, on top of the note it marks",
  hud &&
    marked.strokes.length === 1 &&
    stroke.style?.opacity === 0.38 &&
    stroke.style.strokeWidth === 16 &&
    stroke.z > marked.plan.z,
  JSON.stringify({
    n: marked?.strokes.length,
    style: stroke?.style,
    z: [stroke?.z, marked?.plan.z],
  }),
);

// --- a connector from the note to a diagram node ---------------------------------------------
const arrows = () => page.locator('path[marker-end="url(#shape-arr)"]').count();
const before = await arrows();
await page.mouse.click(1000, 600);
await page.keyboard.press("a");
await sticky.click({ position: { x: 20, y: 150 } });
await page.locator(".node-title", { hasText: "Checkout" }).first().click();
const link = await waitFor(async () => {
  const links = (await api(`/api/boards/${boardId}`)).body.workspace.shapeLinks;
  return Object.values(links).find((l) => l.source === "plan" && l.target === "checkout");
});
const drawn = await waitFor(async () => ((await arrows()) > before ? true : null));
check("Connect joins the note to the diagram node, and draws it", link && drawn, link?.id);
if (shots) await page.screenshot({ path: `${shots}/editor-node-link.png` });

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
