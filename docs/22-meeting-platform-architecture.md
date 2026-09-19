# 22. Meeting Platform — the live-meeting advisory, audited

> **Status: M1–M5 shipped and gated at ≈93 composite (docs/16, docs/17 Gate A);
> M6–M7 shipped in honest form (docs/25 V6–V9: text voice loop, TTS seam,
> chunk-cadence turn-taking, proactive text panel); external connectors as a
> tested seam with mock (docs/24 Phase E); modes shipped (Phase D).** This document takes the
> 2026-09-15 meeting-architecture advisory (two parts: the speech-pipeline
> design, then the native-vs-external product framing) and audits it against
> the code, the same way docs/20 audited the production-architecture advisory.
> Every "build" claim below was checked against a file; where the advisory
> asks for something that exists, the row says so and costs nothing. The real
> gaps (M6–M7 honest form, external seam, meeting modes, retention) shipped
> under the 2026-09-16 owner build order; proactive speech, vendor
> adapters, and continuous transport stay gated.

## 1. The advisory's core claim, and Lucent's answer to it

The advisory's opening rule:

> **Lucent meetings should not be "record audio → transcribe → summarize."**
> They should be a live multimodal meeting system with a speech pipeline,
> speaker identity, a meeting intelligence engine, and optionally a Lucent
> voice participant.

Lucent already meets the first three clauses of that sentence. `MeetingView`
(`web/src/views/MeetingView.tsx`) is a live capture view driving a real STT
seam, with per-utterance speaker attribution where the provider gives it, and
a differential extraction loop that turns finalized turns into classified
semantic statements on the board through the normal `send()` pipeline — same
validation, metering, history, and undo as any other generation. The transcript
is already treated as an input to intelligence, not the intelligence itself
(ADR 0021: statements live on nodes; ADR 0022: provenance rides the
operation).

The fourth clause — the voice participant — is not built, and the advisory
itself says not to start there (§27: "I would not start with
voice-interacting Lucent. That is flashy but not the foundation.").

## 2. Coverage audit — advisory section → code

| Advisory                                                                  | What it asks                                     | Status                                          | Where                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Four layers: audio → STT/diarization → intelligence → voice               | Layered pipeline, transcript ≠ intelligence      | **Shipped (first three)**                       | `web/src/stt/` (three providers), `MeetingView` extraction loop, `core` statement kinds                                                                                                                                                                                                                                                           |
| STTProvider abstraction, provider-swappable                               | No hard-wired engine                             | **Shipped**                                     | `stt/types.ts` — `VoiceSession`/`VoiceHandlers`/`FinalMeta`, providers browser/whisper/livekit; CanvasView never knows which is active                                                                                                                                                                                                            |
| Speaker attribution: "who said what" per turn                             | Identity on transcript turns                     | **Shipped (both cases)**                        | `FinalMeta.speaker` carries the LiveKit participant identity (minted from the signed-in user) or the hosted sidecar's diarization labels (docs/25 V1); meeting turns store it (`server/src/meetings.ts` `MeetingTurn.speaker`)                                                                                                                    |
| Diarization for mixed/single-stream audio                                 | spk_01/spk_02 labels on one stream               | **Shipped (docs/25 V1)**                        | The fourth STT slot (`web/src/stt/hosted.ts`) fills `FinalMeta.speaker` from sidecar diarization labels; server session routes (`routes/stt.ts`), ephemeral registry, `serverStt` org policy, `voice.minute` metering. Deepgram adapter live-verified 2026-09-17 (two-voice loopback → spk_01/spk_02 through our routes); other vendors stub-only |
| Identity mapping (speaker → person)                                       | Announced identity / device mapping / enrollment | **Not built — deliberately**                    | The advisory's own V1 stance ("not voice biometrics") matches the repo's; per-stream LiveKit identity covers the V1 case without it                                                                                                                                                                                                               |
| Separate STT from the reasoning model                                     | Never one giant model                            | **Shipped**                                     | STT seam in `@lucent/web`; intelligence is the normal generation pipeline; no realtime-composite model anywhere                                                                                                                                                                                                                                   |
| Two loops: fast (captions/topic) + deep (decisions/actions/risks)         | Don't run the model on every packet              | **Shipped in embryo**                           | The differential loop IS the deep loop: `meeting-extract.ts` hybrid trigger (silence gap / forced finals / max wall-clock / debounce) decides when a batch is worth a model call; finals display immediately without a call                                                                                                                       |
| Extraction vocabulary: decisions, actions, questions, risks, requirements | Classified statements, not a summary blob        | **Shipped**                                     | Six closed kinds (`core/src/operations.ts`): decision, proposal, question, action, requirement, risk — the advisory's list plus proposal, minus its "topic" (handled by topic-break markers, UX-5)                                                                                                                                                |
| Confidence + status on statements                                         | Structured JSON per detection                    | **Partial**                                     | Kind + status (`open/resolved/rejected/superseded`) exist; no numeric confidence — the freeze's `fact`/`constraint` precedent (docs/17) says a field nobody acts on is a bug                                                                                                                                                                      |
| Meeting state machine SCHEDULED→…→FINALIZED                               | Explicit lifecycle                               | **Partial**                                     | Two states exist: open capture (`endedAt` null, `appendTo` legal) and ended (immutable; `end` is idempotent). SCHEDULED/LOBBY/PROCESSING/FINALIZED do not exist — no scheduling surface wants them yet                                                                                                                                            |
| Finalize pass on END (deep analysis, cross-meeting memory)                | Post-meeting processing                          | **Shipped where measured**                      | Cross-meeting memory is a projection over canonical state (ADR 0023), computed on read — no finalize job needed for it; `MeetingEnded` is a P2 outbox event                                                                                                                                                                                       |
| Meeting Event Stream as a formal type                                     | Typed union of every event                       | **Shipped for speech (docs/25 V1b)**            | `web/src/stt/events.ts` — `speech_started`/`interim`/`final`/`speech_stopped` with distinct identity fields, one bridge deriving callbacks, interim structurally barred from durability. Domain events (outbox vocabulary) stay fixed/small by rule                                                                                               |
| Native + external meetings converge on one internal model                 | Zoom/Meet → same pipeline                        | **Shipped seam + mock (E/V3)**                  | Native meetings already land as: capture → turns → extraction → statements → provenance. External import lands the same way (`meetingConnectors.ts` + import route); vendor adapters + attendee grant follow when a Gate C ask or credentials arrive                                                                                              |
| Retention: audio/transcript/intelligence separately                       | Configurable per class                           | **Trivially satisfied today, policy not built** | Audio is never stored at all (STT is streaming; only text persists) — the advisory's strictest default. Transcript retention = board deletion; no independent policy                                                                                                                                                                              |
| Native AV meeting room (video/screen share)                               | Lucent as the meeting product                    | **Not built**                                   | LiveKit is used as an STT transport (token-minted rooms), not as an AV surface; MeetingView is transcript-first by design                                                                                                                                                                                                                         |
| Meeting modes: record / intelligence / assistant / participant            | Behavior profiles, not prompt toggles            | **Shipped (D/V2)**                              | `web/src/meeting-modes.ts` (Record burns zero generations, Assistant/Participant degrade disclosed); profile persisted on transcripts (migration 0030); picker + note in MeetingView                                                                                                                                                              |
| Response Policy Engine + TTS                                              | Lucent speaks, with thresholds                   | **Shipped (V6–V9 honest form)**                 | Wake/address detection + mode policy table (docs/25 §5); text answers via Ask, TTS seam (local default + server proxy), chunk-cadence interruption, proactive text panel. Proactive speech + per-utterance barge-in stay gated                                                                                                                    |
| Model router (fast/smart/reasoning)                                       | Different models per loop                        | **Partial**                                     | One provider per deployment + BYO-key per request (`modelRouter.ts`); no per-loop routing — justified only when a second loop exists (M6)                                                                                                                                                                                                         |
| Intelligence agent tools (search, get_board_state, propose ops)           | LLM with tools                                   | **Shipped in the house style**                  | The generation pipeline already assembles context and emits validated ops; the narrowing prompt registry (`ai/src/registry.ts`) is the vocabulary guard. No free-form tool surface, per ADR 0005                                                                                                                                                  |
| "Meeting" as first-class object alongside Board                           | Not everything on the canvas                     | **Shipped**                                     | Meeting transcripts are board-scoped rows with their own routes (`routes/meetings.ts`), not canvas shapes; statements surface through Intelligence views (ADR 0026)                                                                                                                                                                               |
| Audio retention as explicit product choice                                | No accidental recordings                         | **Shipped**                                     | No audio path exists server-side; nothing to retain                                                                                                                                                                                                                                                                                               |

## 3. What exists today (the pipeline, as built)

```text
mic (browser / LiveKit room)
  │  STT seam: browser | whisper | livekit     web/src/stt/
  ▼
finals + speaker (where the provider knows)
  │  turnsRef → live transcript UI (fast loop, no model call)
  ▼
hybrid trigger (meeting-extract.ts)          the deep loop's gate
  │  silence gap / forced final / max wall-clock / debounce
  ▼
differential send() — only NEW turns + board context
  │  same validation, metering, approval, history as any generation
  ▼
classified statements (six kinds) + provenance (turnRange)
  │  ops → op log → board
  ▼
server transcript: insert → appendTo checkpoints → end (immutable)
  routes/meetings.ts, store pg-meetings / InMemory twin
```

Two properties the advisory praises as targets are already invariants here:
the model never mutates the workspace (ADR 0005 — ops only, validated), and
speaker attribution is honest about what each provider knows (Web Speech and
on-device Whisper say "You"; LiveKit names the participant; nothing invents a
false distinction — `MeetingView`'s own header comment).

## 4. The real gaps (and what each costs)

1. **M6 — the voice assistant.** **Shipped in honest form (docs/25
   V6–V8)**: wake/address detection, text answers through Ask, TTS seam
   (local + server proxy), chunk-cadence interruption. Per-utterance
   barge-in and vendor adapters stay open.
2. **M7 — proactive participant.** **Shipped in honest form (docs/25 V9)**:
   response-policy table + open-questions text panel. Proactive speech
   stays gated on M6.3 maturity + measured reliability.
3. **External meeting connectors.** Zoom/Meet/Teams → turns. The convergence
   rule is already satisfied structurally: a connector's only job is to emit
   turns into the same store. Builds on the proven integrations seam
   (provider factory, human-gated inbound, exactly-once ledger).
4. **Meeting modes as profiles.** Record (transcript only) / Intelligence
   (today's default) / Assistant / Participant. Today recording implies
   extraction; making that a profile is a real behavior change to a shipped
   surface.
5. **Diarization for shared-mic audio.** Shipped 2026-09-16 as docs/25 V1:
   server-proxied diarizing STT (fourth slot + session routes + `serverStt`
   org policy + voice-minute metering). Identity mapping stays out per the
   V1 stance below.
6. **Lifecycle states beyond open/ended.** SCHEDULED/LOBBY/PROCESSING have no
   consumer; build them when a surface wants them (e.g. finalize-as-job in
   the P4 `ai` family for very large transcripts).

## 5. The build order (the advisory's M1–M7, annotated)

```text
M1 live transcription        SHIPPED (MeetingView + STT seam)
M2 speaker attribution       SHIPPED for individual streams (LiveKit identity) + shared mic (hosted diarization, docs/25 V1)
M3 event stream              SHIPPED in substance (turns checkpoint; triggers)
M4 meeting intelligence      SHIPPED (differential loop, six kinds, ≈93 gate)
M5 context-aware extraction  SHIPPED (board context + provenance + ADR 0023)
M6 voice assistant           SHIPPED honest form (V6–V8: addressed text answers, TTS seam, chunk-cadence yield)
M7 proactive participant    SHIPPED honest form (V9: policy table + open-questions panel; speech stays gated)
```

**Freeze legality (docs/17).** M1–M5 cost nothing — they are the record of
what shipped before this advisory arrived. The remaining rows shipped
2026-09-16 under the owner "complete A–H, then the V ones, and the related
M ones" order, each in the honest form its gate allows (seam + mock where
vendors are needed, text where audio needs maturity, policy where speech
needs evidence). What stays gated: proactive speech, vendor STT/TTS
adapters, continuous transport, counsel artifacts.

## 6. What this plan deliberately does not build

- **No single giant realtime model.** STT, intelligence, and (future) TTS
  stay behind separate seams — the advisory's §28 and the repo's own
  provider-harness rule agree.
- **No voice biometric identification.** Not in V1, per the advisory's own
  privacy stance; per-stream identity covers the common case.
- **No "replace Zoom" pitch.** External meetings converge on the same turn
  model; the value claim is "whatever platform you use, the conversation
  becomes workspace intelligence."
- **No meeting→diagram special path.** A diagram built from minutes is a
  diagram like any other (`MeetingView`'s own rule): the normal generation
  pipeline, no privileged route.
- **No audio storage, for now.** The strictest retention default is free;
  revisit only when a product ask (recording playback) arrives, and then as
  an explicit choice through the asset pipeline — never an accidental
  byproduct.
