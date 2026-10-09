import { describe, expect, it } from "vitest";
import {
  addressesOtherPerson,
  detectAddress,
  detectDismissal,
  evaluateVoicePolicy,
  isMutationUtterance,
  isSpeculativeSpeech,
  isStopRequest,
  VoiceFSM,
  type ResponsePolicyContext,
  type VoiceTurn,
} from "../src/voice.js";

describe("Voice Semantic Contract & Policy (Core)", () => {
  describe("detectAddress", () => {
    it("detects front address invocations with query", () => {
      const res = detectAddress("Lucent, add a payment gateway");
      expect(res.addressed).toBe(true);
      expect(res.type).toBe("explicit_lead");
      expect(res.query).toBe("add a payment gateway");
    });

    it("detects polite variations like 'Hey Lucent' or 'Okay Lucent'", () => {
      const res1 = detectAddress("Hey Lucent, connect checkout to payments");
      expect(res1.addressed).toBe(true);
      expect(res1.query).toBe("connect checkout to payments");

      const res2 = detectAddress("Okay Lucent: explain this architecture");
      expect(res2.addressed).toBe(true);
      expect(res2.query).toBe("explain this architecture");
    });

    it("detects mid-sentence vocatives", () => {
      const res = detectAddress("I think, Lucent, can you move the database?");
      expect(res.addressed).toBe(true);
      expect(res.type).toBe("explicit_vocative");
      expect(res.query).toBe("can you move the database?");
    });

    it("ignores passive mentions without vocatives", () => {
      const res1 = detectAddress("Lucent is really fast");
      expect(res1.addressed).toBe(false);

      const res2 = detectAddress("the lucent approach seems good");
      expect(res2.addressed).toBe(false);
    });

    it("handles bare 'Lucent' with no query as addressed but empty query", () => {
      const res = detectAddress("Lucent");
      expect(res.addressed).toBe(true);
      expect(res.query).toBe("");
    });
  });

  describe("speculative speech vs imperative mutations", () => {
    it("detects speculative and hypothetical thoughts as speculative", () => {
      expect(isSpeculativeSpeech("We're thinking about using Stripe.")).toBe(true);
      expect(isSpeculativeSpeech("Maybe we should put Redis here.")).toBe(true);
      expect(isSpeculativeSpeech("Sarah said we should remove the queue.")).toBe(true);
      expect(isSpeculativeSpeech("I don't think we should use Kafka.")).toBe(true);
      expect(isSpeculativeSpeech("What if we move the payment service?")).toBe(true);
      expect(isSpeculativeSpeech("We were discussing whether to add a cache.")).toBe(true);
    });

    it("does not classify speculative speech as imperative mutation", () => {
      expect(isMutationUtterance("We're thinking about using Stripe.")).toBe(false);
      expect(isMutationUtterance("Maybe we should put Redis here.")).toBe(false);
      expect(isMutationUtterance("What if we move the payment service?")).toBe(false);
    });

    it("classifies direct commands as mutations", () => {
      expect(isMutationUtterance("Add Stripe to the payment architecture")).toBe(true);
      expect(isMutationUtterance("Move payments below checkout")).toBe(true);
      expect(isMutationUtterance("Connect the auth service to Postgres")).toBe(true);
      expect(isMutationUtterance("Draw a flowchart of login")).toBe(true);
      expect(isMutationUtterance("Delete the deprecated queue")).toBe(true);
    });
  });

  describe("detectDismissal & isStopRequest", () => {
    it("recognizes dismissals", () => {
      expect(detectDismissal("Thanks Lucent")).toBe(true);
      expect(detectDismissal("Thank you, that's all")).toBe(true);
      expect(detectDismissal("Got it")).toBe(true);
      expect(detectDismissal("Back to the team")).toBe(true);
      expect(detectDismissal("Okay we're done")).toBe(true);
      expect(detectDismissal("Goodbye")).toBe(true);
    });

    it("recognizes stop requests", () => {
      expect(isStopRequest("stop")).toBe(true);
      expect(isStopRequest("Lucent, stop")).toBe(false); // isStopRequest takes cleaned query
      expect(isStopRequest("cancel")).toBe(true);
      expect(isStopRequest("wait, hold on")).toBe(true);
      expect(isStopRequest("quiet now")).toBe(true);
    });
  });

  describe("addressesOtherPerson", () => {
    it("detects speech addressing other teammates", () => {
      const teammates = ["Alice", "Bob", "Charlie"];
      expect(addressesOtherPerson("Bob, what do you think?", teammates)).toBe(true);
      expect(addressesOtherPerson("Alice, can you check Jira?", teammates)).toBe(true);
      expect(addressesOtherPerson("Wait Charlie: who owns this?", teammates)).toBe(true);
      expect(addressesOtherPerson("Lucent, move the card", teammates)).toBe(false);
    });
  });

  describe("evaluateVoicePolicy (The 3 Questions: Capture, Speak, Act)", () => {
    const makeTurn = (text: string, speakerId = "user_1"): VoiceTurn => ({
      id: "turn_1",
      text,
      speakerId,
      at: Date.now(),
      source: "browser",
    });

    const assistantCtx: ResponsePolicyContext = {
      mode: "assistant",
      leaseActive: false,
      userRole: "editor",
    };

    it("Case 1: Speculative unaddressed chat -> capture=true, speak=false, act=false", () => {
      const decision = evaluateVoicePolicy(
        makeTurn("We're thinking about using Stripe."),
        assistantCtx,
      );
      expect(decision.capture).toBe(true);
      expect(decision.speak).toBe(false);
      expect(decision.act).toBe(false);
      expect(decision.intent.kind).toBe("speculative");
    });

    it("Case 2: Explicit command -> capture=true, speak=true, act=true", () => {
      const decision = evaluateVoicePolicy(
        makeTurn("Lucent, add Stripe and connect it to checkout"),
        assistantCtx,
      );
      expect(decision.capture).toBe(true);
      expect(decision.speak).toBe(true);
      expect(decision.act).toBe(true);
      expect(decision.intent.kind).toBe("mutation");
    });

    it("Case 3: Explicit inquiry -> capture=true, speak=true, act=false", () => {
      const decision = evaluateVoicePolicy(
        makeTurn("Lucent, what are the bottlenecks in this flow?"),
        assistantCtx,
      );
      expect(decision.capture).toBe(true);
      expect(decision.speak).toBe(true);
      expect(decision.act).toBe(false);
      expect(decision.intent.kind).toBe("inquiry");
    });

    it("Case 4: Conversational lease follow-up without wake word -> capture=true, speak=true, act=true", () => {
      const leaseCtx: ResponsePolicyContext = {
        mode: "assistant",
        leaseActive: true,
        leaseSpeakerId: "user_1",
        userRole: "editor",
      };
      const decision = evaluateVoicePolicy(
        makeTurn("And put Redis next to Postgres", "user_1"),
        leaseCtx,
      );
      expect(decision.capture).toBe(true);
      expect(decision.speak).toBe(true);
      expect(decision.act).toBe(true);
      expect(decision.intent.invocation).toBe("lease_followup");
    });

    it("Case 5: Cross-talk during active lease -> capture=true, speak=false, act=false", () => {
      const leaseCtx: ResponsePolicyContext = {
        mode: "assistant",
        leaseActive: true,
        leaseSpeakerId: "user_1",
        userRole: "editor",
      };
      // Different speaker speaks without saying Lucent
      const decision = evaluateVoicePolicy(
        makeTurn("What about authentication?", "user_2"),
        leaseCtx,
      );
      expect(decision.capture).toBe(true);
      expect(decision.speak).toBe(false);
      expect(decision.act).toBe(false);
      expect(decision.intent.invocation).toBe("unaddressed");
    });

    it("Case 6: Record mode -> captures everything, speaks never, mutates never", () => {
      const recordCtx: ResponsePolicyContext = {
        mode: "record",
        leaseActive: false,
        userRole: "editor",
      };
      const decision = evaluateVoicePolicy(
        makeTurn("Lucent, redesign the entire diagram"),
        recordCtx,
      );
      expect(decision.capture).toBe(true);
      expect(decision.speak).toBe(false);
      expect(decision.act).toBe(false);
      expect(decision.reason).toBe("record_mode_silent");
    });

    it("Case 7: Viewer role cannot mutate canvas even if explicitly asked", () => {
      const viewerCtx: ResponsePolicyContext = {
        mode: "assistant",
        leaseActive: false,
        userRole: "viewer",
      };
      const decision = evaluateVoicePolicy(makeTurn("Lucent, add Stripe"), viewerCtx);
      expect(decision.capture).toBe(true);
      expect(decision.speak).toBe(true);
      expect(decision.act).toBe(false);
      expect(decision.reason).toBe("read_only_role_forbidden");
    });
  });

  describe("VoiceFSM State Machine", () => {
    it("handles the complete happy-path lifecycle", () => {
      const fsm = new VoiceFSM("dormant", 1000);
      expect(fsm.state).toBe("dormant");

      // User invokes wake word
      fsm.dispatch({ type: "WAKE_INVOKED", speakerId: "alice", at: 1100 });
      expect(fsm.state).toBe("invocated");
      expect(fsm.snapshot.speakerId).toBe("alice");

      // Start listening
      fsm.dispatch({ type: "START_LISTENING", at: 1200 });
      expect(fsm.state).toBe("listening");

      // Turn finalized
      const turn: VoiceTurn = {
        id: "t1",
        text: "add payment service",
        speakerId: "alice",
        at: 1300,
        source: "browser",
      };
      fsm.dispatch({ type: "TURN_FINALIZED", turn, at: 1300 });
      expect(fsm.state).toBe("processing");

      // Act on canvas
      fsm.dispatch({ type: "ACTING_START", at: 1400 });
      expect(fsm.state).toBe("acting");

      // Speak reply
      fsm.dispatch({ type: "SPEAKING_START", at: 1500 });
      expect(fsm.state).toBe("speaking");

      // TTS completes, lease window opens
      fsm.dispatch({ type: "SPEAKING_DONE", endedWithQuestion: true, at: 1600 });
      expect(fsm.state).toBe("follow_up_window");

      // Lease expires
      fsm.dispatch({ type: "LEASE_EXPIRED", at: 16100 });
      expect(fsm.state).toBe("dormant");
      expect(fsm.snapshot.speakerId).toBeNull();
    });

    it("handles barge-in during speaking", () => {
      const fsm = new VoiceFSM("dormant", 1000);
      fsm.dispatch({ type: "WAKE_INVOKED", speakerId: "alice", at: 1100 });
      fsm.dispatch({ type: "START_LISTENING", at: 1200 });
      fsm.dispatch({ type: "SPEAKING_START", at: 1300 });
      expect(fsm.state).toBe("speaking");

      // Human interrupts
      fsm.dispatch({ type: "BARGE_IN", interruptingSpeakerId: "alice", at: 1350 });
      expect(fsm.state).toBe("interrupted");

      // Immediately re-starts listening for the new turn
      fsm.dispatch({ type: "START_LISTENING", at: 1360 });
      expect(fsm.state).toBe("listening");
    });

    it("handles provider failure and recovery", () => {
      const fsm = new VoiceFSM("listening", 1000);
      fsm.dispatch({
        type: "PROVIDER_FAIL",
        error: "Network drop",
        recoverable: true,
        at: 1100,
      });
      expect(fsm.state).toBe("recovering");
      expect(fsm.snapshot.lastError).toBe("Network drop");

      // Recovers
      fsm.dispatch({ type: "RECOVERED", at: 1200 });
      expect(fsm.state).toBe("listening");
      expect(fsm.snapshot.lastError).toBeNull();
    });
  });
});
