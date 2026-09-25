import { chartGeometry, type ChartData } from "@lucent/core";

/**
 * Renders a `chart` shape from its data (docs/26 §6.1). The drawn primitives
 * come from core's `chartGeometry` — the same source the SVG export uses — so
 * the canvas and the export never diverge. All text is set as SVG text nodes,
 * never markup. A label the geometry shortened with an ellipsis carries its
 * full text as a hover title, so a capped legend name is still readable.
 */
export function ChartView({
  chart,
  width,
  height,
}: {
  chart: ChartData;
  width: number;
  height: number;
}) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const prims = chartGeometry(chart, w, h);
  return (
    <svg
      className="chart-shape"
      width="100%"
      height="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
    >
      {prims.map((p, i) => {
        switch (p.kind) {
          case "rect":
            return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill={p.fill} />;
          case "line":
            return (
              <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.stroke} strokeWidth={p.width} />
            );
          case "polyline":
            return (
              <polyline
                key={i}
                points={p.points.map(([x, y]) => `${x},${y}`).join(" ")}
                fill="none"
                stroke={p.stroke}
                strokeWidth={p.width}
              />
            );
          case "path":
            return <path key={i} d={p.d} fill={p.fill} />;
          case "text":
            return (
              <text
                key={i}
                x={p.x}
                y={p.y}
                textAnchor={p.anchor}
                fill={p.fill}
                fontSize={p.size}
                fontWeight={p.weight ?? 400}
                fontFamily="sans-serif"
              >
                {p.full !== undefined && <title>{p.full}</title>}
                {p.text}
              </text>
            );
          default:
            return null;
        }
      })}
    </svg>
  );
}
