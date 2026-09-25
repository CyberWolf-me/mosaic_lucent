import {
  detectMermaid,
  mermaidToOps,
  parseMermaid,
  MERMAID_LIMITS,
  type MermaidFlavor,
  type Operation,
  type Workspace,
} from "@lucent/core";

/**
 * Mermaid onto the canvas (docs/27 D2). One decision on top of core's
 * converter: an empty board BECOMES the diagram (its kind), a board with
 * content GAINS it as a region of its own kind — so pasting a state diagram
 * next to an architecture never turns the architecture into a state machine.
 * Ids are prefixed per import, so the same snippet pasted twice lands twice.
 */

const NAME: Record<MermaidFlavor, string> = {
  flowchart: "flowchart",
  state: "state diagram",
  mindmap: "mind map",
  class: "class diagram",
};

export type MermaidImportPlan =
  | { ok: true; ops: Operation[]; nodeIds: string[]; message: string }
  | { ok: false; error: string };

function importPrefix(): string {
  return `mm${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
}

export function planMermaidImport(
  ws: Workspace,
  text: string,
  prefix: string = importPrefix(),
): MermaidImportPlan {
  const flavor = detectMermaid(text);
  if (!flavor) {
    return { ok: false, error: "That isn't a Mermaid flowchart, state diagram or mind map." };
  }
  const onto = Object.keys(ws.nodes).length > 0;
  const ops = mermaidToOps(text, {
    idPrefix: prefix,
    ...(onto ? { region: { id: `${prefix}-region` } } : {}),
  });
  if (ops.length === 0) {
    return { ok: false, error: `That Mermaid ${NAME[flavor]} has no nodes to import.` };
  }
  const graph = parseMermaid(text);
  const nodeIds = ops.flatMap((o) => (o.op === "CREATE_NODE" ? [o.id] : []));
  const n = nodeIds.length;
  let message = `Imported a ${NAME[flavor]} — ${n} node${n === 1 ? "" : "s"}${onto ? ", as its own region" : ""}.`;
  if (graph.nodes.length > MERMAID_LIMITS.nodes) {
    message += ` Only the first ${n} of ${graph.nodes.length} came in.`;
  }
  if (graph.skipped > 0) {
    message += ` Skipped ${graph.skipped} line${graph.skipped === 1 ? "" : "s"} of styling or notes.`;
  }
  return { ok: true, ops, nodeIds, message };
}
