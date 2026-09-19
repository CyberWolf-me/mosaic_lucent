/**
 * The worker proxy, pinned (doc 18 Phase 4): request/response correlation by
 * id (concurrent calls never cross), the in-band decline as null, worker
 * death failing its outstanding calls, an unspawnable worker rejecting so
 * the service's built-in fallback answers, and a hang rejecting after the
 * timeout with the next call re-spawning fresh.
 *
 * The spawn is injected — a fake worker is a MessageEvent-emitter pair; no
 * DOM is needed (the suite runs in Node).
 */

import { describe, expect, it, vi } from "vitest";
import { createWorkspace, layeredBoard } from "@lucent/core";
import { WorkerElkEngine } from "../src/diagram/elk/elkWorkerEngine.js";
import type {
  LayoutWorkerRequest,
  LayoutWorkerResponse,
} from "../src/diagram/elk/layoutWorkerProtocol.js";

/** A scriptable fake worker: queue requests, reply when the test decides. */
class FakeWorker {
  onmessage: ((event: MessageEvent<LayoutWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  received: LayoutWorkerRequest[] = [];

  postMessage(envelope: LayoutWorkerRequest): void {
    this.received.push(envelope);
  }

  reply(message: LayoutWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<LayoutWorkerResponse>);
  }

  die(): void {
    this.onerror?.();
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("the worker proxy (doc 18 Phase 4)", () => {
  it("correlates concurrent requests — replies never cross", async () => {
    const fake = new FakeWorker();
    const engine = new WorkerElkEngine(() => fake as unknown as Worker);
    const a = engine.layout({ workspace: layeredBoard(20), options: {} });
    const b = engine.layout({ workspace: layeredBoard(40), options: {} });

    // Reply out of order: b's answer arrives first. Each promise must still
    // resolve with ITS OWN id's payload (20 vs 40 node layouts).
    const idB = fake.received.find((r) => r.kind === "layout" && r.id === 2)!;
    const idA = fake.received.find((r) => r.kind === "layout" && r.id === 1)!;
    const mkLayout = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `node-${i}`,
          { position: { x: i, y: 0 }, size: { width: 10, height: 10 } },
        ]),
      );
    fake.reply({ kind: "layout-done", id: idB.id, layout: mkLayout(40), routes: {} });
    fake.reply({ kind: "layout-done", id: idA.id, layout: mkLayout(20), routes: {} });

    const [outA, outB] = await Promise.all([a, b]);
    expect(Object.keys(outA.layout)).toHaveLength(20);
    expect(Object.keys(outB.layout)).toHaveLength(40);
  });

  it("resolves a region decline to null (the sync contract's null)", async () => {
    const fake = new FakeWorker();
    const engine = new WorkerElkEngine(() => fake as unknown as Worker);
    // A flowchart region (the adapter serves these); the decline comes from
    // the reply below, so the workspace only needs a real group.
    const ws = createWorkspace({ id: "wk-region", name: "Region", diagramKind: "flowchart" });
    ws.nodes["n-1"] = { id: "n-1", nodeType: "step", label: "One", groupId: "g-main" };
    ws.groups["g-main"] = { id: "g-main", label: "Main", children: ["n-1"], kind: "flowchart" };
    const call = engine.relayoutRegion(ws, "g-main");
    fake.reply({ kind: "region-declined", id: fake.received[0]!.id });
    expect(await call).toBeNull();
  });

  it("rejects when the worker cannot spawn — the service's fallback answers", async () => {
    const engine = new WorkerElkEngine(() => null);
    await expect(engine.layout({ workspace: layeredBoard(20), options: {} })).rejects.toThrow(
      /unavailable/,
    );
  });

  it("fails outstanding calls when the worker dies; the next call re-spawns", async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const spawned = [first, second];
    let calls = 0;
    const engine = new WorkerElkEngine(() => spawned[calls++]! as unknown as Worker);

    const dying = engine.layout({ workspace: layeredBoard(20), options: {} });
    first.die();
    await expect(dying).rejects.toThrow(/worker failed/);

    // The re-spawn serves the next request; a reply on the dead worker is
    // ignored (its id was freed).
    const fresh = engine.layout({ workspace: layeredBoard(40), options: {} });
    const id = second.received[0]!.id;
    first.reply({ kind: "layout-done", id: 999, layout: {}, routes: {} });
    second.reply({
      kind: "layout-done",
      id,
      layout: { n: { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } },
      routes: {},
    });
    const out = await fresh;
    expect(Object.keys(out.layout)).toEqual(["n"]);
  });

  it("rejects a hang after the timeout and re-spawns for the next call", async () => {
    vi.useFakeTimers();
    try {
      const hanging = new FakeWorker(); // never replies
      const fresh = new FakeWorker();
      const spawned = [hanging, fresh];
      let calls = 0;
      const engine = new WorkerElkEngine(() => spawned[calls++]! as unknown as Worker);

      const hung = engine.layout({ workspace: layeredBoard(20), options: {} });
      const advance = vi.advanceTimersByTimeAsync(20_001);
      await expect(Promise.all([hung, advance])).rejects.toThrow(/timed out/);
      // The hung worker was killed — terminate is the respawn contract.
      expect(hanging.terminated).toBe(true);

      const next = engine.layout({ workspace: layeredBoard(20), options: {} });
      const id = fresh.received[0]!.id;
      fresh.reply({
        kind: "layout-done",
        id,
        layout: { ok: { position: { x: 1, y: 1 }, size: { width: 2, height: 2 } } },
        routes: {},
      });
      expect(Object.keys((await next).layout)).toEqual(["ok"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
