import { useMeetingSession, inCall } from "./MeetingSessionContext.js";
import { CallLobby } from "./CallLobby.js";
import { CallStage, type CallStageProps } from "./CallStage.js";

/**
 * The board's video call inside the meeting view (docs/28 A3.2): the lobby
 * (S4) before joining, the room (S5) while in it, and — when the call ends
 * for a reason other than leaving — what happened, with the way back.
 */
export function NativeRoom(props: Omit<CallStageProps, "title"> & { title?: string }) {
  const { status, ended, join, dismissEnded, activeBoardId } = useMeetingSession();
  const title = props.title ?? "Board call";

  if (inCall(status)) return <CallStage {...props} title={title} />;

  if (status === "ended" && ended) {
    const canRejoin = ended.kind === "lost" || ended.kind === "replaced";
    return (
      <section className="call-ended" role="status" aria-label="The call ended">
        <h3>
          {ended.kind === "removed"
            ? "You were removed"
            : ended.kind === "lost"
              ? "Disconnected"
              : ended.kind === "replaced"
                ? "Call moved"
                : "The call ended"}
        </h3>
        <p>{ended.text}</p>
        <div className="call-ended-actions">
          {canRejoin && (
            <button
              type="button"
              className="call-join"
              onClick={() => void join(activeBoardId ?? props.boardId)}
            >
              {ended.kind === "replaced" ? "Use this tab instead" : "Rejoin"}
            </button>
          )}
          <button type="button" className="call-link-btn" onClick={dismissEnded}>
            {canRejoin ? "Not now" : "Close"}
          </button>
        </div>
      </section>
    );
  }

  return <CallLobby boardId={props.boardId} title={title} />;
}
