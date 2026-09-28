/**
 * Presentations from frames (docs/26 §6.1): Present steps through the board's
 * frames as slides, and "Slides PDF" prints one page per frame at the frame's
 * size. Against the running app (localhost:5173 → API :4387); the print
 * document the app builds is rendered to a real PDF with Chromium and read
 * back.
 *
 *   node scripts/slides-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 100 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const consoleLines = [];
page.on("console", (m) => consoleLines.push(m.text()));

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
await page.locator('input[type="text"]').first().fill("Sam Slides");
await page.locator('input[type="email"]').first().fill(`slides_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("slides-check-123");
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

// Three frames, numbered out of reading order, each with a note inside.
const deck = [
  { id: "f_sol", x: 900, y: 0, title: "2. Solution", note: "Cache the quotes" },
  { id: "f_prob", x: 0, y: 0, title: "1. Problem", note: "Checkout is slow" },
  { id: "f_ask", x: 0, y: 700, title: "3. Ask", note: "Two engineers, one sprint" },
];
const seeded = await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: deck.flatMap((f, i) => [
      {
        op: "CREATE_SHAPE",
        id: f.id,
        kind: "frame",
        position: { x: f.x, y: f.y },
        size: { width: 800, height: 450 },
        text: f.title,
        z: 2 + i * 2,
      },
      {
        op: "CREATE_SHAPE",
        id: `${f.id}_note`,
        kind: "sticky",
        position: { x: f.x + 60, y: f.y + 80 },
        size: { width: 240, height: 160 },
        text: f.note,
        z: 3 + i * 2,
      },
    ]),
  }),
});
check("seeded three frames", seeded.status === 200, `status ${seeded.status}`);
await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
await page.locator(".shape.frame").first().waitFor({ timeout: 15000 });

// --- present: frame by frame ---------------------------------------------------------------------
await page
  .getByRole("button", { name: /Present/ })
  .first()
  .click();
const caption = page.locator(".present-caption");
const slideState = async () => ({
  meta: (await caption.locator(".present-meta").textContent())?.trim(),
  title: (await caption.locator(".present-title").textContent())?.trim(),
});
const first = await waitFor(async () => {
  const s = await slideState();
  return /Slide 1 of 3/.test(s.meta ?? "") ? s : null;
});
await page.waitForTimeout(700);
const fitted = async (title) => {
  const f = page.locator(".shape.frame").filter({ hasText: title }).first();
  const b = await f.boundingBox();
  return b && b.width > 700 && b.x > -20 && b.x + b.width < 1460 ? Math.round(b.width) : null;
};
const firstFit = await waitFor(() => fitted("1. Problem"), 5000);
check(
  "Present opens on slide 1 — the frame numbered 1 — fitted to the screen",
  first?.title === "1. Problem" && firstFit,
  `${JSON.stringify(first)} · ${firstFit}px wide`,
);
if (shots) await page.screenshot({ path: `${shots}/slides-present.png` });
await page.keyboard.press("ArrowRight");
const second = await waitFor(async () => {
  const s = await slideState();
  return /Slide 2 of 3/.test(s.meta ?? "") ? s : null;
});
const secondFit = await waitFor(() => fitted("2. Solution"), 5000);
check(
  "→ moves to the next frame, and the camera goes with it",
  second?.title === "2. Solution" && secondFit,
  `${JSON.stringify(second)} · ${secondFit}px wide`,
);
await page.keyboard.press("Escape");
check("Esc leaves the presentation", await waitFor(async () => !(await caption.count())));

// --- slides as PDF ---------------------------------------------------------------------------------
await page.locator(".export-menu").hover();
await page.getByRole("button", { name: "Slides PDF" }).click();
const srcdoc = await waitFor(() =>
  page.evaluate(() => document.querySelector('iframe[title="print slides"]')?.srcdoc ?? null),
);
// The print frame must be allowed to open the dialog: Chrome ignores print()
// in a sandbox without allow-modals (the export used to do nothing).
await page.waitForTimeout(1500);
const refused = consoleLines.filter((l) => /Ignored call to 'print\(\)'/.test(l));
check("the print dialog is allowed to open", refused.length === 0, refused[0]);
const printPage = await ctx.newPage();
await printPage.setContent(srcdoc.replace(/<script>[\s\S]*?<\/script>/g, ""));
const pdf = await printPage.pdf({ preferCSSPageSize: true, printBackground: true });
const text = pdf.toString("latin1");
const pageCount = (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
const box = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(text);
const order = [...srcdoc.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
check(
  "Slides PDF: one page per frame, in slide order, each the frame's size",
  pageCount === 3 &&
    box &&
    Math.abs(Number(box[1]) - 600) < 2 && // 800 CSS px = 600 pt
    Math.abs(Number(box[2]) - 337.5) < 2 &&
    order.join("|") === "1. Problem|2. Solution|3. Ask",
  `${pageCount} pages · ${box?.[1]}×${box?.[2]} pt · ${order.join(" | ")}`,
);
if (shots) {
  await printPage.setViewportSize({ width: 800, height: 450 });
  await printPage.screenshot({ path: `${shots}/slides-page1.png` });
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
