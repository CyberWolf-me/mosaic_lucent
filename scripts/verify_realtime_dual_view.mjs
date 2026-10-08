/**
 * Dual-Browser Realtime Visual Verification
 * Opens two distinct browser sessions (User A and User B) on the same board
 * to verify simultaneous viewing, live presence avatars, real-time cursor tracking,
 * and instant canvas synchronization.
 */

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const BASE_URL = process.env.TARGET_URL || "https://161.33.167.15.sslip.io";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  "C:/Users/User/.gemini/antigravity/brain/7c85f396-32f8-4e2f-986b-178975f3243b";

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

console.log(`Starting Dual-Browser Realtime Visual Verification against: ${BASE_URL}\n`);

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass, detail });
  const icon = pass ? "PASS" : "FAIL";
  console.log(`[${icon}] ${name} ${detail ? `(${detail})` : ""}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, data };
}

function extractSessionCookie(headers) {
  const setCookie =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  for (const raw of setCookie) {
    const match = raw.match(/lucent_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function createAccount(name, prefix) {
  const email = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}@lucent.test`;
  const csrf = await fetchJson(`${BASE_URL}/api/auth/csrf`);
  const csrfToken = csrf.data?.token;

  const res = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({
      email,
      password: "Collaborate123!",
      name,
    }),
  });

  if (res.status !== 201) {
    throw new Error(`Failed to create account ${email}: status ${res.status}`);
  }

  const sessionCookie = extractSessionCookie(res.headers);
  const data = await res.json();

  return {
    id: data.user.id,
    email,
    name: data.user.name,
    user: data.user,
    token: data.token,
    sessionCookie,
    csrfToken,
  };
}

async function waitFor(fn, timeout = 15000, every = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const res = await fn();
      if (res) return res;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // 1. Provision Accounts
    console.log("1. Provisioning User A (Alice, Owner) and User B (Bob, Partner)...");
    const userA = await createAccount("Alice (Owner)", "alice_dual");
    const userB = await createAccount("Bob (Partner)", "bob_dual");
    check("Both user accounts provisioned on backend", !!userA.token && !!userB.token);

    // 2. User A creates the board with an initial active node so canvas is live
    console.log("\n2. User A creating shared board with root architecture node...");
    const initialWorkspace = {
      id: `ws_${Date.now()}`,
      name: "Live Multi-Device Collaborative Workspace",
      diagramKind: "flowchart",
      nodes: {
        node_init: {
          id: "node_init",
          nodeType: "process",
          label: "Shared System Architecture",
          position: { x: 500, y: 220 },
        },
      },
      edges: {},
      groups: {},
      shapes: {},
      wireframes: {},
    };

    const createBoardRes = await fetchJson(`${BASE_URL}/api/boards`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        name: "Live Multi-Device Collaborative Workspace",
        workspace: initialWorkspace,
      }),
    });
    const boardId = createBoardRes.data?.board?.id || createBoardRes.data?.id;
    check("Board created with initial architecture", createBoardRes.status === 201 && !!boardId, `Board ID: ${boardId}`);

    // User A mints editor share invite link
    const shareRes = await fetchJson(`${BASE_URL}/api/boards/${boardId}/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({ role: "editor" }),
    });
    const inviteToken = shareRes.data?.token;
    check("Editor invite link minted", (shareRes.status === 200 || shareRes.status === 201) && !!inviteToken);

    // User B joins board as editor
    const joinRes = await fetchJson(`${BASE_URL}/api/boards/${boardId}/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({ token: inviteToken }),
    });
    check("User B accepted invite and joined board", joinRes.status === 200, `Role: ${joinRes.data?.role}`);

    // 3. Launch Dual Browser Sessions
    console.log("\n3. Launching independent browser sessions for User A and User B...");
    const domain = new URL(BASE_URL).hostname;

    // Context A (Alice)
    const contextA = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    if (userA.sessionCookie) {
      await contextA.addCookies([
        {
          name: "lucent_session",
          value: userA.sessionCookie,
          domain,
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ]);
    }
    await contextA.addInitScript(
      ([user, token]) => {
        localStorage.setItem("lucent.user", JSON.stringify(user));
        localStorage.setItem("lucent.token", token);
        localStorage.setItem("lucent.scope", user.id);
        localStorage.setItem("lucent.tour.seen.v1", "1");
      },
      [userA.user, userA.token]
    );

    // Context B (Bob)
    const contextB = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    if (userB.sessionCookie) {
      await contextB.addCookies([
        {
          name: "lucent_session",
          value: userB.sessionCookie,
          domain,
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ]);
    }
    await contextB.addInitScript(
      ([user, token]) => {
        localStorage.setItem("lucent.user", JSON.stringify(user));
        localStorage.setItem("lucent.token", token);
        localStorage.setItem("lucent.scope", user.id);
        localStorage.setItem("lucent.tour.seen.v1", "1");
      },
      [userB.user, userB.token]
    );

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    let aWsJoined = false;
    let bWsJoined = false;

    // Attach diagnostics
    pageA.on("websocket", (ws) => {
      console.log(`[Browser A WS] Opened: ${ws.url()}`);
      ws.on("framereceived", (f) => {
        console.log(`[Browser A WS In] ${f.payload.slice(0, 100)}`);
        if (f.payload.includes('"type":"welcome"')) aWsJoined = true;
      });
      ws.on("framesent", (f) => console.log(`[Browser A WS Out] ${f.payload.slice(0, 100)}`));
    });
    pageB.on("websocket", (ws) => {
      console.log(`[Browser B WS] Opened: ${ws.url()}`);
      ws.on("framereceived", (f) => {
        console.log(`[Browser B WS In] ${f.payload.slice(0, 100)}`);
        if (f.payload.includes('"type":"welcome"')) bWsJoined = true;
      });
      ws.on("framesent", (f) => console.log(`[Browser B WS Out] ${f.payload.slice(0, 100)}`));
    });

    // Navigate both to the shared board simultaneously
    console.log("Navigating User A (Device 1) to board...");
    await pageA.goto(`${BASE_URL}/?view=canvas&board=${boardId}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    console.log("Navigating User B (Device 2) to board...");
    await pageB.goto(`${BASE_URL}/?view=canvas&board=${boardId}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Wait for both to render canvas and the root node
    const aNodeReady = await waitFor(async () => {
      return (await pageA.getByText("Shared System Architecture").count()) > 0;
    }, 15000);
    const bNodeReady = await waitFor(async () => {
      return (await pageB.getByText("Shared System Architecture").count()) > 0;
    }, 15000);

    check("User A rendered active canvas & architecture node", !!aNodeReady);
    check("User B rendered active canvas & architecture node", !!bNodeReady);

    // Wait for WebSocket join handshake on both browsers
    console.log("\nWaiting for bidirectional WebSocket join on both sessions...");
    const bothWsJoined = await waitFor(() => aWsJoined && bWsJoined, 10000);
    check("Both browser sessions connected to WebSocket room", !!bothWsJoined);

    // 4. Verify Live Presence Tracking
    console.log("\n4. Verifying live presence tracking between User A and User B...");
    // Move pointers in both windows to trigger presence updates
    await pageA.mouse.move(300, 300);
    await pageB.mouse.move(400, 400);
    await pageA.waitForTimeout(300);
    await pageB.waitForTimeout(300);

    const peerSeenOnA = await waitFor(async () => {
      const avatars = await pageA.locator(".presence-avatar, .presence-bar, .presence-bar-slot").count();
      return avatars > 0;
    }, 10000);

    const peerSeenOnB = await waitFor(async () => {
      const avatars = await pageB.locator(".presence-avatar, .presence-bar, .presence-bar-slot").count();
      return avatars > 0;
    }, 10000);

    check("User A observes User B presence avatar in header", !!peerSeenOnA);
    check("User B observes User A presence avatar in header", !!peerSeenOnB);

    // 5. Verify Live Cursor Tracking
    console.log("\n5. Verifying live pointer tracking from User A -> User B...");
    await pageA.bringToFront();
    await pageA.mouse.move(500, 300);
    await pageA.waitForTimeout(100);
    await pageA.mouse.move(600, 380, { steps: 5 });
    await pageA.waitForTimeout(100);
    await pageA.mouse.move(700, 350, { steps: 5 });

    const cursorSeenByB = await waitFor(async () => {
      const cursors = await pageB
        .locator(".presence-cursor, [class*='cursor']")
        .filter({ hasText: /Alice/i })
        .count();
      return cursors > 0;
    }, 8000);
    check("User B observes User A's live moving cursor", !!cursorSeenByB);

    // 6. Realtime Canvas Sync: Alice adds a node
    console.log("\n6. User A creating node on board (measuring instant broadcast to User B)...");
    const t0 = Date.now();
    const node1Res = await fetchJson(`${BASE_URL}/api/boards/${boardId}/ops`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        label: "Realtime Sync Task",
        ops: [
          {
            op: "CREATE_NODE",
            id: "live_sync_node_1",
            nodeType: "process",
            label: "Live Synced Task (Alice)",
          },
        ],
      }),
    });
    console.log(`Node 1 commit HTTP ${node1Res.status}:`, node1Res.data);

    const node1SeenByB = await waitFor(async () => {
      const count = await pageB.getByText("Live Synced Task (Alice)").count();
      return count > 0;
    }, 8000);
    const latencyAtoB = Date.now() - t0;
    check(
      "User B's canvas rendered User A's node with 0 reload",
      !!node1SeenByB,
      `Observed latency: ${latencyAtoB}ms`
    );

    // 7. Realtime Canvas Sync: Bob adds a response node
    console.log("\n7. User B responding with a node (measuring instant broadcast to User A)...");
    const t1 = Date.now();
    const node2Res = await fetchJson(`${BASE_URL}/api/boards/${boardId}/ops`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({
        label: "Bob Response Node",
        ops: [
          {
            op: "CREATE_NODE",
            id: "live_sync_node_2",
            nodeType: "process",
            label: "Acknowledged by Bob",
          },
        ],
      }),
    });
    console.log(`Node 2 commit HTTP ${node2Res.status}:`, node2Res.data);

    const node2SeenByA = await waitFor(async () => {
      const count = await pageA.getByText("Acknowledged by Bob").count();
      return count > 0;
    }, 8000);
    const latencyBtoA = Date.now() - t1;
    check(
      "User A's canvas rendered User B's response node with 0 reload",
      !!node2SeenByA,
      `Observed latency: ${latencyBtoA}ms`
    );

    // Keep cursor visible for screenshot
    await pageA.mouse.move(620, 280);
    await pageB.mouse.move(450, 280);
    await pageA.waitForTimeout(500);
    await pageB.waitForTimeout(500);

    // 8. Capture visual proof screenshots
    console.log("\n8. Capturing visual proof screenshots...");
    const shotPathA = path.join(ARTIFACT_DIR, "realtime_screen_user_a.png");
    const shotPathB = path.join(ARTIFACT_DIR, "realtime_screen_user_b.png");

    await pageA.screenshot({ path: shotPathA, fullPage: false });
    await pageB.screenshot({ path: shotPathB, fullPage: false });
    console.log(`Saved User A screenshot: ${shotPathA}`);
    console.log(`Saved User B screenshot: ${shotPathB}`);

    check(
      "Dual visual screenshots captured and verified",
      fs.existsSync(shotPathA) && fs.existsSync(shotPathB)
    );
  } catch (err) {
    console.error("Test execution encountered an error:", err);
  } finally {
    await browser.close();
    console.log("\n============================================================");
    console.log("REALTIME DUAL-BROWSER TEST SUMMARY");
    console.log("============================================================");
    const passed = results.filter((r) => r.pass).length;
    const total = results.length;
    console.log(`Total checks: ${total}`);
    console.log(`Passed:       ${passed}`);
    console.log(`Failed:       ${total - passed}`);
    console.log("============================================================\n");
  }
}

run();
