/**
 * The icon a node gets when nobody chose one (docs/26 §6.2): a brand mark when
 * the label names a product ("Orders DB (Postgres)" → PostgreSQL), otherwise a
 * concept icon for what it is ("Send receipt email" → mail), otherwise — for a
 * few infrastructure node types — the type's icon. Pure and table-driven, so
 * it is node-testable and the registry test can prove every target exists.
 *
 * This replaces the 19 hand-drawn glyphs of techMarks.tsx: same whole-word
 * matching, but real marks, and a label is normalized once and memoized
 * instead of compiling one regex per keyword per node per render.
 */

/** [keywords, ref] — a keyword is a whole word or phrase in the label. */
const BRANDS: Array<[string[], string]> = [
  [["postgresql", "postgres", "psql"], "simple:postgresql"],
  [["mysql"], "simple:mysql"],
  [["mariadb"], "simple:mariadb"],
  [["mongodb", "mongo"], "simple:mongodb"],
  [["sqlite"], "simple:sqlite"],
  [["redis"], "simple:redis"],
  [["kafka", "apache kafka"], "simple:apachekafka"],
  [["rabbitmq"], "simple:rabbitmq"],
  [["elasticsearch"], "simple:elasticsearch"],
  [["opensearch"], "simple:opensearch"],
  [["neo4j"], "simple:neo4j"],
  [["clickhouse"], "simple:clickhouse"],
  [["cassandra"], "simple:apachecassandra"],
  [["snowflake"], "simple:snowflake"],
  [["databricks"], "simple:databricks"],
  [["bigquery"], "simple:googlebigquery"],
  [["spark", "apache spark"], "simple:apachespark"],
  [["airflow"], "simple:apacheairflow"],
  [["supabase"], "simple:supabase"],
  [["firebase"], "simple:firebase"],
  [["planetscale"], "simple:planetscale"],
  [["prisma"], "simple:prisma"],
  [["hasura"], "simple:hasura"],
  [["graphql"], "simple:graphql"],
  [["trpc"], "simple:trpc"],
  [["swagger"], "simple:swagger"],
  [["postman"], "simple:postman"],
  [["stripe"], "simple:stripe"],
  [["paypal"], "simple:paypal"],
  [["shopify"], "simple:shopify"],
  [["google cloud", "gcp"], "simple:googlecloud"],
  [["google analytics"], "simple:googleanalytics"],
  [["google meet"], "simple:googlemeet"],
  [["google", "google oauth", "google login"], "simple:google"],
  [["cloudflare"], "simple:cloudflare"],
  [["vercel"], "simple:vercel"],
  [["netlify"], "simple:netlify"],
  [["digitalocean"], "simple:digitalocean"],
  [["docker"], "simple:docker"],
  [["kubernetes", "k8s"], "simple:kubernetes"],
  [["terraform"], "simple:terraform"],
  [["ansible"], "simple:ansible"],
  [["nginx"], "simple:nginx"],
  [["jenkins"], "simple:jenkins"],
  [["github actions"], "simple:githubactions"],
  [["circleci"], "simple:circleci"],
  [["github"], "simple:github"],
  [["gitlab"], "simple:gitlab"],
  [["git"], "simple:git"],
  [["prometheus"], "simple:prometheus"],
  [["grafana"], "simple:grafana"],
  [["datadog"], "simple:datadog"],
  [["sentry"], "simple:sentry"],
  [["auth0"], "simple:auth0"],
  [["okta"], "simple:okta"],
  [["react", "react native"], "simple:react"],
  [["next.js", "nextjs"], "simple:nextdotjs"],
  [["vue", "vue.js", "vuejs"], "simple:vuedotjs"],
  [["svelte", "sveltekit"], "simple:svelte"],
  [["angular"], "simple:angular"],
  [["tailwind", "tailwindcss"], "simple:tailwindcss"],
  [["node.js", "nodejs"], "simple:nodedotjs"],
  // Not bare "express": "Express shipping" is not a Node framework.
  [["express.js", "expressjs"], "simple:express"],
  [["deno"], "simple:deno"],
  [["python"], "simple:python"],
  [["django"], "simple:django"],
  [["fastapi"], "simple:fastapi"],
  [["flask"], "simple:flask"],
  [["spring boot"], "simple:spring"],
  [["golang"], "simple:go"],
  [["typescript"], "simple:typescript"],
  [["javascript"], "simple:javascript"],
  [["kotlin"], "simple:kotlin"],
  [["php"], "simple:php"],
  [["ruby"], "simple:ruby"],
  [["dotnet", "asp.net"], "simple:dotnet"],
  [["jira"], "simple:jira"],
  [["notion"], "simple:notion"],
  [["figma"], "simple:figma"],
  [["anthropic"], "simple:anthropic"],
  [["hubspot"], "simple:hubspot"],
  [["mixpanel"], "simple:mixpanel"],
  [["zapier"], "simple:zapier"],
  [["intercom"], "simple:intercom"],
  [["zendesk"], "simple:zendesk"],
  [["mailchimp"], "simple:mailchimp"],
  [["algolia"], "simple:algolia"],
  [["meilisearch"], "simple:meilisearch"],
  [["discord"], "simple:discord"],
  [["whatsapp"], "simple:whatsapp"],
  [["telegram"], "simple:telegram"],
];

/** Concepts — what a node does, when it names no product. */
const CONCEPTS: Array<[string[], string]> = [
  [
    ["database", "db", "datastore", "data store", "data warehouse", "sql", "table store"],
    "iconoir:database",
  ],
  [["cache", "caching", "memcached", "cdn cache"], "iconoir:flash"],
  [
    [
      "queue",
      "message queue",
      "message bus",
      "event bus",
      "pubsub",
      "pub/sub",
      "topic",
      "stream",
      "sqs",
      "event stream",
    ],
    "iconoir:data-transfer-both",
  ],
  [["search", "search index"], "iconoir:search"],
  [["payment", "payments", "checkout", "billing", "invoice", "invoicing"], "iconoir:credit-card"],
  [["cart", "basket"], "iconoir:cart"],
  [["wallet"], "iconoir:wallet"],
  [
    [
      "auth",
      "authentication",
      "authorization",
      "oauth",
      "sso",
      "login",
      "log in",
      "signin",
      "sign in",
      "jwt",
      "identity",
      "iam",
      "permissions",
    ],
    "iconoir:lock",
  ],
  [["secrets", "vault", "api key", "keys"], "iconoir:key"],
  [["security", "firewall", "waf", "compliance"], "iconoir:shield-check"],
  [["aws", "azure", "cloud"], "iconoir:cloud"],
  [
    ["s3", "bucket", "object storage", "blob storage", "storage", "file storage"],
    "iconoir:archive",
  ],
  [["disk", "volume"], "iconoir:hard-drive"],
  [["container", "containers"], "iconoir:cube"],
  [
    [
      "api gateway",
      "gateway",
      "load balancer",
      "proxy",
      "reverse proxy",
      "router",
      "dns",
      "vpc",
      "network",
      "cdn",
    ],
    "iconoir:network",
  ],
  [["api", "rest api", "grpc", "endpoint", "webhook", "webhooks", "sdk"], "iconoir:code-brackets"],
  [["backend", "back end", "server", "api server", "service mesh"], "iconoir:server"],
  [
    ["frontend", "front end", "web app", "webapp", "website", "browser", "spa", "web"],
    "iconoir:app-window",
  ],
  [["mobile", "mobile app", "ios", "android", "app store"], "iconoir:smartphone-device"],
  [["email", "e-mail", "mail", "smtp", "newsletter"], "iconoir:mail"],
  [["notification", "notifications", "push", "alerts"], "iconoir:bell"],
  [["sms", "text message", "slack", "chat", "messaging"], "iconoir:chat-bubble"],
  [["analytics", "metrics", "kpi", "kpis", "insights"], "iconoir:graph-up"],
  [["dashboard", "dashboards"], "iconoir:dashboard"],
  [["report", "reports", "reporting"], "iconoir:stats-report"],
  [["monitoring", "observability", "telemetry", "tracing"], "iconoir:dashboard-speed"],
  [["log", "logs", "logging", "audit log", "audit"], "iconoir:journal"],
  [["ci", "ci/cd", "cicd", "pipeline", "build"], "iconoir:git-merge"],
  [["deploy", "deployment", "release", "launch"], "iconoir:rocket"],
  [
    [
      "ai",
      "llm",
      "openai",
      "gpt",
      "machine learning",
      "ml",
      "ml model",
      "model inference",
      "copilot",
      "assistant",
      "embeddings",
    ],
    "iconoir:sparks",
  ],
  // Not "client": "API client" is software, not a person.
  [
    [
      "user",
      "users",
      "customer",
      "customers",
      "visitor",
      "shopper",
      "buyer",
      "end user",
      "member",
      "patient",
      "student",
    ],
    "iconoir:user",
  ],
  [["team", "teams", "staff", "employees", "group"], "iconoir:group"],
  [["admin", "administrator", "owner"], "iconoir:user-crown"],
  [["file", "files", "document", "documents", "docs", "pdf"], "iconoir:page"],
  [["folder", "folders"], "iconoir:folder"],
  [["upload", "uploads"], "iconoir:cloud-upload"],
  [
    ["calendar", "schedule", "scheduling", "booking", "appointment", "appointments"],
    "iconoir:calendar",
  ],
  [["cron", "scheduler", "scheduled job", "timer"], "iconoir:clock"],
  [["worker", "workers", "background job", "jobs", "job runner"], "iconoir:cpu"],
  [["map", "maps", "location", "geo", "geolocation"], "iconoir:map-pin"],
  [["shipping", "delivery", "logistics", "fulfillment", "fulfilment"], "iconoir:delivery-truck"],
  [["inventory", "warehouse", "stock"], "iconoir:packages"],
  [["settings", "config", "configuration", "preferences"], "iconoir:settings"],
  [["table", "spreadsheet", "csv", "excel"], "iconoir:table"],
  [["kanban", "backlog"], "iconoir:kanban-board"],
  [["task", "tasks", "todo", "to-do", "checklist"], "iconoir:task-list"],
  [["approval", "approve", "review", "sign-off", "signoff"], "iconoir:badge-check"],
  [["error", "failure", "failed", "incident", "outage", "alert"], "iconoir:warning-triangle"],
  [["idea", "ideas", "brainstorm"], "iconoir:light-bulb"],
  // Not bare "call": "API call" is not a phone.
  [["phone", "phone call", "voice"], "iconoir:phone"],
  [["video", "meeting", "meetings"], "iconoir:video-camera"],
  [["image", "images", "photo", "photos", "media"], "iconoir:media-image"],
  [["home", "homepage", "home page", "landing page"], "iconoir:home"],
];

/** Node types whose kind alone earns an icon, when the label names nothing. */
const TYPE_ICONS: Record<string, string> = {
  database: "iconoir:database",
  db: "iconoir:database",
  datastore: "iconoir:database",
  cache: "iconoir:flash",
  queue: "iconoir:data-transfer-both",
  topic: "iconoir:data-transfer-both",
  stream: "iconoir:data-transfer-both",
  storage: "iconoir:archive",
  bucket: "iconoir:archive",
  actor: "iconoir:user",
  user: "iconoir:user",
  person: "iconoir:user",
  persona: "iconoir:user",
  customer: "iconoir:user",
  gateway: "iconoir:network",
  screen: "iconoir:app-window",
  page: "iconoir:app-window",
  frontend: "iconoir:app-window",
  mobile: "iconoir:smartphone-device",
};

/**
 * Lowercase, punctuation to spaces (keeping the dots, pluses and slashes that
 * live inside names like next.js, c++ and ci/cd), sentence dots dropped, and
 * padded so every keyword can be matched as " word ".
 */
export function normalizeLabel(label: string): string {
  const text = label
    .toLowerCase()
    .replace(/[^a-z0-9.+/#-]+/g, " ")
    .replace(/(^|\s)[./-]+|[./-]+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return ` ${text} `;
}

/** Brands outrank concepts, and a longer phrase outranks a shorter one. */
const KEYS: Array<[string, string]> = [
  ...BRANDS.flatMap(([keys, ref]) => keys.map((k) => [k, ref, 1] as const)),
  ...CONCEPTS.flatMap(([keys, ref]) => keys.map((k) => [k, ref, 0] as const)),
]
  .sort((a, b) => b[2] - a[2] || b[0].length - a[0].length)
  .map(([k, ref]) => [normalizeLabel(k), ref]);

const memo = new Map<string, string | null>();

/** The label's own icon (brand, then concept), or null when it names neither. */
export function iconForLabel(label: string): string | null {
  const hit = memo.get(label);
  if (hit !== undefined) return hit;
  const text = normalizeLabel(label);
  let ref: string | null = null;
  for (const [key, candidate] of KEYS) {
    if (text.includes(key)) {
      ref = candidate;
      break;
    }
  }
  // Boards reuse labels constantly (every render asks again), so the cache
  // pays for itself; the bound only guards a pathological session.
  if (memo.size > 5_000) memo.clear();
  memo.set(label, ref);
  return ref;
}

/** The icon a node shows when it has none of its own. */
export function autoIconFor(label: string, nodeType: string): string | null {
  return iconForLabel(label) ?? TYPE_ICONS[nodeType.toLowerCase()] ?? null;
}

/** Every reference the tables can produce — the registry test checks them all. */
export function allAutoIconRefs(): string[] {
  return [
    ...new Set([...BRANDS, ...CONCEPTS].map(([, ref]) => ref).concat(Object.values(TYPE_ICONS))),
  ];
}
