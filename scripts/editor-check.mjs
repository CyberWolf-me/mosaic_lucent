/**
 * The canvas editor's remaining moves, end to end (docs/26 §6.4): resize
 * from any edge or corner, with the proportions kept on Shift; a lasso; and
 * align, distribute and group from ⌘K. Against the running app
 * (localhost:5173 → API :4387), on a shared board so each result can be read
 * back from the server.
 *
 *   node scripts/editor-check.mjs
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
await page.locator('input[type="text"]').first().fill("Eli Editor");
await page.locator('input[type="email"]').first().fill(`editor_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("editor-check-123");
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

const rect = (id, x, y, text) => ({
  op: "CREATE_SHAPE",
  id,
  kind: "rect",
  position: { x, y },
  size: { width: 160, height: 80 },
  text,
});
await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [rect("a", 0, 0, "Alpha"), rect("b", 260, 60, "Bravo"), rect("c", 560, 20, "Charlie")],
  }),
});
await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
const shapeEl = (text) => page.locator(".shape").filter({ hasText: text }).first();
await shapeEl("Charlie").waitFor({ timeout: 15000 });
await page.keyboard.press("Shift+1"); // fit
await page.waitForTimeout(800);
const board = async () => (await api(`/api/boards/${boardId}`)).body.workspace.shapes;

// --- resize from the top-left corner: the bottom-right stays put ----------------------------
await shapeEl("Alpha").click();
const nw = shapeEl("Alpha").locator(".shape-resize.h-nw");
await nw.waitFor({ timeout: 5000 });
const handles = await shapeEl("Alpha").locator(".shape-resize").count();
const box = await nw.boundingBox();
await page.mouse.move(box.x + 5, box.y + 5);
await page.mouse.down();
await page.mouse.move(box.x - 35, box.y - 25, { steps: 6 });
await page.mouse.up();
const grown = await waitFor(async () => {
  const a = (await board()).a;
  return a.position.x < 0 && a.position.y < 0 ? a : null;
});
check(
  "eight handles, and the top-left corner grows the box up and left, the far corner fixed",
  handles === 8 &&
    grown &&
    Math.round(grown.position.x + grown.size.width) === 160 &&
    Math.round(grown.position.y + grown.size.height) === 80,
  JSON.stringify(grown && { ...grown.position, ...grown.size }),
);

// --- Shift keeps the proportions -----------------------------------------------------------------
await shapeEl("Bravo").click();
const east = shapeEl("Bravo").locator(".shape-resize.h-e");
const eb = await east.boundingBox();
await page.keyboard.down("Shift");
await page.mouse.move(eb.x + 5, eb.y + 5);
await page.mouse.down();
await page.mouse.move(eb.x + 85, eb.y + 5, { steps: 6 });
await page.mouse.up();
await page.keyboard.up("Shift");
const kept = await waitFor(async () => {
  const b = (await board()).b;
  return b.size.width > 160 ? b : null;
});
check(
  "Shift keeps the proportions (2:1 stays 2:1)",
  kept && Math.abs(kept.size.width / kept.size.height - 2) < 0.05,
  JSON.stringify(kept?.size),
);

// --- a lasso picks two out of three ----------------------------------------------------------------
await page.keyboard.press("Escape");
const ra = await shapeEl("Alpha").boundingBox();
const rb = await shapeEl("Bravo").boundingBox();
const rc = await shapeEl("Charlie").boundingBox();
const left = Math.min(ra.x, rb.x) - 30;
const right = Math.max(ra.x + ra.width, rb.x + rb.width) + 20;
const top = Math.min(ra.y, rb.y) - 30;
const bottom = Math.max(ra.y + ra.height, rb.y + rb.height) + 30;
await page.keyboard.down("Alt");
await page.mouse.move(left, top);
await page.mouse.down();
for (const [x, y] of [
  [right, top],
  [right, bottom],
  [left, bottom],
  [left, top + 5],
]) {
  await page.mouse.move(x, y, { steps: 8 });
}
await page.mouse.up();
await page.keyboard.up("Alt");
const picked = await waitFor(async () => {
  const n = await page.locator(".shape.selected").count();
  return n === 2 ? n : null;
});
const charlieOut = !(await shapeEl("Charlie").evaluate((el) => el.classList.contains("selected")));
check(
  "an Alt-drag lasso takes the two it circles, not the third",
  picked === 2 && charlieOut && rc.x > right,
  `${await page.locator(".shape.selected").count()} selected`,
);
if (shots) await page.screenshot({ path: `${shots}/editor-lasso.png` });

// --- ⌘K: align, then group -----------------------------------------------------------------------------
await page.keyboard.press("Control+k");
await page.keyboard.type("Align tops");
await page.keyboard.press("Enter");
const aligned = await waitFor(async () => {
  const s = await board();
  return s.a.position.y === s.b.position.y ? s : null;
});
check(
  "⌘K Align tops lines the selection up",
  aligned,
  JSON.stringify(aligned && [aligned.a.position.y, aligned.b.position.y]),
);
await page.keyboard.press("Control+k");
await page.keyboard.type("Group selection");
await page.keyboard.press("Enter");
const grouped = await waitFor(async () => {
  const s = await board();
  return s.a.groupId && s.a.groupId === s.b.groupId && !s.c.groupId ? s.a.groupId : null;
});
check("⌘K Group selection groups them", grouped, grouped ?? "");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
