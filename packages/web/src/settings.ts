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
export type Accent = "amber" | "violet" | "cyan" | "rose" | "mono";
export type GridStyle = "dots" | "lines" | "off";
export type Motion = "full" | "reduced";
export type BoardStyle = "clean" | "sketch";
export type ApprovalThreshold = "always" | "large" | "never";

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
}

const LS_KEY = "lucent.settings";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  accent: "amber",
  gridStyle: "dots",
  motion: "full",
  aiSound: true,
  autosave: true,
  activityIndicators: true,
  sttProvider: "browser",
  meetingMode: "intelligence",
  livekitUrl: "",
  livekitTokenUrl: "",
  livekitRoom: "lucent-voice",
  boardStyle: "clean",
  approvalThreshold: "large",
};

type Listener = (s: Settings) => void;

function createStore() {
  let state: Settings = DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
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
