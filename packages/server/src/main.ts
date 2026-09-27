import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { selectImageProvider } from "./image.js";
import { selectVectorProvider } from "./vector.js";
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
import { PostgresRateLimiter } from "./rateStore.js";
import { InMemoryTicketStore } from "./realtimeTicket.js";
import { InMemoryJobQueue, JobRunner, PostgresJobQueue, type JobQueue } from "./jobs.js";
import {
  enqueueRecurring,
  familiesFor,
  parseRole,
  runsJobs,
  runsScheduler,
  servesHttp,
  workerId,
} from "./roles.js";
import { buildAiHandlers } from "./workers/ai.js";
import { buildMediaHandlers } from "./workers/media.js";
import { buildIntegrationHandlers } from "./workers/integration.js";
import { connectionFailure } from "./integrations/health.js";
import { httpSlackPoster } from "./integrations/slack.js";
import { oauthFromEnv, withCredential } from "./integrations/oauth.js";
import { tokenBox } from "./integrations/tokenBox.js";
import { InMemoryIntegrationCredentialStore } from "./integrations/credentials.js";
import { PostgresIntegrationCredentialStore } from "./store/pg-integration-credentials.js";

/**
 * docs/26 A5: OAuth connect for Linear/Jira — only with a token key
 * (LUCENT_TOKEN_KEY) to seal what the providers hand over, and an app
 * (LUCENT_LINEAR_CLIENT_ID/SECRET, LUCENT_JIRA_CLIENT_ID/SECRET). A malformed
 * key stops the boot: a server that can't seal tokens must not take them.
 */
function oauthBundle(
  credentials: import("./integrations/credentials.js").IntegrationCredentialStore,
): { oauth?: import("./integrations/oauth.js").OAuthDeps } {
  const oauth = oauthFromEnv(process.env, tokenBox(process.env.LUCENT_TOKEN_KEY), credentials);
  return oauth ? { oauth } : {};
}
import { boardNodeIssue, pollInbound } from "./integrations/poll.js";
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
import { PostgresMeetingNotesStore } from "./store/pg-meeting-notes.js";
import { InMemoryProjectStore } from "./projects.js";
import { InMemoryStatementIndexStore } from "./statementIndex.js";
import { PostgresProjectStore } from "./store/pg-projects.js";
import { PostgresStatementIndexStore } from "./store/pg-statement-index.js";
import { InMemoryAiRunStore } from "./aiRuns.js";
import { PostgresAiRunStore } from "./store/pg-ai-runs.js";
import { InMemoryThreadStore } from "./threads.js";
import { PostgresThreadStore } from "./store/pg-threads.js";
import { InMemoryMeetingNotesStore } from "./meetingNotes.js";
import { InMemoryProposalStore } from "./proposals.js";
import { PostgresProposalStore } from "./store/pg-proposals.js";
import { PostgresAssetStore } from "./store/pg-assets.js";
import { InMemorySsoStore } from "./ssoStore.js";
import {
  InMemoryIntegrationActionStore,
  InMemoryIntegrationStore,
} from "./integrations/integrations.js";
import { InMemoryExecutionLedger } from "./integrations/ledger.js";
import { InMemoryIntegrationWebhookEventStore } from "./integrations/webhook.js";
import { InMemoryInboundChangeStore, ingestInboundChange } from "./integrations/inbound.js";
import {
  PostgresExecutionLedger,
  PostgresIntegrationActionStore,
  PostgresIntegrationStore,
  PostgresIntegrationWebhookEventStore,
  PostgresInboundChangeStore,
} from "./store/pg-integrations.js";
import { FakeProvider } from "./integrations/fake.js";
import { linearConnectionFactory } from "./integrations/linear.js";
import { githubConnectionFactory } from "./integrations/github.js";
import { jiraConnectionFactory } from "./integrations/jira.js";
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
  meetingNotes: import("./meetingNotes.js").MeetingNotesStore;
  projects: import("./projects.js").ProjectStore;
  statementIndex: import("./statementIndex.js").StatementIndexStore;
  aiRuns: import("./aiRuns.js").AiRunStore;
  threads: import("./threads.js").ThreadStore;
  /** F1: SSO connections + domain claims, on the same store-per-database rule. */
  ssoStore: import("./ssoStore.js").SsoStore;
  /** Stage B3: review-gate proposals — in-memory for dev, Postgres when set. */
  proposals: import("./proposals.js").ProposalStore;
  /** Stage D6: integrations — the store pair is per-branch (InMemory for
   * dev, Postgres when the database is set); the provider factories are
   * env-independent (the credential resolves per-connection). */
  integrations: {
    store: import("./integrations/integrations.js").IntegrationStore;
    providers: Map<string, import("./integrations/provider.js").ExecutionProviderFactory>;
    actions: import("./integrations/integrations.js").IntegrationActionStore;
    ledger: import("./integrations/ledger.js").ExecutionLedger;
    /** Stage D7: the webhook delivery ledger + the inbound queue. */
    webhookEvents: import("./integrations/webhook.js").IntegrationWebhookEventStore;
    inbound: import("./integrations/inbound.js").InboundChangeStore;
    slack: import("./integrations/slack.js").SlackPoster;
    oauth?: import("./integrations/oauth.js").OAuthDeps;
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
      meetingNotes: new InMemoryMeetingNotesStore(),
      projects: new InMemoryProjectStore(),
      statementIndex: new InMemoryStatementIndexStore(),
      aiRuns: new InMemoryAiRunStore(),
      threads: new InMemoryThreadStore(),
      ssoStore: new InMemorySsoStore(),
      integrations: {
        store: new InMemoryIntegrationStore(),
        providers: new Map<string, import("./integrations/provider.js").ExecutionProviderFactory>([
          // ONE instance, like every other store in main: the fake's wire is
          // its own memory, so a per-resolution instance would hand every
          // request a fresh (amnesiac) external system — links would dangle
          // and the recovery contract would be undemonstrable live (found
          // by the D10 live pass).
          [
            "fake",
            (() => {
              const fake = new FakeProvider();
              return () => fake;
            })(),
          ],
          ["linear", linearConnectionFactory()],
          ["github", githubConnectionFactory()],
          ["jira", jiraConnectionFactory()],
        ]),
        actions: new InMemoryIntegrationActionStore(),
        ledger: new InMemoryExecutionLedger(),
        // Stage D7: the webhook delivery ledger + the inbound queue.
        webhookEvents: new InMemoryIntegrationWebhookEventStore(),
        inbound: new InMemoryInboundChangeStore(),
        slack: httpSlackPoster(),
        // docs/26 A5: OAuth connect, when the server has a token key and an app.
        ...oauthBundle(new InMemoryIntegrationCredentialStore()),
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
    meetingNotes: new PostgresMeetingNotesStore(target),
    projects: new PostgresProjectStore(target),
    statementIndex: new PostgresStatementIndexStore(target),
    aiRuns: new PostgresAiRunStore(target),
    threads: new PostgresThreadStore(target),
    ssoStore: new PostgresSsoStore(target),
    proposals: new PostgresProposalStore(target),
    assetStore: new PostgresAssetStore(target),
    // Stage D6: the PG pairs (ADR 0032) — connections/links, action
    // records, the execution ledger; the factories stay env-independent
    // (the per-org credential resolves through the connection at call time).
    integrations: {
      store: new PostgresIntegrationStore(target.db),
      providers: new Map<string, import("./integrations/provider.js").ExecutionProviderFactory>([
        // Same one-instance rule as the in-memory path (see the note there).
        [
          "fake",
          (() => {
            const fake = new FakeProvider();
            return () => fake;
          })(),
        ],
        ["linear", linearConnectionFactory()],
        ["github", githubConnectionFactory()],
        ["jira", jiraConnectionFactory()],
      ]),
      actions: new PostgresIntegrationActionStore(target.db),
      ledger: new PostgresExecutionLedger(target.db),
      // Stage D7: the webhook delivery ledger + the inbound queue (the PG
      // pairs, migration 0021).
      webhookEvents: new PostgresIntegrationWebhookEventStore(target.db),
      inbound: new PostgresInboundChangeStore(target.db),
      // docs/26 A5: Slack, outbound — meeting summaries to a channel.
      slack: httpSlackPoster(),
      ...oauthBundle(new PostgresIntegrationCredentialStore(target.db)),
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
// Provider roulette guard (2026-09-17: `kilo-auto` resolved to a different
// model mid-session and once returned zero ops on a vague prompt). The pin
// lives in LUCENT_AI_MODEL; this line makes the effective choice visible in
// every boot log so a drift is noticed in the logs, not mid-session.
console.log(
  `[lucent] ai provider=${provider.name} model=${process.env.LUCENT_AI_MODEL ?? "(provider default)"}`,
);
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
// P5 (docs/20): with Postgres configured, rate limiting is SHARED. The
// in-process `Limiter` is per-process, so two API replicas behind one
// balancer each grant the full window — the auth limiter included, which is
// the brute-force guard on login. The Postgres counter is consulted instead,
// and the in-memory one stays the honest single-instance path.
const sharedLimiter = db
  ? new PostgresRateLimiter(db, {
      perWindow: config.authLimiter.perWindow,
      windowMs: config.authLimiter.windowMs,
    })
  : undefined;
// M3 follow-up (docs/20 P5): with Postgres configured and two instances
// behind one balancer, a ticket minted on A must work when the upgrade lands
// on B — the PgTicketStore makes mint/consume cross-instance while keeping
// single-use (the DELETE ... RETURNING is the atomic claim). Single-process
// and offline dev keep the in-memory store: no database, no table needed.
const tickets: import("./realtimeTicket.js").TicketStore = db
  ? new (await import("./realtimeTicket.js")).PgTicketStore(db, config.realtimeTicketTtlMs)
  : new InMemoryTicketStore(config.realtimeTicketTtlMs);

// P2 (docs/20): the outbox and its dispatcher. Durable when Postgres is
// configured — the whole point is that a committed change and its
// announcement cannot disagree, which needs a table. Without a database there
// is no transaction to join and nothing a crash could lose, so the in-memory
// twin is the honest degradation (ADR 0006's optional-store rule).
//
// The dispatcher runs every second and drains a bounded batch. It is
// deliberately in-process here; P3 moves it under the worker role, at which
// point this becomes the `LUCENT_ROLE=all` fallback.
//
// NOTE (reserved, not broken): no consumer is registered yet, so drained
// events are marked dispatched with zero handlers run (outbox.ts documents
// the rule). Consumers arrive with the workloads that need them — search
// projections, notifications fan-out, the finalize pass — each as its own
// `dispatcher.subscribe` with idempotent handling, never speculative wiring
// ahead of a reader. The first real producer (the image job's AssetStored
// announcement) already flows through here for exactly that reason.
const outbox: import("./outbox.js").OutboxStore = db
  ? new (await import("./outbox.js")).PostgresOutbox(db)
  : new (await import("./outbox.js")).InMemoryOutbox();
const outboxDispatcher = new (await import("./outbox.js")).OutboxDispatcher({ store: outbox });

// The job queue (P3). Built here, beside the outbox, so the outbox's
// consumers can queue work before the dispatcher starts: an event drained
// with no consumer registered is marked dispatched and gone.
const jobQueue: JobQueue = db ? new PostgresJobQueue(db) : new InMemoryJobQueue();

// docs/28 A3.3 — the outbox's first consumer. A meeting that ended queues its
// end-of-meeting summary as an AI-family job: retried with backoff, and
// deduped per meeting so an at-least-once redelivery queues nothing new.
outboxDispatcher.subscribe("MeetingEnded", async (event) => {
  const meetingId = event.payload.meetingId;
  if (typeof meetingId !== "string" || !event.boardId) return;
  await jobQueue.enqueue({
    type: "meeting.recap",
    family: "ai",
    payload: { boardId: event.boardId, meetingId },
    dedupeKey: `meeting.recap:${meetingId}`,
  });
  // docs/26 A5: the turns nobody extracted, proposed — when the org's rule
  // is on (the job reads it when it runs, so turning it off stops this).
  await jobQueue.enqueue({
    type: "meeting.extract",
    family: "ai",
    payload: { boardId: event.boardId, meetingId },
    dedupeKey: `meeting.extract:${meetingId}`,
  });
});

// docs/26 A5: decisions approved in Review may plan themselves (the org's rule).
outboxDispatcher.subscribe("DecisionApproved", async (event) => {
  const { nodeIds, by } = event.payload as { nodeIds?: unknown; by?: unknown };
  if (
    !event.boardId ||
    typeof by !== "string" ||
    !Array.isArray(nodeIds) ||
    !nodeIds.every((id) => typeof id === "string")
  ) {
    return;
  }
  await jobQueue.enqueue({
    type: "decision.plan",
    family: "ai",
    payload: { boardId: event.boardId, nodeIds, by },
    dedupeKey: `decision.plan:${event.id}`,
  });
});

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

// P4: hoisted so the AI worker family's image job can hold the same provider
// instance the route uses. One provider object, chosen once: the worker path
// and the request path must bill and behave identically.
const imageProvider = selectImageProvider();
// docs/26 §6.3 V3: Recraft when LUCENT_RECRAFT_API_KEY is set, the offline mock
// otherwise, none with LUCENT_VECTOR_PROVIDER=off.
const vectorProvider = selectVectorProvider();
console.log(`[lucent] vector: ${vectorProvider ? vectorProvider.name : "off"}`);

const { server, realtime, writeMeetingRecap, automations } = createApp({
  config,
  provider,
  imageProvider,
  vectorProvider,
  // docs/25 V1: server-hosted diarizing STT. Key + URL mean a live sidecar;
  // anything less is the standby mock and the STT routes answer 503.
  stt: (await import("./stt.js")).selectSttService(process.env),
  // docs/25 V7: server voice synthesis. Same doctrine as STT.
  tts: (await import("./tts.js")).selectTtsService(process.env),
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
  meetingNotes: stores.meetingNotes,
  projects: stores.projects,
  statementIndex: stores.statementIndex,
  aiRuns: stores.aiRuns,
  threads: stores.threads,
  // docs/28 A3.3: ending a meeting announces MeetingEnded here.
  outbox,
  // docs/28 A3.2: host powers in the board call, over the same LiveKit project.
  ...(config.livekit.apiKey && config.livekit.apiSecret && config.livekit.url
    ? {
        callControl: (await import("./calls.js")).createLiveKitCallControl({
          apiKey: config.livekit.apiKey,
          apiSecret: config.livekit.apiSecret,
          url: config.livekit.url,
        }),
      }
    : {}),
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
  sharedLimiter,
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
// limiter entries are pruned on the same tick. The ticket prune is async
// (the Postgres store's DELETE); it is fire-and-forget like the sweeps —
// a failed tick retries on the next one, and expired rows are inert.
const pruneTimer = setInterval(() => {
  usage.prune();
  authLimiter.prune();
  void tickets.prune();
}, 10 * 60_000);
pruneTimer.unref?.();

// P2: start the outbox drain. Every second, a bounded batch; a no-op tick
// costs one indexed SELECT of zero rows. Started here (not at construction)
// so the store exists before anything can be queued against it.
outboxDispatcher.start();

// M4.3: the webhook sweep. Stripe redelivers for ~3 days; this is what picks
// up the rows that outlive those retries, plus deliveries whose worker died
// mid-handler. Bounded per run so one bad week cannot become one long catch-up
// storm after a deploy. Terminal rows older than 30 days are pruned on the
// same tick — Stripe stops serving the event after ~30 days, so an older
// failed row can never be replayed and is kept only by `failed`-preservation
// in `prune` beyond that (events.ts), which this call does not touch.
//
// P3 (docs/20): this body is now a named function driven by the job queue
// rather than a `setInterval` arm, so N API replicas no longer run N sweeps.
async function sweepStripe(): Promise<void> {
  if (!billing) return;
  await sweepStripeEvents({
    store: billing.events,
    dispatcher: billing.dispatcher,
    events: stripeEventLookup(billing.client),
    logger,
    limit: 50,
  });
  await billing.events.prune(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

// Stage D6 (ADR 0032): the execution-ledger sweeper — the stuck-row
// recovery, on the same interval-and-unref pattern. A crashed executor
// leaves a `received` row past the stale window (or a `failed` row,
// immediately reclaimable); the sweep re-claims through the same claim()
// call (the race-safe path), re-runs the item through the provider with
// the SAME idempotency key, and marks applied. The replay source is the
// pending action record's stored items — the payload IS the record.
//
// D10, ADR 0036 — THE LEDGER RETENTION DECISION (the review's Option B):
// execution-ledger rows are retained INDEFINITELY. They are the
// authoritative idempotency/audit substrate — the duplicate-approval and
// sweep-replay guarantees read them for the lifetime of the board, and
// pruning them would weaken the exactly-once contract. The volume is
// bounded by actions-per-board, not events. Revisit trigger (its own ADR
// if it ever fires): a measured storage problem, with the applied rows'
// externalId preserved as the link of record.
//
// P3 (docs/20): named, and driven by the job queue. The three arms (execution
// recovery, webhook retry + link-GC, terminal prune) stay in one function
// because they shared one timer and one family.
async function sweepIntegration(): Promise<void> {
  try {
    const stale = Date.now() - 60_000;
    const pending = await stores.integrations.ledger.pending(stale, Date.now(), 50);
    for (const row of pending) {
      const record = await stores.integrations.actions.action(row.boardId, row.lucentActionId);
      if (!record || record.status !== "approved") continue;
      const item = record.items.find((i) => i.nodeId === row.nodeId);
      if (!item) continue;
      const claim = await stores.integrations.ledger.claim({
        boardId: row.boardId,
        provider: row.provider,
        requestId: row.requestId,
        lucentActionId: row.lucentActionId,
        nodeId: row.nodeId,
      });
      if (claim.outcome !== "claimed") continue;
      try {
        const connection = await stores.integrations.store.connection(record.orgId, row.provider);
        if (!connection || connection.status !== "active") continue;
        const factory = stores.integrations.providers.get(row.provider);
        if (!factory) continue;
        const provider = factory(connection);
        // The recovery-first retry (ADR 0032's contract): reconcile before
        // re-creating — recoverCreate(marker) finds an issue the lost
        // response hid; only a not-found retries the create.
        let task;
        if (item.action === "create" && provider.recoverCreate) {
          const recovered = await provider.recoverCreate(
            `<!-- lucent-action:${item.idempotencyKey} -->`,
          );
          task =
            recovered ??
            (await provider.createTask({
              title: item.title,
              ...(item.assignee ? { assignee: item.assignee } : {}),
              ...(item.dueDate ? { dueDate: item.dueDate } : {}),
              status: item.status,
              idempotencyKey: item.idempotencyKey,
            }));
        } else if (item.action === "update") {
          task = await provider.updateTask(item.externalId!, {
            title: item.title,
            ...(item.assignee ? { assignee: item.assignee } : {}),
            ...(item.dueDate ? { dueDate: item.dueDate } : {}),
            status: item.status,
          });
        } else {
          task = await provider.createTask({
            title: item.title,
            ...(item.assignee ? { assignee: item.assignee } : {}),
            ...(item.dueDate ? { dueDate: item.dueDate } : {}),
            status: item.status,
            idempotencyKey: item.idempotencyKey,
          });
        }
        await stores.integrations.store.linkTask(
          {
            orgId: record.orgId,
            boardId: row.boardId,
            nodeId: item.nodeId,
            provider: row.provider as never,
            externalId: task.externalId,
            ...(task.url ? { url: task.url } : {}),
            lastSyncedStatus: task.status,
          },
          Date.now(),
        );
        await stores.integrations.ledger.applied(
          row.boardId,
          row.provider,
          row.requestId,
          task.externalId,
          Date.now(),
        );
      } catch (err) {
        await stores.integrations.ledger.failed(
          row.boardId,
          row.provider,
          row.requestId,
          (err as Error).message,
          Date.now(),
        );
        logger.error("integrations.sweep.item", {
          error: (err as Error).message,
          provider: row.provider,
        });
      }
    }
  } catch (err) {
    logger.error("integrations.sweep.failed", { error: (err as Error).message });
  }

  // The D7 arm: pending webhook deliveries. The Stripe-refetch doctrine,
  // adapted — Linear has no fetch-by-event-id API, so a stale delivery is
  // recovered by REFETCHING the current truth: resolve the provider, getTask
  // the external id, and ingest what it says NOW. A replayed stale event can
  // never resurrect an old value this way; the current state supersedes it.
  try {
    const staleAt = Date.now() - 60_000;
    const pending = await stores.integrations.webhookEvents.pending(staleAt, Date.now(), 20);
    for (const row of pending) {
      const reclaimer = await stores.integrations.webhookEvents.claim({
        id: row.id,
        provider: row.provider,
        orgId: row.orgId,
        externalId: row.externalId,
        now: Date.now(),
        staleAfterMs: 60_000,
      });
      if (reclaimer.outcome !== "claimed" || !row.externalId || !row.orgId) continue;
      try {
        const connection = await stores.integrations.store.connection(row.orgId, row.provider);
        if (!connection || connection.status !== "active") continue;
        const factory = stores.integrations.providers.get(row.provider);
        if (!factory) continue;
        const provider = factory(await withCredential(stores.integrations.oauth, connection));
        const task = await provider.getTask(row.externalId);
        // docs/26 A5: the connection answered.
        await stores.integrations.store.recordCall(
          row.orgId,
          row.provider,
          { ok: true },
          Date.now(),
        );
        const ingested = await ingestInboundChange(
          {
            linksForExternalId: (p, externalId) =>
              stores.integrations.store.linksForExternalId(p, externalId),
            boardNodeStatus: async (boardId, nodeId) => {
              const board = await stores.boardStore.get(boardId);
              if (!board) return null;
              return board.workspace.nodes[nodeId]?.issue?.status ?? null;
            },
            boardNodeIssue: (boardId, nodeId) => boardNodeIssue(stores.boardStore, boardId, nodeId),
            store: stores.integrations.inbound,
            provider,
          },
          // The task as it is now: its owner and due date too (docs/26 A5).
          {
            provider: row.provider,
            externalId: row.externalId,
            status: task.status,
            assignee: task.assignee ?? null,
            dueDate: task.dueDate ?? null,
          },
          row.orgId,
        );
        // docs/26 A5: "done" in the tracker closes the work where the org allows it.
        await automations.closeFromTracker(ingested.records);
        await stores.integrations.webhookEvents.markProcessed(row.id, row.orgId, Date.now());
      } catch (err) {
        await stores.integrations.webhookEvents.markFailed(
          row.id,
          (err as Error).message.slice(0, 300),
          Date.now(),
        );
        // docs/26 A5: a failure of the connection (not of one issue) is its health.
        const failed = connectionFailure(err);
        if (failed) {
          await stores.integrations.store
            .recordCall(row.orgId, row.provider, failed, Date.now())
            .catch(() => {});
        }
        logger.error("integrations.sweep.webhook", {
          error: (err as Error).message,
          provider: row.provider,
        });
      }
    }
  } catch (err) {
    logger.error("integrations.sweep.webhooks.failed", { error: (err as Error).message });
  }

  // THE LINK-GC ARM (D10, ADR 0036 — the decision the sweep has "owned"
  // since D5): a dead link is one whose BOARD is missing or whose NODE is
  // gone from the board. Links are sync state, not audit (unlike
  // connections, which are disable-not-delete): a re-created node re-links
  // through the create-side recovery contract, so collecting the stale row
  // never orphans an external task. Bounded: linksForOrg caps the feed;
  // the org set comes from the connection store (only orgs WITH
  // integrations can have links).
  try {
    for (const providerName of stores.integrations.providers.keys()) {
      const connections = await stores.integrations.store.connectionsFor(providerName);
      const orgIds = new Set(connections.map((c) => c.orgId));
      for (const orgId of orgIds) {
        const links = await stores.integrations.store.linksForOrg(orgId, 500);
        for (const link of links) {
          const board = await stores.boardStore.get(link.boardId);
          // Board missing (deleted) → dead.
          if (!board) {
            await stores.integrations.store.unlink(link.boardId, link.nodeId, link.provider);
            logger.info("integrations.gc.link", {
              boardId: link.boardId,
              nodeId: link.nodeId,
              provider: link.provider,
              reason: "board missing",
            });
            continue;
          }
          // Node missing (deleted) → dead.
          if (!board.workspace.nodes[link.nodeId]) {
            await stores.integrations.store.unlink(link.boardId, link.nodeId, link.provider);
            logger.info("integrations.gc.link", {
              boardId: link.boardId,
              nodeId: link.nodeId,
              provider: link.provider,
              reason: "node missing",
            });
          }
        }
      }
    }
  } catch (err) {
    logger.error("integrations.sweep.gc.failed", { error: (err as Error).message });
  }

  // THE TERMINAL-ROW PRUNE (D10, ADR 0036): webhook events and inbound
  // changes accumulate forever without it. Terminal rows older than 30
  // days are deleted — the complete terminal sets (failed is retryable and
  // NEVER pruned); the cutoff is the TERMINAL timestamp, so pending rows
  // are structurally safe. Bounded per run.
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const prunedEvents = await stores.integrations.webhookEvents.pruneTerminal(cutoff, 1000);
    const prunedChanges = await stores.integrations.inbound.pruneTerminal(cutoff, 1000);
    if (prunedEvents > 0 || prunedChanges > 0) {
      logger.info("integrations.prune", { prunedEvents, prunedChanges });
    }
  } catch (err) {
    logger.error("integrations.sweep.prune.failed", { error: (err as Error).message });
  }
}

// P3 (docs/20, advisory §8/§9): roles. `LUCENT_ROLE=api` serves traffic and
// runs no sweeps; `worker` claims jobs and serves nothing; `scheduler`
// enqueues the recurring work; `all` (the default, and single-process dev)
// does everything in-process, which is what keeps the compose file's
// one-server mode working exactly as it did before this phase.
//
// The scheduler is leaderless: it enqueues with a dedupe key, and the queue's
// partial unique index makes a second scheduler's enqueue a no-op. That is
// why there is no leader election here — the claim already provides it.
const role = parseRole(process.env.LUCENT_ROLE);
// (jobQueue is built beside the outbox above, so its consumers can queue work.)

async function runSchedulerTick(): Promise<void> {
  try {
    await enqueueRecurring(jobQueue);
  } catch (err) {
    logger.error("scheduler.enqueue.failed", { error: (err as Error).message });
  }
}

if (runsScheduler(role)) {
  const schedulerTimer = setInterval(() => {
    void runSchedulerTick();
  }, 30_000);
  schedulerTimer.unref?.();
  // One immediate pass so a fresh deploy does not wait a full interval.
  void runSchedulerTick();
}

const jobRunner = runsJobs(role)
  ? new JobRunner({
      queue: jobQueue,
      workerId: workerId(role === "all" ? "inproc" : "worker"),
      handlers: {
        // The sweeps, now named jobs instead of anonymous timers.
        "sweep-stripe": async () => void (await sweepStripe()),
        "sweep-execution": async () => void (await sweepIntegration()),
        "sweep-webhooks": async () => void (await sweepIntegration()),
        // P4: the worker families. The AI family's image job is the one with
        // real work today; media and integration ship their claim paths with
        // reserved bodies (docs/20 P4 says so explicitly).
        ...buildAiHandlers({
          imageProvider,
          outbox,
          logger: { info: (e, f) => logger.info(e, f) },
        }),
        ...buildMediaHandlers({ logger: { info: (e, f) => logger.info(e, f) } }),
        ...buildIntegrationHandlers({
          logger: { info: (e, f) => logger.info(e, f) },
          // docs/26 A5: read linked tasks through each active connection —
          // how Jira's changes arrive, and a net under missed webhooks.
          poll: () =>
            pollInbound({
              store: stores.integrations.store,
              inbound: stores.integrations.inbound,
              providers: stores.integrations.providers,
              boardStore: stores.boardStore,
              ...(stores.integrations.oauth ? { oauth: stores.integrations.oauth } : {}),
              afterQueued: (records) => automations.closeFromTracker(records),
              logger: { warn: (e, f) => logger.warn(e, f) },
            }),
        }),
        "prune-jobs": async () => {
          if (jobQueue instanceof PostgresJobQueue) {
            await jobQueue.prune(30 * 24 * 60 * 60 * 1000);
          }
        },
        "prune-outbox": async () => {
          if (outbox instanceof (await import("./outbox.js")).PostgresOutbox) {
            await outbox.prune(7 * 24 * 60 * 60 * 1000);
          }
        },
        "prune-usage": () => {
          usage.prune();
          authLimiter.prune();
          void tickets.prune();
        },
        // docs/24 Phase H: per-org transcript retention. No-op without both
        // stores (family rule: unconfigured work completes, never fails).
        "sweep-retention": async () => {
          if (!stores.orgStore || !stores.meetings) return;
          const { sweepRetentionTranscripts } = await import("./sweeps.js");
          const { orgsChecked, transcriptsDeleted } = await sweepRetentionTranscripts({
            orgs: stores.orgStore,
            meetings: stores.meetings,
          });
          if (transcriptsDeleted > 0) {
            logger.info("retention.swept-transcripts", { orgsChecked, transcriptsDeleted });
          }
        },
        // docs/28 F14: end captures a closed or crashed tab left open.
        "sweep-idle-captures": async () => {
          if (!stores.meetings) return;
          const { sweepIdleCaptures } = await import("./sweeps.js");
          const ended = await sweepIdleCaptures({ meetings: stores.meetings });
          if (ended > 0) logger.info("meetings.ended-idle", { ended });
        },
        // docs/28 A3.3: the end-of-meeting summary, queued by the MeetingEnded
        // consumer. A throw fails the attempt; the queue retries with backoff.
        "meeting.recap": async (job) => {
          const { boardId, meetingId } = job.payload as { boardId?: unknown; meetingId?: unknown };
          if (typeof boardId !== "string" || typeof meetingId !== "string") return;
          const result = await writeMeetingRecap(boardId, meetingId);
          logger.info("meetings.recap", { meetingId, outcome: result.outcome });
        },
        // docs/26 A5, automation v1. Each reads the org's rule when it runs.
        "meeting.extract": async (job) => {
          const { boardId, meetingId } = job.payload as { boardId?: unknown; meetingId?: unknown };
          if (typeof boardId !== "string" || typeof meetingId !== "string") return;
          const result = await automations.extractMeetingRest(boardId, meetingId);
          logger.info("automation.meeting-extract", { meetingId, outcome: result.outcome });
        },
        "decision.plan": async (job) => {
          const { boardId, nodeIds, by } = job.payload as {
            boardId?: unknown;
            nodeIds?: unknown;
            by?: unknown;
          };
          if (typeof boardId !== "string" || typeof by !== "string" || !Array.isArray(nodeIds)) {
            return;
          }
          const result = await automations.planDecisions(boardId, nodeIds as string[], by);
          logger.info("automation.decision-plan", { boardId, outcome: result.outcome });
        },
        "sweep-overdue": async () => {
          const { told } = await automations.sweepOverdue();
          if (told > 0) logger.info("automation.overdue-told", { told });
        },
      },
      ...(familiesFor(role, process.env.LUCENT_JOB_FAMILIES)
        ? { families: familiesFor(role, process.env.LUCENT_JOB_FAMILIES)! }
        : {}),
    })
  : null;
jobRunner?.start();

// P3: a worker or scheduler process serves NO traffic. Opening the port anyway
// would make it a second API instance the load balancer can route to — and it
// has no session store wiring for that, so the failure would be mysterious
// rather than loud.
if (servesHttp(role)) {
  server.listen(config.port, config.host, () => {
    const assetBackend = assetService.describe().blobs;
    console.log(
      `[lucent] server on http://${config.host}:${config.port} ` +
        `(role: ${role}, ` +
        `provider: ${provider.name}, ` +
        `limits: ${limits.perWindow}/${Math.round(limits.windowMs / 1000)}s, ${limits.perDay}/day, ` +
        `auth: ${config.requireAuth ? "required" : "optional"}, ` +
        `storage: ${db ? "postgres" : "in-memory"}, ` +
        `billing: ${billing ? "stripe" : "off"}, ` +
        `assets: ${assetBackend}, ` +
        `trustProxy: ${config.trustProxy ? "on" : "off"}, ` +
        `realtime: /ws)`,
    );
  });
} else {
  console.log(
    `[lucent] ${role} process started (no HTTP listener; ` +
      `storage: ${db ? "postgres" : "in-memory"}, jobs: ${jobRunner ? "on" : "off"})`,
  );
}

let shuttingDown = false;
/** Close listeners, the WebSocketServer, and the connection pool so a restart doesn't leak sockets. */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[lucent] received ${signal}, shutting down…`);
  clearInterval(pruneTimer);
  // Drain once before closing the pool: a committed event that has not been
  // delivered is the one thing this process is holding that a restart would
  // otherwise have to wait a full interval to pick up.
  outboxDispatcher.stop();
  await outboxDispatcher.tick().catch(() => undefined);
  realtime.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db) await closeDb(db);
  console.log("[lucent] shutdown complete");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[lucent] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[lucent] uncaught exception:", err);
});
