import type { MeetingMode } from "./meeting-modes.js";

/**
 * The M6 voice loop & conversational lease platform (docs/25 V6–V8).
 *
 * Implements a stateful, speaker-bound conversational lease:
 * 1. ADDRESSING — explicit invocation (front or mid-sentence vocative);
 *    passive mentions ("the lucent approach", "Lucent is fast") are ignored.
 * 2. SPEAKER-BOUND LEASE — following Lucent's answer, a 15s window opens
 *    strictly for the same speaker. Cross-talk from another participant
 *    immediately suspends/closes the lease.
 * 3. DISMISSALS — polite sign-offs ("Thanks", "Got it", "Back to the team")
 *    silently return to dormant with 0 tokens spent.
 * 4. BARGE-IN — speech during AI responding stops TTS immediately and captures
 *    the interruption.
 * 5. INTENT ROUTING — inquiries stay read-only (askLucent); canvas mutations
 *    ("move payments below checkout") route to the canvas generator.
 */

export interface AddressedQuery {
  addressed: boolean;
  /** The turn with the address stripped; empty when nothing was asked. */
  query: string;
}

/** Common phonetic transcriptions of 'Lucent' from speech-to-text engines. */
const LUCENT_NAME_PATTERN = "(?:lucent|loosened|loosen|loucent|lucente|lucid)";
const LUCENT_NAMES_SET = new Set(["lucent", "loosened", "loosen", "loucent", "lucente", "lucid"]);

/**
 * Detect explicit addressing of Lucent.
 *
 * Rules:
 * 1. Front invocation: "Lucent, ...", "Hey Lucent, ...", "Okay loosened, ..."
 * 2. Mid-sentence invocation: "I think, Lucent, can you explain...", "Wait, Lucent: who owns..."
 * 3. Passive mentions ("the lucent approach", "Lucent is fast") are NOT invocations.
 * 4. Empty query ("Lucent", "Lucent, ") marks addressed: true with empty query.
 */
export function detectAddress(text: string): AddressedQuery {
  const t = text.trim();
  if (!t) return { addressed: false, query: "" };

  // Front address: e.g. "Lucent, ...", "hey lucent ...", "loosened, ..."
  const frontMatch = new RegExp(
    `^(?:hey|ok|okay)?[,\\s]*${LUCENT_NAME_PATTERN}(?:([,\\s:;.!?—–-]+)(.*))?$`,
    "i",
  ).exec(t);
  if (frontMatch) {
    const sep = frontMatch[1] ?? "";
    const rawQuery = (frontMatch[2] ?? "").trim();
    if (!sep && !rawQuery) {
      return { addressed: true, query: "" };
    }
    // If separated only by whitespace (no vocative punctuation), guard against passive mentions
    // e.g. "Lucent is actually fast", "Lucent seems good"
    if (!/[,:;.!?—–-]/.test(sep)) {
      if (/^(?:is|are|was|were|seems|seemed|has|looks|would be)\b/i.test(rawQuery)) {
        return { addressed: false, query: "" };
      }
    }
    return { addressed: true, query: rawQuery };
  }

  // Mid-sentence vocative: conversational lead-in + ", Lucent," + question/command
  // e.g. "I think, Lucent, can you explain the pricing?", "Wait, loosened: who owns mobile?"
  const midMatch = new RegExp(
    `^(?:i think|wait|so|well|um|uh|actually|honestly)[,\\s]+${LUCENT_NAME_PATTERN}[,\\s:;.!?—–-]+(.*)$`,
    "i",
  ).exec(t);
  if (midMatch) {
    const rawQuery = (midMatch[1] ?? "").trim();
    if (rawQuery) {
      return { addressed: true, query: rawQuery };
    }
  }

  return { addressed: false, query: "" };
}

/**
 * Check if the turn is a conversational dismissal or handoff.
 * Examples: "Thanks", "Thank you Lucent", "Got it", "That's all", "Back to the team", "Stay quiet".
 */
export function detectDismissal(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[.!?,—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (
    /^(?:ok(?:ay)?\s+)?(?:thanks?(?:\s+you)?(?:\s+lucent)?\s+)?(?:that'?s\s+(?:all|it|enough|clear)|that\s+makes\s+sense|stop(?:\s+listening)?|bye|goodbye|we'?re\s+done|i'?m\s+done|got\s+it|back\s+to\s+the\s+team|never\s*mind|all\s+good|nothing\s+else|stay\s+quiet)(?:\s+for\s+now)?(?:\s+thanks?(?:\s+you)?)?(?:\s+lucent)?$/.test(
      t,
    ) ||
    /^(?:ok(?:ay)?\s+)?(?:thanks?(?:\s+you)?|got\s+it|all\s+good|back\s+to\s+the\s+team|that\s+makes\s+sense)(?:\s+lucent)?$/.test(
      t,
    )
  );
}

/**
 * "Lucent, stop." — an addressed request that is ONLY a stop word (docs/28
 * F20). These used to open a lease and send "stop" to Ask as a question.
 * The whole request must be the stop word: "Lucent, wait, what about
 * Redis?" and "how do we stop the double charges?" stay requests.
 */
export function isStopRequest(query: string): boolean {
  return /^\s*(?:please\s+)?(?:stop|cancel|wait|hold\s+on|never\s*mind|enough|that(?:'s|\s+is)\s+enough|hush|shush|quiet)(?:\s+(?:please|now|for\s+now))?[\s.!,]*$/i.test(
    query,
  );
}

/**
 * Check if the turn is addressing another teammate rather than Lucent.
 * e.g. "Bob, what do you think?", "Alice, can you check that?"
 */
export function addressesOtherPerson(text: string, knownTeammates: string[] = []): boolean {
  const t = text.trim();
  for (const name of knownTeammates) {
    if (LUCENT_NAMES_SET.has(name.toLowerCase())) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^\\s*(?:wait[,\\s]+)?${escaped}[,\\s:;.!?—–-]+`, "i");
    if (re.test(t)) return true;
  }
  return false;
}

/**
 * Canvas mutation commands (imperative instructions that modify or create board visuals).
 * e.g. "Move payments underneath checkout", "Draw a flowchart of our login process", "Create architecture diagram".
 */
export function isMutationUtterance(text: string): boolean {
  const t = text.trim();
  const MUTATION_VERBS =
    /^\s*(?:(?:actually|so|now|and|then|also|okay|ok)[,\s]+)?(?:can\s+you\s+|could\s+you\s+|please\s+)?(move|put|place|draw|create|build|add|make|design|generate|show|render|delete|remove|change|color|connect|link|rearrange|align|group|ungroup)\b/i;
  const MUTATION_TARGETS =
    /\b(diagram|flowchart|workflow|pipeline|architecture|wireframe|mindmap|mind\s+map|journey|system|process|flow|box|boxes|node|nodes|sticky|stickies|note|notes|arrow|arrows|shape|shapes|checkout|payments|stripe|database|cache|service|services|api|backend|frontend|auth|redis|postgres|postgresql|mysql|mongodb|sqlite|kafka|queue|queues|table|chart|component|components|card|cards|task|tasks|step|steps|underneath|below|above|next\s+to|beside)\b/i;

  if (MUTATION_VERBS.test(t)) {
    return (
      MUTATION_TARGETS.test(t) ||
      /^(?:draw|create|build|make|design|generate|add|delete|remove|connect|link)\b/i.test(t) ||
      /^(?:draw\s+that|delete\s+that|remove\s+that|add\s+that)/i.test(t)
    );
  }
  return false;
}

/**
 * Continuation or clarification interrogatives.
 * e.g. "Why?", "Can you explain that?", "And what about Redis?", "How come?".
 */
export function isContinuationUtterance(text: string): boolean {
  const t = text.trim();
  const CONTINUATION_STARTS =
    /^\s*(?:and\s+)?(?:why(?:\s+is\s+that)?|what\s+about|how\s+about|how\s+come|how\s+does|can\s+you\s+(?:explain|elaborate|clarify)|could\s+you\s+(?:explain|elaborate|clarify)|tell\s+me\s+more|what\s+do\s+you\s+mean|which\s+one|is\s+that|are\s+there|when\s+will|where\s+does|does\s+that)\b/i;

  if (CONTINUATION_STARTS.test(t)) return true;
  // Any sentence ending in question mark with a question word or pronoun
  if (
    t.endsWith("?") &&
    /\b(why|what|how|where|who|when|which|can|could|would|should|is|are)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Concise answers when Lucent asked a clarification question (e.g. "Which database?").
 */
export function isDirectAnswer(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length > 6) return false;
  const DIRECT_ANSWERS =
    /^\s*(?:yes|no|yeah|yep|nope|postgres|postgresql|redis|mysql|mongodb|sqlite|both|neither|separately|together|the\s+first(?:\s+one)?|the\s+second(?:\s+one)?|backend|frontend|mobile)[.!]?\s*$/i;
  return DIRECT_ANSWERS.test(t);
}

/** May the voice answer this turn? */
export function shouldAnswerVoice(mode: MeetingMode, text: string): boolean {
  if (mode !== "assistant" && mode !== "participant") return false;
  const { addressed, query } = detectAddress(text);
  return addressed && query !== "";
}

/* ------------------------- Conversational Lease FSM ------------------------ */

export type ConversationState =
  | "dormant"
  | "invoked"
  | "ai_responding"
  | "waiting_for_followup"
  | "waiting_for_user_response";

export interface ConversationalLease {
  speakerId: string;
  speakerName?: string;
  startedAt: number;
  expiresAt: number;
  turnCount: number;
  state: "waiting_for_followup" | "waiting_for_user_response";
  lastQuestion: string;
  lastAnswer: string;
  lastAnswerEndedWithQuestion: boolean;
  /**
   * A spoken canvas command the canvas AI answered with a question instead of
   * guessing (docs/28 F21): the lease waits for this speaker's answer, and
   * the answer goes back to the canvas together with this instruction.
   */
  clarifying?: string;
}

export type TurnEvaluationResult =
  | { action: "direct_invoke"; query: string; speakerId: string }
  | { action: "direct_mutation"; instruction: string; speakerId: string }
  | {
      action: "followup_query";
      query: string;
      speakerId: string;
      kind: "continuation" | "clarification" | "direct_answer";
    }
  | { action: "followup_mutation"; instruction: string; speakerId: string }
  /** The answer to a clarifying question about `instruction` (docs/28 F21). */
  | { action: "clarification_answer"; instruction: string; answer: string; speakerId: string }
  | { action: "dismiss"; reason: string }
  | {
      action: "ignore";
      reason:
        | "different_speaker"
        | "lease_expired"
        | "dormant"
        | "unrelated"
        | "ambiguous"
        | "passive_mention"
        | "max_turns_exceeded";
    };

export interface ConversationalLeaseManagerOptions {
  leaseDurationMs?: number; // default 15_000ms
  maxFollowUpTurns?: number; // default 3
  knownTeammates?: string[];
}

export class ConversationalLeaseManager {
  private state: ConversationState = "dormant";
  private lease: ConversationalLease | null = null;
  private readonly leaseDurationMs: number;
  private readonly maxFollowUpTurns: number;
  private knownTeammates: string[];
  private listeners = new Set<() => void>();

  constructor(options: ConversationalLeaseManagerOptions = {}) {
    this.leaseDurationMs = options.leaseDurationMs ?? 15_000;
    this.maxFollowUpTurns = options.maxFollowUpTurns ?? 3;
    this.knownTeammates = options.knownTeammates ?? [];
  }

  getState(): ConversationState {
    return this.state;
  }

  getLease(): ConversationalLease | null {
    return this.lease;
  }

  setTeammates(teammates: string[]): void {
    this.knownTeammates = teammates;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Explicit invocation: opens or resets the conversational lease for this speaker. */
  onExplicitInvocation(
    speakerId: string,
    query: string,
    speakerName?: string,
    now: number = Date.now(),
  ): void {
    this.state = "invoked";
    this.lease = {
      speakerId,
      speakerName,
      startedAt: now,
      expiresAt: now + this.leaseDurationMs,
      turnCount: 0,
      state: "waiting_for_followup",
      lastQuestion: query,
      lastAnswer: "",
      lastAnswerEndedWithQuestion: false,
    };
    this.emitChange();
  }

  /** AI starts processing / TTS starts speaking. */
  onAiStartResponding(): void {
    this.state = "ai_responding";
    this.emitChange();
  }

  /**
   * TTS audio finished playing.
   * Starts the 15-second follow-up window from THIS moment (not start time).
   */
  onTtsDone(answerText: string, now: number = Date.now()): void {
    if (!this.lease) {
      this.state = "dormant";
      this.emitChange();
      return;
    }

    const trimmed = answerText.trim();
    const endsWithQuestion = trimmed.endsWith("?");
    const targetState = endsWithQuestion ? "waiting_for_user_response" : "waiting_for_followup";

    this.state = targetState;
    this.lease = {
      ...this.lease,
      state: targetState,
      expiresAt: now + this.leaseDurationMs,
      lastAnswer: answerText,
      lastAnswerEndedWithQuestion: endsWithQuestion,
    };
    this.emitChange();
  }

  /**
   * The canvas AI asked a clarifying question about a spoken command, and it
   * has been shown and spoken (docs/28 F21). The follow-up window opens from
   * now, waiting for THIS speaker's answer — any turn of theirs, not only the
   * short fixed vocabulary `isDirectAnswer` knows, since "below the API" is
   * as good an answer as "Postgres".
   */
  onClarificationAsked(instruction: string, question: string, now: number = Date.now()): void {
    if (!this.lease) {
      this.state = "dormant";
      this.emitChange();
      return;
    }
    this.state = "waiting_for_user_response";
    this.lease = {
      ...this.lease,
      state: "waiting_for_user_response",
      expiresAt: now + this.leaseDurationMs,
      lastAnswer: question,
      lastAnswerEndedWithQuestion: true,
      clarifying: instruction,
    };
    this.emitChange();
  }

  /**
   * Barge-in check: human speaks while AI is speaking.
   */
  onBargeIn(
    speakerId: string,
    text: string,
    now: number = Date.now(),
  ): { interrupted: boolean; newQuery?: string } {
    if (this.state !== "ai_responding") {
      return { interrupted: false };
    }

    const STOP_PATTERN = new RegExp(
      `^\\s*(?:${LUCENT_NAME_PATTERN}[,\\s]+)?(?:no[,\\s]+)?(?:stop|wait|hold\\s+on|cancel|shut\\s+up|pause)(?:[,\\s:;.!?—–-]+(.*))?$`,
      "i",
    );
    const match = STOP_PATTERN.exec(text.trim());

    if (match) {
      let remainder = (match[1] ?? "").trim();
      remainder = remainder
        .replace(
          new RegExp(`^(?:hey|ok|okay)?[,\\s]*${LUCENT_NAME_PATTERN}[,\\s:;.!?—–-]*`, "i"),
          "",
        )
        .trim();
      if (remainder) {
        this.onExplicitInvocation(speakerId, remainder, undefined, now);
        return { interrupted: true, newQuery: remainder };
      }
      this.dismissLease();
      return { interrupted: true };
    }

    // Speech detected during AI playback: interrupt playback and evaluate new turn
    const address = detectAddress(text);
    if (address.addressed) {
      this.onExplicitInvocation(speakerId, address.query, undefined, now);
      return { interrupted: true, newQuery: address.query || undefined };
    }

    return { interrupted: true };
  }

  /** Explicitly dismisses the active lease (silently returns to dormant). */
  dismissLease(): void {
    this.state = "dormant";
    this.lease = null;
    this.emitChange();
  }

  /**
   * Evaluate an incoming turn against the conversational lease state machine.
   */
  evaluateTurn(
    turn: { speaker: string; text: string; at?: number },
    now: number = Date.now(),
  ): TurnEvaluationResult {
    const text = turn.text.trim();
    const speakerId = turn.speaker;

    // 0. Check for conversational dismissal first (e.g. "That's all, Lucent", "Thanks, Lucent", "Okay, thanks")
    if (detectDismissal(text)) {
      this.dismissLease();
      return { action: "dismiss", reason: "conversational_handoff" };
    }

    // 1. Check for explicit Lucent invocation
    const address = detectAddress(text);
    if (address.addressed) {
      if (!address.query) {
        // Bare "Lucent" with nothing asked
        return { action: "ignore", reason: "ambiguous" };
      }
      if (
        /^(?:stay\s+quiet|be\s+quiet|stop\s+talking|mute)\b/i.test(address.query) ||
        isStopRequest(address.query)
      ) {
        this.dismissLease();
        return { action: "dismiss", reason: "user_requested_silence" };
      }
      this.onExplicitInvocation(speakerId, address.query, undefined, now);
      if (isMutationUtterance(address.query)) {
        return { action: "direct_mutation", instruction: address.query, speakerId };
      }
      return { action: "direct_invoke", query: address.query, speakerId };
    }

    // 2. Check if a conversational lease is active
    if (!this.lease || this.state === "dormant") {
      return { action: "ignore", reason: "dormant" };
    }

    // 3. Has the lease expired?
    if (now > this.lease.expiresAt) {
      this.dismissLease();
      return { action: "ignore", reason: "lease_expired" };
    }

    // 4. Did a DIFFERENT speaker speak?
    // In multi-party calls, if someone else speaks, human-to-human discussion has resumed.
    if (speakerId !== this.lease.speakerId) {
      this.dismissLease();
      return { action: "ignore", reason: "different_speaker" };
    }

    // 5. Max turns exceeded check
    if (this.lease.turnCount >= this.maxFollowUpTurns) {
      this.dismissLease();
      return { action: "ignore", reason: "max_turns_exceeded" };
    }

    // 6. Conversational dismissal check
    if (detectDismissal(text)) {
      this.dismissLease();
      return { action: "dismiss", reason: "conversational_handoff" };
    }

    // 7. Addressing another human teammate check
    if (addressesOtherPerson(text, this.knownTeammates)) {
      this.dismissLease();
      return { action: "ignore", reason: "unrelated" };
    }

    // 8a. The answer to a pending clarification (docs/28 F21): the same
    // speaker's next turn, whatever its words — the checks above already
    // let expiry, another speaker, a dismissal and a teammate's name end it.
    if (this.lease.state === "waiting_for_user_response" && this.lease.clarifying) {
      const instruction = this.lease.clarifying;
      this.lease.clarifying = undefined;
      this.lease.turnCount += 1;
      this.lease.lastQuestion = text;
      this.state = "invoked";
      this.emitChange();
      return { action: "clarification_answer", instruction, answer: text, speakerId };
    }

    // 8. Direct answer check (when waiting for user response)
    if (this.lease.state === "waiting_for_user_response" && isDirectAnswer(text)) {
      this.lease.turnCount += 1;
      this.lease.lastQuestion = text;
      this.state = "invoked";
      this.emitChange();
      return {
        action: "followup_query",
        query: text,
        speakerId,
        kind: "direct_answer",
      };
    }

    // 9. Canvas mutation check ("Move payments underneath checkout")
    if (isMutationUtterance(text)) {
      this.lease.turnCount += 1;
      this.lease.lastQuestion = text;
      this.state = "invoked";
      this.emitChange();
      return {
        action: "followup_mutation",
        instruction: text,
        speakerId,
      };
    }

    // 10. Continuation / clarification query check
    if (isContinuationUtterance(text)) {
      this.lease.turnCount += 1;
      this.lease.lastQuestion = text;
      this.state = "invoked";
      this.emitChange();
      return {
        action: "followup_query",
        query: text,
        speakerId,
        kind: "continuation",
      };
    }

    // 11. Ambiguous or unrelated statement (e.g. "What about that?", casual mutter)
    // Safe default: stay silent and leave lease to naturally expire
    return { action: "ignore", reason: "ambiguous" };
  }
}

/** One rendered answer in the meeting view (session-local, never stored). */ export interface VoiceAnswer {
  id: string;
  question: string;
  answer: string;
  citations: string[];
  at: number;
  error?: string;
}

let answerSeq = 0;

/** Assemble the card the view renders; citations collapse to labels. */
export function voiceAnswerCard(
  question: string,
  result: { answer: string; citations?: Array<{ label?: string }> } | { error: string },
  at: number = Date.now(),
): VoiceAnswer {
  answerSeq += 1;
  const id = `lvc_${Date.now().toString(36)}_${answerSeq}`;
  if ("error" in result) {
    return { id, question, answer: "", citations: [], at, error: result.error };
  }
  return {
    id,
    question,
    answer: result.answer,
    citations: (result.citations ?? []).map((c) => c.label ?? "").filter((label) => label !== ""),
    at,
  };
}

/** One open question surfaced proactively (V9, text-only). */
export interface OpenQuestion {
  id: string;
  label: string;
  topic?: string;
}

/**
 * The board's currently open questions (V9/M6.4, first proactive surface).
 * Structural input — no core import, so the rule is testable without the
 * bundle. Read-only over canonical state: the selector derives, stores
 * nothing, and never speaks. Capped for panel space, with the total so the
 * view can say "and N more" instead of pretending three is all.
 */
export function openBoardQuestions(
  workspace:
    | {
        nodes: Record<
          string,
          { label: string; statement?: { kind: string; status: string; topic?: string } }
        >;
      }
    | null
    | undefined,
  limit = 5,
): { items: OpenQuestion[]; total: number } {
  if (!workspace) return { items: [], total: 0 };
  const items: OpenQuestion[] = [];
  for (const [id, node] of Object.entries(workspace.nodes)) {
    if (node.statement?.kind === "question" && node.statement.status === "open") {
      items.push({
        id,
        label: node.label,
        ...(node.statement.topic ? { topic: node.statement.topic } : {}),
      });
    }
  }
  return { items: items.slice(0, Math.max(0, limit)), total: items.length };
}
