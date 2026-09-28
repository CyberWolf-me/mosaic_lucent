/**
 * The tool palette moves (ui/floatingPanel.ts): drag its grip anywhere on
 * the board, it stays on screen, keeps working, is still there after a
 * reload, moves by arrow keys, and double-click puts it back. Against the
 * running app (localhost:5173 → API :4387).
 *
 *   node scripts/toolbar-drag-check.mjs
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

await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Tia Toolbar");
await page.locator('input[type="email"]').first().fill(`toolbar_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("toolbar-check-123");
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
// A new account — and an empty board after a reload — opens on the launch
// screen; the palette lives on the board.
const toBoard = async () => {
  const blank = page.getByRole("button", { name: /start with a blank board/i });
  await blank.waitFor({ timeout: 15000 }).catch(() => {});
  if (await blank.count()) await blank.click();
};
await toBoard();

const bar = page.locator(".shape-toolbar");
const grip = page.locator(".toolbar-grip");
await grip.waitFor({ timeout: 15000 });
const round = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) });
const home = round(await bar.boundingBox());

// --- drag it down to the bottom of the board --------------------------------------------------
const g = await grip.boundingBox();
const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
const to = { x: 400, y: 780 };
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 12 });
await page.mouse.up();
const moved = round(await bar.boundingBox());
const expected = { x: home.x + (to.x - from.x), y: home.y + (to.y - from.y) };
check(
  "dragging the grip moves the palette with the pointer",
  Math.abs(moved.x - expected.x) <= 2 && Math.abs(moved.y - expected.y) <= 2,
  `home ${home.x},${home.y} → ${moved.x},${moved.y} (expected ${expected.x},${expected.y})`,
);
check(
  "low on the screen, its tooltips open upward",
  await bar.evaluate((el) => el.classList.contains("tips-above")),
);
if (shots) await page.screenshot({ path: `${shots}/toolbar-moved.png` });

// --- the tools still work where it is ---------------------------------------------------------
await page.getByRole("button", { name: "Rectangle · R" }).click();
check(
  "a tool picked from the moved palette arms",
  (await page.getByRole("button", { name: "Rectangle · R" }).getAttribute("aria-pressed")) ===
    "true",
);
await page.keyboard.press("Escape");

// --- it stays put across a reload -------------------------------------------------------------
await page.reload({ waitUntil: "networkidle" });
await toBoard();
await grip.waitFor({ timeout: 15000 });
const reloaded = round(await bar.boundingBox());
check(
  "after a reload it's where it was put",
  reloaded.x === moved.x && reloaded.y === moved.y,
  `${reloaded.x},${reloaded.y}`,
);

// --- it can't leave the screen ----------------------------------------------------------------
const g2 = await grip.boundingBox();
await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
await page.mouse.down();
await page.mouse.move(3000, 3000, { steps: 8 });
await page.mouse.up();
const edge = await bar.boundingBox();
check(
  "dragged past the corner, it stops at the edge of the window",
  edge.x + edge.width <= 1440 - 7 && edge.y + edge.height <= 900 - 7 && edge.x >= 8,
  `${Math.round(edge.x)},${Math.round(edge.y)} ${Math.round(edge.width)}×${Math.round(edge.height)}`,
);

// --- arrow keys, then back home ---------------------------------------------------------------
await grip.focus();
const before = await bar.boundingBox();
await page.keyboard.press("ArrowUp");
await page.keyboard.press("Shift+ArrowUp");
const after = await bar.boundingBox();
check(
  "with the grip focused, arrows move it (Shift for further)",
  Math.round(before.y - after.y) === 60,
  `${Math.round(before.y)} → ${Math.round(after.y)}`,
);
await grip.dblclick();
const back = round(await bar.boundingBox());
check(
  "double-clicking the grip puts it back",
  back.x === home.x && back.y === home.y,
  `${back.x},${back.y}`,
);
await page.reload({ waitUntil: "networkidle" });
await toBoard();
await grip.waitFor({ timeout: 15000 });
const afterReset = round(await bar.boundingBox());
check("and it stays home after a reload", afterReset.x === home.x && afterReset.y === home.y);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
