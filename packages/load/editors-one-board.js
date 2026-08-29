/* global __ENV, __VU, __ITER */
import ws from "k6/ws";
import http from "k6/http";
import { check, fail } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  BASE,
  PASSWORD,
  auth,
  createBoard,
  emailFor,
  realtimeTicket,
  signIn,
  socketUrl,
} from "./lib.js";

/**
 * Profile 1 — 100 concurrent editors on one board.
 *
 * Each VU holds an open socket on the same room, commits an operation every
 * couple of seconds and moves its cursor every second, which is what the room
 * actually has to survive: one append-only log being sequenced, validated,
 * persisted and fanned out to a hundred sockets at once.
 *
 * Identity: by default every VU authenticates as the board's owner, so this
 * measures a hundred *sockets*, not a hundred *accounts*. Distinct accounts on
 * one board need either a share link (gated on a verified email, so it needs a
 * working mailer) or a hundred org seats (the free plan sells one). When you
 * have either, mint a link yourself and pass LUCENT_LOAD_BOARD_ID and
 * LUCENT_LOAD_SHARE_TOKEN; each VU then signs up its own account and joins with
 * it, and presence carries a hundred identities. The server-side work under
 * test — sequencing, validation, fan-out, op_log writes — is the same either way.
 */

const EDITORS = Number(__ENV.EDITORS || 100);
const DURATION = __ENV.DURATION || "1m";
/** How long one VU keeps its socket open before reconnecting. */
const HOLD_MS = Number(__ENV.HOLD_MS || 20000);
const OP_INTERVAL_MS = Number(__ENV.OP_INTERVAL_MS || 2000);
const PRESENCE_INTERVAL_MS = Number(__ENV.PRESENCE_INTERVAL_MS || 1000);

const joinMs = new Trend("ws_join_ms", true);
const commitMs = new Trend("ws_commit_ms", true);
const rejected = new Counter("ws_ops_rejected");
const commits = new Counter("ws_ops_committed");

export const options = {
  scenarios: {
    editors: { executor: "constant-vus", vus: EDITORS, duration: DURATION, gracefulStop: "15s" },
  },
  thresholds: {
    // A commit is one round trip through the room: send, sequence, validate,
    // persist, broadcast back. Under a second at the 95th percentile is the
    // point where typing on a shared board still feels live.
    ws_commit_ms: ["p(95)<1000"],
    // Joining costs a ticket mint, an upgrade and a catchup replay.
    ws_join_ms: ["p(95)<2000"],
    // Any rejection here is a bug, not load: these ops are valid and the role
    // is an editor's. `permission` or `validation` means something regressed.
    ws_ops_rejected: ["count<1"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const runId = Date.now().toString(36);
  const shareToken = __ENV.LUCENT_LOAD_SHARE_TOKEN || null;
  const sharedBoard = __ENV.LUCENT_LOAD_BOARD_ID || null;
  if (shareToken && sharedBoard) {
    return { runId, boardId: sharedBoard, shareToken, owner: null };
  }
  const owner = signIn(emailFor(runId, "owner"), PASSWORD, "k6 owner");
  const board = createBoard(owner, owner.orgId, `k6 editors ${runId}`);
  if (!board) fail("board create was refused by the plan gate; free orgs hold three boards");
  return { runId, boardId: board.id, shareToken: null, owner };
}

/** One signup per VU, cached: module scope is per-VU in k6. */
let vuSession = null;
function sessionFor(data) {
  if (vuSession) return vuSession;
  if (!data.shareToken) {
    vuSession = data.owner;
    return vuSession;
  }
  vuSession = signIn(emailFor(data.runId, `editor-${__VU}`), PASSWORD, `k6 editor ${__VU}`);
  const res = http.post(
    `${BASE}/api/boards/${data.boardId}/join`,
    JSON.stringify({ token: data.shareToken }),
    { headers: auth(vuSession), tags: { name: "board-join" } },
  );
  if (res.status !== 200) fail(`share join failed (${res.status}): ${res.body}`);
  return vuSession;
}

export default function (data) {
  const session = sessionFor(data);
  const pending = {};
  let tick = 0;
  const startedAt = Date.now();
  const url = socketUrl(realtimeTicket(session));

  const res = ws.connect(url, {}, function (socket) {
    socket.on("open", function () {
      socket.send(JSON.stringify({ type: "join", boardId: data.boardId, fromSeq: 0 }));
    });

    socket.on("message", function (raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_err) {
        return;
      }
      if (msg.type === "welcome") {
        joinMs.add(Date.now() - startedAt);
        check(msg, { "joined with an editing role": (m) => m.role !== "viewer" });
        socket.setInterval(function () {
          commit(socket, pending, tick++);
        }, OP_INTERVAL_MS);
        socket.setInterval(function () {
          socket.send(
            JSON.stringify({
              type: "presence",
              cursor: { x: (tick * 37) % 1600, y: (tick * 53) % 900 },
              selection: [],
            }),
          );
        }, PRESENCE_INTERVAL_MS);
        socket.setTimeout(function () {
          socket.close();
        }, HOLD_MS);
      } else if (msg.type === "op") {
        const sentAt = pending[msg.entry.label];
        if (sentAt) {
          commitMs.add(Date.now() - sentAt);
          commits.add(1);
          delete pending[msg.entry.label];
        }
      } else if (msg.type === "op-rejected") {
        rejected.add(1);
        console.error(`op rejected: ${msg.error} ${msg.detail || ""}`);
      } else if (msg.type === "error") {
        fail(`room refused the join: ${msg.message}`);
      }
    });

    socket.on("error", function (err) {
      if (String(err) !== "websocket: close sent") console.error(`socket error: ${err}`);
    });
  });

  check(res, { "websocket upgrade accepted": (r) => r && r.status === 101 });
}

/**
 * One commit: create a card, then nudge the card created on the previous tick.
 * Ids embed the VU and iteration because operation ids must be unique for the
 * whole life of the board's log — a collision comes back as `op-rejected`
 * (validation), not as an HTTP error a load script would notice.
 */
function commit(socket, pending, tick) {
  const id = `n-${__VU}-${__ITER}-${tick}`;
  const label = `k6 ${id}`;
  const ops =
    tick % 2 === 0 || tick === 0
      ? [{ op: "CREATE_NODE", id, nodeType: "service", label: `Editor ${__VU} #${tick}` }]
      : [
          {
            op: "MOVE_NODE",
            id: `n-${__VU}-${__ITER}-${tick - 1}`,
            position: { x: (tick * 160) % 4000, y: __VU * 90 },
          },
        ];
  pending[label] = Date.now();
  socket.send(JSON.stringify({ type: "op", ops, label }));
}
