/**
 * Requiring two-step verification, end to end (docs/26 A6): "an owner can
 * require it, and someone without it is told why they can't get in — and
 * gets in the moment they turn it on." Against the running app
 * (localhost:5173 → API :4387):
 *
 *   the owner can't require it before having it → sets it up in Settings →
 *   Security with an authenticator code (computed here, as an app would),
 *   saves the recovery codes → requires it in Admin → a guest given a board
 *   finds it closed, with a notice saying why → the notice's "Set it up"
 *   opens Security → the guest turns it on → the board opens.
 *
 *   node scripts/two-factor-check.mjs
 */
import { createHmac } from "node:crypto";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 150 : 0 });
const shots = process.env.SHOTS;

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

/** RFC 6238, as an authenticator app computes it. */
function totp(secretBase32, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of secretBase32.replace(/[\s=]/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function person(name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror ${name}]`, e.message));
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill(name);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill("two-factor-check-123");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
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

/** Settings → Security → set up, with a live code; the recovery codes shown. */
async function enrollInSettings(page) {
  const dialog = page.locator(".settings-modal, [role=dialog]").filter({ hasText: "Security" });
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  const key = await page.getByLabel("Setup key").textContent();
  await page.getByLabel("Code from your authenticator app").fill(totp(key));
  await page.getByRole("button", { name: "Turn on" }).click();
  const codes = await waitFor(async () => {
    const list = page.getByRole("list", { name: "Recovery codes" });
    return (await list.count()) > 0 ? await list.locator("li").count() : null;
  });
  return { key, codes, dialog };
}

const stamp = Date.now();
const owner = await person("Tara Owner", `tara_${stamp}@example.com`);
const guestEmail = `gus_${stamp}@client.example`;
const guest = await person("Gus Guest", guestEmail);
const me = await owner.api("/api/auth/me");
const orgId = `org_personal_${me.body.user.id}`;
const boardId = (
  await owner.api("/api/boards", {
    method: "POST",
    body: JSON.stringify({ name: "Security review", orgId }),
  })
).body.id;
await owner.api(`/api/boards/${boardId}/members`, {
  method: "POST",
  body: JSON.stringify({ email: guestEmail, role: "viewer" }),
});
check(
  "the guest can open the board before anything is required",
  (await guest.api(`/api/boards/${boardId}`)).status === 200,
);

// --- the owner can't require it before having it -------------------------------------------
const page = owner.page;
await page.bringToFront();
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const requireBox = page.getByRole("checkbox", { name: /Require two-step verification/ });
await requireBox.waitFor({ timeout: 15000 });
// A click, not check(): the refusal leaves the box unchecked, as it should.
await requireBox.click();
const refusal = await waitFor(async () => {
  const t = await page.locator(".boards-admin-error").first().textContent();
  return t && /your own account first/.test(t) ? t : null;
});
check("Admin refuses to require it before the owner has it", refusal, refusal);

// --- Settings → Security ---------------------------------------------------------------------
await page.evaluate(() =>
  window.dispatchEvent(new CustomEvent("lucent:open-settings", { detail: "security" })),
);
await page.getByRole("button", { name: "Set up two-step verification" }).waitFor();
const ownerEnroll = await enrollInSettings(page);
check("Settings → Security turns it on and shows 10 recovery codes", ownerEnroll.codes === 10);
if (shots) await page.screenshot({ path: `${shots}/security-recovery.png` });
await page.getByRole("button", { name: "I've saved them" }).click();
const on = await waitFor(async () =>
  /Two-step verification\s*On/.test(
    (await page.locator(".setting-row").first().textContent()) ?? "",
  )
    ? true
    : null,
);
check("and then reads On", on);
await page.keyboard.press("Escape");

// --- Admin: require it -----------------------------------------------------------------------
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
await requireBox.waitFor({ timeout: 15000 });
await requireBox.check();
const required = await waitFor(async () => {
  const s = await owner.api(`/api/orgs/${orgId}/settings`);
  return s.body.effective?.requireTwoFactor === true ? true : null;
});
const chip = await page.locator(".admin-2fa.on").count();
check("the owner requires it from Admin; their row shows 2FA", required && chip > 0);
if (shots) await page.screenshot({ path: `${shots}/admin-security.png`, fullPage: true });

// --- the guest: closed, told why, one click from fixing it -----------------------------------
const gp = guest.page;
await gp.bringToFront();
const closed = await guest.api(`/api/boards/${boardId}`);
check(
  "the guest without it can't open the board",
  closed.status === 404,
  `status ${closed.status}`,
);
await gp.goto(`${base}/?view=dashboard`, { waitUntil: "networkidle" });
const notice = await waitFor(async () => {
  const n = gp.locator(".access-notice");
  return (await n.count()) > 0 ? await n.textContent() : null;
});
check(
  "a notice says which workspace requires it",
  notice && /Tara Owner.*requires two-step verification/.test(notice),
  notice ?? "",
);
if (shots) await gp.screenshot({ path: `${shots}/access-notice.png` });
await gp.locator(".access-notice").getByRole("button", { name: "Set it up" }).click();
await gp.getByRole("button", { name: "Set up two-step verification" }).waitFor({ timeout: 10000 });
const guestEnroll = await enrollInSettings(gp);
check("its Set it up opens Security, where the guest turns it on", guestEnroll.codes === 10);
const opened = await waitFor(async () =>
  (await guest.api(`/api/boards/${boardId}`)).status === 200 ? true : null,
);
check("and the board opens at once", opened);

// --- nobody slips out by turning theirs off ----------------------------------------------------
const off = await owner.api("/api/auth/2fa/disable", {
  method: "POST",
  body: JSON.stringify({ code: totp(ownerEnroll.key, Date.now() + 30_000) }),
});
check("the owner can't turn theirs off while it's required", off.status === 409, off.body.error);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
