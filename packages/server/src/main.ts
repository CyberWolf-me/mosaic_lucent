import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectImageProvider } from "./image.js";
import { selectProvider } from "./provider.js";
import { UsageTracker, limitsFromEnv } from "./usage.js";
import { Telemetry } from "./telemetry.js";
import { InMemoryUserStore, type UserStore } from "./accounts.js";
import { sessionSecret } from "./config.js";
import { InMemoryBoardStore, type BoardStore } from "./boards.js";
import { createApp } from "./app.js";
import { closeDb, createDb, type Db } from "./db/client.js";
import { migrate as runMigrations } from "./db/migrate.js";
import { PostgresUserStore } from "./store/pg-users.js";
import { PostgresBoardStore } from "./store/pg-boards.js";
import { Limiter } from "./limiter.js";
import { InMemoryTicketStore } from "./realtimeTicket.js";
import { createStaticHandler } from "./static.js";
import { resolve as resolvePath } from "node:path";
import { InMemorySessionStore, PostgresSessionStore, type SessionStore } from "./sessions.js";
import { selectMailer } from "./email/index.js";
import {
  InMemoryTokenStore,
  PostgresEmailVerificationStore,
  PostgresPasswordResetStore,
  type TokenStore,
} from "./tokens.js";
import { InMemoryTotpStore, PostgresTotpStore, type TotpStore } from "./totpStore.js";
import {
  InMemoryAccountDeletionStore,
  PostgresAccountDeletionStore,
  type AccountDeletionStore,
} from "./accountDeletion.js";
import { runScheduledDeletions } from "./accounts.js";
import { InMemoryOrgStore, PostgresOrgStore, type OrgStore } from "./orgs.js";
import { InMemoryOrgInviteStore, PostgresOrgInviteStore, type OrgInviteStore } from "./invites.js";
import { InMemoryNotificationStore, type NotificationStore } from "./notifications.js";
import { PostgresNotificationStore } from "./store/pg-notifications.js";
import { InMemoryMeetingStore } from "./meetings.js";
import { PostgresMeetingStore } from "./store/pg-meetings.js";
import { InMemoryProposalStore } from "./proposals.js";
import { PostgresProposalStore } from "./store/pg-proposals.js";
import { PostgresAssetStore } from "./store/pg-assets.js";
import { InMemorySsoStore } from "./ssoStore.js";
import { InMemoryIntegrationStore } from "./integrations/integrations.js";
import { FakeProvider } from "./integrations/fake.js";
import { PostgresSsoStore } from "./store/pg-sso.js";
import { InMemoryUsageStore, type UsageStore } from "./usageStore.js";
import { PostgresUsageStore } from "./store/pg-usage.js";
import {
  AssetService,
  InMemoryAssetStore,
  selectBlobBackend,
  selectThumbnailer,
} from "./assets.js";
import { hashPassword } from "./auth.js";
import { InMemoryScimIdentityStore, readScimConfig } from "./scim.js";
import { PostgresScimIdentityStore } from "./store/pg-scim-identities.js";
import { PLAN_LADDER } from "./plans.js";
import { StripeClient } from "./billing/stripe.js";
import { createStripeDispatcher } from "./billing/handlers.js";
import { InMemoryStripeEventStore } from "./billing/events.js";
import { PostgresStripeEventStore } from "./store/pg-stripe-events.js";
import {
  applyStripePriceOverrides,
  stripeEventLookup,
  type BillingIntegration,
} from "./billing/service.js";
import { sweepStripeEvents } from "./billing/webhook.js";
import { createLogger, logLevelFromEnv } from "./obs/logger.js";
import { MetricsRegistry, registerProcessMetrics } from "./obs/metrics.js";

/**
 * Process entry point: read configuration, pick implementations, start
 * listening. All request handling lives in `app.ts` so it can be booted in a
 * test without this file's side effects.
 *
 * Persistence (docs/06): when LUCENT_DATABASE_URL is set the server runs
 * migrations on boot and uses Postgres-backed user/board stores. Otherwise the
 * in-memory stores are used, which is correct for single-instance dev but does
 * not survive a restart.
 */

/**
 * Load KEY=VALUE lines from a .env file into process.env (without overriding
 * anything already set). Keeps provider keys out of the shell history and out
 * of git (.env is gitignored). No dependency needed for this simple format.
 */
function loadDotEnv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // no .env file — fine, env may be set another way
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(fileURLToPath(new URL("../.env", import.meta.url)));

/**
 * Select user/board/session stores based on the database URL. With Postgres
 * we also keep the DB handle so the pool can be closed on shutdown.
 */
function makeStores(databaseUrl: string | undefined): {
  userStore: UserStore;
  boardStore: BoardStore;
  sessionStore: SessionStore;
  verificationTokens: TokenStore;
  resetTokens: TokenStore;
  totpStore: TotpStore;
  deletionStore: AccountDeletionStore;
  orgStore: OrgStore;
  inviteStore: OrgInviteStore;
  notifications: NotificationStore;
  usageStore: UsageStore;
  /** E3/R3: meeting transcripts — in-memory for dev, Postgres when configured. */
  meetings: import("./meetings.js").MeetingStore;
  /** F1: SSO connections + domain claims, on the same store-per-database rule. */
  ssoStore: import("./ssoStore.js").SsoStore;
  /** Stage B3: review-gate proposals — in-memory for dev, Postgres when set. */
  proposals: import("./proposals.js").ProposalStore;
  /** Stage D4: integrations — in-memory store + the FakeProvider (the PG
   * pair and real providers land with D6, when Linear demands persistence). */
  integrations: {
    store: import("./integrations/integrations.js").IntegrationStore;
    providers: Map<string, import("./integrations/provider.js").ExecutionProvider>;
  };
  /** Stage B6: asset metadata — in-memory for dev, Postgres when set. */
  assetStore: import("./assets.js").AssetStore;
  db: Db | null;
  presenceStore?: import("./presence.js").PresenceStore;
  fanout?: import("./fanout.js").Fanout;
  /** Short, stable identifier for this process — used as `instanceId`. */
  instanceId?: string;
} {
  if (!databaseUrl) {
    return {
      userStore: new InMemoryUserStore(),
      boardStore: new InMemoryBoardStore(),
      sessionStore: new InMemorySessionStore(),
      verificationTokens: new InMemoryTokenStore(),
      resetTokens: new InMemoryTokenStore(),
      totpStore: new InMemoryTotpStore(),
      deletionStore: new InMemoryAccountDeletionStore(),
      orgStore: new InMemoryOrgStore(),
      inviteStore: new InMemoryOrgInviteStore(),
      notifications: new InMemoryNotificationStore(),
      usageStore: new InMemoryUsageStore(),
      meetings: new InMemoryMeetingStore(),
      ssoStore: new InMemorySsoStore(),
      integrations: {
        store: new InMemoryIntegrationStore(),
        providers: new Map([['fake', new FakeProvider()]]),
      },
      proposals: new InMemoryProposalStore(),
      assetStore: new InMemoryAssetStore(),
      db: null,
    };
  }
  const target = createDb(databaseUrl);
  return {
    userStore: new PostgresUserStore(target),
    boardStore: new PostgresBoardStore(target),
    sessionStore: new PostgresSessionStore(target),
    verificationTokens: new PostgresEmailVerificationStore(target),
    resetTokens: new PostgresPasswordResetStore(target),
    totpStore: new PostgresTotpStore(target),
    deletionStore: new PostgresAccountDeletionStore(target),
    orgStore: new PostgresOrgStore(target),
    inviteStore: new PostgresOrgInviteStore(target),
    notifications: new PostgresNotificationStore(target),
    usageStore: new PostgresUsageStore(target),
    meetings: new PostgresMeetingStore(target),
    ssoStore: new PostgresSsoStore(target),
    proposals: new PostgresProposalStore(target),
    assetStore: new PostgresAssetStore(target),
    // D4: the integration store stays in-memory until the PG pair lands
    // with D6 (the ADR records the deferral); the provider map is
    // env-independent either way.
    integrations: {
      store: new InMemoryIntegrationStore(),
      providers: new Map([['fake', new FakeProvider()]]),
    },
    db: target,
  };
}

// Late-bind readConfig so the .env values are visible.
const { readConfig, isProduction } = await import("./config.js");
const config = readConfig();

/**
 * Process-wide observability (M0.4). One logger and one registry, injected into
 * the app: that is what makes LUCENT_LOG_LEVEL control request logging and lets
 * a single scrape of /metrics/prometheus cover the whole process.
 *
 * The boot lines below stay on console.* deliberately. They have to print
 * whatever the configured level is — a migration failure that logged nothing
 * because someone set LUCENT_LOG_LEVEL=silent would be a very expensive silence.
 */
const logger = createLogger({
  level: logLevelFromEnv(),
  base: { service: "lucent-server", pid: process.pid },
});
const metrics = new MetricsRegistry();

// RSS, heap, CPU and start time, all sampled at scrape time rather than on a
// timer: a timer would wake the event loop on every interval to refresh numbers
// nobody is reading. Uptime is deliberately absent — Prometheus convention is
// to expose the start time and let the query do `time() - start_time`.
registerProcessMetrics(metrics);

/**
 * DATA-LOSS GUARD (Stage A safety, P1). Without LUCENT_DATABASE_URL the
 * server runs the in-memory stores: every account, board, meeting
 * transcript, and audit row lives in the process and evaporates on
 * restart. That fallback is correct for solo dev — but the gate pass
 * watched it silently swallow real user data whenever the env was
 * missing, which is the single easiest variable to forget in a
 * container. The guard makes the tradeoff loud instead of silent:
 * production + auth + in-memory REFUSES TO BOOT (a deployment that would
 * quietly lose everything on the next pod restart); dev prints a
 * warning that names the fix. The refusal deliberately mirrors
 * sessionSecret's production throw — the same class of "weak default in
 * production" — and auth-off is exempt: an intentionally open solo
 * server is a demo, not a data-loss incident.
 */
if (!config.databaseUrl) {
  if (isProduction(process.env) && config.requireAuth) {
    console.error(
      "[lucent] REFUSING TO START: NODE_ENV=production with authentication but no " +
        "LUCENT_DATABASE_URL. The in-memory stores do not survive a restart — every " +
        "account, board, and meeting would be lost. Set LUCENT_DATABASE_URL to a " +
        "Postgres instance, or set LUCENT_REQUIRE_AUTH=0 for an intentionally " +
        "ephemeral demo.",
    );
    process.exit(1);
  }
  console.warn(
    "[lucent] DATA LOSS WARNING: no LUCENT_DATABASE_URL — running on in-memory " +
      "stores. Accounts, boards, and meeting transcripts will NOT survive a " +
      "restart. Fine for local development; set LUCENT_DATABASE_URL for " +
      "anything real.",
  );
}

const stores = makeStores(config.databaseUrl);
const db: Db | null = stores.db;
if (db) {
  // Fail loud: a server that starts against an unmigrated database would answer
  // requests with confusing SQL errors instead of refusing to boot.
  await runMigrations(db).catch((err: Error) => {
    console.error("[lucent] migration failed:", err);
    process.exit(1);
  });
}

// M4: seed the plan catalogue before anything can serve a request. Awaited here
// rather than left to createApp because a request that landed mid-seed would
// resolve to the compiled-in Free fallback and refuse a paying org's work.
//
// This follows the migration's fail-loud convention rather than the deletion
// prune's log-and-continue: a failed prune leaves correct data, just some stale
// rows, whereas an unseeded catalogue makes every entitlement decision wrong in
// the paying customer's direction — and `subscriptions.plan` is a foreign key, so
// a checkout would trip the FK instead of upgrading anyone. Refusing to boot is
// the cheaper failure. Runs after migrations because the Postgres store writes to
// the `plans` table.
await stores.usageStore.seedPlans(PLAN_LADDER, Date.now()).catch((err: Error) => {
  console.error("[lucent] plan catalogue seed failed:", err);
  process.exit(1);
});

// M4.3: the deployment's Stripe price ids, from env onto the catalogue. The
// webhook maps a subscription's priced line back to a plan through these ids
// (handlers.ts:planAndSeats), so a checkout cannot be started without them.
const priceOverrides = await applyStripePriceOverrides(stores.usageStore, process.env, Date.now());
if (priceOverrides > 0) {
  console.log(`[lucent] applied Stripe price ids to ${priceOverrides} plan(s)`);
}

// M1.7: wipe any accounts whose 7-day grace window has passed before
// accepting traffic. The boot path is the only natural moment; subsequent
// deletions run on a periodic timer below.
const prunedUsers = await runScheduledDeletions({
  userStore: stores.userStore,
  deletionStore: stores.deletionStore,
} as Parameters<typeof runScheduledDeletions>[0]).catch((err: Error) => {
  console.error("[lucent] scheduled-deletion prune failed:", err);
  return [];
});
if (prunedUsers.length > 0) {
  console.log(`[lucent] pruned ${prunedUsers.length} matured deletion(s) on boot`);
}

const provider = selectProvider(undefined, { timeoutMs: config.aiTimeoutMs });
const limits = limitsFromEnv();

/**
 * M4.3: Stripe billing. Both keys or neither — a webhook secret without a
 * client would verify deliveries it can never act on, and a client without
 * the webhook secret would take money through checkout and silently drop
 * every delivery that granted it. Half-configured is a boot failure, the same
 * convention the migrations follow: worse to refuse than to bill half-real.
 */
let billing: BillingIntegration | undefined;
if (config.billing.stripeSecretKey || config.billing.stripeWebhookSecret) {
  if (!config.billing.stripeSecretKey || !config.billing.stripeWebhookSecret) {
    console.error(
      "[lucent] billing is half-configured: set both LUCENT_STRIPE_SECRET_KEY and " +
        "LUCENT_STRIPE_WEBHOOK_SECRET, or neither",
    );
    process.exit(1);
  }
  const client = new StripeClient({ secretKey: config.billing.stripeSecretKey });
  const billingEvents = db ? new PostgresStripeEventStore(db) : new InMemoryStripeEventStore();
  const dispatcher = createStripeDispatcher({
    store: stores.usageStore,
    lookup: client,
    logger,
    // metadata.orgId is only honoured for an org something local vouches for
    // (handlers.ts:orgFor); the org store is that voucher.
    orgExists: async (orgId) => (await stores.orgStore.get(orgId)) !== undefined,
  });
  billing = {
    client,
    webhookSecret: config.billing.stripeWebhookSecret,
    events: billingEvents,
    dispatcher,
  };
  console.log("[lucent] billing: Stripe configured (checkout, portal, webhook)");
}

/**
 * M3: cross-instance wiring. When Postgres is configured, build the
 * PresenceStore + Fanout instances and a stable per-process `instanceId`.
 * The presence store writes to the `presence` table; the fanout opens a
 * dedicated `LISTEN` connection.
 *
 * Failure to open the LISTEN connection is loud-once-and-continue: the
 * presence store still works for the in-process path, and the fanout can
 * be retried on the next reconnect. The previous "the realtime layer is
 * down" was a worse outcome than "the realtime layer is single-instance".
 */
let presenceStore: import("./presence.js").PresenceStore | undefined;
let fanout: import("./fanout.js").Fanout | undefined;
const instanceId = `srv_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
if (db) {
  const { PostgresPresenceStore } = await import("./store/pg-presence.js");
  presenceStore = new PostgresPresenceStore(db);
  try {
    const { PostgresFanout } = await import("./store/pg-fanout.js");
    fanout = await PostgresFanout.open(db);
  } catch (err) {
    console.error(
      "[lucent] fanout LISTEN failed; running single-instance:",
      (err as Error).message,
    );
  }
}
const usage = new UsageTracker(limits);
const authLimiter = new Limiter(config.authLimiter.perWindow, config.authLimiter.windowMs);
const tickets = new InMemoryTicketStore(config.realtimeTicketTtlMs);

// M7 / M4 storage: the asset gateway. Stage B6 closes the deferred gap: the
// metadata store is Postgres when a database is configured (the `assets` table
// was always there; every uploaded asset row previously evaporated with the
// process), in-memory otherwise. The bytes stay in the BlobBackend by
// config — the documented caveat stands and is recorded in the restore
// runbook: a backend swap that does not carry the bytes to the same bucket
// leaves rows pointing at keys the new backend cannot serve, and the
// content-addressed keys make that a byte migration, not a metadata one
// (re-upload dedupes).
const assetService = new AssetService({
  store: stores.assetStore,
  blobs: selectBlobBackend(process.env),
  thumbnails: selectThumbnailer(process.env),
});

// M6/F1: SCIM 2.0 gateway. Configured when `LUCENT_SCIM_TOKEN` (or its digest
// form) is set; otherwise the routes are absent and the deployment can ignore
// this surface. The user store is reused — SCIM only manages the lifecycle
// (provision + deprovision via tokenVersion), never the credential.
//
// `auth.ts:hashPassword` returns the salted `salt:hash` form directly, so the
// SCIM adapter is just a thin re-shape that exposes the same interface the
// SCIM gateway expects.
const scimConfig = readScimConfig(process.env, sessionSecret());
const scim = scimConfig
  ? {
      config: scimConfig,
      identities: db ? new PostgresScimIdentityStore(db) : new InMemoryScimIdentityStore(),
      hashPassword: async (password: string) => {
        const combined = await hashPassword(password);
        // `combined` is `salt:hash`; we split it here so the SCIM gateway
        // can describe the salt and hash as separate fields if it ever needs
        // to. Today the gateway concatenates them back, but keeping the
        // shape split future-proofs the migration to a non-scrypt layout.
        const colonAt = combined.indexOf(":");
        return {
          salt: colonAt >= 0 ? combined.slice(0, colonAt) : combined,
          hash: colonAt >= 0 ? combined.slice(colonAt + 1) : "",
        };
      },
    }
  : undefined;
if (scim) {
  console.log(`[lucent] scim: gateway configured (idp=${scimConfig!.idp})`);
}

const { server, realtime } = createApp({
  config,
  provider,
  imageProvider: selectImageProvider(),
  userStore: stores.userStore,
  boardStore: stores.boardStore,
  // M1: wire the session store alongside the user/board stores. Tests can
  // pass `undefined` to keep the old HMAC-bearer-only behaviour.
  sessionStore: stores.sessionStore,
  // M1.4: wire the verification + reset token stores.
  verificationTokens: stores.verificationTokens,
  resetTokens: stores.resetTokens,
  // M1.6: wire the TOTP + recovery-code store.
  totpStore: stores.totpStore,
  // M1.7: wire the pending-account-deletion store.
  deletionStore: stores.deletionStore,
  // M2: wire the org store.
  orgStore: stores.orgStore,
  // M2.4: wire the org invite store.
  inviteStore: stores.inviteStore,
  // M2.6: wire the notification store. In-memory is the honest choice for dev
  // — the tray empties on restart, which is what "single instance, no database"
  // means everywhere else in this file too.
  notifications: stores.notifications,
  // E3/R3: meeting transcripts, on the same store-per-database rule as the rest.
  meetings: stores.meetings,
  // Stage B3: review-gate proposals, same rule — the server is now the
  // record for what Lucent wants to change on a shared board.
  proposals: stores.proposals,
  // F1: SSO connections + domain claims, same rule.
  ssoStore: stores.ssoStore,
  // Stage D4: the integration platform bundle — store + provider map.
  integrations: stores.integrations,
  // M4: wire the plan + metering store. Without it the entitlement gates fail
  // open, which is the right answer for a deployment that never configured
  // billing but the wrong one here — every plan limit would go unenforced.
  usageStore: stores.usageStore,
  // M1.3: pick a Mailer based on env. Console in dev/test, SMTP in prod.
  mailer: selectMailer(config.mail),
  secret: sessionSecret(),
  usage,
  limits,
  telemetry: new Telemetry(),
  authLimiter,
  tickets,
  // M0.6: serve the built web app on the same origin so a single `npm start`
  // boots the whole product. Omitted in tests; the dev split has Vite serving
  // the client and only this server's API on the loopback port.
  staticHandler: createStaticHandler({
    root: resolvePath(import.meta.dirname, "../../web/dist"),
  }),
  logger,
  metrics,
  // M3: cross-instance presence + fanout (Postgres only; undefined on the
  // in-memory dev path).
  presenceStore,
  fanout,
  instanceId,
  // M4.3: Stripe billing routes + webhook receiver. Undefined when the
  // deployment has not configured a secret key; the routes then answer 503.
  billing,
  // M7/M4 storage: asset gateway. Always wired — uploads always have a
  // destination (memory by default, disk or S3 when env is configured).
  assetService,
  // M6/F1: SCIM 2.0 gateway. Undefined when no SCIM token is configured;
  // routes are absent in dev. The user store is reused for the underlying
  // account operations so SCIM never owns the credential.
  ...(scim ? { scim } : {}),
});

// Live rooms is the one number that says whether collaboration is actually
// being used; it needs the realtime server, so it is registered after the app.
const liveRooms = metrics.gauge({
  name: "lucent_realtime_rooms",
  help: "Boards with at least one connected client.",
});
metrics.collect(() => liveRooms.set(realtime.roomCount()));

// Bound the usage and limiter maps on a long-running process. Tickets and
// limiter entries are pruned on the same tick.
const pruneTimer = setInterval(() => {
  usage.prune();
  authLimiter.prune();
  tickets.prune();
}, 10 * 60_000);
pruneTimer.unref?.();

// M4.3: the webhook sweep. Stripe redelivers for ~3 days; this is what picks
// up the rows that outlive those retries, plus deliveries whose worker died
// mid-handler. Bounded per run so one bad week cannot become one long catch-up
// storm after a deploy. Terminal rows older than 30 days are pruned on the
// same tick — Stripe stops serving the event after ~30 days, so an older
// failed row can never be replayed and is kept only by `failed`-preservation
// in `prune` beyond that (events.ts), which this call does not touch.
if (billing) {
  const sweep = setInterval(() => {
    void sweepStripeEvents({
      store: billing.events,
      dispatcher: billing.dispatcher,
      events: stripeEventLookup(billing.client),
      logger,
      limit: 50,
    }).catch((err: Error) => {
      logger.error("billing.sweep.failed", { error: err.message });
    });
    void billing.events.prune(Date.now() - 30 * 24 * 60 * 60 * 1000).catch(() => {
      // A failed prune leaves correct rows, just stale ones; the next tick retries.
    });
  }, 5 * 60_000);
  sweep.unref?.();
}

server.listen(config.port, config.host, () => {
  const assetBackend = assetService.describe().blobs;
  console.log(
    `[lucent] server on http://${config.host}:${config.port} ` +
      `(provider: ${provider.name}, ` +
      `limits: ${limits.perWindow}/${Math.round(limits.windowMs / 1000)}s, ${limits.perDay}/day, ` +
      `auth: ${config.requireAuth ? "required" : "optional"}, ` +
      `storage: ${db ? "postgres" : "in-memory"}, ` +
      `billing: ${billing ? "stripe" : "off"}, ` +
      `assets: ${assetBackend}, ` +
      `trustProxy: ${config.trustProxy ? "on" : "off"}, ` +
      `realtime: /ws)`,
  );
});

let shuttingDown = false;
/** Close listeners, the WebSocketServer, and the connection pool so a restart doesn't leak sockets. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lucent] received ${signal}, shutting down…`);
  clearInterval(pruneTimer);
  realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) await closeDb(db);
  console.log("[lucent] shutdown complete");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
