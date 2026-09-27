import { apiFetch } from "./http.js";

/**
 * The org's automation rules (docs/26 A5) — what Lucent does on its own —
 * read and set through the owner-only settings route. The server resolves
 * defaults and validates every write; this module only names the rules for
 * people and carries the switch.
 */

export const AUTOMATION_RULES = [
  "meetingExtract",
  "decisionPlan",
  "overdueNotify",
  "externalClose",
] as const;
export type AutomationRule = (typeof AUTOMATION_RULES)[number];
export type AutomationSettings = Record<AutomationRule, boolean>;

/** How each rule reads in the admin console: when, then what. */
export const AUTOMATION_COPY: Record<AutomationRule, { title: string; body: string }> = {
  meetingExtract: {
    title: "When a meeting ends, propose what it left unextracted",
    body: "The turns nobody turned into the board become a proposal on the meeting's board, for someone to approve.",
  },
  decisionPlan: {
    title: "When a decision is approved in Review, propose its plan",
    body: "The work the decision drives — actions, owners, workstreams — arrives as a proposal. Nothing is decided for you.",
  },
  overdueNotify: {
    title: "When work passes its due date, tell its owner",
    body: "One reminder per due date, to the person the work names.",
  },
  externalClose: {
    title: "When Linear, Jira or GitHub marks linked work done, complete it here",
    body: "Applied as the integration without waiting for accept — on the board's history, in the audit log, and undoable. Other changes still wait for a person.",
  },
};

function parseRules(raw: unknown): AutomationSettings | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const out = {} as AutomationSettings;
  for (const rule of AUTOMATION_RULES) out[rule] = record[rule] === true;
  return out;
}

/** The org's rules as the server enforces them, or null (not an owner, offline). */
export async function loadAutomation(orgId: string): Promise<AutomationSettings | null> {
  try {
    const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/settings`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { effective?: { automation?: unknown } };
    return parseRules(body?.effective?.automation);
  } catch {
    return null;
  }
}

/** Turn one rule on or off; the server's resolved rules, or null on failure. */
export async function setAutomationRule(
  orgId: string,
  rule: AutomationRule,
  on: boolean,
): Promise<AutomationSettings | null> {
  try {
    const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify({ automation: { [rule]: on } }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { effective?: { automation?: unknown } };
    return parseRules(body?.effective?.automation);
  } catch {
    return null;
  }
}
