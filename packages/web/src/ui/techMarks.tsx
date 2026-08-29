/**
 * Recognizable marks for common technologies, so a node reading "PostgreSQL" or
 * "Redis" is identifiable at a glance instead of just another labelled box.
 *
 * These are hand-drawn simplified glyphs, not vendor logo files: no network
 * fetch, no bundled trademark assets, and they inherit `currentColor` so they
 * work in both themes. Each entry carries a brand tint used for the node's
 * accent dot; the glyph itself stays monochrome to keep the board calm.
 */

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

export interface TechMark {
  /** Canonical display name, e.g. "PostgreSQL". */
  label: string;
  /** Brand-ish accent color for the node dot. */
  tint: string;
  Glyph: (p: P) => JSX.Element;
}

const svg =
  (children: React.ReactNode, filled = false) =>
  (p: P) => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...p}
    >
      {children}
    </svg>
  );

/** Stacked-platters database silhouette, shared by relational stores. */
const DbGlyph = svg(
  <>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
    <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
  </>,
);

const CacheGlyph = svg(
  <>
    <path d="M3 7.5 12 3l9 4.5-9 4.5z" />
    <path d="m3 12 9 4.5L21 12" />
    <path d="m3 16.5 9 4.5 9-4.5" />
  </>,
);

const CloudGlyph = svg(
  <>
    <path d="M7 18h10a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 7.6 11 3.5 3.5 0 0 0 7 18z" />
  </>,
);

const QueueGlyph = svg(
  <>
    <rect x="3" y="8" width="4" height="8" rx="1" />
    <rect x="10" y="8" width="4" height="8" rx="1" />
    <rect x="17" y="8" width="4" height="8" rx="1" />
  </>,
);

const CardGlyph = svg(
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M2.5 10.5h19" />
    <path d="M6 14.5h3" />
  </>,
);

const GoogleGlyph = svg(
  <>
    <path d="M20.5 12a8.5 8.5 0 1 1-2.9-6.4" />
    <path d="M20.6 11.4H12v2.6h5.9" />
  </>,
);

const ContainerGlyph = svg(
  <>
    <rect x="3" y="10" width="4" height="4" />
    <rect x="8" y="10" width="4" height="4" />
    <rect x="8" y="5.5" width="4" height="4" />
    <rect x="13" y="10" width="4" height="4" />
    <path d="M3 14.5c0 3 2.5 4.5 7 4.5s8.5-2 10-6c-1.5-.6-3-.5-4 .2" />
  </>,
);

const KubernetesGlyph = svg(
  <>
    <path d="M12 2.8 20 7v10l-8 4.2L4 17V7z" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 5v4M12 15v4M6.5 9l3.2 1.8M14.3 13.2 17.5 15M6.5 15l3.2-1.8M14.3 10.8 17.5 9" />
  </>,
);

const ReactGlyph = svg(
  <>
    <circle cx="12" cy="12" r="2" />
    <ellipse cx="12" cy="12" rx="10" ry="4" />
    <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
    <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
  </>,
);

const NodeJsGlyph = svg(
  <>
    <path d="M12 2.6 20.5 7v10L12 21.4 3.5 17V7z" />
    <path d="M9 14.5c0 .9.8 1.5 2 1.5s2-.6 2-1.5V9" />
  </>,
);

const LockGlyph = svg(
  <>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </>,
);

const SearchDocGlyph = svg(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="m19.5 19.5-4-4" />
  </>,
);

const GraphGlyph = svg(
  <>
    <circle cx="6" cy="7" r="2.2" />
    <circle cx="18" cy="7" r="2.2" />
    <circle cx="12" cy="17.5" r="2.2" />
    <path d="M7.6 8.7 10.6 15.6M16.4 8.7 13.4 15.6M8.2 7h7.6" />
  </>,
);

const BrowserGlyph = svg(
  <>
    <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
    <path d="M2.5 9h19" />
    <path d="M6 6.8h.01M8.5 6.8h.01" />
  </>,
);

const MobileGlyph = svg(
  <>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M10.5 18.8h3" />
  </>,
);

const ApiGlyph = svg(
  <>
    <path d="M9 7 4.5 12 9 17" />
    <path d="m15 7 4.5 5L15 17" />
    <path d="M13 5.5 11 18.5" />
  </>,
);

const MailGlyph = svg(
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m3.5 6.5 8.5 6.5 8.5-6.5" />
  </>,
);

const ChartGlyph = svg(
  <>
    <path d="M4 19.5V4" />
    <path d="M4 19.5h16" />
    <path d="M8 19.5v-6M12.5 19.5V8M17 19.5v-9" />
  </>,
);

const GitGlyph = svg(
  <>
    <circle cx="7" cy="6" r="2.2" />
    <circle cx="7" cy="18" r="2.2" />
    <circle cx="17" cy="12" r="2.2" />
    <path d="M7 8.2v7.6" />
    <path d="M9.2 6.8c3.5.6 5.3 2 5.7 4.2" />
  </>,
);

const TINT = {
  blue: "oklch(0.72 0.11 235)",
  green: "oklch(0.78 0.11 155)",
  red: "oklch(0.72 0.15 25)",
  amber: "oklch(0.80 0.13 75)",
  violet: "oklch(0.72 0.13 300)",
  slate: "oklch(0.70 0.02 250)",
  teal: "oklch(0.75 0.10 190)",
} as const;

/**
 * Keyword → mark. Keys are matched as whole words (case-insensitive) against a
 * node's label, longest first, so "google cloud storage" prefers the cloud mark
 * over the bare "google" mark.
 */
const MARKS: Array<[string[], TechMark]> = [
  [["postgresql", "postgres", "psql"], { label: "PostgreSQL", tint: TINT.blue, Glyph: DbGlyph }],
  [["mysql", "mariadb"], { label: "MySQL", tint: TINT.teal, Glyph: DbGlyph }],
  [["mongodb", "mongo"], { label: "MongoDB", tint: TINT.green, Glyph: DbGlyph }],
  [["dynamodb"], { label: "DynamoDB", tint: TINT.blue, Glyph: DbGlyph }],
  [["sqlite"], { label: "SQLite", tint: TINT.slate, Glyph: DbGlyph }],
  [
    ["database", "db", "datastore", "data store"],
    { label: "Database", tint: TINT.blue, Glyph: DbGlyph },
  ],
  [["redis", "memcached", "cache"], { label: "Redis", tint: TINT.red, Glyph: CacheGlyph }],
  [
    ["kafka", "rabbitmq", "sqs", "queue", "message bus", "event bus", "pubsub", "pub/sub"],
    { label: "Queue", tint: TINT.amber, Glyph: QueueGlyph },
  ],
  [
    ["elasticsearch", "opensearch", "search"],
    { label: "Search", tint: TINT.amber, Glyph: SearchDocGlyph },
  ],
  [
    ["neo4j", "graph database", "graphql"],
    { label: "Graph", tint: TINT.violet, Glyph: GraphGlyph },
  ],
  [
    ["stripe", "payment", "payments", "paypal", "checkout", "billing"],
    { label: "Payments", tint: TINT.violet, Glyph: CardGlyph },
  ],
  [
    ["google oauth", "google sign", "google login", "google"],
    { label: "Google", tint: TINT.blue, Glyph: GoogleGlyph },
  ],
  [
    [
      "oauth",
      "auth",
      "authentication",
      "authorization",
      "sso",
      "login",
      "signin",
      "sign in",
      "jwt",
      "identity",
    ],
    { label: "Auth", tint: TINT.green, Glyph: LockGlyph },
  ],
  [["docker", "container"], { label: "Docker", tint: TINT.blue, Glyph: ContainerGlyph }],
  [["kubernetes", "k8s"], { label: "Kubernetes", tint: TINT.blue, Glyph: KubernetesGlyph }],
  [
    ["aws", "azure", "gcp", "cloud", "s3", "cdn", "cloudflare"],
    { label: "Cloud", tint: TINT.amber, Glyph: CloudGlyph },
  ],
  [
    ["react", "next.js", "nextjs", "vue", "svelte", "frontend", "front end"],
    { label: "Frontend", tint: TINT.teal, Glyph: ReactGlyph },
  ],
  [
    ["node.js", "nodejs", "express", "backend", "back end", "server"],
    { label: "Backend", tint: TINT.green, Glyph: NodeJsGlyph },
  ],
  [
    ["api gateway", "rest api", "api", "grpc", "endpoint", "webhook"],
    { label: "API", tint: TINT.violet, Glyph: ApiGlyph },
  ],
  [
    ["email", "mail", "sendgrid", "ses", "notification", "notifications", "sms", "twilio"],
    { label: "Messaging", tint: TINT.amber, Glyph: MailGlyph },
  ],
  [
    ["analytics", "metrics", "dashboard", "reporting", "report"],
    { label: "Analytics", tint: TINT.teal, Glyph: ChartGlyph },
  ],
  [
    ["github", "gitlab", "git", "ci/cd", "ci", "pipeline"],
    { label: "Git", tint: TINT.amber, Glyph: GitGlyph },
  ],
  [
    ["mobile app", "ios", "android", "mobile"],
    { label: "Mobile", tint: TINT.violet, Glyph: MobileGlyph },
  ],
  [
    ["browser", "web app", "website", "web"],
    { label: "Web", tint: TINT.blue, Glyph: BrowserGlyph },
  ],
];

// Longest keyword first so specific phrases beat generic single words.
const INDEX: Array<[string, TechMark]> = MARKS.flatMap(([keys, mark]) =>
  keys.map((k) => [k, mark] as [string, TechMark]),
).sort((a, b) => b[0].length - a[0].length);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find a technology mark for a node label, or null when nothing matches.
 * Matching is whole-word so "cardboard" doesn't match "card" and "database"
 * doesn't get hijacked by the bare "db" key.
 */
export function techMarkFor(label: string): TechMark | null {
  const text = label.toLowerCase();
  for (const [key, mark] of INDEX) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRe(key)}($|[^a-z0-9])`, "i");
    if (re.test(text)) return mark;
  }
  return null;
}
