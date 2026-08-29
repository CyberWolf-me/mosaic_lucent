import { useEffect, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";

/**
 * Workshop timer (docs/14 §14). A small floating countdown for brainstorms,
 * sprints, and retros. Pure local UI — no model/state coupling. Presets plus
 * play/pause/reset; flashes when time runs out.
 */
export function TimerWidget({ onClose }: { onClose: () => void }) {
  const [remaining, setRemaining] = useState(5 * 60);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      tickRef.current = setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) {
            setRunning(false);
            setDone(true);
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [running]);

  const set = (mins: number) => {
    setRemaining(mins * 60);
    setDone(false);
    setRunning(false);
  };
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <div className={`timer-widget ${done ? "done" : ""}`}>
      <div className="timer-head">
        <Ico.History /> <span>Timer</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close">
          <Ico.X />
        </button>
      </div>
      <div className="timer-clock">
        {mm}:{ss}
      </div>
      <div className="timer-presets">
        {[1, 5, 10, 15].map((m) => (
          <button key={m} onClick={() => set(m)}>
            {m}m
          </button>
        ))}
      </div>
      <div className="timer-controls">
        <button
          className="timer-play"
          onClick={() => {
            setDone(false);
            setRunning((r) => !r);
          }}
        >
          {running ? "Pause" : "Start"}
        </button>
        <button
          onClick={() => {
            setRunning(false);
            setDone(false);
            setRemaining(5 * 60);
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
