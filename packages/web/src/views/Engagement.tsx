import type { Operation, Workspace } from "@lucent/core";
import { Ico } from "../ui/icons.js";
import {
  REACTION_EMOJI,
  clearVotesOps,
  myReactionFor,
  myVoteFor,
  reactionTally,
  toggleReactionOps,
  toggleVoteOps,
  voteResults,
  voteTally,
} from "../board/engagement.js";

/**
 * Voting and reactions surface (docs/14 §workshop features).
 *
 * - `VotePanel` runs a round: turn voting on, see the live tally, reset.
 * - `EngagementBar` is the per-selection control (vote + emoji).
 * - `EngagementBadges` overlays counts on the board so results are visible
 *   without opening a panel.
 *
 * All of it goes through operations, so a round persists, undoes, and is
 * readable by the AI.
 */

export function VotePanel({
  workspace,
  active,
  onToggleActive,
  onApply,
  onClose,
}: {
  workspace: Workspace;
  active: boolean;
  onToggleActive: () => void;
  onApply: (ops: Operation[], label: string) => void;
  onClose: () => void;
}) {
  const results = voteResults(workspace);
  const total = results.reduce((sum, r) => sum + r.votes, 0);
  const top = results[0]?.votes ?? 0;

  return (
    <div className="vote-panel" role="dialog" aria-label="Voting">
      <div className="vote-head">
        <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Voting</div>
        <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
          {total} vote{total === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close" aria-label="Close voting">
          <Ico.X />
        </button>
      </div>

      <button className={`vote-toggle ${active ? "on" : ""}`} onClick={onToggleActive}>
        {active ? "Stop voting" : "Start voting"}
      </button>
      <div className="vote-hint">
        {active
          ? "Click any node or sticky to cast or withdraw a vote."
          : "Turn voting on, then click objects to vote."}
      </div>

      {results.length > 0 ? (
        <>
          <div className="vote-results">
            {results.map((r) => (
              <div key={r.targetId} className="vote-row">
                <div className="vote-bar-wrap">
                  <div
                    className="vote-bar"
                    style={{ width: top ? `${(r.votes / top) * 100}%` : "0%" }}
                  />
                </div>
                <span className="vote-row-label" title={r.label}>
                  {r.label}
                </span>
                <span className="mono vote-count">{r.votes}</span>
              </div>
            ))}
          </div>
          <button
            className="vote-reset"
            onClick={() => onApply(clearVotesOps(), "Clear all votes")}
          >
            Reset round
          </button>
        </>
      ) : (
        <div className="vote-empty">No votes yet.</div>
      )}
    </div>
  );
}

/** Per-selection vote + reaction control, shown above the selected object. */
export function EngagementBar({
  workspace,
  targetId,
  onApply,
}: {
  workspace: Workspace;
  targetId: string;
  onApply: (ops: Operation[], label: string) => void;
}) {
  const votes = voteTally(workspace)[targetId] ?? 0;
  const mine = myVoteFor(workspace, targetId) !== null;

  return (
    <div className="engagement-bar">
      <button
        className={`eng-vote ${mine ? "on" : ""}`}
        onClick={() => onApply(toggleVoteOps(workspace, targetId), mine ? "Withdraw vote" : "Vote")}
        title={mine ? "Withdraw your vote" : "Vote for this"}
      >
        ▲ {votes}
      </button>
      <div className="eng-sep" />
      {REACTION_EMOJI.map((emoji) => {
        const own = myReactionFor(workspace, targetId, emoji) !== null;
        return (
          <button
            key={emoji}
            className={`eng-react ${own ? "on" : ""}`}
            onClick={() =>
              onApply(
                toggleReactionOps(workspace, targetId, emoji),
                own ? "Remove reaction" : "React",
              )
            }
            title={own ? `Remove ${emoji}` : `React ${emoji}`}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Vote counts and reaction chips pinned to their objects on the canvas. Rendered
 * inside the pan/zoom layer so they track content coordinates.
 */
export function EngagementBadges({ workspace }: { workspace: Workspace }) {
  const votes = voteTally(workspace);
  const reactions = reactionTally(workspace);
  const targetIds = new Set([...Object.keys(votes), ...Object.keys(reactions)]);
  if (targetIds.size === 0) return null;

  return (
    <>
      {[...targetIds].map((id) => {
        const node = workspace.nodes[id];
        const shape = workspace.shapes[id];
        const box =
          node?.position && node.size
            ? {
                x: node.position.x,
                y: node.position.y,
                width: node.size.width,
                height: node.size.height,
              }
            : shape
              ? {
                  x: shape.position.x,
                  y: shape.position.y,
                  width: shape.size.width,
                  height: shape.size.height,
                }
              : null;
        // A hidden shape shouldn't show a floating badge.
        if (!box || shape?.hidden) return null;

        const count = votes[id] ?? 0;
        const emoji = Object.entries(reactions[id] ?? {});
        return (
          <div
            key={id}
            className="engagement-badges"
            style={{ left: box.x + box.width - 8, top: box.y + box.height - 10 }}
          >
            {count > 0 && <span className="badge-vote">▲ {count}</span>}
            {emoji.map(([e, n]) => (
              <span key={e} className="badge-react">
                {e} {n}
              </span>
            ))}
          </div>
        );
      })}
    </>
  );
}
