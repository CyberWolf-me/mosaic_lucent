/**
 * Did everyone end up looking at the same board?
 *
 *   1. Every connected socket holds a gap-free log from its join point to the
 *      server's head, and every socket agrees on what each seq was.
 *   2. Replaying that log through the core reducer from the board's starting
 *      state reproduces the live room's board — and the board the server
 *      PERSISTED converges to it once the room goes quiet (the stored copy is
 *      what reloads, exports, Ask, MCP and the AI's own validation read).
 *   3. Every browser on the canvas renders the same nodes.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { applyOperations } from "../../../packages/core/dist/index.js";
import { canonical } from "./realtime.mjs";
import { nodeLabels } from "./browser.mjs";

/** The semantic content clients render: ids, labels, kinds, links, notes, threads. */
function essence(ws) {
  const nodes = Object.fromEntries(
    Object.entries(ws.nodes ?? {}).map(([id, n]) => [
      id,
      { label: n.label, nodeType: n.nodeType, statement: n.statement?.kind ?? null, status: n.issue?.statusCategory ?? null },
    ]),
  );
  const edges = Object.values(ws.edges ?? {})
    .map((e) => `${e.source}->${e.target}`)
    .sort();
  return {
    nodes,
    edges,
    shapes: Object.keys(ws.shapes ?? {}).sort(),
    comments: Object.keys(ws.comments ?? {}).sort(),
    votes: Object.keys(ws.votes ?? {}).length,
    reactions: Object.keys(ws.reactions ?? {}).length,
  };
}

function describeDiff(a, b) {
  const out = [];
  const an = Object.keys(a.nodes),
    bn = Object.keys(b.nodes);
  const onlyA = an.filter((k) => !b.nodes[k]);
  const onlyB = bn.filter((k) => !a.nodes[k]);
  const changed = an.filter((k) => b.nodes[k] && canonical(a.nodes[k]) !== canonical(b.nodes[k]));
  if (onlyA.length) out.push(`${onlyA.length} node(s) missing from the stored board (${onlyA.slice(0, 3).join(", ")})`);
  if (onlyB.length) out.push(`${onlyB.length} node(s) only in the stored board`);
  if (changed.length)
    out.push(`${changed.length} node(s) differ (${changed.slice(0, 2).map((k) => `${k}: ${canonical(a.nodes[k])} vs ${canonical(b.nodes[k])}`).join("; ")})`);
  for (const key of ["edges", "shapes", "comments"]) {
    if (canonical(a[key]) !== canonical(b[key])) out.push(`${key}: ${a[key].length} vs ${b[key].length}`);
  }
  if (a.votes !== b.votes) out.push(`votes ${a.votes} vs ${b.votes}`);
  if (a.reactions !== b.reactions) out.push(`reactions ${a.reactions} vs ${b.reactions}`);
  return out.join(" · ");
}

export async function checkConvergence(world, { label, startWorkspace, startSeq = 0, browsers = [], knownStale = {} }) {
  const r = world.report;
  let board = await world.serverBoard();
  const head = board.latestSeq;
  const sockets = world.people.filter((p) => p.rt?.open);
  const slug = label.replace(/\W+/g, "_");

  // 1. Logs: complete and identical.
  await Promise.allSettled(sockets.map((p) => p.rt.waitForSeq(head, 20_000)));
  const gappy = sockets.filter((p) => p.rt.contiguousHead() < head);
  r.check(
    `${label}: all ${sockets.length} connected sockets hold the complete log to seq ${head}`,
    gappy.length === 0,
    gappy.map((p) => `${p.name} stops at ${p.rt.contiguousHead()}`).join(", "),
  );
  const disagreements = [];
  for (let seq = startSeq + 1; seq <= head; seq++) {
    const ids = new Set();
    for (const p of sockets) {
      const e = p.rt.entries.get(seq);
      if (e) ids.add(e.operationId ?? canonical(e.ops));
    }
    if (ids.size > 1) disagreements.push(seq);
  }
  r.check(`${label}: every socket agrees on every seq`, disagreements.length === 0, disagreements.slice(0, 10).join(", "));

  // 2. Replay = the log's board; the stored board must converge to it.
  const reference = sockets.find((p) => p.rt.contiguousHead() >= head && (p.rt.joins[0]?.version ?? 0) <= startSeq);
  let replayed = null;
  if (reference && startWorkspace) {
    replayed = structuredClone(startWorkspace);
    for (let seq = startSeq + 1; seq <= head; seq++) replayed = applyOperations(replayed, reference.rt.entries.get(seq).ops);
    const want = canonical(essence(replayed));
    const t0 = Date.now();
    let same = canonical(essence(board.workspace)) === want;
    while (!same && Date.now() - t0 < 10_000) {
      await new Promise((res) => setTimeout(res, 1000));
      board = await world.serverBoard();
      if (board.latestSeq !== head) break; // someone wrote meanwhile; compare at the next checkpoint
      same = canonical(essence(board.workspace)) === want;
    }
    const lag = Date.now() - t0;
    if (!same) {
      writeFileSync(
        path.join(r.artifactDir, `diverged-${slug}.json`),
        JSON.stringify(
          {
            head,
            diff: describeDiff(essence(replayed), essence(board.workspace)),
            replayed,
            server: board.workspace,
            log: [...reference.rt.entries.values()].filter((e) => e.seq > startSeq).sort((a, b) => a.seq - b.seq),
          },
          null,
          2,
        ),
      );
    }
    r.check(
      `${label}: the board the server stored matches the ${head - startSeq} logged batches`,
      same,
      same ? (lag > 1500 ? `caught up after ${lag} ms` : "") : `${describeDiff(essence(replayed), essence(board.workspace))} (still after ${lag} ms idle; see diverged-${slug}.json)`,
      same
        ? {}
        : {
            known:
              "the stored board is written outside the commit order: REST/agent/review commits save a stale base (commitBatch.ts:43-44) and socket commits' saves race (realtime.ts:539-545)",
          },
    );
  }

  // 3. Browsers render the log's nodes.
  const truth = replayed ?? board.workspace;
  const expected = Object.keys(truth.nodes ?? {}).length;
  for (const person of browsers) {
    if (!person.page) continue;
    // The canvas culls what is outside the viewport: fit first, then count.
    await person.page.locator('button[title="Zoom to fit"]').first().click({ timeout: 3_000 }).catch(() => {});
    await new Promise((res) => setTimeout(res, 600));
    let rendered = [];
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      rendered = await nodeLabels(person.page).catch(() => []);
      if (rendered.length === expected) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const ok = rendered.length === expected;
    r.check(
      `${label}: ${person.name}'s browser renders all ${expected} nodes`,
      ok,
      ok ? "" : `renders ${rendered.length}`,
      ok || !knownStale[person.name] ? {} : { known: knownStale[person.name] },
    );
  }
  return { head, board, replayed };
}

export const STALE_AI_BASE =
  "the AI requester's canvas applies the result to the board as it was when they asked, dropping everything others did meanwhile (web/src/workspace.tsx:1242, then updateWorkspace at :835)";
