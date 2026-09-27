import {
  attachPlanProvenance,
  attachProvenance,
  gatePlanOps,
  isOverdueUnfinished,
  planRequestText,
  type Operation,
  type Workspace,
} from "@lucent/core";
import {
  REQUEST_LIMITS,
  classifyTurn,
  differentialPrompt,
  summarizeWorkspace,
  type TurnKind,
} from "@lucent/ai";
import type { AutomationRule, EffectiveOrgSettings } from "./classification.js";
import type { BoardStore, StoredBoard } from "./boards.js";
import type { MeetingStore, MeetingTranscript, MeetingTurn } from "./meetings.js";
import type { ProposalStore, StoredProposal } from "./proposals.js";
import type { NewAiRun } from "./aiRuns.js";
import type { NotificationKind, NotifyEvent } from "./notifications.js";
import type { InboundChangeRecord } from "./integrations/inbound.js";
import type { StatementIndexStore } from "./statementIndex.js";

/**
 * Automation v1 (docs/26 A5): what Lucent does on its own when something
 * happens, per the org's rules (`OrgSettings.automation`). Four rules, each
 * with an output a person can review or reverse:
 *
 * - a meeting ends → the turns nobody extracted become a PROPOSAL;
 * - a decision is approved in Review → its plan becomes a PROPOSAL;
 * - work passes its due date → its owner gets a NOTIFICATION, once;
 * - an external tracker marks linked work done → the board marks it
 *   completed as the integration — op-logged, audited, undoable — only
 *   where the owner turned that on.
 *
 * Every rule re-reads the org's settings when it runs, so turning a rule off
 * stops work already queued. A model call passes the same gates a person's
 * would: the board's AI boundary, the org's provider policy, the monthly
 * allowance.
 */

/** What an automation that writes a proposal did — for logs and tests. */
export type ProposalAutomationOutcome =
  | "proposed"
  | "off"
  | "not-found"
  | "not-ended"
  | "record-mode"
  | "covered"
  | "busy"
  | "refused"
  | "limit"
  | "failed"
  | "nothing"
  | "not-a-decision";

/**
 * The first turn no extraction has covered: past every turn range the
 * board's nodes and statements cite for this meeting, and past every
 * proposal made from it that is pending or was decided (a rejected batch
 * was looked at — re-proposing it would ask the same question twice).
 */
export function firstUncoveredTurn(
  meetingId: string,
  workspace: Workspace,
  proposals: readonly StoredProposal[],
): number {
  let next = 0;
  const cover = (range: readonly [number, number] | undefined) => {
    if (range) next = Math.max(next, range[1] + 1);
  };
  for (const node of Object.values(workspace.nodes)) {
    if (node.provenance?.meetingId === meetingId) cover(node.provenance.turnRange);
    if (node.statement?.provenance?.meetingId === meetingId) {
      cover(node.statement.provenance.turnRange);
    }
  }
  for (const p of proposals) {
    if (p.meetingId === meetingId && p.status !== "superseded") cover(p.provenance?.turnRange);
  }
  return next;
}

/**
 * The extraction request's message for a meeting's remaining turns — the
 * live loop's differential prompt behind a header naming the meeting and its
 * date (so "by Friday" resolves against the meeting, not the job's clock).
 * As many turns as fit the request's message cap, from the first; null when
 * not even one does.
 */
export function remainderMessage(
  meeting: Pick<MeetingTranscript, "title" | "startedAt">,
  turns: readonly MeetingTurn[],
): { message: string; count: number } | null {
  const date = new Date(meeting.startedAt).toISOString().slice(0, 10);
  const header =
    `The meeting${meeting.title ? ` "${meeting.title}"` : ""} on ${date} has ended. ` +
    "These are its last turns, which were never extracted to the board.\n\n";
  const lines = turns.map((t) => ({ speaker: t.speaker, text: t.text, kind: kindOf(t) }));
  const base = header.length + differentialPrompt([]).length;
  let size = base;
  let count = 0;
  for (const line of lines) {
    const added = differentialPrompt([line]).length - differentialPrompt([]).length;
    if (size + added > REQUEST_LIMITS.messageChars) break;
    size += added;
    count += 1;
  }
  if (count === 0) return null;
  return { message: header + differentialPrompt(lines.slice(0, count)), count };
}

function kindOf(turn: MeetingTurn): TurnKind | undefined {
  return turn.kind ?? classifyTurn(turn.text);
}

/**
 * The person an assignee names: their name, email, or the part before the
 * @ — and only when exactly one person matches. The assignee field is text
 * (typed, or synced from a tracker), so anything looser would tell a stranger.
 */
export function personNamed<P extends { name: string; email: string }>(
  people: Iterable<P>,
  assignee: string,
): P | undefined {
  const want = assignee.trim().toLowerCase();
  const hits = [...people].filter((p) =>
    [p.name, p.email, p.email.split("@")[0]].some((v) => v && v.toLowerCase() === want),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

export interface AutomationDeps {
  boardStore: BoardStore;
  meetings?: MeetingStore;
  proposals?: ProposalStore;
  index: Pick<StatementIndexStore, "query">;
  /** Re-derive any board whose index rows are older than it (the read-time repair). */
  freshen?(boards: readonly StoredBoard[]): Promise<unknown>;
  orgs?: { list(): Promise<Array<{ id: string }>> };
  settingsFor(orgId: string): Promise<EffectiveOrgSettings>;
  /**
   * Run the model over a request for this board, through every gate a
   * person's request passes. `refused` is the board's or org's policy;
   * `limit` the monthly allowance.
   */
  generate(
    board: StoredBoard,
    request: { message: string; summary: unknown; today: string },
  ): Promise<
    | {
        ok: true;
        operations: Operation[];
        explanation: string | null;
        provider: string;
        model: string | null;
      }
    | { ok: false; reason: "refused" | "limit" | "failed"; detail?: string }
  >;
  recordRun(run: NewAiRun): Promise<string | null>;
  linkRunProposal(runId: string, proposalId: string): Promise<void>;
  broadcast(boardId: string, event: Record<string, unknown>): void;
  notify<K extends NotificationKind>(event: NotifyEvent<K>): Promise<void>;
  /** Everyone who could own work on a board: its owner and the org's members. */
  peopleFor(board: StoredBoard): Promise<Array<{ id: string; name: string; email: string }>>;
  findUser(id: string): Promise<{ id: string; name: string; email: string } | undefined>;
  /**
   * Apply an inbound change as the integration, when the board's boundary
   * allows it; false when it doesn't or the change no longer applies.
   */
  applyInbound(board: StoredBoard, record: InboundChangeRecord): Promise<boolean>;
  audit(entry: {
    orgId: string;
    action: string;
    subject: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  logger: {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
  };
  now?: () => number;
}

export interface Automations {
  /** Rule 1: propose the ended meeting's unextracted turns. */
  extractMeetingRest(
    boardId: string,
    meetingId: string,
  ): Promise<{ outcome: ProposalAutomationOutcome; proposal?: StoredProposal }>;
  /**
   * Rule 2: propose the plan for the decisions someone just approved — one
   * proposal for one Review action, however many it approved.
   */
  planDecisions(
    boardId: string,
    nodeIds: readonly string[],
    approvedBy: string,
  ): Promise<{ outcome: ProposalAutomationOutcome; proposal?: StoredProposal }>;
  /** Rule 3: tell owners about work past its due date, once per due date. */
  sweepOverdue(): Promise<{ told: number }>;
  /** Rule 4: apply "done" from a tracker where the org allows it. */
  closeFromTracker(records: readonly InboundChangeRecord[]): Promise<{ applied: number }>;
}

export function createAutomations(deps: AutomationDeps): Automations {
  const now = () => (deps.now ?? Date.now)();
  const ruleOn = async (orgId: string, rule: AutomationRule) =>
    (await deps.settingsFor(orgId)).automation[rule];
  /** Overdue reminders already sent by this process (the row id is the real dedupe). */
  const toldOverdue = new Set<string>();

  /** The shared tail of the two proposal rules: record, propose, tell. */
  async function propose(
    board: StoredBoard,
    input: {
      operations: Operation[];
      request: string;
      explanation: string | null;
      meetingId: string | null;
      provenance: StoredProposal["provenance"];
      createdBy: string;
      provider: string;
      model: string | null;
      rule: "meetingExtract" | "decisionPlan";
      subject: string;
      contextScope: string;
    },
  ): Promise<StoredProposal | null> {
    const at = now();
    const { createHash } = await import("node:crypto");
    const runId = await deps.recordRun({
      orgId: board.orgId,
      boardId: board.id,
      initiatedBy: null,
      surface: input.meetingId ? "meeting" : "canvas",
      provider: input.provider,
      model: input.model,
      contextScope: input.contextScope,
      tools: [`automation:${input.rule}`],
      outputHash: createHash("sha256").update(JSON.stringify(input.operations)).digest("hex"),
      opCount: input.operations.length,
      createdAt: at,
    });
    let created;
    try {
      created = await deps.proposals!.create({
        boardId: board.id,
        orgId: board.orgId,
        meetingId: input.meetingId,
        operations: input.operations,
        request: input.request,
        explanation: input.explanation,
        provenance: input.provenance,
        createdBy: input.createdBy,
        createdAt: at,
        runId,
      });
    } catch {
      // A person's proposal won the pending slot in the meantime.
      return null;
    }
    if (runId) await deps.linkRunProposal(runId, created.proposal.id).catch(() => {});
    deps.broadcast(board.id, {
      type: "proposal-created",
      proposal: created.proposal,
      ...(created.supersededId !== null ? { supersededId: created.supersededId } : {}),
    });
    const person = await deps.findUser(input.createdBy);
    if (person) {
      await deps.notify({
        kind: "automation.proposed",
        to: { userId: person.id, email: person.email },
        orgId: board.orgId,
        payload: {
          boardId: board.id,
          boardName: board.name,
          rule: input.rule,
          subject: input.subject,
          ops: input.operations.length,
        },
        id: `ntf_auto_${created.proposal.id}`,
      });
    }
    return created.proposal;
  }

  /** One pending proposal per board: an automation never displaces a person's. */
  async function boardBusy(boardId: string): Promise<boolean> {
    return (await deps.proposals!.pendingForBoards([boardId])).length > 0;
  }

  return {
    async extractMeetingRest(boardId, meetingId) {
      if (!deps.meetings || !deps.proposals) return { outcome: "not-found" };
      const board = await deps.boardStore.get(boardId);
      const meeting = board ? await deps.meetings.get(boardId, meetingId) : undefined;
      if (!board || !meeting) return { outcome: "not-found" };
      if (!(await ruleOn(board.orgId, "meetingExtract"))) return { outcome: "off" };
      if (meeting.endedAt === null) return { outcome: "not-ended" };
      // Record mode keeps the transcript and nothing else — no model, no board.
      if (meeting.mode === "record") return { outcome: "record-mode" };
      const { correctedTurns } = await import("./meetings.js");
      const turns = correctedTurns(meeting);
      const start = firstUncoveredTurn(
        meetingId,
        board.workspace,
        await deps.proposals.forBoard(boardId, 200),
      );
      if (start >= turns.length) return { outcome: "covered" };
      if (await boardBusy(boardId)) return { outcome: "busy" };
      const fitted = remainderMessage(meeting, turns.slice(start));
      if (!fitted) return { outcome: "nothing" };
      const used = turns.slice(start, start + fitted.count);

      const result = await deps.generate(board, {
        message: fitted.message,
        summary: summarizeWorkspace(board.workspace),
        today: new Date(meeting.startedAt).toISOString().slice(0, 10),
      });
      if (!result.ok) {
        deps.logger.warn("automation.meeting-extract.failed", {
          boardId,
          meetingId,
          reason: result.reason,
          ...(result.detail ? { detail: result.detail } : {}),
        });
        return { outcome: result.reason === "failed" ? "failed" : result.reason };
      }
      if (result.operations.length === 0) return { outcome: "nothing" };

      const turnRange: [number, number] = [start, start + used.length - 1];
      // Unique kinds, in the order the turns raise them (the node schema caps
      // the list; there are six kinds).
      const turnKinds = [...new Set(used.map(kindOf).filter((k): k is TurnKind => Boolean(k)))];
      const quote = used
        .map((t) => t.text)
        .join(" ")
        .slice(0, 240);
      const operations = attachProvenance(result.operations, {
        meetingId,
        turnRange,
        ...(turnKinds.length ? { turnKinds } : {}),
        quote,
      });
      const title =
        meeting.title ?? `the meeting on ${new Date(meeting.startedAt).toISOString().slice(0, 10)}`;
      const proposal = await propose(board, {
        operations,
        request: `Automation — what ${meeting.title ? `"${meeting.title}"` : title} left unextracted (turns ${turnRange[0] + 1}–${turnRange[1] + 1} of ${turns.length})`,
        explanation: result.explanation,
        meetingId,
        provenance: { quote, turnRange, ...(turnKinds.length ? { turnKinds } : {}) },
        // The proposal is on behalf of whoever recorded the meeting.
        createdBy: meeting.createdBy ?? board.ownerId,
        provider: result.provider,
        model: result.model,
        rule: "meetingExtract",
        subject: meeting.title ?? title,
        contextScope: "meeting",
      });
      return proposal ? { outcome: "proposed", proposal } : { outcome: "busy" };
    },

    async planDecisions(boardId, nodeIds, approvedBy) {
      if (!deps.proposals) return { outcome: "not-found" };
      const board = await deps.boardStore.get(boardId);
      if (!board) return { outcome: "not-found" };
      if (!(await ruleOn(board.orgId, "decisionPlan"))) return { outcome: "off" };
      const { nodes, edges } = board.workspace;
      const decided = nodeIds.filter((id) => {
        const statement = nodes[id]?.statement;
        return (
          statement?.kind === "decision" &&
          statement.status === "resolved" &&
          (statement.trust === "human-approved" || statement.trust === "human-edited")
        );
      });
      if (decided.length === 0) return { outcome: "not-a-decision" };
      // A decision that already drives work has its plan.
      const unplanned = decided.filter(
        (id) => !Object.values(edges).some((e) => e.source === id && e.relationship === "drives"),
      );
      if (unplanned.length === 0) return { outcome: "covered" };
      if (await boardBusy(boardId)) return { outcome: "busy" };

      const named = unplanned.map((id) => `- "${nodes[id]!.label}" (${id})`).join("\n");
      const result = await deps.generate(board, {
        message: `${planRequestText(unplanned.length)}\n\nThe ${unplanned.length === 1 ? "decision" : "decisions"}:\n${named}`,
        summary: summarizeWorkspace(board.workspace, unplanned),
        today: new Date(now()).toISOString().slice(0, 10),
      });
      if (!result.ok) {
        deps.logger.warn("automation.decision-plan.failed", { boardId, reason: result.reason });
        return { outcome: result.reason === "failed" ? "failed" : result.reason };
      }
      // The plan gate (ADR 0028), as the Intelligence view applies it: a
      // plan creates and organizes; it never converts or removes.
      const gated = gatePlanOps(result.operations);
      if (gated.allowed.length === 0) return { outcome: "nothing" };
      const operations = attachPlanProvenance(gated.allowed, unplanned);
      const subject =
        unplanned.length === 1
          ? nodes[unplanned[0]!]!.label
          : `${nodes[unplanned[0]!]!.label} (and ${unplanned.length - 1} more)`;
      const proposal = await propose(board, {
        operations,
        request:
          unplanned.length === 1
            ? `Automation — the plan for "${nodes[unplanned[0]!]!.label}", approved in Review`
            : `Automation — the plan for ${unplanned.length} decisions approved in Review`,
        explanation: result.explanation,
        meetingId: null,
        provenance: null,
        createdBy: approvedBy,
        provider: result.provider,
        model: result.model,
        rule: "decisionPlan",
        subject,
        contextScope: "board",
      });
      return proposal ? { outcome: "proposed", proposal } : { outcome: "busy" };
    },

    async sweepOverdue() {
      if (!deps.orgs) return { told: 0 };
      const at = now();
      let told = 0;
      for (const org of await deps.orgs.list()) {
        if (!(await ruleOn(org.id, "overdueNotify"))) continue;
        const boards = await deps.boardStore.listForOrg(org.id);
        if (boards.length === 0) continue;
        await deps.freshen?.(boards);
        const byId = new Map(boards.map((b) => [b.id, b] as const));
        const rows = (await deps.index.query([...byId.keys()], { kinds: ["action"] })).filter(
          (r) =>
            r.status === "open" &&
            r.assignee &&
            r.dueDate &&
            isOverdueUnfinished(r.dueDate, r.executionStatus, at),
        );
        const peopleByBoard = new Map<string, Array<{ id: string; name: string; email: string }>>();
        for (const row of rows) {
          const id = `ntf_overdue_${row.boardId}_${row.id}_${row.dueDate}`;
          if (toldOverdue.has(id)) continue;
          const board = byId.get(row.boardId)!;
          let people = peopleByBoard.get(board.id);
          if (!people) {
            people = await deps.peopleFor(board);
            peopleByBoard.set(board.id, people);
          }
          const person = personNamed(people, row.assignee!);
          toldOverdue.add(id);
          if (!person) continue;
          try {
            await deps.notify({
              kind: "work.overdue",
              to: { userId: person.id, email: person.email },
              orgId: org.id,
              payload: {
                boardId: board.id,
                boardName: board.name,
                nodeId: row.id,
                label: row.label,
                dueDate: row.dueDate!,
              },
              // One reminder per due date: the id is the row's primary key, so
              // a second sweep — here or in another process — writes nothing.
              id,
            });
            told += 1;
          } catch {
            // Already told (the id exists), or the store is down: either way
            // the next due date, or the next sweep, tries again.
          }
        }
      }
      return { told };
    },

    async closeFromTracker(records) {
      let applied = 0;
      for (const record of records) {
        if (
          record.status !== "pending" ||
          record.field !== "status" ||
          record.mappedValue !== "completed"
        ) {
          continue;
        }
        const board = await deps.boardStore.get(record.boardId);
        if (!board || board.orgId !== record.orgId) continue;
        if (!(await ruleOn(board.orgId, "externalClose"))) continue;
        if (!(await deps.applyInbound(board, record))) continue;
        applied += 1;
        await deps
          .audit({
            orgId: board.orgId,
            action: "automation.external-close",
            subject: record.id,
            metadata: {
              boardId: board.id,
              nodeId: record.nodeId,
              provider: record.provider,
              externalId: record.externalId,
              externalValue: record.externalValue,
            },
          })
          .catch(() => {});
      }
      return { applied };
    },
  };
}
