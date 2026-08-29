import type { Operation, Workspace } from "@lucent/core";

/**
 * Inspector for a selected connector (ShapeLink): switch routing variant
 * (straight / elbow / curved), toggle a double arrowhead, or delete it. Each
 * change is an UPDATE_LINK / DISCONNECT_SHAPES operation (docs/14 connectors).
 */
export function LinkInspector({
  workspace,
  linkId,
  onApply,
  onClear,
}: {
  workspace: Workspace;
  linkId: string;
  onApply: (ops: Operation[], label: string) => void;
  onClear: () => void;
}) {
  const link = workspace.shapeLinks[linkId];
  if (!link) return null;
  const variant = link.variant ?? "curved";

  const setVariant = (v: "straight" | "elbow" | "curved") =>
    onApply([{ op: "UPDATE_LINK", id: linkId, variant: v }], "Change connector style");

  const toggleDouble = () =>
    onApply(
      [{ op: "UPDATE_LINK", id: linkId, doubleArrow: !link.doubleArrow }],
      "Toggle double arrow",
    );

  const remove = () => {
    onApply([{ op: "DISCONNECT_SHAPES", id: linkId }], "Delete connector");
    onClear();
  };

  return (
    <div className="shape-inspector">
      <div className="insp-label">Connector</div>
      <div className="insp-group">
        <span className="insp-cap">Routing</span>
        <div className="segmented">
          {(["straight", "elbow", "curved"] as const).map((v) => (
            <button
              key={v}
              className={variant === v ? "active" : ""}
              onClick={() => setVariant(v)}
              style={{ textTransform: "capitalize" }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="insp-sep" />
      <button className="insp-btn" onClick={toggleDouble}>
        {link.doubleArrow ? "Single arrow" : "Double arrow"}
      </button>
      <button className="insp-btn" onClick={remove}>
        Delete
      </button>
    </div>
  );
}
