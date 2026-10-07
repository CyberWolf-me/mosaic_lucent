import { describe, expect, it } from "vitest";
import {
  applyOperation,
  createWorkspace,
  evaluateVoicePolicy,
  type Operation,
  type VoiceTurn,
  type Workspace,
} from "@lucent/core";

describe('"Do Not Act" Speculative Speech Adversarial Suite (Phase 2 / Task 2.3)', () => {
  const speculativePhrases = [
    "We're thinking about using Stripe.",
    "Maybe we should put Redis here.",
    "Sarah said we should remove the queue.",
    "I don't think we should use Kafka.",
    "What if we move the payment service?",
    "We were considering adding auth.",
    "Could be that we need a cache.",
    "Probably going to use PostgreSQL.",
    "Someone suggested we delete the gateway.",
  ];

  it("strictly enforces act=false and zero board operations for all speculative phrases", () => {
    let ws: Workspace = createWorkspace();
    const initNode: Operation = {
      op: "CREATE_NODE",
      id: "node_1",
      label: "API Gateway",
      nodeType: "service",
    };
    ws = applyOperation(ws, initNode);
    const initialNodeCount = Object.keys(ws.nodes).length;
    expect(initialNodeCount).toBe(1);

    for (const phrase of speculativePhrases) {
      const turn: VoiceTurn = {
        id: `turn_${Math.random()}`,
        text: phrase,
        speakerId: "engineer_1",
        at: Date.now(),
        source: "livekit",
      };

      const decision = evaluateVoicePolicy(turn, {
        mode: "assistant",
        leaseActive: false,
        userRole: "editor",
      });

      // Must be captured into meeting context
      expect(decision.capture).toBe(true);
      // Must NOT produce spoken audio unprompted
      expect(decision.speak).toBe(false);
      // Must NEVER mutate the workspace
      expect(decision.act).toBe(false);
      expect(decision.intent.kind).toBe("speculative");

      // Verify workspace remained 100% untouched
      expect(Object.keys(ws.nodes)).toHaveLength(initialNodeCount);
    }
  });

  it("answers conversationally but does NOT mutate when a speculative question addresses Lucent", () => {
    let ws: Workspace = createWorkspace();
    const initNode: Operation = {
      op: "CREATE_NODE",
      id: "node_payments",
      label: "Payment Service",
      nodeType: "service",
    };
    ws = applyOperation(ws, initNode);

    // User asks Lucent a hypothetical question:
    // "Lucent, what if we move the payment service?"
    const turn: VoiceTurn = {
      id: "turn_hypothetical",
      text: "Lucent, what if we move the payment service?",
      speakerId: "architect",
      at: Date.now(),
      source: "browser",
    };

    const decision = evaluateVoicePolicy(turn, {
      mode: "assistant",
      leaseActive: false,
      userRole: "editor",
    });

    // Captures the question
    expect(decision.capture).toBe(true);
    // Lucent SPEAKS its advice/thoughts
    expect(decision.speak).toBe(true);
    // But Lucent does NOT mutate the canvas on a "what if" hypothesis!
    expect(decision.act).toBe(false);
    expect(decision.intent.kind).toBe("inquiry");

    // Board remains untouched
    expect(Object.keys(ws.nodes)).toHaveLength(1);
  });

  it("contrasts with explicit imperative commands which DO authorize mutations", () => {
    let ws: Workspace = createWorkspace();
    const initNode: Operation = {
      op: "CREATE_NODE",
      id: "node_payments",
      label: "Payment Service",
      nodeType: "service",
    };
    ws = applyOperation(ws, initNode);

    // Now user issues explicit imperative command:
    // "Lucent, put Stripe behind the payment service."
    const turn: VoiceTurn = {
      id: "turn_imperative",
      text: "Lucent, put Stripe behind the payment service.",
      speakerId: "architect",
      at: Date.now(),
      source: "browser",
    };

    const decision = evaluateVoicePolicy(turn, {
      mode: "assistant",
      leaseActive: false,
      userRole: "editor",
    });

    expect(decision.capture).toBe(true);
    expect(decision.speak).toBe(true);
    // Explicit command authorizes mutation!
    expect(decision.act).toBe(true);
    expect(decision.intent.kind).toBe("mutation");

    // Apply the authorized operation
    const stripeOp: Operation = {
      op: "CREATE_NODE",
      id: "node_stripe",
      label: "Stripe",
      nodeType: "service",
    };
    ws = applyOperation(ws, stripeOp);
    expect(Object.keys(ws.nodes)).toHaveLength(2);
  });
});
