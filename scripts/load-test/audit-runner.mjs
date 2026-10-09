#!/usr/bin/env node
/**
 * Lucent Concurrency & Performance Audit Runner
 * Executes Phases 1-5 investigations and records raw telemetry.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.mjs";
import { MetricsCollector } from "./metrics.mjs";
import {
  createTestUser,
  createBoard,
  shareBoard,
  joinBoard,
  getBoard,
  postBoardOps,
  RealtimeClient,
  fetchJson,
} from "./client.mjs";

async function pMap(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function scrapeServerMetrics(baseUrl, token) {
  try {
    const jsonRes = await fetchJson(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const promRes = await fetch(`${baseUrl}/metrics/prometheus`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then((r) => r.text())
      .catch(() => "");

    const parsedProm = {};
    for (const line of promRes.split("\n")) {
      if (line && !line.startsWith("#")) {
        const parts = line.split(" ");
        if (parts.length >= 2) {
          parsedProm[parts[0]] = parseFloat(parts[1]);
        }
      }
    }

    return {
      ok: true,
      json: jsonRes.data,
      prom: parsedProm,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Audit Test A: Baseline Hot-Board Contention (LT-02 variant with detailed timing)
 */
export async function runHotBoardContentionAudit(
  baseUrl,
  metrics,
  concurrencyLevels = [10, 25, 50],
) {
  console.log("\n============================================================");
  console.log("PHASE 2 AUDIT: HOT-BOARD CONTENTION INVESTIGATION");
  console.log("============================================================\n");

  const runId = `audit_${Date.now()}`;
  const owner = await createTestUser(baseUrl, 1, runId, CONFIG.DEFAULT_PASSWORD);
  const boardRes = await createBoard(baseUrl, owner.token, `Audit Hot Board (${runId})`);
  const boardId = boardRes.boardId;
  const share = await shareBoard(baseUrl, owner.token, boardId, "editor");

  const results = {};

  try {
    for (const N of concurrencyLevels) {
      console.log(`\n--- Contention Wave: ${N} Simultaneous Users ---`);
      const users = await pMap(
        Array.from({ length: N }, (_, i) => i + 1),
        (idx) => createTestUser(baseUrl, `${N}_${idx}`, runId, CONFIG.DEFAULT_PASSWORD),
        8,
      );

      await pMap(users, (u) => joinBoard(baseUrl, u.token, boardId, share.token), 8);

      const clients = users.map(
        (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
      );

      // Connect all clients
      const tConn0 = Date.now();
      await pMap(clients, (c) => c.connect(), 10);
      const connDuration = Date.now() - tConn0;
      console.log(`  Connected ${N} clients in ${connDuration}ms`);

      // Track peer fanout delivery
      const fanoutDelays = [];
      clients.forEach((c) => {
        c.listeners.add((entry) => {
          if (entry.label?.startsWith(`Contention Wave ${N}`)) {
            const transit = Date.now() - entry.at;
            fanoutDelays.push(transit);
            metrics.recordTiming(`contention_${N}_fanout`, transit);
          }
        });
      });

      // Submit N simultaneous operations at the exact same millisecond
      console.log(`  Dispatching ${N} simultaneous operations...`);
      const opPromises = clients.map((c, idx) => {
        const nid = `node_c_${N}_${idx}_${runId}`;
        return c.sendOp(`Contention Wave ${N} Op ${idx}`, [
          { op: "CREATE_NODE", id: nid, nodeType: "process", label: `Node ${idx} Wave ${N}` },
        ]);
      });

      const tOp0 = Date.now();
      const acks = await Promise.allSettled(opPromises);
      const totalOpDuration = Date.now() - tOp0;

      const fulfilled = acks.filter((a) => a.status === "fulfilled").map((a) => a.value);
      const rejected = acks.filter((a) => a.status === "rejected").map((a) => a.reason);

      const ackLatencies = fulfilled.map((a) => a.duration);
      ackLatencies.forEach((lat) => metrics.recordTiming(`contention_${N}_ack`, lat));

      // Compute wave stats
      const ackStats = metrics.calculateStats(ackLatencies);
      const fanoutStats = metrics.calculateStats(fanoutDelays);

      console.log(`  Results for ${N} simultaneous ops:`);
      console.log(`    Total Wave Duration: ${totalOpDuration}ms`);
      console.log(`    Acks Fulfilled: ${fulfilled.length}/${N}, Rejected: ${rejected.length}`);
      console.log(
        `    Op Ack Latency: Min=${ackStats.min}ms, Avg=${ackStats.avg}ms, p50=${ackStats.p50}ms, p95=${ackStats.p95}ms, Max=${ackStats.max}ms`,
      );
      if (fanoutDelays.length > 0) {
        console.log(
          `    Fanout Transit: Min=${fanoutStats.min}ms, Avg=${fanoutStats.avg}ms, p50=${fanoutStats.p50}ms, p95=${fanoutStats.p95}ms`,
        );
      }

      results[N] = {
        users: N,
        totalOpDuration,
        fulfilled: fulfilled.length,
        rejected: rejected.length,
        ackStats,
        fanoutStats,
      };

      // Disconnect clients cleanly
      clients.forEach((c) => c.close());
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Verify durable storage holds all acknowledged nodes exactly once
    const finalBoard = await getBoard(baseUrl, owner.token, boardId);
    const nodes = finalBoard.workspace?.nodes || {};
    let totalPersistedNodes = 0;
    for (const N of concurrencyLevels) {
      for (let i = 0; i < N; i++) {
        const nid = `node_c_${N}_${i}_${runId}`;
        if (nodes[nid]) totalPersistedNodes++;
      }
    }
    const expectedNodes = concurrencyLevels.reduce((a, b) => a + b, 0);

    metrics.recordCheck(
      `All ${expectedNodes} contended nodes durably persisted without data loss`,
      totalPersistedNodes === expectedNodes,
      `Persisted: ${totalPersistedNodes}/${expectedNodes}`,
    );
  } finally {
    await fetchJson(`${baseUrl}/api/boards/${boardId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    }).catch(() => {});
  }

  return results;
}

/**
 * Audit Test B: Protocol Resilience & Edge Cases (Duplicate, Out-of-order, Replay)
 */
export async function runProtocolResilienceAudit(baseUrl, metrics) {
  console.log("\n============================================================");
  console.log("PHASE 5 AUDIT: PROTOCOL RESILIENCE & EDGE CASES");
  console.log("============================================================\n");

  const runId = `proto_${Date.now()}`;
  const owner = await createTestUser(baseUrl, 1, runId, CONFIG.DEFAULT_PASSWORD);
  const boardRes = await createBoard(baseUrl, owner.token, `Protocol Board (${runId})`);
  const boardId = boardRes.boardId;

  try {
    const client = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await client.connect();

    // 1. Idempotency test (Duplicate requestId)
    console.log("1. Testing idempotent duplicate requestId handling...");
    const fixedReqId = `fixed_req_${runId}`;
    const op1 = await client.sendOp(
      "Idempotent Op 1",
      [{ op: "CREATE_NODE", id: `n_idem_${runId}`, nodeType: "process", label: "Idempotent Node" }],
      fixedReqId,
    );

    // Send exact same requestId again
    const op1Duplicate = await client.sendOp(
      "Idempotent Op 1 Duplicate",
      [
        {
          op: "CREATE_NODE",
          id: `n_idem_${runId}`,
          nodeType: "process",
          label: "Idempotent Node Duplicate",
        },
      ],
      fixedReqId,
    );

    metrics.recordCheck(
      "Duplicate requestId acknowledged without error or duplication",
      op1.seq === op1Duplicate.seq,
      `Original seq: ${op1.seq}, Duplicate seq: ${op1Duplicate.seq}`,
    );

    // 2. Out-of-order reconnect catchup
    console.log("2. Testing reconnect catchup from historical sequence...");
    client.close();
    await new Promise((r) => setTimeout(r, 500));

    // Reconnect with fromSeq = 0
    const reconnectedClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await reconnectedClient.connect(0);

    metrics.recordCheck(
      "Reconnected client caught up with full log from sequence 0",
      reconnectedClient.version >= op1.seq,
      `Client version: ${reconnectedClient.version}, Expected >= ${op1.seq}`,
    );

    reconnectedClient.close();
  } finally {
    await fetchJson(`${baseUrl}/api/boards/${boardId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.token}` },
    }).catch(() => {});
  }
}

/**
 * Main Audit Runner
 */
async function main() {
  const runId = `AUDIT_${Date.now()}`;
  const metrics = new MetricsCollector(runId, CONFIG.ARTIFACT_DIR);
  const target = CONFIG.TARGET_URL;

  console.log("============================================================");
  console.log("LUCENT POST-CERTIFICATION PERFORMANCE & CONCURRENCY AUDIT");
  console.log(`Target:      ${target}`);
  console.log(`Run ID:      ${runId}`);
  console.log("============================================================\n");

  // Step 1: Baseline system metrics
  const diagUser = await createTestUser(target, 0, runId, CONFIG.DEFAULT_PASSWORD);
  const preMetrics = await scrapeServerMetrics(target, diagUser.token);
  console.log("Pre-Test Server Health & Metrics:");
  console.log(`  Uptime: ${preMetrics.json?.uptimeSeconds}s`);
  console.log(
    `  Memory Resident: ${preMetrics.prom?.lucent_process_resident_memory_bytes ? (preMetrics.prom.lucent_process_resident_memory_bytes / 1024 / 1024).toFixed(1) + "MB" : "N/A"}`,
  );
  console.log(
    `  Node Heap Used:  ${preMetrics.prom?.lucent_nodejs_heap_used_bytes ? (preMetrics.prom.lucent_nodejs_heap_used_bytes / 1024 / 1024).toFixed(1) + "MB" : "N/A"}`,
  );

  // Step 2: Protocol resilience
  await runProtocolResilienceAudit(target, metrics);

  // Step 3: Hot-Board contention investigation (10, 25, 50)
  const contentionResults = await runHotBoardContentionAudit(target, metrics, [10, 25, 50]);

  // Step 4: Post-test system metrics
  const postMetrics = await scrapeServerMetrics(target, diagUser.token);
  console.log("\nPost-Test Server Health & Metrics:");
  console.log(`  Uptime: ${postMetrics.json?.uptimeSeconds}s`);
  console.log(
    `  Node Heap Used: ${postMetrics.prom?.lucent_nodejs_heap_used_bytes ? (postMetrics.prom.lucent_nodejs_heap_used_bytes / 1024 / 1024).toFixed(1) + "MB" : "N/A"}`,
  );

  metrics.finish();
  const report = metrics.generateReport(
    "Lucent Post-Certification Performance & Concurrency Audit",
    {
      ws_op_ack_p95: 500,
    },
  );
  console.log("\n" + report);
}

main().catch((err) => {
  console.error("[FATAL AUDIT ERROR]", err);
  process.exit(1);
});
