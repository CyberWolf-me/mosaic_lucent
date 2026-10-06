import { useEffect, useState } from "react";
import type { SttProviderId } from "./stt/index.js";
import type { MeetingMode } from "./meeting-modes.js";

export type { SttProviderId };
export type { MeetingMode };

/**
 * Global settings store persisted to localStorage, ported from the reference
 * prototype (reference/components/settings.jsx). Drives theme + accent on
 * <html>. A tiny pub/sub store keeps it framework-light; useSettings subscribes.
 */

export type Theme = "dark" | "light" | "system";
/**
 * The Atelier accent axis. Each value re-points --bloom-* in atelier.css so the
 * whole app recolors as one system. The pre-redesign set (amber/violet/cyan/
 * rose/mono) is retired; stale stored values are coerced to "bloom" on load.
 */
export type Accent = "bloom" | "madder" | "moss" | "saffron" | "graphite";
const ACCENTS: readonly Accent[] = ["bloom", "madder", "moss", "saffron", "graphite"];
export type GridStyle = "dots" | "lines" | "off";
export type Motion = "full" | "reduced";
export type BoardStyle = "clean" | "sketch";
export type ApprovalThreshold = "always" | "large" | "never";
export type ModelTier = "fast" | "balanced" | "reasoning";

export interface Settings {
  theme: Theme;
  accent: Accent;
  gridStyle: GridStyle;
  motion: Motion;
  aiSound: boolean;
  autosave: boolean;
  activityIndicators: boolean;
  /** Which speech-to-text engine the mic uses (docs/06). */
  sttProvider: SttProviderId;
  /** Meeting behavior profile (docs/24 Phase D). Validated at the use site. */
  meetingMode: MeetingMode;
  /** LiveKit room URL (wss://…). Empty means LiveKit is not configured. */
  livekitUrl: string;
  /**
   * Endpoint that mints a short-lived LiveKit access token. The browser must
   * never hold a LiveKit API secret, so this points at your own server.
   */
  livekitTokenUrl: string;
  /** Room to join for transcription. */
  livekitRoom: string;
  /** Clean (Miro/FigJam) vs. Sketch (Excalidraw hand-drawn) rendering (docs/14 §23). */
  boardStyle: BoardStyle;
  /** When the AI must ask before applying changes (UX-1). */
  approvalThreshold: ApprovalThreshold;
  /** Opt-in experimental ELK layout engine for orthogonal layered graphs. Default false. */
  elkLayout: boolean;
  /** AI model performance / reasoning tier: fast (flash), balanced, or reasoning (deep thinking). */
  modelTier: ModelTier;
}

const LS_KEY = "lucent.settings";
const MIGRATION_KEY = "lucent.v2.theme_init";

export const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  accent: "bloom",
  gridStyle: "dots",
  motion: "full",
  aiSound: false,
  autosave: true,
  activityIndicators: true,
  sttProvider: "browser",
  meetingMode: "assistant",
  // Empty by default: the server's token endpoint returns the room URL
  // (LUCENT_LIVEKIT_URL), so voice is zero-config. A value here is only for
  // bringing your own LiveKit (Settings → Advanced).
  livekitUrl: "",
  livekitTokenUrl: "/api/livekit/token",
  livekitRoom: "lucent-voice",
  boardStyle: "clean",
  approvalThreshold: "large",
  elkLayout: false,
  modelTier: "balanced",
};

type Listener = (s: Settings) => void;

function createStore() {
  let state: Settings = DEFAULT_SETTINGS;
  try {
    const migrated = localStorage.getItem(MIGRATION_KEY);
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      // One-time move onto Atelier's paper default — but only for settings
      // that are still the old factory defaults (dark theme + the retired
      // amber accent). The old store saved the whole object on any change, so
      // "dark" is usually the default rather than a choice; a user who picked
      // light, system, or a different accent keeps exactly what they chose.
      if (!migrated) {
        if (parsed.theme === "dark" && (parsed.accent as string | undefined) === "amber") {
          parsed.theme = "light";
          parsed.accent = "bloom";
          localStorage.setItem(LS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, ...parsed }));
        }
        localStorage.setItem(MIGRATION_KEY, "true");
      }
      state = { ...DEFAULT_SETTINGS, ...parsed };
      // A retired accent (amber/violet/cyan/rose/mono) stored before the Atelier
      // consolidation would set data-accent to a value no CSS block matches,
      // leaving the app on cobalt with a dead swatch — coerce it back to bloom.
      if (!ACCENTS.includes(state.accent)) state.accent = "bloom";
      // The token endpoint must stay set (it's how voice reaches the server);
      // the room URL is intentionally allowed to be empty — the server supplies
      // it, and only a bring-your-own-LiveKit user fills it in.
      if (!state.livekitTokenUrl?.trim()) state.livekitTokenUrl = DEFAULT_SETTINGS.livekitTokenUrl;
    } else if (!migrated) {
      localStorage.setItem(MIGRATION_KEY, "true");
    }
  } catch {
    /* ignore */
  }
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set: (patch: Partial<Settings>) => {
      state = { ...state, ...patch };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
      } catch {
        /* ignore */
      }
      listeners.forEach((fn) => fn(state));
    },
    subscribe: (fn: Listener) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export const settingsStore = createStore();

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings>(settingsStore.get());
  useEffect(() => settingsStore.subscribe(setS), []);
  return [s, settingsStore.set];
}

/** Applies theme + accent + grid style to <html> whenever settings change. */
export function ThemeRoot() {
  const [s] = useSettings();
  useEffect(() => {
    const html = document.documentElement;
    const resolved =
      s.theme === "system"
        ? window.matchMedia?.("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : s.theme;
    html.setAttribute("data-theme", resolved);
    html.setAttribute("data-accent", s.accent);
    html.setAttribute("data-motion", s.motion);
    html.setAttribute("data-board", s.boardStyle);
    // The grid selector used to change nothing because this attribute was never
    // written and no CSS read it.
    html.setAttribute("data-grid", s.gridStyle);
    html.style.setProperty("--transition-motion", s.motion === "reduced" ? "0.001s" : "");
  }, [s.theme, s.accent, s.motion, s.boardStyle, s.gridStyle]);
  return null;
}
