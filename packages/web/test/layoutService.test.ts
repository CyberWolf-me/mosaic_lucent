/**
 * The layout service, pinned (doc 18 Phase 4, ADR 0039): kind-based routing,
 * failure fallback with retained geometry, and the spatial-additivity
 * invariant through the ELK region path — the "add one node, the rest of the
 * board holds still" acceptance, expressed the way Lucent actually commits
 * (scoped to a region).
 */

import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyRoutes,
  computeLayoutWithRoutes,
  createWorkspace,
  layeredBoard,
  mixedRegionBoard,
  swimlaneBoard,
  type DiagramLayoutEngine,
  type Workspace,
} from "@lucent/core";
import { ELK_LAYOUT_ENGINE, WorkerElkEngine, WORKER_ELK_ENGINE } from "../src/diagram/elk/index.js";
import { elkEligible, layoutBoard, relayoutRegionScoped } from "../src/diagram/layoutService.js";

/** A flowchart region of `n` members plus `k` ungrouped flow nodes. */
function regionBoard(n: number, k: number): Workspace {
  const ws = createWorkspace({ id: "svc-region", name: "Region", diagramKind: "flowchart" });
  const children: string[] = [];
  for (let i = 0; i < n; i++) {
    const node = { id: `r-${String(i).padStart(3, "0")}`, nodeType: "service", label: `Step ${i}` };
    ws.nodes[node.id] = { ...node, groupId: "region-main" };
    children.push(node.id);
    if (i > 0) {
      ws.edges[`e-r-${i}`] = {
        id: `e-r-${i}`,
        source: `r-${String(i - 1).padStart(3, "0")}`,
        target: node.id,
        relationship: "calls",
      };
    }
  }
  ws.groups["region-main"] = { id: "region-main", label: "Main", children, kind: "flowchart" };
  let prev: string | null = null;
  for (let i = 0; i < k; i++) {
    const node = { id: `f-${i}`, nodeType: "step", label: `Flow ${i}` };
    ws.nodes[node.id] = node;
    if (prev)
      ws.edges[`e-f-${i}`] = {
        id: `e-f-${i}`,
        source: prev,
        target: node.id,
        relationship: "then",
      };
    prev = node.id;
  }
  return ws;
}

const throwing: DiagramLayoutEngine = {
  id: "test-throwing",
  supports: () => true,
  layout: () => {
    throw new Error("engine exploded");
  },
};

describe("layout service routing (ADR 0039)", () => {
  it(
    "routes flat flowchart boards to ELK",
    async () => {
      // The routing pin: an ELK-eligible board must reach ELK, never the
      // built-in engine. The primary is injected because the DEFAULT primary
      // is the worker proxy, which cannot spawn under vitest's Node runtime —
      // that default chain (worker rejects → built-in answers) is the
      // unspawnable-worker test below.
      const outcome = await layoutBoard(layeredBoard(40), {}, { primary: ELK_LAYOUT_ENGINE });
      expect(outcome.engineId).toBe("elk-0.12");
      expect(outcome.degraded).toBe(false);
    },
    15_000,
  );

  it("routes mixed-region and process boards to the built-in engines", async () => {
    expect(elkEligible(mixedRegionBoard(40))).toBe(false);
    expect(elkEligible(swimlaneBoard(40))).toBe(false);
    const mixed = await layoutBoard(mixedRegionBoard(40));
    expect(mixed.engineId).toBe("lucent-current");
  });

  it("a foreign-kind region makes an otherwise-ELK board ineligible", () => {
    const ws = layeredBoard(40);
    ws.groups["g-mind"] = {
      id: "g-mind",
      label: "Mind",
      children: [],
      kind: "mindmap",
    };
    expect(elkEligible(ws)).toBe(false);
  });

  it("falls back to the built-in engine when the primary throws", async () => {
    const outcome = await layoutBoard(layeredBoard(40), {}, { primary: throwing });
    expect(outcome.engineId).toBe("lucent-current");
    expect(outcome.degraded).toBe(false);
  });

  it("retains the previous geometry, degraded, when every engine fails", async () => {
    const ws = layeredBoard(40);
    const outcome = await layoutBoard(ws, {}, { primary: throwing, fallback: throwing });
    expect(outcome.engineId).toBeNull();
    expect(outcome.degraded).toBe(true);
    expect(outcome.workspace).toBe(ws); // geometry retained, not blanked
  });
});

describe("the production engine path — the worker proxy (doc 18 Phase 4)", () => {
  it("an unspawnable worker rejects and the built-in fallback answers", async () => {
    // Node has no Worker: the production defaultSpawn returns null, which is
    // exactly the "browser blocked workers" production case. The service's
    // contract: fall back, never throw into the render path.
    const outcome = await layoutBoard(layeredBoard(40), {}, { primary: WORKER_ELK_ENGINE });
    expect(outcome.engineId).toBe("lucent-current");
    expect(outcome.degraded).toBe(false);
  });

  it("a worker proxy behind a scripted worker produces ELK geometry", async () => {
    const fake = new FakeReplyingWorker();
    const proxy = new WorkerElkEngine(() => fake as unknown as Worker);
    const outcome = await layoutBoard(layeredBoard(20), {}, { primary: proxy });
    expect(outcome.engineId).toBe(proxy.id);
    expect(fake.requests).toHaveLength(1);
    // The stamped workspace carries the geometry the fake produced for the
    // node it placed (n-000: (5,5)); nodes the fake never listed keep the
    // positions they already held — applyLayout's own contract.
    expect(outcome.workspace.nodes["n-000"]?.position).toEqual({ x: 5, y: 5 });
  });

  it("region scope through the service: decline falls to the built-in region pass", async () => {
    const ws = regionBoard(20, 2);
    const stamped = applyRoutes(
      applyLayout(ws, computeLayoutWithRoutes(ws).layout),
      computeLayoutWithRoutes(ws).routes,
    );
    const declining = new WorkerElkEngine(() => new FakeDecliningWorker() as unknown as Worker);
    const outcome = await relayoutRegionScoped(stamped, "region-main", {}, { primary: declining });
    // The worker declined in band; the built-in engine's region pass answers.
    expect(outcome.engineId).toBe("lucent-current");
    expect(outcome.degraded).toBe(false);
  });
});

/** A fake worker that replies with a fixed single-node layout. */
class FakeReplyingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  requests: unknown[] = [];
  postMessage(envelope: unknown): void {
    this.requests.push(envelope);
    const { id } = envelope as { id: number };
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          kind: "layout-done",
          id,
          layout: { "n-000": { position: { x: 5, y: 5 }, size: { width: 50, height: 50 } } },
          routes: {},
        },
      } as MessageEvent);
    });
  }
  terminate(): void {}
}

/** A fake worker whose every region request is declined in band. */
class FakeDecliningWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(envelope: unknown): void {
    const { id, kind } = envelope as { id: number; kind: string };
    queueMicrotask(() => {
      this.onmessage?.({
        data:
          kind === "region"
            ? { kind: "region-declined", id }
            : { kind: "layout-error", id, message: "no" },
      } as MessageEvent);
    });
  }
  terminate(): void {}
}

describe("the spatial-additivity invariant through ELK (Phase 4)", () => {
  it("the advisory's 100+1 test, scoped: outside nodes are pixel-identical", async () => {
    // 100-node flowchart region + 3 ungrouped nodes. Stamp geometry with the
    // ELK engine first (the committed board), then add ONE node inside the
    // region and re-run the scoped path. Everything outside the region must
    // be pixel-identical — by contract, and now by test.
    const ws = regionBoard(100, 3);
    const first = await ELK_LAYOUT_ENGINE.layout({ workspace: ws, options: {} });
    const committed = applyRoutes(applyLayout(ws, first.layout), first.routes);

    const probe = {
      id: "probe-added-node",
      nodeType: "service",
      label: "Added step",
      groupId: "region-main",
    };
    const edited: Workspace = {
      ...committed,
      nodes: { ...committed.nodes, [probe.id]: probe },
      edges: {
        ...committed.edges,
        "e-probe": {
          id: "e-probe",
          source: "r-099",
          target: probe.id,
          relationship: "calls",
        },
      },
    };

    const outcome = await relayoutRegionScoped(edited, "region-main");
    expect(outcome.degraded).toBe(false);
    expect(outcome.engineId).toBe("elk-0.12");

    const before = committed.nodes;
    const after = outcome.workspace.nodes;
    for (const id of ["f-0", "f-1", "f-2"]) {
      expect(after[id]!.position).toEqual(before[id]!.position);
    }
    // The region itself re-laid out and the probe landed inside it.
    expect(after["probe-added-node"]!.position).toBeTruthy();
  });

  it("a non-ELK region routes to the built-in engine, outside nodes held", async () => {
    const ws = mixedRegionBoard(80);
    const stamped = applyRoutes(
      applyLayout(ws, (await import("@lucent/core")).computeLayout(ws)),
      (await import("@lucent/core")).computeLayoutWithRoutes(ws).routes,
    );
    const outcome = await relayoutRegionScoped(stamped, "region-mind");
    expect(outcome.engineId).toBe("lucent-current");
    const before = stamped.nodes;
    const after = outcome.workspace.nodes;
    for (const [id, node] of Object.entries(before)) {
      if (node.groupId === "region-mind") continue;
      expect(after[id]!.position).toEqual(node.position!);
    }
  });

  it("falls back to the built-in region pass when the ELK region throws", async () => {
    const ws = regionBoard(20, 2);
    const stamped = applyRoutes(
      applyLayout(ws, (await import("@lucent/core")).computeLayout(ws)),
      (await import("@lucent/core")).computeLayoutWithRoutes(ws).routes,
    );
    const outcome = await relayoutRegionScoped(stamped, "region-main", {}, { primary: throwing });
    expect(outcome.engineId).toBe("lucent-current");
    expect(outcome.degraded).toBe(false);
  });
});
