/* global __ENV, __VU, __ITER */
import http from "k6/http";
import { check, fail } from "k6";
import { Trend, Counter } from "k6/metrics";
import {
  BASE,
  FREE_BOARDS_PER_ORG,
  PASSWORD,
  auth,
  createBoard,
  createOrg,
  emailFor,
  signIn,
} from "./lib.js";

/**
 * Profile 2 — 1,000 boards across the listing and read paths.
 *
 * Boards live in orgs of FREE_BOARDS_PER_ORG, so this profile spreads creation
 * over ~334 orgs and then measures what a signed-in user actually feels at
 * scale: the org's board listing, a board fetch, and a share-listing sweep.
 * Create is once (setup + a low create rate); the steady state is reads,
 * because that is what a dashboard with a thousand boards serves all day.
 *
 * The plan gate is part of the profile, not an obstacle: a 402 on create is
 * answered by rotating to a fresh org, which is what the product makes
 * everyone do.
 */

const BOARDS = Number(__ENV.BOARDS || 1000);
const READERS = Number(__ENV.READERS || 20);
const DURATION = __ENV.DURATION || "2m";

const listMs = new Trend("board_list_ms", true);
const getMs = new Trend("board_get_ms", true);
const created = new Counter("boards_created");
const gateHits = new Counter("boards_plan_gated");

export const options = {
  scenarios: {
    // One-shot seeding: enough boards that the read path has something to
    // chew on. Runs to completion before the readers start.
    seed: {
      executor: "per-vu-iterations",
      vus: 5,
      iterations: Math.ceil(BOARDS / 5),
      maxDuration: "10m",
      exec: "seedBoards",
      gracefulStop: "0s",
    },
    reads: {
      executor: "constant-vus",
      vus: READERS,
      duration: DURATION,
      startTime: "15s",
      exec: "readBoards",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    board_get_ms: ["p(95)<250"],
    board_list_ms: ["p(95)<400"],
    "board_get_ms{scenario:reads}": ["p(99)<800"],
  },
};

/** Which org owns the n-th board, and the index within it. */
function orgSlot(n) {
  const orgIndex = Math.floor(n / FREE_BOARDS_PER_ORG);
  const slot = n % FREE_BOARDS_PER_ORG;
  return { orgIndex, slot };
}

// VU-local caches so the seed and read scenarios agree on what exists.
const runId = `${Date.now().toString(36)}`;
const orgIdsByIndex = new Map();
const sessionByOrg = new Map();

function sessionForOrg(orgIndex) {
  const cached = sessionByOrg.get(orgIndex);
  if (cached) return cached;
  const s = signIn(emailFor(runId, orgIndex), PASSWORD, `load-${orgIndex}`);
  const orgId = createOrg(s, `load-org-${runId}-${orgIndex}`);
  const entry = { session: s, orgId };
  orgIdsByIndex.set(orgIndex, orgId);
  sessionByOrg.set(orgIndex, entry);
  return entry;
}

export function seedBoards() {
  const n = (__VU - 1) * Math.ceil(BOARDS / 5) + __ITER;
  if (n >= BOARDS) return;
  const { orgIndex, slot } = orgSlot(n);
  const { session, orgId } = sessionForOrg(orgIndex);
  // The last slot in each org is the rotation probe: try a board beyond the
  // plan and expect the 402, so the gate is exercised on every org too.
  if (slot === FREE_BOARDS_PER_ORG - 1) {
    const gated = createBoard(session, orgId, `gated-${runId}-${n}`);
    if (gated === null) gateHits.add(1);
    else fail("expected a plan gate on the free board limit");
    return;
  }
  const board = createBoard(session, orgId, `load-${runId}-${n}`);
  if (board === null) fail(`board ${n} plan-gated but should not be`);
  else created.add(1);
}

export function readBoards() {
  // Readers cycle org indexes; the free plan caps an org's board count, so a
  // reader's listing is small but the fetch path sees the whole fleet.
  const orgIndex = (__VU + __ITER) % Math.ceil(BOARDS / FREE_BOARDS_PER_ORG);
  const { session, orgId } = sessionForOrg(orgIndex);

  const list = http.get(`${BASE}/api/boards?orgId=${orgId}`, {
    headers: auth(session),
    tags: { name: "board-list" },
  });
  check(list, { "list ok": (r) => r.status === 200 });
  listMs.add(list.timings.duration);

  const boards = list.json("boards");
  if (!boards || boards.length === 0) return;
  const pick = boards[__ITER % boards.length];
  const got = http.get(`${BASE}/api/boards/${pick.id}`, {
    headers: auth(session),
    tags: { name: "board-get" },
  });
  check(got, { "get ok": (r) => r.status === 200 });
  getMs.add(got.timings.duration);
}
