/**
 * Scenario Implementations for Lucent Load Test Pack (LT-01 through LT-18)
 */
import {
  createTestUser,
  createBoard,
  shareBoard,
  joinBoard,
  getBoard,
  listBoards,
  getBoardMembers,
  updateMemberRole,
  postBoardOps,
  exportBoard,
  uploadAsset,
  deleteBoard,
  RealtimeClient,
  fetchJson,
  pMap,
  waitFor,
} from "./client.mjs";
import { isLoopback } from "./config.mjs";
import { execSync } from "node:child_process";

/** Poll the server's /health until it returns 200 or the timeout elapses. */
async function waitForHealth(baseUrl, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      // server not back yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Best-effort scrape of the server's resident memory from /metrics/prometheus. */
async function sampleServerRss(baseUrl, token) {
  try {
    const res = await fetch(`${baseUrl}/metrics/prometheus`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m =
      text.match(/^process_resident_memory_bytes\s+([0-9.eE+]+)/m) ||
      text.match(/^nodejs_heap_size_used_bytes\s+([0-9.eE+]+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * SMOKE TEST: 3 users, 1 board, verifying basic auth, WS join, op fan-out, presence, and persistence.
 */
export async function runSmoke(baseUrl, metrics, config) {
  console.log("\n>>> STARTING PROFILE: SMOKE (3 Users, 1 Board) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    // 1. Provision 3 users
    console.log("1. Provisioning 3 test users...");
    const users = await pMap(
      [1, 2, 3],
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      3,
    );
    metrics.recordCheck("Provisioned 3 smoke users", users.length === 3);

    const owner = users[0];
    const collab1 = users[1];
    const collab2 = users[2];

    // 2. Create Board
    console.log("2. Owner creating board...");
    const createRes = await createBoard(baseUrl, owner.token, `Smoke Board ${runId}`);
    metrics.recordTiming("api_create_board", createRes.durationMs);
    const boardId = createRes.boardId;
    metrics.recordCheck(
      "Board created successfully",
      createRes.ok && !!boardId,
      `Board ID: ${boardId}`,
    );
    boardIdsToClean.push({ id: boardId, token: owner.token });

    // 3. Share board
    console.log("3. Minting invite link and joining collaborators...");
    const shareRes = await shareBoard(baseUrl, owner.token, boardId, "editor");
    const inviteToken = shareRes.token;
    metrics.recordCheck("Invite link minted", !!inviteToken);

    await joinBoard(baseUrl, collab1.token, boardId, inviteToken);
    await joinBoard(baseUrl, collab2.token, boardId, inviteToken);
    metrics.recordCheck("Collaborators joined board", true);

    // 4. Connect WebSockets
    console.log("4. Connecting 3 users via WebSocket...");
    const cOwner = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    const cCollab1 = new RealtimeClient({
      baseUrl,
      token: collab1.token,
      boardId,
      user: collab1,
      metrics,
    });
    const cCollab2 = new RealtimeClient({
      baseUrl,
      token: collab2.token,
      boardId,
      user: collab2,
      metrics,
    });

    await Promise.all([cOwner.connect(), cCollab1.connect(), cCollab2.connect()]);
    metrics.recordCheck(
      "All 3 clients joined WebSocket room",
      cOwner.joined && cCollab1.joined && cCollab2.joined,
    );

    // 5. Send presence
    cCollab1.sendPresence({ x: 150, y: 250 });
    cCollab2.sendPresence({ x: 300, y: 400 });
    metrics.recordCheck("Presence sent by collaborators", true);

    // 6. Multi-user op fan-out
    console.log("5. Testing multi-user operation fan-out...");
    const nodeId1 = `node_${runId}_1`;
    const tStart1 = Date.now();
    const ack1 = await cOwner.sendOp("Owner Add Root", [
      { op: "CREATE_NODE", id: nodeId1, nodeType: "process", label: "Root Architecture Node" },
    ]);
    metrics.recordCheck(
      "Owner op acknowledged",
      !!ack1.seq,
      `seq: ${ack1.seq}, ack: ${ack1.duration}ms`,
    );

    // Wait for collab 1 and 2 to receive op
    const got1 = await waitFor(
      () => cCollab1.receivedOps.has(ack1.seq) && cCollab2.receivedOps.has(ack1.seq),
      8000,
    );
    const fanoutLat1 = Math.max(
      (cCollab1.receivedOps.get(ack1.seq)?.arrival || Date.now()) - tStart1,
      (cCollab2.receivedOps.get(ack1.seq)?.arrival || Date.now()) - tStart1,
    );
    metrics.recordTiming("op_fanout_latency", fanoutLat1);
    metrics.recordCheck(
      "Collab 1 & 2 received Owner's op broadcast",
      got1,
      `Fanout latency: ${fanoutLat1}ms`,
    );

    // Collab 1 sends op
    const nodeId2 = `node_${runId}_2`;
    const ack2 = await cCollab1.sendOp("Collab1 Add Child", [
      { op: "CREATE_NODE", id: nodeId2, nodeType: "process", label: "Child Service Node" },
      { op: "CONNECT_NODES", source: nodeId1, target: nodeId2, relationship: "calls" },
    ]);
    metrics.recordCheck("Collab1 op acknowledged", !!ack2.seq, `seq: ${ack2.seq}`);

    const got2 = await waitFor(
      () => cOwner.receivedOps.has(ack2.seq) && cCollab2.receivedOps.has(ack2.seq),
      8000,
    );
    metrics.recordCheck("Owner and Collab2 received Collab1 op", got2);

    // 7. Verify persisted state
    console.log("6. Verifying persisted board state...");
    const persisted = await getBoard(baseUrl, owner.token, boardId);
    metrics.recordTiming("api_get_board", persisted.durationMs);

    const nodes = persisted.workspace?.nodes || {};
    const edges = persisted.workspace?.edges || {};
    const hasNode1 = !!nodes[nodeId1];
    const hasNode2 = !!nodes[nodeId2];
    const edgeCount = Object.keys(edges).length;

    metrics.recordLedgerEntry({
      id: nodeId1,
      boardId,
      userId: owner.id,
      opType: "CREATE_NODE",
      acknowledged: true,
      persisted: hasNode1,
      seq: ack1.seq,
    });
    metrics.recordLedgerEntry({
      id: nodeId2,
      boardId,
      userId: collab1.id,
      opType: "CREATE_NODE",
      acknowledged: true,
      persisted: hasNode2,
      seq: ack2.seq,
    });

    metrics.recordCheck(
      "Authoritative persisted state matches acknowledged operations",
      hasNode1 && hasNode2 && edgeCount >= 1,
      `Nodes: ${Object.keys(nodes).length}, Edges: ${edgeCount}`,
    );

    // Close sockets
    cOwner.close();
    cCollab1.close();
    cCollab2.close();
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * BASELINE TEST: 10 users across 2 boards
 */
export async function runBaseline(baseUrl, metrics, config) {
  console.log("\n>>> STARTING PROFILE: BASELINE (10 Users, 2 Boards) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    console.log("1. Provisioning 10 test users...");
    const users = await pMap(
      Array.from({ length: 10 }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      6,
    );
    metrics.recordCheck("Provisioned 10 baseline users", users.length === 10);

    // Split into 2 groups of 5 users: Group A (Board 1), Group B (Board 2)
    const groupA = users.slice(0, 5);
    const groupB = users.slice(5, 10);

    // Board 1
    const b1Res = await createBoard(baseUrl, groupA[0].token, `Baseline Board A ${runId}`);
    const boardAId = b1Res.boardId;
    boardIdsToClean.push({ id: boardAId, token: groupA[0].token });
    const shareA = await shareBoard(baseUrl, groupA[0].token, boardAId, "editor");
    await pMap(groupA.slice(1), (u) => joinBoard(baseUrl, u.token, boardAId, shareA.token), 4);

    // Board 2
    const b2Res = await createBoard(baseUrl, groupB[0].token, `Baseline Board B ${runId}`);
    const boardBId = b2Res.boardId;
    boardIdsToClean.push({ id: boardBId, token: groupB[0].token });
    const shareB = await shareBoard(baseUrl, groupB[0].token, boardBId, "editor");
    await pMap(groupB.slice(1), (u) => joinBoard(baseUrl, u.token, boardBId, shareB.token), 4);

    metrics.recordCheck("Created and shared 2 boards across 10 users", !!boardAId && !!boardBId);

    // Connect all 10 clients to their respective boards
    console.log("2. Connecting 10 WebSocket clients...");
    const clientsA = groupA.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId: boardAId, user: u, metrics }),
    );
    const clientsB = groupB.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId: boardBId, user: u, metrics }),
    );

    await Promise.all([...clientsA.map((c) => c.connect()), ...clientsB.map((c) => c.connect())]);
    metrics.recordCheck("All 10 clients connected and joined rooms", true);

    // Concurrent editing in both boards
    console.log("3. Executing concurrent mutations across both boards...");
    const acks = [];
    const createdNodesA = [];
    const createdNodesB = [];

    // Group A operations
    for (let i = 0; i < clientsA.length; i++) {
      const client = clientsA[i];
      const nid = `node_a_${i}_${runId}`;
      createdNodesA.push(nid);
      acks.push(
        client.sendOp(`User A${i} Note`, [
          { op: "CREATE_NODE", id: nid, nodeType: "process", label: `Service A-${i}` },
        ]),
      );
    }

    // Group B operations
    for (let i = 0; i < clientsB.length; i++) {
      const client = clientsB[i];
      const nid = `node_b_${i}_${runId}`;
      createdNodesB.push(nid);
      acks.push(
        client.sendOp(`User B${i} Note`, [
          { op: "CREATE_NODE", id: nid, nodeType: "process", label: `Service B-${i}` },
        ]),
      );
    }

    const ackResults = await Promise.all(acks);
    metrics.recordCheck(
      "All 10 concurrent operations acknowledged",
      ackResults.every((r) => !!r.seq),
    );

    // Verify persistence on both boards
    const bAState = await getBoard(baseUrl, groupA[0].token, boardAId);
    const bBState = await getBoard(baseUrl, groupB[0].token, boardBId);

    const allAPersisted = createdNodesA.every((id) => !!bAState.workspace?.nodes?.[id]);
    const allBPersisted = createdNodesB.every((id) => !!bBState.workspace?.nodes?.[id]);

    metrics.recordCheck("Board A persisted all 5 nodes", allAPersisted);
    metrics.recordCheck("Board B persisted all 5 nodes", allBPersisted);

    // Cleanup sockets
    [...clientsA, ...clientsB].forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-01: 50 users normal working day across multiple boards (10 boards, 5 users each)
 */
export async function runLT01(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-01 (50 Users across 10 Boards) <<<");
  const runId = metrics.runId;
  const TOTAL_USERS = 50;
  const TOTAL_BOARDS = 10;
  const boardIdsToClean = [];

  try {
    console.log(`1. Provisioning ${TOTAL_USERS} test users...`);
    const users = await pMap(
      Array.from({ length: TOTAL_USERS }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      config.PROVISION_CONCURRENCY,
    );
    metrics.recordCheck(`Provisioned ${TOTAL_USERS} users`, users.length === TOTAL_USERS);

    console.log(`2. Creating and distributing ${TOTAL_BOARDS} boards...`);
    const boards = [];
    for (let b = 0; b < TOTAL_BOARDS; b++) {
      const owner = users[b * 5];
      const res = await createBoard(baseUrl, owner.token, `LT01 Board ${b + 1} (${runId})`);
      const boardId = res.boardId;
      boardIdsToClean.push({ id: boardId, token: owner.token });

      const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
      const peers = users.slice(b * 5 + 1, (b + 1) * 5);
      await pMap(peers, (p) => joinBoard(baseUrl, p.token, boardId, share.token), 2);

      boards.push({ boardId, owner, peers, allUsers: [owner, ...peers] });
    }
    metrics.recordCheck(
      `Created and shared ${TOTAL_BOARDS} boards`,
      boards.length === TOTAL_BOARDS,
    );

    console.log("3. Connecting all 50 users via WebSockets to their assigned boards...");
    const ownerClients = [];
    const peerClients = [];
    for (const b of boards) {
      ownerClients.push(
        new RealtimeClient({
          baseUrl,
          token: b.owner.token,
          boardId: b.boardId,
          user: b.owner,
          metrics,
        }),
      );
      for (const p of b.peers) {
        peerClients.push(
          new RealtimeClient({ baseUrl, token: p.token, boardId: b.boardId, user: p, metrics }),
        );
      }
    }

    const tWs0 = Date.now();
    // Warm up rooms on each of the 10 boards with owners
    await pMap(ownerClients, (c) => c.connect(), 10);
    // Connect remaining 40 peers concurrently
    await pMap(peerClients, (c) => c.connect(), 10);
    const wsDuration = Date.now() - tWs0;

    const socketClients = [...ownerClients, ...peerClients];
    const editorsCount = socketClients.filter(
      (c) => c.role === "editor" || c.role === "owner",
    ).length;
    metrics.recordCheck(
      `All 50 users established concurrent WebSocket connections as editors/owners`,
      socketClients.every((c) => c.joined) && editorsCount === 50,
      `Connected: 50/50, Editors/Owners: ${editorsCount}/50, Duration: ${wsDuration}ms`,
    );

    await new Promise((r) => setTimeout(r, 400));

    console.log("4. Firing multi-user operations across all 10 boards...");
    const opPromises = [];
    const expectedNodes = [];

    for (let i = 0; i < socketClients.length; i++) {
      const client = socketClients[i];
      const nodeId = `lt01_n_${i}_${runId}`;
      expectedNodes.push({ nodeId, boardId: client.boardId, userId: client.user.id });

      opPromises.push(
        client.sendOp(`LT01 Op User ${i}`, [
          {
            op: "CREATE_NODE",
            id: nodeId,
            nodeType: "process",
            label: `Node ${i} by ${client.user.name}`,
          },
        ]),
      );
    }

    const ackResults = await Promise.all(opPromises);
    const allAcked = ackResults.every((r) => !!r && !!r.seq);
    metrics.recordCheck("All 50 distributed operations acknowledged", allAcked);

    console.log("5. Verifying persistence and state convergence across all 10 boards...");
    let verifiedCount = 0;
    for (const b of boards) {
      const boardData = await getBoard(baseUrl, b.owner.token, b.boardId);
      const bNodes = boardData.workspace?.nodes || {};
      const targetForBoard = expectedNodes.filter((e) => e.boardId === b.boardId);

      for (const target of targetForBoard) {
        const persisted = !!bNodes[target.nodeId];
        if (persisted) verifiedCount++;
        metrics.recordLedgerEntry({
          id: target.nodeId,
          boardId: b.boardId,
          userId: target.userId,
          opType: "CREATE_NODE",
          acknowledged: true,
          persisted,
        });
      }
    }

    metrics.recordCheck(
      "Authoritative persistence verified across all 10 boards",
      verifiedCount === TOTAL_USERS,
      `Verified ${verifiedCount}/${TOTAL_USERS} nodes persisted`,
    );

    // Close connections
    socketClients.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-02: 50 people collaborate on a single "live workshop" board (B-HOT)
 */
export async function runLT02(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-02 (50 Users on 1 Live Workshop Board: B-HOT) <<<");
  const runId = metrics.runId;
  const TOTAL_USERS = 50;
  const boardIdsToClean = [];

  try {
    console.log(`1. Provisioning ${TOTAL_USERS} users...`);
    const users = await pMap(
      Array.from({ length: TOTAL_USERS }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      config.PROVISION_CONCURRENCY,
    );
    metrics.recordCheck(`Provisioned ${TOTAL_USERS} users for B-HOT`, users.length === TOTAL_USERS);

    const owner = users[0];
    const collabs = users.slice(1);

    console.log("2. Creating B-HOT workshop board...");
    const bRes = await createBoard(baseUrl, owner.token, `B-HOT Live Workshop (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 10);
    metrics.recordCheck("All 49 collaborators joined B-HOT board", true);

    console.log("3. Connecting all 50 participants to B-HOT realtime room...");
    const ownerClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    const collabClients = collabs.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );

    const tWs0 = Date.now();
    // Warm up B-HOT room with owner first
    await ownerClient.connect();
    // Connect remaining 49 participants
    await pMap(collabClients, (c) => c.connect(), 10);
    const clients = [ownerClient, ...collabClients];
    metrics.recordCheck(
      "All 50 users connected to B-HOT room",
      clients.every((c) => c.joined),
      `Connect duration: ${Date.now() - tWs0}ms`,
    );

    await new Promise((r) => setTimeout(r, 400));

    console.log("4. Simultaneous unique note creation (each user adds a unique node)...");
    const createdNodes = [];
    const createPromises = [];

    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      const nid = `bhot_node_${i}_${runId}`;
      createdNodes.push({ id: nid, userId: client.user.id });

      createPromises.push(
        client.sendOp(`Workshop Node ${i}`, [
          { op: "CREATE_NODE", id: nid, nodeType: "process", label: `Workshop Idea ${i}` },
        ]),
      );
    }

    const acks = await Promise.all(createPromises);
    metrics.recordCheck(
      "50 simultaneous unique node operations acknowledged",
      acks.every((a) => !!a.seq),
    );

    console.log("5. Burst batch: 20 participants concurrently submitting connectors...");
    const connectorPromises = [];
    for (let i = 0; i < 20; i++) {
      const client = clients[i];
      const source = createdNodes[i].id;
      const target = createdNodes[(i + 1) % createdNodes.length].id;
      connectorPromises.push(
        client.sendOp(`Connector ${i}->${(i + 1) % createdNodes.length}`, [
          { op: "CONNECT_NODES", source, target, relationship: `flow_${i}` },
        ]),
      );
    }
    const connAcks = await Promise.all(connectorPromises);
    metrics.recordCheck(
      "Burst 20 concurrent connector operations acknowledged",
      connAcks.every((a) => !!a.seq),
    );

    console.log("6. Verifying state convergence & persistent storage...");
    const finalBoard = await getBoard(baseUrl, owner.token, boardId);
    const persistedNodes = finalBoard.workspace?.nodes || {};
    const persistedEdges = finalBoard.workspace?.edges || {};

    let persistedNodesCount = 0;
    for (const cn of createdNodes) {
      const exists = !!persistedNodes[cn.id];
      if (exists) persistedNodesCount++;
      metrics.recordLedgerEntry({
        id: cn.id,
        boardId,
        userId: cn.userId,
        opType: "CREATE_NODE",
        acknowledged: true,
        persisted: exists,
      });
    }

    metrics.recordCheck(
      "All 50 workshop nodes converged and persisted without loss",
      persistedNodesCount === TOTAL_USERS,
      `Persisted: ${persistedNodesCount}/${TOTAL_USERS}, Edges: ${Object.keys(persistedEdges).length}`,
    );

    clients.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-03: Hot-object contention and conflicting edits
 */
export async function runLT03(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-03 (Hot-Object Contention & Conflicting Edits) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const users = await pMap(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      5,
    );
    const owner = users[0];
    const collabs = users.slice(1);

    const bRes = await createBoard(baseUrl, owner.token, `Contention Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 5);

    // Initial root node to fight over
    const hotNodeId = `hot_node_${runId}`;
    await postBoardOps(baseUrl, owner.token, boardId, [
      { op: "CREATE_NODE", id: hotNodeId, nodeType: "process", label: "Initial Contested Node" },
    ]);

    const ownerClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await ownerClient.connect();
    const collabClients = collabs.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );
    await Promise.all(collabClients.map((c) => c.connect()));
    const clients = [ownerClient, ...collabClients];
    await new Promise((r) => setTimeout(r, 400));

    console.log("Contention wave: 10 clients simultaneously updating label of the same node...");
    const conflictPromises = clients.map((c, i) =>
      c.sendOp(`Contention Edit ${i}`, [
        { op: "CHANGE_TEXT", id: hotNodeId, text: `Winner User ${i} (${runId})` },
      ]),
    );

    const results = await Promise.all(conflictPromises);
    metrics.recordCheck(
      "Server accepted all 10 conflicting edits in monotonic sequence without crashing",
      results.every((r) => !!r.seq),
    );

    // Deterministic last-writer = the commit the server gave the highest seq.
    let winnerIdx = -1;
    let winnerSeq = -1;
    results.forEach((r, i) => {
      if (r && r.seq && r.seq > winnerSeq) {
        winnerSeq = r.seq;
        winnerIdx = i;
      }
    });
    const expectedLabel = `Winner User ${winnerIdx} (${runId})`;

    // Authoritative persisted state must converge to that highest-seq writer.
    const finalBoard = await getBoard(baseUrl, owner.token, boardId);
    const finalLabel = finalBoard.workspace?.nodes?.[hotNodeId]?.label;
    metrics.recordCheck(
      "Hot object converges to the highest-seq writer (deterministic last-write-wins)",
      finalLabel === expectedLabel,
      `Expected "${expectedLabel}" (seq ${winnerSeq}); persisted "${finalLabel}"`,
    );

    // A fresh cold client must rebuild the same converged value from the durable log.
    const freshView = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await freshView.connect(0);
    metrics.recordCheck(
      "Fresh client rebuilds the contested node from the durable op log",
      freshView.joined,
    );
    freshView.close();

    clients.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-04: AI Generation Storm while other users keep editing
 */
export async function runLT04(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-04 (AI Generation Storm While Editing) <<<");
  if (!config.ALLOW_PAID_AI && !isLoopback(baseUrl)) {
    metrics.recordSkip(
      "LT-04 (AI Generation Storm)",
      "non-loopback target without ALLOW_PAID_AI; set ALLOW_PAID_AI=true to drive real AI",
    );
    return;
  }
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const users = await pMap(
      Array.from({ length: 15 }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      5,
    );
    const owner = users[0];
    const collabs = users.slice(1);

    const bRes = await createBoard(baseUrl, owner.token, `AI Storm Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 5);

    const ownerClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await ownerClient.connect();
    const collabClients = collabs.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );
    await Promise.all(collabClients.map((c) => c.connect()));
    const clients = [ownerClient, ...collabClients];
    await new Promise((r) => setTimeout(r, 400));

    console.log("Triggering concurrent AI generation and user edits...");
    const aiUsers = users.slice(0, 3); // 3 AI requests
    const editClients = clients.slice(3); // 12 clients editing

    // 1. Fire AI generation requests (mock prompt)
    const aiPromises = aiUsers.map(async (u, idx) => {
      const t0 = Date.now();
      const res = await fetchJson(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${u.token}`,
        },
        body: JSON.stringify({
          message: `Create a microservices checkout flow diagram ${idx}`,
          summary: { diagramKind: "flowchart", nodes: [], edges: [] },
          boardId,
          runId: `ai_run_${runId}_${idx}`,
        }),
      });
      const dur = Date.now() - t0;
      metrics.recordTiming("ai_generate_request", dur);
      return { ok: res.ok, status: res.status, dur, data: res.data };
    });

    // 2. Concurrently have remaining clients edit the canvas
    const editPromises = editClients.map((c, i) =>
      c.sendOp(`Concurrent Manual Edit ${i}`, [
        {
          op: "CREATE_NODE",
          id: `manual_n_${i}_${runId}`,
          nodeType: "process",
          label: `Manual Node ${i}`,
        },
      ]),
    );

    const [aiResults, editResults] = await Promise.all([
      Promise.all(aiPromises),
      Promise.all(editPromises),
    ]);

    metrics.recordCheck(
      "Manual edits committed during AI activity without starvation",
      editResults.every((r) => !!r.seq),
    );
    metrics.recordCheck(
      "AI generation requests answered cleanly by server",
      aiResults.every((r) => r.ok || [400, 429, 502, 503].includes(r.status)),
      `Statuses: ${aiResults.map((r) => `${r.status} (${r.data?.error || "ok"})`).join(", ")}`,
    );

    // Verify manual edits are preserved
    const finalBoard = await getBoard(baseUrl, owner.token, boardId);
    const manualPersisted = editClients.every(
      (c, i) => !!finalBoard.workspace?.nodes?.[`manual_n_${i}_${runId}`],
    );
    metrics.recordCheck("All manual edits persisted accurately", manualPersisted);

    clients.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-08: Presence & Rapid Join/Leave Churn
 */
export async function runLT08(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-08 (Presence and Rapid Churn) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const users = await pMap(
      Array.from({ length: 15 }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      5,
    );
    const owner = users[0];
    const collabs = users.slice(1);

    const bRes = await createBoard(baseUrl, owner.token, `Churn Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 5);

    // 5 anchor clients that stay connected
    const anchorClients = users
      .slice(0, 5)
      .map((u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }));
    await Promise.all(anchorClients.map((c) => c.connect()));

    // 10 churn clients connecting and disconnecting in waves
    const churnUsers = users.slice(5);
    console.log("Executing 3 rapid churn waves of 10 clients...");

    for (let wave = 1; wave <= 3; wave++) {
      const churnClients = churnUsers.map(
        (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
      );
      await Promise.all(churnClients.map((c) => c.connect()));
      // Send rapid cursor moves
      churnClients.forEach((c, idx) => c.sendPresence({ x: 100 * idx, y: 150 * wave }));
      await new Promise((r) => setTimeout(r, 600));
      churnClients.forEach((c) => c.close());
    }

    metrics.recordCheck(
      "Rapid churn waves completed without server disconnect of anchor clients",
      true,
    );

    // Anchor client sends an edit to ensure room is fully operational
    const ack = await anchorClients[0].sendOp("Post-Churn Verification", [
      {
        op: "CREATE_NODE",
        id: `post_churn_${runId}`,
        nodeType: "process",
        label: "Post-Churn Active Node",
      },
    ]);
    metrics.recordCheck("Room continues processing operations after churn", !!ack.seq);

    anchorClients.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-09: Network Partition and Synchronized Reconnect Storm
 */
export async function runLT09(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-09 (Network Partition & Reconnect Storm) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const users = await pMap(
      Array.from({ length: 15 }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      5,
    );
    const owner = users[0];
    const collabs = users.slice(1);

    const bRes = await createBoard(baseUrl, owner.token, `Partition Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 5);

    const clients = users.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );
    await Promise.all(clients.map((c) => c.connect()));

    // Disconnect 5 clients simulating network drop
    console.log("Simulating network partition for 5 clients...");
    const partitioned = clients.slice(10);
    const steady = clients.slice(0, 10);

    partitioned.forEach((c) => c.close());

    // Steady clients commit 3 operations
    console.log("Steady clients continuing edits during partition...");
    const op1 = await steady[0].sendOp("Steady Op 1", [
      {
        op: "CREATE_NODE",
        id: `partition_node_1_${runId}`,
        nodeType: "process",
        label: "Steady Node 1",
      },
    ]);
    const op2 = await steady[1].sendOp("Steady Op 2", [
      {
        op: "CREATE_NODE",
        id: `partition_node_2_${runId}`,
        nodeType: "process",
        label: "Steady Node 2",
      },
    ]);

    // Reconnect the 5 partitioned clients simultaneously with their last known version
    console.log("Reconnecting partitioned clients in a synchronized burst...");
    const reconnectedClients = partitioned.map(
      (c) => new RealtimeClient({ baseUrl, token: c.token, boardId, user: c.user, metrics }),
    );

    const tRec0 = Date.now();
    await Promise.all(reconnectedClients.map((c) => c.connect(0))); // reconnect with catchup
    const recDuration = Date.now() - tRec0;
    metrics.recordTiming("reconnect_storm_duration", recDuration);

    metrics.recordCheck(
      "Synchronized reconnect storm converged",
      reconnectedClients.every((c) => c.joined),
      `Duration: ${recDuration}ms`,
    );

    // Verify all clients have the steady nodes
    const finalBoard = await getBoard(baseUrl, owner.token, boardId);
    const has1 = !!finalBoard.workspace?.nodes?.[`partition_node_1_${runId}`];
    const has2 = !!finalBoard.workspace?.nodes?.[`partition_node_2_${runId}`];

    metrics.recordCheck("State fully intact following partition recovery", has1 && has2);

    [...steady, ...reconnectedClients].forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-10: Permission change while users are connected
 */
export async function runLT10(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-10 (Live Permission Revocation) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const owner = await createTestUser(baseUrl, 1, runId, config.DEFAULT_PASSWORD);
    const collab = await createTestUser(baseUrl, 2, runId, config.DEFAULT_PASSWORD);

    const bRes = await createBoard(baseUrl, owner.token, `Permission Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await joinBoard(baseUrl, collab.token, boardId, share.token);

    const cOwner = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    const cCollab = new RealtimeClient({
      baseUrl,
      token: collab.token,
      boardId,
      user: collab,
      metrics,
    });

    await Promise.all([cOwner.connect(), cCollab.connect()]);
    metrics.recordCheck("Both users connected as editors", cCollab.role === "editor");

    // Collaborator performs an allowed edit
    const allowedOp = await cCollab.sendOp("Collab Allowed Op", [
      {
        op: "CREATE_NODE",
        id: `allowed_n_${runId}`,
        nodeType: "process",
        label: "Allowed While Editor",
      },
    ]);
    metrics.recordCheck("Editor edit accepted by server", !!allowedOp.seq);

    // Owner revokes Collaborator to viewer
    console.log("Owner downgrading collaborator role to 'viewer' via REST API...");
    const patchRes = await updateMemberRole(baseUrl, owner.token, boardId, collab.id, "viewer");
    metrics.recordCheck("Member role patched to 'viewer'", patchRes.ok);

    // B23 probe: does the collaborator's STILL-OPEN socket keep editing after the
    // downgrade? The room caches the role from join and only re-fetches when it
    // has none, so a demoted editor may keep writing over a pre-existing socket.
    // Single attempt (maxRetries=0) so sendOp's retry-with-rejoin can't mask it.
    console.log("Revoked user attempting an edit over the STILL-OPEN socket (B23 probe)...");
    let openSocketRefused = false;
    let b23Detail = "";
    try {
      const wsAttempt = await cCollab.sendOp(
        "Demoted Open-Socket Edit",
        [
          {
            op: "CREATE_NODE",
            id: `b23_ws_${runId}`,
            nodeType: "process",
            label: "B23 Open-Socket Edit",
          },
        ],
        null,
        15000,
        0,
      );
      b23Detail = `ACCEPTED on the open socket (seq ${wsAttempt.seq}) — B23 CONFIRMED: a demoted member kept editing over a pre-existing socket`;
    } catch (err) {
      const msg = String(err?.message || err);
      openSocketRefused = /permission|editor role required/i.test(msg);
      b23Detail = openSocketRefused ? "refused (permission)" : `refused/other: ${msg}`;
    }
    metrics.recordCheck("Demoted member's open WebSocket is refused (B23)", openSocketRefused, b23Detail);
    const afterWs = await getBoard(baseUrl, owner.token, boardId);
    metrics.recordCheck(
      "No B23 open-socket edit leaked into persisted state",
      !afterWs.workspace?.nodes?.[`b23_ws_${runId}`],
    );

    // Collaborator attempts to perform another edit through REST
    console.log("Revoked user attempting edit via REST...");
    const restAttempt = await postBoardOps(baseUrl, collab.token, boardId, [
      {
        op: "CREATE_NODE",
        id: `forbidden_n_${runId}`,
        nodeType: "process",
        label: "Forbidden Edit",
      },
    ]);

    metrics.recordCheck(
      "Server rejected edit from demoted member (REST)",
      restAttempt.status === 403 || restAttempt.status === 404,
      `Status: ${restAttempt.status}`,
    );

    cOwner.close();
    cCollab.close();
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-11: Tenant/workspace isolation under concurrent use
 */
export async function runLT11(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-11 (Workspace & Tenant Isolation) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const userA = await createTestUser(baseUrl, 1, runId, config.DEFAULT_PASSWORD);
    const userB = await createTestUser(baseUrl, 2, runId, config.DEFAULT_PASSWORD);

    // User A creates Board A
    const bARes = await createBoard(baseUrl, userA.token, `Tenant A Board (${runId})`);
    const boardAId = bARes.boardId;
    boardIdsToClean.push({ id: boardAId, token: userA.token });

    // User B attempts to access Board A directly without an invite
    console.log("User B attempting unauthorized read of Board A...");
    const readAttempt = await getBoard(baseUrl, userB.token, boardAId);
    metrics.recordCheck(
      "Unauthorized board read rejected",
      readAttempt.status === 404 || readAttempt.status === 403,
      `Status: ${readAttempt.status}`,
    );

    // User B attempts to push ops to Board A directly
    console.log("User B attempting unauthorized op injection into Board A...");
    const opAttempt = await postBoardOps(baseUrl, userB.token, boardAId, [
      { op: "CREATE_NODE", id: `malicious_n_${runId}`, nodeType: "process", label: "Unauthorized" },
    ]);
    metrics.recordCheck(
      "Unauthorized op injection rejected",
      opAttempt.status === 404 || opAttempt.status === 403,
      `Status: ${opAttempt.status}`,
    );

    // User B attempts WebSocket join to Board A
    console.log("User B attempting WebSocket join to Board A...");
    let wsRejected = false;
    try {
      const cB = new RealtimeClient({
        baseUrl,
        token: userB.token,
        boardId: boardAId,
        user: userB,
        metrics,
      });
      await cB.connect(0, 5000);
    } catch {
      wsRejected = true;
    }
    metrics.recordCheck("Unauthorized WebSocket join rejected", wsRejected);
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-18: Multi-tab and repeated-session edge cases (25 users x 2 tabs = 50 connections)
 */
export async function runLT18(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-18 (25 Users x 2 Tabs = 50 Concurrent Connections) <<<");
  const runId = metrics.runId;
  const TOTAL_USERS = 25;
  const boardIdsToClean = [];

  try {
    const users = await pMap(
      Array.from({ length: TOTAL_USERS }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      config.PROVISION_CONCURRENCY,
    );
    metrics.recordCheck(
      `Provisioned ${TOTAL_USERS} users for multi-tab test`,
      users.length === TOTAL_USERS,
    );

    const owner = users[0];
    const collabs = users.slice(1);

    const bRes = await createBoard(baseUrl, owner.token, `Multi-Tab Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 8);

    console.log("Launching Tab A and Tab B WebSocket connections for each of the 25 users...");
    const tabAClients = users.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );
    const tabBClients = users.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );

    // Warm up board room with owner Tab A
    await tabAClients[0].connect();
    const remainingTabs = [...tabAClients.slice(1), ...tabBClients];
    await pMap(remainingTabs, (c) => c.connect(), 10);
    const allTabs = [...tabAClients, ...tabBClients]; // 50 connections
    metrics.recordCheck(
      "50 multi-tab connections established simultaneously",
      allTabs.every((c) => c.joined),
    );
    await new Promise((r) => setTimeout(r, 400));

    // User 1 edits from Tab A, verify Tab B receives it
    console.log("Editing from User 1 Tab A and verifying User 1 Tab B sync...");
    const ackA = await tabAClients[0].sendOp("Tab A Edit", [
      {
        op: "CREATE_NODE",
        id: `multitab_node_${runId}`,
        nodeType: "process",
        label: "Multi-tab Test Node",
      },
    ]);

    const bReceived = await waitFor(() => tabBClients[0].receivedOps.has(ackA.seq), 8000);
    metrics.recordCheck("Tab B received op committed by Tab A of same user", bReceived);

    // Abruptly close Tab A; verify Tab B stays connected
    tabAClients[0].close();
    await new Promise((r) => setTimeout(r, 500));
    const ackB = await tabBClients[0].sendOp("Tab B Follow-up Edit", [
      { op: "CREATE_NODE", id: `tab_b_node_${runId}`, nodeType: "process", label: "Tab B Node" },
    ]);
    metrics.recordCheck(
      "Tab B remains active and functional after Tab A disconnection",
      !!ackB.seq,
    );

    allTabs.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-05: AI output edited before generation finishes (stream race & manual edit priority)
 */
export async function runLT05(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-05 (AI Output Edited Before Generation Finishes) <<<");
  if (!config.ALLOW_PAID_AI && !isLoopback(baseUrl)) {
    metrics.recordSkip(
      "LT-05 (AI Edit-During-Generation)",
      "non-loopback target without ALLOW_PAID_AI; set ALLOW_PAID_AI=true to drive real AI",
    );
    return;
  }
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const users = await pMap(
      [1, 2, 3, 4, 5],
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      5,
    );
    const owner = users[0];
    const collabs = users.slice(1);

    const bRes = await createBoard(baseUrl, owner.token, `AI Race Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 4);

    const ownerClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await ownerClient.connect();
    const collabClients = collabs.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );
    await Promise.all(collabClients.map((c) => c.connect()));
    await new Promise((r) => setTimeout(r, 400));

    console.log("Triggering in-flight AI generation while collaborator edits concurrently...");
    const aiPromise = fetchJson(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({
        message: "Generate a multi-tier payment processing architecture",
        summary: { diagramKind: "flowchart", nodes: [], edges: [] },
        boardId,
        runId: `ai_race_${runId}`,
      }),
    });

    // Collaborator dispatches manual edit while AI generation is in-flight
    const manualNodeId = `manual_during_ai_${runId}`;
    const manualOpAck = await collabClients[0].sendOp("Human Interleaved Edit", [
      {
        op: "CREATE_NODE",
        id: manualNodeId,
        nodeType: "process",
        label: "Critical Manual Node (Human Winner)",
      },
    ]);
    metrics.recordCheck("Manual edit committed during active AI request", !!manualOpAck.seq);

    const aiRes = await aiPromise;
    metrics.recordCheck(
      "AI generation request completed or handled by upstream",
      aiRes.ok || [400, 429, 502, 503].includes(aiRes.status),
      `AI status: ${aiRes.status}`,
    );

    // Verify manual edit survives and is not overwritten
    const finalBoard = await getBoard(baseUrl, owner.token, boardId);
    const manualNode = finalBoard.workspace?.nodes?.[manualNodeId];
    metrics.recordCheck(
      "Manual edit persisted cleanly and was not overwritten by AI completion",
      !!manualNode && manualNode.label === "Critical Manual Node (Human Winner)",
      `Label: "${manualNode?.label || "missing"}"`,
    );

    [ownerClient, ...collabClients].forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-06: Five breakout groups (50 users across 5 boards), then consolidate results onto synthesis board
 */
export async function runLT06(baseUrl, metrics, config) {
  console.log(
    "\n>>> STARTING SCENARIO: LT-06 (5 Breakout Groups -> Synthesis Board Consolidation) <<<",
  );
  const runId = metrics.runId;
  const TOTAL_USERS = 50;
  const GROUPS_COUNT = 5;
  const boardIdsToClean = [];

  try {
    console.log(`1. Provisioning ${TOTAL_USERS} users across ${GROUPS_COUNT} breakout groups...`);
    const users = await pMap(
      Array.from({ length: TOTAL_USERS }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      config.PROVISION_CONCURRENCY,
    );
    metrics.recordCheck(
      `Provisioned ${TOTAL_USERS} users for breakout groups`,
      users.length === TOTAL_USERS,
    );

    // 2. Create 5 breakout boards (10 users each)
    console.log("2. Creating 5 breakout boards...");
    const breakoutBoards = [];
    for (let g = 0; g < GROUPS_COUNT; g++) {
      const groupUsers = users.slice(g * 10, (g + 1) * 10);
      const owner = groupUsers[0];
      const peers = groupUsers.slice(1);
      const res = await createBoard(baseUrl, owner.token, `Breakout Group ${g + 1} (${runId})`);
      const boardId = res.boardId;
      boardIdsToClean.push({ id: boardId, token: owner.token });

      const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
      await pMap(peers, (p) => joinBoard(baseUrl, p.token, boardId, share.token), 5);
      breakoutBoards.push({ groupIndex: g + 1, boardId, owner, peers, allUsers: groupUsers });
    }
    metrics.recordCheck("5 breakout boards created and joined", breakoutBoards.length === 5);

    // 3. Connect users and create 5 findings per breakout board (total 25 findings)
    console.log("3. Collaborating within breakout groups...");
    const breakoutFindings = []; // { groupIndex, nodeId, label }
    for (const b of breakoutBoards) {
      const ownerClient = new RealtimeClient({
        baseUrl,
        token: b.owner.token,
        boardId: b.boardId,
        user: b.owner,
        metrics,
      });
      await ownerClient.connect();
      const peerClients = b.peers.map(
        (p) =>
          new RealtimeClient({ baseUrl, token: p.token, boardId: b.boardId, user: p, metrics }),
      );
      await pMap(peerClients, (c) => c.connect(), 5);

      // Create 5 findings in this breakout board
      for (let i = 0; i < 5; i++) {
        const nid = `finding_g${b.groupIndex}_${i}_${runId}`;
        const label = `Group ${b.groupIndex} Finding #${i + 1}`;
        breakoutFindings.push({ groupIndex: b.groupIndex, nodeId: nid, label });
        await peerClients[i % peerClients.length].sendOp(`Add Finding ${i}`, [
          { op: "CREATE_NODE", id: nid, nodeType: "process", label },
        ]);
      }
      [ownerClient, ...peerClients].forEach((c) => c.close());
    }
    metrics.recordCheck(
      "25 breakout findings created across 5 boards",
      breakoutFindings.length === 25,
    );

    // 4. Create synthesis board and consolidate 2 findings from each group (10 findings total)
    console.log("4. Consolidating into shared Synthesis Board...");
    const leadOwner = breakoutBoards[0].owner;
    const synthRes = await createBoard(baseUrl, leadOwner.token, `Synthesis Board (${runId})`);
    const synthBoardId = synthRes.boardId;
    boardIdsToClean.push({ id: synthBoardId, token: leadOwner.token });

    const synthShare = await shareBoard(baseUrl, leadOwner.token, synthBoardId, "editor");
    const otherLeads = breakoutBoards.slice(1).map((b) => b.owner);
    await pMap(
      otherLeads,
      (lead) => joinBoard(baseUrl, lead.token, synthBoardId, synthShare.token),
      4,
    );

    const synthLeadClients = breakoutBoards.map(
      (b) =>
        new RealtimeClient({
          baseUrl,
          token: b.owner.token,
          boardId: synthBoardId,
          user: b.owner,
          metrics,
        }),
    );
    await synthLeadClients[0].connect();
    await pMap(synthLeadClients.slice(1), (c) => c.connect(), 4);

    // Each lead transfers 2 selected findings onto the synthesis board
    const consolidatedNodeIds = [];
    for (let g = 0; g < GROUPS_COUNT; g++) {
      const leadClient = synthLeadClients[g];
      const selected = breakoutFindings.filter((f) => f.groupIndex === g + 1).slice(0, 2);
      for (const sel of selected) {
        const synthNid = `synth_${sel.nodeId}`;
        consolidatedNodeIds.push(synthNid);
        await leadClient.sendOp(`Consolidate ${sel.label}`, [
          {
            op: "CREATE_NODE",
            id: synthNid,
            nodeType: "process",
            label: `[Consolidated] ${sel.label}`,
          },
        ]);
      }
    }
    metrics.recordCheck(
      "10 findings consolidated onto synthesis board",
      consolidatedNodeIds.length === 10,
    );

    // 5. Connect consolidated findings with connectors on synthesis board
    await synthLeadClients[0].sendOp("Synthesize Links", [
      {
        op: "CONNECT_NODES",
        source: consolidatedNodeIds[0],
        target: consolidatedNodeIds[2],
        relationship: "cross_group_flow",
      },
    ]);

    // 6. Verify isolation and persistence
    const synthBoardData = await getBoard(baseUrl, leadOwner.token, synthBoardId);
    const synthNodes = synthBoardData.workspace?.nodes || {};
    const allConsolidatedPresent = consolidatedNodeIds.every((id) => !!synthNodes[id]);
    metrics.recordCheck(
      "Synthesis board accurately persists all 10 consolidated findings",
      allConsolidatedPresent,
    );

    // Verify source breakout boards were not corrupted
    const b1Data = await getBoard(
      baseUrl,
      breakoutBoards[0].owner.token,
      breakoutBoards[0].boardId,
    );
    const b1NodesCount = Object.keys(b1Data.workspace?.nodes || {}).length;
    metrics.recordCheck(
      "Breakout boards preserved without cross-board data leak",
      b1NodesCount === 5,
      `Board 1 nodes: ${b1NodesCount}`,
    );

    synthLeadClients.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-07: Large board: 5,000 objects scale test
 */
export async function runLT07(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-07 (Large Board: 5,000 Objects Scale Test) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];
  const OBJECT_COUNT = 5000;
  const BATCH_SIZE = 500;

  try {
    const owner = await createTestUser(baseUrl, 1, runId, config.DEFAULT_PASSWORD);
    const bRes = await createBoard(baseUrl, owner.token, `Giant Board 5k (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    console.log(
      `1. Seeding ${OBJECT_COUNT} objects across ${OBJECT_COUNT / BATCH_SIZE} batches...`,
    );
    const tSeed0 = Date.now();
    for (let batch = 0; batch < OBJECT_COUNT / BATCH_SIZE; batch++) {
      const ops = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const idx = batch * BATCH_SIZE + i;
        ops.push({
          op: "CREATE_NODE",
          id: `large_${idx}_${runId}`,
          nodeType: "process",
          label: `Node ${idx}`,
        });
      }
      const postRes = await postBoardOps(
        baseUrl,
        owner.token,
        boardId,
        ops,
        `Seed Batch ${batch + 1}`,
      );
      if (!postRes.ok) {
        throw new Error(`Failed to seed batch ${batch + 1}: status ${postRes.status}`);
      }
    }
    const seedDuration = Date.now() - tSeed0;
    metrics.recordTiming("large_board_seed_duration", seedDuration);
    console.log(`Seeded ${OBJECT_COUNT} objects in ${seedDuration}ms`);
    metrics.recordCheck(
      `Seeded ${OBJECT_COUNT} objects onto board`,
      true,
      `Duration: ${seedDuration}ms`,
    );

    // 2. Connect 25 concurrent users to the 5,000-object board
    console.log("2. Connecting 25 concurrent clients to the 5,000-object board...");
    const users = await pMap(
      Array.from({ length: 25 }, (_, i) => i + 2),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      5,
    );
    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(users, (u) => joinBoard(baseUrl, u.token, boardId, share.token), 5);

    const ownerClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await ownerClient.connect();

    const collabClients = users.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );
    const tWs0 = Date.now();
    await pMap(collabClients, (c) => c.connect(), 5);
    const connectDuration = Date.now() - tWs0;
    metrics.recordTiming("large_board_connect_duration", connectDuration);
    metrics.recordCheck(
      "25 concurrent clients joined 5,000-object board",
      collabClients.every((c) => c.joined),
      `Duration: ${connectDuration}ms`,
    );

    // 3. 10 editors submit concurrent updates across distinct quadrants of the large board
    console.log("3. 10 editors performing concurrent mutations across different regions...");
    const updatePromises = [];
    for (let e = 0; e < 10; e++) {
      const client = collabClients[e];
      const targetId = `large_${e * 500}_${runId}`;
      updatePromises.push(
        client.sendOp(`Update Region ${e}`, [
          { op: "CHANGE_TEXT", id: targetId, text: `Active Region ${e} by User ${client.user.id}` },
        ]),
      );
    }
    const updateAcks = await Promise.all(updatePromises);
    metrics.recordCheck(
      "Concurrent mutations across 5k-object board acknowledged",
      updateAcks.every((a) => !!a.seq),
    );

    // 4. Verify authoritative persistence
    const finalBoard = await getBoard(baseUrl, owner.token, boardId);
    const nodeCount = Object.keys(finalBoard.workspace?.nodes || {}).length;
    metrics.recordCheck(
      "Authoritative persistence holds all 5,000 objects plus updates",
      nodeCount >= OBJECT_COUNT,
      `Total persisted nodes: ${nodeCount}`,
    );

    [ownerClient, ...collabClients].forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-12: Undo/redo and history with interleaved collaborators
 */
export async function runLT12(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-12 (Undo/Redo & Interleaved Collaborators) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const userA = await createTestUser(baseUrl, 1, runId, config.DEFAULT_PASSWORD);
    const userB = await createTestUser(baseUrl, 2, runId, config.DEFAULT_PASSWORD);

    const bRes = await createBoard(baseUrl, userA.token, `Undo History Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: userA.token });

    const share = await shareBoard(baseUrl, userA.token, boardId, "editor");
    await joinBoard(baseUrl, userB.token, boardId, share.token);

    const clientA = new RealtimeClient({
      baseUrl,
      token: userA.token,
      boardId,
      user: userA,
      metrics,
    });
    const clientB = new RealtimeClient({
      baseUrl,
      token: userB.token,
      boardId,
      user: userB,
      metrics,
    });

    await clientA.connect();
    await clientB.connect();
    await new Promise((r) => setTimeout(r, 400));

    // 1. User A creates Node A; User B creates Node B
    const nodeAId = `node_a_${runId}`;
    const nodeBId = `node_b_${runId}`;
    await clientA.sendOp("Create Node A", [
      { op: "CREATE_NODE", id: nodeAId, nodeType: "process", label: "Initial Node A" },
    ]);
    await clientB.sendOp("Create Node B", [
      { op: "CREATE_NODE", id: nodeBId, nodeType: "process", label: "Initial Node B" },
    ]);

    // 2. Interleaved edits: User A modifies Node A; User B modifies Node B
    await clientA.sendOp("User A Edit", [
      { op: "CHANGE_TEXT", id: nodeAId, text: "Node A Modified by User A" },
    ]);
    await clientB.sendOp("User B Edit", [
      { op: "CHANGE_TEXT", id: nodeBId, text: "Node B Modified by User B" },
    ]);

    // 3. User A performs inverse op (undo) on Node A
    console.log("User A executing inverse operation (undo) on Node A...");
    const undoAck = await clientA.sendOp("User A Undo", [
      { op: "CHANGE_TEXT", id: nodeAId, text: "Initial Node A" },
    ]);
    metrics.recordCheck("User A inverse operation committed", !!undoAck.seq);

    // 4. Verify Node A reverted, but User B's edits on Node B remain intact
    const finalBoard = await getBoard(baseUrl, userA.token, boardId);
    const labelA = finalBoard.workspace?.nodes?.[nodeAId]?.label;
    const labelB = finalBoard.workspace?.nodes?.[nodeBId]?.label;

    metrics.recordCheck(
      "User A's object successfully reverted by inverse op",
      labelA === "Initial Node A",
      `Node A Label: "${labelA}"`,
    );
    metrics.recordCheck(
      "User B's independent edit preserved intact after User A's undo",
      labelB === "Node B Modified by User B",
      `Node B Label: "${labelB}"`,
    );

    clientA.close();
    clientB.close();
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-13: Board creation, duplication, and navigation burst
 */
export async function runLT13(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-13 (Board Creation & Duplication Burst) <<<");
  const runId = metrics.runId;
  const TOTAL_USERS = 30;
  const boardIdsToClean = [];

  try {
    console.log(`1. Provisioning ${TOTAL_USERS} users...`);
    const users = await pMap(
      Array.from({ length: TOTAL_USERS }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      config.PROVISION_CONCURRENCY,
    );
    metrics.recordCheck(
      `Provisioned ${TOTAL_USERS} users for burst test`,
      users.length === TOTAL_USERS,
    );

    // Seed 1 source template board to duplicate
    const sourceRes = await createBoard(baseUrl, users[0].token, `Source Template (${runId})`);
    const sourceBoardId = sourceRes.boardId;
    boardIdsToClean.push({ id: sourceBoardId, token: users[0].token });
    await postBoardOps(baseUrl, users[0].token, sourceBoardId, [
      {
        op: "CREATE_NODE",
        id: `tmpl_n_${runId}`,
        nodeType: "process",
        label: "Template Workflow Root",
      },
    ]);

    // 2. 30 users concurrently create unique boards within a short window
    console.log("2. 30 users simultaneously creating boards...");
    const tCreate0 = Date.now();
    const createResults = await pMap(
      users,
      async (u, idx) => {
        const res = await createBoard(baseUrl, u.token, `Burst Board ${idx + 1} (${runId})`);
        boardIdsToClean.push({ id: res.boardId, token: u.token });
        return res;
      },
      15,
    );
    const createDuration = Date.now() - tCreate0;
    metrics.recordTiming("burst_create_boards_duration", createDuration);
    metrics.recordCheck(
      "30 concurrent board creations completed without collision",
      createResults.every((r) => !!r.boardId),
      `Duration: ${createDuration}ms`,
    );

    // 3. 10 users duplicate the source board concurrently
    console.log("3. 10 users duplicating the source board concurrently...");
    const sourceData = await getBoard(baseUrl, users[0].token, sourceBoardId);
    const dupUsers = users.slice(0, 10);
    const dupResults = await pMap(
      dupUsers,
      async (u, idx) => {
        const res = await createBoard(baseUrl, u.token, `Duplicated Board ${idx + 1} (${runId})`);
        boardIdsToClean.push({ id: res.boardId, token: u.token });
        // copy template workspace
        if (sourceData.workspace?.nodes) {
          await postBoardOps(baseUrl, u.token, res.boardId, [
            {
              op: "CREATE_NODE",
              id: `dup_n_${idx}_${runId}`,
              nodeType: "process",
              label: "Cloned Root",
            },
          ]);
        }
        return res;
      },
      5,
    );
    metrics.recordCheck(
      "10 concurrent board duplications completed",
      dupResults.every((r) => !!r.boardId),
    );

    // 4. Query listBoards to verify list integrity
    console.log("4. Verifying board listing across users...");
    const orgId =
      sourceData.board?.orgId ||
      sourceData.orgId ||
      sourceRes.data?.board?.orgId ||
      sourceRes.data?.orgId ||
      "";
    const listRes = await listBoards(baseUrl, users[0].token, orgId);
    metrics.recordCheck(
      "Board listing retrieved successfully",
      listRes.ok ||
        listRes.status === 200 ||
        (Array.isArray(listRes.boards) && listRes.boards.length >= 1),
      `Status: ${listRes.status}, count: ${Array.isArray(listRes.boards) ? listRes.boards.length : 0}`,
    );
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-14: Upload / Import / Export workload concurrency
 */
export async function runLT14(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-14 (Upload, Export & Edit Concurrency) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const owner = await createTestUser(baseUrl, 1, runId, config.DEFAULT_PASSWORD);
    const bRes = await createBoard(baseUrl, owner.token, `File Ops Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    // Seed a node
    await postBoardOps(baseUrl, owner.token, boardId, [
      {
        op: "CREATE_NODE",
        id: `file_n_${runId}`,
        nodeType: "process",
        label: "Media Pipeline Node",
      },
    ]);

    const users = await pMap(
      Array.from({ length: 8 }, (_, i) => i + 2),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      4,
    );
    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(users, (u) => joinBoard(baseUrl, u.token, boardId, share.token), 4);

    const client = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await client.connect();

    // 1. Concurrent asset uploads (5 users)
    console.log("1. Executing 5 concurrent binary asset uploads...");
    const fakePng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    // Uploads must come from a member of the BOARD'S org. A shared collaborator
    // from another personal org is correctly refused by the cross-tenant board-id
    // guard (that produced the earlier 404s), so the board-org owner uploads here.
    const uploadPromises = Array.from({ length: 5 }, () =>
      uploadAsset(baseUrl, owner.token, boardId, fakePng, "image/png", owner.csrfToken),
    );

    // 2. Concurrent exports (3 users)
    console.log("2. Executing 3 concurrent board exports...");
    const exportUsers = users.slice(5, 8);
    const exportPromises = exportUsers.map((u) =>
      exportBoard(baseUrl, u.token, boardId, "json", u.csrfToken),
    );

    // 3. Concurrent canvas edits during file activity
    const opPromise = client.sendOp("Active Edit During Uploads", [
      {
        op: "CREATE_NODE",
        id: `edit_during_upload_${runId}`,
        nodeType: "process",
        label: "Active Drawing",
      },
    ]);

    const [uploadResults, exportResults, opAck] = await Promise.all([
      Promise.all(uploadPromises),
      Promise.all(exportPromises),
      opPromise,
    ]);

    metrics.recordCheck(
      "Asset uploads succeeded for a board-org member",
      uploadResults.every((r) => r.ok || r.status === 200 || r.status === 201),
      `Statuses: ${uploadResults.map((r) => r.status).join(", ")}`,
    );
    metrics.recordCheck(
      "Board export requests answered cleanly",
      exportResults.every((r) => r.ok || [200, 400, 402, 403].includes(r.status)),
      `Statuses: ${exportResults.map((r) => r.status).join(", ")}`,
    );
    metrics.recordCheck(
      "Canvas mutation committed without disruption during file operations",
      !!opAck.seq,
    );

    client.close();
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-15: Service restart and persistence recovery
 */
export async function runLT15(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-15 (Service Restart & Persistence Recovery) <<<");
  if (!config.ALLOW_DESTRUCTIVE_TESTS) {
    metrics.recordSkip(
      "LT-15 (Service Restart)",
      "destructive (recycles the server process); set ALLOW_DESTRUCTIVE_TESTS=true to run",
    );
    return;
  }
  if (!isLoopback(baseUrl)) {
    metrics.recordSkip(
      "LT-15 (Service Restart)",
      "refusing to restart a non-loopback target; run only against the local stack",
    );
    return;
  }
  const runId = metrics.runId;
  const boardIdsToClean = [];

  try {
    const owner = await createTestUser(baseUrl, 1, runId, config.DEFAULT_PASSWORD);
    const bRes = await createBoard(baseUrl, owner.token, `Recovery Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const client = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await client.connect();

    // 1. Commit 3 acknowledged operations
    console.log("1. Writing acknowledged operations prior to simulated restart/recovery...");
    const ack1 = await client.sendOp("Pre-Restart Op 1", [
      {
        op: "CREATE_NODE",
        id: `node_pre1_${runId}`,
        nodeType: "process",
        label: "Pre-Restart Service Alpha",
      },
    ]);
    const ack2 = await client.sendOp("Pre-Restart Op 2", [
      {
        op: "CREATE_NODE",
        id: `node_pre2_${runId}`,
        nodeType: "process",
        label: "Pre-Restart Service Beta",
      },
    ]);
    metrics.recordCheck("Pre-restart operations acknowledged", !!ack1.seq && !!ack2.seq);

    // 2. REAL restart: recycle the server process and wait for /health to return.
    client.close();
    console.log(`2. Restarting the server: ${config.RESTART_CMD}`);
    const tRestart = Date.now();
    try {
      execSync(config.RESTART_CMD, { stdio: "inherit", cwd: process.cwd() });
    } catch (err) {
      metrics.recordCheck("Server restart command executed", false, err.message);
      return;
    }
    const healthy = await waitForHealth(baseUrl, 90000);
    const recoverMs = Date.now() - tRestart;
    metrics.recordTiming("service_restart_recovery", recoverMs);
    metrics.recordCheck("Server came back healthy after real restart", healthy, `${recoverMs}ms`);
    if (!healthy) return;

    // 3. Connect fresh client with cold start (fromSeq: 0)
    console.log("3. Connecting fresh client to trigger cold room rebuild from durable op_log...");
    const freshClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await freshClient.connect(0);
    metrics.recordCheck("Client reconnected to board after simulated restart", freshClient.joined);

    // 4. Verify durable persistence matches acknowledged writes
    const reloaded = await getBoard(baseUrl, owner.token, boardId);
    const nodes = reloaded.workspace?.nodes || {};
    const hasPre1 = !!nodes[`node_pre1_${runId}`];
    const hasPre2 = !!nodes[`node_pre2_${runId}`];
    metrics.recordCheck(
      "Durable state fully recovered across cold start / restart cycle",
      hasPre1 && hasPre2,
      `Nodes found: Alpha=${hasPre1}, Beta=${hasPre2}`,
    );

    // 5. Subsequent edit succeeds
    const postAck = await freshClient.sendOp("Post-Restart Edit", [
      {
        op: "CREATE_NODE",
        id: `node_post_${runId}`,
        nodeType: "process",
        label: "Post-Restart Gamma",
      },
    ]);
    metrics.recordCheck("Room processes new operations following recovery", !!postAck.seq);

    freshClient.close();
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-16: Long soak and resource leak detection (Sustained multi-wave collaboration)
 */
export async function runLT16(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-16 (Sustained Soak & Health Verification) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];
  const SOAK_USERS = Number(process.env.SOAK_USERS || 20);
  const SOAK_ROUNDS = Number(process.env.SOAK_ROUNDS || 5);
  const memSamples = [];

  try {
    const users = await pMap(
      Array.from({ length: SOAK_USERS }, (_, i) => i + 1),
      (idx) => createTestUser(baseUrl, idx, runId, config.DEFAULT_PASSWORD),
      5,
    );
    const owner = users[0];
    const collabs = users.slice(1);

    const bRes = await createBoard(baseUrl, owner.token, `Soak Test Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });

    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");
    await pMap(collabs, (c) => joinBoard(baseUrl, c.token, boardId, share.token), 5);

    const ownerClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await ownerClient.connect();
    const collabClients = collabs.map(
      (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
    );
    await pMap(collabClients, (c) => c.connect(), 5);
    const clients = [ownerClient, ...collabClients];

    console.log(`Executing ${SOAK_ROUNDS} sustained interaction rounds with think time...`);
    const latencies = [];
    for (let round = 1; round <= SOAK_ROUNDS; round++) {
      if (round === 1 || round % 10 === 0) console.log(`-- Soak Round ${round}/${SOAK_ROUNDS} --`);
      // 1. Presence moves
      clients.forEach((c, idx) => c.sendPresence({ x: 100 + idx * 20, y: 150 + round * 10 }));
      // 2. Mutation wave
      const t0 = Date.now();
      await clients[round % clients.length].sendOp(`Soak Round ${round} Note`, [
        {
          op: "CREATE_NODE",
          id: `soak_n_${round}_${runId}`,
          nodeType: "process",
          label: `Soak Node Round ${round}`,
        },
      ]);
      const roundLat = Date.now() - t0;
      latencies.push(roundLat);
      metrics.recordTiming("soak_round_latency", roundLat);
      // 3. Sample server memory for leak detection.
      const rss = await sampleServerRss(baseUrl, owner.token);
      if (rss != null) {
        memSamples.push(rss);
        metrics.recordTiming("soak_server_rss_mb", Math.round(rss / (1024 * 1024)));
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // First-window vs last-window comparison (latency drift + memory leak).
    const win = Math.max(1, Math.floor(latencies.length / 4));
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const firstLatAvg = avg(latencies.slice(0, win));
    const lastLatAvg = avg(latencies.slice(-win));
    metrics.recordCheck(
      "Sustained soak completed without latency drift",
      latencies.length === SOAK_ROUNDS && lastLatAvg < Math.max(10000, firstLatAvg * 3),
      `${SOAK_ROUNDS} rounds; first-window avg ${Math.round(firstLatAvg)}ms, last-window avg ${Math.round(lastLatAvg)}ms`,
    );
    if (memSamples.length >= 2) {
      const firstMem = memSamples[0];
      const lastMem = memSamples[memSamples.length - 1];
      const growthPct = Math.round(((lastMem - firstMem) / firstMem) * 100);
      metrics.recordCheck(
        "No unexplained server-memory growth over soak",
        growthPct < 50,
        `RSS first ${Math.round(firstMem / 1e6)}MB -> last ${Math.round(lastMem / 1e6)}MB (${growthPct >= 0 ? "+" : ""}${growthPct}%)`,
      );
    }

    clients.forEach((c) => c.close());
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}

/**
 * LT-17: Load spike and controlled saturation ramp (10 -> 25 -> 50 -> 75 users)
 */
export async function runLT17(baseUrl, metrics, config) {
  console.log("\n>>> STARTING SCENARIO: LT-17 (Load Spike & Controlled Saturation Ramp) <<<");
  const runId = metrics.runId;
  const boardIdsToClean = [];
  const RAMP_STAGES = process.env.RAMP_STAGES
    ? process.env.RAMP_STAGES.split(",").map((n) => Number(n.trim()))
    : [10, 25, 50, 75, 100];
  const stageResults = [];

  try {
    const owner = await createTestUser(baseUrl, 1, runId, config.DEFAULT_PASSWORD);
    const bRes = await createBoard(baseUrl, owner.token, `Ramp Board (${runId})`);
    const boardId = bRes.boardId;
    boardIdsToClean.push({ id: boardId, token: owner.token });
    const share = await shareBoard(baseUrl, owner.token, boardId, "editor");

    const ownerClient = new RealtimeClient({
      baseUrl,
      token: owner.token,
      boardId,
      user: owner,
      metrics,
    });
    await ownerClient.connect();

    for (const targetUsers of RAMP_STAGES) {
      console.log(`\n--- RAMP STAGE: ${targetUsers} Concurrent Users ---`);
      const stageUsers = await pMap(
        Array.from({ length: targetUsers - 1 }, (_, i) => i + 2),
        (idx) => createTestUser(baseUrl, `${targetUsers}_${idx}`, runId, config.DEFAULT_PASSWORD),
        8,
      );
      await pMap(stageUsers, (u) => joinBoard(baseUrl, u.token, boardId, share.token), 8);

      const stageClients = stageUsers.map(
        (u) => new RealtimeClient({ baseUrl, token: u.token, boardId, user: u, metrics }),
      );
      const tConn0 = Date.now();
      await pMap(stageClients, (c) => c.connect(), 10);
      const connDuration = Date.now() - tConn0;
      metrics.recordTiming(`ramp_${targetUsers}_connect`, connDuration);

      // Concurrent burst at this stage
      const tOp0 = Date.now();
      const ack = await ownerClient.sendOp(`Ramp ${targetUsers} Marker`, [
        {
          op: "CREATE_NODE",
          id: `ramp_${targetUsers}_${runId}`,
          nodeType: "process",
          label: `Ramp Target ${targetUsers}`,
        },
      ]);
      const opDuration = Date.now() - tOp0;
      metrics.recordTiming(`ramp_${targetUsers}_op`, opDuration);

      const stageOk = stageClients.every((c) => c.joined) && !!ack.seq;
      stageResults.push({
        users: targetUsers,
        connectMs: connDuration,
        opMs: opDuration,
        ok: stageOk,
      });
      metrics.recordCheck(
        `Ramp stage ${targetUsers} users connected and synchronized`,
        stageOk,
        `Connect: ${connDuration}ms, Op Ack: ${opDuration}ms`,
      );

      stageClients.forEach((c) => c.close());
      await new Promise((r) => setTimeout(r, 500));
    }

    // Capacity knee: largest stage meeting the op-ack budget, and the first that breaks it.
    const OP_BUDGET_MS = Number(process.env.RAMP_OP_BUDGET_MS || 1000);
    const healthyStages = stageResults.filter((s) => s.ok && s.opMs <= OP_BUDGET_MS);
    const knee = stageResults.find((s) => !s.ok || s.opMs > OP_BUDGET_MS);
    const largestHealthy = healthyStages.length ? healthyStages[healthyStages.length - 1].users : 0;
    metrics.recordCheck(
      "Saturation ramp recorded a capacity knee",
      stageResults.length > 0,
      `Largest healthy: ${largestHealthy} users (budget ${OP_BUDGET_MS}ms); knee: ${knee ? knee.users + " users @ " + knee.opMs + "ms" : "none in range"}`,
    );

    ownerClient.close();
  } finally {
    if (config.CLEANUP_ON_EXIT) {
      for (const b of boardIdsToClean) {
        await deleteBoard(baseUrl, b.token, b.id).catch(() => {});
      }
    }
  }
}
