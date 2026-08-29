export type MiniKind = "arch" | "journey" | "seq" | "mind" | "wire" | "flow" | "story";

/** Per-artifact SVG thumbnails, ported from reference/screen_dashboard.jsx. */
export function MiniPreview({ kind, accent }: { kind: MiniKind; accent?: boolean }) {
  const stroke = accent ? "var(--amber-3)" : "var(--stroke-3)";
  const fill = "var(--canvas-2)";

  const box = (x: number, y: number, w = 22, h = 12, key?: string) => (
    <rect
      key={key}
      x={x}
      y={y}
      width={w}
      height={h}
      rx="2"
      fill={fill}
      stroke={stroke}
      strokeWidth="0.6"
    />
  );

  if (kind === "arch") {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        {box(6, 10, 26, 12, "a")}
        {box(40, 10, 26, 12, "b")}
        {box(74, 10, 26, 12, "c")}
        {box(108, 10, 26, 12, "d")}
        {box(40, 36, 26, 12, "e")}
        {box(74, 36, 26, 12, "f")}
        {[
          [32, 16, 40, 16],
          [66, 16, 74, 16],
          [100, 16, 108, 16],
          [53, 22, 53, 36],
          [66, 42, 74, 42],
        ].map((l, i) => (
          <path
            key={i}
            d={`M${l[0]} ${l[1]} L${l[2]} ${l[3]}`}
            stroke={stroke}
            strokeWidth="0.6"
            fill="none"
          />
        ))}
      </svg>
    );
  }
  if (kind === "journey") {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        <path
          d="M8 40 Q40 10, 60 30 T110 20 T150 30"
          stroke={stroke}
          strokeWidth="0.8"
          fill="none"
        />
        {[
          [8, 40],
          [40, 20],
          [70, 32],
          [110, 20],
          [150, 30],
        ].map((p, i) => (
          <circle
            key={i}
            cx={p[0]}
            cy={p[1]}
            r="2.5"
            fill={fill}
            stroke={stroke}
            strokeWidth="0.7"
          />
        ))}
      </svg>
    );
  }
  if (kind === "seq") {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        {[15, 55, 95, 135].map((x, i) => (
          <line
            key={i}
            x1={x}
            y1="8"
            x2={x}
            y2="52"
            stroke={stroke}
            strokeWidth="0.5"
            strokeDasharray="2 2"
          />
        ))}
        {[15, 55, 95, 135].map((x, i) => (
          <rect
            key={`r${i}`}
            x={x - 8}
            y="4"
            width="16"
            height="8"
            rx="1.5"
            fill={fill}
            stroke={stroke}
            strokeWidth="0.6"
          />
        ))}
        {[
          [15, 22, 55],
          [55, 32, 95],
          [95, 42, 135],
          [135, 48, 55],
        ].map(([x1, y, x2], i) => (
          <path
            key={i}
            d={`M${x1} ${y} L${x2} ${y}`}
            stroke={stroke}
            strokeWidth="0.7"
            fill="none"
          />
        ))}
      </svg>
    );
  }
  if (kind === "mind") {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        <circle cx="80" cy="30" r="7" fill={fill} stroke={stroke} strokeWidth="0.8" />
        {[
          [20, 15],
          [20, 45],
          [140, 15],
          [140, 45],
          [80, 5],
          [80, 55],
        ].map((p, i) => (
          <g key={i}>
            <path d={`M80 30 L${p[0]} ${p[1]}`} stroke={stroke} strokeWidth="0.5" fill="none" />
            <circle cx={p[0]} cy={p[1]} r="3" fill={fill} stroke={stroke} strokeWidth="0.6" />
          </g>
        ))}
      </svg>
    );
  }
  if (kind === "wire") {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        <rect
          x="6"
          y="6"
          width="148"
          height="48"
          rx="2"
          fill={fill}
          stroke={stroke}
          strokeWidth="0.6"
        />
        <rect x="6" y="6" width="40" height="48" fill="var(--canvas-3)" opacity="0.6" />
        {[14, 22, 30, 38].map((y, i) => (
          <rect key={i} x="10" y={y} width="30" height="3" rx="1" fill={stroke} opacity="0.4" />
        ))}
        {[
          [52, 14],
          [92, 14],
          [52, 30],
          [92, 30],
        ].map(([x, y], i) => (
          <rect
            key={`c${i}`}
            x={x}
            y={y}
            width="34"
            height="10"
            rx="1.5"
            fill="none"
            stroke={stroke}
            strokeWidth="0.5"
          />
        ))}
      </svg>
    );
  }
  if (kind === "flow") {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        {box(6, 24, 22, 12, "a")}
        <polygon points="45,24 60,30 45,36 30,30" fill={fill} stroke={stroke} strokeWidth="0.6" />
        {box(66, 24, 22, 12, "b")}
        {box(66, 4, 22, 12, "c")}
        {box(100, 24, 22, 12, "d")}
        {[
          [28, 30, 30, 30],
          [60, 30, 66, 30],
          [77, 4, 77, 24],
          [88, 30, 100, 30],
        ].map((l, i) => (
          <path
            key={i}
            d={`M${l[0]} ${l[1]} L${l[2]} ${l[3]}`}
            stroke={stroke}
            strokeWidth="0.6"
            fill="none"
          />
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 160 60" width="100%" height="100%">
      {[10, 40, 70, 100, 130].map((x, i) => (
        <g key={i}>
          {box(x, 6, 22, 8, `t${i}`)}
          {box(x, 20, 22, 8, `s${i}`)}
          {box(x, 34, 22, 8, `s2${i}`)}
        </g>
      ))}
    </svg>
  );
}
