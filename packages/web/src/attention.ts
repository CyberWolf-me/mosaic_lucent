import { derivedExecution, type Workspace } from "@lucent/core";

/**
 * UX-3 attention queue (pure): one surface answering "what needs review?"
 * Composed deterministically from workspace state + caller-supplied signals.
 * No fetches, no stores — the caller owns the data, this module owns the list.
 */

export type AttentionKind =
  | "proposal"
  | "skipped"
  | "inbound"
  | "blocked"
  | "atrisk"
  | "sync"
  | "offline";

export interface AttentionTarget {
  /** Workspace view to navigate to (cast to View at the call site). */
  view: string;
  lens?: string;
  reveal?: string;
}

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  count?: number;
  target: AttentionTarget;
}

export interface BuildAttentionOptions {
  proposal?: { operations?: readonly unknown[]; request?: string } | null;
  skippedCount?: number;
  inboundPending?: number;
  syncError?: string | null;
  disconnected?: boolean;
}

function todayIso(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Build the attention list. Blocked/at-risk prefer `derivedExecution`
 * (transitive project truth); when it throws or is unavailable, fall back
 * to scanning node issue status directly.
 */
export function buildAttention(
  workspace: Workspace,
  opts: BuildAttentionOptions = {},
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { proposal, skippedCount, inboundPending, syncError, disconnected } = opts;

  if (proposal) {
    const count = Array.isArray(proposal.operations) ? proposal.operations.length : 0;
    items.push({
      id: "proposal",
      kind: "proposal",
      title: count > 0 ? `Review proposal — ${count} change${count === 1 ? "" : "s"}` : "Review proposal",
      detail: proposal.request ?? "Lucent proposed changes waiting for review.",
      ...(count > 0 ? { count } : {}),
      target: { view: "canvas" },
    });
  }

  if (typeof skippedCount === "number" && skippedCount > 0) {
    items.push({
      id: "skipped",
      kind: "skipped",
      title: `${skippedCount} change${skippedCount === 1 ? "" : "s"} skipped`,
      detail: "Applied what still fits — the rest needs a fix.",
      count: skippedCount,
      target: { view: "canvas" },
    });
  }

  if (typeof inboundPending === "number" && inboundPending > 0) {
    items.push({
      id: "inbound",
      kind: "inbound",
      title: `${inboundPending} inbound change${inboundPending === 1 ? "" : "s"} pending`,
      detail: "External changes waiting for review.",
      count: inboundPending,
      target: { view: "intelligence" },
    });
  }

  // Blocked / at-risk from derived execution, with a status-scan fallback.
  try {
    const now = Date.now();
    const derived = derivedExecution(workspace, now);
    for (const node of Object.values(workspace.nodes)) {
      const d = derived.get(node.id);
      const isBlocked =
        (d?.blockedBy.length ?? 0) > 0 || node.issue?.status === "blocked";
      if (isBlocked && node.issue && node.issue.statusCategory !== "done") {
        const by = d?.blockedBy.length ?? 0;
        items.push({
          id: `blocked-${node.id}`,
          kind: "blocked",
          title: `Blocked: ${node.label}`,
          detail:
            node.issue.status === "blocked"
              ? "Marked blocked."
              : by > 0
                ? `Blocked by ${by} upstream action${by === 1 ? "" : "s"}.`
                : "Has unmet dependencies.",
          target: { view: "canvas", reveal: node.id },
        });
      }
      const atRiskUpstream = d?.atRiskBy.length ?? 0;
      const selfOverdue =
        !!node.issue?.dueDate &&
        node.issue.status !== "completed" &&
        node.issue.status !== "cancelled" &&
        node.issue.dueDate < todayIso(now);
      if ((atRiskUpstream > 0 || selfOverdue) && node.issue?.statusCategory !== "done") {
        // Avoid double-listing a node already flagged blocked for its own
        // overdue date — the blocked row carries the signal.
        const alreadyBlocked = items.some((i) => i.id === `blocked-${node.id}`);
        if (!alreadyBlocked) {
          items.push({
            id: `atrisk-${node.id}`,
            kind: "atrisk",
            title: `At risk: ${node.label}`,
            detail: selfOverdue
              ? `Due ${node.issue?.dueDate ?? ""}.`
              : `Upstream risk from ${atRiskUpstream} action${atRiskUpstream === 1 ? "" : "s"}.`,
            target: { view: "execution", reveal: node.id },
          });
        }
      }
    }
  } catch {
    // Fallback: direct issue-status scan (no transitive graph).
    for (const node of Object.values(workspace.nodes)) {
      if (!node.issue || node.issue.statusCategory === "done") continue;
      if (node.issue.status === "blocked") {
        items.push({
          id: `blocked-${node.id}`,
          kind: "blocked",
          title: `Blocked: ${node.label}`,
          detail: "Marked blocked.",
          target: { view: "canvas", reveal: node.id },
        });
      }
    }
  }

  if (typeof syncError === "string" && syncError.length > 0) {
    items.push({
      id: "sync",
      kind: "sync",
      title: "Sync error",
      detail: syncError,
      target: { view: "canvas" },
    });
  }

  if (disconnected === true) {
    items.push({
      id: "offline",
      kind: "offline",
      title: "Offline — changes stay local",
      detail: "Reconnect to share and sync.",
      target: { view: "canvas" },
    });
  }

  return items;
}
