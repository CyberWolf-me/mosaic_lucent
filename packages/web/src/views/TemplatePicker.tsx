import { useCallback, useEffect, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";
import { TEMPLATES } from "../templates.js";
import { useWorkspace, type View } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { fetchOrgs, preferredOrg } from "../billing.js";
import { getOrgTemplate, listOrgTemplates, type OrgTemplate } from "../teamTemplates.js";
import { resolveLocale, t, type Locale } from "@lucent/i18n";

/** Template gallery. Applies a freshly built operation batch through the engine
 * (docs/14 §9) — commits to history, fully undoable, just like an AI response.
 *
 * Two sources render through one component: the bundled local `TEMPLATES` and
 * the active org's team library fetched live from `/api/orgs/:id/templates`.
 * A "Source" picker ("Built-in" / "Team") sits above the kind filter so a
 * contributor can find the diagram the team saved last week in two clicks.
 */
export function TemplatePicker({ onClose }: { onClose: () => void }) {
  const { applyManual, setView } = useWorkspace();
  const { notify } = useToast();
  const [filter, setFilter] = useState("All");
  const [source, setSource] = useState<"builtin" | "team">("builtin");
  const [team, setTeam] = useState<OrgTemplate[] | null>(null);
  const [teamLoadFailed, setTeamLoadFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

  const handleClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(onClose, 140);
  }, [closing, onClose]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // Fetch the active org's templates once on mount. The list is short enough
  // that re-rendering on every selection change would be wasted work; the
  // owner can save a new template and it appears on the next picker open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchOrgs();
      if (cancelled) return;
      if (result.kind !== "ok") {
        setTeamLoadFailed(true);
        return;
      }
      const org = preferredOrg(result.orgs);
      if (org === null) {
        setTeamLoadFailed(true);
        return;
      }
      const list = await listOrgTemplates(org.id);
      if (cancelled) return;
      if (list === null) {
        setTeamLoadFailed(true);
        return;
      }
      setTeam(list);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const kinds =
    source === "builtin"
      ? ["All", ...Array.from(new Set(TEMPLATES.map((t) => t.kind)))]
      : team === null
        ? ["All"]
        : ["All", ...Array.from(new Set(team.map((t) => t.kind)))];

  const use = (id: string) => {
    if (source === "builtin") {
      const t = TEMPLATES.find((x) => x.id === id);
      if (!t) return;
      return applyBatch(t.build(), t.name, notify, applyManual, setView, handleClose);
    }
    if (team === null) return;
    void applyTeamTemplate(id, team, applyManual, notify, setView, handleClose);
    return;
  };

  return (
    <>
      <div className={`modal-scrim ${closing ? "closing" : ""}`} onClick={handleClose} />
      <div
        className={`template-modal ${closing ? "closing" : ""}`}
        role="dialog"
        aria-label="Templates"
      >
        <div className="tpl-head">
          <div style={{ fontSize: 15, fontVariationSettings: "'wght' 560" }}>Templates</div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={handleClose}>
            <Ico.X />
          </button>
        </div>
        <div className="tpl-filters">
          {(["builtin", "team"] as const).map((s) => (
            <button
              key={s}
              className={`tpl-chip ${source === s ? "active" : ""}`}
              onClick={() => {
                setSource(s);
                setFilter("All");
              }}
            >
              {s === "builtin" ? "Built-in" : "Team"}
            </button>
          ))}
          {kinds.map((k) => (
            <button
              key={k}
              className={`tpl-chip ${filter === k ? "active" : ""}`}
              onClick={() => setFilter(k)}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="tpl-grid">
          {source === "builtin" ? (
            (filter === "All" ? TEMPLATES : TEMPLATES.filter((t) => t.kind === filter)).map((t) => (
              <button key={t.id} className="tpl-card" onClick={() => use(t.id)}>
                <div className="tpl-thumb">
                  <Ico.Grid />
                </div>
                <div className="tpl-name">{t.name}</div>
                <div className="tpl-kind mono">{t.kind}</div>
              </button>
            ))
          ) : teamLoadFailed ? (
            <div className="tpl-empty">Team templates are unavailable right now.</div>
          ) : team === null ? (
            <div className="tpl-empty">Loading team templates…</div>
          ) : team.length === 0 ? (
            <div className="tpl-empty">No team templates yet. Save one from a finished board.</div>
          ) : (
            (filter === "All" ? team : team.filter((t) => t.kind === filter)).map((t) => (
              <button key={t.id} className="tpl-card" onClick={() => use(t.id)}>
                <div className="tpl-thumb">
                  <Ico.Grid />
                </div>
                <div className="tpl-name">{t.name}</div>
                <div className="tpl-kind mono">{t.kind}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function applyBatch(
  ops: import("@lucent/core").Operation[],
  name: string,
  notify: (msg: string) => void,
  applyManual: (ops: import("@lucent/core").Operation[], label: string) => boolean,
  setView: (v: View) => void,
  onClose: () => void,
): void {
  // The label rides history, not the toast: history entries are read later
  // by the person who made them, so the label stays English ("Insert
  // template: X") — the product's history timeline is a log, and logs are
  // not translated. The toast is read now, so it is.
  const applied = applyManual(ops, `Insert template: ${name}`);
  const loc = activeLocale();
  if (applied) {
    notify(t("toast.inserted", loc, { name }));
    setView("canvas");
    onClose();
    return;
  }
  notify(t("toast.insert.conflict", loc, { name }));
}

async function applyTeamTemplate(
  templateId: string,
  team: OrgTemplate[],
  applyManual: (ops: import("@lucent/core").Operation[], label: string) => boolean,
  notify: (msg: string) => void,
  setView: (v: View) => void,
  onClose: () => void,
): Promise<void> {
  const card = team.find((t) => t.id === templateId);
  if (!card) return;
  const orgId = card.orgId;
  const detail = await getOrgTemplate(orgId, templateId);
  if (!detail) {
    notify(`Couldn't insert ${card.name} — it was removed.`);
    return;
  }
  applyBatch(detail.ops, card.name, notify, applyManual, setView, onClose);
}

/** Same negotiation rule as AuthView's `locale()`; one definition per file is cheaper than a context. */
function activeLocale(): Locale {
  return resolveLocale(
    typeof navigator === "undefined" ? null : (navigator.languages?.[0] ?? navigator.language),
  );
}
