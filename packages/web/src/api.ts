import type { Operation, Workspace } from "@lucent/core";
import { recentHistory, summarizeWorkspace } from "@lucent/ai";
import type { DocumentAttachment, ImageAttachment } from "@lucent/ai";
import type { ChatEntry } from "./persistence.js";
import { apiFetch } from "./http.js";

/**
 * Client-side call to our own /api/generate. The browser never sees an API key;
 * it sends the message, a compact workspace summary and recent conversation
 * turns, and receives validated operations back (docs/09 §5).
 *
 * Both calls below go through `apiFetch` because both are POSTs behind the
 * server CSRF guard: the hand-rolled `fetch` calls they replaced sent the
 * session cookie with no `x-csrf-token` header, so the product main
 * generation loop 403d for every cookie-authenticated user.
 */

export interface GenerateResponse {
  operations: Operation[];
  explanation: string | null;
  /** What Lucent says back in a voice conversation; absent from older servers. */
  reply?: string | null;
  /** Clarification question and options when intent is ambiguous. */
  clarification?: import("@lucent/core").ClarificationChoice | null;
  provider: string;
  /** How much of the monthly allowance is left, or null when none was reported. */
  allowance: Allowance | null;
  /**
   * Operations the server skipped during partial application (M1): each
   * carries the validator's own reason. Undefined on a clean batch. The
   * chat surfaces these so the user knows what didn't land — and can ask
   * Lucent to fix just those, instead of losing the whole generation the way
   * the old all-or-nothing 422 did.
   */
  warnings?: Array<{ op: string; reason: string }>;
  /**
   * ADR 0047: the AI run this answer is, for committing its operations under
   * (the log then records AI, asked for and approved by this person). Absent
   * from older servers and from anonymous use.
   */
  runId?: string;
}

/** What an AI run is for: the board the person is on, and where they asked. */
export interface RunContext {
  boardId?: string;
  surface?: "canvas" | "meeting" | "voice";
}

/**
 * The machine-readable half of a 402 refusal, mirroring `RefusalBody` in
 * `packages/server/src/entitlements.ts`. Declared here rather than imported: the
 * browser bundle does not depend on the server package, so the wire contract is
 * copied on purpose, pinned by the reference above.
 *
 * Every field is nullable even though the server always sends them, because this
 * is parsed from a body a proxy, an outage page or an older build may have
 * mangled -- and a refusal we can only half-read still has to be *recognisable*
 * as a billing refusal instead of collapsing into a generic failure.
 */
export interface PlanRefusal {
  /**
   * `plan_limit` = the tier includes this and it is used up; `plan_feature` =
   * the tier never included it. A customer reads those two differently, so the
   * distinction survives the parse rather than being flattened into the message.
   */
  reason: "plan_limit" | "plan_feature" | null;
  /**
   * Which entitlement was hit (`ai.generationsPerMonth`, `seats`, ...). A plain
   * string rather than a copy of the server's union: a key added next quarter
   * must not parse to "no key at all" in the one message whose whole job is to
   * explain which ceiling was reached.
   */
  key: string | null;
  plan: string | null;
  planName: string | null;
  /** The ceiling hit and the usage against it; both null for a feature refusal. */
  limit: number | null;
  used: number | null;
  /**
   * Where to send someone who wants to upgrade. Not defaulted to a hard-coded
   * path when it is missing: the server treats this as deployment config, and a
   * link to a route this deployment does not host is worse than no link at all.
   */
  upgradeUrl: string | null;
  /** Cheapest tier that raises this limit; null means sales has to be involved. */
  suggestedPlan: string | null;
  /** Epoch ms when a monthly allowance returns; null for a standing limit. */
  resetsAt: number | null;
}

/**
 * A 402 from an entitlement gate (M4). An `Error` subclass rather than a second
 * return channel: every caller of this module already renders
 * `(err as Error).message` -- `workspace.tsx` into a chat entry, `CanvasView`
 * into a toast -- and they keep doing exactly that, because the server's
 * sentence *is* the message. The structured fields ride along on the instance,
 * so whoever builds the upgrade affordance narrows with `planRefusal(err)`
 * instead of a parallel error path existing for the one status that has one.
 */
export class PlanRefusalError extends Error {
  readonly refusal: PlanRefusal;

  constructor(message: string, refusal: PlanRefusal) {
    super(message);
    // Subclassing `Error` leaves `name` as "Error", and that is a worse clue
    // than "PlanRefusalError" in a log when a gate fires unexpectedly.
    this.name = "PlanRefusalError";
    this.refusal = refusal;
  }
}

/**
 * The refusal behind a thrown failure, or null when the plan was not the reason.
 * The narrowing lives here so a caller never has to import the class to ask, and
 * so `instanceof` stays this module's problem.
 */
export function planRefusal(err: unknown): PlanRefusal | null {
  return err instanceof PlanRefusalError ? err.refusal : null;
}

/**
 * The other half of the same gate: what an *allowed* response reports about how
 * much of the allowance is left, mirroring `AllowanceHint` in
 * `packages/server/src/entitlements.ts`. Copied rather than imported for the
 * reason `PlanRefusal` is, and nullable field by field for the same one.
 *
 * `warn` is read, never re-derived from `limit` and `used`. The server owns the
 * fraction at which a warning starts, and a client that computed its own would
 * eventually show two different answers about one allowance on one screen -- the
 * warning next to the composer and the meter in Preferences -- the first time
 * that fraction moved on one side only.
 */
export interface Allowance {
  key: string | null;
  limit: number | null;
  /** Usage including the request that just succeeded. */
  used: number | null;
  /** null is unlimited, not spent: the two read oppositely (see billing.ts). */
  remaining: number | null;
  warn: boolean;
  resetsAt: number | null;
}

/**
 * Turn a failed response into the error to throw, so "backend not running" is
 * never reported as "the AI service is unavailable".
 *
 * Returns the `Error` rather than the message it used to return, because a 402
 * carries fields no sentence can: the subclass above is how they reach a caller
 * without a second failure channel. `what` names the calling feature for the
 * generic tail only -- every branch before it is about a layer, not a feature.
 */
async function describeFailure(res: Response, what = "Generation"): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let error = "";
  let detail = "";
  /**
   * The parsed body kept whole, not just its two strings: a 402 refusal has
   * eight more fields, and `res.text()` above already consumed the only copy of
   * the stream, so a second reader is not an option.
   */
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { error?: string; detail?: unknown };
    error = parsed.error ?? "";
    detail = typeof parsed.detail === "string" ? parsed.detail : "";
    body = parsed as Record<string, unknown>;
  } catch {
    error = raw.slice(0, 200);
  }

  if (res.status === 503 && /unreachable/i.test(error)) {
    // The dev proxy answers 503 when the backend process isn't running.
    return new Error(
      "Can't reach the Lucent server. Start it with: npm run start -w @lucent/server",
    );
  }
  if (res.status === 502 || res.status === 503) {
    // The server reached us but its upstream model provider refused.
    return new Error(
      detail
        ? `The AI provider rejected the request (${detail.slice(0, 120)}). Please try again.`
        : "The AI provider is temporarily unavailable. Please try again.",
    );
  }
  if (res.status === 402) {
    // Payment Required from an entitlement gate: the request was authorised and
    // the *plan* is what is missing, so the remedy differs from the 429 below
    // (wait) and from a 403 (ask an admin). It gets its own branch above the
    // generic tail because falling through would print the sentence and drop
    // `upgradeUrl` -- the only part of a refusal a user can act on. Every branch
    // here tests one exact status and returns, so nothing above shadows it.
    //
    // The server's sentence wins verbatim: it already names the plan, the
    // ceiling, whether it resets and which tier to buy, and re-deriving it here
    // would fork the pricing copy and go stale the first time a tier changes.
    // Read from the parsed body rather than `error`, so a proxy's HTML page falls
    // back to the generic sentence instead of being rendered as a plan message.
    const sentence = readString(body, "error");
    return new PlanRefusalError(
      sentence ?? "Your plan doesn't allow this request. Review your plan and usage to continue.",
      parsePlanRefusal(body),
    );
  }
  if (res.status === 429) {
    // The server distinguishes a short-window rate limit from the daily quota;
    // "wait a moment" is wrong advice for a quota that resets at midnight.
    const retry = Number(res.headers.get("retry-after"));
    if (/quota/i.test(error)) {
      return new Error("Daily AI request limit reached. It resets at 00:00 UTC.");
    }
    return new Error(
      Number.isFinite(retry) && retry > 0
        ? `Too many requests — try again in ${retry}s.`
        : "Too many requests in a short window. Please retry shortly.",
    );
  }
  if (res.status === 422) {
    return new Error(
      "The AI returned changes that didn't fit this board. Try rephrasing your request.",
    );
  }
  if (res.status === 404) {
    return new Error(
      "The Lucent API isn't reachable. Start the backend with: npm run start -w @lucent/server",
    );
  }
  return new Error(error ? `${what} failed: ${error}` : `${what} failed (${res.status}).`);
}

/**
 * Readers for a body we do not control. An empty string counts as absent because
 * a blank `upgradeUrl` renders as a link to nowhere, and a non-finite number
 * because `resetsAt: NaN` formats as "Invalid Date" in front of a customer.
 */
function readString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The refusal fields, each independently optional. `reason` is compared against
 * the two literals rather than cast: it is the field a caller switches on, so an
 * unexpected value has to read as "unknown" instead of passing for one of them.
 */
function parsePlanRefusal(body: Record<string, unknown>): PlanRefusal {
  const reason = body.reason;
  return {
    reason: reason === "plan_limit" || reason === "plan_feature" ? reason : null,
    key: readString(body, "key"),
    plan: readString(body, "plan"),
    planName: readString(body, "planName"),
    limit: readNumber(body, "limit"),
    used: readNumber(body, "used"),
    upgradeUrl: readString(body, "upgradeUrl"),
    suggestedPlan: readString(body, "suggestedPlan"),
    resetsAt: readNumber(body, "resetsAt"),
  };
}

/**
 * The `allowance` field of a successful response, or null when it is absent: a
 * deployment with no billing store meters nothing, and an older build or a proxy
 * may not carry it. Null is deliberately the quiet case -- a warning assembled
 * from a body we could only half-read would be worse than no warning.
 */
export function parseAllowance(value: unknown): Allowance | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return {
    key: readString(body, "key"),
    limit: readNumber(body, "limit"),
    used: readNumber(body, "used"),
    remaining: readNumber(body, "remaining"),
    // Strict `=== true`: a truthy string from a mangled body must not raise a
    // warning the server never sent.
    warn: body.warn === true,
    resetsAt: readNumber(body, "resetsAt"),
  };
}

/* --------------------------- live plan status ----------------------------- */

/**
 * What the last metered call said about the plan.
 *
 * A module-level store rather than a return value, because the surfaces that
 * have to show this are not the ones that make the call: the composer on the
 * canvas, the dashboard and the billing pane all need to know that the monthly
 * allowance is nearly gone, and none of them is in `generate`'s call stack.
 * Threading a prop through every view instead puts the warning only where a prop
 * happened to be passed, which is how a paywall ends up missing from the one
 * screen the customer is actually looking at.
 *
 * In memory only, and empty until the first metered response. That is the honest
 * state: these figures belong to a response, not to the client.
 */
export interface PlanStatus {
  /** Headroom reported by the last allowed metered response. */
  allowance: Allowance | null;
  /** The refusal behind the last 402, until something supersedes it. */
  refusal: PlanRefusalError | null;
}

type PlanStatusListener = (status: PlanStatus) => void;

let plan: PlanStatus = { allowance: null, refusal: null };
const planListeners = new Set<PlanStatusListener>();

export function planStatus(): PlanStatus {
  return plan;
}

export function subscribeToPlanStatus(listener: PlanStatusListener): () => void {
  planListeners.add(listener);
  return () => {
    planListeners.delete(listener);
  };
}

function setPlanStatus(next: PlanStatus): void {
  plan = next;
  planListeners.forEach((fn) => fn(plan));
}

/**
 * Record what an allowed metered response reported.
 *
 * A response that carried no allowance leaves the last known figure alone rather
 * than erasing it: "this deployment meters nothing" and "this build forgot to
 * send it" look identical from here, and blanking a warning the customer has
 * already read is the worse of the two mistakes.
 *
 * A success against the same key clears a standing refusal, because the ceiling
 * that produced it has demonstrably moved -- the month rolled over, or they
 * upgraded -- and a wall that outlives its reason is a bug the customer pays for.
 */
function recordAllowance(allowance: Allowance | null): void {
  if (allowance === null) return;
  const stale = plan.refusal !== null && plan.refusal.refusal.key === allowance.key;
  setPlanStatus({ allowance, refusal: stale ? null : plan.refusal });
}

/**
 * Record a refusal so a surface that can offer the upgrade gets to see it.
 * Anything that is not a plan refusal is ignored, so a caller may hand this
 * whatever it caught without narrowing first.
 */
export function recordPlanRefusal(err: unknown): void {
  if (!(err instanceof PlanRefusalError)) return;
  setPlanStatus({ allowance: plan.allowance, refusal: err });
}

/** Dismiss the wall. Only a dismissal or a later success clears one. */
export function clearPlanRefusal(): void {
  if (plan.refusal === null) return;
  setPlanStatus({ allowance: plan.allowance, refusal: null });
}

/**
 * Record the refusal behind a response whose caller reports every failure as
 * `null` -- `boards.ts` does, for every board call it makes. Without this the
 * reason a board could not be created is dropped with the response, and the user
 * is told to check that the server is running when the truth is that their plan
 * is full.
 */
export async function notePlanRefusal(res: Response): Promise<void> {
  if (res.status !== 402) return;
  recordPlanRefusal(await describeFailure(res, "Board"));
}

/**
 * The requester's local calendar date, YYYY-MM-DD. Sent with every
 * generation so the model can resolve "by Friday" against a real date —
 * local rather than UTC, because "Friday" is the speaker's Friday.
 */
export function localIsoDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function generate(
  message: string,
  workspace: Workspace,
  selection?: string[],
  history?: ChatEntry[],
  attachments?: { images?: ImageAttachment[]; documents?: DocumentAttachment[] },
  run?: RunContext,
  rules?: string,
): Promise<GenerateResponse> {
  const turns = history ? recentHistory(history) : [];

  let res: Response;
  try {
    res = await apiFetch("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        message,
        summary: summarizeWorkspace(workspace, selection),
        today: localIsoDate(),
        ...(turns.length ? { history: turns } : {}),
        ...(attachments?.images?.length ? { images: attachments.images } : {}),
        ...(attachments?.documents?.length ? { documents: attachments.documents } : {}),
        ...(run ? { run } : {}),
        ...(rules ? { rules } : {}),
      }),
    });
  } catch (err) {
    // fetch only rejects on abort or a transport-level failure — i.e. the Lucent
    // backend itself is unreachable, which is a different problem from the AI
    // provider failing. Say which one so the fix is obvious.
    if ((err as Error).name === "AbortError") {
      throw new Error("Generation timed out. The AI took too long — please try again.");
    }
    throw new Error(
      "Can't reach the Lucent server. Start it with: npm run start -w @lucent/server",
    );
  }

  if (!res.ok) {
    throw await describeFailure(res);
  }
  const body = (await res.json()) as GenerateResponse;
  // Re-parsed rather than trusted as typed: the cast above is a claim about the
  // wire, and this is the one field a caller renders straight to a customer.
  const allowance = parseAllowance(body.allowance);
  recordAllowance(allowance);
  return { ...body, allowance };
}

/**
 * Streaming generation (M5/E1): same request as `generate`, SSE response.
 * Deltas are the model's payload text as it arrives and go to `onDelta` —
 * display material only. The resolved value is the `done` frame, whose
 * operations passed the server's full validation pipeline; an `error` frame
 * throws with the server's message. There is no time limit: a slow model's
 * generation runs until it answers, and the person can Cancel (the server
 * sends a heartbeat while the model is silent, so nothing between here and it
 * closes a quiet stream either).
 */
export async function streamGenerate(
  message: string,
  workspace: Workspace,
  onDelta: (text: string) => void,
  selection?: string[],
  history?: ChatEntry[],
  attachments?: { images?: ImageAttachment[]; documents?: DocumentAttachment[] },
  externalSignal?: AbortSignal,
  onPhase?: (
    phase: "understanding" | "constructing" | "validating" | "applying",
    message?: string,
  ) => void,
  run?: RunContext,
  rules?: string,
): Promise<GenerateResponse> {
  const controller = new AbortController();
  // UX-2: Cancel aborts the request. The flag tells a cancel apart from
  // anything else that aborts it (the page going away).
  let userCancelled = false;
  const onExternalAbort = (): void => {
    userCancelled = true;
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new Error("Cancelled — nothing was applied.");
    }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const turns = history ? recentHistory(history) : [];
  let res: Response;
  try {
    res = await apiFetch("/api/generate/stream", {
      method: "POST",
      body: JSON.stringify({
        message,
        summary: summarizeWorkspace(workspace, selection),
        today: localIsoDate(),
        ...(turns.length ? { history: turns } : {}),
        ...(attachments?.images?.length ? { images: attachments.images } : {}),
        ...(attachments?.documents?.length ? { documents: attachments.documents } : {}),
        ...(run ? { run } : {}),
        ...(rules ? { rules } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if ((err as Error).name === "AbortError") {
      if (userCancelled) throw new Error("Cancelled — nothing was applied.");
      throw new Error("The request was stopped before the server responded — please try again.");
    }
    throw new Error(
      "Can't reach the Lucent server. Start it with: npm run start -w @lucent/server",
    );
  }

  if (!res.ok || !res.body) {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    throw await describeFailure(res);
  }

  // SSE frames over a fetch body. Browsers do not deliver POST-based SSE
  // through EventSource, so the reader is manual; the framing is the same.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: GenerateResponse | null = null;
  let failure: string | null = null;

  const handleFrame = (event: string, data: unknown): void => {
    if (event === "phase") {
      const body = data as { phase?: unknown; message?: unknown };
      if (typeof body.phase === "string") {
        onPhase?.(
          body.phase as "understanding" | "constructing" | "validating" | "applying",
          typeof body.message === "string" ? body.message : undefined,
        );
      }
      return;
    }
    if (event === "delta") {
      const text = (data as { text?: unknown }).text;
      if (typeof text === "string") onDelta(text);
      return;
    }
    if (event === "done") {
      const body = data as {
        operations?: Operation[];
        explanation?: string | null;
        reply?: string | null;
        clarification?: unknown;
        provider?: string;
        warnings?: Array<{ op: string; reason: string }>;
        runId?: unknown;
      };
      done = {
        ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
        operations: Array.isArray(body.operations) ? body.operations : [],
        explanation: body.explanation ?? null,
        reply: typeof body.reply === "string" ? body.reply : null,
        clarification:
          body.clarification &&
          typeof body.clarification === "object" &&
          "question" in body.clarification &&
          "options" in body.clarification
            ? (body.clarification as import("@lucent/core").ClarificationChoice)
            : null,
        provider: body.provider ?? "unknown",
        allowance: null,
        warnings: Array.isArray(body.warnings) ? body.warnings : undefined,
      };
      return;
    }
    if (event === "error") {
      const body = data as { error?: unknown; detail?: unknown };
      failure =
        typeof body.error === "string"
          ? body.error + (typeof body.detail === "string" ? ` — ${body.detail}` : "")
          : "The generation failed.";
    }
  };

  const readEvents = async (): Promise<void> => {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          try {
            handleFrame(event, JSON.parse(dataLines.join("")) as unknown);
          } catch {
            // An unparsable frame is skipped, never fatal: the terminal frame
            // is what decides the outcome.
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  };

  try {
    await readEvents();
  } catch (err) {
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if ((err as Error).name === "AbortError" && userCancelled) {
      throw new Error("Cancelled — nothing was applied.");
    }
    throw new Error("The stream was interrupted before it finished — please try again.");
  }
  externalSignal?.removeEventListener("abort", onExternalAbort);

  if (failure) throw new Error(failure);
  if (!done) throw new Error("The stream ended without a result — please try again.");
  return done;
}

export interface ImageResponse {
  src: string;
  explanation?: string;
  provider: string;
  /** As on `GenerateResponse`: images draw on the same monthly AI allowance. */
  allowance: Allowance | null;
}

/** Ask the server to generate an image (Phase E). Key stays server-side. */
export async function generateImage(
  prompt: string,
  size?: "square" | "landscape" | "portrait",
  /** The shared board the image is for: its AI boundary decides (server image route). */
  boardId?: string | null,
): Promise<ImageResponse> {
  const res = await apiFetch("/api/image", {
    method: "POST",
    body: JSON.stringify({ prompt, size, ...(boardId ? { boardId } : {}) }),
  });
  if (!res.ok) {
    // Through the same mapping as /api/generate rather than a message of its
    // own: this spliced the raw body into the toast, so an entitlement 402 here
    // would have shown a user the refusal JSON and dropped the refusal with it.
    //
    // Recorded as well as thrown, unlike /api/generate above: this call is made
    // from the canvas, where the refusal becomes a toast that is gone in three
    // seconds. The structured half has to outlive it for an upgrade to be
    // reachable at all.
    const err = await describeFailure(res, "Image generation");
    recordPlanRefusal(err);
    throw err;
  }
  const body = (await res.json()) as ImageResponse;
  const allowance = parseAllowance(body.allowance);
  recordAllowance(allowance);
  return { ...body, allowance };
}
