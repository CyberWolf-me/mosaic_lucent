/**
 * Adversarial tests: report determinism and stale-source detection.
 * Same sources must yield byte-identical output; any source move must
 * change the embedded source footer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sourceHash, verifyGenerated, buildProjections, renderTasksBoard, renderExecutionLog, renderFounderReport } from "../lib/report.js";
import { minimalTask } from "./helpers.mjs";

const tasks = [minimalTask("ENG-1"), minimalTask("ENG-2", { dependencies: ["ENG-1"] })];
const states = new Map([
  ["ENG-1", { status: "done", spec_rev: "abc" }],
  ["ENG-2", { status: "blocked", spec_rev: "def", blocked_from: "ready", blocked_reason: "waiting" }],
]);
const events = [
  { seq: 1, ts: 1000, actor: "cto", task_id: "ENG-1", attempt_id: null, action: "task.created", outcome: "ok" },
  { seq: 2, ts: 2000, actor: "w1", task_id: "ENG-1", attempt_id: "att_x", action: "verification.recorded", outcome: "fail" },
];

describe("report determinism", () => {
  it("same inputs produce identical bytes", () => {
    const a = renderTasksBoard({ tasks, states, tasksHash: "h", maxEventSeq: 2 });
    const b = renderTasksBoard({ tasks, states, tasksHash: "h", maxEventSeq: 2 });
    assert.equal(a, b);
    assert.ok(a.includes("<!-- GENERATED"));
    assert.ok(a.includes("do not hand-edit"));
  });

  it("source moves change the embedded footer", () => {
    const a = renderExecutionLog({ events, tasksHash: sourceHash("v1"), maxEventSeq: 2 });
    const b = renderExecutionLog({ events, tasksHash: sourceHash("v2"), maxEventSeq: 2 });
    assert.notEqual(a, b);
    const c = renderExecutionLog({ events, tasksHash: sourceHash("v1"), maxEventSeq: 3 });
    assert.notEqual(a, c);
  });

  it("generated-file footers verify provenance, not recency", () => {
    const board = renderTasksBoard({ tasks, states, tasksHash: "abc123", maxEventSeq: 9 });
    assert.ok(verifyGenerated(board, { tasksHash: "abc123", maxEventSeq: 9 }).ok);
    // Newer events after generation are fine (freshness is a --check concern).
    assert.ok(verifyGenerated(board, { tasksHash: "abc123", maxEventSeq: 25 }).ok);
    // Wrong spec hash or a future watermark fails.
    assert.ok(verifyGenerated(board, { tasksHash: "deadbeef", maxEventSeq: 9 }).ok === false);
    assert.ok(verifyGenerated(board, { tasksHash: "abc123", maxEventSeq: 3 }).ok === false);
    assert.ok(verifyGenerated("no footer here", { tasksHash: "abc123", maxEventSeq: 0 }).ok === false);
  });

  it("buildProjections is byte-stable and source-sensitive", () => {
    const input = { tasksText: "{}", tasks, states, events };
    const a = buildProjections(input);
    const b = buildProjections(input);
    assert.equal(a.board, b.board);
    assert.equal(a.log, b.log);
    const moved = buildProjections({
      ...input,
      states: new Map([...states, ["ENG-2", { status: "done", spec_rev: "def" }]]),
    });
    assert.notEqual(a.board, moved.board);
  });

  it("founder report distinguishes claims from results and names approvals", () => {
    const out = renderFounderReport({
      tasks,
      states,
      events,
      pendingApprovals: ["ENG-7 needs founder:push-origin-main"],
      integratedCommit: "deadbeef",
      remotePushed: false,
      tasksHash: "h",
      maxEventSeq: 2,
    });
    assert.ok(out.includes("remote push occurred: NO"));
    assert.ok(out.includes("ENG-7 needs founder:push-origin-main"));
    assert.ok(out.includes("seq 2"));
    assert.ok(out.includes("deadbeef"));
  });
});
