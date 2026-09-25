import type { Workspace } from "./model.js";
import { categorizeStatus, edgeId, parseMentions } from "./model.js";
import type { Operation } from "./operations.js";
import { UNKNOWN_AUTHOR } from "./authorship.js";

/**
 * Pure reducer: applyOperation(state, op) -> new state. No mutation of the
 * input, no side effects, no coordinates (layout is a separate pass). This is
 * what makes AI actions deterministic and reversible. See docs/03 and docs/09.
 *
 * Callers should validate ops first (validator.ts). The reducer assumes valid
 * input and applies changes idempotently where possible.
 *
 * Authorship (M0.4): the annotation cases below fall back to `UNKNOWN_AUTHOR`
 * when an op carries no `by`. They used to fall back to `"me"`, which is a
 * plausible-looking identity nobody owns — so an unauthored op was
 * indistinguishable from an authored one and the MCP path could ship with no
 * stamping at all without anyone noticing. The fallback is not a licence to skip
 * stamping: `validateOperations` now refuses an authored op with no author, so
 * every path that validates is rejected loudly instead. What is left are the two
 * paths that cannot validate and cannot be dropped — an already-durable op
 * replayed out of the op log (boardSync's catchup applies log entries directly),
 * and the throwaway validation workspace `generate.ts` rebuilds from a client
 * summary that reports vote counts but no voters. For those, "no author was
 * recorded" is the truth, and `UNKNOWN_AUTHOR` says it.
 */

function clone(workspace: Workspace): Workspace {
  return {
    ...workspace,
    nodes: { ...workspace.nodes },
    edges: { ...workspace.edges },
    groups: { ...workspace.groups },
    wireframes: { ...workspace.wireframes },
    shapes: { ...workspace.shapes },
    shapeLinks: { ...workspace.shapeLinks },
    votes: { ...(workspace.votes ?? {}) },
    reactions: { ...(workspace.reactions ?? {}) },
    comments: { ...(workspace.comments ?? {}) },
  };
}

/**
 * Remove votes and reactions attached to a deleted object, so a tally can never
 * count annotations pointing at something that no longer exists.
 */
function dropAnnotations(next: Workspace, targetId: string): void {
  for (const [id, v] of Object.entries(next.votes)) {
    if (v.targetId === targetId) delete next.votes[id];
  }
  for (const [id, r] of Object.entries(next.reactions)) {
    if (r.targetId === targetId) delete next.reactions[id];
  }
  // Comment threads on a deleted object go with it, replies included.
  const doomed = new Set(
    Object.values(next.comments)
      .filter((c) => c.targetId === targetId)
      .map((c) => c.id),
  );
  for (const [id, c] of Object.entries(next.comments)) {
    if (doomed.has(id) || (c.parentId && doomed.has(c.parentId))) delete next.comments[id];
  }
}

export function applyOperation(workspace: Workspace, op: Operation): Workspace {
  const next = clone(workspace);

  switch (op.op) {
    case "CREATE_NODE": {
      next.nodes[op.id] = {
        id: op.id,
        nodeType: op.nodeType,
        label: op.label,
        ...(op.groupId ? { groupId: op.groupId } : {}),
        // Creation evidence (Stage C2): stored once, untouched by every later
        // op. A node's origin is not part of its mutable state.
        ...(op.provenance ? { provenance: op.provenance } : {}),
        ...(op.icon ? { icon: op.icon } : {}),
      };
      if (op.groupId) {
        const group = next.groups[op.groupId];
        if (group && !group.children.includes(op.id)) {
          next.groups[op.groupId] = {
            ...group,
            children: [...group.children, op.id],
          };
        }
      } else {
        // Membership is bidirectional (Stage E3): a node created into a
        // group that ALREADY lists it as a child inherits that group — the
        // mirror of the CREATE_GROUP stamp above. The repair pass reorders
        // CREATE_GROUP (bucket 1) before CREATE_NODE (bucket 2), so a batch
        // that emits "group with children" then the children themselves
        // (the plan's workstream tree) must converge on the same membership
        // as the unreordered batch. When SEVERAL groups already list the
        // node (the plan region plus its workstreams), the LAST-created
        // wins — the same last-write-wins the CREATE_GROUP stamp applies
        // to existing nodes, so order never changes membership.
        let gid: string | undefined;
        for (const [id, group] of Object.entries(next.groups)) {
          if (group.children.includes(op.id)) gid = id;
        }
        if (gid) next.nodes[op.id] = { ...next.nodes[op.id]!, groupId: gid };
      }
      break;
    }

    case "DELETE_NODE": {
      delete next.nodes[op.id];
      // Drop dangling edges touching this node.
      for (const [id, edge] of Object.entries(next.edges)) {
        if (edge.source === op.id || edge.target === op.id) delete next.edges[id];
      }
      // Remove from any group membership.
      for (const [gid, group] of Object.entries(next.groups)) {
        if (group.children.includes(op.id)) {
          next.groups[gid] = {
            ...group,
            children: group.children.filter((c) => c !== op.id),
          };
        }
      }
      dropAnnotations(next, op.id);
      break;
    }

    case "CHANGE_TEXT": {
      const node = next.nodes[op.id];
      if (node) next.nodes[op.id] = { ...node, label: op.text };
      break;
    }

    case "CHANGE_NODE_TYPE": {
      const node = next.nodes[op.id];
      if (node) next.nodes[op.id] = { ...node, nodeType: op.nodeType };
      break;
    }

    case "SET_NODE_ICON": {
      const node = next.nodes[op.id];
      if (node) {
        const { icon: _prev, ...rest } = node;
        next.nodes[op.id] = op.icon === null ? rest : { ...rest, icon: op.icon };
      }
      break;
    }

    case "SET_ISSUE": {
      const node = next.nodes[op.id];
      if (node) {
        if (op.issue === null) {
          const { issue: _drop, ...rest } = node;
          next.nodes[op.id] = rest;
        } else {
          next.nodes[op.id] = {
            ...node,
            issue: {
              ...op.issue,
              statusCategory: op.issue.statusCategory ?? categorizeStatus(op.issue.status),
            },
          };
        }
      }
      break;
    }

    case "UPDATE_ISSUE": {
      const node = next.nodes[op.id];
      if (node?.issue) {
        const issue = { ...node.issue };
        if (op.status !== undefined) {
          issue.status = op.status;
          // A status change re-derives the column unless one was given.
          issue.statusCategory = op.statusCategory ?? categorizeStatus(op.status);
        } else if (op.statusCategory !== undefined) {
          issue.statusCategory = op.statusCategory;
        }
        // Nullable fields: null clears, undefined leaves untouched.
        if (op.assignee !== undefined) {
          if (op.assignee === null) delete issue.assignee;
          else issue.assignee = op.assignee;
        }
        if (op.priority !== undefined) {
          if (op.priority === null) delete issue.priority;
          else issue.priority = op.priority;
        }
        if (op.storyPoints !== undefined) {
          if (op.storyPoints === null) delete issue.storyPoints;
          else issue.storyPoints = op.storyPoints;
        }
        if (op.labels !== undefined) issue.labels = op.labels;
        if (op.parentId !== undefined) {
          if (op.parentId === null) delete issue.parentId;
          else issue.parentId = op.parentId;
        }
        // Stage D1: the execution fields patch independently — no field ever
        // derives another (ADR 0027: status stays untouched when the assignee
        // changes, and vice versa).
        if (op.dueDate !== undefined) {
          if (op.dueDate === null) delete issue.dueDate;
          else issue.dueDate = op.dueDate;
        }
        if (op.description !== undefined) {
          if (op.description === null) delete issue.description;
          else issue.description = op.description;
        }
        next.nodes[op.id] = { ...node, issue };
      }
      break;
    }

    case "SET_STATEMENT": {
      const node = next.nodes[op.id];
      if (node) {
        if (op.statement === null) {
          const { statement: _drop, ...rest } = node;
          next.nodes[op.id] = rest;
        } else {
          next.nodes[op.id] = { ...node, statement: { ...op.statement } };
          // Supersession is visible (Stage C2): the targets a statement
          // replaces are marked superseded here, not left to a label
          // convention. Only the status flips — the target's kind, topic, and
          // evidence stay, because the story of what was replaced is as much
          // the board's history as the replacement is.
          for (const target of op.statement.supersedes ?? []) {
            const superseded = next.nodes[target];
            if (superseded?.statement) {
              next.nodes[target] = {
                ...superseded,
                statement: { ...superseded.statement, status: "superseded" },
              };
            }
          }
        }
      }
      break;
    }

    case "UPDATE_STATEMENT": {
      const node = next.nodes[op.id];
      if (node?.statement) {
        const statement = { ...node.statement };
        if (op.status !== undefined) statement.status = op.status;
        if (op.topic !== undefined) {
          if (op.topic === null) delete statement.topic;
          else statement.topic = op.topic;
        }
        if (op.supersedes !== undefined) statement.supersedes = op.supersedes;
        next.nodes[op.id] = { ...node, statement };
        // The same visible supersession as SET_STATEMENT, applied on the patch
        // path — a "we went with the other option" edit marks the replaced
        // statement just as a full replacement does.
        for (const target of op.supersedes ?? []) {
          const superseded = next.nodes[target];
          if (superseded?.statement) {
            next.nodes[target] = {
              ...superseded,
              statement: { ...superseded.statement, status: "superseded" },
            };
          }
        }
      }
      break;
    }

    case "MOVE_NODE": {
      const node = next.nodes[op.id];
      if (node) {
        const pinned = op.pinned ?? true;
        next.nodes[op.id] = pinned
          ? { ...node, position: op.position, pinned: true }
          : (() => {
              const { pinned: _drop, ...rest } = node;
              return { ...rest, position: op.position };
            })();
      }
      break;
    }

    case "CONNECT_NODES": {
      const id = edgeId(op.source, op.target, op.relationship);
      next.edges[id] = {
        id,
        source: op.source,
        target: op.target,
        relationship: op.relationship,
      };
      break;
    }

    case "DISCONNECT_NODES": {
      delete next.edges[edgeId(op.source, op.target, op.relationship)];
      break;
    }

    case "CREATE_GROUP": {
      next.groups[op.id] = {
        id: op.id,
        label: op.label,
        children: [...op.children],
        ...(op.kind ? { kind: op.kind } : {}),
      };
      for (const child of op.children) {
        const node = next.nodes[child];
        if (node) next.nodes[child] = { ...node, groupId: op.id };
      }
      break;
    }

    case "SET_GROUP_KIND": {
      const group = next.groups[op.id];
      if (group) {
        next.groups[op.id] =
          op.kind === null
            ? (() => {
                const { kind: _dropped, ...rest } = group;
                return rest;
              })()
            : { ...group, kind: op.kind };
      }
      break;
    }

    case "DELETE_GROUP": {
      delete next.groups[op.id];
      for (const [nid, node] of Object.entries(next.nodes)) {
        if (node.groupId === op.id) {
          const { groupId: _dropped, ...rest } = node;
          next.nodes[nid] = rest;
        }
      }
      break;
    }

    case "CREATE_DIAGRAM": {
      next.diagramKind = op.kind;
      break;
    }

    case "TRANSFORM_DIAGRAM": {
      // V1: the transform changes the target representation; re-layout happens
      // in the layout pass. Node/edge semantics are preserved.
      next.diagramKind = op.to;
      break;
    }

    case "SET_LAYOUT_INTENT": {
      // Phase 5: replace-whole (the op's contract — see operations.ts). An
      // empty object is a legitimate "clear the intent": {} means every field
      // absent, which downstream consumers read as "no intent".
      const { direction, primaryFlow, emphasis } = op;
      if (direction === undefined && primaryFlow === undefined && emphasis === undefined) {
        delete next.layoutIntent;
      } else {
        next.layoutIntent = {
          ...(direction !== undefined ? { direction } : {}),
          ...(primaryFlow !== undefined ? { primaryFlow: [...primaryFlow] } : {}),
          ...(emphasis !== undefined ? { emphasis: [...emphasis] } : {}),
        };
      }
      break;
    }

    case "CREATE_WIREFRAME": {
      next.wireframes[op.id] = {
        id: op.id,
        title: op.title,
        viewport: op.viewport,
        root: op.root,
      };
      break;
    }

    case "DELETE_WIREFRAME": {
      delete next.wireframes[op.id];
      break;
    }

    case "CREATE_SHAPE": {
      next.shapes[op.id] = {
        id: op.id,
        kind: op.kind,
        position: op.position,
        size: op.size,
        ...(op.rotation !== undefined ? { rotation: op.rotation } : {}),
        ...(op.text !== undefined ? { text: op.text } : {}),
        ...(op.path !== undefined ? { path: op.path } : {}),
        ...(op.src !== undefined ? { src: op.src } : {}),
        ...(op.vector !== undefined ? { vector: op.vector } : {}),
        ...(op.table !== undefined ? { table: op.table } : {}),
        ...(op.chart !== undefined ? { chart: op.chart } : {}),
        ...(op.style ? { style: op.style } : {}),
        ...(op.z !== undefined ? { z: op.z } : {}),
        ...(op.groupId ? { groupId: op.groupId } : {}),
        ...(op.locked !== undefined ? { locked: op.locked } : {}),
        ...(op.hidden !== undefined ? { hidden: op.hidden } : {}),
      };
      break;
    }

    case "UPDATE_SHAPE": {
      const shape = next.shapes[op.id];
      if (shape) {
        const updated = { ...shape };
        if (op.position) updated.position = op.position;
        if (op.size) updated.size = op.size;
        if (op.rotation !== undefined) updated.rotation = op.rotation;
        if (op.text !== undefined) updated.text = op.text;
        if (op.vector !== undefined) updated.vector = op.vector;
        if (op.table !== undefined) updated.table = op.table;
        if (op.chart !== undefined) updated.chart = op.chart;
        if (op.style) updated.style = { ...shape.style, ...op.style };
        if (op.z !== undefined) updated.z = op.z;
        // false is the default for these flags, so store it as absence — keeps
        // the model canonical and lets undo restore an untouched shape exactly.
        if (op.locked === true) updated.locked = true;
        else if (op.locked === false) delete updated.locked;
        if (op.hidden === true) updated.hidden = true;
        else if (op.hidden === false) delete updated.hidden;
        if (op.groupId === null) delete updated.groupId;
        else if (op.groupId !== undefined) updated.groupId = op.groupId;
        next.shapes[op.id] = updated;
      }
      break;
    }

    case "DELETE_SHAPE": {
      delete next.shapes[op.id];
      // Drop any manual links touching this shape.
      for (const [id, link] of Object.entries(next.shapeLinks)) {
        if (link.source === op.id || link.target === op.id) delete next.shapeLinks[id];
      }
      dropAnnotations(next, op.id);
      break;
    }

    case "CONNECT_SHAPES": {
      next.shapeLinks[op.id] = {
        id: op.id,
        source: op.source,
        target: op.target,
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.variant !== undefined ? { variant: op.variant } : {}),
        ...(op.doubleArrow !== undefined ? { doubleArrow: op.doubleArrow } : {}),
      };
      break;
    }

    case "UPDATE_LINK": {
      const link = next.shapeLinks[op.id];
      if (link) {
        next.shapeLinks[op.id] = {
          ...link,
          ...(op.label !== undefined ? { label: op.label } : {}),
          ...(op.variant !== undefined ? { variant: op.variant } : {}),
          ...(op.doubleArrow !== undefined ? { doubleArrow: op.doubleArrow } : {}),
        };
      }
      break;
    }

    case "DISCONNECT_SHAPES": {
      delete next.shapeLinks[op.id];
      break;
    }

    case "GROUP_SHAPES": {
      for (const id of op.ids) {
        const s = next.shapes[id];
        if (s) next.shapes[id] = { ...s, groupId: op.groupId };
      }
      break;
    }

    case "UNGROUP_SHAPES": {
      for (const [id, s] of Object.entries(next.shapes)) {
        if (s.groupId === op.groupId) {
          const { groupId: _drop, ...rest } = s;
          next.shapes[id] = rest;
        }
      }
      break;
    }

    case "ADD_VOTE": {
      next.votes[op.id] = { id: op.id, targetId: op.targetId, by: op.by ?? UNKNOWN_AUTHOR };
      break;
    }

    case "REMOVE_VOTE": {
      delete next.votes[op.id];
      break;
    }

    case "CLEAR_VOTES": {
      if (op.targetId === undefined) {
        next.votes = {};
      } else {
        for (const [id, v] of Object.entries(next.votes)) {
          if (v.targetId === op.targetId) delete next.votes[id];
        }
      }
      break;
    }

    case "ADD_REACTION": {
      next.reactions[op.id] = {
        id: op.id,
        targetId: op.targetId,
        emoji: op.emoji,
        by: op.by ?? UNKNOWN_AUTHOR,
      };
      break;
    }

    case "REMOVE_REACTION": {
      delete next.reactions[op.id];
      break;
    }

    case "ADD_COMMENT": {
      const mentions = parseMentions(op.body);
      next.comments[op.id] = {
        id: op.id,
        targetId: op.targetId,
        body: op.body,
        by: op.by ?? UNKNOWN_AUTHOR,
        createdAt: op.createdAt ?? Date.now(),
        ...(mentions.length ? { mentions } : {}),
      };
      break;
    }

    case "REPLY_COMMENT": {
      const parent = next.comments[op.parentId];
      if (parent) {
        const mentions = parseMentions(op.body);
        next.comments[op.id] = {
          id: op.id,
          // A reply inherits its thread's anchor so a pin count stays correct.
          targetId: parent.targetId,
          body: op.body,
          by: op.by ?? UNKNOWN_AUTHOR,
          createdAt: op.createdAt ?? Date.now(),
          parentId: op.parentId,
          ...(mentions.length ? { mentions } : {}),
        };
      }
      break;
    }

    case "RESOLVE_COMMENT": {
      const comment = next.comments[op.id];
      if (comment) {
        const resolved = op.resolved ?? true;
        next.comments[op.id] = resolved
          ? { ...comment, resolved: true }
          : (() => {
              const { resolved: _drop, ...rest } = comment;
              return rest;
            })();
      }
      break;
    }

    case "DELETE_COMMENT": {
      delete next.comments[op.id];
      // Deleting a thread root takes its replies with it.
      for (const [id, c] of Object.entries(next.comments)) {
        if (c.parentId === op.id) delete next.comments[id];
      }
      break;
    }
  }

  return next;
}

export function applyOperations(workspace: Workspace, ops: Operation[]): Workspace {
  return ops.reduce(applyOperation, workspace);
}
