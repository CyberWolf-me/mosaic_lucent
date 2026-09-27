import { useCallback, useEffect, useRef, useState } from "react";
import { Ico, ToolIco } from "./icons.js";
import { useToast } from "./Toast.js";
import {
  badgeText,
  describeNotification,
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  notificationAge,
  notificationTimestamp,
  startUnreadPoll,
  unreadAnnouncement,
  unreadLabel,
} from "../notifications.js";
import type { NotificationIcon, NotificationView } from "../notifications.js";
import type { ReactNode } from "react";

/**
 * The notification tray: the bell in the top bar, its badge, and the panel it
 * opens. Restores the item the prototype's account menu used to fake — the
 * server has been writing invites, mentions and replies since M2.6 and nothing
 * in the browser was reading them.
 *
 * The rules it plays by:
 * - THE BADGE NEVER DISAGREES WITH THE LIST. Opening the tray sets the count
 *   from the very response that produced the rows (the list route sends both),
 *   and a mark-read takes the count from the write's own reply. Nothing here
 *   counts rows and calls that a badge.
 * - OPTIMISTIC, THEN RECONCILED. A click marks a row read immediately because
 *   the common case is that it worked; a failed write puts the row back, asks the
 *   server for the real count and says so out loud. A silently wrong badge is the
 *   one outcome that is not allowed.
 * - THE COUNT IS NOT ONLY A BADGE. It is in the trigger's accessible name and in
 *   a polite live region, and every card states "Unread" in words next to the
 *   dot, because colour and a pill are not information for everyone.
 */

/** Rows per request. Two screens' worth: enough to scroll, small enough to feel instant. */
const PAGE_SIZE = 20;

/**
 * Icon per category. Pre-built elements rather than components: they are
 * decorative (`aria-hidden`), immutable, and this keeps the lookup a plain map.
 * Mention and reply share one on purpose — the difference between them is stated
 * in words, and inventing two glyphs for it would be decoration pretending to be
 * meaning.
 */
const ICON_NODES: Record<NotificationIcon, ReactNode> = {
  invite: <Ico.Share />,
  member: <ToolIco.Team />,
  role: <Ico.Lock />,
  comment: <Ico.Comment />,
  meeting: <Ico.Present />,
  work: <Ico.Gauge />,
  review: <Ico.Check />,
  bell: <ToolIco.Bell />,
};

export function NotificationTray() {
  const { notify } = useToast();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotificationView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  /**
   * Whether this deployment has notifications at all. Starts optimistic and goes
   * false on the first 503 or 401: the alternative is a probe request before the
   * bell can be drawn, which every deployment that does have the feature would
   * pay for.
   */
  const [available, setAvailable] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** One list request at a time; a double-click on the bell must not race itself. */
  const loadingRef = useRef(false);

  useEffect(
    () =>
      startUnreadPoll({
        onCount: setCount,
        onStopped: () => {
          setAvailable(false);
          setOpen(false);
        },
      }),
    [],
  );

  const load = useCallback(async (from?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setStatus("loading");
    const res = await fetchNotifications({
      limit: PAGE_SIZE,
      ...(from !== undefined ? { cursor: from } : {}),
    });
    loadingRef.current = false;
    if (!res.ok) {
      if (res.failure === "signed-out" || res.failure === "unavailable") {
        setAvailable(false);
        setOpen(false);
        return;
      }
      setStatus("error");
      return;
    }
    setStatus("idle");
    const views = res.value.notifications.map(describeNotification);
    // `from` undefined means "first page": replace, so reopening the tray cannot
    // stack yesterday's rows on top of today's.
    setRows((prev) => (from === undefined ? views : [...prev, ...views]));
    setCursor(res.value.nextCursor);
    setCount(res.value.unread);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    // Escape and an outside click must not drop focus into nowhere; hand it back
    // to the button that opened the panel.
    triggerRef.current?.focus();
  }, []);

  // Escape closes, from anywhere — the same idiom the confirm dialog uses. Bound
  // only while open so the tray does not hold a listener it cannot act on.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    // Opening is the fetch. The rows and the badge then come from one response,
    // which is the whole reason the list route sends the count.
    void load();
  };

  const readOne = async (view: NotificationView) => {
    // An already-read row has nothing to write and, more importantly, nothing to
    // subtract: decrementing here is how a badge drifts below the truth.
    if (view.read) return;
    const previousCount = count;
    setRows((list) => list.map((r) => (r.id === view.id ? { ...r, read: true } : r)));
    setCount((c) => Math.max(0, c - 1));
    const res = await markNotificationRead(view.id);
    if (res.ok) {
      // `changed: false` means another tab got there first. Not a failure — and
      // the count still comes from the server either way.
      setCount(res.value.count);
      return;
    }
    // The write did not land. Un-read the row, then ask what the count really is
    // rather than keeping the number we guessed; if even that fails, restore the
    // one we started from instead of inventing a new one.
    setRows((list) => list.map((r) => (r.id === view.id ? { ...r, read: false } : r)));
    const fresh = await fetchUnreadCount();
    setCount(fresh.ok ? fresh.value : previousCount);
    notify("Couldn't mark that as read — try again.");
  };

  const readAll = async () => {
    const previousRows = rows;
    const previousCount = count;
    setRows(previousRows.map((r) => ({ ...r, read: true })));
    setCount(0);
    const res = await markAllNotificationsRead();
    if (res.ok) {
      // The route answers a hardcoded zero rather than re-reading the store, so a
      // notification written while this was in flight shows up on the next poll.
      setCount(res.value.count);
      return;
    }
    // A failed bulk write leaves us not knowing which rows the server still
    // considers unread, so restore the snapshot whole: a list and a badge that
    // agree and are a minute stale beat a pair that disagree.
    setRows(previousRows);
    setCount(previousCount);
    notify("Couldn't mark those as read — try again.");
  };

  /**
   * Follow a card. A real navigation, not the router's soft `navigate`: the
   * workspace reads `?board=` once at mount, so pushing the URL would update the
   * address bar and leave the previous board on screen. Because a full load
   * cancels anything in flight, the mark-read is awaited before the jump.
   */
  const followLink = (view: NotificationView, e: React.MouseEvent<HTMLAnchorElement>) => {
    // A modified click is the browser's job — it opens a tab and leaves this page
    // alone — but the row is still read either way, so the write happens without
    // blocking it.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      void readOne(view);
      return;
    }
    e.preventDefault();
    void (async () => {
      await readOne(view);
      if (view.href !== null) window.location.assign(view.href);
    })();
  };

  if (!available) return null;

  // One clock per render: ages that tick independently would re-render the panel
  // for no reason, and they refresh whenever the tray is opened anyway.
  const now = Date.now();

  return (
    <>
      <button
        ref={triggerRef}
        className="icon-btn notif-btn"
        onClick={toggle}
        aria-label={unreadLabel(count)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls="notif-panel"
      >
        <ToolIco.Bell />
        {count > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {badgeText(count)}
          </span>
        )}
      </button>
      {/* The badge, as text, for anyone who cannot see it — announced politely on
          change and silent at zero so a quiet tray says nothing on load. */}
      <span className="sr-only" role="status">
        {unreadAnnouncement(count)}
      </span>
      {open && (
        <>
          {/* Click-anywhere-else catcher, as the share popover does it. */}
          <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 210 }} />
          <div
            id="notif-panel"
            className="notif-panel"
            role="group"
            aria-labelledby="notif-heading"
          >
            <div className="notif-head">
              <h2 id="notif-heading">Notifications</h2>
              <button
                className="notif-mark-all"
                onClick={() => void readAll()}
                disabled={count === 0}
              >
                Mark all read
              </button>
              <button className="notif-close" onClick={close} aria-label="Close notifications">
                <Ico.X />
              </button>
            </div>
            {rows.length === 0 && status === "loading" && <p className="notif-note">Loading…</p>}
            {rows.length === 0 && status === "idle" && (
              <p className="notif-note">Nothing yet. Invites, mentions and replies land here.</p>
            )}
            {status === "error" && (
              <p className="notif-note" role="alert">
                Couldn&rsquo;t load notifications.{" "}
                <button className="notif-retry" onClick={() => void load()}>
                  Retry
                </button>
              </p>
            )}
            {rows.length > 0 && (
              <ul className="notif-list">
                {rows.map((view) => (
                  <NotificationCard
                    key={view.id}
                    view={view}
                    now={now}
                    onRead={(v) => void readOne(v)}
                    onFollow={followLink}
                  />
                ))}
              </ul>
            )}
            {cursor !== null && (
              <button
                className="notif-more"
                onClick={() => void load(cursor)}
                disabled={status === "loading"}
              >
                {status === "loading" ? "Loading…" : "Show older"}
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

function NotificationCard({
  view,
  now,
  onRead,
  onFollow,
}: {
  view: NotificationView;
  now: number;
  onRead: (view: NotificationView) => void;
  onFollow: (view: NotificationView, e: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <li className={`notif-row ${view.read ? "" : "unread"}`}>
      <span className="notif-ico" aria-hidden="true">
        {ICON_NODES[view.icon]}
      </span>
      <div className="notif-main">
        <div className="notif-meta">
          <span className="notif-cat">{view.category}</span>
          <span aria-hidden="true">·</span>
          <span className="notif-age" title={notificationTimestamp(view.createdAt)}>
            {notificationAge(view.createdAt, now)}
          </span>
          {/* Words, not only the dot on the left: the state has to survive being
              read aloud or seen without colour. */}
          {!view.read && <span className="notif-new">Unread</span>}
        </div>
        {view.href !== null ? (
          <a className="notif-subject" href={view.href} onClick={(e) => onFollow(view, e)}>
            {view.title}
          </a>
        ) : (
          <span className="notif-subject plain">{view.title}</span>
        )}
        {view.body !== null && <p className="notif-body">{view.body}</p>}
      </div>
      {!view.read && (
        <button
          className="notif-check"
          onClick={() => onRead(view)}
          aria-label={`Mark "${view.title}" as read`}
          title="Mark as read"
        >
          <Ico.Check />
        </button>
      )}
    </li>
  );
}
