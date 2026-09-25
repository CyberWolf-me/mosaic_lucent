import type { Workspace } from "./model.js";
import { edgeId } from "./model.js";
import type { Operation } from "./operations.js";
import { isUnauthored } from "./authorship.js";
import { isImageDataUrl } from "./schemaPrimitives.js";

/**
 * Semantic validation: schema parsing (operations.ts) guarantees shape, but not
 * that an operation makes sense against the *current* workspace (e.g. connecting
 * a node that doesn't exist). This layer catches those before the reducer runs,
 * so the canvas never enters an inconsistent state. See docs/09 section 4/8.
 *
 * Authorship is one of those semantics (M0.4). `by` is optional in the schema
 * because no client can be trusted to pick it, and every write path is supposed
 * to call `stampAuthorship` before validating. "Supposed to" is what failed: the
 * MCP path shipped without it, and the reducer's `"me"` fallback made an
 * authorless comment look like a real one, so nothing complained. Refusing an
 * unauthored authored op here turns that convention into an invariant — a new
 * write path that forgets to stamp fails on its first comment with a message
 * that names the fix, instead of quietly attributing board content to nobody.
 */

export interface ValidationError {
  index: number;
  op: Operation["op"];
  message: string;
}

export function validateOperations(workspace: Workspace, ops: Operation[]): ValidationError[] {
  const errors: ValidationError[] = [];

  // Simulate presence as ops are applied in order, so an op can reference an
  // entity created by an earlier op in the same batch.
  const nodes = new Set(Object.keys(workspace.nodes));
  const groups = new Set(Object.keys(workspace.groups));
  const edges = new Set(Object.keys(workspace.edges));
  const wireframes = new Set(Object.keys(workspace.wireframes));
  const shapes = new Set(Object.keys(workspace.shapes));
  // Each shape's kind, including shapes created earlier in this batch: a
  // vector/table/chart payload belongs only on the shape kind that renders it.
  const shapeKinds = new Map(Object.values(workspace.shapes).map((s) => [s.id, s.kind]));
  // Locked shapes (M0.5): the validator refuses to mutate or remove them
  // unless the op is explicitly clearing `locked`. The previous behaviour
  // treated `locked` as advisory only, which let a model move, recolor or
  // delete shapes the user had pinned.
  const lockedShapes = new Set(
    Object.values(workspace.shapes)
      .filter((s) => s.locked)
      .map((s) => s.id),
  );
  const shapeLinks = new Set(Object.keys(workspace.shapeLinks));
  const votes = new Set(Object.keys(workspace.votes ?? {}));
  const reactions = new Set(Object.keys(workspace.reactions ?? {}));
  const comments = new Set(Object.keys(workspace.comments ?? {}));
  // Thread roots only: a reply must attach to a root, not to another reply.
  const commentRoots = new Set(
    Object.values(workspace.comments ?? {})
      .filter((c) => !c.parentId)
      .map((c) => c.id),
  );
  // Statement supersession (Stage C2): node id -> the ids its statement
  // supersedes. Maintained through the batch so the cycle check sees links a
  // statement earlier in the same batch created, the same presence-simulation
  // the sets above perform. Nodes carrying a statement is likewise tracked,
  // because "the target must itself be a statement" is exactly the kind of
  // rule a dangling link would silently break.
  const statementOf = new Map<string, NonNullable<Workspace["nodes"][string]["statement"]>>();
  for (const [id, node] of Object.entries(workspace.nodes)) {
    if (node.statement) statementOf.set(id, node.statement);
  }
  // Issue presence (Stage E1): a drives edge's target must be executable —
  // an action statement AND an issue — and the batch may mint the issue in
  // the same batch as the edge, so presence is simulated like `statementOf`.
  const issueOf = new Set<string>();
  for (const [id, node] of Object.entries(workspace.nodes)) {
    if (node.issue) issueOf.add(id);
  }

  /**
   * True when `from`'s supersession closure reaches `to` — i.e. following
   * `supersedes` links from `from` (transitively) arrives at `to`. Bounded by
   * the link count: the walk visits each node once, so a cycle in existing
   * data cannot loop forever, and the check itself is what keeps cycles out.
   */
  const supersedesReaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const queue = [...(statementOf.get(from)?.supersedes ?? [])];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const links = statementOf.get(id)?.supersedes;
      if (links) queue.push(...links);
    }
    return false;
  };

  // Dependency adjacency (Stage D3, ADR 0029): node id -> the upstream ids
  // it waits on, depends_on canonical, blocks normalized to the same form
  // (A blocks B ≡ B depends_on A) so a cycle cannot hide across spellings.
  // Maintained through the batch exactly like `statementOf` — the cycle
  // check must catch a loop formed entirely WITHIN one AI-generated batch,
  // not only against pre-existing edges. related_to carries no dependency
  // semantics and never enters the adjacency.
  const dependsOnOf = new Map<string, string[]>();
  for (const edge of Object.values(workspace.edges)) {
    if (edge.relationship === "depends_on") {
      const list = dependsOnOf.get(edge.source) ?? [];
      list.push(edge.target);
      dependsOnOf.set(edge.source, list);
    } else if (edge.relationship === "blocks") {
      const list = dependsOnOf.get(edge.target) ?? [];
      list.push(edge.source);
      dependsOnOf.set(edge.target, list);
    }
  }
  /** The same seen-bounded walk as supersedesReaches, over the dependency graph. */
  const dependencyReaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const queue = [...(dependsOnOf.get(from) ?? [])];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...(dependsOnOf.get(id) ?? []));
    }
    return false;
  };

  ops.forEach((op, index) => {
    const err = (message: string) => errors.push({ index, op: op.op, message });

    // Checked ahead of the switch so all four annotation ops are covered by one
    // rule, reading the same list `stampAuthorship` does (authorship.ts).
    if (isUnauthored(op)) {
      err(`${op.op} "${op.id}" has no author; stamp authorship before validating`);
    }

    switch (op.op) {
      case "CREATE_NODE":
        if (nodes.has(op.id)) err(`node "${op.id}" already exists`);
        if (op.groupId && !groups.has(op.groupId)) err(`group "${op.groupId}" does not exist`);
        nodes.add(op.id);
        break;
      case "DELETE_NODE":
        if (!nodes.has(op.id)) err(`node "${op.id}" does not exist`);
        nodes.delete(op.id);
        break;
      case "CHANGE_TEXT":
      case "CHANGE_NODE_TYPE":
      case "SET_NODE_ICON":
      case "MOVE_NODE":
        if (!nodes.has(op.id)) err(`node "${op.id}" does not exist`);
        break;
      case "SET_ISSUE":
        if (!nodes.has(op.id)) err(`node "${op.id}" does not exist`);
        // A parent must be a real node, so epic→story links never dangle.
        if (op.issue?.parentId && !nodes.has(op.issue.parentId))
          err(`parent issue "${op.issue.parentId}" does not exist`);
        if (op.issue) issueOf.add(op.id);
        else issueOf.delete(op.id);
        break;
      case "UPDATE_ISSUE":
        if (!nodes.has(op.id)) err(`node "${op.id}" does not exist`);
        if (op.parentId && !nodes.has(op.parentId))
          err(`parent issue "${op.parentId}" does not exist`);
        break;
      case "SET_STATEMENT": {
        if (!nodes.has(op.id)) err(`node "${op.id}" does not exist`);
        const statement = op.statement;
        if (statement) {
          for (const target of statement.supersedes ?? []) {
            if (target === op.id) {
              err(`statement on "${op.id}" cannot supersede itself`);
              continue;
            }
            if (!nodes.has(target)) err(`superseded node "${target}" does not exist`);
            else if (!statementOf.has(target))
              err(`superseded node "${target}" carries no statement`);
            else if (supersedesReaches(target, op.id))
              err(`supersession by "${target}" would cycle back to "${op.id}"`);
          }
          statementOf.set(op.id, statement);
        } else {
          statementOf.delete(op.id);
        }
        break;
      }
      case "UPDATE_STATEMENT": {
        if (!nodes.has(op.id)) err(`node "${op.id}" does not exist`);
        if (op.supersedes) {
          for (const target of op.supersedes) {
            if (target === op.id) {
              err(`statement on "${op.id}" cannot supersede itself`);
              continue;
            }
            if (!nodes.has(target)) err(`superseded node "${target}" does not exist`);
            else if (!statementOf.has(target))
              err(`superseded node "${target}" carries no statement`);
            else if (supersedesReaches(target, op.id))
              err(`supersession by "${target}" would cycle back to "${op.id}"`);
          }
        }
        // The patch merges over the live statement for the cycle check: the
        // NEW list is what will be, and a target may itself have been set
        // earlier in this batch.
        if (statementOf.has(op.id)) {
          const current = statementOf.get(op.id)!;
          statementOf.set(op.id, {
            ...current,
            ...(op.status ? { status: op.status } : {}),
            ...(op.supersedes ? { supersedes: op.supersedes } : {}),
          });
        }
        break;
      }
      case "CONNECT_NODES": {
        if (!nodes.has(op.source)) err(`source node "${op.source}" does not exist`);
        if (!nodes.has(op.target)) err(`target node "${op.target}" does not exist`);
        if (op.source === op.target) err(`cannot connect node "${op.source}" to itself`);
        // The dependency cycle rule (Stage D3, ADR 0029): adding a
        // dependency edge is refused when the OTHER endpoint already
        // reaches this one — including through edges earlier in the same
        // batch. depends_on and blocks normalize to one upstream graph, so
        // a cycle cannot hide across the two spellings. related_to carries
        // no semantics and cycles freely.
        if (op.relationship === "depends_on" || op.relationship === "blocks") {
          const dependent = op.relationship === "blocks" ? op.target : op.source;
          const upstream = op.relationship === "blocks" ? op.source : op.target;
          if (dependencyReaches(upstream, dependent)) {
            err(
              `dependency "${op.source}" ${op.relationship} "${op.target}" would form a cycle (via ${upstream} → … → ${dependent})`,
            );
          } else {
            const list = dependsOnOf.get(dependent) ?? [];
            list.push(upstream);
            dependsOnOf.set(dependent, list);
          }
        }
        // The drives endpoint rule (Stage E1, ADR 0037): causality has typed
        // endpoints — the source must carry a DECISION statement, the target
        // must be executable work (action statement + issue). Both are
        // readable from statements/issues minted earlier in the same batch.
        // No cycle rule: a decision driving an action is historical fact, not
        // a dependency — it never blocks and never propagates.
        if (op.relationship === "drives") {
          const sourceStatement = statementOf.get(op.source);
          const targetStatement = statementOf.get(op.target);
          if (!sourceStatement || sourceStatement.kind !== "decision") {
            err(
              `drives edge from "${op.source}" to "${op.target}" refused: the source carries no decision statement`,
            );
          }
          if (!targetStatement || targetStatement.kind !== "action" || !issueOf.has(op.target)) {
            err(
              `drives edge from "${op.source}" to "${op.target}" refused: the target is not executable work (an action statement and an issue)`,
            );
          }
        }
        edges.add(edgeId(op.source, op.target, op.relationship));
        break;
      }
      case "DISCONNECT_NODES": {
        const id = edgeId(op.source, op.target, op.relationship);
        if (!edges.has(id)) err(`edge ${id} does not exist`);
        edges.delete(id);
        // Removing a dependency edge is always valid (unblocking can never
        // form a cycle); the simulated adjacency drops the upstream link so
        // later ops in the batch validate against the post-disconnect graph.
        if (op.relationship === "depends_on") {
          const list = dependsOnOf.get(op.source);
          if (list)
            dependsOnOf.set(
              op.source,
              list.filter((t) => t !== op.target),
            );
        } else if (op.relationship === "blocks") {
          const list = dependsOnOf.get(op.target);
          if (list)
            dependsOnOf.set(
              op.target,
              list.filter((t) => t !== op.source),
            );
        }
        break;
      }
      case "CREATE_GROUP":
        if (groups.has(op.id)) err(`group "${op.id}" already exists`);
        // Children may be created later in the same batch (a node's own
        // groupId also links it), so we don't require them to pre-exist.
        groups.add(op.id);
        break;
      case "DELETE_GROUP":
        if (!groups.has(op.id)) err(`group "${op.id}" does not exist`);
        groups.delete(op.id);
        break;
      case "SET_GROUP_KIND":
        if (!groups.has(op.id)) err(`group "${op.id}" does not exist`);
        break;
      case "CREATE_DIAGRAM":
      case "TRANSFORM_DIAGRAM":
        break;
      case "SET_LAYOUT_INTENT": {
        // Intent may reference nodes created earlier in the same batch (a
        // fresh board's spine arrives with the board), so the check is
        // against the batch-evolving node set like every other op.
        for (const id of op.primaryFlow ?? []) {
          if (!nodes.has(id)) err(`primaryFlow node "${id}" does not exist`);
        }
        for (const id of op.emphasis ?? []) {
          if (!nodes.has(id)) err(`emphasis node "${id}" does not exist`);
        }
        break;
      }
      case "CREATE_WIREFRAME":
        if (wireframes.has(op.id)) err(`wireframe "${op.id}" already exists`);
        wireframes.add(op.id);
        break;
      case "DELETE_WIREFRAME":
        if (!wireframes.has(op.id)) err(`wireframe "${op.id}" does not exist`);
        wireframes.delete(op.id);
        break;
      case "CREATE_SHAPE":
        if (shapes.has(op.id)) err(`shape "${op.id}" already exists`);
        // An inline base64 image is how pasted and generated images travel, but
        // only an image shape renders `src` in an <img>: on an embed the same
        // field reaches an iframe, so it stays http(s)-only there.
        // A vector shape is its paths; only a vector shape carries them.
        if (op.kind === "vector" && !op.vector) err(`vector shape "${op.id}" has no paths`);
        if (op.vector && op.kind !== "vector")
          err(`only a vector shape carries paths, not "${op.kind}"`);
        // Same rule for the V4 data objects: a table shape IS its grid and a
        // chart shape IS its data, and neither payload rides any other kind —
        // otherwise a later edit could add one where the inverse has nothing
        // to restore, and undo would silently keep it.
        if (op.kind === "table" && !op.table) err(`table shape "${op.id}" has no table data`);
        if (op.table && op.kind !== "table")
          err(`only a table shape carries table data, not "${op.kind}"`);
        if (op.kind === "chart" && !op.chart) err(`chart shape "${op.id}" has no chart data`);
        if (op.chart && op.kind !== "chart")
          err(`only a chart shape carries chart data, not "${op.kind}"`);
        if (op.src && op.kind !== "image" && isImageDataUrl(op.src)) {
          err(`a data URL src is only allowed on an image shape, not "${op.kind}"`);
        }
        shapes.add(op.id);
        shapeKinds.set(op.id, op.kind);
        // A new shape may declare itself locked at creation. Treating that the
        // same as a post-creation update keeps the lock-state invariant
        // uniform across all paths that introduce a shape.
        if (op.locked === true) lockedShapes.add(op.id);
        break;
      case "UPDATE_SHAPE": {
        if (!shapes.has(op.id)) err(`shape "${op.id}" does not exist`);
        const kind = shapeKinds.get(op.id);
        if (kind !== undefined) {
          if (op.vector && kind !== "vector") err(`only a vector shape carries paths, not "${kind}"`);
          if (op.table && kind !== "table")
            err(`only a table shape carries table data, not "${kind}"`);
          if (op.chart && kind !== "chart")
            err(`only a chart shape carries chart data, not "${kind}"`);
        }
        // Locked shapes may only be updated to clear their own lock; anything
        // else is a move/recolour/relabel the AI should not perform.
        const isLocked = lockedShapes.has(op.id);
        const clearsLock = op.locked === false;
        if (isLocked && !clearsLock) {
          err(`shape "${op.id}" is locked; clear the lock before further edits`);
        }
        if (op.locked === true) lockedShapes.add(op.id);
        else if (clearsLock) lockedShapes.delete(op.id);
        break;
      }
      case "DELETE_SHAPE": {
        if (!shapes.has(op.id)) err(`shape "${op.id}" does not exist`);
        if (lockedShapes.has(op.id)) err(`shape "${op.id}" is locked`);
        shapes.delete(op.id);
        shapeKinds.delete(op.id);
        lockedShapes.delete(op.id);
        break;
      }
      case "CONNECT_SHAPES":
        if (shapeLinks.has(op.id)) err(`shape link "${op.id}" already exists`);
        if (!shapes.has(op.source)) err(`shape link source "${op.source}" does not exist`);
        if (!shapes.has(op.target)) err(`shape link target "${op.target}" does not exist`);
        shapeLinks.add(op.id);
        break;
      case "UPDATE_LINK":
        if (!shapeLinks.has(op.id)) err(`shape link "${op.id}" does not exist`);
        break;
      case "DISCONNECT_SHAPES":
        if (!shapeLinks.has(op.id)) err(`shape link "${op.id}" does not exist`);
        shapeLinks.delete(op.id);
        break;
      case "GROUP_SHAPES":
        for (const id of op.ids) {
          if (!shapes.has(id)) err(`shape "${id}" does not exist`);
          if (lockedShapes.has(id)) err(`shape "${id}" is locked`);
        }
        break;
      case "UNGROUP_SHAPES":
        break;

      // Votes and reactions attach to either a node or a shape.
      case "ADD_VOTE":
        if (votes.has(op.id)) err(`vote "${op.id}" already exists`);
        if (!nodes.has(op.targetId) && !shapes.has(op.targetId))
          err(`vote target "${op.targetId}" does not exist`);
        votes.add(op.id);
        break;
      case "REMOVE_VOTE":
        if (!votes.has(op.id)) err(`vote "${op.id}" does not exist`);
        votes.delete(op.id);
        break;
      case "CLEAR_VOTES":
        if (op.targetId !== undefined && !nodes.has(op.targetId) && !shapes.has(op.targetId))
          err(`vote target "${op.targetId}" does not exist`);
        break;
      case "ADD_REACTION":
        if (reactions.has(op.id)) err(`reaction "${op.id}" already exists`);
        if (!nodes.has(op.targetId) && !shapes.has(op.targetId))
          err(`reaction target "${op.targetId}" does not exist`);
        reactions.add(op.id);
        break;
      case "REMOVE_REACTION":
        if (!reactions.has(op.id)) err(`reaction "${op.id}" does not exist`);
        reactions.delete(op.id);
        break;

      // Comment threads anchor to a node or shape; replies attach to a root.
      case "ADD_COMMENT":
        if (comments.has(op.id)) err(`comment "${op.id}" already exists`);
        if (!nodes.has(op.targetId) && !shapes.has(op.targetId))
          err(`comment target "${op.targetId}" does not exist`);
        comments.add(op.id);
        commentRoots.add(op.id);
        break;
      case "REPLY_COMMENT":
        if (comments.has(op.id)) err(`comment "${op.id}" already exists`);
        if (!commentRoots.has(op.parentId)) err(`comment thread "${op.parentId}" does not exist`);
        comments.add(op.id);
        break;
      case "RESOLVE_COMMENT":
        if (!commentRoots.has(op.id)) err(`comment thread "${op.id}" does not exist`);
        break;
      case "DELETE_COMMENT":
        if (!comments.has(op.id)) err(`comment "${op.id}" does not exist`);
        comments.delete(op.id);
        commentRoots.delete(op.id);
        break;
    }
  });

  return errors;
}
