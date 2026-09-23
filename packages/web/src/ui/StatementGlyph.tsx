import type { StatementFields } from "@lucent/core";
import { KIND_TINT } from "../statementUi.js";

/**
 * The statement kinds as marks, not emoji. Each is legible at 10px, reads in
 * both themes, and takes its colour from the kind's token (KIND_TINT), so a
 * decision is a cobalt diamond on the canvas, in Intelligence, in a meeting
 * brief and on Home alike.
 */
export function StatementGlyph({
  kind,
  size = 12,
  tinted = true,
}: {
  kind: StatementFields["kind"];
  size?: number;
  /** false: inherit `currentColor` (for use on a filled chip). */
  tinted?: boolean;
}) {
  const color = tinted ? KIND_TINT[kind] : "currentColor";
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: color,
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    style: { flexShrink: 0 },
  };
  switch (kind) {
    case "decision":
      // Settled: a solid diamond.
      return (
        <svg {...common}>
          <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" fill={color} />
        </svg>
      );
    case "proposal":
      // Not yet decided: the same diamond, only drawn in outline.
      return (
        <svg {...common}>
          <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" strokeDasharray="2.2 1.8" />
        </svg>
      );
    case "question":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3v.3" />
          <circle cx="8" cy="11.4" r=".4" fill={color} />
        </svg>
      );
    case "action":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="3" />
          <path d="m5.2 8.2 2 2 3.8-4.2" />
        </svg>
      );
    case "requirement":
      return (
        <svg {...common}>
          <path d="M5.5 2.2H3.2v11.6h2.3M10.5 2.2h2.3v11.6h-2.3M6.2 8h3.6" />
        </svg>
      );
    case "risk":
      return (
        <svg {...common}>
          <path d="M8 2.2 14.3 13.4H1.7Z" />
          <path d="M8 6.4v3.2" />
          <circle cx="8" cy="11.5" r=".4" fill={color} />
        </svg>
      );
  }
}
