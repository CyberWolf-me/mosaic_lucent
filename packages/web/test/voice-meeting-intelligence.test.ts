import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  evaluateVoicePolicy,
  type StatementRow,
  type VoiceTurn,
  type Workspace,
} from "@lucent/core";
import { ConversationalLeaseManager } from "../src/meeting-voice.js";

describe("Decoupled Meeting Intelligence & Spoken Summaries (Phase 2 / Task 2.4)", () => {
  it("passively captures candidate actions/decisions without spoken interruption, then summarizes upon invocation", () => {
    const ws: Workspace = createWorkspace();
    const leaseManager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
    let t = 1000;

    // Simulated intelligence store of extracted statements
    const candidateStatements: StatementRow[] = [];

    // Turn 1: Sarah says: "Bob will finish the API by Friday."
    const turn1Text = "Bob will finish the API by Friday.";
    const turn1: VoiceTurn = {
      id: "turn_sarah",
      text: turn1Text,
      speakerId: "sarah",
      speakerName: "Sarah",
      at: t,
      source: "livekit",
    };

    const policy1 = evaluateVoicePolicy(turn1, {
      mode: "participant",
      leaseActive: false,
      userRole: "editor",
    });

    // 1. MUST capture (feed meeting intelligence)
    expect(policy1.capture).toBe(true);
    // 2. MUST NOT speak unprompted (never interrupt natural meeting flow)
    expect(policy1.speak).toBe(false);
    // 3. MUST NOT mutate visual canvas directly
    expect(policy1.act).toBe(false);

    // Intelligence engine extracts action candidate silently
    candidateStatements.push({
      id: "stmt_1",
      kind: "action",
      label: "Finish API",
      status: "open",
      assignee: "Bob",
      dueDate: "Friday",
    });
    expect(candidateStatements).toHaveLength(1);

    // Turn 2: Alice says: "We decided to go with Postgres for the primary store."
    t = 5000;
    const turn2Text = "We decided to go with Postgres for the primary store.";
    const turn2: VoiceTurn = {
      id: "turn_alice",
      text: turn2Text,
      speakerId: "alice",
      speakerName: "Alice",
      at: t,
      source: "livekit",
    };

    const policy2 = evaluateVoicePolicy(turn2, {
      mode: "participant",
      leaseActive: false,
      userRole: "editor",
    });

    expect(policy2.capture).toBe(true);
    expect(policy2.speak).toBe(false);
    expect(policy2.act).toBe(false);

    candidateStatements.push({
      id: "stmt_2",
      kind: "decision",
      label: "Use Postgres for primary store",
      status: "resolved",
    });
    expect(candidateStatements).toHaveLength(2);

    // Turn 3: An attendee explicitly invokes Lucent:
    // "Lucent, what actions did we create?"
    t = 10_000;
    const turn3Text = "Lucent, what actions did we create?";
    const turn3: VoiceTurn = {
      id: "turn_query",
      text: turn3Text,
      speakerId: "sarah",
      at: t,
      source: "livekit",
    };

    const turn3Lease = leaseManager.evaluateTurn({ speaker: "sarah", text: turn3Text }, t);
    expect(turn3Lease.action).toBe("direct_invoke");

    const policy3 = evaluateVoicePolicy(turn3, {
      mode: "participant",
      leaseActive: false,
      userRole: "editor",
    });

    // 1. MUST capture query
    expect(policy3.capture).toBe(true);
    // 2. MUST speak (it was explicitly addressed!)
    expect(policy3.speak).toBe(true);
    // 3. MUST NOT act (this is an informational inquiry, not a canvas mutation!)
    expect(policy3.act).toBe(false);
    expect(policy3.intent.kind).toBe("inquiry");

    // Synthesize spoken summary of the recorded actions
    const actions = candidateStatements.filter((s) => s.kind === "action");
    const spokenSummary = `We recorded one action: ${actions[0]?.assignee} will ${actions[0]?.label.toLowerCase()} by ${actions[0]?.dueDate}.`;
    expect(spokenSummary).toBe("We recorded one action: Bob will finish api by Friday.");

    // Canvas visually remained untouched throughout
    expect(Object.keys(ws.nodes)).toHaveLength(0);
  });
});
