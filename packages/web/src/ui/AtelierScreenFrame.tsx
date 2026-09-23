import { useEffect, useRef } from "react";
import { useWorkspace, type View } from "../workspace.js";
import { SCREEN_BY_KEY, SCREEN_BY_ID, SCREENS } from "./ScreenSwitcher.js";

export function AtelierScreenFrame({ screenKey }: { screenKey: string }) {
  const { setView } = useWorkspace();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const screen = SCREEN_BY_KEY[screenKey] || SCREEN_BY_ID[11] || SCREENS[2];
  const screenId = screen?.id ?? 11;

  // Stable initial source: only set once on mount so iframe never reloads on screen change!
  const initialSrc = useRef(`/v2.html?screen=${screenId}`).current;
  const lastSentId = useRef<number | null>(null);
  const lastReceivedId = useRef<number | null>(null);

  // Send screen change to iframe via postMessage without reloading the iframe
  useEffect(() => {
    if (lastReceivedId.current === screenId) {
      // Screen change originated from the iframe itself; don't echo back
      return;
    }
    lastSentId.current = screenId;
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: "lucent:set-screen", id: screenId, key: screenKey },
        "*",
      );
    }
  }, [screenId, screenKey]);

  // Handle screen changes originating inside the iframe
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === "lucent:v2-screen" && e.data.key) {
        if (e.data.id === lastSentId.current) {
          // Acknowledgment of message we just sent; ignore
          return;
        }
        lastReceivedId.current = e.data.id;
        if (e.data.key !== screenKey) {
          setView(e.data.key as View);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [screenKey, setView]);

  const handleLoad = () => {
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: "lucent:set-screen", id: screenId, key: screenKey },
        "*",
      );
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", zIndex: 1 }}>
      <iframe
        ref={iframeRef}
        src={initialSrc}
        onLoad={handleLoad}
        title={`Lucent Atelier · ${screen?.label || screenKey}`}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          display: "block",
          background: "transparent",
        }}
      />
    </div>
  );
}
