/* global __ENV, __VU */
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Trend } from "k6/metrics";
import { BASE, PASSWORD, auth, createBoard, createOrg, emailFor, signIn } from "./lib.js";

/**
 * Profile 3 — cold open of a large board (D3: "large boards remain usable").
 *
 * One board carrying a 5,000-node workspace. The profile measures the read
 * path a first join rides: board fetch (the workspace JSON the renderer boots
 * from), a listing that includes the heavy board, and — as the baseline every
 * number should be read against — a tiny board fetched by the same client.
 *
 * 5,000 nodes at ~150 JSON bytes each is well under the 8 MiB workspace cap
 * (config.ts), so this is the honest size of a real big board, not a payload
 * attack. If the p(95) here is fine and the canvas still stutters, the defect
 * is in the renderer, not the server — that is exactly the split this profile
 * exists to expose.
 */

const NODES = Number(__ENV.NODES || 5000);
const READERS = Number(__ENV.READERS || 10);
const DURATION = __ENV.DURATION || "1m";

const coldOpenMs = new Trend("board_cold_open_ms", true);
const smallOpenMs = new Trend("board_small_open_ms", true);
const listWithHeavyMs = new Trend("board_list_with_heavy_ms", true);

export const options = {
  scenarios: {
    setup: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      exec: "seed",
      maxDuration: "2m",
    },
    open: {
      executor: "constant-vus",
      vus: READERS,
      duration: DURATION,
      startTime: "5s",
      exec: "openBoards",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    board_cold_open_ms: ["p(95)<1000"],
    board_small_open_ms: ["p(95)<250"],
  },
};

const runId = `${Date.now().toString(36)}`;
let heavy = null; // { id }
let small = null;

function workspaceWithNodes(count) {
  const workspace = {
    name: `load-${count}`,
    diagramKind: "flowchart",
    nodes: {},
    edges: {},
    groups: {},
    shapes: {},
    shapeLinks: {},
    comments: {},
    votes: {},
    reactions: {},
    wireframes: {},
  };
  for (let i = 0; i < count; i += 1) {
    workspace.nodes[`n${i}`] = {
      id: `n${i}`,
      nodeType: i % 9 === 0 ? "service" : "step",
      label: `Node ${i}`,
      position: { x: (i % 100) * 220, y: Math.floor(i / 100) * 140 },
      size: { width: 180, height: 90 },
    };
    if (i > 0 && i % 3 === 0) {
      const from = `n${i - 1}`;
      workspace.edges[`e${i}`] = {
        id: `e${i}`,
        source: from,
        target: `n${i}`,
        relationship: "next",
      };
    }
  }
  return workspace;
}

export function seed() {
  const session = signIn(emailFor(runId, 0), PASSWORD, "cold-open");
  const orgId = createOrg(session, `cold-open-${runId}`);
  heavy = createBoard(session, orgId, `heavy-${runId}`, workspaceWithNodes(NODES));
  if (!heavy) fail("heavy board create was plan-gated; seed must run on a fresh org");
  small = createBoard(session, orgId, `small-${runId}`, workspaceWithNodes(5));
  if (!small) fail("small board create failed");
}

export function openBoards() {
  const session = signIn(emailFor(runId, 1000 + __VU), PASSWORD, "cold-open-reader");

  const cold = http.get(`${BASE}/api/boards/${heavy.id}`, {
    headers: auth(session),
    tags: { name: "board-cold-open" },
  });
  check(cold, { "cold open ok": (r) => r.status === 200 });
  coldOpenMs.add(cold.timings.duration);

  const smallGet = http.get(`${BASE}/api/boards/${small.id}`, {
    headers: auth(session),
    tags: { name: "board-small-open" },
  });
  check(smallGet, { "small open ok": (r) => r.status === 200 });
  smallOpenMs.add(smallGet.timings.duration);

  const list = http.get(`${BASE}/api/boards?orgId=${cold.json("orgId")}`, {
    headers: auth(session),
    tags: { name: "board-list-heavy" },
  });
  check(list, { "list ok": (r) => r.status === 200 });
  listWithHeavyMs.add(list.timings.duration);

  sleep(1);
}
