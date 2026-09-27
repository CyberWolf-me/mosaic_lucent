/**
 * Follow, spotlight and "bring everyone here", end to end (docs/28 S5):
 * "in a meeting about a board, everyone can be looking at the same place."
 * Against the running app (localhost:5173 → API :4387), two people in two
 * browsers on one shared board:
 *
 *   each sees the other's live cursor → Fay follows Ed and her view lands on
 *   his → Ed takes the spotlight and Fay is on it → Fay scrolls away (taking
 *   over) and can step back in → Fay brings everyone to her view, and Ed can
 *   go back.
 *
 *   node scripts/follow-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 100 : 0 });

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
  await page.locator('input[type="password"]').first().fill("follow-check-123");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  for (let i = 0; i < 5; i++) {
    const s = page.getByRole("button", { name: /^Skip$/ });
    if (!(await s.count())) break;
    await s
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(300);
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
  return { page, api };
}

/**
 * Where a page is looking: the board point at the centre of its canvas, and
 * its zoom — what following shares. Read from the canvas layer's transform
 * (translate, then scale about 50% 40%) and the canvas's size, which differ
 * between two people's screens.
 */
async function camera(page) {
  const got = await page.evaluate(() => {
    const view = document.querySelector(".canvas-viewport");
    const layer = view?.querySelector(":scope > div:nth-child(2)");
    if (!view || !layer) return null;
    const { width: w, height: h } = view.getBoundingClientRect();
    return { t: layer.style.transform, w, h };
  });
  const m = got?.t.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
  if (!m) return null;
  const [px, py, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return { x: 0.5 * got.w - px / s, y: 0.4 * got.h + (0.1 * got.h - py) / s, zoom: s };
}
const near = (a, b) =>
  a && b && Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3 && Math.abs(a.zoom - b.zoom) < 0.02;
/** Wait until a page's camera stops moving, and return it. */
async function settled(page) {
  let last = null;
  return waitFor(
    async () => {
      const now = await camera(page);
      const same = near(now, last);
      last = now;
      return same ? now : null;
    },
    10000,
    300,
  );
}

const stamp = Date.now();
const fay = await person("Fay Lead", `fay_${stamp}@example.com`);
const ed = await person("Ed Mover", `ed_${stamp}@example.com`);

// --- one shared board --------------------------------------------------------------------------
await fay.page.bringToFront();
await fay.page.getByRole("button", { name: "Share board" }).click();
await fay.page.getByRole("button", { name: /publish & start collaborating/i }).click();
await fay.page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(fay.page.url()).searchParams.get("board");
await fay.page.keyboard.press("Escape");
await fay.api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: ["Plan", "Build", "Ship", "Learn"].map((label) => ({
      op: "CREATE_NODE",
      id: label.toLowerCase(),
      nodeType: "process",
      label,
    })),
  }),
});
// Given to Ed by email (a share link needs the owner's address verified first).
await fay.api(`/api/boards/${boardId}/members`, {
  method: "POST",
  body: JSON.stringify({ email: `ed_${stamp}@example.com`, role: "editor" }),
});
for (const p of [fay, ed]) {
  await p.page.goto(`${base}/?view=canvas&board=${boardId}`, { waitUntil: "networkidle" });
}
const avatar = (page, name) =>
  page.getByRole("button", { name: new RegExp(`^(Follow|Following) ${name}$`) });
await avatar(fay.page, "Ed Mover").waitFor({ timeout: 15000 });
await avatar(ed.page, "Fay Lead").waitFor({ timeout: 15000 });

// --- live cursors --------------------------------------------------------------------------------
await fay.page.mouse.move(700, 450);
await fay.page.mouse.move(720, 460, { steps: 5 });
const cursor = await waitFor(
  async () =>
    (await ed.page.locator(".presence-cursor").filter({ hasText: "Fay Lead" }).count()) > 0,
);
check("each sees the other's live cursor", cursor);

// --- follow ---------------------------------------------------------------------------------------
await ed.page.mouse.move(700, 450);
for (let i = 0; i < 6; i++) await ed.page.mouse.wheel(250, 180);
const edView = await settled(ed.page);
const fayBefore = await camera(fay.page);
await avatar(fay.page, "Ed Mover").click();
const followed = await waitFor(async () => {
  const now = await camera(fay.page);
  return near(now, edView) ? now : null;
});
check(
  "Fay follows Ed, and her view lands on his",
  followed && !near(fayBefore, edView),
  JSON.stringify({ ed: edView, fay: await camera(fay.page) }),
);
const chip = await fay.page.locator(".follow-chip").textContent();
check("she's told whom she follows", /Following Ed Mover/.test(chip ?? ""), chip);
await fay.page.locator(".follow-chip").getByRole("button", { name: "Stop" }).click();

// --- spotlight ------------------------------------------------------------------------------------
await ed.page.bringToFront();
await ed.page.getByRole("button", { name: "Spotlight me" }).click();
const onSpot = await waitFor(async () =>
  /Following Ed Mover's spotlight/.test(
    (await fay.page.locator(".follow-chip").textContent()) ?? "",
  ),
);
for (let i = 0; i < 4; i++) await ed.page.mouse.wheel(-200, 120);
const spotView = await settled(ed.page);
const tracked = await waitFor(async () => near(await camera(fay.page), spotView));
check("Ed takes the spotlight and Fay is on it", onSpot && tracked);
if (shots) await fay.page.screenshot({ path: `${shots}/follow-spotlight.png` });

await fay.page.bringToFront();
await fay.page.mouse.move(700, 450);
await fay.page.mouse.wheel(0, 300);
const out = await waitFor(async () =>
  /Ed Mover has the spotlight/.test((await fay.page.locator(".follow-chip").textContent()) ?? ""),
);
await fay.page.locator(".follow-chip").getByRole("button", { name: "Follow" }).click();
const back = await waitFor(async () =>
  /Following Ed Mover's spotlight/.test(
    (await fay.page.locator(".follow-chip").textContent()) ?? "",
  ),
);
check("scrolling away steps her out, and she can step back in", out && back);
await ed.page.locator(".follow-chip").getByRole("button", { name: "Stop" }).click();
await waitFor(async () => (await fay.page.locator(".follow-chip").count()) === 0);

// --- bring everyone here ------------------------------------------------------------------------------
for (let i = 0; i < 5; i++) await fay.page.mouse.wheel(-300, -200);
const fayView = await settled(fay.page);
const edBefore = await camera(ed.page);
await fay.page.getByRole("button", { name: "Bring everyone here" }).click();
const brought = await waitFor(async () => near(await camera(ed.page), fayView));
const told = /Fay Lead brought everyone here/.test(
  (await ed.page
    .locator(".follow-chip")
    .textContent()
    .catch(() => "")) ?? "",
);
check("Fay brings everyone to her view", brought && told);
if (shots) await ed.page.screenshot({ path: `${shots}/follow-summoned.png` });
await ed.page.locator(".follow-chip").getByRole("button", { name: "Go back" }).click();
const returned = await waitFor(async () => near(await camera(ed.page), edBefore));
check(
  "and Ed can go back",
  returned,
  JSON.stringify({ before: edBefore, now: await camera(ed.page) }),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
