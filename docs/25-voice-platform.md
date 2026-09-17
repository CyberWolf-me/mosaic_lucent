# 25. Voice Platform — the voice-model advisory, audited

> **Status: V1 shipped 2026-09-16 (diarizing STT slot + server session +
> org STT policy + voice-minute metering); V2–V5 still gated.** This document
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

| Advisory ask                                                              | Status                                   | Where / why                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTS provider seam (OpenAI / ElevenLabs / self-hosted)                     | **Not built**                            | Zero hits for TTS/speech-synthesis in any package. No audio-out path exists anywhere.                                                                                                                                                                                      |
| Wake / address detection ("Lucent, …")                                    | **Not built**                            | No utterance-routing code; transcripts go straight to extraction, never through intent.                                                                                                                                                                                    |
| Response Policy Engine (intervention thresholds per mode)                 | **Not built**                            | The closest shape is the differential loop's trigger thresholds (`meeting-extract.ts`) — a _send_ policy, not a _speak_ policy.                                                                                                                                            |
| Retrieve → reason → speak path                                            | **Not built**                            | Ask is text-only and read-direction; nothing renders an answer as audio or decides to speak unprompted.                                                                                                                                                                    |
| Realtime voice transport (WebRTC gateway, VAD, barge-in / human priority) | **Not built**                            | LiveKit rooms are an STT _transport_ (token-minted), not an AV surface; mic audio flows one way (capture → finals). No VAD, no yield, no TTS injection.                                                                                                                    |
| Fast / smart / reasoning per-loop model router                            | **Not built — correctly**                | One provider per deployment + BYO per request (`modelRouter.ts`). A second loop does not exist yet; routing between models is justified only when M6 creates one.                                                                                                          |
| 4th STT slot with diarization (Deepgram / transcribe-diarize)             | **Shipped (V1, 2026-09-16)**             | `web/src/stt/hosted.ts` (fourth slot) + `server/src/stt.ts` + `routes/stt.ts` (session routes, ephemeral registry); `FinalMeta.speaker` filled from sidecar labels, no consumer change. No vendor live-verified — sidecar contract first, Deepgram/OpenAI adapters follow. |
| Identity mapping (announce / device / enrollment)                         | **Not built — deliberately**             | Advisory's own V1 stance (no voice biometrics) + docs/22: per-stream LiveKit identity covers the common case without it.                                                                                                                                                   |
| Meeting event stream as a formal type                                     | **Not built — deliberately informal**    | docs/22 §4 + ADR 0026 stand: events are implicit (React state, checkpoints, ops). The _outbox_ vocabulary is fixed/small by rule — voice events (`LucentResponseStarted`, …) would be deliberate one-line additions, not a parallel stream.                                |
| Full lifecycle (SCHEDULED/LOBBY/PROCESSING/FINALIZED)                     | **Open / ended only**                    | `endedAt` null vs set; idempotent `end`; `MeetingEnded` outbox event exists. Other states have no consumer.                                                                                                                                                                |
| Meeting modes as behavior profiles                                        | **Not built** (docs/24 Phase D)          | Extraction always runs; no Record-vs-Intelligence split.                                                                                                                                                                                                                   |
| External connectors (Zoom/Meet/Teams → turns)                             | **Not built** (docs/24 Phase E)          | No connector code; convergence rule structural (a connector's only job is turns into the same store).                                                                                                                                                                      |
| Native AV room (video / screen share)                                     | **Not built**                            | Transcript-first by design; no video/screen-share surface.                                                                                                                                                                                                                 |
| Audio storage                                                             | **None exists — strictest default free** | No server-side audio path; only text persists.                                                                                                                                                                                                                             |
| Voice-minutes metering                                                    | **Shipped (V1)**                         | `voice.minute` metered once on session close (whole minutes, sub-minute free); `voice.minutes` allowance gated before session creation. First producer of the `plans.ts` line item.                                                                                        |

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

## 4. Costed slices (V1–V5)

Each slice names its seam, its acceptance, and its gate. Ordering follows
the advisory's own M1–M7 discipline (foundation before voice).

- **V1 — diarizing STT slot (docs/24 Phase F shape).** Seam: fourth entry
  in `web/src/stt/` filling `FinalMeta.speaker` from diarization labels

  > **Shipped 2026-09-16**, widened past the costing in one deliberate way:
  > keys must never reach the browser, so the slot is server-proxied
  > (`POST /api/stt/sessions` → chunk POSTs → close), not a client vendor
  > SDK — with the ephemeral session registry, 503-when-unconfigured,
  > `serverStt` org policy (§3.1, built with the route, not after it), and
  > `voice.minute` metering on close. Acceptance met: chunk → finals with
  > speakers through the real HTTP stack (`test/stt-routes.test.ts`); no
  > vendor live-verified.
  > (provider's `spk_*` opaque through; identity mapping stays out per §2).
  > Acceptance: a shared-mic fixture asserting distinct speakers per turn
  > where today everything is "You". Gate: clause 4 if it arrives as a
  > correctness fix to shipped capture, else Gate C evidence.

- **V2 — meeting modes as profiles (Phase D).** Seam: `meeting-extract.ts`
  trigger policy + `MeetingView` state; `kind` optional-by-profile.
  Acceptance: a Record-only meeting burns zero generations (a violation is
  clause 4, per docs/24 §6). Gate: C/D.
- **V3 — external connectors (Phase E).** Seam: adapter family on
  `integrations/provider.ts`; exactly-once ledger + human-gated inbound
  (the D-series shape); output is turns into the same store, nothing else.
  Acceptance: a Zoom/Meet turn lands, attributes, extracts, and undoes like
  a native one. Gate: C, plus the §3.3 authorized-attendee rule as a
  precondition, not a follow-up.
- **V4 — voice assistant (M6).** Seams: `TTSProvider` interface in
  `@lucent/web` (or a small new package if a second consumer appears —
  decide then, not now); wake/address detection; the response-policy engine
  with the advisory's intervention thresholds (passive never speaks; human
  speech always preempts); retrieve→reason→speak through validated ops
  only (ADR 0005 — the voice never touches the reducer). Preconditions:
  §3.1 STT policy on the org plane; this doc as the advisory; an explicit
  owner decision with a named M6 plan (this slice is the largest new
  subsystem in the advisory and does not fit inside a phase amendment).
  Acceptance: scripted messy-meeting voice benchmark (answer precision,
  citations spoken + shown, interruption rate, yield latency) added to
  docs/16's harness before the code.
- **V5 — proactive participant (M7).** Only after V4's benchmark is green
  across real meetings. Same gate as V4 plus measured reliability.

## 5. Freeze legality (docs/17)

V1 is legal now **only** as a clause-4 correctness fix to shipped capture;
otherwise it waits with V2–V3 behind Gate C/D (users name the wall).

> V1 shipped 2026-09-16 on both grounds the freeze allows: the clause-4
> fix (shared-mic capture labelled every turn "You") and an explicit owner
> build order ("do them according to the structure and plan"). The §3.1
> STT policy shipped with it, so V4's precondition (1) is already met;
> preconditions (2, this advisory) and (3, named M6 plan + owner decision)
> still stand. V2–V3 wait behind Gate C/D. G–H
> (encryption/residency/retention) are unchanged. M6/M7 stay out of docs/24 —
> that plan's exclusion stands.
> V4–V5 wait for three things in order: this advisory (done here), the §3.1
> STT policy, and an explicit owner decision with a named plan. G–H
> (encryption/residency/retention) are unchanged. M6/M7 stay out of docs/24 —
> that plan's exclusion stands.

## 6. What this document does not do

- **No code, no schema, no new package.** Advisory only.
- **No single giant realtime model.** STT, intelligence, and future TTS
  stay behind separate seams (§28 of the advisory + the repo's
  provider-harness rule agree).
- **No voice biometrics, no audio storage, no "replace Zoom" pitch**
  (docs/22 §6 — restated, not reopened).
- **No second mutation path.** When voice arrives it proposes validated
  ops through the one commit path (docs/24 §10), like every other input.
- **No per-loop model router until the second loop exists.** A router with
  one route is a lie the freeze rule forbids.
