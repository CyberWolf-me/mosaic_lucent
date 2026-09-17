import type { MeetingMode } from "./meeting-modes.js";

/**
 * The M6 voice loop, stage M6.1: text answers (docs/25 V6).
 *
 * Full loop later (V7 audio, V8 interruption, V9 proactivity); this module
 * is deliberately only two pure rules plus the shape of an answer:
 *
 * 1. ADDRESSING — did this turn speak to Lucent? A leading "Lucent"
 *    (optionally after "hey", followed by punctuation/space), stripped to
 *    the query. Mid-sentence mentions ("the lucent approach") do NOT
 *    count: addressing is invocation, not mention.
 * 2. PERMISSION — may this mode answer aloud (in text, for now)? Only the
 *    assistant/participant profiles. Record is transcript-only at every
 *    volume — a Record meeting that spends a generation answering is the
 *    same clause-4 defect as a Record extraction. Intelligence extracts
 *    but does not volunteer answers; asking there stays manual (Ask pill).
 *
 * Answers reuse the Ask pipeline (read-only, cited, metered mode "ask"),
 * so a spoken question can never mutate the board — the M6 voice never
 * touches the reducer, same as every other input (docs/24 §10).
 */

export interface AddressedQuery {
  addressed: boolean;
  /** The turn with the address stripped; empty when nothing was asked. */
  query: string;
}

const ADDRESS = /^\s*(?:hey[,\s]+)?lucent(?:[,\s:;.!?—–-]+(.*))?$/i;

/** Split a final turn into address + query. Pure, tested, no DOM. */
export function detectAddress(text: string): AddressedQuery {
  const match = ADDRESS.exec(text);
  if (!match) return { addressed: false, query: "" };
  return { addressed: true, query: (match[1] ?? "").trim() };
}

/**
 * May the voice answer this turn in text? Mode permission AND a real
 * question: "Lucent" alone (empty query) is acknowledged by nothing — the
 * loop does not spend a generation on an empty ask.
 */
export function shouldAnswerVoice(mode: MeetingMode, text: string): boolean {
  if (mode !== "assistant" && mode !== "participant") return false;
  const { addressed, query } = detectAddress(text);
  return addressed && query !== "";
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
