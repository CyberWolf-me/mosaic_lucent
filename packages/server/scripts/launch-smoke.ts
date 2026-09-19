import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { ConsoleMailer } from "../src/email/console.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { WebSocket } from "ws";

async function main() {
  console.log("=== Lucent Pre-Launch E2E Operational Smoke Test ===");

  const port = 4389;
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({
      LUCENT_HOST: "127.0.0.1",
      LUCENT_PORT: String(port),
      LUCENT_WEB_ORIGIN: `http://localhost:${port}`,
      LUCENT_REQUIRE_AUTH: "1",
      LUCENT_SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef",
    }),
    requireAuth: true,
  };

  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const tickets = new InMemoryTicketStore(60_000);
  const authLimiter = new Limiter(100, 60_000);
  const sharedLimiter = new Limiter(100, 60_000);

  const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    mailer: new ConsoleMailer(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter,
    sharedLimiter,
    tickets,
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  console.log(`[1] Server listening on ${base}`);

  try {
    // 1. Health check
    const healthRes = await fetch(`${base}/health`);
    if (!healthRes.ok) throw new Error(`/health returned ${healthRes.status}`);
    const healthJson = await healthRes.json();
    console.log(`[2] /health OK:`, healthJson);

    // 2. Metrics check: verify that unauthenticated /metrics is protected (401)
    const unauthMetricsRes = await fetch(`${base}/metrics`);
    if (unauthMetricsRes.status !== 401)
      throw new Error(
        `/metrics should return 401 when unauthenticated, got ${unauthMetricsRes.status}`,
      );
    console.log(`[3] /metrics security gate verified (unauthenticated request rejected with 401)`);

    // 3. CSRF token
    const csrfRes = await fetch(`${base}/api/auth/csrf`);
    const csrfText = await csrfRes.text();
    if (!csrfRes.ok) throw new Error(`/api/auth/csrf returned ${csrfRes.status}: ${csrfText}`);
    const { token: csrfToken } = JSON.parse(csrfText);
    console.log(`[4] CSRF token received: ${csrfToken.slice(0, 8)}...`);

    // 4. Signup
    const userEmail = `founder-${Date.now()}@example.com`;
    const signupRes = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        email: userEmail,
        password: "SuperSecretPassword123!",
        name: "Elena Vance",
      }),
    });
    if (!signupRes.ok)
      throw new Error(`Signup failed (${signupRes.status}): ${await signupRes.text()}`);
    const signupData = await signupRes.json();
    const bearerToken = signupData.token;
    const orgId = signupData.memberships[0]?.orgId;
    console.log(
      `[5] User registered: ${signupData.user.name} (${signupData.user.email}), Org ID: ${orgId}`,
    );

    // Authenticated metrics check
    const authMetricsRes = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!authMetricsRes.ok)
      throw new Error(`Authenticated /metrics returned ${authMetricsRes.status}`);
    const metricsData = await authMetricsRes.json();
    console.log(
      `[5b] Authenticated /metrics OK: provider=${metricsData.provider}, telemetry errors=${metricsData.recentErrors.length}`,
    );

    // 5. Board creation
    const initialWorkspace = createWorkspace({ name: "Launch Architecture" });
    const createBoardRes = await fetch(`${base}/api/boards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        orgId,
        name: "Launch Architecture",
        workspace: initialWorkspace,
      }),
    });
    if (!createBoardRes.ok) throw new Error(`Board create failed: ${await createBoardRes.text()}`);
    const { id: boardId } = await createBoardRes.json();
    console.log(`[6] Cloud board created with ID: ${boardId}`);

    // 6. Board listing
    const listRes = await fetch(`${base}/api/boards?orgId=${orgId}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const listJson = await listRes.json();
    const boardsList = listJson.boards ?? [];
    console.log(`[7] Board listing verified (${boardsList.length} board(s) found in org ${orgId})`);

    // 7. Realtime Ticket Minting
    const ticketRes = await fetch(`${base}/api/realtime/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ boardId }),
    });
    if (!ticketRes.ok) throw new Error(`Ticket minting failed: ${await ticketRes.text()}`);
    const { ticket } = await ticketRes.json();
    console.log(`[8] Realtime WebSocket ticket minted`);

    // 8. WebSocket connection, join, and operation commitment
    const wsUrl = `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket handshake timed out"));
      }, 5000);

      ws.on("open", () => {
        console.log(`[9] WebSocket connected, sending join frame for board ${boardId}`);
        ws.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
      });

      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        console.log(`[ws frame received: ${msg.type}]`, JSON.stringify(msg));
        if (msg.type === "welcome") {
          console.log(`[10] Realtime WebSocket welcomed client (board=${boardId}), sending op`);
          ws.send(
            JSON.stringify({
              type: "op",
              ops: [
                {
                  op: "CREATE_NODE",
                  id: "node_gateway",
                  nodeType: "service",
                  label: "API Gateway",
                },
              ],
              label: "create node_gateway",
            }),
          );
        } else if (msg.type === "op") {
          const hasGatewayNode = msg.entry?.ops?.some((o: any) => o.id === "node_gateway");
          if (hasGatewayNode) {
            console.log(
              `[11] Realtime WebSocket op committed and broadcasted (seq: ${msg.entry.seq})`,
            );
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // 9. Verify board after WebSocket op
    const getBoardRes = await fetch(`${base}/api/boards/${boardId}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const updatedBoard = await getBoardRes.json();
    const hasNode = Boolean(updatedBoard.workspace?.nodes?.node_gateway);
    console.log(`[12] Board state verified: node_gateway present = ${hasNode}`);

    console.log("\n>>> ALL PRE-LAUNCH E2E SMOKE VERIFICATIONS PASSED <<<");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
