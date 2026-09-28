import type { Operation } from "./operations.js";
import type { NodeDetails, Workspace } from "./model.js";
import { applyOperations } from "./reducer.js";

/**
 * Inverse computation for undo/redo (docs/03 — every AI action reversible).
 *
 * The previous History stored a full workspace snapshot per edit. That breaks in
 * multiplayer: undoing your own change would revert the entire board, including
 * other people's concurrent work. Storing *inverse operations* instead means an
 * undo touches only what that edit touched.
 *
 * `inverseOperations(ops, before)` returns ops that exactly undo `ops`, given the
 * board state immediately before they were applied. Order reverses (last applied,
 * first undone), and deletions are restored with everything they took with them:
 * a deleted node's inverse recreates the node AND its edges, because the reducer
 * drops dangling edges on delete.
 *
 * Known limits, stated rather than hidden:
 * - UPDATE_SHAPE cannot un-set a field that was absent before (the op schema has
 *   no "remove field" except groupId=null). Moves/resizes/recolors/relabels — the
 *   overwhelming majority — round-trip exactly.
 * - Restoring a deleted node re-adds it to its group automatically, because
 *   CREATE_NODE carries the original groupId and the reducer re-links members.
 */

/** Capture the parts of a workspace an operation might destroy. */
function captureNode(ws: Workspace, id: string) {
  return {
    node: ws.nodes[id],
    edges: Object.values(ws.edges).filter((e) => e.source === id || e.target === id),
  };
}

function copyDetails(details: NodeDetails): NodeDetails {
  return {
    sections: details.sections.map((s) => ({
      ...(s.title !== undefined ? { title: s.title } : {}),
      items: [...s.items],
    })),
  };
}

function captureCommentTree(ws: Workspace, id: string) {
  const root = ws.comments[id];
  if (!root) return null;
  return { root, replies: Object.values(ws.comments).filter((c) => c.parentId === id) };
}

/**
 * Compute the operations that undo `ops`, assuming `before` is the state right
 * before `ops` were applied (in order).
 */
export function inverseOperations(ops: readonly Operation[], before: Workspace): Operation[] {
  // Walk forward over a private copy so each inverse sees the state its
  // counterpart saw (required for chained ops like create-then-connect) without
  // mutating the caller's `before`. A one-op apply forces a fresh clone since
  // applyOperations([]) returns the input untouched.
  let walking: Workspace = structuredClone(before);
  const inverses: Operation[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "CREATE_NODE":
        inverses.unshift({ op: "DELETE_NODE", id: op.id });
        break;
      case "DELETE_NODE": {
        const captured = captureNode(walking, op.id);
        if (!captured.node) break;
        const restore: Operation[] = [
          {
            op: "CREATE_NODE",
            id: captured.node.id,
            nodeType: captured.node.nodeType,
            label: captured.node.label,
            ...(captured.node.groupId ? { groupId: captured.node.groupId } : {}),
            // Creation evidence travels with the restore (Stage C2): the
            // node's origin is as much a fact to undo as its position.
            ...(captured.node.provenance ? { provenance: { ...captured.node.provenance } } : {}),
            ...(captured.node.icon ? { icon: captured.node.icon } : {}),
            // A class's attributes, an entity's columns: the node's content,
            // so undoing its delete brings them back with it (V4).
            ...(captured.node.details ? { details: copyDetails(captured.node.details) } : {}),
          },
          // Restoring the node's position and pin state is what makes undo feel
          // exact: a node the user placed by hand would otherwise pop back at
          // the layout engine's choice of coordinates (M0.4).
          ...(captured.node.position
            ? [
                {
                  op: "MOVE_NODE" as const,
                  id: captured.node.id,
                  position: captured.node.position,
                  ...(captured.node.pinned ? {} : { pinned: false }),
                },
              ]
            : []),
          // Same for issue fields: a node deleted with a Jira-style status set
          // reappears without it unless we restore the SET_ISSUE that came with it.
          ...(captured.node.issue
            ? [
                {
                  op: "SET_ISSUE" as const,
                  id: captured.node.id,
                  issue: { ...captured.node.issue },
                },
              ]
            : []),
          // And the same for the statement (Stage C2): the node's meaning must
          // reappear with it, or undo of a delete silently drops a decision.
          ...(captured.node.statement
            ? [
                {
                  op: "SET_STATEMENT" as const,
                  id: captured.node.id,
                  statement: { ...captured.node.statement },
                },
              ]
            : []),
          ...captured.edges.map(
            (e): Operation => ({
              op: "CONNECT_NODES",
              source: e.source,
              target: e.target,
              relationship: e.relationship,
            }),
          ),
          // Manual connectors between the node and shapes (docs/26 §6.4).
          ...Object.values(walking.shapeLinks)
            .filter((l) => l.source === op.id || l.target === op.id)
            .map(
              (l): Operation => ({
                op: "CONNECT_SHAPES",
                id: l.id,
                source: l.source,
                target: l.target,
                ...(l.label !== undefined ? { label: l.label } : {}),
                ...(l.variant !== undefined ? { variant: l.variant } : {}),
                ...(l.doubleArrow !== undefined ? { doubleArrow: l.doubleArrow } : {}),
              }),
            ),
        ];
        inverses.unshift(...restore);
        break;
      }
      case "CHANGE_TEXT": {
        const prev = walking.nodes[op.id]?.label;
        if (prev !== undefined && prev !== op.text)
          inverses.unshift({ op: "CHANGE_TEXT", id: op.id, text: prev });
        break;
      }
      case "CHANGE_NODE_TYPE": {
        const prev = walking.nodes[op.id]?.nodeType;
        if (prev !== undefined && prev !== op.nodeType)
          inverses.unshift({ op: "CHANGE_NODE_TYPE", id: op.id, nodeType: prev });
        break;
      }
      case "SET_NODE_ICON": {
        const node = walking.nodes[op.id];
        if (node && (node.icon ?? null) !== op.icon)
          inverses.unshift({ op: "SET_NODE_ICON", id: op.id, icon: node.icon ?? null });
        break;
      }
      case "SET_NODE_DETAILS": {
        // Whole-value restore: the details the node had (a copy, so a later
        // edit can't reach back into history), or null when it had none.
        const node = walking.nodes[op.id];
        if (node)
          inverses.unshift({
            op: "SET_NODE_DETAILS",
            id: op.id,
            details: node.details ? copyDetails(node.details) : null,
          });
        break;
      }
      case "SET_ISSUE": {
        // Restore whatever issue fields the node had (or clear them if it had none).
        const prev = walking.nodes[op.id]?.issue;
        inverses.unshift({ op: "SET_ISSUE", id: op.id, issue: prev ? { ...prev } : null });
        break;
      }
      case "UPDATE_ISSUE": {
        // Re-apply the full prior issue so every patched field round-trips,
        // including ones cleared to null by the forward op.
        const prev = walking.nodes[op.id]?.issue;
        if (prev) inverses.unshift({ op: "SET_ISSUE", id: op.id, issue: { ...prev } });
        break;
      }
      case "SET_STATEMENT":
      case "UPDATE_STATEMENT": {
        // Restore the node's prior statement (or clear it if it had none),
        // the same full-replay reasoning as UPDATE_ISSUE above.
        const prev = walking.nodes[op.id]?.statement;
        const restore: Operation[] = [
          { op: "SET_STATEMENT", id: op.id, statement: prev ? { ...prev } : null },
        ];
        // Supersession restore (Stage C2): applying this statement marked its
        // targets superseded; undo must give them THEIR prior statements back
        // too, or "undo the rejection" leaves the rejected proposal buried.
        const targets =
          op.op === "SET_STATEMENT" ? (op.statement?.supersedes ?? []) : (op.supersedes ?? []);
        for (const target of targets) {
          const prior = walking.nodes[target]?.statement;
          // Replayed against the walking state, which the SET_STATEMENT above
          // has not yet touched when inverses run forward — prior is the
          // statement exactly as it was before the supersession.
          if (prior) {
            restore.push({ op: "SET_STATEMENT", id: target, statement: { ...prior } });
          }
        }
        inverses.unshift(...restore);
        break;
      }
      case "MOVE_NODE": {
        const prev = walking.nodes[op.id];
        if (prev?.position)
          inverses.unshift({
            op: "MOVE_NODE",
            id: op.id,
            position: prev.position,
            ...(prev.pinned ? {} : { pinned: false }),
          });
        break;
      }
      case "CONNECT_NODES":
        inverses.unshift({
          op: "DISCONNECT_NODES",
          source: op.source,
          target: op.target,
          relationship: op.relationship,
        });
        break;
      case "DISCONNECT_NODES":
        inverses.unshift({
          op: "CONNECT_NODES",
          source: op.source,
          target: op.target,
          relationship: op.relationship,
        });
        break;
      case "CREATE_GROUP":
        inverses.unshift({ op: "DELETE_GROUP", id: op.id });
        break;
      case "DELETE_GROUP": {
        const gone = walking.groups[op.id];
        if (!gone) break;
        inverses.unshift({
          op: "CREATE_GROUP",
          id: gone.id,
          label: gone.label,
          children: [...gone.children],
          ...(gone.kind ? { kind: gone.kind } : {}),
        });
        break;
      }
      case "SET_GROUP_KIND": {
        // Restore the prior kind, including absent (null clears the region).
        const prev = walking.groups[op.id]?.kind;
        inverses.unshift({
          op: "SET_GROUP_KIND",
          id: op.id,
          kind: prev ?? null,
        });
        break;
      }
      case "CREATE_DIAGRAM": {
        const prevKind = walking.diagramKind;
        inverses.unshift({ op: "TRANSFORM_DIAGRAM", to: prevKind });
        break;
      }
      case "TRANSFORM_DIAGRAM": {
        const prevKind = walking.diagramKind;
        if (prevKind !== op.to) inverses.unshift({ op: "TRANSFORM_DIAGRAM", to: prevKind });
        break;
      }
      case "SET_LAYOUT_INTENT": {
        // Restore the prior intent field-for-field. Absent → the inverse
        // clears it ({} deletes, per the reducer's replace-whole contract).
        // An identical intent inverts to the same op, which is harmless.
        const prev = walking.layoutIntent;
        if (!prev || (!prev.direction && !prev.primaryFlow && !prev.emphasis)) {
          inverses.unshift({ op: "SET_LAYOUT_INTENT" });
        } else {
          inverses.unshift({
            op: "SET_LAYOUT_INTENT",
            ...(prev.direction !== undefined ? { direction: prev.direction } : {}),
            ...(prev.primaryFlow !== undefined ? { primaryFlow: [...prev.primaryFlow] } : {}),
            ...(prev.emphasis !== undefined ? { emphasis: [...prev.emphasis] } : {}),
          });
        }
        break;
      }
      case "CREATE_WIREFRAME":
        inverses.unshift({ op: "DELETE_WIREFRAME", id: op.id });
        break;
      case "DELETE_WIREFRAME": {
        const gone = walking.wireframes[op.id];
        if (!gone) break;
        inverses.unshift({ op: "CREATE_WIREFRAME", ...gone });
        break;
      }
      case "CREATE_SHAPE":
        inverses.unshift({ op: "DELETE_SHAPE", id: op.id });
        break;
      case "UPDATE_SHAPE": {
        const prev = walking.shapes[op.id];
        if (!prev) break;
        const restore: Record<string, unknown> = { op: "UPDATE_SHAPE", id: op.id };
        for (const key of ["position", "size", "rotation", "text", "vector", "table", "chart", "style", "z"] as const) {
          if (op[key] === undefined) continue;
          if (prev[key] !== undefined) restore[key] = prev[key];
        }
        // locked/hidden are boolean flags stored as absence when false, so the
        // inverse restores the prior value explicitly — including false, which
        // the reducer maps back to "unset".
        if (op.locked !== undefined) restore.locked = prev.locked ?? false;
        if (op.hidden !== undefined) restore.hidden = prev.hidden ?? false;
        // groupId has a null sentinel for removal.
        if (op.groupId !== undefined) restore.groupId = prev.groupId ?? null;
        inverses.unshift(restore as Operation);
        break;
      }
      case "DELETE_SHAPE": {
        const gone = walking.shapes[op.id];
        if (!gone) break;
        const links = Object.values(walking.shapeLinks).filter(
          (l) => l.source === op.id || l.target === op.id,
        );
        // Recreate the shape, then its connectors as separate ops — an array
        // can't be spread into one CREATE_SHAPE object.
        const restoreShape: Operation[] = [
          {
            op: "CREATE_SHAPE",
            id: gone.id,
            kind: gone.kind,
            position: gone.position,
            size: gone.size,
            ...(gone.rotation !== undefined ? { rotation: gone.rotation } : {}),
            ...(gone.text !== undefined ? { text: gone.text } : {}),
            ...(gone.path !== undefined ? { path: gone.path } : {}),
            ...(gone.src !== undefined ? { src: gone.src } : {}),
            ...(gone.vector !== undefined ? { vector: gone.vector } : {}),
            ...(gone.table !== undefined ? { table: gone.table } : {}),
            ...(gone.chart !== undefined ? { chart: gone.chart } : {}),
            ...(gone.style ? { style: gone.style } : {}),
            z: gone.z ?? 0,
            ...(gone.groupId ? { groupId: gone.groupId } : {}),
            ...(gone.locked !== undefined ? { locked: gone.locked } : {}),
            ...(gone.hidden !== undefined ? { hidden: gone.hidden } : {}),
          },
          ...links.map(
            (l): Operation => ({
              op: "CONNECT_SHAPES",
              id: l.id,
              source: l.source,
              target: l.target,
              ...(l.label !== undefined ? { label: l.label } : {}),
              ...(l.variant !== undefined ? { variant: l.variant } : {}),
              ...(l.doubleArrow !== undefined ? { doubleArrow: l.doubleArrow } : {}),
            }),
          ),
        ];
        inverses.unshift(...restoreShape);
        break;
      }
      case "CONNECT_SHAPES":
        inverses.unshift({ op: "DISCONNECT_SHAPES", id: op.id });
        break;
      case "DISCONNECT_SHAPES": {
        const gone = walking.shapeLinks[op.id];
        if (!gone) break;
        inverses.unshift({
          op: "CONNECT_SHAPES",
          id: gone.id,
          source: gone.source,
          target: gone.target,
          ...(gone.label !== undefined ? { label: gone.label } : {}),
          ...(gone.variant !== undefined ? { variant: gone.variant } : {}),
          ...(gone.doubleArrow !== undefined ? { doubleArrow: gone.doubleArrow } : {}),
        });
        break;
      }
      case "GROUP_SHAPES": {
        // Inverse fidelity: each shape may already belong to a different group.
        // Restoring `groupId: null` would orphan it from its prior group, which
        // is what the old inverse did. Capture the actual prior groupId per id
        // so an undo slots each shape back where it was (M0.4).
        const restore = op.ids.map((id): Operation => {
          const prev = walking.shapes[id];
          const priorGroupId = prev?.groupId ?? null;
          return { op: "UPDATE_SHAPE", id, groupId: priorGroupId };
        });
        inverses.unshift(...restore);
        break;
      }
      case "UNGROUP_SHAPES": {
        const members = Object.values(walking.shapes)
          .filter((s) => s.groupId === op.groupId)
          .map((s) => s.id);
        if (members.length > 0)
          inverses.unshift({ op: "GROUP_SHAPES", groupId: op.groupId, ids: members });
        break;
      }
      case "ADD_VOTE":
        inverses.unshift({ op: "REMOVE_VOTE", id: op.id });
        break;
      case "REMOVE_VOTE": {
        const gone = walking.votes[op.id];
        if (!gone) break;
        inverses.unshift({
          op: "ADD_VOTE",
          id: gone.id,
          targetId: gone.targetId,
          by: gone.by,
        });
        break;
      }
      case "CLEAR_VOTES": {
        const doomed =
          op.targetId === undefined
            ? Object.values(walking.votes)
            : Object.values(walking.votes).filter((v) => v.targetId === op.targetId);
        inverses.unshift(
          ...doomed.map(
            (v): Operation => ({
              op: "ADD_VOTE",
              id: v.id,
              targetId: v.targetId,
              by: v.by,
            }),
          ),
        );
        break;
      }
      case "ADD_REACTION":
        inverses.unshift({ op: "REMOVE_REACTION", id: op.id });
        break;
      case "REMOVE_REACTION": {
        const gone = walking.reactions[op.id];
        if (!gone) break;
        inverses.unshift({
          op: "ADD_REACTION",
          id: gone.id,
          targetId: gone.targetId,
          emoji: gone.emoji,
          by: gone.by,
        });
        break;
      }
      case "ADD_COMMENT":
        inverses.unshift({ op: "DELETE_COMMENT", id: op.id });
        break;
      case "REPLY_COMMENT":
        inverses.unshift({ op: "DELETE_COMMENT", id: op.id });
        break;
      case "RESOLVE_COMMENT": {
        // Inverse fidelity: capture the *prior* resolved state, not just the
        // negation of the forward op. A re-open (forward op resolved=false)
        // would otherwise invert to resolved=true, which is wrong when the
        // thread was already closed and a stale op tried to flip it (M0.4).
        const prev = walking.comments[op.id];
        if (!prev) break;
        const wasResolved = Boolean(prev.resolved);
        inverses.unshift({ op: "RESOLVE_COMMENT", id: op.id, resolved: wasResolved });
        break;
      }
      case "DELETE_COMMENT": {
        const tree = captureCommentTree(walking, op.id);
        if (!tree) break;
        // Restore replies first? No — root first so the reply's parent exists.
        const restore: Operation[] = [
          {
            op: "ADD_COMMENT",
            id: tree.root.id,
            targetId: tree.root.targetId,
            body: tree.root.body,
            by: tree.root.by,
            createdAt: tree.root.createdAt,
          },
          ...tree.replies.flatMap((r): Operation[] => [
            {
              op: "REPLY_COMMENT",
              id: r.id,
              parentId: r.parentId!,
              body: r.body,
              by: r.by,
              createdAt: r.createdAt,
            },
          ]),
        ];
        if (tree.root.resolved)
          restore.push({ op: "RESOLVE_COMMENT", id: tree.root.id, resolved: true });
        inverses.unshift(...restore);
        break;
      }
    }
    // Advance the walk so chained ops see realistic state.
    walking = applyOperations(walking, [op]);
  }

  return inverses;
}
