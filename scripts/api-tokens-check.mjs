/**
 * API tokens, end to end (docs/26 A6): "make a token in Settings, give it to
 * an agent, and it can do exactly what its scope says — until it's revoked
 * or the workspace turns tokens off." Against the running app
 * (localhost:5173 → API :4387), and Lucent's real MCP server over stdio:
 *
 *   Settings → Security makes a Read token (shown once) → the MCP server,
 *   given it, reads the board but can't change it → a Read & write token
 *   lets it add a node → the list shows both, and Revoke stops one at once →
 *   Admin → Security lists the workspace's tokens, and turning tokens off
 *   stops the other.
 *
 *   node scripts/api-tokens-check.mjs
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const apiBase = process.env.API_URL || "http://127.0.0.1:4387";
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

/** One MCP tool call through Lucent's MCP server, as an agent's client makes it. */
async function mcpCall(token, boardId, name, args) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--conditions=development", "packages/mcp/src/main.ts"],
    {
      env: {
        ...process.env,
        LUCENT_MCP_URL: apiBase,
        LUCENT_MCP_TOKEN: token,
        LUCENT_MCP_BOARD: boardId,
      },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  let out = "";
  const replies = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
    let nl;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/call", params: { name, arguments: args } });
  const reply = await waitFor(() => replies.find((r) => r.id === 2), 30000, 100);
  child.stdin.end();
  child.kill();
  const text = (reply?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return { isError: reply?.result?.isError === true, text };
}

// --- an owner with a board --------------------------------------------------------------------
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
await page.locator('input[type="text"]').first().fill("Ada Agent");
await page.locator('input[type="email"]').first().fill(`ada_${Date.now()}@example.com`);
await page.locator('input[type="password"]').first().fill("api-tokens-check-123");
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
const me = await api("/api/auth/me");
const orgId = `org_personal_${me.body.user.id}`;
const boardId = (
  await api("/api/boards", { method: "POST", body: JSON.stringify({ name: "Launch plan", orgId }) })
).body.id;
await api(`/api/boards/${boardId}/ops`, {
  method: "POST",
  body: JSON.stringify({
    label: "seed",
    ops: [{ op: "CREATE_NODE", id: "beta", nodeType: "process", label: "Open the beta" }],
  }),
});

// --- Settings → Security → API tokens ---------------------------------------------------------
async function makeToken(name, access) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("lucent:open-settings", { detail: "security" })),
  );
  await page.getByLabel("Token name").waitFor({ timeout: 10000 });
  await page.getByLabel("Token name").fill(name);
  await page.getByLabel("Access").selectOption(access);
  await page.getByRole("button", { name: "Create token" }).click();
  const shown = page.getByLabel("New API token");
  await shown.waitFor({ timeout: 10000 });
  const token = (await shown.textContent())?.trim();
  if (shots) await page.screenshot({ path: `${shots}/tokens-made-${access}.png` });
  await page.getByRole("button", { name: "Done" }).click();
  return token;
}
const readToken = await makeToken("Nightly report", "read");
check("Settings makes a Read token and shows it once", /^lct_/.test(readToken ?? ""));

const read = await mcpCall(readToken, boardId, "get_board", {});
check(
  "the MCP server, given it, reads the board",
  !read.isError && read.text.includes("Open the beta"),
  read.text.slice(0, 80),
);
const refused = await mcpCall(readToken, boardId, "apply_canvas_operations", {
  operations: [{ op: "CREATE_NODE", id: "nope", nodeType: "process", label: "Not allowed" }],
});
check("but can't change it", refused.isError, refused.text.slice(0, 100));

const writeToken = await makeToken("Claude Desktop", "write");
const wrote = await mcpCall(writeToken, boardId, "apply_canvas_operations", {
  operations: [{ op: "CREATE_NODE", id: "ga", nodeType: "process", label: "Ship GA" }],
});
const board = await api(`/api/boards/${boardId}`);
check(
  "a Read & write token lets it add a node",
  !wrote.isError && board.body.workspace?.nodes?.ga?.label === "Ship GA",
  wrote.text.slice(0, 80),
);

// --- the list, and Revoke ------------------------------------------------------------------------
await page.evaluate(() =>
  window.dispatchEvent(new CustomEvent("lucent:open-settings", { detail: "security" })),
);
const list = page.getByRole("list", { name: "Your API tokens" });
await list.waitFor({ timeout: 10000 });
const rows = await list.locator("li").allTextContents();
check(
  "Settings lists both, with scope and use — never the token",
  rows.length === 2 &&
    rows.some((r) => /Claude Desktop.*Read & write/.test(r)) &&
    rows.some((r) => /Nightly report.*Read/.test(r)) &&
    !rows.join(" ").includes(readToken),
  JSON.stringify(rows),
);
if (shots) await page.screenshot({ path: `${shots}/tokens-list.png` });
await page.getByRole("button", { name: "Revoke Nightly report" }).click();
await waitFor(async () => ((await list.locator("li").count()) === 1 ? true : null));
const afterRevoke = await fetch(`${apiBase}/api/boards/${boardId}`, {
  headers: { authorization: `Bearer ${readToken}` },
});
check("Revoke stops it at once", afterRevoke.status === 401, `status ${afterRevoke.status}`);
await page.keyboard.press("Escape");

// --- Admin → Security ------------------------------------------------------------------------------
await page.goto(`${base}/?view=admin`, { waitUntil: "networkidle" });
const orgList = page.getByRole("list", { name: "API tokens for this workspace" });
await orgList.waitFor({ timeout: 15000 });
const orgRows = await orgList.locator("li").allTextContents();
check(
  "Admin lists the workspace's tokens and whose they are",
  orgRows.length === 1 && /Claude Desktop.*Ada Agent/.test(orgRows[0]),
  JSON.stringify(orgRows),
);
await page.getByRole("checkbox", { name: /Allow API tokens/ }).uncheck();
const stopped = await waitFor(async () => {
  const r = await fetch(`${apiBase}/api/boards/${boardId}`, {
    headers: { authorization: `Bearer ${writeToken}` },
  });
  return r.status === 403 ? true : null;
});
check("turning tokens off stops every one", stopped);
if (shots) await page.screenshot({ path: `${shots}/admin-tokens.png`, fullPage: true });

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
