import type { SendOutcome } from "./workspace.js";

/**
 * Talking with Lucent on the canvas: a conversation, not a dictation box.
 *
 * The person taps the mic once and talks. When they pause, what they said is
 * sent; Lucent answers out loud — the model's conversational `reply`, often a
 * question back — and then listens again, until the person says they're done,
 * taps the mic, or goes quiet for a while. It used to take one utterance, stop
 * listening, and (only with "AI sound" on) read out the change description.
 *
 * The timings and words live here, pure, so the rules are tested without a
 * microphone; CanvasView wires them to the recognizer and the speaker.
 */

/** A pause this long after a finished phrase ends the person's turn. */
export const END_OF_TURN_MS = 1800;
/**
 * Words still being recognized, no final yet: wait longer before taking them
 * as the turn (the recognizer usually finalizes first).
 */
export const INTERIM_GRACE_MS = 3500;
/** No speech at all for this long while listening ends the conversation. */
export const IDLE_END_MS = 30_000;

/** "That's all", "stop", "thanks, bye": the person is done talking. */
export function isEndOfConversation(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[.!?,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(ok(ay)? )?(thanks?( you)?( lucent)? )?(that'?s (all|it)|stop( listening)?|bye|goodbye|we'?re done|i'?m done|end (the )?conversation|nothing else|no thanks?)( for now)?( thanks?( you)?)?$/.test(
    t,
  );
}

/** What Lucent says back for what the request did; null when nothing is worth saying. */
export function spokenReply(outcome: SendOutcome): string | null {
  switch (outcome.outcome) {
    case "applied":
    case "proposed":
    case "answered":
      return outcome.reply.trim() || null;
    case "rejected":
      return "I couldn't make that change cleanly, so I left the board as it was. Could you say it another way?";
    case "failed":
      return `That didn't work: ${outcome.error}`;
    case "busy":
      return "I'm still working on the last request.";
    case "refused":
      return "I can't change this board from here.";
    case "cancelled":
      return null;
  }
}

/** Where the conversation is, for the pill's status line. */
export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";

export function voicePhaseLabel(phase: VoicePhase): string | null {
  switch (phase) {
    case "listening":
      return 'Listening — say "that\'s all" or tap the mic to finish';
    case "thinking":
      return "Lucent is thinking…";
    case "speaking":
      return "Lucent is answering — tap the mic to stop";
    case "idle":
      return null;
  }
}
