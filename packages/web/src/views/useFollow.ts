import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Peer, Spotlight, Viewport } from "../boardSync.js";
import type { Camera, ViewportControls } from "../ui/atoms.js";

/**
 * Follow, spotlight and "bring everyone here" on a shared board (docs/28 S5).
 *
 * Every client reports where it's looking — the content point at the centre
 * of its screen and its zoom — so following someone means gliding to their
 * point at their zoom, whatever the size of either window.
 *
 * - **Follow** a person from the presence bar; your view tracks theirs until
 *   you move it yourself (a wheel or a press on the board), which is taking
 *   over.
 * - **Spotlight**: while someone holds it, everyone else follows them. Taking
 *   over steps you out of it; you can step back in.
 * - **Bring everyone here**: one move of everyone else's view to yours, with
 *   a way back for fifteen seconds.
 */

export interface Following {
  userId: string;
  name: string;
  via: "follow" | "spotlight";
}

export function useFollow({
  controls,
  viewportBox,
  zoom,
  peers,
  spotlight,
  lastSummon,
  setPresence,
  meId,
}: {
  controls: MutableRefObject<ViewportControls | null>;
  viewportBox: { x: number; y: number; width: number; height: number } | null;
  zoom: number;
  peers: Peer[];
  spotlight: Spotlight | null;
  lastSummon: { from: Spotlight; viewport: Viewport; at: number } | null;
  setPresence: (update: { viewport?: Viewport | null }) => void;
  meId: string | null;
}) {
  // --- where I'm looking, for anyone following me -----------------------------------
  const here = useRef<Viewport | null>(null);
  useEffect(() => {
    // The box only says the camera moved; the centre comes from the camera
    // itself, since the box leaves the chrome out.
    const center = viewportBox ? controls.current?.centerPoint() : null;
    if (!center) return;
    const next: Viewport = {
      x: Math.round(center.x),
      y: Math.round(center.y),
      zoom: Math.round(zoom),
    };
    const prev = here.current;
    if (prev && prev.x === next.x && prev.y === next.y && prev.zoom === next.zoom) return;
    here.current = next;
    setPresence({ viewport: next });
  }, [viewportBox, zoom, setPresence, controls]);

  // --- following ------------------------------------------------------------------------
  const [following, setFollowing] = useState<Following | null>(null);
  /** The spotlight holder I stepped away from, so their spotlight doesn't pull me back. */
  const [steppedOut, setSteppedOut] = useState<string | null>(null);

  useEffect(() => {
    if (!spotlight) {
      setFollowing((f) => (f?.via === "spotlight" ? null : f));
      setSteppedOut(null);
      return;
    }
    if (spotlight.userId === meId || steppedOut === spotlight.userId) return;
    setFollowing({ userId: spotlight.userId, name: spotlight.name, via: "spotlight" });
  }, [spotlight, meId, steppedOut]);

  const target = following ? peers.find((p) => p.userId === following.userId) : undefined;
  const view = target?.viewport ?? null;
  const applied = useRef("");
  useEffect(() => {
    if (!following) {
      applied.current = "";
      return;
    }
    if (!view) return;
    const key = `${view.x}:${view.y}:${view.zoom}`;
    if (key === applied.current) return;
    applied.current = key;
    controls.current?.focusOn(view.x, view.y, view.zoom);
  }, [following, view, controls]);

  // The person I follow left the board.
  const targetPresent = Boolean(target);
  useEffect(() => {
    if (following && !targetPresent) setFollowing(null);
  }, [following, targetPresent]);

  const follow = useCallback((peer: Pick<Peer, "userId" | "name">) => {
    setFollowing({ userId: peer.userId, name: peer.name, via: "follow" });
  }, []);

  /** Moving the view yourself is taking over. */
  const takeOver = useCallback(() => {
    setFollowing((f) => {
      if (f?.via === "spotlight") setSteppedOut(f.userId);
      return null;
    });
  }, []);

  const rejoinSpotlight = useCallback(() => setSteppedOut(null), []);

  // --- "bring everyone here" -------------------------------------------------------------
  const [summoned, setSummoned] = useState<{ name: string; back: Camera } | null>(null);
  const summonAt = lastSummon?.at;
  useEffect(() => {
    if (!lastSummon || lastSummon.from.userId === meId) return;
    const back = controls.current?.getCamera() ?? null;
    const { x, y, zoom: z } = lastSummon.viewport;
    controls.current?.focusOn(x, y, z);
    if (back) setSummoned({ name: lastSummon.from.name, back });
    const t = window.setTimeout(() => setSummoned(null), 15_000);
    return () => window.clearTimeout(t);
    // Once per summon: `at` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summonAt]);

  const goBack = useCallback(() => {
    if (summoned) controls.current?.setCamera(summoned.back);
    setSummoned(null);
  }, [summoned, controls]);

  return {
    following,
    follow,
    takeOver,
    rejoinSpotlight,
    steppedOut,
    summoned,
    goBack,
    dismissSummon: () => setSummoned(null),
    /** Where I'm looking now — what "bring everyone here" sends. */
    here: () => here.current,
  };
}
