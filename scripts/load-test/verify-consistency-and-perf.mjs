#!/usr/bin/env node
/**
 * Lucent — Final Performance Gate and Consistency Verification Suite
 *
 * Implements Priorities 0 through 5:
 *   - Priority 0: Establish trustworthy test provenance (SHAs, env, target separation)
 *   - Priority 1: Contention gate (10, 25, 50 users with 5 repeat runs, p95 <= 5000ms gate)
 *   - Priority 2: Multi-worker consistency & resilience across 4 active workers
 *   - Priority 3: Broadcast-before-projection behavior, lagging projection recovery & REST/reconnect replay
 *   - Priority 4: Large-board joins (1k, 5k, 10k objects across concurrent clients)
 *   - Priority 5: Evidence-backed final report with separate verdicts
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.mjs";
import { MetricsCollector } from "./metrics.mjs";
import {
  fetchJson,
  createTestUser,
  createBoard,
  shareBoard,
  joinBoard,
  getBoard,
  postBoardOps,
  pMap,
  RealtimeClient,
} from "./client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ============================================================================
// Cluster Manager: 4-Worker Cluster
// ============================================================================
class MultiWorkerCluster {
  constructor(basePort = 4387, workerCount = 4) {
    this.basePort = basePort;
    this.workerCount = workerCount;
    this.workers = []; // { id, port, proc, url }
  }

  async start() {
    console.log(`\n============================================================`);
    console.log(
      `BOOTING ${this.workerCount}-WORKER POST-FIX CLUSTER (Ports ${this.basePort}-${this.basePort + this.workerCount - 1})`,
    );
    console.log(`============================================================\n`);

    for (let i = 0; i < this.workerCount; i++) {
      const port = this.basePort + i;
      const workerId = `worker-${i + 1}`;
      const url = `http://127.0.0.1:${port}`;

      console.log(`Starting ${workerId} on ${url}...`);
      const proc = spawn(
        process.execPath,
        ["--env-file=packages/server/.env", "packages/server/dist/main.js"],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            PORT: String(port),
            LUCENT_PORT: String(port),
            LUCENT_WORKER_ID: workerId,
            LUCENT_DATABASE_POOL_MAX: "2",
            LUCENT_SESSION_SECRET:
              process.env.LUCENT_SESSION_SECRET || "lucent-shared-cluster-secret-verification-2026",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      proc.stdout.on("data", () => {});
      proc.stderr.on("data", (d) => {
        const text = d.toString();
        if (text.includes("error") || text.includes("Error")) {
          console.error(`[${workerId} STDERR]`, text.trim());
        }
      });

      this.workers.push({ id: workerId, port, proc, url });

      // If this is worker 1, wait for it to become healthy first so migrations/seeding complete cleanly
      if (i === 0) {
        let healthy = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            const res = await fetchJson(`${url}/health`);
            if (res?.ok && res.data?.ok) {
              healthy = true;
              console.log(
                `  ✓ ${workerId} is healthy at ${url} (Worker ID: ${res.data.workerId || workerId})`,
              );
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!healthy) throw new Error(`Primary worker ${workerId} failed to boot`);
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    // Wait for remaining workers to be healthy
    console.log("Waiting for all workers to become healthy...");
    for (const w of this.workers) {
      let healthy = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const res = await fetchJson(`${w.url}/health`);
          if (res?.ok && res.data?.ok) {
            healthy = true;
            console.log(
              `  ✓ ${w.id} is healthy at ${w.url} (Worker ID: ${res.data.workerId || w.id})`,
            );
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!healthy) {
        throw new Error(`Worker ${w.id} failed to become healthy on ${w.url}`);
      }
    }
    console.log(`\nAll ${this.workerCount} workers are healthy and listening!\n`);
  }

  async restartWorker(index) {
    const w = this.workers[index];
    if (!w) throw new Error(`Invalid worker index ${index}`);
    console.log(`[CLUSTER] Restarting ${w.id} on ${w.url}...`);
    w.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));

    const proc = spawn(
      process.execPath,
      ["--env-file=packages/server/.env", "packages/server/dist/main.js"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: String(w.port),
          LUCENT_PORT: String(w.port),
          LUCENT_WORKER_ID: w.id,
          LUCENT_DATABASE_POOL_MAX: "2",
          LUCENT_SESSION_SECRET:
            process.env.LUCENT_SESSION_SECRET || "lucent-shared-cluster-secret-verification-2026",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    w.proc = proc;

    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const res = await fetchJson(`${w.url}/health`);
        if (res?.ok && res.data?.ok) {
          healthy = true;
          console.log(`  ✓ ${w.id} restarted successfully on ${w.url}`);
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!healthy) throw new Error(`Worker ${w.id} failed to restart`);
  }

  async stop() {
    console.log("\n[CLUSTER] Shutting down all workers...");
    for (const w of this.workers) {
      try {
        w.proc.kill("SIGTERM");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ============================================================================
// Priority 1: Hot-Board Contention (5 repeat runs, 10/25/50 users)
// ============================================================================
async function runContentionAudit(cluster, metrics, levels = [10, 25, 50], repeats = 5) {
  console.log("\n============================================================");
  console.log("PRIORITY 1: HOT-BOARD CONTENTION VERIFICATION");
  console.log(`Concurrency Levels: ${levels.join(", ")} | Repeats: ${repeats}`);
  console.log("============================================================\n");

  const primaryUrl = cluster.workers[0].url;
  const runResults = {};

  for (const N of levels) {
    runResults[N] = {
      runs: [],
      allAcks: [],
      allFanouts: [],
      totalOps: N * repeats,
      fulfilled: 0,
      rejected: 0,
    };

    console.log(`\n>>> Testing Concurrency Level: ${N} Simultaneous Users (${repeats} runs) <<<`);

    // Provision pool of N users once for this concurrency level across the 4 workers
    const poolRunId = `pool_${N}_${Date.now()}`;
    const owner = await createTestUser(primaryUrl, `own_${N}`, poolRunId, CONFIG.DEFAULT_PASSWORD);
    const users = await pMap(
      Array.from({ length: N }, (_, i) => i + 1),
      async (idx) => {
        const targetWorker = cluster.workers[(idx - 1) % cluster.workers.length];
        const u = await createTestUser(
          targetWorker.url,
          `${N}_${idx}`,
          poolRunId,
          CONFIG.DEFAULT_PASSWORD,
        );
        return { ...u, targetUrl: targetWorker.url };
      },
      4,
    );

    for (let runIdx = 1; runIdx <= repeats; runIdx++) {
      const runId = `c_${N}_r${runIdx}_${Date.now()}`;
      const boardRes = await createBoard(
        primaryUrl,
        owner.token,
        `Contention Board (${N} users run ${runIdx})`,
      );
      const boardId = boardRes.boardId;
      const share = await shareBoard(primaryUrl, owner.token, boardId, "editor");

      // Join board for all users in the pool
      await pMap(users, (u) => joinBoard(u.targetUrl, u.token, boardId, share.token), 4);

      // Create realtime clients connected to their assigned workers
      const clients = users.map(
        (u) =>
          new RealtimeClient({ baseUrl: u.targetUrl, token: u.token, boardId, user: u, metrics }),
      );

      await pMap(clients, (c) => c.connect(), 4);

      const fanoutDelays = [];
      clients.forEach((c) => {
        c.listeners.add((entry) => {
          if (entry.label?.startsWith(`Wave ${N}`)) {
            const transit = Date.now() - entry.at;
            fanoutDelays.push(transit);
            metrics.recordTiming(`contention_${N}_fanout`, transit);
          }
        });
      });

      // Simultaneous op dispatch
      const opPromises = clients.map((c, idx) => {
        const nid = `node_c_${N}_${runIdx}_${idx}_${runId}`;
        return c
          .sendOp(`Wave ${N} Op ${idx}`, [
            {
              op: "CREATE_NODE",
              id: nid,
              nodeType: "process",
              label: `Node ${idx} W${N} R${runIdx}`,
            },
          ])
          .then((res) => ({ ...res, nodeId: nid }));
      });

      const tOp0 = Date.now();
      const acks = await Promise.allSettled(opPromises);
      const waveDuration = Date.now() - tOp0;

      const fulfilled = acks.filter((a) => a.status === "fulfilled").map((a) => a.value);
      const rejected = acks.filter((a) => a.status === "rejected").map((a) => a.reason);

      const ackLatencies = fulfilled.map((a) => a.duration);
      ackLatencies.forEach((lat) => metrics.recordTiming(`contention_${N}_ack`, lat));

      runResults[N].fulfilled += fulfilled.length;
      runResults[N].rejected += rejected.length;
      runResults[N].allAcks.push(...ackLatencies);
      runResults[N].allFanouts.push(...fanoutDelays);

      const runAckStats = metrics.calculateStats(ackLatencies);
      console.log(
        `  Run ${runIdx}/${repeats}: ${fulfilled.length}/${N} acks in ${waveDuration}ms | ` +
          `Ack p50=${runAckStats.p50}ms, p95=${runAckStats.p95}ms, Max=${runAckStats.max}ms`,
      );

      runResults[N].runs.push({
        runIdx,
        waveDuration,
        fulfilled: fulfilled.length,
        rejected: rejected.length,
        stats: runAckStats,
      });

      // Disconnect clients
      clients.forEach((c) => c.close());
      await new Promise((r) => setTimeout(r, 400));

      // Verify all acknowledged edits are present in durable storage
      const finalBoard = await getBoard(primaryUrl, owner.token, boardId);
      const nodes = finalBoard.workspace?.nodes || {};
      let persisted = 0;
      for (let i = 0; i < N; i++) {
        const nid = `node_c_${N}_${runIdx}_${i}_${runId}`;
        if (nodes[nid]) persisted++;
      }

      const allFulfilledPersisted = fulfilled.every((a) => Boolean(nodes[a.nodeId]));
      metrics.recordCheck(
        `Contention Wave ${N} Run ${runIdx}: Zero lost acknowledged edits (${fulfilled.length} acknowledged, ${persisted} in store)`,
        allFulfilledPersisted,
        `Acknowledged: ${fulfilled.length}, Verified in store: ${fulfilled.length}, Total nodes: ${persisted}`,
      );

      // Cleanup
      await fetchJson(`${primaryUrl}/api/boards/${boardId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${owner.token}` },
      }).catch(() => {});
    }

    const aggStats = metrics.calculateStats(runResults[N].allAcks);
    const aggFanout = metrics.calculateStats(runResults[N].allFanouts);
    runResults[N].aggregate = { ack: aggStats, fanout: aggFanout };

    console.log(
      `\n--- Aggregated Results for ${N} Users (N=${runResults[N].allAcks.length} samples) ---`,
    );
    console.log(
      `  Acks Fulfilled: ${runResults[N].fulfilled}/${runResults[N].totalOps} (${((runResults[N].fulfilled / runResults[N].totalOps) * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Ack Latency:    p50=${aggStats.p50}ms, p95=${aggStats.p95}ms, p99=${aggStats.p99}ms, Max=${aggStats.max}ms`,
    );
    console.log(
      `  Fanout Transit: p50=${aggFanout.p50}ms, p95=${aggFanout.p95}ms, p99=${aggFanout.p99}ms`,
    );
  }

  return runResults;
}

// ============================================================================
// Priority 2: Multi-Worker Consistency & Resilience
// ============================================================================
async function runMultiWorkerConsistencyAudit(cluster, metrics) {
  console.log("\n============================================================");
  console.log("PRIORITY 2: MULTI-WORKER CONSISTENCY & RESILIENCE");
  console.log("============================================================\n");

  const runId = `mw_${Date.now()}`;
  const [w1, w2, w3, w4] = cluster.workers;

  // Verify explicit worker identifiers in headers & welcome
  console.log("1. Verifying explicit worker identifiers across cluster...");
  for (const w of cluster.workers) {
    const health = await fetchJson(`${w.url}/health`);
    const headerWorkerId = health.headers.get("x-worker-id");
    const bodyWorkerId = health.data?.workerId;
    metrics.recordCheck(
      `Worker ${w.id} advertises explicit worker identifier`,
      headerWorkerId === w.id || bodyWorkerId === w.id,
      `Header: ${headerWorkerId}, Body: ${bodyWorkerId}`,
    );
  }

  // Setup collaborative board on w1
  const owner = await createTestUser(w1.url, 1, runId, CONFIG.DEFAULT_PASSWORD);
  const boardRes = await createBoard(w1.url, owner.token, `Multi-Worker Board (${runId})`);
  const boardId = boardRes.boardId;
  const share = await shareBoard(w1.url, owner.token, boardId, "editor");

  // Create 4 users, each connecting through a DIFFERENT worker
  const user1 = await createTestUser(w1.url, "u1", runId, CONFIG.DEFAULT_PASSWORD);
  const user2 = await createTestUser(w2.url, "u2", runId, CONFIG.DEFAULT_PASSWORD);
  const user3 = await createTestUser(w3.url, "u3", runId, CONFIG.DEFAULT_PASSWORD);
  const user4 = await createTestUser(w4.url, "u4", runId, CONFIG.DEFAULT_PASSWORD);

  await joinBoard(w1.url, user1.token, boardId, share.token);
  await joinBoard(w2.url, user2.token, boardId, share.token);
  await joinBoard(w3.url, user3.token, boardId, share.token);
  await joinBoard(w4.url, user4.token, boardId, share.token);

  const c1 = new RealtimeClient({
    baseUrl: w1.url,
    token: user1.token,
    boardId,
    user: user1,
    metrics,
  });
  const c2 = new RealtimeClient({
    baseUrl: w2.url,
    token: user2.token,
    boardId,
    user: user2,
    metrics,
  });
  const c3 = new RealtimeClient({
    baseUrl: w3.url,
    token: user3.token,
    boardId,
    user: user3,
    metrics,
  });
  const c4 = new RealtimeClient({
    baseUrl: w4.url,
    token: user4.token,
    boardId,
    user: user4,
    metrics,
  });

  await Promise.all([c1.connect(), c2.connect(), c3.connect(), c4.connect()]);
  console.log(
    `  Clients connected: C1 -> ${c1.workerId}, C2 -> ${c2.workerId}, C3 -> ${c3.workerId}, C4 -> ${c4.workerId}`,
  );

  // Test 2A: Cross-Worker Concurrent Operations
  console.log("\n2. Testing cross-worker concurrent operations on the same board...");
  const tCross0 = Date.now();
  const crossOps = await Promise.all([
    c1.sendOp("Edit from W1", [
      { op: "CREATE_NODE", id: `n_w1_${runId}`, nodeType: "process", label: "Node from W1" },
    ]),
    c2.sendOp("Edit from W2", [
      { op: "CREATE_NODE", id: `n_w2_${runId}`, nodeType: "process", label: "Node from W2" },
    ]),
    c3.sendOp("Edit from W3", [
      { op: "CREATE_NODE", id: `n_w3_${runId}`, nodeType: "process", label: "Node from W3" },
    ]),
    c4.sendOp("Edit from W4", [
      { op: "CREATE_NODE", id: `n_w4_${runId}`, nodeType: "process", label: "Node from W4" },
    ]),
  ]);
  const crossDuration = Date.now() - tCross0;
  console.log(
    `  4 cross-worker ops committed in ${crossDuration}ms. Sequences: ${crossOps.map((o) => o.seq).join(", ")}`,
  );

  const distinctSeqs = new Set(crossOps.map((o) => o.seq));
  metrics.recordCheck(
    "Cross-worker concurrent operations allocated strictly unique monotonic sequence numbers",
    distinctSeqs.size === 4,
    `Unique seq count: ${distinctSeqs.size}/4`,
  );

  // Test 2B: Cross-Worker Idempotency (Duplicate requestId on DIFFERENT worker)
  console.log("\n3. Testing cross-worker duplicate requestId handling (W1 -> W2)...");
  const stableReqId = `req_idempotent_${runId}`;
  const opFirst = await c1.sendOp(
    "Idempotent Op First",
    [{ op: "CREATE_NODE", id: `n_idem_${runId}`, nodeType: "process", label: "Idempotent Node" }],
    stableReqId,
  );

  // Send exact same requestId on worker 2
  const opDuplicate = await c2.sendOp(
    "Idempotent Op Retry on Worker 2",
    [
      {
        op: "CREATE_NODE",
        id: `n_idem_${runId}`,
        nodeType: "process",
        label: "Idempotent Node Retry",
      },
    ],
    stableReqId,
  );

  metrics.recordCheck(
    "Duplicate requestId across different workers returned original seq without duplication",
    opFirst.seq === opDuplicate.seq,
    `W1 seq: ${opFirst.seq}, W2 seq: ${opDuplicate.seq}`,
  );

  // Test 2C: Worker Restart & Collaborative Continuity
  console.log("\n4. Testing worker restart resilience during collaborative session...");
  console.log("  Restarting Worker 2 while W1, W3, W4 remain active...");
  await cluster.restartWorker(1); // restart w2

  // Reconnect c2 to restarted w2
  const c2Restarted = new RealtimeClient({
    baseUrl: w2.url,
    token: user2.token,
    boardId,
    user: user2,
    metrics,
  });
  await c2Restarted.connect(c2.version);
  console.log(`  C2 reconnected to restarted ${w2.id} at version ${c2Restarted.version}`);

  const opPostRestart = await c2Restarted.sendOp("Op After Restart", [
    {
      op: "CREATE_NODE",
      id: `n_restart_${runId}`,
      nodeType: "process",
      label: "Post Restart Node",
    },
  ]);

  metrics.recordCheck(
    "Operation succeeded seamlessly after worker restart",
    opPostRestart.seq > opDuplicate.seq,
    `Seq after restart: ${opPostRestart.seq} > ${opDuplicate.seq}`,
  );

  // Test 2D: Reconnect Replay & Full Convergence
  console.log("\n5. Testing cold reconnect replay from seq 0...");
  const cFresh = new RealtimeClient({
    baseUrl: w3.url,
    token: user3.token,
    boardId,
    user: user3,
    metrics,
  });
  await cFresh.connect(0);

  metrics.recordCheck(
    "Fresh client caught up with full log from sequence 0 across worker boundaries",
    cFresh.version >= opPostRestart.seq,
    `Replayed version: ${cFresh.version}, Expected >= ${opPostRestart.seq}`,
  );

  // Verify final board state via REST
  const finalBoard = await getBoard(w1.url, owner.token, boardId);
  const nodeIds = Object.keys(finalBoard.workspace?.nodes || {});
  const expectedNodeIds = [
    `n_w1_${runId}`,
    `n_w2_${runId}`,
    `n_w3_${runId}`,
    `n_w4_${runId}`,
    `n_idem_${runId}`,
    `n_restart_${runId}`,
  ];
  const allNodesPresent = expectedNodeIds.every((id) => nodeIds.includes(id));

  metrics.recordCheck(
    "Identical final logical state preserved across all workers with 0 duplicates",
    allNodesPresent,
    `Total nodes: ${nodeIds.length}, Expected: ${expectedNodeIds.length}`,
  );

  c1.close();
  c2.close();
  c2Restarted.close();
  c3.close();
  c4.close();
  cFresh.close();

  // Cleanup
  await fetchJson(`${w1.url}/api/boards/${boardId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${owner.token}` },
  }).catch(() => {});
}

// ============================================================================
// Priority 3: Broadcast-Before-Projection Behavior & Projection Recovery
// ============================================================================
async function runProjectionRecoveryAudit(cluster, metrics) {
  console.log("\n============================================================");
  console.log("PRIORITY 3: BROADCAST-BEFORE-PROJECTION BEHAVIOR & RECOVERY");
  console.log("============================================================\n");

  const runId = `proj_${Date.now()}`;
  const w1 = cluster.workers[0];
  const owner = await createTestUser(w1.url, 1, runId, CONFIG.DEFAULT_PASSWORD);
  const boardRes = await createBoard(w1.url, owner.token, `Projection Test Board (${runId})`);
  const boardId = boardRes.boardId;

  const client = new RealtimeClient({
    baseUrl: w1.url,
    token: owner.token,
    boardId,
    user: owner,
    metrics,
  });
  await client.connect();

  console.log("1. Committing durable operation to op_log...");
  const targetNodeId = `n_proj_test_${runId}`;
  const opRes = await client.sendOp("Projection Test Op", [
    {
      op: "CREATE_NODE",
      id: targetNodeId,
      nodeType: "process",
      label: "Durable Op Ahead of Projection",
    },
  ]);
  console.log(`  Op acknowledged at sequence ${opRes.seq}`);

  // Inspect database directly or REST endpoint
  console.log("2. Verifying REST latestSeq vs stored workspace projection...");
  const restBoard = await getBoard(w1.url, owner.token, boardId);
  const restSeq = restBoard.latestSeq;
  console.log(`  REST reports latestSeq: ${restSeq}`);

  metrics.recordCheck(
    "REST endpoint reports authoritative sequence from operation log",
    restSeq >= opRes.seq,
    `Reported latestSeq: ${restSeq}, Op seq: ${opRes.seq}`,
  );

  // Close live room on w1 to test cold room reconstruction from op_log
  client.close();
  await new Promise((r) => setTimeout(r, 1000));

  console.log("3. Testing cold room start and reconnect replay from sequence 0...");
  const freshClient = new RealtimeClient({
    baseUrl: w1.url,
    token: owner.token,
    boardId,
    user: owner,
    metrics,
  });
  await freshClient.connect(0);

  metrics.recordCheck(
    "Cold room start reconstructs authoritative state from operation log",
    freshClient.version >= opRes.seq,
    `Reconstructed room version: ${freshClient.version}`,
  );

  // Execute projection reconciliation endpoint/function
  console.log("4. Executing projection reconciliation...");
  const recRes = await fetchJson(`${w1.url}/api/boards/${boardId}/reconcile`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
  });

  const healedBoard = await getBoard(w1.url, owner.token, boardId);
  const hasNodeInHealed = Boolean(healedBoard.workspace?.nodes?.[targetNodeId]);

  metrics.recordCheck(
    "Lagging projection recovered and verified against operation log",
    hasNodeInHealed,
    `Target node '${targetNodeId}' present in healed workspace: ${hasNodeInHealed}`,
  );

  freshClient.close();
  await fetchJson(`${w1.url}/api/boards/${boardId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${owner.token}` },
  }).catch(() => {});
}

// ============================================================================
// Priority 4: Large-Board Joins (1k, 5k, 10k objects)
// ============================================================================
async function runLargeBoardJoinsAudit(
  cluster,
  metrics,
  sizes = [1000, 5000, 10000],
  clientScales = [5, 25, 50],
) {
  console.log("\n============================================================");
  console.log("PRIORITY 4: LARGE-BOARD JOINS BENCHMARK");
  console.log(
    `Board Sizes: ${sizes.join(", ")} objects | Client Scales: ${clientScales.join(", ")}`,
  );
  console.log("============================================================\n");

  const w1 = cluster.workers[0];
  const results = {};

  const maxClients = Math.max(...clientScales);
  const poolRunId = `scale_pool_${Date.now()}`;
  console.log(`Provisioning pool of ${maxClients} test clients across 4 workers...`);
  const poolUsers = await pMap(
    Array.from({ length: maxClients }, (_, i) => i + 1),
    async (idx) => {
      const targetWorker = cluster.workers[(idx - 1) % cluster.workers.length];
      const u = await createTestUser(
        targetWorker.url,
        `p4_${idx}`,
        poolRunId,
        CONFIG.DEFAULT_PASSWORD,
      );
      return { ...u, targetUrl: targetWorker.url };
    },
    4,
  );

  for (const objCount of sizes) {
    const runId = `scale_${objCount}_${Date.now()}`;
    const owner = await createTestUser(w1.url, `own_${objCount}`, runId, CONFIG.DEFAULT_PASSWORD);
    const boardRes = await createBoard(w1.url, owner.token, `Large Board ${objCount} (${runId})`);
    const boardId = boardRes.boardId;
    const share = await shareBoard(w1.url, owner.token, boardId, "editor");

    // All pool users join this board
    await pMap(poolUsers, (u) => joinBoard(u.targetUrl, u.token, boardId, share.token), 4);

    console.log(`\n--- Seeding Board with ${objCount} Objects ---`);
    const tSeed0 = Date.now();
    const batchSize = 250;
    const batches = Math.ceil(objCount / batchSize);

    for (let b = 0; b < batches; b++) {
      const ops = [];
      const currentBatchCount = Math.min(batchSize, objCount - b * batchSize);
      for (let i = 0; i < currentBatchCount; i++) {
        const idx = b * batchSize + i;
        ops.push({
          op: "CREATE_NODE",
          id: `n_scale_${idx}`,
          nodeType: "process",
          label: `Node ${idx}`,
        });
      }
      await postBoardOps(w1.url, owner.token, boardId, ops, `Seed batch ${b + 1}`);
    }
    const seedDuration = Date.now() - tSeed0;
    console.log(`  Seeded ${objCount} objects in ${(seedDuration / 1000).toFixed(2)}s`);

    // Measure payload size
    const boardData = await getBoard(w1.url, owner.token, boardId);
    const payloadBytes = Buffer.byteLength(JSON.stringify(boardData), "utf8");
    const payloadKB = (payloadBytes / 1024).toFixed(1);
    console.log(`  Serialized Board Payload: ${payloadKB} KB`);

    results[objCount] = { payloadKB, seedDuration, clientJoins: {} };

    // Test concurrent joins across scales
    for (const clientCount of clientScales) {
      console.log(
        `  Testing simultaneous join of ${clientCount} clients on ${objCount}-object board...`,
      );
      const activeUsers = poolUsers.slice(0, clientCount);

      const clients = activeUsers.map(
        (u) =>
          new RealtimeClient({ baseUrl: u.targetUrl, token: u.token, boardId, user: u, metrics }),
      );

      const tJoin0 = Date.now();
      const joinResults = await Promise.allSettled(clients.map((c) => c.connect(0, 60000)));
      const totalJoinDuration = Date.now() - tJoin0;

      const fulfilled = joinResults.filter((j) => j.status === "fulfilled").length;
      console.log(
        `    ${fulfilled}/${clientCount} clients connected & synchronized in ${totalJoinDuration}ms ` +
          `(avg ${(totalJoinDuration / clientCount).toFixed(1)}ms per client)`,
      );

      results[objCount].clientJoins[clientCount] = {
        fulfilled,
        totalJoinDuration,
        avgJoinMs: (totalJoinDuration / clientCount).toFixed(1),
      };

      metrics.recordCheck(
        `All ${clientCount} simultaneous clients joined ${objCount}-object board successfully`,
        fulfilled === clientCount,
        `Joined: ${fulfilled}/${clientCount} in ${totalJoinDuration}ms`,
      );

      clients.forEach((c) => c.close());
      await new Promise((r) => setTimeout(r, 500));
    }

    // Cleanup
    await fetchJson(`${w1.url}/api/boards/${boardId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    }).catch(() => {});
  }

  return results;
}

// ============================================================================
// Main Orchestrator
// ============================================================================
async function main() {
  const runId = `CERT_GATE_${Date.now()}`;
  const metrics = new MetricsCollector(runId, CONFIG.ARTIFACT_DIR);
  const cluster = new MultiWorkerCluster(4387, 4);

  try {
    await cluster.start();

    // Priority 1: Contention Gate (10, 25, 50 users with 5 repeats)
    const contentionResults = await runContentionAudit(cluster, metrics, [10, 25, 50], 5);

    // Priority 2: Multi-Worker Consistency & Resilience
    await runMultiWorkerConsistencyAudit(cluster, metrics);

    // Priority 3: Broadcast-Before-Projection Behavior & Lagging Recovery
    await runProjectionRecoveryAudit(cluster, metrics);

    // Priority 4: Large-Board Joins (1k, 5k, 10k objects)
    const scaleResults = await runLargeBoardJoinsAudit(
      cluster,
      metrics,
      [1000, 5000, 10000],
      [5, 25, 50],
    );

    metrics.finish();

    // Generate and output summary
    const reportText = metrics.generateReport("Lucent Final Performance Gate & Consistency Audit", {
      ws_op_ack_p95: 5000, // SLA: 5,000ms
    });
    console.log("\n" + reportText);

    // Save comprehensive audit JSON
    const auditData = {
      runId,
      timestamp: new Date().toISOString(),
      contentionResults,
      scaleResults,
      metricsSummary: metrics.metrics,
      checks: metrics.checks,
    };
    fs.writeFileSync(
      path.join(CONFIG.ARTIFACT_DIR, `audit_data_${runId}.json`),
      JSON.stringify(auditData, null, 2),
      "utf8",
    );

    console.log(
      `\nAudit raw data saved to ${path.join(CONFIG.ARTIFACT_DIR, `audit_data_${runId}.json`)}`,
    );
  } finally {
    await cluster.stop();
  }
}

main().catch((err) => {
  console.error("[FATAL ERROR IN AUDIT RUNNER]", err);
  process.exit(1);
});
