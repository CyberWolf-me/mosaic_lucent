import React, { useState, useEffect } from "react";
import {
  AtelierAppShell,
  SectionHeader,
  LinearMark,
  GithubMark,
  SlackMark,
  GmeetMark,
  ZoomMark,
  DriveMark,
  NotionMark,
  JiraMark,
  FigmaMark,
} from "../ui/atelierAtoms.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";
import { fetchOrgIntegrations, fetchIntegrationLinks, type IntegrationLink } from "../boards.js";
import { getCurrentOrgId } from "../orgs.js";

interface ConnectedItem {
  id: string;
  name: string;
  provider: string;
  kind: string;
  mark: React.ReactNode;
  status: "active" | "idle" | "disabled";
  activity: string;
  configured?: boolean;
}

interface AvailableItem {
  id: string;
  name: string;
  provider: string;
  kind: string;
  mark: React.ReactNode;
  description: string;
}

const DEFAULT_CONNECTED: ConnectedItem[] = [
  { id: "linear", name: "Linear", provider: "linear", kind: "Issues", mark: <LinearMark />, status: "active", activity: "4 issues synced today" },
  { id: "github", name: "GitHub", provider: "github", kind: "Code", mark: <GithubMark />, status: "active", activity: "3 PRs · 12 commits linked" },
  { id: "slack", name: "Slack", provider: "slack", kind: "Chat", mark: <SlackMark />, status: "active", activity: "2 threads linked to actions" },
  { id: "gmeet", name: "Google Meet", provider: "gmeet", kind: "Meetings", mark: <GmeetMark />, status: "active", activity: "1 meeting joined today" },
  { id: "zoom", name: "Zoom", provider: "zoom", kind: "Meetings", mark: <ZoomMark />, status: "idle", activity: "0 today · idle" },
  { id: "gdrive", name: "Google Drive", provider: "gdrive", kind: "Storage", mark: <DriveMark />, status: "active", activity: "2 files attached this week" },
  { id: "notion", name: "Notion", provider: "notion", kind: "Docs", mark: <NotionMark />, status: "idle", activity: "no activity in 3 weeks" },
];

const DEFAULT_AVAILABLE: AvailableItem[] = [
  { id: "jira", name: "Jira", provider: "jira", kind: "Issues", mark: <JiraMark />, description: "Atlassian Jira Software issue sync and bi-directional status tracking." },
  { id: "asana", name: "Asana", provider: "asana", kind: "Tasks", mark: <Ico.Folder />, description: "Sync tasks and project deliverables directly from strategy nodes." },
  { id: "confluence", name: "Confluence", provider: "confluence", kind: "Docs", mark: <Ico.Book />, description: "Export architecture diagrams and decision records directly to team wikis." },
  { id: "figma", name: "Figma", provider: "figma", kind: "Design", mark: <FigmaMark />, description: "Link canvas wireframes and UI components to live Figma artboards." },
  { id: "clickup", name: "ClickUp", provider: "clickup", kind: "Tasks", mark: <Ico.Layers />, description: "Bi-directional status updates for sprints and team backlogs." },
  { id: "gitlab", name: "GitLab", provider: "gitlab", kind: "Code", mark: <GithubMark />, description: "Connect merge requests and issue tracking on self-hosted or SaaS GitLab." },
];

const SYNC_EVENTS = [
  { icon: <LinearMark />, text: 'LIN-476 · marked Blocked · linked to action "Add /pay route"', time: "2h ago" },
  { icon: <GithubMark />, text: "PR #482 · draft opened by @jtorres · linked to LIN-476", time: "5h ago" },
  { icon: <SlackMark />, text: "#payments-launch · 1 thread linked to Payment Service risk", time: "5h ago" },
  { icon: <LinearMark />, text: "LIN-473 · closed by @jtorres · action marked Done", time: "yesterday" },
  { icon: <GithubMark />, text: "PR #481 · merged · closes 2 actions", time: "yesterday" },
];

export function IntegrationsView({ onOpenSettings }: { onOpenSettings?: (section?: string) => void }) {
  const { boardId, setView } = useWorkspace();
  const [connected, setConnected] = useState<ConnectedItem[]>(DEFAULT_CONNECTED);
  const [selectedModal, setSelectedModal] = useState<ConnectedItem | AvailableItem | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [liveLinks, setLiveLinks] = useState<IntegrationLink[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orgId = getCurrentOrgId();
      if (orgId) {
        try {
          const orgConns = await fetchOrgIntegrations(orgId);
          if (!cancelled && orgConns.length > 0) {
            setConnected((prev) => {
              const updated = [...prev];
              for (const c of orgConns) {
                const existing = updated.find((item) => item.provider === c.provider);
                if (existing) {
                  existing.status = c.status === "active" ? "active" : "disabled";
                  existing.configured = true;
                }
              }
              return updated;
            });
          }
        } catch {
          /* keep default connected items on standalone or test mode */
        }
      }

      if (boardId) {
        try {
          const links = await fetchIntegrationLinks(boardId);
          if (!cancelled && links.length > 0) {
            setLiveLinks(links);
          }
        } catch {
          /* fallback to static events */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const handleConnect = (item: ConnectedItem | AvailableItem) => {
    setSelectedModal(item);
    setApiKeyInput("");
  };

  const handleSaveConnection = () => {
    if (!selectedModal) return;
    setConnected((prev) => {
      const exists = prev.find((c) => c.provider === selectedModal.provider);
      if (exists) {
        return prev.map((c) => (c.provider === selectedModal.provider ? { ...c, status: "active", configured: true } : c));
      }
      return [
        ...prev,
        {
          id: selectedModal.id,
          name: selectedModal.name,
          provider: selectedModal.provider,
          kind: selectedModal.kind,
          mark: selectedModal.mark,
          status: "active",
          activity: "Connected just now",
          configured: true,
        },
      ];
    });
    setSyncNotice(`Successfully connected ${selectedModal.name}. Realtime synchronization is now active.`);
    setSelectedModal(null);
    setTimeout(() => setSyncNotice(null), 4000);
  };

  return (
    <AtelierAppShell
      activeArea="integrations"
      crumbs={[
        { label: "Admin", onClick: () => setView("admin") },
        { label: "Integrations", current: true },
      ]}
      onOpenSettings={onOpenSettings}
    >
      <div style={{ padding: "32px 40px 60px", maxWidth: 1100, margin: "0 auto", animation: "atelier-in 0.25s var(--e-out)" }}>
        <SectionHeader
          eyebrow="Fig. 23 · Integrations"
          title="Connected systems"
          meta="Lucent is the intelligence layer, not a replacement. Actions and decisions sync bi-directionally."
          actions={
            <button
              type="button"
              className="icon-btn primary"
              onClick={() => {
                const el = document.getElementById("available-section");
                el?.scrollIntoView({ behavior: "smooth" });
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 8,
                background: "var(--ink-0)",
                color: "var(--paper-0)",
                fontSize: 12.5,
                fontWeight: 500,
                border: "none",
                cursor: "pointer",
              }}
            >
              <Ico.Plus /> Connect more
            </button>
          }
        />

        {syncNotice && (
          <div
            style={{
              marginBottom: 20,
              padding: "12px 16px",
              borderRadius: 8,
              background: "oklch(from var(--moss) l c h / 0.12)",
              border: "1px solid var(--moss)",
              color: "var(--moss)",
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Ico.Check />
            <span>{syncNotice}</span>
          </div>
        )}

        <div className="mono-caps" style={{ marginBottom: 12, fontSize: 11, letterSpacing: "0.08em", color: "var(--ink-2)" }}>
          Connected · {connected.length}
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            gap: 12,
            marginBottom: 36,
          }}
        >
          {connected.map((c) => (
            <IntegrationCard
              key={c.id}
              item={c}
              connected
              onManage={() => handleConnect(c)}
            />
          ))}
        </div>

        <div id="available-section" className="mono-caps" style={{ marginBottom: 12, fontSize: 11, letterSpacing: "0.08em", color: "var(--ink-2)" }}>
          Available integrations
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 10,
            marginBottom: 36,
          }}
        >
          {DEFAULT_AVAILABLE.map((a) => (
            <IntegrationCard
              key={a.id}
              item={a}
              onConnect={() => handleConnect(a)}
            />
          ))}
        </div>

        <div className="mono-caps" style={{ marginBottom: 12, fontSize: 11, letterSpacing: "0.08em", color: "var(--ink-2)" }}>
          Sync activity · last 24h
        </div>
        <div
          style={{
            padding: "16px 20px",
            background: "var(--paper-0)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            borderRadius: 12,
            boxShadow: "var(--sh-card)",
          }}
        >
          {(liveLinks.length > 0
            ? liveLinks.map((link, i) => ({
                icon: link.provider === "linear" ? <LinearMark /> : link.provider === "github" ? <GithubMark /> : <JiraMark />,
                text: `${link.externalId || link.provider} · linked to node #${link.nodeId.slice(0, 6)} (${link.status || "synced"})`,
                time: "recently",
              }))
            : SYNC_EVENTS
          ).map((r, i, arr) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 0",
                borderBottom: i < arr.length - 1 ? "1px solid oklch(from var(--paper-4) l c h / 0.4)" : "none",
              }}
            >
              <span style={{ color: "var(--ink-2)", display: "grid", placeItems: "center", width: 20, height: 20 }}>
                {r.icon}
              </span>
              <span style={{ flex: 1, fontSize: 12.5, color: "var(--ink-0)" }}>{r.text}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {r.time}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Integration Setup / Manage Modal */}
      {selectedModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "oklch(0 0 0 / 0.4)",
            backdropFilter: "blur(4px)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: 20,
          }}
          onClick={() => setSelectedModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 440,
              background: "var(--paper-0)",
              border: "1px solid var(--paper-3)",
              borderRadius: 16,
              boxShadow: "var(--sh-lift)",
              padding: 24,
              animation: "pop-in 0.2s var(--e-out)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: "var(--paper-2)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {selectedModal.mark}
              </div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-0)" }}>
                  Configure {selectedModal.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {selectedModal.kind} Integration
                </div>
              </div>
            </div>

            <p style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, marginBottom: 16 }}>
              Connect your {selectedModal.name} organization to enable automatic cross-referencing,
              action task syncing, and status updates directly on your Lucent visual boards.
            </p>

            <div style={{ marginBottom: 16 }}>
              <label
                style={{
                  display: "block",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  color: "var(--ink-3)",
                  marginBottom: 6,
                }}
              >
                API Token / Credential Ref
              </label>
              <input
                type="password"
                placeholder="e.g. LINEAR_API_KEY or Bearer token"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--paper-4)",
                  background: "var(--paper-1)",
                  fontSize: 13,
                  color: "var(--ink-0)",
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setSelectedModal(null)}
                style={{
                  padding: "7px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--paper-4)",
                  background: "transparent",
                  color: "var(--ink-1)",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveConnection}
                style={{
                  padding: "7px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: "var(--ink-0)",
                  color: "var(--paper-0)",
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Save &amp; Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </AtelierAppShell>
  );
}

function IntegrationCard({
  item,
  connected,
  onManage,
  onConnect,
}: {
  item: ConnectedItem | AvailableItem;
  connected?: boolean;
  onManage?: () => void;
  onConnect?: () => void;
}) {
  const status = "status" in item ? item.status : undefined;
  const activity = "activity" in item ? item.activity : item.kind;

  return (
    <div
      style={{
        padding: "14px 16px",
        borderRadius: 12,
        background: "var(--paper-0)",
        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        transition: "all 0.15s var(--e-out)",
        boxShadow: "var(--sh-card)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.borderColor = "var(--ink-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.borderColor = "oklch(from var(--paper-4) l c h / 0.5)";
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: "var(--paper-2)",
          display: "grid",
          placeItems: "center",
          color: "var(--ink-1)",
          flexShrink: 0,
        }}
      >
        {item.mark}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-0)" }}>{item.name}</span>
          {connected && (
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: status === "active" ? "var(--moss)" : "var(--ink-3)",
              }}
              title={status}
            />
          )}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-3)",
            marginTop: 2,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {activity}
        </div>
      </div>
      {connected ? (
        <button
          type="button"
          onClick={onManage}
          style={{
            fontSize: 11.5,
            color: "var(--ink-2)",
            padding: "4px 9px",
            borderRadius: 6,
            background: "var(--paper-2)",
            border: "1px solid var(--paper-3)",
            cursor: "pointer",
          }}
        >
          Manage
        </button>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          style={{
            fontSize: 11.5,
            color: "var(--ink-0)",
            padding: "4px 10px",
            borderRadius: 6,
            background: "var(--paper-2)",
            border: "1px solid var(--paper-4)",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Connect
        </button>
      )}
    </div>
  );
}
