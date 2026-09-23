import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSettings } from "../settings.js";

export interface TweaksState {
  theme: "light" | "dark";
  accent: "bloom" | "madder" | "moss" | "saffron" | "graphite";
  density: "compact" | "regular" | "cozy";
  radius: "sharp" | "soft" | "pillowy";
  grain: boolean;
}

const TWEAKS_STORAGE_KEY = "lucent.v2.tweaks";

export const DEFAULT_TWEAKS: TweaksState = {
  theme: "light",
  accent: "bloom",
  density: "regular",
  radius: "soft",
  grain: true,
};

export function useTweaks(): [TweaksState, <K extends keyof TweaksState>(key: K, val: TweaksState[K]) => void] {
  const [settings, setSettings] = useSettings();
  const [tweaks, setTweaksState] = useState<TweaksState>(() => {
    try {
      const raw = localStorage.getItem(TWEAKS_STORAGE_KEY);
      if (raw) {
        return { ...DEFAULT_TWEAKS, ...JSON.parse(raw) };
      }
    } catch {}
    return DEFAULT_TWEAKS;
  });

  const setTweak = useCallback(<K extends keyof TweaksState>(key: K, val: TweaksState[K]) => {
    setTweaksState((prev) => {
      const next = { ...prev, [key]: val };
      try {
        localStorage.setItem(TWEAKS_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

    // Also synchronize theme and accent with global settings
    if (key === "theme") {
      setSettings({ theme: val as "light" | "dark" });
    } else if (key === "accent") {
      setSettings({ accent: val as any });
    }
  }, [setSettings]);

  // Apply tweaks to DOM
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", tweaks.theme);
    if (tweaks.accent && tweaks.accent !== "bloom") {
      root.setAttribute("data-accent", tweaks.accent);
    } else {
      root.removeAttribute("data-accent");
    }

    if (tweaks.density !== "regular") {
      root.setAttribute("data-density", tweaks.density);
    } else {
      root.removeAttribute("data-density");
    }

    if (tweaks.radius !== "soft") {
      root.setAttribute("data-radius", tweaks.radius);
    } else {
      root.removeAttribute("data-radius");
    }

    root.style.setProperty("--grain-opacity", tweaks.grain ? "0.4" : "0");
  }, [tweaks]);

  return [tweaks, setTweak];
}

export function TweaksPanel({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (o: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const [tweaks, setTweak] = useTweaks();

  const accents: Array<{ value: TweaksState["accent"]; color: string; label: string }> = [
    { value: "bloom", color: "oklch(0.48 0.22 260)", label: "Bloom" },
    { value: "madder", color: "oklch(0.55 0.22 20)", label: "Madder" },
    { value: "moss", color: "oklch(0.52 0.16 148)", label: "Moss" },
    { value: "saffron", color: "oklch(0.68 0.17 68)", label: "Saffron" },
    { value: "graphite", color: "oklch(0.42 0.010 60)", label: "Graphite" },
  ];

  if (!open) return null;

  return (
    <aside
      aria-label="Tweaks Panel"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 200,
        width: 280,
        maxHeight: "calc(100vh - 32px)",
        display: "flex",
        flexDirection: "column",
        background: "rgba(250, 249, 247, 0.92)",
        color: "var(--ink-0)",
        backdropFilter: "blur(24px) saturate(160%)",
        WebkitBackdropFilter: "blur(24px) saturate(160%)",
        border: "0.5px solid rgba(255, 255, 255, 0.6)",
        borderRadius: 14,
        boxShadow: "0 1px 0 rgba(255, 255, 255, 0.5) inset, 0 12px 40px rgba(0, 0, 0, 0.18)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px 10px 14px",
          borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <b style={{ fontSize: 12.5, fontWeight: 600 }}>Tweaks</b>
          <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            ⌘/
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{
            appearance: "none",
            border: 0,
            background: "transparent",
            color: "var(--ink-2)",
            width: 22,
            height: 22,
            borderRadius: 6,
            cursor: "pointer",
            display: "grid",
            placeItems: "center",
          }}
          title="Close tweaks"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
          overflowY: "auto",
        }}
      >
        {/* Theme Section */}
        <div>
          <div
            className="mono-caps"
            style={{ fontSize: 10, marginBottom: 6, color: "var(--ink-3)" }}
          >
            Theme
          </div>
          <div
            style={{
              display: "flex",
              padding: 2,
              borderRadius: 8,
              background: "rgba(0,0,0,0.06)",
              gap: 2,
            }}
          >
            {[
              { value: "light", label: "Paper" },
              { value: "dark", label: "Charcoal" },
            ].map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTweak("theme", t.value as any)}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: 0,
                  fontSize: 11.5,
                  fontWeight: tweaks.theme === t.value ? 600 : 400,
                  background: tweaks.theme === t.value ? "white" : "transparent",
                  color: tweaks.theme === t.value ? "var(--ink-0)" : "var(--ink-2)",
                  boxShadow: tweaks.theme === t.value ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
                  cursor: "pointer",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Accent Section */}
        <div>
          <div
            className="mono-caps"
            style={{ fontSize: 10, marginBottom: 6, color: "var(--ink-3)" }}
          >
            Accent
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {accents.map((a) => {
              const active = tweaks.accent === a.value;
              return (
                <button
                  key={a.value}
                  type="button"
                  onClick={() => setTweak("accent", a.value)}
                  title={a.label}
                  style={{
                    flex: 1,
                    height: 28,
                    borderRadius: 6,
                    border: active ? "2px solid var(--ink-0)" : "1px solid rgba(0,0,0,0.12)",
                    background: a.color,
                    cursor: "pointer",
                    boxShadow: active ? "0 0 0 1px white inset" : "none",
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* Density Section */}
        <div>
          <div
            className="mono-caps"
            style={{ fontSize: 10, marginBottom: 6, color: "var(--ink-3)" }}
          >
            Density
          </div>
          <div
            style={{
              display: "flex",
              padding: 2,
              borderRadius: 8,
              background: "rgba(0,0,0,0.06)",
              gap: 2,
            }}
          >
            {["compact", "regular", "cozy"].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setTweak("density", d as any)}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: 0,
                  fontSize: 11,
                  textTransform: "capitalize",
                  fontWeight: tweaks.density === d ? 600 : 400,
                  background: tweaks.density === d ? "white" : "transparent",
                  color: tweaks.density === d ? "var(--ink-0)" : "var(--ink-2)",
                  boxShadow: tweaks.density === d ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
                  cursor: "pointer",
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Radius Section */}
        <div>
          <div
            className="mono-caps"
            style={{ fontSize: 10, marginBottom: 6, color: "var(--ink-3)" }}
          >
            Radius
          </div>
          <div
            style={{
              display: "flex",
              padding: 2,
              borderRadius: 8,
              background: "rgba(0,0,0,0.06)",
              gap: 2,
            }}
          >
            {["sharp", "soft", "pillowy"].map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setTweak("radius", r as any)}
                style={{
                  flex: 1,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: 0,
                  fontSize: 11,
                  textTransform: "capitalize",
                  fontWeight: tweaks.radius === r ? 600 : 400,
                  background: tweaks.radius === r ? "white" : "transparent",
                  color: tweaks.radius === r ? "var(--ink-0)" : "var(--ink-2)",
                  boxShadow: tweaks.radius === r ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
                  cursor: "pointer",
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Paper Grain Toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 4,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-1)" }}>Paper grain</span>
          <button
            type="button"
            onClick={() => setTweak("grain", !tweaks.grain)}
            style={{
              position: "relative",
              width: 34,
              height: 20,
              borderRadius: 999,
              background: tweaks.grain ? "var(--bloom-2)" : "rgba(0,0,0,0.15)",
              border: 0,
              cursor: "pointer",
              transition: "background 0.15s",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 2,
                left: tweaks.grain ? 16 : 2,
                width: 16,
                height: 16,
                borderRadius: 999,
                background: "white",
                boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                transition: "left 0.15s",
              }}
            />
          </button>
        </div>
      </div>
    </aside>
  );
}
