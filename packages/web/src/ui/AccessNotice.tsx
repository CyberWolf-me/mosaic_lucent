import { useEffect, useState } from "react";
import { hasSession } from "../session.js";
import { loadAccess, type BlockedWorkspace } from "../security.js";
import { requestSettings } from "./Chrome.js";
import { Ico } from "./icons.js";
import { Button } from "./kit.js";

/**
 * The workspaces closed to you right now, and what opens them (docs/26 A6).
 * A workspace that requires two-step verification keeps its boards from
 * anyone without it; without this, they'd simply be missing, and a guest's
 * link would answer "not found" with no reason.
 */
export function AccessNotice() {
  const [blocked, setBlocked] = useState<BlockedWorkspace[]>([]);
  useEffect(() => {
    if (!hasSession()) return;
    let cancelled = false;
    void loadAccess().then((list) => {
      if (!cancelled && list) setBlocked(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (blocked.length === 0) return null;
  const names = blocked.map((b) => b.orgName);
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    <div className="access-notice" role="status">
      <Ico.Lock className="access-notice-glyph" aria-hidden />
      <p>
        <strong>{who}</strong> {names.length === 1 ? "requires" : "require"} two-step verification.{" "}
        {names.length === 1 ? "Its boards stay" : "Their boards stay"} closed to you until you turn
        it on.
      </p>
      <Button variant="primary" size="sm" onClick={() => requestSettings("security")}>
        Set it up
      </Button>
    </div>
  );
}
