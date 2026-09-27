/**
 * "Connect with Linear", the browser's side (docs/26 A5). Against the running
 * app (localhost:5173 → API :4387), with the API started with a placeholder
 * Linear OAuth app and a token key:
 *
 *   LUCENT_TOKEN_KEY=<32 random bytes, base64>
 *   LUCENT_LINEAR_CLIENT_ID=dev-linear-client LUCENT_LINEAR_CLIENT_SECRET=…
 *
 * Linear's sign-in page is intercepted (no call leaves the machine): the
 * check sees Admin offer "Connect with Linear", ask for the team first, send
 * the browser to Linear with a signed state and PKCE, and — when the person
 * declines there — come back to Admin saying so. The token exchange itself is
 * covered against a stub provider in server/test/integration-oauth.test.ts.
 *
 *   node scripts/oauth-connect-check.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

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

// Linear's sign-in page, played by the check: the person declines.
let authorize = null;
await ctx.route("https://linear.app/**", async (route) => {
  authorize = new URL(route.request().url());
  const back = new URL(authorize.searchParams.get("redirect_uri"));
  back.searchParams.set("error", "access_denied");
  back.searchParams.set("state", authorize.searchParams.get("state"));
  await route.fulfill({ status: 302, headers: { location: back.toString() } });
});

await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Otto OAuth");
await page.locator('input[type="email"]').first().fill(`oauth_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("oauth-check-123");
await page.getByRole("button", { name: /create account/i }).click();
await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);

await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const row = page.getByRole("list", { name: "Integrations" }).locator(".integ-row").filter({
  hasText: "Linear",
});
await row.waitFor({ timeout: 15000 });
await row.getByRole("button", { name: "Connect" }).click();
const form = page.getByRole("form", { name: "Connect Linear" });
const button = form.getByRole("button", { name: "Connect with Linear" });
check("Admin offers “Connect with Linear”", (await button.count()) === 1);

await button.click();
check(
  "it asks for the team before leaving",
  /Fill in Team ID/.test((await form.getByRole("alert").textContent()) ?? ""),
);
await form.getByLabel("Team ID").fill("team-1");
await shot("oauth-form");
await button.click();
const returned = await waitFor(() => /oauth=|view=admin/.test(page.url()) && authorize !== null);
check(
  "the browser goes to Linear with a signed state and PKCE",
  returned &&
    authorize.searchParams.get("client_id") === "dev-linear-client" &&
    authorize.searchParams.get("code_challenge_method") === "S256" &&
    (authorize.searchParams.get("state") ?? "").includes(".") &&
    authorize.searchParams.get("redirect_uri").endsWith("/api/integrations/oauth/linear/callback"),
  authorize?.toString().slice(0, 140),
);

const notice = await waitFor(async () => {
  const t = await row.locator(".integ-notice").textContent();
  return t && /didn't allow it/.test(t) && /^Linear/.test(t) ? t : null;
});
await shot("oauth-declined");
check("declining there comes back to Admin, saying so", notice, notice ?? page.url());
check(
  "and the address bar is clean again",
  !/oauth=|reason=/.test(page.url()),
  page.url().replace(base, ""),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
