/**
 * Connecting a tracker, end to end (docs/26 A5): "an owner connects Linear,
 * Jira or GitHub from Admin, learns at once whether it works, and sees when
 * it stops working." Against the running app (localhost:5173 → API :4387),
 * with the server's test tracker:
 *
 *   Admin → Integrations lists what this server can connect → Connect the
 *   test tracker with a key variable → saved and checked in one step:
 *   "Connected", "Last answered just now" → Disconnect → "Disconnected" →
 *   Reconnect → connected again (it used to stay disconnected whatever was
 *   saved).
 *
 *   node scripts/integrations-check.mjs
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

// --- an owner -----------------------------------------------------------------------
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Ivy Integrate");
await page.locator('input[type="email"]').first().fill(`integ_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("integ-check-123");
await page.getByRole("button", { name: /create account/i }).click();
await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);

// --- Admin → Integrations -------------------------------------------------------------
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const list = page.getByRole("list", { name: "Integrations" });
await list.waitFor({ timeout: 15000 });
const row = list.locator(".integ-row").filter({ hasText: "Test tracker" });
check(
  "Admin lists what this server can connect",
  (await row.count()) === 1 &&
    (await row.locator(".integ-state").textContent()) === "Not connected",
  (await list.locator(".integ-name").allTextContents()).join(" | "),
);

await row.getByRole("button", { name: "Connect" }).click();
const form = page.getByRole("form", { name: "Connect Test tracker" });
await form.getByRole("button", { name: "Save and check" }).click();
check(
  "the form says what's missing instead of saving half a connection",
  /Fill in the key's variable/.test((await form.getByRole("alert").textContent()) ?? ""),
);
await form.getByLabel("Key variable").fill("LUCENT_TEST_TRACKER_KEY");
await shot("integrations-form");
await form.getByRole("button", { name: "Save and check" }).click();
const connected = await waitFor(async () =>
  (await row.locator(".integ-state").textContent()) === "Connected" ? true : null,
);
await shot("integrations-connected");
check(
  "saving checks it: connected, and it answered",
  connected &&
    /connected — it answered/.test((await row.locator(".integ-notice").textContent()) ?? "") &&
    /Last answered just now/.test((await row.locator(".integ-detail").textContent()) ?? ""),
  (await row.textContent()) ?? "",
);

await row.getByRole("button", { name: "Check" }).click();
const rechecked = await waitFor(async () =>
  /the connection works/.test((await row.locator(".integ-notice").textContent()) ?? ""),
);
check("Check asks it again", rechecked);

await row.getByRole("button", { name: "Disconnect" }).click();
const disconnected = await waitFor(async () =>
  (await row.locator(".integ-state").textContent()) === "Disconnected" ? true : null,
);
check("Disconnect shows it disconnected", disconnected);

await row.getByRole("button", { name: "Reconnect" }).click();
await page
  .getByRole("form", { name: "Connect Test tracker" })
  .getByLabel("Key variable")
  .fill("LUCENT_TEST_TRACKER_KEY");
await page
  .getByRole("form", { name: "Connect Test tracker" })
  .getByRole("button", { name: "Save and check" })
  .click();
const back = await waitFor(async () =>
  (await row.locator(".integ-state").textContent()) === "Connected" ? true : null,
);
check("Reconnect brings it back", back);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
