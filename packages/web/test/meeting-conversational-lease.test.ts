import { describe, it, expect, beforeEach } from "vitest";
import { ConversationalLeaseManager } from "../src/meeting-voice.js";

describe("Conversational Lease Engine — Edge Cases", () => {
  let manager: ConversationalLeaseManager;
  const T0 = 1_000_000;

  beforeEach(() => {
    manager = new ConversationalLeaseManager({
      leaseDurationMs: 15_000,
      maxFollowUpTurns: 3,
      knownTeammates: ["Bob", "Charlie", "Alice", "Sarah"],
    });
  });

  // 1. Direct Invocation vs Mentions
  describe("Invocation vs Mentions", () => {
    it("recognizes direct invocation at start: 'Lucent, summarize this'", () => {
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Lucent, summarize this" }, T0);
      expect(res.action).toBe("direct_invoke");
      if (res.action === "direct_invoke") {
        expect(res.query).toBe("summarize this");
        expect(res.speakerId).toBe("Alice");
      }
      expect(manager.getState()).toBe("invoked");
      expect(manager.getLease()?.speakerId).toBe("Alice");
    });

    it("recognizes 'Hey Lucent...' invocation", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "Hey Lucent, who owns mobile?" },
        T0,
      );
      expect(res.action).toBe("direct_invoke");
      if (res.action === "direct_invoke") {
        expect(res.query).toBe("who owns mobile?");
      }
    });

    it("recognizes mid-sentence vocative: 'I think, Lucent, can you explain the pricing decision?'", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "I think, Lucent, can you explain the pricing decision?" },
        T0,
      );
      expect(res.action).toBe("direct_invoke");
      if (res.action === "direct_invoke") {
        expect(res.query).toBe("can you explain the pricing decision?");
      }
    });

    it("ignores passive mention: 'Lucent is fast'", () => {
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Lucent is fast" }, T0);
      expect(res.action).toBe("ignore");
      expect(manager.getState()).toBe("dormant");
    });

    it("ignores 'the lucent approach seems fine'", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "the lucent approach seems fine" },
        T0,
      );
      expect(res.action).toBe("ignore");
      expect(manager.getState()).toBe("dormant");
    });
  });

  // 2. Speaker-Bound 15s Follow-Up Window
  describe("Speaker-Bound Follow-Up Window", () => {
    beforeEach(() => {
      // Alice invokes Lucent
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, what database did we choose?" }, T0);
      manager.onAiStartResponding();
      // TTS completes at T0 + 4,000ms
      manager.onTtsDone(
        "We chose PostgreSQL because it supports robust JSONB queries.",
        T0 + 4_000,
      );
    });

    it("allows the same speaker to ask a continuation 3s later without saying 'Lucent'", () => {
      const now = T0 + 7_000; // 3s after TTS finished
      const res = manager.evaluateTurn({ speaker: "Alice", text: "And what about Redis?" }, now);
      expect(res.action).toBe("followup_query");
      if (res.action === "followup_query") {
        expect(res.query).toBe("And what about Redis?");
        expect(res.speakerId).toBe("Alice");
        expect(res.kind).toBe("continuation");
      }
    });

    it("allows clarification from the same speaker: 'Can you explain that?'", () => {
      const now = T0 + 6_000; // 2s after TTS finished
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Can you explain that?" }, now);
      expect(res.action).toBe("followup_query");
      if (res.action === "followup_query") {
        expect(res.query).toBe("Can you explain that?");
      }
    });

    it("STAYS SILENT if another participant (Bob) speaks during the window", () => {
      const now = T0 + 6_000;
      const res = manager.evaluateTurn({ speaker: "Bob", text: "And what about Redis?" }, now);
      expect(res.action).toBe("ignore");
      if (res.action === "ignore") {
        expect(res.reason).toBe("different_speaker");
      }
      // And the lease should be closed so human discussion continues undisturbed
      expect(manager.getState()).toBe("dormant");
      expect(manager.getLease()).toBeNull();
    });

    it("STAYS SILENT and expires if the same speaker asks after 16s (window > 15s)", () => {
      const now = T0 + 21_000; // 17s after TTS finished (> 15s)
      const res = manager.evaluateTurn({ speaker: "Alice", text: "And what about Redis?" }, now);
      expect(res.action).toBe("ignore");
      if (res.action === "ignore") {
        expect(res.reason).toBe("lease_expired");
      }
      expect(manager.getState()).toBe("dormant");
    });
  });

  // 3. Conversational Dismissals & Handoffs
  describe("Dismissals & Handoffs", () => {
    beforeEach(() => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, summarize the sprint goals" }, T0);
      manager.onAiStartResponding();
      manager.onTtsDone("The sprint goal is to complete the auth flow.", T0 + 3_000);
    });

    it("silently ends lease on 'Okay, thanks'", () => {
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Okay, thanks" }, T0 + 5_000);
      expect(res.action).toBe("dismiss");
      expect(manager.getState()).toBe("dormant");
      expect(manager.getLease()).toBeNull();
    });

    it("silently ends lease on 'That makes sense'", () => {
      const res = manager.evaluateTurn({ speaker: "Alice", text: "That makes sense" }, T0 + 5_000);
      expect(res.action).toBe("dismiss");
      expect(manager.getState()).toBe("dormant");
    });

    it("silently ends lease on 'Back to the team'", () => {
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Back to the team" }, T0 + 5_000);
      expect(res.action).toBe("dismiss");
      expect(manager.getState()).toBe("dormant");
    });

    it("silently ends lease on 'That's all, Lucent.'", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "That's all, Lucent." },
        T0 + 5_000,
      );
      expect(res.action).toBe("dismiss");
      expect(manager.getState()).toBe("dormant");
    });
  });

  // docs/28 F20: "Lucent, stop" used to open a lease and ask Ask "stop".
  describe("Addressed stop phrases", () => {
    it.each([
      "Lucent, stop.",
      "Lucent, stop",
      "Hey Lucent, cancel",
      "Lucent, never mind.",
      "Lucent, nevermind",
      "Lucent, wait!",
      "Lucent, that's enough",
      "Lucent, please stop",
    ])("'%s' is silence, not a question", (text) => {
      const res = manager.evaluateTurn({ speaker: "Alice", text }, T0);
      expect(res.action).toBe("dismiss");
      expect(manager.getState()).toBe("dormant");
      expect(manager.getLease()).toBeNull();
    });

    it("a stop phrase ends a running lease too", () => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, summarize the sprint goals" }, T0);
      manager.onAiStartResponding();
      manager.onTtsDone("The goal is the auth flow.", T0 + 3_000);
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Lucent, stop." }, T0 + 4_000);
      expect(res.action).toBe("dismiss");
      expect(manager.getState()).toBe("dormant");
    });

    it("a real request that starts with one of those words is still a request", () => {
      const wait = manager.evaluateTurn(
        { speaker: "Alice", text: "Lucent, wait, what about Redis?" },
        T0,
      );
      expect(wait.action).toBe("direct_invoke");
      const stopping = manager.evaluateTurn(
        { speaker: "Bob", text: "Lucent, how do we stop the double charges?" },
        T0 + 20_000,
      );
      expect(stopping.action).toBe("direct_invoke");
    });
  });

  // 4. Teammate Cross-Talk Detection (Negative Name Check)
  describe("Addressing other teammates", () => {
    beforeEach(() => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, explain our architecture" }, T0);
      manager.onAiStartResponding();
      manager.onTtsDone("We have an API gateway, auth service, and Postgres.", T0 + 4_000);
    });

    it("detects Alice talking to Bob ('Bob, what do you think?') and stays silent", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "Bob, what do you think?" },
        T0 + 6_000,
      );
      expect(res.action).toBe("ignore");
      if (res.action === "ignore") {
        expect(res.reason).toBe("unrelated");
      }
      expect(manager.getState()).toBe("dormant");
    });
  });

  // 5. Direct Clarification Answers (WAITING_FOR_USER_RESPONSE)
  describe("Direct Clarification Answers", () => {
    beforeEach(() => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, create the database diagram" }, T0);
      manager.onAiStartResponding();
      // Notice the question mark at the end:
      manager.onTtsDone("Do you want PostgreSQL or Redis?", T0 + 3_000);
    });

    it("enters waiting_for_user_response when AI ends with a question", () => {
      expect(manager.getState()).toBe("waiting_for_user_response");
      expect(manager.getLease()?.lastAnswerEndedWithQuestion).toBe(true);
    });

    it("accepts concise direct answer 'Postgres' with high confidence", () => {
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Postgres" }, T0 + 5_000);
      expect(res.action).toBe("followup_query");
      if (res.action === "followup_query") {
        expect(res.kind).toBe("direct_answer");
        expect(res.query).toBe("Postgres");
      }
    });

    it("accepts 'Separately' or 'Yes'", () => {
      const res = manager.evaluateTurn({ speaker: "Alice", text: "Separately" }, T0 + 5_000);
      expect(res.action).toBe("followup_query");
      if (res.action === "followup_query") {
        expect(res.kind).toBe("direct_answer");
      }
    });
  });

  // 6. Canvas Mutation Follow-ups
  describe("Canvas Mutation Intent Routing", () => {
    beforeEach(() => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, build a checkout architecture" }, T0);
      manager.onAiStartResponding();
      manager.onTtsDone("Created the checkout architecture on the canvas.", T0 + 4_000);
    });

    it("classifies 'Move payments underneath checkout' as a canvas mutation", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "Move payments underneath checkout" },
        T0 + 6_000,
      );
      expect(res.action).toBe("followup_mutation");
      if (res.action === "followup_mutation") {
        expect(res.instruction).toBe("Move payments underneath checkout");
        expect(res.speakerId).toBe("Alice");
      }
    });

    it("classifies 'Put Stripe below payments' as a canvas mutation", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "Put Stripe below payments" },
        T0 + 6_000,
      );
      expect(res.action).toBe("followup_mutation");
      if (res.action === "followup_mutation") {
        expect(res.instruction).toBe("Put Stripe below payments");
      }
    });
  });

  // 7. Barge-in & Interruption
  describe("Barge-in / Interruption", () => {
    beforeEach(() => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, explain our architecture" }, T0);
      manager.onAiStartResponding();
    });

    it("halts audio on 'No, stop' during AI responding", () => {
      const barge = manager.onBargeIn("Alice", "No, stop.", T0 + 1_000);
      expect(barge.interrupted).toBe(true);
      expect(manager.getState()).toBe("dormant");
    });

    it("captures correction during AI responding: 'Wait, Lucent, I meant frontend'", () => {
      const barge = manager.onBargeIn("Alice", "Wait, Lucent, I meant frontend", T0 + 1_000);
      expect(barge.interrupted).toBe(true);
      expect(barge.newQuery).toBe("I meant frontend");
      expect(manager.getState()).toBe("invoked");
    });
  });

  // 8. Max Turns Cap
  describe("Max Turns Cap", () => {
    it("enforces max 3 follow-ups before returning to dormant", () => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, question 1" }, T0);
      manager.onAiStartResponding();
      manager.onTtsDone("Answer 1", T0 + 2_000);

      // Follow-up 1
      manager.evaluateTurn({ speaker: "Alice", text: "Why?" }, T0 + 4_000);
      manager.onAiStartResponding();
      manager.onTtsDone("Answer 2", T0 + 6_000);

      // Follow-up 2
      manager.evaluateTurn({ speaker: "Alice", text: "Can you explain that?" }, T0 + 8_000);
      manager.onAiStartResponding();
      manager.onTtsDone("Answer 3", T0 + 10_000);

      // Follow-up 3
      manager.evaluateTurn({ speaker: "Alice", text: "Tell me more" }, T0 + 12_000);
      manager.onAiStartResponding();
      manager.onTtsDone("Answer 4", T0 + 14_000);

      // 4th follow-up exceeds cap!
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "And what about Redis?" },
        T0 + 16_000,
      );
      expect(res.action).toBe("ignore");
      if (res.action === "ignore") {
        expect(res.reason).toBe("max_turns_exceeded");
      }
      expect(manager.getState()).toBe("dormant");
    });
  });

  // 9. Another user invoking Lucent explicitly transfers the lease
  describe("Lease transfer", () => {
    it("allows Bob to take over by saying 'Lucent...'", () => {
      manager.evaluateTurn({ speaker: "Alice", text: "Lucent, question from Alice" }, T0);
      manager.onAiStartResponding();
      manager.onTtsDone("Answer to Alice", T0 + 3_000);

      // Bob explicitly invokes Lucent
      const res = manager.evaluateTurn(
        { speaker: "Bob", text: "Lucent, question from Bob" },
        T0 + 5_000,
      );
      expect(res.action).toBe("direct_invoke");
      if (res.action === "direct_invoke") {
        expect(res.speakerId).toBe("Bob");
      }
      expect(manager.getLease()?.speakerId).toBe("Bob");
    });
  });

  // 10. Phonetic STT matching and direct mutations
  describe("Phonetic Addressing & Direct Mutations", () => {
    it("recognizes phonetic 'loosened' STT transcriptions", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "loosened, what is this board about?" },
        T0,
      );
      expect(res.action).toBe("direct_invoke");
      if (res.action === "direct_invoke") {
        expect(res.query).toBe("what is this board about?");
        expect(res.speakerId).toBe("Alice");
      }
    });

    it("recognizes 'Hey loosen...' STT transcriptions", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "Hey loosen, explain the architecture" },
        T0,
      );
      expect(res.action).toBe("direct_invoke");
      if (res.action === "direct_invoke") {
        expect(res.query).toBe("explain the architecture");
      }
    });

    it("routes explicit diagram creation commands to direct_mutation", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "Lucent, draw a flowchart of our login process" },
        T0,
      );
      expect(res.action).toBe("direct_mutation");
      if (res.action === "direct_mutation") {
        expect(res.instruction).toBe("draw a flowchart of our login process");
        expect(res.speakerId).toBe("Alice");
      }
    });

    it("routes phonetic diagram creation commands to direct_mutation", () => {
      const res = manager.evaluateTurn(
        { speaker: "Alice", text: "loosened, create an architecture diagram for checkout" },
        T0,
      );
      expect(res.action).toBe("direct_mutation");
      if (res.action === "direct_mutation") {
        expect(res.instruction).toBe("create an architecture diagram for checkout");
      }
    });
  });
});
