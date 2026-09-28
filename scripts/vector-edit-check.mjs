/**
 * Vector Studio editing (docs/26 §6.3): gradients drawn whole, simplify,
 * flatten, split into parts and combine — through the inspector, against the
 * running app (localhost:5173 → API :4387), on a shared board so every step
 * is read back from the server.
 *
 *   node scripts/vector-edit-check.mjs
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
await page.locator('input[type="text"]').first().fill("Vera Vector");
await page.locator('input[type="email"]').first().fill(`vec_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("vector-edit-123");
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

// A dense traced-style ring (simplify has work to do), a square, and a
// gradient-filled bar.
const ring = Array.from({ length: 160 }, (_, i) => {
  const a = (i / 160) * Math.PI * 2;
  return `${i ? "L" : "M"}${(50 + 30 * Math.cos(a)).toFixed(2)} ${(50 + 30 * Math.sin(a)).toFixed(2)}`;
}).join("");
const vector = {
  viewBox: [0, 0, 200, 100],
  paths: [
    { d: `${ring}Z`, fill: "#e4572e" },
    { d: "M110 20L150 20L150 60L110 60Z", fill: "#17bebb" },
    { d: "M110 70L190 70L190 90L110 90Z", fill: "#76b041", fillGradient: 0 },
  ],
  gradients: [
    {
      kind: "linear",
      units: "box",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 0,
      stops: [
        { offset: 0, color: "#ffc914" },
        { offset: 1, color: "#76b041" },
      ],
    },
  ],
};
const seeded = await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [
      {
        op: "CREATE_SHAPE",
        id: "art",
        kind: "vector",
        position: { x: 0, y: 0 },
        size: { width: 400, height: 200 },
        vector,
        z: 3,
      },
    ],
  }),
});
check("the API takes a vector with a gradient", seeded.status === 200, `status ${seeded.status}`);

await page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
const art = page.locator(".shape svg").first();
await art.waitFor({ timeout: 15000 });
await page.keyboard.press("Shift+1");
await page.waitForTimeout(800);

// --- gradients draw ------------------------------------------------------------------------------
const drawn = await page.evaluate(() => {
  const svg = document.querySelector(".shape svg");
  const grad = svg?.querySelector("linearGradient");
  const painted = [...(svg?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("fill"));
  return {
    gradient: grad ? grad.querySelectorAll("stop").length : 0,
    ref: painted[2],
    id: grad?.id,
  };
});
check(
  "the gradient draws as a gradient, not a flat colour",
  drawn.gradient === 2 && drawn.ref === `url(#${drawn.id})`,
  JSON.stringify(drawn),
);
if (shots) await page.screenshot({ path: `${shots}/vector-gradient.png` });

const shapesNow = async () =>
  Object.values((await api(`/api/boards/${boardId}`)).body.workspace.shapes).filter(
    (s) => s.kind === "vector",
  );

// --- simplify ------------------------------------------------------------------------------------
await art.click({ position: { x: 100, y: 100 } });
await page.getByRole("button", { name: "Simplify" }).click();
const note = await waitFor(async () => {
  const t = await page
    .locator(".vector-section [role=status]")
    .textContent()
    .catch(() => "");
  return /Simplified/.test(t ?? "") ? t : null;
});
const simplified = await waitFor(async () => {
  const [v] = await shapesNow();
  return v && v.vector.paths[0].d.length < vector.paths[0].d.length ? v : null;
});
check(
  "Simplify: fewer points, the same three parts, and it says by how much",
  note && simplified && simplified.vector.paths.length === 3,
  `${note} · ${vector.paths[0].d.length} → ${simplified?.vector.paths[0].d.length} chars`,
);

// --- flatten ---------------------------------------------------------------------------------------
await page.getByRole("button", { name: "Flat", exact: true }).click();
const flat = await waitFor(async () => {
  const [v] = await shapesNow();
  return v && !v.vector.gradients ? v : null;
});
check(
  "Flat swaps each gradient for its solid colour",
  flat &&
    flat.vector.paths[2].fill === "#76b041" &&
    flat.vector.paths[2].fillGradient === undefined,
);

// --- edit with AI (the offline editor behind the mock provider) ----------------------------------
await page.getByRole("button", { name: "Edit with AI" }).click();
await page.getByLabel("Describe the change").fill("outline only");
await page.getByRole("button", { name: "Preview", exact: true }).click();
const preview = page.getByRole("group", { name: "AI edit preview" });
await preview.waitFor({ timeout: 15000 });
const previewed = {
  figures: await preview.locator("figure svg").count(),
  summary: await preview.locator(".vector-ai-summary").textContent(),
  // Nothing is written until Apply.
  untouched: (await shapesNow())[0].vector.paths[0].fill === "#e4572e",
};
if (shots) await page.screenshot({ path: `${shots}/vector-ai-preview.png` });
check(
  "Edit with AI previews before and after, and changes nothing yet",
  previewed.figures === 2 && /outlines/.test(previewed.summary ?? "") && previewed.untouched,
  JSON.stringify(previewed),
);
await preview.getByRole("button", { name: "Apply" }).click();
const outlined = await waitFor(async () => {
  const [v] = await shapesNow();
  return v && v.vector.paths.every((p) => p.fill === "none") ? v : null;
});
check(
  "Apply writes the edit to the board, with its provenance",
  outlined && outlined.vector.source?.prompt === "outline only",
  JSON.stringify(outlined?.vector.source),
);

// --- split ---------------------------------------------------------------------------------------
await page.getByRole("button", { name: "Split", exact: true }).click();
const parts = await waitFor(async () => {
  const vs = await shapesNow();
  return vs.length === 3 ? vs : null;
});
const selectedLabel = await page
  .locator(".shape-inspector .insp-label")
  .textContent()
  .catch(() => "");
check(
  "Split: a shape per part, where each was drawn, and all three selected",
  parts &&
    !parts.some((s) => s.id === "art") &&
    parts.every((s) => s.vector.paths.length === 1) &&
    /3 selected/.test(selectedLabel ?? ""),
  JSON.stringify(parts?.map((s) => [Math.round(s.position.x), Math.round(s.position.y)])) +
    ` · ${selectedLabel}`,
);
if (shots) await page.screenshot({ path: `${shots}/vector-split.png` });

// --- combine -------------------------------------------------------------------------------------
await page.getByRole("button", { name: "Combine" }).click();
const combined = await waitFor(async () => {
  const vs = await shapesNow();
  return vs.length === 1 && vs[0].vector.paths.length === 3 ? vs[0] : null;
});
check(
  "Combine joins them back into one vector of three parts",
  combined,
  combined && JSON.stringify({ ...combined.position, ...combined.size }),
);

// --- undo ----------------------------------------------------------------------------------------
await page.mouse.click(1200, 700);
await page.keyboard.press("Control+z");
const undone = await waitFor(async () => ((await shapesNow()).length === 3 ? true : null));
check("one undo takes the combine back", undone);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
