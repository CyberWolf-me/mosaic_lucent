# Runbook: 3-human voice certification session

Covers plan §15 (attribution), §16 (hard diarization), §20 (modes),
§21 (agent speaking), §22 (barge-in), §23 (hallucination), plus the
§32 device checks that need hands. One 60–90 minute session with
three humans, or two sessions (attribution + agent) if voices tire.

## 0. Preconditions (all must be true before anyone speaks)

- [ ] Staging Lucent: real PG, real LLM, Deepgram STT/TTS keys wired
      (`/api/stt/sessions` → 200 `provider: deepgram`, not 503).
- [ ] LiveKit deployment reachable; `POST /api/livekit/token` → 200
      (not 503) for each human; room `lucent-voice` joins from all
      three devices with audio levels moving.
- [ ] Meeting board created (Internal), all three are editors; modes
      available: Record / Assistant / Participant.
- [ ] Facilitator has this file, a stopwatch, and write access to the
      score sheet (§6). One laptop records the session clock.
- [ ] Evidence rig: server log capture on, `/metrics` snapshot
      before/after, board export saved at each phase end.

Abort the session (don't score it) if: LiveKit drops twice in phase
1, STT returns 503 mid-run, or the LLM vendor 502s more than twice —
rerun on a healthy stack. A red stack invalidates evidence, not the
product.

## 1. Cast

- **Alice** (laptop + headset): PM voice, owns frontend lines.
- **Bob** (phone or second laptop, different room if possible):
  backend lines, does the interrupting.
- **Sarah** (third device): frontend lines, asks Lucent the questions.
- **Facilitator** (silent, runs clock + scores, calls phase changes).

## 2. Phase A — clean attribution (10 min, Assistant mode)

Each line spoken once, 3-second gaps, facing own mic:

1. Alice: "My name is Alice. I own frontend."
2. Bob: "My name is Bob. I own backend."
3. Sarah: "My name is Sarah. I own analytics."
4. Alice: "The checkout total must include tax."
5. Bob: "The pricing service returns cents, not dollars."
6. Alice: "Mobile will reuse the same endpoint."
7. Sarah: "Analytics needs the purchase event."
8. Bob: "I'll migrate the schema tonight."

Score: every turn attributed Alice→Alice, Bob→Bob, Sarah→Sarah
(§15). Any fabricated name = FAIL the phase, stop, file a bug.

## 3. Phase B — hard diarization (15 min)

1. **Interruption**: Alice starts "I think we should rebuild—",
   Bob cuts in at ~2s: "No — patch it, launch is Friday." Then
   Alice finishes: "…rebuild after launch, fine."
2. **Rapid switching**: Alice/Bob/Sarah one short sentence each,
   back-to-back, two rounds, no gaps.
3. **Same-room mic**: Bob and Sarah share one laptop mic for three
   lines each (announce who speaks first: "Bob here…", then drop
   the announcements for the next two).
4. **Noise**: Alice types loudly for 10s while Bob talks; Bob
   crinkles paper while Sarah talks.
5. **Silence + rejoin**: Sarah mutes 60s, unmutes, speaks.

Expected (§16): transcript stays correct-ish; uncertain speakers
read exactly `Speaker` — never a guessed name. Score per case.

## 4. Phase C — agent loop + barge-in (15 min, Assistant mode)

1. Sarah: "Lucent, what did we decide about checkout?"
   Expect: STT → address → answer → TTS. Note latency.
2. Mid-answer, Bob interrupts loudly: "Wait — skip the detail,
   just the decision." Expect: TTS cancels <1s, no overlap,
   Bob's turn captured, shorter answer follows (§22).
3. Sarah: "Lucent, summarize what we just agreed on." Then
   immediately: "Wait — don't say it yet." Expect: TTS stops,
   nothing else spoken (§21).
4. Alice: "Lucent, what did Sarah decide about pricing?"
   (Sarah decided nothing.) Expect: no-evidence answer, no
   invention (§23). Then Sarah: "Did we discuss Kubernetes?"
   Expect: "not in this meeting" (§23).

## 5. Phase D — Participant soak (20–30 min, Participant mode)

Free discussion of a real topic (use the pending checkout work).
Lucent participates. Facilitator scores: joins/listens/answers
selectively/waits for humans/handles direct questions/refers to
earlier context. FAIL if it answers every sentence, speaks
unprompted more than once, or loses context past 10 turns.

## 6. Score sheet (copy per session)

```text
Session date:            Stack (commit/env):
A attribution:  /8 turns correct (need 8/8, no fabrications):
B1 interruption (honest labels):
B2 rapid switching:
B3 shared mic:
B4 noise:
B5 rejoin:
C1 answer latency (s):   correct (y/n):
C2 barge-in cancel <1s (y/n):   overlap (y/n):
C3 stop on command (y/n):
C4 hallucination probes (2/2 needed):
D soak notes (interruptions, unprompted speaks, context refs):
Diarization honest fallback count (Speaker):   fabrications:
Board check: decisions/actions/questions present with provenance:
Metrics delta (errors, p95, usage_rows added):
Verdict: PASS / PARTIAL (holes named) / FAIL (bug filed):
```

## 7. Device-matrix add-on (§32, same humans, +20 min)

Rotate each human through: laptop mic → headset → phone;
background the browser tab 60s mid-speech; one Wi-Fi → hotspot
switch mid-sentence. Note permission prompts, switching gaps,
and recovery time. iPhone Safari + Android Chrome if hardware
exists; otherwise record the gap as NOT CERTIFIED, not as pass.

## 8. After the session

1. Export the board; save server logs + metrics delta with the
   sheet in `docs/eval-results/<date>-3human.md`.
2. Any trust-axis failure (fabricated name, invented decision,
   unprompted speech changing the board) → P0 bug + golden case
   before the next session.
3. Update the Release Certification Ledger gates E/F with the
   sheet link and PASS/PARTIAL/FAIL — never memory-hole a FAIL.
