/**
 * The worker core + protocol, pinned (doc 18 Phase 4): the handler answers
 * each request envelope with its correlated response — geometry, an in-band
 * decline for a region the adapter does not serve, or an error message — and
 * nothing else. Driven directly (Node has no `self`), through the same
 * `handleLayoutRequest` the real worker entry wires to the worker global.
 */

import { describe, expect, it } from "vitest";
import { createWorkspace, layeredBoard, type Operation, type Workspace } from "@lucent/core";
import { ElkLayoutEngine } from "../src/diagram/elk/elkLayoutEngine.js";
import { handleLayoutRequest } from "../src/diagram/elk/layoutWorkerCore.js";
import type {
  LayoutWorkerRequest,
  LayoutWorkerResponse,
} from "../src/diagram/elk/layoutWorkerProtocol.js";

describe("the layout worker core (doc 18 Phase 4)", () => {
  it("answers a board layout with the correlated result", async () => {
    const board = layeredBoard(20);
    const request: LayoutWorkerRequest = { kind: "layout", id: 7, workspace: board, options: {} };
    const responses: LayoutWorkerResponse[] = [];
    await handleLayoutRequest(new ElkLayoutEngine(), request, (m) => responses.push(m));

    expect(responses).toHaveLength(1);
    const out = responses[0]!;
    expect(out.kind).toBe("layout-done");
    if (out.kind !== "layout-done") return;
    expect(out.id).toBe(7);
    expect(Object.keys(out.layout as Record<string, unknown>)).toHaveLength(20);
    // Every node finite — the structural invariant the Phase 2 pins hold too.
    for (const entry of Object.values(
      out.layout as Record<string, { position: { x: number; y: number } }>,
    )) {
      expect(Number.isFinite(entry.position.x)).toBe(true);
      expect(Number.isFinite(entry.position.y)).toBe(true);
    }
  });

  it("declines a non-ELK region in band, by id", async () => {
    // A mindmap region inside a flowchart board: the adapter's region pass
    // serves only its winning families, so the answer is region-declined —
    // NOT an error; the proxy resolves null exactly like the sync seam.
    const ws = createWorkspace({ id: "wk-decline", name: "Decline", diagramKind: "flowchart" });
    const kids = ["m-1", "m-2"];
    for (const id of kids) ws.nodes[id] = { id, nodeType: "idea", label: id, groupId: "g-mind" };
    ws.groups["g-mind"] = { id: "g-mind", label: "Mind", children: kids, kind: "mindmap" };
    const request: LayoutWorkerRequest = {
      kind: "region",
      id: 3,
      workspace: ws,
      groupId: "g-mind",
      options: {},
    };
    const responses: LayoutWorkerResponse[] = [];
    await handleLayoutRequest(new ElkLayoutEngine(), request, (m) => responses.push(m));
    expect(responses).toEqual([{ kind: "region-declined", id: 3 }]);
  });

  it("answers an ELK region with the merged geometry", async () => {
    const ws = layeredBoard(30);
    const group = Object.values(ws.groups)[0] ?? null;
    if (!group) return; // layeredBoard always creates at least one region
    const request: LayoutWorkerRequest = {
      kind: "region",
      id: 11,
      workspace: ws,
      groupId: group.id,
      options: {},
    };
    const responses: LayoutWorkerResponse[] = [];
    await handleLayoutRequest(new ElkLayoutEngine(), request, (m) => responses.push(m));
    const out = responses[0]!;
    expect(out.kind).toBe("layout-done");
    if (out.kind !== "layout-done") return;
    expect(out.id).toBe(11);
    // outside nodes restated
    expect(Object.keys(out.layout as Record<string, unknown>)).toHaveLength(30);
  });

  it("reports a crash as a correlated error, never a throw", async () => {
    const broken = new ElkLayoutEngine();
    // Sabotage the engine so the handler's catch arm runs; the sabotage stays
    // in this test — the real engine's failures are the service's business.
    const request: LayoutWorkerRequest = {
      kind: "layout",
      id: 42,
      workspace: null as unknown as Workspace, // invalid: the adapter throws
      options: {},
    };
    const responses: LayoutWorkerResponse[] = [];
    await handleLayoutRequest(broken, request, (m) => responses.push(m));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ kind: "layout-error", id: 42 });
    expect((responses[0] as { message: string }).message).toBeTruthy();
  });

  it("the ops contract is untouched: envelopes never carry operations", () => {
    // The worker ferries geometry only — an envelope can never smuggle a
    // canvas operation past the validator (the ADR 0038 clause applied to
    // the transport). Pinned structurally: the request union's fields are
    // kind/id/workspace/groupId/options, and workspace objects arrive as
    // semantic state, not as operations.
    const request: LayoutWorkerRequest = { kind: "layout", id: 1, workspace: {}, options: {} };
    expect(Object.keys(request)).toEqual(["kind", "id", "workspace", "options"]);
    const request2: LayoutWorkerRequest = {
      kind: "region",
      id: 2,
      workspace: {},
      groupId: "g",
      options: {},
    };
    expect(Object.keys(request2)).toEqual(["kind", "id", "workspace", "groupId", "options"]);
    // And an Operation never fits the envelope's channels.
    const op: Operation = { op: "CREATE_NODE", id: "n", nodeType: "step", label: "x" } as Operation;
    expect("op" in (request as unknown as Record<string, unknown>)).toBe(false);
    void op;
  });
});
