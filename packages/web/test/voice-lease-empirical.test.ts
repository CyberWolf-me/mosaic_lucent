import { describe, expect, it } from "vitest";
import { ConversationalLeaseManager } from "../src/meeting-voice.js";

describe("Conversational Lease Empirical Matrix & Boundaries (Phase 1 / Task 1.4)", () => {
  const durations = [5_000, 10_000, 15_000, 20_000, 30_000];

  describe("Duration Matrix Thresholds", () => {
    durations.forEach((durationMs) => {
      it(`enforces precise boundaries for leaseDuration = ${durationMs}ms`, () => {
        const manager = new ConversationalLeaseManager({ leaseDurationMs: durationMs });
        const start = 10_000;

        // 1. Invocation
        manager.onExplicitInvocation("alice", "explain the architecture", "Alice", start);
        manager.onAiStartResponding();

        // 2. TTS finishes at start + 2000ms
        const ttsDoneAt = start + 2000;
        manager.onTtsDone("The architecture has an API gateway and payment service.", ttsDoneAt);

        expect(manager.getState()).toBe("waiting_for_followup");
        const lease = manager.getLease();
        expect(lease).not.toBeNull();
        expect(lease?.expiresAt).toBe(ttsDoneAt + durationMs);

        // Turn right before expiration boundary (100ms before)
        const insideBoundary = ttsDoneAt + durationMs - 100;
        const resultInside = manager.evaluateTurn(
          { speaker: "alice", text: "And where does the database sit?" },
          insideBoundary,
        );
        expect(resultInside.action).toBe("followup_query");

        // Now test after expiration (100ms after new expiration or resetting)
        manager.onTtsDone("The database sits behind the backend.", insideBoundary + 1000);
        const expiredTime = insideBoundary + 1000 + durationMs + 100;
        const resultExpired = manager.evaluateTurn(
          { speaker: "alice", text: "What did we decide?" },
          expiredTime,
        );
        expect(resultExpired.action).toBe("ignore");
        if (resultExpired.action === "ignore") {
          expect(resultExpired.reason).toBe("lease_expired");
        }
        expect(manager.getState()).toBe("dormant");
      });
    });
  });

  describe("Conversational Multi-Turn Golden Flow (15s Default)", () => {
    it("handles the exact user conversation script from specification", () => {
      const manager = new ConversationalLeaseManager({
        leaseDurationMs: 15_000,
        knownTeammates: ["Bob", "Sarah"],
      });

      let t = 1000;

      // 1. User: "Lucent, explain the payment flow."
      const turn1 = manager.evaluateTurn(
        { speaker: "alice", text: "Lucent, explain the payment flow." },
        t,
      );
      expect(turn1.action).toBe("direct_invoke");
      expect(manager.getState()).toBe("invoked");

      // Lucent speaks and finishes at t = 3000
      t = 3000;
      manager.onAiStartResponding();
      manager.onTtsDone("The payment flow connects checkout to Stripe with webhooks.", t);
      expect(manager.getState()).toBe("waiting_for_followup");

      // 2. User after 5s (t = 8000): "And where does the database sit?" -> should answer without wake word
      t = 8000;
      const turn2 = manager.evaluateTurn(
        { speaker: "alice", text: "And where does the database sit?" },
        t,
      );
      expect(turn2.action).toBe("followup_query");

      // Lucent speaks and finishes at t = 10000
      t = 10_000;
      manager.onAiStartResponding();
      manager.onTtsDone("The database sits directly behind the orders service.", t);

      // 3. User after 14.9s (t = 24900): "And what about refunds?" -> boundary case, should answer
      t = 24_900;
      const turn3 = manager.evaluateTurn(
        { speaker: "alice", text: "And what about refunds?" },
        t,
      );
      expect(turn3.action).toBe("followup_query");

      // Lucent finishes at t = 27000
      t = 27_000;
      manager.onAiStartResponding();
      manager.onTtsDone("Refunds are handled through the Stripe refund API.", t);

      // 4. User after 20s (t = 47000): "What did we decide?" -> should require invocation
      t = 47_000;
      const turn4 = manager.evaluateTurn(
        { speaker: "alice", text: "What did we decide?" },
        t,
      );
      expect(turn4.action).toBe("ignore");
      if (turn4.action === "ignore") {
        expect(turn4.reason).toBe("lease_expired");
      }
      expect(manager.getState()).toBe("dormant");

      // 5. Re-open lease with explicit invocation
      t = 48_000;
      const turn5 = manager.evaluateTurn(
        { speaker: "alice", text: "Lucent, explain shipping flow" },
        t,
      );
      expect(turn5.action).toBe("direct_invoke");
      manager.onAiStartResponding();
      manager.onTtsDone("Shipping flow begins once payment is captured.", t + 2000);
      t += 2000;

      // 6. Another participant speaks (Bob): "Yeah, what about shipping?" -> lease should close/suspend
      t += 3000;
      const turn6 = manager.evaluateTurn(
        { speaker: "bob", text: "Yeah, what about shipping?" },
        t,
      );
      expect(turn6.action).toBe("ignore");
      if (turn6.action === "ignore") {
        expect(turn6.reason).toBe("different_speaker");
      }
      expect(manager.getState()).toBe("dormant");

      // 7. Original speaker (Alice): "Lucent, actually..." -> explicit invocation reopens it
      t += 2000;
      const turn7 = manager.evaluateTurn(
        { speaker: "alice", text: "Lucent, actually can you add a shipping queue?" },
        t,
      );
      expect(turn7.action).toBe("direct_mutation");
      expect(manager.getState()).toBe("invoked");
      expect(manager.getLease()?.speakerId).toBe("alice");
    });

    it("immediately dismisses the lease when user addresses a known teammate", () => {
      const manager = new ConversationalLeaseManager({
        leaseDurationMs: 15_000,
        knownTeammates: ["Bob", "Sarah"],
      });

      manager.onExplicitInvocation("alice", "draw payments", "Alice", 1000);
      manager.onTtsDone("Done. I drew payments.", 2000);

      // Alice turns to Bob
      const res = manager.evaluateTurn(
        { speaker: "alice", text: "Bob, what do you think of this?" },
        3000,
      );
      expect(res.action).toBe("ignore");
      if (res.action === "ignore") {
        expect(res.reason).toBe("unrelated");
      }
      expect(manager.getState()).toBe("dormant");
    });

    it("silently ends lease on conversational sign-offs", () => {
      const manager = new ConversationalLeaseManager({ leaseDurationMs: 15_000 });
      manager.onExplicitInvocation("alice", "draw payments", "Alice", 1000);
      manager.onTtsDone("Done. I drew payments.", 2000);

      const res = manager.evaluateTurn({ speaker: "alice", text: "Thanks Lucent, that's all" }, 3000);
      expect(res.action).toBe("dismiss");
      if (res.action === "dismiss") {
        expect(res.reason).toBe("conversational_handoff");
      }
      expect(manager.getState()).toBe("dormant");
    });
  });
});
