import { describe, expect, it } from "vitest";
import {
  applyOperations,
  computeLayout,
  createWorkspace,
  evaluateVoicePolicy,
  validateOperations,
  type Operation,
  type VoiceTurn,
  type Workspace,
} from "@lucent/core";
import { ConversationalLeaseManager } from "../src/meeting-voice.js";
import { speakAnswer, type TtsProvider } from "../src/tts.js";
import { spokenReply } from "../src/voiceConversation.js";

describe("Complete Voice -> Canvas Golden Pipeline (Phase 2 / Task 2.2)", () => {
  it("executes the full spoken utterance to visual canvas transformation and spoken reply", async () => {
    // 0. Initial board setup with an existing Payment Service
    let ws: Workspace = createWorkspace();
    const initOps: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "node_payment",
        label: "Payment Service",
        nodeType: "service",
      },
    ];
    ws = applyOperations(ws, initOps);
    expect(Object.keys(ws.nodes)).toHaveLength(1);

    const leaseManager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
    let t = 1000;

    // 1. User Speaks: "Lucent, add Stripe to the payment architecture and connect it to the payment service."
    const turn1Text = "Lucent, add Stripe to the payment architecture and connect it to the payment service.";
    const turn1: VoiceTurn = {
      id: "turn_1",
      text: turn1Text,
      speakerId: "alice",
      at: t,
      source: "browser",
    };

    // 2. Lease & Response Policy Evaluation
    const turn1Eval = leaseManager.evaluateTurn({ speaker: "alice", text: turn1Text }, t);
    expect(turn1Eval.action).toBe("direct_mutation");

    const policy1 = evaluateVoicePolicy(turn1, {
      mode: "assistant",
      leaseActive: false,
      userRole: "editor",
    });
    expect(policy1.capture).toBe(true);
    expect(policy1.speak).toBe(true);
    expect(policy1.act).toBe(true);
    expect(policy1.intent.kind).toBe("mutation");

    // 3. AI visual operations generation
    const proposedOps: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "node_stripe",
        label: "Stripe",
        nodeType: "service",
      },
      {
        op: "CONNECT_NODES",
        source: "node_payment",
        target: "node_stripe",
        relationship: "processes",
      },
    ];

    // Invariant Check: AI NEVER supplies coordinates for semantic nodes
    for (const op of proposedOps) {
      expect((op as unknown as { position?: unknown }).position).toBeUndefined();
    }

    // 4. Semantic Validation
    const errors = validateOperations(ws, proposedOps);
    expect(errors).toHaveLength(0);

    // 5. Core Reducer commits operations
    ws = applyOperations(ws, proposedOps);
    expect(Object.keys(ws.nodes)).toHaveLength(2);
    expect(Object.keys(ws.edges)).toHaveLength(1);

    // 6. Layout Engine calculates geometric coordinates deterministically
    const layout = computeLayout(ws, { strategy: "layered" });
    expect(layout["node_payment"]).toBeDefined();
    expect(layout["node_stripe"]).toBeDefined();
    expect(typeof layout["node_stripe"]?.position.x).toBe("number");
    expect(typeof layout["node_stripe"]?.position.y).toBe("number");

    // 7. Explanations & Spoken Reply
    const outcome = {
      outcome: "applied" as const,
      ops: 2,
      reply: "Done. I added Stripe and connected the payment service. Should I add webhook handlers for payment events?",
      explanation: "Added Stripe service node and connected Payment Service to it.",
    };
    const replyText = spokenReply(outcome);
    expect(replyText).toBe(
      "Done. I added Stripe and connected the payment service. Should I add webhook handlers for payment events?",
    );

    // 8. TTS Execution
    let ttsSpoke = false;
    const testBrowserTts: TtsProvider = {
      id: "browser",
      isSupported: () => true,
      unavailableReason: () => null,
      speak: async (text: string) => {
        expect(text).toContain("Done. I added Stripe");
        ttsSpoke = true;
        return { stop: () => {}, done: Promise.resolve() };
      },
    };
    const ttsResult = await speakAnswer(replyText!, undefined, testBrowserTts);
    expect(ttsSpoke).toBe(true);
    expect(ttsResult.provider).toBe("browser");

    // Inform lease manager that TTS completed
    t = 3000;
    leaseManager.onAiStartResponding();
    leaseManager.onTtsDone(replyText!, t);
    expect(leaseManager.getState()).toBe("waiting_for_user_response"); // Reply ended with a question

    // 9. Conversational Continuity (Turn 2 under active lease without saying "Lucent")
    // User after 4s (t = 7000): "Actually, put Stripe behind the payment service."
    t = 7000;
    const turn2Text = "Actually, put Stripe behind the payment service.";
    const turn2Eval = leaseManager.evaluateTurn({ speaker: "alice", text: turn2Text }, t);
    expect(turn2Eval.action).toBe("followup_mutation");

    // Update diagram relationship
    const turn2Ops: Operation[] = [
      {
        op: "DISCONNECT_NODES",
        source: "node_payment",
        target: "node_stripe",
        relationship: "processes",
      },
      {
        op: "CONNECT_NODES",
        source: "node_stripe",
        target: "node_payment",
        relationship: "depends_on",
      },
    ];
    ws = applyOperations(ws, turn2Ops);
    const updatedEdge = Object.values(ws.edges)[0];
    expect(updatedEdge?.source).toBe("node_stripe");
    expect(updatedEdge?.target).toBe("node_payment");
    expect(updatedEdge?.relationship).toBe("depends_on");
  });
});
