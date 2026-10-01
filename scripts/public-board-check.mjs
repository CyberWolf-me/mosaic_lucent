/**
 * Anonymous public board view (docs/26): an editor publishes a board, and the
 * /p/:token link renders a read-only snapshot with NO account — the
 * "Made with Lucent" growth loop. Against the running app (5173 → API :4387).
 *
 *   node scripts/public-board-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ headless: process.env.HEADED !== "1" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
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
await page.locator('input[type="text"]').first().fill("Pat Public");
await page.locator('input[type="email"]').first().fill(`pub_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("public-board-123");
await page.getByRole("button", { name: /create account/i }).click();
await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(700);
for (let i = 0; i < 5; i++) {
  const s = page.getByRole("button", { name: /^Skip$/ });
  if (!(await s.count())) break;
  await s
    .first()
    .click({ force: true })
    .catch(() => {});
  await page.waitForTimeout(250);
}
await page.getByRole("button", { name: "Share board" }).click();
await page.getByRole("button", { name: /publish & start collaborating/i }).click();
await page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(page.url()).searchParams.get("board");
await page.keyboard.press("Escape");

// Seed a couple of nodes so the snapshot has something to draw.
await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [
      { op: "CREATE_NODE", id: "a", nodeType: "start", label: "Customer" },
      { op: "CREATE_NODE", id: "b", nodeType: "process", label: "Checkout" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "leads_to" },
    ],
  }),
});

// --- the Share dialog's public toggle (UI path) ---------------------------------------------
await page.getByRole("button", { name: "Share board" }).click();
// The PublicLink toggle carries a distinct aria-label so it never collides with
// the invite-link "Create link" button; waiting on it also gates dialog-open.
const createPublic = page.getByRole("button", { name: "Create public link" });
await createPublic.waitFor({ timeout: 10000 });
await createPublic.click();
const uiUrl = await page
  .waitForFunction(
    () => {
      const el = [...document.querySelectorAll(".mono")].find((n) =>
        /\/p\//.test(n.textContent || ""),
      );
      return el ? el.textContent : null;
    },
    { timeout: 10000 },
  )
  .then((h) => h.jsonValue());
check(
  "the Share dialog's 'Create link' publishes a /p/ URL",
  typeof uiUrl === "string" && /\/p\/[A-Za-z0-9_-]{20,}$/.test(uiUrl),
  uiUrl,
);
await page.keyboard.press("Escape");

// Publish (publish → token).
const pub = await api(`/api/boards/${boardId}/public`, { method: "POST" });
check(
  "publishing a board returns a public token",
  pub.status === 200 && !!pub.body.token,
  pub.body.path,
);
const token = pub.body.token;

// Open /p/:token in a FRESH, cookieless context — a true anonymous visitor.
const anon = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const guest = await anon.newPage();
guest.on("pageerror", (e) => console.log("[guest pageerror]", e.message));
await guest.goto(`${base}/p/${token}`, { waitUntil: "networkidle", timeout: 20000 });
await guest.waitForTimeout(800);
const view = await guest.evaluate(() => ({
  url: location.pathname,
  redirectedToLogin: /login|signup/.test(location.pathname),
  madeWith: !![...document.querySelectorAll("a")].find((a) =>
    /Made with Lucent/i.test(a.textContent || ""),
  ),
  svgs: document.querySelectorAll("main svg").length,
  hasCheckout: (document.querySelector("main")?.textContent || "").includes("Checkout"),
}));
if (shots) await guest.screenshot({ path: `${shots}/public-board.png` });
check(
  "an anonymous visitor sees the read-only board, no login required",
  !view.redirectedToLogin && view.svgs > 0 && view.hasCheckout,
  JSON.stringify(view),
);
check("the board carries a 'Made with Lucent' link", view.madeWith);

// Revoke → the link goes dark.
await api(`/api/boards/${boardId}/public`, { method: "DELETE" });
const gone = await anon.newPage();
await gone.goto(`${base}/p/${token}`, { waitUntil: "networkidle", timeout: 20000 });
await gone.waitForTimeout(600);
const goneText = await gone.evaluate(() => document.body.textContent || "");
check(
  "a revoked link goes dark",
  /isn't public|turned off|deleted/i.test(goneText),
  goneText.slice(0, 80),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
