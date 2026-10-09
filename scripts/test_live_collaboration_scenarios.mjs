/**
 * Automated Scenario Verification Suite
 * Tests multi-user tenant isolation, realtime WebSocket sync,
 * LiveKit room tokens, AI generation resilience, and OAuth proxying.
 */

const BASE_URL = process.env.TARGET_URL || "https://161.33.167.15.sslip.io";

console.log(`Starting Scenario Test Suite against: ${BASE_URL}\n`);

const results = [];
function record(title, pass, details = "") {
  results.push({ title, pass, details });
  const icon = pass ? "PASS" : "FAIL";
  console.log(`[${icon}] ${title} ${details ? `(${details})` : ""}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, data };
}

async function createTestAccount(name, prefix) {
  const email = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}@lucent.test`;
  const csrf = await fetchJson(`${BASE_URL}/api/auth/csrf`);
  const csrfToken = csrf.data?.token;

  const res = await fetchJson(`${BASE_URL}/api/auth/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({
      email,
      password: "TestPassword123!",
      name,
    }),
  });

  if (res.status !== 201) {
    throw new Error(`Failed to create account ${email}: status ${res.status}`);
  }

  return {
    id: res.data.user.id,
    email,
    token: res.data.token,
    csrfToken,
  };
}

async function runTests() {
  try {
    // -------------------------------------------------------------------------
    // Phase 1: Edge Proxy & OAuth Health
    // -------------------------------------------------------------------------
    console.log("=== Phase 1: Edge Proxy & OAuth Health ===");
    const csrfCheck = await fetchJson(`${BASE_URL}/api/auth/csrf`);
    record(
      "CSRF endpoint reachable and returns token",
      csrfCheck.status === 200 && typeof csrfCheck.data?.token === "string",
    );
    record(
      "OAuth providers configured (Google & GitHub enabled)",
      csrfCheck.data?.oauth?.google === true && csrfCheck.data?.oauth?.github === true,
    );

    const googleStart = await fetch(`${BASE_URL}/api/auth/oauth/google/start`, {
      redirect: "manual",
    });
    record(
      "Google OAuth start returns HTTP 302 redirect",
      googleStart.status === 302 &&
        googleStart.headers.get("location")?.includes("accounts.google.com"),
    );

    const githubStart = await fetch(`${BASE_URL}/api/auth/oauth/github/start`, {
      redirect: "manual",
    });
    record(
      "GitHub OAuth start returns HTTP 302 redirect",
      githubStart.status === 302 &&
        githubStart.headers.get("location")?.includes("github.com/login/oauth/authorize"),
    );

    // -------------------------------------------------------------------------
    // Phase 2: Multi-User Collaboration & Tenant Isolation
    // -------------------------------------------------------------------------
    console.log("\n=== Phase 2: Multi-User Collaboration & Tenant Isolation ===");
    const userA = await createTestAccount("Device A (Owner)", "dev_a");
    const userB = await createTestAccount("Device B (Collaborator)", "dev_b");
    record("Account A and Account B created successfully", !!userA.token && !!userB.token);

    // User A creates a board
    const createBoardRes = await fetchJson(`${BASE_URL}/api/boards`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({ name: "Multi-Device Test Board" }),
    });
    const boardId = createBoardRes.data?.board?.id || createBoardRes.data?.id;
    record(
      "User A created a new board",
      createBoardRes.status === 201 && !!boardId,
      `Board ID: ${boardId}`,
    );

    // User B attempts to access User A's board without invitation
    const uninvitedGet = await fetchJson(`${BASE_URL}/api/boards/${boardId}`, {
      headers: { authorization: `Bearer ${userB.token}` },
    });
    record(
      "Uninvited User B receives 404 for User A's board (Tenant Isolation)",
      uninvitedGet.status === 404,
    );

    // User B attempts to join WS for User A's board
    const ticketB_uninvited = await fetchJson(`${BASE_URL}/api/realtime/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${userB.token}` },
    });
    const wsUrlUninvited =
      BASE_URL.replace(/^http/, "ws") + `/ws?ticket=${ticketB_uninvited.data?.ticket}`;
    const wsUninvited = new WebSocket(wsUrlUninvited);
    const uninvitedWsResult = await new Promise((resolve) => {
      wsUninvited.onopen = () => {
        wsUninvited.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
      };
      wsUninvited.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          resolve(msg);
        } catch {
          resolve(null);
        }
      };
      setTimeout(() => resolve(null), 4000);
    });
    wsUninvited.close();
    record(
      "Uninvited WebSocket join is rejected with error",
      uninvitedWsResult?.type === "error" && uninvitedWsResult?.message === "board not found",
    );

    // User A generates an invitation share link
    const shareRes = await fetchJson(`${BASE_URL}/api/boards/${boardId}/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({ role: "editor" }),
    });
    const inviteToken = shareRes.data?.token;
    record("User A minted an editor share link", shareRes.status === 200 && !!inviteToken);

    // User B redeems the invitation
    const joinRes = await fetchJson(`${BASE_URL}/api/boards/${boardId}/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({ token: inviteToken }),
    });
    record("User B successfully redeemed the invite", joinRes.status === 200);

    // User B can now read the board
    const invitedGet = await fetchJson(`${BASE_URL}/api/boards/${boardId}`, {
      headers: { authorization: `Bearer ${userB.token}` },
    });
    record("User B can now access the board (200 OK)", invitedGet.status === 200);

    // -------------------------------------------------------------------------
    // Phase 3: Realtime WebSocket Bidirectional Synchronization
    // -------------------------------------------------------------------------
    console.log("\n=== Phase 3: Realtime WebSocket Bidirectional Sync ===");
    const ticketA = await fetchJson(`${BASE_URL}/api/realtime/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${userA.token}` },
    });
    const ticketB = await fetchJson(`${BASE_URL}/api/realtime/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${userB.token}` },
    });

    const wsUrlA = BASE_URL.replace(/^http/, "ws") + `/ws?ticket=${ticketA.data?.ticket}`;
    const wsUrlB = BASE_URL.replace(/^http/, "ws") + `/ws?ticket=${ticketB.data?.ticket}`;

    const wsA = new WebSocket(wsUrlA);
    const wsB = new WebSocket(wsUrlB);

    const readyA = new Promise((resolve) => {
      wsA.onopen = () => {
        wsA.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
      };
      wsA.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "welcome" || msg.type === "resync") resolve(msg);
      };
    });

    const readyB = new Promise((resolve) => {
      wsB.onopen = () => {
        wsB.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
      };
      wsB.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "welcome" || msg.type === "resync") resolve(msg);
      };
    });

    const [welcomeA, welcomeB] = await Promise.all([readyA, readyB]);
    record(
      "User A joined realtime room over WebSocket",
      welcomeA?.type === "welcome" || welcomeA?.type === "resync",
    );
    record(
      "User B joined realtime room over WebSocket",
      welcomeB?.type === "welcome" || welcomeB?.type === "resync",
    );

    // Test Op propagation from User A -> User B
    const bReceivedOp = new Promise((resolve) => {
      const listener = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "op") {
          wsB.removeEventListener("message", listener);
          resolve(msg);
        }
      };
      wsB.addEventListener("message", listener);
    });

    wsA.send(
      JSON.stringify({
        type: "op",
        ops: [
          {
            op: "CREATE_NODE",
            id: "node_from_user_a",
            nodeType: "step",
            label: "Created by Device A",
          },
        ],
        label: "Add Node A",
      }),
    );

    const receivedByB = await Promise.race([
      bReceivedOp,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for op on B")), 5000),
      ),
    ]).catch(() => null);

    record(
      "Realtime Op broadcast: Device B received operation from Device A",
      receivedByB?.type === "op" && receivedByB.ops?.some((o) => o.id === "node_from_user_a"),
    );

    // Test Op propagation from User B -> User A
    const aReceivedOp = new Promise((resolve) => {
      const listener = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === "op") {
          wsA.removeEventListener("message", listener);
          resolve(msg);
        }
      };
      wsA.addEventListener("message", listener);
    });

    wsB.send(
      JSON.stringify({
        type: "op",
        ops: [
          {
            op: "CREATE_NODE",
            id: "node_from_user_b",
            nodeType: "step",
            label: "Created by Device B",
          },
        ],
        label: "Add Node B",
      }),
    );

    const receivedByA = await Promise.race([
      aReceivedOp,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for op on A")), 5000),
      ),
    ]).catch(() => null);

    record(
      "Realtime Op broadcast: Device A received operation from Device B",
      receivedByA?.type === "op" && receivedByA.ops?.some((o) => o.id === "node_from_user_b"),
    );

    wsA.close();
    wsB.close();

    // -------------------------------------------------------------------------
    // Phase 4: LiveKit Voice & Video Room Tokens
    // -------------------------------------------------------------------------
    console.log("\n=== Phase 4: LiveKit Voice & Video Room Tokens ===");
    const lkTokenA = await fetchJson(`${BASE_URL}/api/livekit/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({ boardId }),
    });
    record(
      "Device A minted LiveKit token for meeting",
      lkTokenA.status === 200 && typeof lkTokenA.data?.token === "string",
      `Room: ${lkTokenA.data?.room}`,
    );

    const lkTokenB = await fetchJson(`${BASE_URL}/api/livekit/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userB.token}`,
      },
      body: JSON.stringify({ boardId }),
    });
    record(
      "Device B minted LiveKit token for meeting",
      lkTokenB.status === 200 && typeof lkTokenB.data?.token === "string",
      `Room: ${lkTokenB.data?.room}`,
    );

    // -------------------------------------------------------------------------
    // Phase 5: AI Prompting & Ask Mode Resilience
    // -------------------------------------------------------------------------
    console.log("\n=== Phase 5: AI Prompting & Rate-Limiting Resilience ===");
    // Test Ask endpoint
    const askRes = await fetchJson(`${BASE_URL}/api/boards/${boardId}/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        question: "What nodes exist on this board?",
        history: [],
      }),
    });

    const isAskSuccess = askRes.status === 200 && typeof askRes.data?.answer === "string";
    const isAskRateLimited = askRes.status === 429;
    record(
      "AI Ask endpoint handled cleanly (200 with answer OR 429 rate limit backoff)",
      isAskSuccess || isAskRateLimited,
      `Status: ${askRes.status}`,
    );

    // Test Generate endpoint
    const genRes = await fetchJson(`${BASE_URL}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userA.token}`,
      },
      body: JSON.stringify({
        message: "Add a database node connected to the service",
        summary: {
          diagramKind: "flowchart",
          nodes: [{ id: "n1", nodeType: "step", label: "Service" }],
          edges: [],
        },
      }),
    });

    const isGenSuccess = genRes.status === 200 && Array.isArray(genRes.data?.operations);
    const isGenRateLimited = genRes.status === 429;
    record(
      "AI Generate endpoint handled cleanly (200 with ops OR 429 rate limit backoff)",
      isGenSuccess || isGenRateLimited,
      `Status: ${genRes.status}`,
    );
  } catch (err) {
    console.error("Test execution encountered an error:", err);
  } finally {
    console.log("\n============================================================");
    console.log("TEST SUMMARY REPORT");
    console.log("============================================================");
    const passed = results.filter((r) => r.pass).length;
    const total = results.length;
    console.log(`Total assertions: ${total}`);
    console.log(`Passed:           ${passed}`);
    console.log(`Failed:           ${total - passed}`);
    console.log(`Pass Rate:        ${Math.round((passed / total) * 100)}%`);
    console.log("============================================================\n");
  }
}

runTests();
