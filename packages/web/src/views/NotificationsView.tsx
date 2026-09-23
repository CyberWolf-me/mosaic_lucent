import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useWorkspace } from "../workspace.js";
import { navigate } from "../routes.js";
import { useToast } from "../ui/Toast.js";
import { Ico } from "../ui/icons.js";
import {
  AtelierAppShell,
  SectionHeader,
  RiskIcon,
  BellIcon,
} from "../ui/atelierAtoms.js";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  describeNotification,
  notificationAge,
  notificationTimestamp,
  type NotificationView,
  type NotificationIcon,
} from "../notifications.js";

/**
 * Screen 21 — Notifications (full page).
 *
 * Replaces the embedded v2 prototype iframe with a native React view wired to
 * the real `/api/notifications` endpoints. Rows group into "Needs you" (unread)
 * and "Earlier" (read); the badge count is always taken from the server's
 * response, matching the tray popover the rail already shipped.
 */

const ICON_FOR: Record<NotificationIcon, ReactNode> = {
  invite: <Ico.Folder />,
  member: <Ico.Comment />,
  role: <RiskIcon />,
  comment: <Ico.Comment />,
  bell: <BellIcon />,
};

const COLOR_FOR: Record<NotificationIcon, string> = {
  invite: "var(--bloom-2)",
  member: "var(--moss)",
  role: "var(--saffron)",
  comment: "oklch(0.55 0.11 220)",
  bell: "var(--ink-2)",
};

export function NotificationsView({
  onOpenSettings,
}: {
  onOpenSettings?: (section?: string) => void;
}) {
  const { setView } = useWorkspace() as unknown as { setView: (v: string) => void };
  const { notify } = useToast();
  const [rows, setRows] = useState<NotificationView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");

  const load = useCallback(async () => {
    const res = await fetchNotifications({ limit: 50 });
    if (!res.ok) {
      // A deployment without a notification store (503) or a signed-out session
      // both read as "nothing to show" here rather than a scary error wall.
      setState(res.failure === "error" || res.failure === "offline" ? "error" : "empty");
      setRows([]);
      return;
    }
    const views = res.value.notifications.map(describeNotification);
    setRows(views);
    setState(views.length === 0 ? "empty" : "ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { needsYou, earlier } = useMemo(() => {
    const unread = rows.filter((r) => !r.read);
    const read = rows.filter((r) => r.read);
    return { needsYou: unread, earlier: read };
  }, [rows]);

  const openRow = async (row: NotificationView) => {
    if (!row.read) {
      const res = await markNotificationRead(row.id);
      if (res.ok) {
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, read: true } : r)));
      }
    }
    if (row.href) navigate(row.href);
  };

  const markAll = async () => {
    const res = await markAllNotificationsRead();
    if (res.ok) {
      setRows((prev) => prev.map((r) => ({ ...r, read: true })));
      setState((s) => (rows.length === 0 ? "empty" : s));
      notify("All notifications marked read", <Ico.Check />, "success");
    }
  };

  const unreadCount = needsYou.length;

  return (
    <AtelierAppShell
      activeArea="notif"
      crumbs={[{ label: "Notifications", current: true }]}
      onOpenSettings={onOpenSettings}
    >
      <div style={{ padding: "32px 40px 60px", maxWidth: 900, margin: "0 auto" }}>
        <SectionHeader
          eyebrow="Notifications"
          title="Notifications"
          meta={
            state === "ready"
              ? `${unreadCount} need${unreadCount === 1 ? "s" : ""} you · ${rows.length} total`
              : undefined
          }
          actions={
            <>
              <button
                className="icon-btn"
                onClick={markAll}
                disabled={unreadCount === 0}
                title="Mark all as read"
              >
                Mark all read
              </button>
              <button
                className="icon-btn"
                onClick={() => onOpenSettings?.("notifications")}
                title="Notification preferences"
              >
                <Ico.Settings /> Preferences
              </button>
            </>
          }
        />

        {state === "loading" && <NotifSkeleton />}

        {state === "error" && (
          <NotifMessage
            title="Couldn't load notifications"
            body="The notification service didn't respond. Try again in a moment."
            action={
              <button className="btn ghost" onClick={() => void load()}>
                Retry
              </button>
            }
          />
        )}

        {state === "empty" && (
          <NotifMessage
            title="You're all caught up"
            body="Invites, mentions, and extracted decisions will show up here. Start a meeting or share a board to get things moving."
            action={
              <button className="btn bloom" onClick={() => setView("meeting_board")}>
                Start a meeting
              </button>
            }
          />
        )}

        {state === "ready" && (
          <>
            {needsYou.length > 0 && (
              <NotifGroup label={`Needs you · ${needsYou.length}`}>
                {needsYou.map((r) => (
                  <NotifRow key={r.id} row={r} onOpen={() => void openRow(r)} />
                ))}
              </NotifGroup>
            )}
            {earlier.length > 0 && (
              <NotifGroup label="Earlier">
                {earlier.map((r) => (
                  <NotifRow key={r.id} row={r} onOpen={() => void openRow(r)} />
                ))}
              </NotifGroup>
            )}
          </>
        )}
      </div>
    </AtelierAppShell>
  );
}

function NotifGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="mono-caps" style={{ marginBottom: 10 }}>
        {label}
      </div>
      <div style={{ display: "grid", gap: 6 }}>{children}</div>
    </div>
  );
}

function NotifRow({ row, onOpen }: { row: NotificationView; onOpen: () => void }) {
  const color = COLOR_FOR[row.icon];
  return (
    <button
      onClick={onOpen}
      title={notificationTimestamp(row.createdAt)}
      style={{
        padding: "12px 14px",
        borderRadius: "var(--r-sm)",
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        textAlign: "left",
        cursor: "pointer",
        transition: "all 0.12s var(--e-out)",
        opacity: row.read ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--paper-1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--paper-0)";
      }}
    >
      {!row.read && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--bloom-2)",
            flexShrink: 0,
            marginTop: 8,
            boxShadow: "0 0 6px var(--bloom-glow)",
          }}
        />
      )}
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          background: `oklch(from ${color} l c h / 0.14)`,
          color,
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        {ICON_FOR[row.icon]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-0)", marginBottom: 3 }}>
          {row.title}
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-2)",
            lineHeight: 1.4,
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
          }}
        >
          {row.body ?? row.category}
        </div>
      </div>
      <span
        className="mono"
        style={{ fontSize: 10.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}
      >
        {notificationAge(row.createdAt, Date.now())}
      </span>
    </button>
  );
}

function NotifMessage({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        gap: 10,
        textAlign: "center",
        padding: "64px 24px",
        border: "1px dashed oklch(from var(--paper-4) l c h / 0.7)",
        borderRadius: "var(--r-lg)",
        background: "oklch(from var(--paper-0) l c h / 0.5)",
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: "var(--bloom-wash)",
          color: "var(--bloom-2)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <BellIcon />
      </div>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 20, color: "var(--ink-0)" }}>
        {title}
      </div>
      <div style={{ fontSize: 13.5, color: "var(--ink-2)", maxWidth: 420, lineHeight: 1.5 }}>
        {body}
      </div>
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

function NotifSkeleton() {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 58,
            borderRadius: "var(--r-sm)",
            background:
              "linear-gradient(90deg, var(--paper-2) 25%, var(--paper-1) 37%, var(--paper-2) 63%)",
            backgroundSize: "400% 100%",
            animation: "skeleton-shimmer 1.4s ease infinite",
          }}
        />
      ))}
    </div>
  );
}
