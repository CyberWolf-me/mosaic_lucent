import { useState } from "react";
import { useWorkspace, type View } from "../workspace.js";
import { Ico } from "../ui/icons.js";
import {
  AtelierAppShell,
  SectionHeader,
  ApprovalCard,
  type ChangeItem,
} from "../ui/atelierAtoms.js";

interface ProposalReviewItem {
  id: number;
  kind: "decision" | "action" | "risk" | "question" | "edit";
  title: string;
  summary: string;
  from: { icon: React.ReactNode; label: string };
  when: string;
  changes?: ChangeItem[];
  status: "approved" | "rejected" | "edited" | null;
}

export function ReviewQueueView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { setView, proposal, applyProposal, cancelProposal } = useWorkspace();

  const [items, setItems] = useState<ProposalReviewItem[]>([
    {
      id: 1,
      kind: "decision",
      title: "Payment Service goes behind the API gateway",
      summary:
        "Alex proposed placing the new Payment Service inside the existing edge routing rather than as its own external endpoint. Everyone verbally agreed.",
      from: { icon: <Ico.Present />, label: "Checkout design review · 14:32" },
      when: "46m ago",
      status: null,
    },
    {
      id: 2,
      kind: "decision",
      title: "Support Klarna as a payment method at launch",
      summary:
        "John noted that Klarna alone lifted conversion +8% at Northbeam. This SUPERSEDES decision D#42 (Sep 12) which deferred Klarna to Q1 2027.",
      from: { icon: <Ico.Present />, label: "Checkout design review · 14:34" },
      when: "42m ago",
      status: null,
    },
    {
      id: 3,
      kind: "action",
      title: "John: integrate Klarna sandbox in staging by Monday",
      summary: "Direct assignment from the transcript. Creates Linear issue in Payment launch project. P0 priority.",
      from: { icon: <Ico.Present />, label: "Checkout design review · 14:35" },
      when: "41m ago",
      changes: [
        { count: 1, label: "Linear issue created", color: "oklch(0.5 0.14 265)" },
        { count: 1, label: "GitHub milestone updated" },
      ],
      status: null,
    },
    {
      id: 4,
      kind: "risk",
      title: "Stripe 3DS callback validation is untested in staging",
      summary: "Extracted from discussion of the retry policy. Medium severity, medium probability.",
      from: { icon: <Ico.Present />, label: "Checkout design review · 14:38" },
      when: "38m ago",
      status: null,
    },
    {
      id: 5,
      kind: "question",
      title: "Should silent retries surface a message to the user after N attempts?",
      summary: "Unresolved during the meeting. Assigned to Sarah for a UX call before Friday.",
      from: { icon: <Ico.Present />, label: "Checkout design review · 14:40" },
      when: "36m ago",
      status: null,
    },
    {
      id: 6,
      kind: "edit",
      title: "Add Payment Service and Redis Cache to E-commerce architecture",
      summary: "Canvas change: 2 new nodes, 4 new edges, 1 existing node modified (API Gateway routes).",
      from: { icon: <Ico.Layers />, label: "E-commerce platform · canvas" },
      when: "34m ago",
      changes: [
        { count: 2, label: "nodes added", color: "var(--moss)" },
        { count: 4, label: "edges added", color: "var(--moss)" },
        { count: 1, label: "node modified", color: "var(--bloom-2)" },
      ],
      status: null,
    },
  ]);

  const setStatus = (id: number, status: "approved" | "rejected" | "edited" | null) => {
    setItems((curr) => curr.map((x) => (x.id === id ? { ...x, status } : x)));
    if (status === "approved" && proposal) {
      applyProposal();
    } else if (status === "rejected" && proposal) {
      cancelProposal();
    }
  };

  const remaining = items.filter((x) => !x.status).length;

  return (
    <AtelierAppShell
      activeArea="review"
      crumbs={[
        { label: "Personal", view: "home" as View },
        { label: "Review Queue", current: true },
      ]}
      actions={
        <button
          type="button"
          className="btn-atelier primary"
          style={{ height: 32 }}
          onClick={() => setView("canvas")}
        >
          <Ico.Layers /> View Board
        </button>
      }
    >
      <div style={{ padding: "32px 40px 60px", maxWidth: 900, margin: "0 auto" }}>
        <SectionHeader
          eyebrow="Review Queue · Human-Gated AI Actions"
          title="AI proposes; you decide."
          meta={remaining === 0 ? "All caught up" : `${remaining} item${remaining === 1 ? "" : "s"} awaiting approval`}
          actions={
            <>
              <button
                type="button"
                className="btn-atelier ghost"
                style={{ height: 32, fontSize: 12.5 }}
                disabled={!remaining}
                onClick={() => setItems((curr) => curr.map((x) => (x.status ? x : { ...x, status: "rejected" })))}
              >
                Reject all
              </button>
              <button
                type="button"
                className="btn-atelier bloom"
                disabled={!remaining}
                onClick={() => {
                  setItems((curr) => curr.map((x) => (x.status ? x : { ...x, status: "approved" })));
                  if (proposal) applyProposal();
                }}
                style={{ height: 32, fontSize: 12.5, padding: "0 16px" }}
              >
                <Ico.Check /> Approve all
              </button>
            </>
          }
        />

        <div style={{ display: "grid", gap: 14 }}>
          {items.map((card) => {
            if (card.status) {
              const statusColors = {
                approved: { color: "var(--moss)", label: "Approved" },
                rejected: { color: "var(--madder)", label: "Rejected" },
                edited: { color: "var(--saffron)", label: "Editing" },
              }[card.status];

              return (
                <div
                  key={card.id}
                  style={{
                    padding: "12px 16px",
                    borderRadius: 12,
                    background: "oklch(from var(--paper-2) l c h / 0.5)",
                    border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: `oklch(from ${statusColors.color} l c h / 0.15)`,
                      color: statusColors.color,
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                    }}
                  >
                    {statusColors.label}
                  </span>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: "var(--ink-1)" }}>
                    {card.title}
                  </div>
                  <button
                    type="button"
                    onClick={() => setStatus(card.id, null)}
                    className="btn-atelier ghost"
                    style={{ height: 26, padding: "0 8px", fontSize: 11 }}
                  >
                    Undo
                  </button>
                </div>
              );
            }

            return (
              <ApprovalCard
                key={card.id}
                kind={card.kind}
                title={card.title}
                summary={card.summary}
                from={card.from}
                when={card.when}
                changes={card.changes}
                onApprove={() => setStatus(card.id, "approved")}
                onReject={() => setStatus(card.id, "rejected")}
                onEdit={() => setStatus(card.id, "edited")}
              />
            );
          })}

          {remaining === 0 && (
            <div
              style={{
                padding: "36px 24px",
                borderRadius: 16,
                background: "oklch(from var(--moss) l c h / 0.06)",
                border: "1px solid oklch(from var(--moss) l c h / 0.3)",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-serif)",
                  fontSize: 22,
                  color: "var(--ink-0)",
                  marginBottom: 6,
                }}
              >
                <Ico.Check style={{ display: "inline", color: "var(--moss)", marginRight: 6, verticalAlign: -2 }} />
                All proposals reviewed!
              </div>
              <div style={{ fontSize: 13.5, color: "var(--ink-2)", maxWidth: 440, margin: "0 auto 16px" }}>
                All decisions and canvas operations have been settled. Lucent will notify you when new actions require review.
              </div>
              <button
                type="button"
                className="btn-atelier bloom"
                onClick={() => setView("canvas")}
                style={{ height: 34, padding: "0 18px" }}
              >
                Return to Canvas
              </button>
            </div>
          )}
        </div>
      </div>
    </AtelierAppShell>
  );
}
