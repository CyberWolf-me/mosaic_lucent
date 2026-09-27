# 25. Voice Platform — the voice-model advisory, audited

> **Status: V1–V9 shipped 2026-09-16 in honest form (diarizing STT,
> SpeechEvent primitive, modes, connectors seam, retention, engine, VAD
> stage 1, text voice loop, TTS, chunk-cadence turn-taking, proactive text
> panel); gated residuals: proactive speech, vendor adapters, continuous
> transport, counsel artifacts.** This document
> took the 2026-09 production + voice advisories (three pastes: production
> architecture §§1–39, the speech-pipeline design, the native-vs-external
> product framing) and audited them against the code, the way docs/20 audited
> the production advisory and docs/22 audited the first meeting advisory. The
> finding is twofold: the production-architecture paste is already ingested
> (it is the advisory P2/P3 cite — §1 below is a disposition, not a work
> order), and the meeting intelligence it asks for first (M1–M5) already
> shipped (docs/22). What was genuinely new here was the **voice-model
> delta** — TTS, the response policy, the realtime voice loop, per-loop model
> routing, and a security boundary no prior advisory named: **audio egress**.
> This doc costs that delta as slices V1–V5 with seams, acceptance, and
> gates. V1 is built; V2–V5 are not.

## 1. Disposition of the production-architecture paste (§§1–39)

Already ingested. Every load-bearing claim maps onto shipped work:

| Paste claim                                         | Where it lives                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Modular monolith, no microservices (§§1, 34–36)     | docs/20's stance; `LUCENT_ROLE` processes, same image (docs/24 §10)                    |
| Canonical / derived / ephemeral state (§2)          | docs/20 §2; ADR 0026 (projection rule: don't persist what you can derive)              |
| Snapshot + op log; commit-before-broadcast (§3)     | `server/src/room.ts`; durable seq allocation (ADR 0016); two-instance convergence test |
| Sequenced rooms, pg_notify fanout (§§4, 20, 26–27)  | `store/pg-fanout.ts` (ADR 0004); room-as-projection, catchup from `lastSeenSeq`        |
| No CRDTs, no Kafka (§5)                             | AGENTS.md non-negotiables; ADR reasoning in `room.ts`                                  |
| AI outside the mutation boundary (§§6, 30)          | ADR 0005 — structured ops, validated; every phase since preserves it                   |
| Expensive generations as jobs (§7)                  | P3/P4 worker families (`main.ts` roles, `jobs.ts`, `sweeps.ts`)                        |
| Sweeps out of the API process (§9)                  | P3 (`sweeps.ts`, `roles.ts` — "the advisory's §9" in code comments)                    |
| PG as system of record; scaling order (§§10–11)     | docs/20; P7 evidence-gated (docs/21)                                                   |
| Redis optional, never truth (§12)                   | ADR on fan-out order (Postgres before Redis); no Redis in the tree                     |
| Search as projection (§13)                          | `retrieval.ts` seam (ADR 0024); embeddings wait for lexical misses                     |
| Object storage for bytes, PG for metadata (§14)     | M7 asset gateway (`assets.ts`, `pg-assets.ts`)                                         |
| Auth layers; tenant isolation (§§15–16)             | `routes/context.ts` guard shape; `crossTenant.test.ts` matrix                          |
| Integration symmetry, ledger, inbound (§§17, 32–33) | D4–D8 (ADRs 0030–0036); human-gated inbound                                            |
| Domain events + outbox (§§18–19)                    | P2 (`outbox.ts`, fixed/small vocabulary — see §4 below)                                |
| Correlation IDs; mandatory metrics (§§21–22)        | P1 (`requestIdOf`, `x-request-id`); `/metrics` + Prometheus; reliability SLOs          |
| Deploy pipeline; K8s as orchestrator (§§24–25)      | Helm chart present; sticky-session + S3 gaps named in checklist                        |
| MCP as same backend (§29)                           | `packages/mcp` → `POST /api/boards/:id/ops`, user's token                              |
| Logical vs runtime diagrams (§39)                   | docs/20's two-diagram split                                                            |

**Nothing to build from paste 1.** It is confirmation of the current shape,
not a work order. The remainder of this doc is about the voice delta only.

## 2. Coverage audit — voice delta → code

| Advisory ask                                                              | Status                                            | Where / why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTS provider seam (OpenAI / ElevenLabs / self-hosted)                     | **Shipped (V7) + Deepgram live 2026-09-17**       | `web/src/tts.ts` (local synthesis default + server proxy); `POST /api/tts/speak` (mock standby/503, `serverTts` org switch, voice.minute metering); answers read aloud unless muted. Deepgram Aura verified live (two voices synthesized through our route); OpenAI adapter implemented, reviewed + stub-tested, awaiting a keyed live run.                                                                                                                                                                           |
| Wake / address detection ("Lucent, …")                                    | **Shipped (V6)**                                  | `meeting-voice.ts detectAddress`: leading "Lucent" is invocation, mid-sentence mention is not; empty queries spend nothing.                                                                                                                                                                                                                                                                                                                                                                                           |
| Response Policy Engine (intervention thresholds per mode)                 | **Shipped (V9 policy table)**                     | Mode × behavior matrix in §5 (Record never … nothing speaks unprompted); wake/address detection in `meeting-voice.ts`; open questions as the first proactive surface. Proactive speech stays gated.                                                                                                                                                                                                                                                                                                                   |
| Retrieve → reason → speak path                                            | **Shipped as text (V6–V7)**                       | Addressed turns ask the board through the read-only pipeline (cited, metered); answers render as session cards and read aloud via TTS. Nothing unprompted speaks.                                                                                                                                                                                                                                                                                                                                                     |
| Conversational follow-ups (no wake word for the next turn)                | **Shipped (V6–V9), 2026-09-26/27**                | `web/src/meeting-voice.ts` `ConversationalLeaseManager`: after an answer, the SAME speaker gets a 15 s window (3 follow-ups) without saying "Lucent"; another speaker, a dismissal ("thanks", "Lucent, stop" — docs/28 F20) or a teammate's name ends it. A spoken command the canvas AI answers with a question holds the window for that speaker's answer (docs/28 F21). Barge-in while Lucent speaks waits for the V8 transport (docs/26 F4).                                                                      |
| Realtime voice transport (WebRTC gateway, VAD, barge-in / human priority) | **Streaming built + live 2026-09-17, flag-gated** | `DeepgramStreamingSttService` (same seam/interface: socket stays open, labels stable, finals per push, `vad_events` onset on `speech`, interim dropped, failures throw): verified live against real Deepgram (mid-stream final + onset events + close flush). Selected by `LUCENT_STT_STREAMING=1`; default stays buffer-at-close until soak. Capture-start/flush order + stop/mute/next-answer cancel unchanged. Mic audio still flows one way (the call itself is a separate LiveKit room — see the native AV row). |
| Fast / smart / reasoning per-loop model router                            | **Not built — correctly**                         | One provider per deployment + BYO per request (`modelRouter.ts`). A second loop does not exist yet; routing between models is justified only when M6 creates one.                                                                                                                                                                                                                                                                                                                                                     |
| 4th STT slot with diarization (Deepgram / transcribe-diarize)             | **Shipped (V1) + Deepgram live 2026-09-17**       | `web/src/stt/hosted.ts` (fourth slot) + `server/src/stt.ts` + `routes/stt.ts` (session routes, ephemeral registry); `FinalMeta.speaker` filled from sidecar labels, no consumer change. Deepgram adapter (`DeepgramSttService`, buffer-at-close mapping) verified live: two-voice loopback diarized to spk_01/spk_02 through our own routes. OpenAI adapter implemented the same day, reviewed + stub-tested, awaiting a keyed live run.                                                                              |
| Identity mapping (announce / device / enrollment)                         | **Not built — deliberately**                      | Advisory's own V1 stance (no voice biometrics) + docs/22: per-stream LiveKit identity covers the common case without it.                                                                                                                                                                                                                                                                                                                                                                                              |
| Meeting event stream as a formal type                                     | **Shipped for speech (V1b)**                      | `web/src/stt/events.ts`: `speech_started` / `interim` / `final` / `speech_stopped` with distinct identity fields, one bridge deriving callbacks, interim structurally barred from durability. The _outbox_ vocabulary stays fixed/small — voice _domain_ events would still be deliberate additions.                                                                                                                                                                                                                  |
| Full lifecycle (SCHEDULED/LOBBY/PROCESSING/FINALIZED)                     | **Open / ended only**                             | `endedAt` null vs set; idempotent `end`; `MeetingEnded` outbox event exists. Other states have no consumer.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Meeting modes as behavior profiles                                        | **Shipped (D/V2)**                                | `meeting-modes.ts`: Record burns zero generations; Assistant/Participant degrade disclosed; profile persisted on transcripts (migration 0030); picker + note in MeetingView.                                                                                                                                                                                                                                                                                                                                          |
| External connectors (Zoom/Meet/Teams → turns)                             | **Shipped seam + mock (E/V3)**                    | `meetingConnectors.ts` (turns-only convergence, per-request credentials) + `POST .../meetings/import` (editor floor, validated). Vendor adapters + attendee grant follow against the interface.                                                                                                                                                                                                                                                                                                                       |
| Native AV room (video / screen share)                                     | **Built (2026-09)**                               | A LiveKit room per board: camera, mic, screen share and the huddle dock (`web/src/meeting-room/`). Lobby, roster, host powers and chat are docs/28 S4–S5.                                                                                                                                                                                                                                                                                                                                                             |
| Audio storage                                                             | **None exists — strictest default free**          | No server-side audio path; only text persists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Voice-minutes metering                                                    | **Shipped (V1)**                                  | `voice.minute` metered once on session close (whole minutes, sub-minute free); `voice.minutes` allowance gated before session creation. First producer of the `plans.ts` line item.                                                                                                                                                                                                                                                                                                                                   |

## 3. The new security analysis: audio egress

No prior advisory covers this, and Phase C makes the gap visible by
contrast. The S1–S3 plane governs **LLM-bound content**: classification
gates board text leaving for a provider, and `providerPolicy` decides which
LLM may process it. **Raw meeting audio takes a different path that none of
those gates see:**

- The default browser STT provider is cloud-backed — `stt/types.ts` says
  "audio leaves the device" outright. A `restricted` board's meeting audio
  reaches the browser vendor's speech endpoint today with no org-level way
  to say otherwise.
- On-device Whisper keeps audio local; LiveKit routes it through the
  deployment's room. The choice between those three is a per-user client
  setting, not an org policy.
- M6 would add audio in the _other_ direction (TTS out), plus continuous
  listening — a strictly larger egress surface than transcription.

The requirement, adopted from the advisory's own framing (§5 of the
native/external paste: never hidden listening) plus the S1–S3 discipline:

1. **An STT provider policy belongs on the org plane before M6**, not
   after: which STT may serve this org (on-device-only / approved-hosted),
   resolved the way `providerPolicy` resolves the LLM — restrict, never
   widen. Until it exists, the honest Settings sentence must say audio may
   leave the device on the default provider.

   > Shipped with V1 in the minimal honest form: the org `serverStt`
   > switch (`allowed`/`disabled`, fail-closed, audited, member-visible on
   > the `/policy` surface) governing the server route. It does not govern
   > the client-side providers (browser/Whisper/LiveKit remain the user's
   > choice) — an org that needs those governed has a client-deployment
   > decision, and the Settings sentence says audio may leave the device.

2. **Audio retention stays trivially satisfied by storing nothing**; if
   recording playback ever arrives, it goes through the asset pipeline as
   an explicit choice (docs/22 §6), with per-class lifetimes as org policy
   (S5's mechanism, evidence-gated as today).
3. **External connectors need the visible-authorized-attendee rule**: an
   explicit grant naming the workspace and what Lucent may read, with an
   in-meeting "Lucent AI is attending" indicator — the same 404-on-denial
   shape every other org-denial uses. No silent ingestion, ever.
4. Transcript retention remains board lifetime until S5 opens; intelligence
   retention is the statements themselves (already canonical state).

## 4. Costed slices (V1–V9)

Each slice names its seam, its acceptance, and its gate. Ordering follows
the advisory's review: event primitive → speaker resolution → sidecar
contract → MeetingEngine boundary → VAD → decomposed M6 — architecture
before infrastructure, and the engine seam before everything that attaches
to it.

- **V1 — diarizing STT slot (docs/24 Phase F shape).** Seam: fourth entry
  in `web/src/stt/` filling speaker labels from diarization

  > **Shipped 2026-09-16**, widened past the costing in one deliberate way:
  > keys must never reach the browser, so the slot is server-proxied
  > (`POST /api/stt/sessions` → chunk POSTs → close), not a client vendor
  > SDK — with the ephemeral session registry, 503-when-unconfigured,
  > `serverStt` org policy (§3.1, built with the route, not after it), and
  > `voice.minute` metering on close. Acceptance met: chunk → finals with
  > speakers through the real HTTP stack (`test/stt-routes.test.ts`).
  > Live-verified 2026-09-17 against Deepgram (two-voice Aura loopback
  > diarized to spk*01/spk_02 with 0.99+ confidence through our own
  > session + TTS routes); other vendors remain stub-only.
  > (provider's `spk*\*` opaque through; identity mapping stays out per §2).
  > Acceptance: a shared-mic fixture asserting distinct speakers per turn
  > where today everything is "You". Gate: clause 4 if it arrives as a
  > correctness fix to shipped capture, else Gate C evidence.

- **V1b — SpeechEvent primitive + speaker ladder (this change).** Seam:
  `web/src/stt/events.ts` (`speech_started` / `interim` / `final` /
  `speech_stopped`, with `participantId` vs `speakerId` kept distinct,
  timing/provenance fields from day one, interim structurally barred from
  durability); one `eventConsumerFromCallbacks` bridge every `start()`
  delegates to; MeetingView on the stream, CanvasView untouched.
  Acceptance: per-provider event sequences with flush-then-stopped order
  (`test/stt-events.test.ts`), bridge precedence, bridge silence on
  lifecycle/interim. Gate: owner-ordered refactor, behavior-preserving.
- **V2 — meeting modes as profiles (Phase D).** **Shipped under the owner
  build order**: `meeting-modes.ts` (four profiles, extraction allowed
  everywhere except Record — pinned as a pure rule), Assistant/Participant
  degrading to Intelligence disclosed until M6, profile persisted on the
  transcript (migration 0030).
  Acceptance: a Record-only meeting burns zero generations (a violation is
  clause 4, per docs/24 §6). Gate: C/D — lifted by owner order.
- **V3 — external connectors (Phase E).** **Shipped under the owner build
  order**: `meetingConnectors.ts` seam (turns-only convergence, per-request
  credentials never stored) + `POST .../meetings/import` (editor floor,
  recording policy, strict validation) with the `mock` source; vendor
  adapters + the §3.3 authorized-attendee grant follow against the
  interface.
  Acceptance: a Zoom/Meet turn lands, attributes, extracts, and undoes like
  a native one. Gate: C, plus the §3.3 authorized-attendee rule as a
  precondition, not a follow-up — lifted by owner order for the seam.
- **V4 — MeetingEngine refactor (no behavior change).** **Shipped under
  the owner build order**: `web/src/meeting-engine.ts` — Speech (final
  bookkeeping) / Understanding (trigger, batch slicing, outcome
  application, heartbeat strings) / Context (untouched pipeline) / Voice
  (reserved). Clock state moved out of view refs into the engine;
  `MeetingView` asks `shouldFire` and applies outcomes. `test/meeting-
engine.test.ts` pins firing, re-queue-only-busy/failed, and the exact
  heartbeat strings; the meeting suites observe no change. The engine
  stores nothing — turns stay in React state, transcripts server-side,
  boards in the op log (§6).
- **V5 — VAD (approximate, then real).** **Stage 1 shipped under the
  owner build order**: the sidecar contract accepts a per-chunk `speech`
  verdict, validated (garbage degrades to null, never a guessed boolean)
  and forwarded on the audio-route response; the mock reports null
  (no VAD, honestly). No consumer reads it yet — turn-taking does, at V8 —
  and pretending this is full realtime onset is forbidden (it is
  boundaries-within-chunks). Stage 2 (continuous VAD) needs the V8
  transport. In two honest stages, as reviewed.
- **V6 — M6.1 text voice loop.** **Shipped under the owner build order**:
  `web/src/meeting-voice.ts` (address detection — leading "Lucent" is
  invocation, mid-sentence mention is not; permission is the mode
  contract: assistant/participant only, Record silent at every volume,
  empty queries spend nothing) + answers in the meeting view through the
  read-only Ask pipeline (cited, metered `ask`, session-local cards —
  never board writes, never stored). One at a time, surfaced never
  overlapped.
- **V7 — M6.2 TTS.** **Shipped under the owner build order**: `web/src/
tts.ts` seam (free local speech synthesis default — nothing to bill;
  server-proxied OpenAI-style sidecar second; `speakAnswer` falls back
  hosted → browser → honest reason, 503 as the expected trigger) +
  `POST /api/tts/speak` (mock standby/503, org `serverTts` switch as
  `policy:tts`, `voice.minutes` allowance, whole minutes floored on
  ~800 chars/min so short answers are free, 502s never bill) + meeting
  answers read aloud unless muted, cancelled on stop. Gate: V6 reliable.
- **V8 — M6.3 realtime transport + interruption.** **Shipped at chunk
  cadence under the owner build order**: capture-start silences in-flight
  answers (human speech outranks Lucent), answers cancel on stop/mute/next
  answer — the turn-taking basis. Per-utterance barge-in needs VAD onset
  events the chunk transport cannot produce; that half stays open with the
  V8 transport, honestly marked in code.
- **V9 — M6.4/M7 proactive intelligence.** **Shipped in its honest form
  under the owner build order**: the response policy below, plus the
  board's open questions surfaced as a text panel in Participant mode
  (derived live, no store, never speech). Nothing speaks unprompted —
  proactive SPEECH waits on M6.3 maturity plus measured reliability, and
  stays gated on those.

## 5. Freeze legality (docs/17)

V1 is legal now **only** as a clause-4 correctness fix to shipped capture;
otherwise it waits with V2–V3 behind Gate C/D (users name the wall).

> V1 shipped 2026-09-16 on both grounds the freeze allows: the clause-4
> fix (shared-mic capture labelled every turn "You") and an explicit owner
> build order ("do them according to the structure and plan"). V1b (the
> event primitive) shipped under the same owner order as a
> behavior-preserving refactor. D–I (modes, connectors, retention) and
> V4–V9 shipped under the follow-up owner order ("complete A–H first, then
> the V ones, and the related M ones"). The §3.1 STT policy shipped with
> V1. What stays gated: proactive SPEECH (M6.3 maturity + measured
> reliability), per-org residency/DPA (counsel), vendor STT/TTS adapters
> (keys + live verification), and the V8 continuous transport. G–H
> (encryption/residency/retention) are unchanged. M6/M7 stay out of docs/24 —
> that plan's exclusion stands.

### Response policy (V9, as shipped)

| Mode         | Extracts | Answers when addressed         | Surfaces open questions | Speaks unprompted |
| ------------ | -------- | ------------------------------ | ----------------------- | ----------------- |
| Record       | never    | never                          | never                   | never             |
| Intelligence | yes      | no (Ask pill is manual)        | no                      | never             |
| Assistant    | yes      | yes, text + voice unless muted | no                      | never             |
| Participant  | yes      | yes, text + voice unless muted | yes, text panel         | never             |

## 6. Source-of-truth assignments

The constraint from the advisory's review, recorded as law so no future
slice can blur it:

```text
LiveKit          = media state (tracks, presence in the room)
STT              = speech interpretation (words + labels, never persons)
VAD              = speech boundaries (when, never what)
MeetingEngine    = orchestration (reads events, emits proposals)
LLM              = reasoning (answers, never mutations)
TTS              = audio generation (renders text, stores nothing)
Lucent Core      = canonical product state (ops, statements, turns)
Postgres         = durable truth (the log, transcripts, ledger)
```

Never let LiveKit, the sidecar, the engine, or the model become competing
stores. Concretely: no turn exists until a `final` event lands it in the
transcript store; no board change exists until a validated op commits; no
audio is ever stored anywhere. Anything that cannot point at the row it
came from does not exist.

## 7. What this document does not do

- **No schema, no new package, no second store.** The V1/V1b code it
  records added seams and a session table, never a store of truth.
- **No single giant realtime model.** STT, intelligence, and future TTS
  stay behind separate seams (§28 of the advisory + the repo's
  provider-harness rule agree).
- **No voice biometrics, no audio storage, no "replace Zoom" pitch**
  (docs/22 §6 — restated, not reopened).
- **No second mutation path.** When voice arrives it proposes validated
  ops through the one commit path (docs/24 §10), like every other input.
- **No per-loop model router until the second loop exists.** A router with
  one route is a lie the freeze rule forbids.
