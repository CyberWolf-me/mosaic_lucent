import type { Operation, StatementKind } from "@lucent/core";

/**
 * What one conversation turn did to the board — the line under a Lucent
 * reply that turns the chat from a log of messages into a log of changes to
 * what the team knows ("Added 12 · 1 decision · 1 open question · 1 risk").
 *
 * Pure over the ops that were actually applied, so the numbers are the
 * board's, not the model's prose.
 */
export interface TurnEffect {
  /** Semantic nodes and manual shapes created. */
  created: number;
  /** Nodes and shapes deleted. */
  removed: number;
  /** Existing objects relabelled, retyped, re-issued or re-statemented. */
  changed: number;
  /** Connections made. */
  connected: number;
  /** Statements newly set, by kind (SET_STATEMENT). */
  statements: Partial<Record<StatementKind, number>>;
  /** Statement lifecycle moves (UPDATE_STATEMENT) — e.g. a question answered. */
  resolved: number;
}

export function turnEffect(ops: readonly Operation[]): TurnEffect {
  const effect: TurnEffect = {
    created: 0,
    removed: 0,
    changed: 0,
    connected: 0,
    statements: {},
    resolved: 0,
  };
  const createdIds = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case "CREATE_NODE":
      case "CREATE_SHAPE":
        effect.created++;
        createdIds.add(op.id);
        break;
      case "DELETE_NODE":
      case "DELETE_SHAPE":
        effect.removed++;
        break;
      case "CONNECT_NODES":
      case "CONNECT_SHAPES":
        effect.connected++;
        break;
      case "SET_STATEMENT":
        if (op.statement) {
          const k = op.statement.kind;
          effect.statements[k] = (effect.statements[k] ?? 0) + 1;
        }
        // Stating an existing node is a change to it; stating a node this
        // same batch created is part of creating it.
        if (!createdIds.has(op.id)) effect.changed++;
        break;
      case "UPDATE_STATEMENT":
        effect.resolved++;
        break;
      case "CHANGE_TEXT":
      case "CHANGE_NODE_TYPE":
      case "SET_NODE_ICON":
      case "UPDATE_SHAPE":
      case "SET_ISSUE":
      case "UPDATE_ISSUE":
        if (!("id" in op) || !createdIds.has(op.id)) effect.changed++;
        break;
      default:
        break;
    }
  }
  return effect;
}

/** True when the turn changed nothing a reader would notice. */
export function isEmptyEffect(e: TurnEffect): boolean {
  return (
    e.created + e.removed + e.changed + e.connected + e.resolved === 0 &&
    Object.keys(e.statements).length === 0
  );
}
