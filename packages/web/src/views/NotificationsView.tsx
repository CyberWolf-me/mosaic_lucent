import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspace } from "../workspace.js";
import { navigate } from "../routes.js";
import { useToast } from "../ui/Toast.js";
import { Ico, ToolIco } from "../ui/icons.js";
import { Button, EmptyState, FilterChips, Page, PageHeader, SectionLabel } from "../ui/kit.js";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  describeNotification,
  notificationAge,
  notificationTimestamp,
  type NotificationFailure,
  type NotificationView,
  type NotificationIcon,
} from "../notifications.js";

/**
 * Notifications (full page).
 *
 * The page twin of the top bar's tray, wired to the same `/api/notifications`
 * routes. Rows split into "Unread" and "Earlier"; the unread count is always
 * the server's (every read/mark response carries it), never one derived from
 * whichever rows happen to be loaded — the contract `notifications.ts` sets.
 */

const PAGE_SIZE = 50;

const ICON_FOR: Record<NotificationIcon, ReactNode> = {
  invite: <Ico.Share />,
  member: <Ico.Team />,
  role: <Ico.Lock />,
  comment: <Ico.Comment />,
  meeting: <Ico.Present />,
  work: <Ico.Gauge />,
  review: <Ico.Check />,
  bell: <ToolIco.Bell />,
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed"; failure: NotificationFailure };

type Filter = "all" | "unread";

export function NotificationsView({
  onOpenSettings,
}: {
  onOpenSettings: (section?: string) => void;
}) {
  const { setView } = useWorkspace();
  const { notify } = useToast();
  const [rows, setRows] = useState<NotificationView[]>([]);
  const [unread, setUnread] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const res = await fetchNotifications({ limit: PAGE_SIZE });
    if (!res.ok) {
      setRows([]);
      setCursor(null);
      setState({ kind: "failed", failure: res.failure });
      return;
    }
    setRows(res.value.notifications.map(describeNotification));
    setUnread(res.value.unread);
    setCursor(res.value.nextCursor);
    setState({ kind: "ready" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const res = await fetchNotifications({ limit: PAGE_SIZE, cursor });
    setLoadingMore(false);
    if (!res.ok) {
      notify("Couldn't load older notifications — try again.");
      return;
    }
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      return [
        ...prev,
        ...res.value.notifications.map(describeNotification).filter((r) => !seen.has(r.id)),
      ];
    });
    setUnread(res.value.unread);
    setCursor(res.value.nextCursor);
  };

  const { unreadRows, earlier } = useMemo(
    () => ({ unreadRows: rows.filter((r) => !r.read), earlier: rows.filter((r) => r.read) }),
    [rows],
  );

  const openRow = async (row: NotificationView) => {
    if (!row.read) {
      const res = await markNotificationRead(row.id);
      if (res.ok) {
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, read: true } : r)));
        setUnread(res.value.count);
      } else if (!row.href) {
        notify("Couldn't mark that as read — try again.");
      }
    }
    if (row.href) navigate(row.href);
  };

  const markAll = async () => {
    const res = await markAllNotificationsRead();
    if (!res.ok) {
      notify("Couldn't mark those as read — try again.");
      return;
    }
    setRows((prev) => prev.map((r) => ({ ...r, read: true })));
    setUnread(res.value.count);
    notify("All notifications marked read", <Ico.Check />, "success");
  };

  const ready = state.kind === "ready";
  const now = Date.now();

  return (
    <Page
      crumbs={[{ label: "Notifications", current: true }]}
      boardScoped={false}
      onOpenSettings={onOpenSettings}
      width="narrow"
    >
      <PageHeader
        eyebrow="Notifications"
        title={
          ready && rows.length > 0 ? (
            unread > 0 ? (
              <>
                {unread} {unread === 1 ? "thing" : "things"}{" "}
                <em>need{unread === 1 ? "s" : ""} you</em>
              </>
            ) : (
              <>
                You&apos;re <em>all caught up</em>
              </>
            )
          ) : (
            "Notifications"
          )
        }
        lede="Invites, new teammates, access changes, mentions and replies — for your account, across every workspace."
        actions={
          ready && unread > 0 ? (
            <Button variant="ghost" onClick={() => void markAll()}>
              <Ico.Check /> Mark all read
            </Button>
          ) : undefined
        }
      />

      {state.kind === "loading" && <NotifSkeleton />}

      {state.kind === "failed" && (
        <FailedState failure={state.failure} onRetry={() => void load()} />
      )}

      {ready && rows.length === 0 && (
        <EmptyState
          glyph={<ToolIco.Bell width={22} height={22} />}
          title="Nothing here yet"
          body="You'll hear here when someone invites you to a board or workspace, joins a board you shared, changes your access, or mentions or replies to you in a comment. Share a board from its top bar to bring someone in."
          action={
            <Button variant="primary" onClick={() => setView("dashboard")}>
              <Ico.Folder /> Go to your boards
            </Button>
          }
        />
      )}

      {ready && rows.length > 0 && (
        <>
          <div className="boards-notif-toolbar">
            <FilterChips
              items={[
                { id: "all", label: "All", count: rows.length },
                { id: "unread", label: "Unread", count: unread },
              ]}
              value={filter}
              onChange={setFilter}
              label="Show notifications"
            />
          </div>

          {unreadRows.length > 0 && (
            <section className="boards-notif-group" aria-label="Unread">
              <SectionLabel count={unreadRows.length}>Unread</SectionLabel>
              <ul className="boards-notif-list">
                {unreadRows.map((r) => (
                  <NotifRow key={r.id} row={r} now={now} onOpen={() => void openRow(r)} />
                ))}
              </ul>
            </section>
          )}

          {filter === "unread" && unreadRows.length === 0 && (
            <EmptyState
              compact
              title={unread > 0 ? "Unread notifications are further back" : "Nothing unread"}
              body={
                unread > 0
                  ? "They're older than what's loaded. Load older notifications, or mark them all read."
                  : undefined
              }
              action={
                <Button size="sm" onClick={() => setFilter("all")}>
                  Show all
                </Button>
              }
            />
          )}

          {filter === "all" && earlier.length > 0 && (
            <section className="boards-notif-group" aria-label="Earlier">
              <SectionLabel count={earlier.length}>Earlier</SectionLabel>
              <ul className="boards-notif-list">
                {earlier.map((r) => (
                  <NotifRow key={r.id} row={r} now={now} onOpen={() => void openRow(r)} />
                ))}
              </ul>
            </section>
          )}

          {cursor && (
            <div className="boards-notif-more">
              <Button size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load older"}
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

function NotifRow({
  row,
  now,
  onOpen,
}: {
  row: NotificationView;
  now: number;
  onOpen: () => void;
}) {
  const body = (
    <>
      <span className={`boards-notif-ico ${row.icon}`} aria-hidden="true">
        {ICON_FOR[row.icon]}
      </span>
      <span className="boards-notif-main">
        <span className="boards-notif-meta">
          <span className="mono-caps">{row.category}</span>
          {!row.read && <span className="boards-notif-new">Unread</span>}
        </span>
        <span className="boards-notif-title">{row.title}</span>
        {row.body !== null && <span className="boards-notif-body">{row.body}</span>}
      </span>
      <time
        className="boards-notif-age mono"
        dateTime={new Date(row.createdAt).toISOString()}
        title={notificationTimestamp(row.createdAt)}
      >
        {notificationAge(row.createdAt, now)}
      </time>
    </>
  );
  // A read row with nowhere to go is information, not a control.
  if (row.read && !row.href) {
    return (
      <li>
        <div className="boards-notif-row read static">{body}</div>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className={`boards-notif-row ${row.read ? "read" : "unread"}`}
        onClick={onOpen}
        title={row.href ? undefined : "Mark as read"}
      >
        {body}
      </button>
    </li>
  );
}

function FailedState({ failure, onRetry }: { failure: NotificationFailure; onRetry: () => void }) {
  if (failure === "signed-out") {
    return (
      <EmptyState
        compact
        title="Sign in to see your notifications"
        body="Notifications belong to your account, so they need a signed-in session."
      />
    );
  }
  if (failure === "unavailable") {
    return (
      <EmptyState
        compact
        title="Notifications aren't switched on for this server"
        body="Whoever runs this Lucent deployment hasn't configured a notification store, so nothing is recorded here."
      />
    );
  }
  return (
    <div role="alert">
      <EmptyState
        compact
        title="Couldn't load notifications"
        body={
          failure === "offline"
            ? "The Lucent server didn't answer. Check your connection and try again."
            : "The notification service returned an error. Try again in a moment."
        }
        action={
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    </div>
  );
}

function NotifSkeleton() {
  return (
    <div className="boards-notif-skeleton" role="status" aria-label="Loading notifications">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} />
      ))}
    </div>
  );
}
