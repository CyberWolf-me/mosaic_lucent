import type { BoardStore } from "../boards.js";
import { watchProvider, connectionFailure } from "./health.js";
import {
  ingestInboundChange,
  type InboundChangeRecord,
  type InboundChangeStore,
} from "./inbound.js";
import type { IntegrationStore } from "./integrations.js";
import type { ExecutionProviderFactory } from "./provider.js";
import { withCredential, type OAuthDeps } from "./oauth.js";

/**
 * The inbound poll (docs/26 A5, the `integration.poll` job): read every
 * linked task through each active connection and queue what changed there —
 * status, owner, due date — through the same ingest a webhook uses.
 *
 * It is how Jira's changes reach Lucent at all (Jira has no webhook scheme:
 * Atlassian's Connect model is its own project), and a safety net for Linear
 * and GitHub deliveries that never arrived. A poll re-reads what it already
 * knows, so only values that moved since the link's last sync are news (the
 * ingest compares against the link's baseline), and a connection that stops
 * answering stops being read for the rest of the run and has its health
 * recorded once.
 */

/** Tasks read per connection per run: a large org can't monopolize a worker. */
export const POLL_LINKS_PER_CONNECTION = 100;

export interface PollDeps {
  store: IntegrationStore;
  inbound: InboundChangeStore;
  providers: ReadonlyMap<string, ExecutionProviderFactory>;
  boardStore: Pick<BoardStore, "get">;
  /** docs/26 A5: resolves OAuth connections' tokens. */
  oauth?: OAuthDeps;
  /** What an automation may do with what was queued (the external-close rule). */
  afterQueued?: (records: InboundChangeRecord[]) => Promise<unknown>;
  logger?: { warn(event: string, fields?: Record<string, unknown>): void };
  now?: () => number;
  perConnection?: number;
}

/** A node's owner and due date, for the ingest's comparison. */
export async function boardNodeIssue(
  boardStore: Pick<BoardStore, "get">,
  boardId: string,
  nodeId: string,
): Promise<{ assignee?: string; dueDate?: string } | null> {
  const issue = (await boardStore.get(boardId))?.workspace.nodes[nodeId]?.issue;
  if (!issue) return null;
  return {
    ...(issue.assignee ? { assignee: issue.assignee } : {}),
    ...(issue.dueDate ? { dueDate: issue.dueDate } : {}),
  };
}

export async function pollInbound(
  deps: PollDeps,
): Promise<{ connections: number; read: number; queued: number }> {
  const now = deps.now ?? Date.now;
  let connections = 0;
  let read = 0;
  let queued = 0;
  for (const [name, factory] of deps.providers) {
    for (const connection of await deps.store.connectionsFor(name)) {
      const links = (
        await deps.store.linksForOrg(
          connection.orgId,
          (deps.perConnection ?? POLL_LINKS_PER_CONNECTION) * 4,
        )
      )
        .filter((l) => l.provider === name)
        .slice(0, deps.perConnection ?? POLL_LINKS_PER_CONNECTION);
      if (links.length === 0) continue;
      connections += 1;
      const record = (outcome: Parameters<IntegrationStore["recordCall"]>[2]) =>
        deps.store.recordCall(connection.orgId, name, outcome, now());
      let watched: ReturnType<typeof watchProvider>;
      try {
        watched = watchProvider(factory(await withCredential(deps.oauth, connection)), record);
      } catch (err) {
        const failed = connectionFailure(err);
        if (failed?.auth) await record(failed).catch(() => {});
        deps.logger?.warn("integration.poll.unavailable", {
          orgId: connection.orgId,
          provider: name,
          error: (err as Error).message,
        });
        continue;
      }
      const found: InboundChangeRecord[] = [];
      for (const link of links) {
        let task;
        try {
          task = await watched.provider.getTask(link.externalId);
        } catch (err) {
          // The connection stopped answering: stop reading through it this
          // run. One task the provider can't find is that task's problem.
          if (connectionFailure(err)) break;
          continue;
        }
        read += 1;
        const outcome = await ingestInboundChange(
          {
            linksForExternalId: async () => [link],
            boardNodeStatus: async (boardId, nodeId) =>
              (await deps.boardStore.get(boardId))?.workspace.nodes[nodeId]?.issue?.status ?? null,
            boardNodeIssue: (boardId, nodeId) => boardNodeIssue(deps.boardStore, boardId, nodeId),
            store: deps.inbound,
            provider: watched.provider,
            now,
          },
          {
            provider: name,
            externalId: link.externalId,
            status: task.status,
            assignee: task.assignee ?? null,
            dueDate: task.dueDate ?? null,
          },
          connection.orgId,
          "sweep",
        );
        found.push(...outcome.records);
      }
      await watched.settle();
      queued += found.length;
      if (found.length > 0) await deps.afterQueued?.(found);
    }
  }
  return { connections, read, queued };
}
