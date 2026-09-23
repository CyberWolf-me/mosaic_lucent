import { AtelierAppShell } from "../ui/atelierAtoms.js";
import { useWorkspace, type View } from "../workspace.js";
import { Ico } from "../ui/icons.js";

/**
 * Screen 00 — Design system (living style guide).
 *
 * Native React port replacing the embedded v2 prototype iframe. A focused,
 * token-driven reference: palette, type scale, radii, elevation, core
 * components, and principles. Everything reads the same CSS variables the app
 * ships, so it stays honest as the tokens evolve.
 */

const PAPER = ["--paper-0", "--paper-1", "--paper-2", "--paper-3", "--paper-4", "--paper-edge"];
const INK = ["--ink-0", "--ink-1", "--ink-2", "--ink-3", "--ink-4"];
const BLOOM = ["--bloom-1", "--bloom-2", "--bloom-3"];
const SEMANTIC = ["--madder", "--moss", "--saffron", "--graphite"];
const RADII: Array<[string, string]> = [
  ["--r-xs", "6"],
  ["--r-sm", "10"],
  ["--r-md", "14"],
  ["--r-lg", "18"],
  ["--r-xl", "24"],
  ["--r-2xl", "32"],
];
const SHADOWS = ["--shadow-1", "--shadow-2", "--shadow-3"];

function Swatch({ token, dark }: { token: string; dark?: boolean }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          height: 56,
          borderRadius: "var(--r-sm)",
          background: `var(${token})`,
          border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
          boxShadow: "var(--shadow-1)",
        }}
      />
      <div className="mono" style={{ fontSize: 10, color: dark ? "var(--ink-2)" : "var(--ink-3)", marginTop: 6, letterSpacing: "0.02em" }}>
        {token.replace("--", "")}
      </div>
    </div>
  );
}

export function DesignSystemView({ onOpenSettings }: { onOpenSettings?: (section?: string) => void }) {
  const { setView } = useWorkspace() as unknown as { setView: (v: View) => void };
  return (
    <AtelierAppShell
      activeArea="system"
      crumbs={[{ label: "Product · Design system", current: true }]}
      onOpenSettings={onOpenSettings}
      actions={
        <button className="icon-btn" onClick={() => setView("ia" as View)}>
          <Ico.Book /> Information architecture
        </button>
      }
    >
      <div className="ds-content">
        <div className="ds-hero">
          <div className="ds-eyebrow">Design system · Atelier · paper + bloom</div>
          <div className="ds-h1">
            The materials of a <em>drafting table.</em>
          </div>
          <div className="ds-lede">
            Warm paper, espresso ink, and a single fountain-pen cobalt "bloom" for everything the AI
            touches. These are the exact tokens the app renders — this page is a mirror, not a mockup.
          </div>
        </div>

        {/* Palette */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-num">01</span>
            <h2 className="ds-h2">Palette</h2>
          </div>
          <div className="mono-caps" style={{ marginBottom: 10 }}>Paper</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 22 }}>
            {PAPER.map((t) => <Swatch key={t} token={t} />)}
          </div>
          <div className="mono-caps" style={{ marginBottom: 10 }}>Ink</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 22 }}>
            {INK.map((t) => <Swatch key={t} token={t} />)}
          </div>
          <div className="mono-caps" style={{ marginBottom: 10 }}>Bloom · signature accent</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 22 }}>
            {BLOOM.map((t) => <Swatch key={t} token={t} />)}
          </div>
          <div className="mono-caps" style={{ marginBottom: 10 }}>Semantic</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
            {SEMANTIC.map((t) => <Swatch key={t} token={t} />)}
          </div>
        </div>

        {/* Typography */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-num">02</span>
            <h2 className="ds-h2">Typography</h2>
          </div>
          <div style={{ display: "grid", gap: 18 }}>
            <div>
              <div className="mono-caps" style={{ marginBottom: 6, color: "var(--ink-3)" }}>Serif · display — IBM Plex Serif</div>
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 40, letterSpacing: "-0.025em", color: "var(--ink-0)" }}>
                Good morning, Alex.
              </div>
              <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 17, color: "var(--ink-2)", marginTop: 4 }}>
                You have a meeting in 46 minutes and 3 things waiting for review.
              </div>
            </div>
            <div>
              <div className="mono-caps" style={{ marginBottom: 6, color: "var(--ink-3)" }}>Sans · body — IBM Plex Sans</div>
              <div style={{ fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--ink-1)", lineHeight: 1.6, maxWidth: 560 }}>
                The board is always the primary surface. Meetings, intelligence, and execution layer
                on top of it — never off to the side.
              </div>
            </div>
            <div>
              <div className="mono-caps" style={{ marginBottom: 6, color: "var(--ink-3)" }}>Mono · labels — IBM Plex Mono</div>
              <div className="mono" style={{ fontSize: 13, color: "var(--ink-1)", letterSpacing: "0.03em" }}>
                DECISION · D#67 · 14:32 · 0.94 conf
              </div>
            </div>
          </div>
        </div>

        {/* Radii */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-num">03</span>
            <h2 className="ds-h2">Radii</h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12 }}>
            {RADII.map(([t, px]) => (
              <div key={t} style={{ textAlign: "center" }}>
                <div style={{ height: 56, borderRadius: `var(${t})`, background: "var(--bloom-wash)", border: "1px solid var(--bloom-wash-2)" }} />
                <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 6 }}>
                  {t.replace("--", "")} · {px}px
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Elevation */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-num">04</span>
            <h2 className="ds-h2">Elevation</h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
            {SHADOWS.map((t) => (
              <div key={t} style={{ height: 88, borderRadius: "var(--r-md)", background: "var(--paper-0)", boxShadow: `var(${t})`, display: "grid", placeItems: "center" }}>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{t.replace("--", "")}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Components */}
        <div className="ds-section">
          <div className="ds-section-head">
            <span className="ds-section-num">05</span>
            <h2 className="ds-h2">Components</h2>
          </div>
          <div className="mono-caps" style={{ marginBottom: 10 }}>Buttons</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 22 }}>
            <button className="btn bloom">Apply on board</button>
            <button className="btn ghost">Discard</button>
            <button className="icon-btn"><Ico.Plus /> New</button>
            <button className="icon-btn primary"><Ico.Sparkle /> Ask Lucent</button>
          </div>
          <div className="mono-caps" style={{ marginBottom: 10 }}>Chips &amp; badges</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "var(--bloom-2)", color: "white", fontWeight: 700 }}>ADD</span>
            <span className="mono" style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "var(--bloom-wash)", color: "var(--bloom-2)", fontWeight: 600 }}>NEW</span>
            <span className="mono" style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "oklch(from var(--moss) l c h / 0.16)", color: "var(--moss)", fontWeight: 600 }}>APPROVED</span>
            <span className="mono" style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "oklch(from var(--madder) l c h / 0.14)", color: "var(--madder)", fontWeight: 600 }}>BLOCKED</span>
            <span className="mono" style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "oklch(from var(--saffron) l c h / 0.2)", color: "oklch(0.45 0.12 78)", fontWeight: 600 }}>REVIEW</span>
          </div>
        </div>

        {/* Principles */}
        <div className="ds-section" style={{ borderBottom: 0 }}>
          <div className="ds-section-head">
            <span className="ds-section-num">06</span>
            <h2 className="ds-h2">Principles</h2>
          </div>
          <div className="ds-grid ds-grid-2" style={{ gap: 20 }}>
            {[
              { t: "Paper, not glass", b: "Warm cream surfaces with a soft grain. Depth comes from cast shadow, not translucency." },
              { t: "One accent", b: "Cobalt bloom marks everything the AI touches. Everything else stays near-neutral ink." },
              { t: "Drafted corners", b: "Soft, variable radii read as hand-drawn rather than pillowy or sharp-CAD." },
              { t: "Mono for meaning", b: "Monospace labels carry provenance — IDs, timestamps, confidence, kinds." },
            ].map((p) => (
              <div key={p.t} className="ds-card" style={{ padding: 22 }}>
                <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 6, letterSpacing: "-0.01em" }}>{p.t}</div>
                <div style={{ fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55 }}>{p.b}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AtelierAppShell>
  );
}
