/** Operation builders (packages/core/src/operations.ts), ids unique per run. */
let n = 0;
export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${(n++).toString(36)}`;

export const node = (id, label, nodeType = "process") => ({ op: "CREATE_NODE", id, nodeType, label });
export const connect = (source, target, relationship = "relates to") => ({
  op: "CONNECT_NODES",
  source,
  target,
  relationship,
});
export const text = (id, value) => ({ op: "CHANGE_TEXT", id, text: value });
export const move = (id, x, y) => ({ op: "MOVE_NODE", id, position: { x, y } });
export const del = (id) => ({ op: "DELETE_NODE", id });
export const sticky = (id, value, x = 0, y = 0) => ({
  op: "CREATE_SHAPE",
  id,
  kind: "sticky",
  position: { x, y },
  size: { width: 160, height: 120 },
  text: value,
});
export const comment = (id, targetId, body) => ({ op: "ADD_COMMENT", id, targetId, body });
export const reply = (id, parentId, body) => ({ op: "REPLY_COMMENT", id, parentId, body });
export const resolve = (id, resolved = true) => ({ op: "RESOLVE_COMMENT", id, resolved });
export const vote = (id, targetId) => ({ op: "ADD_VOTE", id, targetId });
export const react = (id, targetId, emoji) => ({ op: "ADD_REACTION", id, targetId, emoji });
export const issue = (id, fields) => ({ op: "SET_ISSUE", id, issue: fields });
export const statement = (id, kind, status) => ({
  op: "SET_STATEMENT",
  id,
  statement: { kind, ...(status ? { status } : {}) },
});
