import { useEffect, useState, type SVGProps } from "react";
import { createPortal } from "react-dom";
import { Ico, ToolIco } from "./icons.js";
import { NotificationTray } from "./NotificationTray.js";
import { ProfileMenu } from "./ProfileMenu.js";
import { getSessionUser } from "../session.js";
import { Dialog } from "./primitives.js";
import { useWorkspace, type CanvasLens, type View } from "../workspace.js";
import {
  classifyBoard,
  createShareLink,
  fetchBoard,
  listMembers,
  readShareLinkError,
  removeMember,
  revokeShareLinks,
  setMemberRole,
  type BoardMemberSummary,
  type ShareRole,
} from "../boards.js";
import { BOARD_TIERS, TIER_DESCRIPTIONS, TIER_LABELS, type BoardTier } from "../board-tiers.js";

/** Top bar, left rail, command overlay, and badges. Ported from chrome.jsx. */

export interface Crumb {
  label: string;
  current?: boolean;
  view?: View;
  /**
   * The crumb IS the board's name and clicking it renames the board. Opt-in:
   * it used to be implied by `current`, so a page title crumb ("Home",
   * "Intelligence") opened a rename-the-board box.
   */
  rename?: boolean;
}

export function TopBar({
  crumbs,
  actions,
  meta,
  onOpenSettings,
  boardActions = true,
}: {
  crumbs: Crumb[];
  actions?: React.ReactNode;
  /** Optional right-side stamp: a small mono label, like the corner of a sheet. */
  meta?: React.ReactNode;
  onOpenSettings: (section?: string) => void;
  /**
   * Share and Meeting act on the open board. On pages that are not about one
   * board (Home, Boards, Notifications, Admin) they read as "share what?", so
   * those pages turn them off.
   */
  boardActions?: boolean;
}) {
  const { view, setView, readOnly, projectName, setProjectName } = useWorkspace();
  const [share, setShare] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(projectName);

  const commitTitle = () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (next && next !== projectName) {
      setProjectName(next);
    }
  };

  return (
    <div className="top-bar">
      <button className="brand" onClick={() => setView("home")} title="Home" aria-label="Home">
        <div className="brand-mark" />
        <span>Lucent</span>
      </button>
      <span className="crumb-sep">·</span>
      {crumbs.map((c, i) => (
        <span key={i} style={{ display: "contents" }}>
          {c.view ? (
            <button
              className={`crumb ${c.current ? "current" : ""}`}
              onClick={() => setView(c.view!)}
              style={{ background: "none", border: 0, cursor: "pointer" }}
            >
              {c.label}
            </button>
          ) : c.current && c.rename && !readOnly ? (
            editingTitle ? (
              <input
                autoFocus
                className="crumb-title-input"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitTitle();
                  if (e.key === "Escape") {
                    setTitleDraft(projectName);
                    setEditingTitle(false);
                  }
                }}
              />
            ) : (
              <span
                className="crumb current editable"
                onClick={() => {
                  setTitleDraft(projectName || c.label);
                  setEditingTitle(true);
                }}
                title="Click to rename board"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setTitleDraft(projectName || c.label);
                    setEditingTitle(true);
                  }
                }}
              >
                {c.label}
              </span>
            )
          ) : (
            <span className={`crumb ${c.current ? "current" : ""}`}>{c.label}</span>
          )}
          {i < crumbs.length - 1 && <span className="crumb-sep">/</span>}
        </span>
      ))}
      {meta && <div className="spacer" />}
      {meta}
      <div className="spacer" />
      <div className="actions">
        {/* Outside any conditional on purpose: notifications are
            account-scoped, so a view that supplies its own action cluster must
            not be a view where they disappear. Share/Profile likewise always
            render — a view's `actions` augment the cluster, never replace it. */}
        <NotificationTray />
        {actions}
        <>
          {readOnly && (
            <span className="view-only-chip" role="status" aria-label="View only">
              <Ico.Eye /> View only
            </span>
          )}
          {boardActions && (
            <button className="icon-btn" onClick={() => setShare(true)} aria-label="Share board">
              <Ico.Share /> Share
            </button>
          )}
          {boardActions && view !== "meeting" && (
            <button
              className="icon-btn"
              onClick={() => setView("meeting")}
              title="Start or join a meeting on this board"
              aria-label="Meeting"
            >
              <Ico.Present /> Meeting
            </button>
          )}
          <ProfileMenu onOpenSettings={onOpenSettings} onNavigate={setView} />
        </>
      </div>
      {share && <ShareDialog onClose={() => setShare(false)} />}
    </div>
  );
}

function ShareDialog({ onClose }: { onClose: () => void }) {
  const { syncStatus, syncRole, boardId, peers, startSharing } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedIn = getSessionUser() !== null;

  // The role a newly minted link will grant. Editor is the useful default for
  // "come work on this with me"; viewer is there for a read-only walkthrough.
  const [linkRole, setLinkRole] = useState<ShareRole>("editor");
  const [invite, setInvite] = useState<{ token: string; role: ShareRole } | null>(null);
  const [minting, setMinting] = useState(false);
  const [members, setMembers] = useState<BoardMemberSummary[]>([]);
  const isOwner = syncRole === "owner";
  // Board governance tier (docs/23 S1): the resolved tier the server
  // enforces, loaded with the member list. Null while loading or on local
  // boards, which have no server and nothing to govern.
  const [tier, setTier] = useState<BoardTier | null>(null);
  const [tierError, setTierError] = useState<string | null>(null);
  const [tierSaving, setTierSaving] = useState(false);
  const [closing, setClosing] = useState(false);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 150);
  };

  // Load the member list whenever the dialog opens on a shared board, so role
  // changes and removals act on current data rather than a stale snapshot.
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    void listMembers(boardId).then((res) => {
      if (!cancelled && res) setMembers(res.members);
    });
    // The governance tier rides the same open: members see what governs
    // them, owners may change it below.
    void fetchBoard(boardId).then((board) => {
      if (!cancelled && board) setTier(board.classification);
    });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const refreshMembers = async () => {
    if (!boardId) return;
    const res = await listMembers(boardId);
    if (res) setMembers(res.members);
  };

  // An invite URL carries the board id *and* the token: the id alone is not a
  // capability, so a bare ?board= link 404s for anyone who isn't a member.
  const shareUrl =
    typeof window !== "undefined"
      ? boardId
        ? `${window.location.origin}${window.location.pathname}?board=${encodeURIComponent(boardId)}${
            invite ? `&invite=${encodeURIComponent(invite.token)}` : ""
          }`
        : window.location.href
      : "";

  const copy = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access needs a secure context and permission; say so instead
      // of showing a false success.
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2200);
    }
  };

  const share = async () => {
    setSharing(true);
    setError(null);
    const id = await startSharing();
    setSharing(false);
    if (!id)
      setError("Couldn't publish the board. Check you're signed in and the server is running.");
  };

  /** Mint a fresh link. The previous token stays valid until it's revoked. */
  const mintLink = async () => {
    if (!boardId) return;
    setMinting(true);
    setError(null);
    const link = await createShareLink(boardId, linkRole);
    setMinting(false);
    if (!link) {
      // Prefer the server's own reason (e.g. the email-verification gate) over
      // the old blanket "only the owner" guess, which misled actual owners.
      setError(
        readShareLinkError() ??
          "Couldn't create an invite link. Check your connection and try again.",
      );
      return;
    }
    setInvite({ token: link.token, role: link.role });
  };

  const revokeAll = async () => {
    if (!boardId) return;
    const revoked = await revokeShareLinks(boardId);
    setInvite(null);
    setError(
      revoked > 0
        ? null
        : "There were no live links to revoke. People who already joined keep their access.",
    );
  };

  /** Re-classify the board. The server is authoritative (owner-only, strict
   * tiers); a refusal surfaces its reason rather than silently reverting. */
  const changeTier = async (next: BoardTier) => {
    if (!boardId || tierSaving) return;
    setTierSaving(true);
    setTierError(null);
    const result = await classifyBoard(boardId, next);
    setTierSaving(false);
    if (result.ok) {
      setTier(result.classification);
    } else {
      setTierError(result.error);
    }
  };

  return createPortal(
    <>
      <div
        onClick={requestClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 200,
          background: "oklch(0.10 0.005 252 / 0.45)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
          animation: closing ? "scrim-out 0.15s ease-in both" : "scrim-in 0.18s ease-out backwards",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: 62,
          right: 20,
          zIndex: 201,
          width: 320,
          padding: 16,
          background: "oklch(from var(--canvas-2) l c h / 0.95)",
          border: "1px solid var(--stroke-2)",
          borderRadius: "var(--r-lg)",
          boxShadow: "var(--elev-3)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          color: "var(--ink-0)",
          transformOrigin: "top right",
          animation: closing
            ? "inspector-out 0.15s var(--e-in-out) both"
            : "inspector-in 0.2s var(--e-out) both",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Ico.Share />
          <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Share workspace</div>
          <div style={{ flex: 1 }} />
          <button
            onClick={requestClose}
            style={{ padding: 4, color: "var(--ink-3)" }}
            aria-label="Close share dialog"
          >
            <Ico.X />
          </button>
        </div>

        {boardId ? (
          <>
            <div
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                padding: "8px 10px",
                background: "var(--canvas-2)",
                border: "1px solid var(--stroke-1)",
                borderRadius: 6,
                marginBottom: 12,
              }}
            >
              <span
                className="mono"
                style={{
                  flex: 1,
                  fontSize: 11,
                  color: "var(--ink-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {shareUrl}
              </span>
              <button
                onClick={copy}
                style={{
                  fontSize: 11,
                  padding: "4px 10px",
                  borderRadius: "var(--r-sm)",
                  background: copied
                    ? "oklch(0.78 0.11 155 / 0.15)"
                    : copyFailed
                      ? "oklch(0.72 0.15 25 / 0.15)"
                      : "var(--ink-0)",
                  color: copied
                    ? "var(--sig-green)"
                    : copyFailed
                      ? "var(--sig-red)"
                      : "var(--canvas-0)",
                  fontVariationSettings: "'wght' 550",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {copied ? (
                  <>
                    <Ico.Check /> Copied
                  </>
                ) : copyFailed ? (
                  "Blocked"
                ) : (
                  "Copy"
                )}
              </button>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
              {syncStatus === "online"
                ? `Live · ${peers.length === 0 ? "no one else here yet" : `${peers.length} other${peers.length > 1 ? "s" : ""} on this board`}${syncRole ? ` · you are ${syncRole}` : ""}.`
                : syncStatus === "connecting"
                  ? "Connecting to the board…"
                  : "Offline — reconnecting when the server is reachable."}
              {!invite &&
                isOwner &&
                " Create an invite link below — a bare board link won't let anyone in."}
            </div>

            {isOwner && (
              <div
                style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--stroke-1)" }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 8,
                  }}
                >
                  Governance
                </div>
                {tier === null ? (
                  <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Loading tier…</div>
                ) : (
                  <>
                    <div className="segmented" role="radiogroup" aria-label="Board governance tier">
                      {BOARD_TIERS.map((t) => (
                        <button
                          key={t}
                          className={tier === t ? "active" : ""}
                          aria-pressed={tier === t}
                          disabled={tierSaving}
                          onClick={() => void changeTier(t)}
                        >
                          {TIER_LABELS[t]}
                        </button>
                      ))}
                    </div>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: "var(--ink-2)",
                        lineHeight: 1.45,
                        marginTop: 8,
                      }}
                    >
                      {TIER_DESCRIPTIONS[tier]}
                    </div>
                    {tierError && (
                      <div style={{ fontSize: 11.5, color: "var(--sig-red)", marginTop: 6 }}>
                        {tierError}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {!isOwner && tier !== null && (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 12 }}>
                Governed as {TIER_LABELS[tier].toLowerCase()} — {TIER_DESCRIPTIONS[tier]}
              </div>
            )}

            {isOwner && (
              <div
                style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--stroke-1)" }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 8,
                  }}
                >
                  Invite link
                </div>
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  <div className="segmented" style={{ flex: 1 }}>
                    <button
                      className={linkRole === "editor" ? "active" : ""}
                      onClick={() => setLinkRole("editor")}
                    >
                      Can edit
                    </button>
                    <button
                      className={linkRole === "commenter" ? "active" : ""}
                      onClick={() => setLinkRole("commenter")}
                    >
                      Can comment
                    </button>
                    <button
                      className={linkRole === "viewer" ? "active" : ""}
                      onClick={() => setLinkRole("viewer")}
                    >
                      Can view
                    </button>
                  </div>
                  <button
                    className="btn"
                    onClick={() => void mintLink()}
                    disabled={minting}
                    style={{ fontSize: 11.5, whiteSpace: "nowrap" }}
                  >
                    {minting ? "…" : invite ? "New link" : "Create link"}
                  </button>
                </div>
                {invite && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--ink-2)",
                      lineHeight: 1.45,
                      marginBottom: 8,
                    }}
                  >
                    The link above now grants{" "}
                    <strong>{invite.role === "editor" ? "edit" : "view"}</strong> access. Anyone who
                    opens it joins the board; revoking stops new joins but keeps people who already
                    joined.
                  </div>
                )}
                <button
                  onClick={() => void revokeAll()}
                  style={{ fontSize: 11, color: "var(--sig-red)", padding: "2px 0" }}
                >
                  Revoke all links
                </button>
              </div>
            )}

            {members.length > 0 && (
              <div
                style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--stroke-1)" }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 8,
                  }}
                >
                  People with access ({members.length})
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    maxHeight: 160,
                    overflowY: "auto",
                  }}
                >
                  {members.map((m) => (
                    <div
                      key={m.userId}
                      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}
                    >
                      <span
                        className="mono"
                        style={{
                          flex: 1,
                          color: "var(--ink-2)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {m.userId}
                      </span>
                      {isOwner ? (
                        <>
                          <select
                            value={m.role}
                            aria-label={`Role for ${m.userId}`}
                            onChange={(e) => {
                              const role = e.target.value as ShareRole;
                              void setMemberRole(m.boardId, m.userId, role).then(refreshMembers);
                            }}
                            style={{
                              fontSize: 11,
                              background: "var(--canvas-2)",
                              color: "var(--ink-1)",
                              border: "1px solid var(--stroke-1)",
                              borderRadius: "var(--r-xs)",
                              padding: "2px 4px",
                            }}
                          >
                            <option value="editor">Can edit</option>
                            <option value="commenter">Can comment</option>
                            <option value="viewer">Can view</option>
                          </select>
                          <button
                            onClick={() =>
                              void removeMember(m.boardId, m.userId).then(refreshMembers)
                            }
                            aria-label={`Remove ${m.userId}`}
                            style={{ color: "var(--ink-3)", padding: 2 }}
                          >
                            <Ico.X />
                          </button>
                        </>
                      ) : (
                        <span style={{ color: "var(--ink-3)" }}>{m.role}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: 12 }}>
              {signedIn
                ? "This board is local to your browser. Publish it to collaborate live — others open the link and see your cursor and edits as they happen."
                : "Sign in first: a shared board lives on the server, so it needs an account to own it."}
            </div>
            <button
              className="btn amber"
              style={{ width: "100%" }}
              onClick={() => void share()}
              disabled={!signedIn || sharing}
            >
              {sharing ? "Publishing…" : "Publish & start collaborating"}
            </button>
          </>
        )}
        {error && (
          <div style={{ fontSize: 11.5, color: "var(--sig-red)", lineHeight: 1.45, marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

/**
 * Asks the app-level command palette (App.tsx owns it) to open. An event
 * rather than a prop so any surface — the rail, Home's composer, an empty
 * state — can summon the one palette without threading callbacks.
 */
export const OPEN_PALETTE_EVENT = "lucent:open-command-palette";

export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}

/** Same pattern for the settings modal; `detail` is the section to open. */
export const OPEN_SETTINGS_EVENT = "lucent:open-settings";

export function requestSettings(section?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: section }));
}

/**
 * The seven places a team works (Atelier IA). Ordered by the product's own
 * loop: see what needs you → pick a board → shape it → talk it through →
 * understand what was decided → carry it out → trace how it got here.
 */
const RAIL_ITEMS: { id: string; icon: keyof typeof Ico; label: string; view: View }[] = [
  { id: "home", icon: "Home", label: "Home", view: "home" },
  { id: "boards", icon: "Folder", label: "Boards", view: "dashboard" },
  { id: "canvas", icon: "Layers", label: "Canvas", view: "canvas" },
  { id: "meeting", icon: "Present", label: "Meeting", view: "meeting" },
  { id: "intelligence", icon: "Sparkle", label: "Intelligence", view: "intelligence" },
  { id: "execution", icon: "Gauge", label: "Execution", view: "execution" },
  { id: "history", icon: "History", label: "History", view: "history" },
];

/**
 * Canvas lenses (UX-1): the same board, re-rendered. They nest under Canvas
 * and only unfold while the canvas is the active surface — one model, many
 * representations, without seven more icons competing on every screen.
 */
const RAIL_LENSES: {
  id: string;
  label: string;
  lens: CanvasLens;
  Icon: (p: SVGProps<SVGSVGElement>) => JSX.Element;
}[] = [
  { id: "visual", label: "Diagram", lens: "visual", Icon: Ico.Flow },
  { id: "kanban", label: "Kanban", lens: "kanban", Icon: Ico.Kanban },
  { id: "document", label: "Document", lens: "document", Icon: Ico.Book },
  { id: "wireframe", label: "Wireframe", lens: "wireframe", Icon: ToolIco.Frame },
  { id: "sequence", label: "Sequence", lens: "sequence", Icon: Ico.Sequence },
  { id: "er", label: "ER diagram", lens: "er", Icon: Ico.Table },
];

/** Legacy lens views that still route as views; they belong to Canvas. */
const CANVAS_VIEWS: ReadonlySet<View> = new Set([
  "canvas",
  "board",
  "document",
  "wireframe",
  "sequence",
  "er",
]);

export function LeftRail({
  side = "left",
  onOpenSettings,
}: {
  side?: "left" | "right";
  onOpenSettings?: (section?: string) => void;
}) {
  const { view, setView, lens, setLens, newProject, workspace } = useWorkspace();
  const [confirmNew, setConfirmNew] = useState(false);

  // Does the current board hold work worth warning about before replacing it?
  const hasWork =
    Object.keys(workspace.nodes).length > 0 ||
    Object.keys(workspace.shapes).length > 0 ||
    Object.keys(workspace.wireframes).length > 0;

  const onCanvas = CANVAS_VIEWS.has(view);

  return (
    <>
      <nav className={`left-rail ${side === "right" ? "on-right" : ""}`} aria-label="Main">
        <button
          className="rail-new"
          data-tip="New board"
          title="New board"
          aria-label="New board"
          onClick={() => (hasWork ? setConfirmNew(true) : newProject())}
        >
          <Ico.Plus />
        </button>
        {RAIL_ITEMS.map((it) => {
          const Icon = Ico[it.icon];
          const active = it.id === "canvas" ? onCanvas : view === it.view;
          return (
            <div key={it.id} className="rail-group">
              <button
                className={`rail-btn ${active ? "active" : ""}`}
                data-tip={it.label}
                title={it.label}
                aria-label={it.label}
                aria-current={active ? "page" : undefined}
                onClick={() => setView(it.view)}
              >
                <Icon />
              </button>
              {it.id === "canvas" && onCanvas && (
                <div className="rail-lenses" role="group" aria-label="Canvas lenses">
                  {RAIL_LENSES.map((l) => {
                    const on = view === "canvas" && lens === l.lens;
                    return (
                      <button
                        key={l.id}
                        className={`rail-lens ${on ? "active" : ""}`}
                        data-tip={l.label}
                        title={l.label}
                        aria-label={`${l.label} lens`}
                        aria-pressed={on}
                        onClick={() => {
                          // setView first: setView("canvas") resets to the board's
                          // own lens, so the explicit lens applies after.
                          setView("canvas");
                          setLens(l.lens);
                        }}
                      >
                        <l.Icon />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <button
          className="rail-btn"
          data-tip="Search · ⌘K"
          title="Search · ⌘K"
          aria-label="Search"
          onClick={openCommandPalette}
        >
          <Ico.Search />
        </button>
        <button
          className="rail-btn"
          data-tip="Settings · ⌘,"
          title="Settings · ⌘,"
          aria-label="Settings"
          onClick={() => (onOpenSettings ? onOpenSettings() : requestSettings())}
        >
          <ToolIco.Settings />
        </button>
      </nav>
      {confirmNew && (
        <ConfirmNewWorkspace
          onCancel={() => setConfirmNew(false)}
          onConfirm={() => {
            setConfirmNew(false);
            newProject();
          }}
        />
      )}
    </>
  );
}

/** Guard before replacing the current board. `newProject` is not undoable via
 * canvas history, so a mis-click used to lose the whole board silently. */
function ConfirmNewWorkspace({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog onClose={onCancel} title="Start a new workspace?">
      <div className="confirm-body">
        This board stays saved in Projects, but the canvas will be cleared and you'll start from an
        empty board.
      </div>
      <div className="confirm-actions">
        <button className="btn ghost" onClick={onCancel} autoFocus>
          Keep working here
        </button>
        <button className="btn amber" onClick={onConfirm}>
          New workspace
        </button>
      </div>
    </Dialog>
  );
}

export function ZoomBadge({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
  overviewOn,
  onToggleOverview,
}: {
  zoom: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onReset?: () => void;
  onFit?: () => void;
  /** Current overview (minimap) visibility, when the toggle is offered. */
  overviewOn?: boolean;
  onToggleOverview?: () => void;
}) {
  return (
    <div
      className="chrome-badge"
      style={{
        position: "absolute",
        bottom: 20,
        // Clear of the rail (x 12–68).
        left: 84,
        zIndex: 25,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        userSelect: "none",
      }}
    >
      <button
        style={{ padding: "0 4px", fontSize: 14, lineHeight: 1 }}
        onClick={onZoomOut}
        title="Zoom out"
      >
        −
      </button>
      <button
        onClick={onReset}
        style={{ color: "var(--ink-1)", minWidth: 42, textAlign: "center" }}
      >
        {Math.round(zoom)}%
      </button>
      <button
        style={{ padding: "0 4px", fontSize: 14, lineHeight: 1 }}
        onClick={onZoomIn}
        title="Zoom in"
      >
        +
      </button>
      {onFit && (
        <button style={{ padding: "0 6px", fontSize: 11 }} onClick={onFit} title="Zoom to fit">
          Fit
        </button>
      )}
      {onToggleOverview && (
        <button
          style={{
            padding: "0 6px",
            fontSize: 11,
            color: overviewOn ? "var(--ink-0)" : "var(--ink-3)",
          }}
          onClick={onToggleOverview}
          title={overviewOn ? "Hide board overview" : "Show board overview"}
        >
          Map
        </button>
      )}
    </div>
  );
}

export function StatusBadge({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="chrome-badge"
      style={{
        position: "absolute",
        bottom: 20,
        right: 20,
        zIndex: 25,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        letterSpacing: "0.03em",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}
