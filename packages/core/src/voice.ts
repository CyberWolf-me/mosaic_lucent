/**
 * Voice Semantic Contract, Response Policy, and State Machine (Voice V1.5).
 *
 * This module unifies the three voice modes (Canvas Voice, Live Duplex Agent,
 * and Meeting Voice) behind one shared semantic pipeline:
 *
 *   SpeechEvent -> VoiceTurn -> VoiceIntent -> ResponsePolicy -> ActionProposal / SpokenResponse
 *
 * Core Principles:
 * 1. The user describes; the AI constructs.
 * 2. Deterministic operations: coordinates are never generated for semantic nodes.
 * 3. Ephemeral audio: only text turns and structured statements persist.
 * 4. Separation of three fundamental questions:
 *      - CAPTURE: Should Lucent understand and record this? (Almost always yes)
 *      - SPEAK:   Should Lucent respond with audible speech? (Only when invoked/lease active)
 *      - ACT:     Should Lucent mutate the canvas? (Only when explicitly authorized)
 */

export type VoiceSource = "browser" | "whisper" | "livekit" | "hosted" | "synthetic";

/** One finalized, attributed turn of speech. */
export interface VoiceTurn {
  id: string;
  text: string;
  speakerId?: string;
  speakerName?: string;
  at: number;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  source: VoiceSource;
}

export type VoiceInvocationType =
  | "explicit_lead" // Front invocation: "Lucent, add payments"
  | "explicit_vocative" // Mid-sentence vocative: "I think, Lucent, can you explain?"
  | "lease_followup" // Same speaker follow-up under an active conversational lease
  | "unaddressed"; // No invocation detected

export type VoiceIntentKind =
  | "mutation" // Imperative instruction to modify canvas visuals
  | "inquiry" // Read-only query or historical explanation
  | "clarification" // Answer to a clarification question previously asked by Lucent
  | "speculative" // Brainstorming / hypothetical / passive conversation
  | "discussion" // Human-to-human discussion
  | "dismissal" // Sign-off: "Thanks", "That's all", "Back to team"
  | "stop" // Barge-in interruption: "Lucent, stop", "Hold on"
  | "ambiguous"; // Bare "Lucent" with no actionable query

export interface VoiceIntent {
  invocation: VoiceInvocationType;
  kind: VoiceIntentKind;
  cleanQuery: string;
  targetSpeakerId?: string;
}

/** The 3-question evaluation outcome. */
export interface PolicyDecision {
  capture: boolean;
  speak: boolean;
  act: boolean;
  intent: VoiceIntent;
  reason: string;
}

export type MeetingModeKind = "canvas" | "record" | "intelligence" | "assistant" | "participant";

export interface ResponsePolicyContext {
  mode: MeetingModeKind;
  leaseActive: boolean;
  leaseSpeakerId?: string;
  isMuted?: boolean;
  userRole?: "owner" | "editor" | "viewer";
}

/* -------------------------------------------------------------------------- */
/* Lexical and Pattern Matchers (Pure deterministic string functions)         */
/* -------------------------------------------------------------------------- */

const LUCENT_NAME_PATTERN = "(?:lucent|loosened|loosen|loucent|lucente|lucid)";
const LUCENT_NAMES_SET = new Set(["lucent", "loosened", "loosen", "loucent", "lucente", "lucid"]);

/** Detect explicit invocation of Lucent. */
export function detectAddress(text: string): {
  addressed: boolean;
  query: string;
  type: VoiceInvocationType;
} {
  const t = text.trim();
  if (!t) return { addressed: false, query: "", type: "unaddressed" };

  // Front address: e.g. "Lucent, ...", "hey lucent ...", "loosened, ..."
  const frontMatch = new RegExp(
    `^(?:hey|ok|okay)?[,\\s]*${LUCENT_NAME_PATTERN}(?:([,\\s:;.!?—–-]+)(.*))?$`,
    "i",
  ).exec(t);

  if (frontMatch) {
    const sep = frontMatch[1] ?? "";
    const rawQuery = (frontMatch[2] ?? "").trim();
    if (!sep && !rawQuery) {
      return { addressed: true, query: "", type: "explicit_lead" };
    }
    // If separated only by whitespace without punctuation, check for passive descriptions
    if (!/[,:;.!?—–-]/.test(sep)) {
      if (/^(?:is|are|was|were|seems|seemed|has|looks|would be)\b/i.test(rawQuery)) {
        return { addressed: false, query: "", type: "unaddressed" };
      }
    }
    return { addressed: true, query: rawQuery, type: "explicit_lead" };
  }

  // Mid-sentence vocative: conversational lead-in + ", Lucent," + query
  const midMatch = new RegExp(
    `^(?:i think|wait|so|well|um|uh|actually|honestly)[,\\s]+${LUCENT_NAME_PATTERN}[,\\s:;.!?—–-]+(.*)$`,
    "i",
  ).exec(t);

  if (midMatch) {
    const rawQuery = (midMatch[1] ?? "").trim();
    if (rawQuery) {
      return { addressed: true, query: rawQuery, type: "explicit_vocative" };
    }
  }

  return { addressed: false, query: "", type: "unaddressed" };
}

/** Check if turn is a conversational dismissal or handoff. */
export function detectDismissal(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[.!?,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Pattern covering single or compound polite signoffs:
  // e.g. "thanks", "thank you, that's all", "got it", "back to the team", "okay we're done"
  return (
    /^(?:ok(?:ay)? )?(?:thanks?(?: you)?(?: lucent)? )?(?:that'?s (?:all|it|enough|clear)|stop(?: listening)?|bye|goodbye|we'?re done|i'?m done|got it|back to the team|never mind|all good|nothing else|stay quiet)(?: for now)?(?: thanks?(?: you)?)?$/.test(
      t,
    ) ||
    /^\s*(?:thanks?(?:\s+you)?|got\s+it|all\s+good|back\s+to\s+the\s+team)(?:\s+lucent)?[.!]?\s*$/i.test(
      text.trim(),
    )
  );
}

/** Stop or cancel requests that command immediate silence/barge-in. */
export function isStopRequest(query: string): boolean {
  const t = query
    .toLowerCase()
    .replace(/[.!?,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /^(?:please\s+)?(?:stop|cancel|wait|hold\s+on|wait\s+hold\s+on|never\s*mind|enough|that'?s\s+enough|hush|shush|quiet)(?:\s+(?:please|now|for\s+now))?$/i.test(
    t,
  );
}

/** Check if the utterance addresses another teammate rather than Lucent. */
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

/** Check if utterance is speculative, brainstorming, or hypothetical chatter. */
export function isSpeculativeSpeech(text: string): boolean {
  const t = text.trim();
  const SPECULATIVE_PATTERNS = [
    /\b(?:we'?re|i'?m|we\s+were|i\s+was)\s+(?:thinking\s+about|considering|wondering\s+if)\b/i,
    /\b(?:maybe|perhaps|probably|possibly)\s+(?:we\s+should|we\s+could|i\s+should|going\s+to|planning\s+to)\b/i,
    /\bwhat\s+if\s+(?:we|you|i)\b/i,
    /\b(?:sarah|bob|alice|charlie|someone|anybody)\s+(?:said|suggested|mentioned)\s+(?:we\s+should|we\s+could)?\b/i,
    /\bi\s+don'?t\s+think\s+we\s+should\b/i,
    /\b(?:could\s+be\s+that|might\s+want\s+to|might\s+need\s+to)\b/i,
    /\bwe\s+were\s+discussing\b/i,
    /\b(?:is\s+it\s+possible\s+to|would\s+it\s+make\s+sense\s+to)\b/i,
  ];
  return SPECULATIVE_PATTERNS.some((pattern) => pattern.test(t));
}

/** Check if turn contains direct imperative canvas mutation commands. */
export function isMutationUtterance(text: string): boolean {
  const t = text.trim();
  // If it's speculative, it is NOT an imperative mutation command
  if (isSpeculativeSpeech(t)) return false;

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

/** Concise direct answers (e.g. answering clarification questions). */
export function isDirectAnswer(text: string): boolean {
  const t = text.trim();
  if (t.split(/\s+/).length > 8) return false;
  const DIRECT_ANSWERS =
    /^\s*(?:yes|no|yeah|yep|nope|postgres|postgresql|redis|mysql|mongodb|sqlite|both|neither|separately|together|the\s+first(?:\s+one)?|the\s+second(?:\s+one)?|backend|frontend|mobile|below\s+the\s+api|after\s+checkout)[.!]?\s*$/i;
  return DIRECT_ANSWERS.test(t);
}

/* -------------------------------------------------------------------------- */
/* Intent Evaluation and Response Policy Engine                               */
/* -------------------------------------------------------------------------- */

export function classifyVoiceIntent(
  turn: VoiceTurn,
  leaseActive: boolean,
  leaseSpeakerId?: string,
  knownTeammates: string[] = [],
): VoiceIntent {
  const text = turn.text.trim();
  const speakerId = turn.speakerId;

  // 1. Cross-talk check: addressing a known teammate
  if (addressesOtherPerson(text, knownTeammates)) {
    return {
      invocation: "unaddressed",
      kind: "discussion",
      cleanQuery: text,
      targetSpeakerId: "teammate",
    };
  }

  // 2. Dismissals
  if (detectDismissal(text)) {
    return {
      invocation: "unaddressed",
      kind: "dismissal",
      cleanQuery: "",
    };
  }

  // 3. Explicit Address Check
  const address = detectAddress(text);
  if (address.addressed) {
    const q = address.query;
    if (!q) {
      return { invocation: address.type, kind: "ambiguous", cleanQuery: "" };
    }
    if (isStopRequest(q)) {
      return { invocation: address.type, kind: "stop", cleanQuery: q };
    }
    if (isMutationUtterance(q)) {
      return { invocation: address.type, kind: "mutation", cleanQuery: q };
    }
    if (isSpeculativeSpeech(q)) {
      return { invocation: address.type, kind: "inquiry", cleanQuery: q };
    }
    return { invocation: address.type, kind: "inquiry", cleanQuery: q };
  }

  // 4. Conversational Lease Follow-up Check
  if (leaseActive && speakerId && leaseSpeakerId === speakerId) {
    if (isStopRequest(text)) {
      return { invocation: "lease_followup", kind: "stop", cleanQuery: text };
    }
    if (isMutationUtterance(text)) {
      return { invocation: "lease_followup", kind: "mutation", cleanQuery: text };
    }
    if (isDirectAnswer(text)) {
      return { invocation: "lease_followup", kind: "clarification", cleanQuery: text };
    }
    if (isSpeculativeSpeech(text)) {
      return { invocation: "lease_followup", kind: "discussion", cleanQuery: text };
    }
    return { invocation: "lease_followup", kind: "inquiry", cleanQuery: text };
  }

  // 5. Unaddressed chatter
  if (isSpeculativeSpeech(text)) {
    return { invocation: "unaddressed", kind: "speculative", cleanQuery: text };
  }
  return { invocation: "unaddressed", kind: "discussion", cleanQuery: text };
}

/**
 * The Three-Question Response Policy Evaluator.
 * Given a turn and context, deterministically decides:
 * - Should Lucent understand (capture)?
 * - Should Lucent speak?
 * - Should Lucent act (mutate canvas)?
 */
export function evaluateVoicePolicy(
  turn: VoiceTurn,
  ctx: ResponsePolicyContext,
  knownTeammates: string[] = [],
): PolicyDecision {
  const intent = classifyVoiceIntent(turn, ctx.leaseActive, ctx.leaseSpeakerId, knownTeammates);

  // Capture is always true for non-empty speech (records in transcripts & candidate memory)
  const capture = turn.text.trim().length > 0;

  // Record mode: captures everything, NEVER speaks, NEVER mutates
  if (ctx.mode === "record") {
    return {
      capture,
      speak: false,
      act: false,
      intent,
      reason: "record_mode_silent",
    };
  }

  // Dismissal or stop requests
  if (intent.kind === "dismissal") {
    return {
      capture,
      speak: false,
      act: false,
      intent,
      reason: "dismissal",
    };
  }

  if (intent.kind === "stop") {
    return {
      capture,
      speak: false,
      act: false,
      intent,
      reason: "stop_requested",
    };
  }

  // If unaddressed and no active lease, do not speak or act
  if (intent.invocation === "unaddressed") {
    return {
      capture,
      speak: false,
      act: false,
      intent,
      reason: "unaddressed_speech",
    };
  }

  // Ambiguous "Lucent" with no words
  if (intent.kind === "ambiguous") {
    return {
      capture,
      speak: false,
      act: false,
      intent,
      reason: "ambiguous_call",
    };
  }

  // Role permissions check: viewers cannot mutate
  const canMutate = ctx.userRole !== "viewer";

  // Mode rules for speaking:
  // Intelligence mode: never speaks unless manual Ask pill is used
  if (ctx.mode === "intelligence") {
    return {
      capture,
      speak: false,
      act: false,
      intent,
      reason: "intelligence_mode_silent",
    };
  }

  const shouldSpeak = !ctx.isMuted;

  // Mutation commands
  if (intent.kind === "mutation") {
    if (!canMutate) {
      return {
        capture,
        speak: shouldSpeak,
        act: false,
        intent,
        reason: "read_only_role_forbidden",
      };
    }
    return {
      capture,
      speak: shouldSpeak,
      act: true,
      intent,
      reason: "authorized_mutation",
    };
  }

  // Inquiries and clarifications
  return {
    capture,
    speak: shouldSpeak,
    act: false,
    intent,
    reason: intent.kind === "clarification" ? "clarification_answer" : "inquiry_response",
  };
}

/* -------------------------------------------------------------------------- */
/* Canonical Voice State Machine (VoiceFSM)                                   */
/* -------------------------------------------------------------------------- */

export type VoiceState =
  | "dormant"
  | "invocated"
  | "listening"
  | "processing"
  | "acting"
  | "speaking"
  | "follow_up_window"
  | "interrupted"
  | "recovering"
  | "error";

export type VoiceFsmEvent =
  | { type: "WAKE_INVOKED"; speakerId?: string; at: number }
  | { type: "START_LISTENING"; at: number }
  | { type: "TURN_FINALIZED"; turn: VoiceTurn; at: number }
  | { type: "PROCESSING_START"; at: number }
  | { type: "ACTING_START"; at: number }
  | { type: "SPEAKING_START"; at: number }
  | { type: "SPEAKING_DONE"; endedWithQuestion: boolean; at: number }
  | { type: "BARGE_IN"; interruptingSpeakerId?: string; at: number }
  | { type: "LEASE_EXPIRED"; at: number }
  | { type: "DISMISS"; at: number }
  | { type: "PROVIDER_FAIL"; error: string; recoverable: boolean; at: number }
  | { type: "RECOVERED"; at: number }
  | { type: "RESET"; at: number };

export interface VoiceFsmSnapshot {
  state: VoiceState;
  speakerId: string | null;
  lastError: string | null;
  updatedAt: number;
}

export class VoiceFSM {
  private _state: VoiceState = "dormant";
  private _speakerId: string | null = null;
  private _lastError: string | null = null;
  private _updatedAt: number;
  private listeners = new Set<(snapshot: VoiceFsmSnapshot) => void>();

  constructor(initialState: VoiceState = "dormant", now: number = Date.now()) {
    this._state = initialState;
    this._updatedAt = now;
  }

  get state(): VoiceState {
    return this._state;
  }

  get snapshot(): VoiceFsmSnapshot {
    return {
      state: this._state,
      speakerId: this._speakerId,
      lastError: this._lastError,
      updatedAt: this._updatedAt,
    };
  }

  subscribe(listener: (snapshot: VoiceFsmSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transition(next: VoiceState, now: number, speakerId?: string | null): void {
    this._state = next;
    this._updatedAt = now;
    if (speakerId !== undefined) {
      this._speakerId = speakerId;
    }
    const snap = this.snapshot;
    for (const l of this.listeners) {
      l(snap);
    }
  }

  dispatch(event: VoiceFsmEvent): VoiceState {
    const at = event.at;

    switch (event.type) {
      case "WAKE_INVOKED":
        this.transition("invocated", at, event.speakerId ?? this._speakerId);
        return this._state;

      case "START_LISTENING":
        this.transition("listening", at);
        return this._state;

      case "TURN_FINALIZED":
        // Moves from listening to processing
        this.transition("processing", at, event.turn.speakerId ?? this._speakerId);
        return this._state;

      case "PROCESSING_START":
        this.transition("processing", at);
        return this._state;

      case "ACTING_START":
        this.transition("acting", at);
        return this._state;

      case "SPEAKING_START":
        this.transition("speaking", at);
        return this._state;

      case "SPEAKING_DONE":
        // If question asked or lease open, transition to follow-up window
        this.transition("follow_up_window", at);
        return this._state;

      case "BARGE_IN":
        // Immediate interruption during speaking or processing
        if (
          this._state === "speaking" ||
          this._state === "processing" ||
          this._state === "acting"
        ) {
          this.transition("interrupted", at, event.interruptingSpeakerId ?? this._speakerId);
          return this._state;
        }
        return this._state;

      case "LEASE_EXPIRED":
      case "DISMISS":
      case "RESET":
        this._speakerId = null;
        this._lastError = null;
        this.transition("dormant", at, null);
        return this._state;

      case "PROVIDER_FAIL":
        this._lastError = event.error;
        if (event.recoverable) {
          this.transition("recovering", at);
        } else {
          this.transition("error", at);
        }
        return this._state;

      case "RECOVERED":
        this._lastError = null;
        this.transition("listening", at);
        return this._state;
    }
  }
}
