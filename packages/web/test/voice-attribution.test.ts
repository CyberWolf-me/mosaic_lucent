import { describe, expect, it } from "vitest";
import { ConversationalLeaseManager } from "../src/meeting-voice.js";
import { evaluateVoicePolicy, type ResponsePolicyContext, type VoiceTurn } from "@lucent/core";

describe("Speaker Attribution Adversarial Suite (Phase 2 / Task 2.1)", () => {
  const policyCtx = (leaseActive: boolean, leaseSpeakerId?: string): ResponsePolicyContext => ({
    mode: "assistant",
    leaseActive,
    leaseSpeakerId,
    userRole: "editor",
  });

  describe("Rule: The person who invoked Lucent owns the conversational lease", () => {
    it("locks the lease to the invoking speaker and rejects cross-talk", () => {
      const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
      let t = 1000;

      // Alice invokes Lucent
      const turnA1 = manager.evaluateTurn(
        { speaker: "alice", text: "Lucent, how should we structure the payments?" },
        t,
      );
      expect(turnA1.action).toBe("direct_invoke");
      expect(manager.getLease()?.speakerId).toBe("alice");

      // Lucent finishes speaking at t = 3000
      t = 3000;
      manager.onAiStartResponding();
      manager.onTtsDone("You should separate checkout, payment processor, and ledger.", t);
      expect(manager.getState()).toBe("waiting_for_followup");

      // Bob speaks while Alice holds the lease
      t = 4000;
      const turnB = manager.evaluateTurn(
        { speaker: "bob", text: "Yeah, and we should also use Stripe." },
        t,
      );

      // The lease must NOT be transferred to Bob
      expect(turnB.action).toBe("ignore");
      if (turnB.action === "ignore") {
        expect(turnB.reason).toBe("different_speaker");
      }
      // Bob speaking breaks the lease back to dormant
      expect(manager.getState()).toBe("dormant");
      expect(manager.getLease()).toBeNull();

      // Alice re-invokes Lucent
      t = 5000;
      const turnA2 = manager.evaluateTurn(
        { speaker: "alice", text: "Lucent, continue with the ledger details" },
        t,
      );
      expect(turnA2.action).toBe("direct_invoke");
      expect(manager.getLease()?.speakerId).toBe("alice");
    });

    it("prevents third-party participants from answering clarification questions meant for the invoker", () => {
      const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
      let t = 1000;

      // Alice asks to add a database
      manager.onExplicitInvocation("alice", "add a database", "Alice", t);
      manager.onClarificationAsked(
        "add a database",
        "Which database: Postgres or Redis?",
        t + 1000,
      );
      expect(manager.getState()).toBe("waiting_for_user_response");
      expect(manager.getLease()?.speakerId).toBe("alice");

      // Bob speaks up instead of Alice
      t = 3000;
      const turnB = manager.evaluateTurn({ speaker: "bob", text: "Postgres for sure" }, t);

      // Bob does not own the clarification answer
      expect(turnB.action).toBe("ignore");
      if (turnB.action === "ignore") {
        expect(turnB.reason).toBe("different_speaker");
      }
      expect(manager.getState()).toBe("dormant");
    });
  });

  describe("Simultaneous and Interleaved Speech", () => {
    it("evaluates simultaneous speech from two participants independently", () => {
      const t = 10_000;

      const turnAlice: VoiceTurn = {
        id: "t_alice",
        text: "Lucent, add Stripe",
        speakerId: "spk_alice",
        at: t,
        source: "livekit",
      };

      const turnBob: VoiceTurn = {
        id: "t_bob",
        text: "I think we should take lunch soon",
        speakerId: "spk_bob",
        at: t,
        source: "livekit",
      };

      const decisionAlice = evaluateVoicePolicy(turnAlice, policyCtx(false));
      const decisionBob = evaluateVoicePolicy(turnBob, policyCtx(false));

      // Alice explicitly addressed Lucent with a command
      expect(decisionAlice.capture).toBe(true);
      expect(decisionAlice.speak).toBe(true);
      expect(decisionAlice.act).toBe(true);
      expect(decisionAlice.intent.kind).toBe("mutation");

      // Bob spoke general discussion simultaneously
      expect(decisionBob.capture).toBe(true);
      expect(decisionBob.speak).toBe(false);
      expect(decisionBob.act).toBe(false);
      expect(decisionBob.intent.kind).toBe("discussion");
    });

    it("handles diarized stream labels (spk_01 vs spk_02) accurately", () => {
      const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
      let t = 1000;

      // Speaker 01 invokes
      const res1 = manager.evaluateTurn(
        { speaker: "spk_01", text: "Lucent, explain the database cluster" },
        t,
      );
      expect(res1.action).toBe("direct_invoke");
      expect(manager.getLease()?.speakerId).toBe("spk_01");

      manager.onAiStartResponding();
      manager.onTtsDone("The cluster has one primary and two read replicas.", t + 2000);

      // Speaker 01 follows up within 5s
      t = 4000;
      const res2 = manager.evaluateTurn(
        { speaker: "spk_01", text: "And what is the failover time?" },
        t,
      );
      expect(res2.action).toBe("followup_query");

      manager.onAiStartResponding();
      manager.onTtsDone("Failover time is approximately 10 to 15 seconds.", t + 2000);

      // Speaker 02 chimes in
      t = 8000;
      const res3 = manager.evaluateTurn({ speaker: "spk_02", text: "That sounds fine with me" }, t);
      expect(res3.action).toBe("ignore");
      if (res3.action === "ignore") {
        expect(res3.reason).toBe("different_speaker");
      }
    });

    it("restores identity correctly when participant reconnects with same ID", () => {
      const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
      const t = 1000;

      // User invokes Lucent
      manager.onExplicitInvocation("user_persist_123", "draw architecture", "Alice", t);
      manager.onTtsDone("Drawn.", t + 1000);

      // Participant temporarily disconnects/reconnects but re-enters with their user ID
      const followup = manager.evaluateTurn(
        { speaker: "user_persist_123", text: "And add Redis" },
        t + 3000,
      );

      expect(followup.action).toBe("followup_mutation");
    });
  });
});
