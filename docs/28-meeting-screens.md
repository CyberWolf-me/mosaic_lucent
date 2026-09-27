# 28 — Meeting screens: the A3 state map

- Status: **Proposed 2026-09-27** — the screen-level specification for
  docs/26 phase A3 (meeting lifecycle); §9 lists the decisions it needs
- Date: 2026-09-27 · branch `lucent/atelier`
- Inputs: the founder's user-flow specification (the same 139 flows docs/26
  took in; here §§16–27, 57, 64–65, 80–82, 116–122 and 130); docs/26 §7, J1
  and J5; docs/25 §5 (response policy); docs/27 §2 (notes); a code audit of
  this branch (2026-09-27, three passes: the call room, the meeting view and
  voice loop, and meetings as data plus what happens after one ends).

docs/26 §7 lists the meeting lifecycle as stages. This document turns those
stages into **screens**. For each screen it gives how you get there, every
state the screen can be in, what each action does and where it leads, and
what exists in the code today. It is written to build against one slice at a
time (§8).

Today all of it is one view: `MeetingView` on one board. That view has four
phases (`none | live | unsaved | saved`, `web/src/views/MeetingView.tsx:1159`)
and a call drawer (`web/src/meeting-room/NativeRoom.tsx`). The target splits
it into twelve screens around a meeting object (J1). The audit also found
defects in what already exists, and they come first (§2), because two of them
lose transcripts.

Legend: ✅ exists · 🟡 partial · ❌ missing. Paths are relative to `packages/`.

## 1. Rules every meeting screen follows

1. **The meeting outlives the AI** (spec §116). Media and the transcript keep
   going when the model, the allowance, or a provider fails. An AI panel that
   cannot work says so ("Lucent is unavailable — the transcript is still
   recording"). It is never blank.
2. **Leaving the call is not ending the meeting, and closing the tab is not
   losing the transcript** (§21). Durable meeting state never depends on the
   media connection or on one browser tab.
3. **Interim is never durable** (§22). Captions may show interim text; only
   finals become turns. This is already law in `web/src/stt/events.ts`.
4. **Capture is visible to everyone** (docs/27 §2.9). Every participant sees
   "Transcribing · Lucent in Assistant mode" while capture runs.
5. **Nothing extracted becomes trusted without a person** (docs/26 decision
   5). Extraction lands as a candidate on every path: live, manual and end of
   meeting.
6. **A refusal explains itself** (§52). A control the user cannot use is
   visible and disabled with the reason, known from the user's role before
   any request is made ("Viewers can listen and take notes; only editors
   record this meeting"). A board the caller cannot see still answers 404, so
   a refusal never reveals what exists.
7. **Honest capabilities** (docs/26 rule 3). A control that is not built is
   absent, not a dead button: no chat button, raise hand or captions toggle
   until each one works.

Every screen below uses the same state words: **loading**, **empty**,
**ready**, **busy**, **degraded** (working with less, e.g. no speaker names),
**refused** (role or policy), **failed** (recoverable, with Retry) and
**gone** (ended, cancelled or deleted).

## 2. Defects found by the audit

This continues docs/26 §4's numbering. Every row was found by reading the
code; none was reproduced at runtime. F13–F17, F20 and F23 were re-checked
against every file their row cites.

| #   | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                                                                            | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F13 | **Live capture never opens a server transcript.** The view opens one with `turns: []`, the server refuses an empty array ("turns must not be empty"), and `saveMeeting` returns null without a message. With no live id nothing is appended during the meeting; the transcript is written once, at Stop. Separately, `checkpointTurns` reads `liveMeetingId` from the render in which capture started, so it would skip even with an open transcript. A reload or a closed tab mid-meeting loses every turn | `web/src/views/MeetingView.tsx:679`, `:263–266`, `:586`; `server/src/meetings.ts:145`                                            | **Done:** the transcript opens with the first captured turns (the contract the route tests already use), so the server's no-empty rule stands and a silent capture leaves no record. Persistence moved to `web/src/meetingCapture.ts`, one instance per capture, reading no render state. Stop ends the transcript only once every line is saved, and Save meeting resumes that transcript instead of writing a second. Tests: `web/test/meeting-capture.test.ts`; end to end, `scripts/meeting-capture-check.mjs` (2/6 on the old code, 6/6 now). The voice command path's stale `send` was fixed with F21 (`sendRef`)                                   |
| F14 | **Leaving the meeting view mid-capture discards it.** Unmount stops speech capture and playback but neither flushes nor ends, so a record that did open shows "No end recorded"                                                                                                                                                                                                                                                                                                                             | `MeetingView.tsx:484–492`                                                                                                        | **Done:** the meeting view publishes its capture to `MeetingSessionContext`, and while one runs the Router keeps the view mounted (hidden) wherever the user goes, so recording, extraction and the voice loop carry on. The dock shows it ("Recording · 3 lines · 4:12") with Open and a Stop that runs the view's own Stop. An unmount mid-capture (sign-out) finishes it. Server: `sweep-idle-captures` (every 15 min) ends a transcript unheard for 12 h, at its last line (`MeetingStore.endIdle`, both stores). Tests: `server/test/idle-captures.test.ts`; `scripts/meeting-capture-check.mjs` 10/10                                               |
| F15 | **Manual extraction skips review.** "Extract to board" and "Re-extract from here" send without `propose`, so the approval threshold decides: five operations or fewer apply directly, and on an empty board any number do. This breaks decision 5 and Home's promise "You approve what lands on the board"                                                                                                                                                                                                  | `MeetingView.tsx:904–919`, `:1036`; `web/src/workspace.tsx:1646–1649`; `web/src/views/HomeView.tsx:939`                          | **Done:** every meeting-sourced extraction (live, Extract to board, Re-extract from here) is built by one helper, `meetingExtractRequest` (`web/src/meeting-extract.ts`), which always sets `propose: true`. A test fails if the meeting view builds meeting provenance by hand                                                                                                                                                                                                                                                                                                                                                                           |
| F16 | **Live extraction batches replace each other unseen.** Each batch opens a new proposal; the server keeps one pending proposal per board and supersedes the last. The proposal panel renders only on the canvas, so someone in the meeting view never sees a batch before the next one replaces it. The Brief reads only applied statements, so it stays empty                                                                                                                                               | `web/src/workspace.tsx:1396`; `server/src/proposals.ts:193–202`; `web/src/views/CanvasView.tsx:3173`; `web/src/meetingBrief.ts`  | **Done (differently):** merging was unsafe — each batch is generated against a board without the pending one, so merged batches duplicate nodes and collide on ids. Instead the live loop **holds** while any proposal is pending (the same rule protects a canvas request from a meeting batch); turns stay queued, the status line says "Waiting for your review", and they go out together once the proposal is decided. The proposal panel now renders in the meeting view too. `scripts/meeting-capture-check.mjs` 16/16 (the old code supersedes). Per-item candidates stay S9 / J5                                                                 |
| F17 | **Meeting write routes skip the CSRF check.** `routes/meetings.ts` never calls `requireCsrf`, though its header says the guard runs first; every other file with mutating routes calls it. `SameSite=Lax` limits exposure, so this is lost defence in depth, not an open door                                                                                                                                                                                                                               | `server/src/routes/meetings.ts:16–18`                                                                                            | **Done:** `requireCsrf` first on the four meeting POSTs — and on proposal-create, which an audit of every mutating route found open too (the rest are guarded or exempt by design: signed webhooks, SAML ACS, pre-session auth). `server/test/csrf-board-writes.test.ts` drives a real cookie session (the existing route tests use bearer tokens, which skip CSRF by design — why nothing noticed)                                                                                                                                                                                                                                                       |
| F18 | **Mic and camera failures are invisible.** If enabling the mic fails at join, the error goes to `console.warn`, the camera is never attempted, the status still becomes live and both controls show on. In-call toggle errors set `error`, which neither the stage nor the dock renders                                                                                                                                                                                                                     | `web/src/meeting-room/MeetingSessionContext.tsx:274–279`, `:300`, `:318`, `:330`                                                 | **Done:** `enableLocalMedia` (`web/src/meeting-room/mediaErrors.ts`) turns the mic and camera on independently and reports what really came on; `describeMediaError` names each failure from the DOMException name ("Microphone blocked. Allow it for this site in the address bar…"). In-call failures are a non-fatal `notice` shown in the room and the dock (`MediaNotice`); `error` stays the lobby's fatal kind. Cancelling the screen picker says nothing. Tests: `web/test/media-errors.test.ts`. The lobby's own permission states stay S4                                                                                                       |
| F19 | **A viewer can start a capture that cannot be saved.** The meeting view checks no role: for a viewer the open fails, capture stays in the tab, extraction reports "read-only", and Stop ends in "Couldn't save the meeting"                                                                                                                                                                                                                                                                                 | `MeetingView.tsx` (no role reads)                                                                                                | **Done:** the view reads `readOnly` (the role the server assigned): Start / New recording, the room's record button, Save meeting, Extract to board and Re-extract are disabled or absent for a viewer, and one line says what a viewer can do (join the call, read, take private notes). Per §9.3's recommendation, speaking in the call stays allowed. `scripts/meeting-roles-check.mjs` 5/5 (two real accounts, a viewer share link)                                                                                                                                                                                                                   |
| F20 | **"Lucent, stop" is sent as a question.** During playback it cannot be heard (F4). Outside playback, "stop", "cancel" and "never mind" after the wake word are not silence phrases, so they open a lease and go to Ask                                                                                                                                                                                                                                                                                      | `web/src/meeting-voice.ts:380`                                                                                                   | **Done (outside playback):** `isStopRequest` (`web/src/meeting-voice.ts`) makes an addressed request that is ONLY a stop word — stop, cancel, wait, hold on, never mind, enough — silence; "Lucent, wait, what about Redis?" stays a question. A stop said while an answer is being fetched still shows the card but no longer speaks it. During playback it still can't be heard: that is F4 (the V8 transport)                                                                                                                                                                                                                                          |
| F21 | **Clarifying questions never reach the meeting.** When the canvas AI asks instead of guessing, the question lands in the canvas chat: it is not spoken, not shown as a card, and the lease never enters `waiting_for_user_response`                                                                                                                                                                                                                                                                         | `web/src/workspace.tsx:1676–1688`                                                                                                | **Done:** `send` now returns the reply text on `answered`; a spoken command whose reply is a question shows it as a card, speaks it, and the lease enters `waiting_for_user_response` for that speaker (`onClarificationAsked`). The speaker's next turn — any words, not only `isDirectAnswer`'s vocabulary — is a `clarification_answer`, sent back to the canvas together with the instruction it clarifies. The mock provider now asks back on a request with no referent ("add it…"), like the real prompt. `scripts/meeting-capture-check.mjs` 19/19                                                                                                |
| F22 | **Transcription degrades silently.** An unsupported provider falls back to another without notice; failed hosted chunk uploads are skipped; LiveKit and Whisper produce text only at Stop, so the voice loop and live extraction do nothing with them, and the view doesn't say so                                                                                                                                                                                                                          | `web/src/stt/index.ts:20–33`; `web/src/stt/hosted.ts:136–139`; `web/src/stt/livekit.ts:125–128`; `web/src/stt/whisper.ts:94–119` | **Done:** while a capture runs, the meeting view lists why it works with less: a fallback (`resolveSttProvider` names the provider asked for and why it can't run), a provider whose text only comes at Stop (`finalsAtStop` on Whisper and LiveKit), and what the hosted provider reports through a new `onDegraded` callback — a server that transcribes only at close, and audio chunks the server didn't answer. The server now reports its session `mode` honestly (`at-close` for the buffering Deepgram and OpenAI services; it said `live` for all). Tests: `stt-registry`, `stt-hosted`, `stt-routes`; `scripts/meeting-capture-check.mjs` 20/20 |
| F23 | **The LiveKit speech provider's token call sends no CSRF header.** Pointed at Lucent's own `/api/livekit/token` with a cookie session, it gets 403                                                                                                                                                                                                                                                                                                                                                          | `web/src/stt/livekit.ts:34–39`                                                                                                   | **Done:** `fetchLiveKitToken` uses `apiFetch` (session + CSRF) for a same-origin token URL — the default `/api/livekit/token` — and a bare, credential-less fetch for a third-party token server, so Lucent's CSRF token and cookies never leave the origin. The client CSRF suite (`web/test/http-csrf.test.ts`), which walks every mutating call, now includes it and the meeting and proposal writes (19 → 24 calls)                                                                                                                                                                                                                                   |
| F24 | **Screen-share state goes stale.** Nothing listens for the browser's own "Stop sharing", and the local screen tile is published only at join and on camera toggle                                                                                                                                                                                                                                                                                                                                           | `web/src/meeting-room/MeetingSessionContext.tsx`, `NativeRoom.tsx`                                                               | **Done:** the room follows LiveKit's `LocalTrackUnpublished` for the screen share (the browser's own "Stop sharing"), and your own share tile is published when sharing starts. Not verified against a live room (that needs the LiveKit account)                                                                                                                                                                                                                                                                                                                                                                                                         |
| F25 | **The dock's Expand opens the wrong board.** It opens the meeting view of the current board, not the call's; `activeBoardId` is never read                                                                                                                                                                                                                                                                                                                                                                  | `web/src/meeting-room/MeetingHuddleDock.tsx`                                                                                     | **Done:** the dock's Expand, "View" (presenting) and the recording row's Open open the board the call (`activeBoardId`) or the recording (`capture.boardId`) belongs to, then its meeting view. `scripts/meeting-capture-check.mjs` 24/24 — records on board A, opens board B mid-meeting, Open lands back on A with every line (the old dock stays on B)                                                                                                                                                                                                                                                                                                 |

## 3. The screens and how they connect

```text
 entry: board top bar · ⌘K · Home · Intelligence · email invite · notification
        · citation link (?meeting=<id>&turn=<n>)
                                    │
                                    ▼
 S1 Meetings ──► S2 Schedule ──► S3 Meeting page (upcoming)
   │    │                              │ Join
   │    └──── Start now ───────────────┤
   │                                   ▼
   │                             S4 Lobby ──► S5 Room (live) ◄──► S6 Dock
   │                                            │  side panel: S7 Capture
   │                                            │  (transcript · notes · Lucent · brief)
   │                                            │ End
   │                                            ▼
   │                                      S8 Ending ──► S9 Review ──► S11 Follow-up
   │                                                        │
   └──────────── open a past meeting ──────────────────► S10 Past meeting
 S12 Import transcript ──► S8
```

| Screen                             | Spec        |             Today              |
| ---------------------------------- | ----------- | :----------------------------: |
| S1 Meetings (workspace list)       | §65, §121   | ✅ Live now · Upcoming · Past  |
| S2 Schedule                        | §16         |            ✅ A3.4             |
| S3 Meeting page (upcoming)         | §16, §122   |            ✅ A3.4             |
| S4 Lobby                           | §17         |            ✅ A3.2             |
| S5 Room                            | §18–21      | ✅ A3.2 (captions wait for V8) |
| S6 Dock (call outside the meeting) | —           |      ✅ with F25, rejoin       |
| S7 Capture panel                   | §22–25      |    🟡 today's `MeetingView`    |
| S8 Ending                          | §120        |      ✅ A3.3 (server job)      |
| S9 Review                          | §26–27, §57 |    ✅ per item, on its page    |
| S10 Past meeting                   | §121        |       ✅ A3.1 (+ rename)       |
| S11 Follow-up                      | §57         |  ✅ offers once it's reviewed  |
| S12 Import transcript              | §64         |   🟡 route, mock only, no UI   |

## 4. State machines every screen shares

### 4.1 Meeting lifecycle (J1)

| From         | Event                                          | To                             | Who          |
| ------------ | ---------------------------------------------- | ------------------------------ | ------------ |
| —            | Schedule                                       | `scheduled`                    | any editor   |
| —            | Start now                                      | `live`                         | any editor   |
| `scheduled`  | first person joins                             | `live`                         | participant  |
| `scheduled`  | Cancel                                         | `cancelled`                    | host         |
| `live`       | End for everyone                               | `ended`                        | host         |
| `live`       | last person leaves, then a grace period (§9.1) | `ended`                        | system       |
| `live`       | no turn and no participant for N hours         | `ended`                        | idle sweep   |
| `ended`      | end-of-meeting pass finishes                   | `summarized`                   | system (job) |
| `ended`      | Record mode                                    | `summarized` (transcript only) | system       |
| `summarized` | every candidate decided                        | `reviewed`                     | editors      |

**Today:** `scheduled`, `cancelled`, `live`, `ended` and `summarized`, all
derived from the row (ADR 0045, `server/src/meetings.ts` `meetingStatus`).
A scheduled meeting goes `live` when the recording that starts in its window
becomes it; the host ends the call for everyone (A3.2); `MeetingEnded` queues
the summary (A3.3). `reviewed` waits for the review center (A2).

### 4.2 A participant's connection

`idle → prejoin → joining → connected ⇄ reconnecting → left | failed | removed`

| State          | The user sees                                                                       |                                    Today                                    |
| -------------- | ----------------------------------------------------------------------------------- | :-------------------------------------------------------------------------: |
| `joining`      | "Connecting…" with Cancel                                                           |                                     ✅                                      |
| `connected`    | the room                                                                            |                                  ✅ `live`                                  |
| `reconnecting` | a banner, "Reconnecting — your transcript is safe"; media frozen, capture continues | ✅ on a media reconnect; a signal-only resume keeps media and shows nothing |
| `failed`       | "Lost the connection" with Rejoin (→ S4)                                            |                                     ✅                                      |
| `removed`      | "The host removed you from this meeting"                                            |              ✅ and the token route refuses them for this call              |
| `left`         | the dock disappears; the meeting goes on without you                                |                                     ✅                                      |

The call token lasts 600 s (`server/src/livekit.ts`) and is minted at join.
LiveKit sends a connected client refreshed tokens over the signal connection
(`refreshToken`), and the client reconnects with the newest one; a Rejoin after
the call ended mints a new token through the token route, which also re-checks
the board role and the host's removals.

### 4.3 Capture (transcription), per participant

`off → starting → live ⇄ degraded → stopped`, plus `muted` (the person asked
not to be transcribed, docs/27 §2.9) and `refused` (org policy).

| State      | The user sees                                                                                                                                                                 |                          Today                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------: |
| `starting` | "Starting transcription…"                                                                                                                                                     |   ✅ toasts: "Transcribing on device…", "Connecting…"    |
| `live`     | REC with the provider named                                                                                                                                                   |                            ✅                            |
| `degraded` | the reason: "On-device transcription — every line shows as You", "Hosted transcription dropped a chunk", "This provider transcribes when you stop — Lucent can't answer live" |                          ❌ F22                          |
| `muted`    | "You're not being transcribed" (to you); a mark on your tile (to others)                                                                                                      | ✅ "Stop transcribing me"; "Not transcribed" on the tile |
| `refused`  | "Your organization has turned off meeting capture. The call still works."                                                                                                     |    🟡 server 403 with `recordingDisabled`; no UI copy    |
| `failed`   | "Transcription stopped: <reason>" with Restart; turns so far are kept                                                                                                         |       🟡 toast; the server transcript is left open       |

### 4.4 Lucent's availability in this meeting

| State         | Cause                                    | Effect                                                    | Copy                                                                                                                 |
| ------------- | ---------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ready`       | —                                        | answers, extraction, voice per mode                       | —                                                                                                                    |
| `off by mode` | Record mode                              | no extraction, no answers                                 | "Record mode keeps the transcript only" ✅                                                                           |
| `refused`     | board AI boundary or org provider policy | no model calls; notes use the offline enhancer (labelled) | "This board's AI boundary keeps Lucent out of this meeting"                                                          |
| `limited`     | the monthly allowance is used up         | no model calls until reset                                | "This month's AI allowance is used up. The meeting continues without Lucent." (today: only the server's 402 message) |
| `unavailable` | provider error or timeout                | extraction re-queues; answers fail with Retry             | "Lucent is unavailable — the transcript is still recording"                                                          |

Answers have no timeout today (audit); a 30 s limit turns a hang into
`unavailable`.

### 4.5 Voice conversation

This exists (`web/src/meeting-voice.ts:166–473`, lease 15 s, three follow-up
turns); the table records it so the screens can show it, with the two changes
F20 and F21 need.

| State                       | Entered by                                                                                                          | Left by                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `dormant`                   | start; lease expiry; dismissal ("thanks", "that's all"); another speaker; a teammate's name first; three follow-ups | wake phrase ("Lucent, …", "hey Lucent", "I think, Lucent, …")                                                      |
| `invoked`                   | wake phrase with a request                                                                                          | question → `ai_responding`; command → applied through `send` (proposal above the threshold)                        |
| `ai_responding`             | a question is being answered                                                                                        | answer spoken → `waiting_for_followup`; answer ends in "?" → `waiting_for_user_response`                           |
| `waiting_for_followup`      | answer finished                                                                                                     | same speaker continues → `ai_responding`; else → `dormant`                                                         |
| `waiting_for_user_response` | Lucent asked something                                                                                              | short answer from the same speaker → `ai_responding`; **new: a canvas clarification also enters this state (F21)** |

"Esc" ends the lease today. "Lucent, stop" ends any state and stops playback
once F20 is fixed. Barge-in while Lucent speaks waits for the V8 transport
(F4). Where it shows: the lease chip in
S5 and S6 ("Continuing with Alice · 12 s", Esc); the `?voicehud` debug panel
stays a developer tool.

## 5. Screens

Each screen gives its states (what the user sees, and where each leads) and
its actions. "Today" names what exists.

### S1 Meetings — the workspace list

Every meeting the user can see, across boards and projects (J1).
**Today ❌:** lists are per board: the meeting view's Meetings tab and Home's
"Recent meetings" (three rows, current board only,
`web/src/views/HomeView.tsx:145–164`).

Sections: **Live now · Upcoming · Needs review · Past.** Filters: project,
board, participant, mode. A row shows title, time, status, linked boards,
participants and the count of candidates awaiting review.

| State            | Shows                                         | Leads to                                                                                        |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| loading          | skeleton rows                                 | ready / failed                                                                                  |
| empty            | "No meetings yet" with Start now and Schedule | S4 / S2                                                                                         |
| empty (filtered) | "No meetings match" with Clear filters        | ready                                                                                           |
| ready            | sections                                      | a row: `scheduled` → S3, `live` → S4 (S5 if already in it), `summarized` → S9, `reviewed` → S10 |
| failed           | "Couldn't load meetings" with Retry           | loading                                                                                         |

Actions: **Start now** → creates a `live` meeting on the current board → S4.
**Schedule** → S2. **Import transcript** → S12, shown only when a real
connector is configured (rule 7). Rows appear only for boards the user can
read; a restricted meeting shows only to its invitees (§80).

### S2 Schedule

**Today ✅ (A3.4):** `ScheduleMeeting.tsx`, from the Meetings list (with a board
picker) and from a board's meeting view. Not yet: the policy-refused mode
picker (the sheet offers every mode). The spec: a sheet: title (required), when (date, time, duration),
participants (org members; guests wait for A6), boards and/or project,
template (the six from docs/27: general, 1:1, standup, design review, customer
call, retro), AI mode (default Assistant). Classification is the strictest
of the linked boards and is shown, not chosen.

| State                           | Shows                                                                | Leads to         |
| ------------------------------- | -------------------------------------------------------------------- | ---------------- |
| editing                         | the form; inline errors ("Add a title", "Pick a time in the future") | submitting       |
| submitting                      | disabled form                                                        | created / failed |
| created                         | toast "Invites sent to 4 people"                                     | S3               |
| failed                          | "Couldn't create the meeting" with Retry; fields kept                | editing          |
| refused (capture off by policy) | the mode picker offers only "No capture" with the policy's reason    | created          |

Invites go by email with an `.ics` (decision 6). Reminders and calendar sync
come later.

### S3 Meeting page (upcoming)

**Today ✅ (A3.4):** `UpcomingMeeting.tsx` — every state below but `refused`
(an invitee who lost access simply stops seeing it). The spec: title, time, participants, linked boards, template agenda, and
the **context brief** (§122): earlier decisions, open actions, unresolved
questions and risks from the linked boards (the J3 index widens this to the
project later). Its empty state is "No earlier meetings on these boards".

| State            | Shows                                                       | Leads to  |
| ---------------- | ----------------------------------------------------------- | --------- |
| loading          | skeleton                                                    | ready     |
| ready            | page with Join                                              | S4        |
| early            | "Starts in 2 h"; Join still allowed (§9.6)                  | S4        |
| gone (cancelled) | "Cancelled by Alice on 3 Oct"                               | S1        |
| gone (ended)     | redirect                                                    | S9 or S10 |
| refused          | "You're not invited to this meeting. Ask Alice for access." | —         |

Actions: **Join** → S4. **Edit** and **Cancel** (host) → S2 / confirm →
`cancelled`. **Copy link**.

### S4 Lobby

**Today ✅ (A3.2):** `CallLobby.tsx` — every state below; the speaker picker
shows where the browser can route audio (`setSinkId`). The capture line and
the host's mode choice are not in the lobby yet.

Shows: camera preview, mic level meter, device pickers (mic, camera, speaker
with a test sound), the capture line ("Lucent is transcribing · Assistant
mode"; the host can change the mode here), and Join.

| State                  | Shows                                                                                           | Leads to          |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ----------------- |
| asking permission      | "Allow camera and microphone to preview"                                                        | ready / denied    |
| ready                  | preview, meter, Join                                                                            | joining           |
| mic denied             | "Microphone blocked. Allow it in the address bar, then Retry." Join as listener stays available | ready / joining   |
| camera denied or none  | camera tile off, no error                                                                       | joining           |
| no microphone          | "No microphone found" with Join as listener                                                     | joining           |
| device busy            | "Another app is using your camera"                                                              | ready             |
| joining                | "Connecting…" with Cancel                                                                       | S5 / failed       |
| failed                 | "Couldn't connect" with Retry                                                                   | joining           |
| refused                | "You don't have access to this meeting's call." (today: `Token request failed (404): …`)        | —                 |
| calls not set up (503) | "Video calls aren't set up on this server. You can still transcribe on this device."            | S7 without a call |
| gone                   | "This meeting has ended"                                                                        | S10               |

### S5 Room

**Today ✅ (A3.2):** `CallStage.tsx` — auto grid, spotlight when someone presents
or is pinned, speaker view, People and Chat panels, reactions, the host's
menus, live captions, "stop transcribing me". The board beside the call is
still to come.

| Control                                                       | Who                          |                                          Today                                           |
| ------------------------------------------------------------- | ---------------------------- | :--------------------------------------------------------------------------------------: |
| Mic, camera                                                   | everyone                     |                                    ✅ Ctrl+D, Ctrl+E                                     |
| Switch device in the call                                     | everyone                     |                               ✅ Audio and video settings                                |
| Share screen, stop sharing                                    | everyone (host may restrict) |                       ✅ F24; the host can let only hosts present                        |
| Roster with speaking, muted, sharing, hand                    | everyone                     |                                     ✅ People panel                                      |
| Raise hand, reactions                                         | everyone                     |                                            ✅                                            |
| Chat                                                          | everyone                     |                        ✅ in-call only, never stored (as in Meet)                        |
| Live captions (interim, never stored)                         | everyone                     |                 ✅ CC — each speaker's own device, to whoever reads them                 |
| Capture indicator (rule 4)                                    | everyone sees it             |                           ✅ "Lucent is transcribing · <name>"                           |
| Stop transcribing me                                          | everyone                     |                                            ✅                                            |
| Board beside the call; follow, spotlight, bring everyone here | everyone / presenter         |                              ❌ (`focusOn` exists, unused)                               |
| Leave                                                         | everyone                     |                                      ✅ no confirm                                       |
| End for everyone                                              | host                         |                            ✅ also ends a capture of the call                            |
| Mute, remove, allow sharing, make co-host                     | host                         | ✅ mute, mute everyone, remove, co-host, lower a hand, lock the call, only hosts present |

States follow §4.2. Two more: **ended by host** ("Alice ended the meeting" →
S8 for the host, S10 for others) and **removed** (→ S1).

### S6 Dock — the call while you work elsewhere

**Today ✅:** shows while the call is live and the meeting view isn't open:
people, hands and unread messages, presenter, the lease chip, mic, camera,
screen, Leave, Open (to the call's board, F25), "Reconnecting…", and why a call
ended. A reload offers the call back ("You left the call when the page
reloaded" — Rejoin), from a per-tab marker.

### S7 Capture panel — transcript, notes, Lucent, brief

**Today 🟡:** this is today's `MeetingView`: a left column (header, actions,
mode picker, status, Brief, answer cards, Ask bar) and a right panel with
Transcript, Notes and Meetings tabs.

**Transcript.** Finals with speaker, time, `#n` and kind; search, kind
filters, jump to a turn, topic breaks, links to the board objects a turn
produced (all ✅). Missing: speaker → person mapping (per-participant
capture, §8), confidence, and correction.

| State                                      | Shows                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| not capturing (editor)                     | "Transcription is off" with Start                               |
| not capturing (viewer)                     | "Only editors record this meeting" (F19)                        |
| listening                                  | "Listening for the first line" ✅                               |
| live / degraded / muted / refused / failed | per §4.3                                                        |
| no provider                                | "This browser offers no speech-to-text…" with Start disabled ✅ |

**Correction (§23), new.** Edit a final turn → stored as an overlay
`{turnIndex, text, originalText, editorId, at}`, so the turn log stays
append-only and an ended transcript stays immutable. The line shows "edited
by Bob"; extraction and Ask read the corrected text. Who may correct: §9.4.

**Notes.** As shipped in docs/27 N1 ✅: empty, saving ("Saving…"), saved
("Private to you"), failed ("Couldn't save — your text is still here"),
enhancing ("Writing the note…"), enhanced (cited), offline-enhanced
(labelled).

**Lucent.** Answer cards with citations ✅.

| State                           | Shows                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------- |
| answering                       | "Lucent is answering…" ✅                                                     |
| answered                        | the answer with citation chips ✅                                             |
| no evidence                     | "Nothing in this meeting or board answers that"                               |
| clarifying                      | the question as a card, spoken, with the lease held (F21)                     |
| unavailable / limited / refused | per §4.4                                                                      |
| failed                          | "Couldn't answer: <reason>" with Retry 🟡 (the message exists; Retry doesn't) |

**Brief.** Today it lists only statements already on the board, so it is empty
until someone approves a proposal on the canvas (F16). Target: pending
candidates show here as **suggested**, with Approve and Reject inline, and
the Brief switches to "on the board" as they are approved.

### S8 Ending

**Today 🟡:** Stop flushes, ends, and switches to the saved record ("Ended
at X after N min"). There is no summary step, and closing the tab first loses
the transcript (F13).

Triggers: host **End for everyone** (confirm: "End the meeting for all 4
people? Transcription stops and Lucent writes the summary."); the last person
leaves plus a grace period; Stop on an ad-hoc capture.

| State           | Shows                                                           | Leads to                   |
| --------------- | --------------------------------------------------------------- | -------------------------- |
| finalizing      | "Saving the last lines…"                                        | extracting                 |
| extracting      | "Finding decisions, actions, questions and risks"               | summarizing                |
| summarizing     | "Writing the summary"                                           | S9                         |
| transcript only | Record mode, or Lucent off (§4.4): "Transcript saved"           | S10                        |
| partly failed   | "Transcript saved. The summary couldn't be written." with Retry | S10 (retry later from S10) |

The end-of-meeting pass runs server-side as a job on `MeetingEnded` (retries
and the poison state come from `server/src/jobs.ts`), so closing the tab does
not stop it.

### S9 Review

**Today ❌.** The Brief is the nearest thing, and the canvas proposal panel
is all-or-nothing ("Apply all" / "Cancel").

Shows: the summary, where every sentence cites turns (the notes rule, docs/27
§4); candidates grouped as decisions, actions, questions, risks, requirements
and assumptions, each with its quote, turn link, speaker, confidence (as
evidence coverage, docs/26 rule 2) and any duplicate or contradiction with an
existing statement (§103–104).

Per candidate: **Approve · Edit · Reject · Merge with existing · Assign**
(owner and due date, for actions). Per group: Approve all.

| State                       | Shows                                                          | Leads to  |
| --------------------------- | -------------------------------------------------------------- | --------- |
| loading                     | skeleton                                                       | ready     |
| empty                       | "Lucent found no decisions or actions in this meeting"         | S10       |
| ready                       | "4 of 9 reviewed"                                              | reviewed  |
| reviewed                    | "All reviewed" with the follow-up offers                       | S11 / S10 |
| stale                       | "This no longer fits the board — edit or reject" (today's 422) | ready     |
| changed by another reviewer | "Bob approved this a moment ago"                               | ready     |
| viewer                      | read-only: "Only editors approve candidates"                   | —         |

Approved candidates land through the one mutation path as ordinary operations
with trust `human-approved` (J5). A3 ships the summary and the candidate
list; per-item review with the trust field is A2 (docs/26 §11's order), and
until then the list approves through today's proposal.

### S10 Past meeting

**Today 🟡:** the saved-record mode of the meeting view, per board:
transcript, Brief, notes, "Ended at X after Y", and the `?meeting=&turn=`
deep link.

Shows: title, time, participants, summary, statements with their **current**
status (a superseded decision shows as superseded, §59), transcript, your
notes, linked boards and project, follow-ups created.

| State                | Shows                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| never ended          | today: "This capture never recorded an end…"; target: the idle sweep ends it and the page says so                                 |
| deleted by retention | "Deleted under your organization's 90-day retention policy" (a tombstone, not a 404; the sweep is `server/src/sweeps.ts:138–160`) |
| refused / not found  | as S3                                                                                                                             |

Deep links: today `?meeting=<id>&turn=<n>` (the index is 0-based and `turn`
is dropped after it's read); the target is a stable path with a time offset
(§128).

### S11 Follow-up

**Today 🟡:** each piece exists elsewhere: external tasks through the human
gate (Linear, GitHub, Jira; ADRs 0031–0034), plans from decisions (ADR 0028),
and notes as "Copy as Markdown".

Offers after review: **Create tasks** from approved actions (external gate
preview → confirm); **Schedule the next meeting** (S2 prefilled with open
questions and actions); **Notify owners** (a new notification kind — none of
the seven today is about meetings, `server/src/notifications.ts:125–133`);
**Add a board section** summarizing the meeting (a proposal).

Each offer: preview → confirm → sending → done (with a link) | failed (Retry)
| not connected ("Connect Linear in Integrations").

### S12 Import transcript

**Today 🟡:** `POST /api/boards/:id/meetings/import` (editor), mock source
only, no UI. It stays out of the UI until a real connector exists (rule 7).
When it does: choose source → pick meeting → preview turns → import → S8, with
"Imported from Zoom — speakers as Zoom labelled them".

## 6. Who may do what

Board role governs what lands on the board. Meeting role (new) governs the
call. Org policy caps both.

| Action                         |   Board viewer   | Board editor |  Meeting host  | Today                                                    |
| ------------------------------ | :--------------: | :----------: | :------------: | -------------------------------------------------------- |
| See the meeting and transcript |        ✅        |      ✅      |       ✅       | viewer floor ✅                                          |
| Join the call, speak, share    |    ✅ (§9.3)     |      ✅      |       ✅       | ✅ every board member's token can publish                |
| Be transcribed                 | ✅ unless muted  |      ✅      |       ✅       | ✅ each person on their own device, in a call            |
| Start or stop capture          |        ❌        |      ✅      |       ✅       | editor floor; the UI doesn't check (F19)                 |
| Private notes, enhance, Ask    |        ✅        |      ✅      |       ✅       | ✅ viewer floor                                          |
| Correct a turn                 | own turns (§9.4) |      ✅      |       ✅       | ❌                                                       |
| Approve candidates             |        ❌        |      ✅      | only as editor | editor ✅                                                |
| End for everyone, host powers  |        ❌        |      ❌      |       ✅       | ✅ the call's host list (first person in, plus co-hosts) |
| Import                         |        ❌        |      ✅      |       —        | editor ✅                                                |

Org `recordingDisabled` blocks save, append and import, but never end or reads
(`server/src/routes/meetings.ts`) ✅. The UI must say so (§4.3 `refused`).

## 7. Failures and what keeps working

| Failure                                  | Keeps working                              | The user sees                                                      | Today                                                         |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Client network drops                     | local capture, queued turns                | `reconnecting` banner; turns flush on return                       | silent return to the lobby; turns persist only at Stop (F13)  |
| Call service down or unset               | on-device capture, notes, Ask              | "Video unavailable — transcribing on this device"                  | lobby banner ✅; capture is separate ✅                       |
| Speech provider fails                    | the call                                   | "Transcription stopped" with Restart; no invented text (§117)      | toast; server transcript left open                            |
| Speech output fails                      | the answer as text                         | "Voice: <reason>"                                                  | ✅ `web/src/tts.ts:209–238`                                   |
| Model fails, times out or hits the limit | call, transcript, notes (offline enhancer) | §4.4 copy; extraction re-queues; end pass retries                  | re-queue ✅; no timeout; limit copy is the raw server message |
| Tab closed or reloaded                   | the meeting, for everyone else             | Rejoin offer; the transcript is intact up to the last flushed turn | the call ends; every unsaved turn is lost (F13)               |
| Capture turned off by policy mid-meeting | the call; end and reads                    | "Your organization turned off capture — transcription stopped"     | server ✅, no UI                                              |

## 8. Build order inside A3

Each slice ends in something a person can do, measured against golden steps
7–21 (docs/26 §10).

| Slice | Scope                                                                                          | Ends when                                                                        |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A3.0  | F13–F17: capture durability and the review rule                                                | A reload mid-meeting loses nothing; no meeting extraction applies without review |
| A3.1  | J1 meeting objects (ADR first, migration with backfill); S1 and S10 on them                    | Every meeting in the workspace is listed and reopens                             |
| A3.2  | S4 lobby, S5 states and roster, host basics, F18, F24, F25, S6 rejoin                          | Two people join with chosen devices, and every failure explains itself           |
| A3.3  | `MeetingEnded` emitted and consumed; end-of-meeting pass; S8; S9's summary and candidate list  | A meeting ends into a cited summary with candidates                              |
| A3.4  | S2, S3, email and `.ics`, the context brief                                                    | A scheduled meeting opens with last time's open items                            |
| A3.5  | Per-participant capture with real speaker names; confidence and `startMs` on turns; correction | A two-person transcript names both people, and a wrong line can be fixed         |
| A3.6  | F20, F21, F22                                                                                  | "Lucent, stop" stops; a clarification is spoken and answered by voice            |

A3.0 comes first and is small (no schema). A3.1 gates A3.3, A3.4 and A3.5,
since all three need a meeting object. A3.2 and A3.6 can run beside them.
Per-item review with trust is A2 (J5), and captions and barge-in wait for the
V8 transport (F4).

### Status

- **A3.0 — done (2026-09-27):** F13–F17 (§2).
- **A3.6 — done (2026-09-27):** F20 (outside playback), F21, F22 (§2).
- **A3.1 — done (2026-09-27), per ADR 0045.** The meeting stays its
  transcript record, so its id — which provenance, proposals, notes and deep
  links already use — never changes; J1's fields arrive as columns with the
  features that use them. Shipped: a nullable `title` (migration 0032) with
  rename on the past-meeting page (S10); a derived `live` / `ended` status;
  `GET /api/orgs/:id/meetings`, every meeting on the boards the caller can
  read (the same two scopes as the board list), as summaries; and S1, the
  workspace Meetings view (Live now · Past; the rail's Meetings item) whose
  rows open the meeting on its own board. Upcoming and Needs review are
  absent until scheduling (A3.4) and the end-of-meeting pass (A3.3) give
  them something to show. `scripts/meeting-capture-check.mjs` 28/28.
- **A3.3 — done (2026-09-27): the summary half of S8/S9.** Ending a meeting
  (Stop, a one-shot save, an import) appends `MeetingEnded` to the outbox —
  its first consumer — which queues a `meeting.recap` AI-family job (retried,
  deduped per meeting). The job writes the summary: the notes enhancer's cited
  note over the whole transcript (template "general", no personal lines), with
  the offline note and its reason when the board boundary, the provider policy,
  the allowance or the model says no; Record mode gets none. It is stored on the
  meeting (`summary`, migration 0033) and the status reads `summarized`
  (derived from the stored summary, ADR 0045). The past-meeting page shows it
  above the Brief with turn chips, says "Writing the summary" while the job runs,
  and lets an editor Write it now / Rewrite (`POST …/summary`). Per-item review
  of candidates with trust stays A2 (J5). `scripts/meeting-capture-check.mjs` 29/29.
- **A3.2 — done (2026-09-27): the call works like Zoom or Meet.** The lobby
  (S4): camera preview, a live mic meter, microphone / camera / speaker pickers
  with a test sound, per-device permission states (a blocked or missing mic
  still joins as a listener), "who's here", Cancel while connecting, and a
  failed join in words. The room (S5): auto grid, spotlight for a presenter or
  a pin, speaker view, People (raised hands first) and Chat panels, reactions,
  raise hand, device switching, Ctrl+D / Ctrl+E / Ctrl+Alt+H, the
  "transcribing" mark on the person who records (rule 4), and every connection
  state of §4.2. Host powers: the first person into a board's call hosts it
  (created with LiveKit's RoomService, so two people starting at once still
  get one host); a host mutes one person or everyone, lowers a hand, makes a
  co-host, removes someone — who can't rejoin that call — and ends it for
  everyone, which also ends a capture of it. When every host has left, the
  next person in hosts. The host list lives in the LiveKit room's metadata,
  which only the server writes; hands and the transcribing mark are
  participant attributes the server sets for the caller, so no participant
  token can rename itself. The dock (S6) offers the call back after a reload.
  Fixed on the way: remote audio was attached nowhere, so a call could be
  silent. `scripts/meeting-call-check.mjs` drives three accounts through a real
  LiveKit project (37/37, four runs in a row). Not yet: the board beside the
  call, a waiting room for guests (A6), background blur, and video recording.
- **A3.4 — done (2026-09-27): meetings can be scheduled.** The plan lives on
  the meeting's own row (ADR 0045; migration 0035 adds `scheduled_for`,
  `duration_min`, `invitees`, `template`, `cancelled_at`, `cancelled_by`),
  so the id the invites carry is the id the recording keeps: a recording that
  starts on the board from 15 minutes before to 15 minutes after the planned
  slot becomes that meeting (exactly once — the store's precondition), and
  the summary follows the meeting's template. S2 schedules with a title,
  time, length, invitees (only people who can read the board), notes template
  and Lucent's mode; each invitee gets a `meeting.invited` notification and,
  by their preference, a mail carrying an `.ics` (RFC 5545, the meeting id as
  UID; mail attachments are new on all three transports). S3 shows when, who,
  the template's agenda and the context brief — open actions (soonest due
  first), unresolved questions, risks, recent decisions, and what the last
  summarized meeting on the board ended with — with Join (into the call's
  lobby), Copy link, Add to calendar, and, for the host, Edit (invitees are told;
  anyone dropped gets the cancellation) and Cancel (`meeting.cancelled` with a
  CANCEL `.ics`). S1 lists Upcoming, and meetings you're invited to on boards
  shared from another org. `scripts/meeting-schedule-check.mjs` 19/19. Not yet:
  reminders, calendar sync, linking one meeting to several boards, guests (A6).
- **Captions and host settings — done (2026-09-27).** CC (the button, or
  "c") turns on live captions for you: every speaker's own device — the one
  that already transcribes them for the record — sends what it hears of them,
  words-so-far lossy and the finished line reliable, to the people reading
  captions and to no one else, and nothing is kept. A speaker is told when
  someone reads captions, and "Stop transcribing me" covers captions too. The
  host can lock the call (no one new gets in; hosts and anyone already in
  can) and let only hosts present (others' screens stop at once, and their
  tokens can't publish one). Found on the way, against the live LiveKit
  project: two host actions a moment apart both read the same room metadata
  and the second undid the first, and a client could apply an older room
  update after a newer one. Metadata changes now run one at a time per room
  on the server, the server trusts its own last write over a lagging read,
  and every write carries a `rev` clients use to ignore stale updates.
  Transcript lines are acknowledged by the recording device and resent until
  they are, so a data-channel hiccup doesn't cost anyone their words.
- **A3.5, per-participant capture — done (2026-09-27).** In a board call, each
  person's own browser captures their mic and transcribes it (with the speech
  provider it uses — browser speech recognition sends audio to the browser's
  speech service; hosted runs on our server) while someone records the call,
  and every line lands in ONE transcript under the name LiveKit knows them by
  — with their account id on the turn (`speakerId`). The recording tab stays
  the one writer: other devices send finished lines to it over the call's data
  channel (`lucent.line`), addressed to it alone, and it files them like its
  own — classified, extracted, persisted, and heard by the conversational lease,
  so "Lucent, …" works from anyone in the call. The sender is the LiveKit
  participant, never a name in the payload; a flood from one device is dropped.
  The first person to start recording holds the call's transcript, and a second
  recording of the same call won't start ("Hana is already transcribing this
  call — your words are included"). Everyone else sees that their words are
  included, with **Stop transcribing me**; opting out shows "Not transcribed" on
  their tile, and nothing of theirs is captured. Nothing is transcribed while a
  person's mic is off. Needs a live speech provider on each device (browser
  speech in Chrome and Edge, or hosted); a browser without one says so.
  Confidence and `startMs` on turns are not carried yet, and Lucent's spoken
  answers still play only on the recording device.
- **A3.5, corrections part — done (2026-09-27).** An editor corrects a
  transcript line in place on a saved meeting (`POST …/turns/:n/correction`).
  The correction is an overlay (`corrections`, migration 0034, appended
  atomically on Postgres): the turn keeps its words on record and an ended
  transcript stays immutable; the line reads "· edited" with the original in
  its tooltip. The summary, Ask and search (through `visibleMeetings`) and
  extraction read the corrected words. Only editors for now — §9.4's "the
  speaker" needs speakers to be accounts, which is per-participant capture,
  the rest of A3.5 (it needs a multi-person LiveKit room to build and verify).
- **Notes, checked end to end (2026-09-27).** The owner couldn't tell whether
  note-taking worked, so `scripts/meeting-notes-check.mjs` now drives it:
  notes typed during a recording save and are stamped with the turn they came
  after; stopping writes the enhanced note (your lines in ink, Lucent's cited);
  a reload keeps both; editing one of Lucent's lines makes it yours and saves;
  Copy as Markdown; someone without the board gets 404 (12/12). It found three
  bugs. A reopened meeting showed an empty notepad: the loader marked the
  meeting as loaded before its notes arrived, and React's second effect run
  then skipped the load. The load could also land after the first keystroke
  and replace the typed lines with the stored (empty) copy, so the note the
  meeting's end writes had nothing to work from. Lines typed while the load is
  in flight are now kept after the stored ones and saved (a read-only pad
  during the load wasn't enough: it didn't hold under a slow load). And the
  meeting's proposal review floated over the
  Notes tab; it now docks at the top of the side pane and shows the meeting
  lines it came from, not the internal extraction prompt.

- **S9, review after a meeting — done (2026-09-28).** A past meeting's page
  reviews what Lucent suggested from it, item by item. The Brief (the
  statements that cite the meeting) marks each suggestion. An editor
  approves it, rewords it (Edit), gives an action an owner and a due date
  (Assign), or rejects it, which removes it and undo brings it back.
  "Approve all" takes a section at once. The head says "3 of 5 reviewed",
  then "All reviewed".

  These are the Review center's decisions (`POST /api/boards/:id/review`,
  ADR 0047), committed as the person who decided. They reach the page
  through the room like any change, so a second reviewer's calls show at
  once. A viewer sees the count and "only editors approve what Lucent
  suggested". `scripts/meeting-review-check.mjs` 7/7.

  Not yet: "Merge with existing" and marking duplicates and contradictions
  (§103–104). Candidates still come from extraction, live or "Extract to
  board"; the recap job writes the summary only.

- **S11, follow-up — done (2026-09-28).** Once everything from a meeting is
  reviewed, its page offers what comes next. Each offer goes through a path
  that already has its own gate:

  - **Create tasks:** the meeting's open actions, through the external-action
    preview of each connected tracker (Linear, Jira, GitHub). With none
    connected, it points to Admin.
  - **Schedule the next meeting:** S2, titled "Follow-up: …", inviting the
    people who spoke when they can be matched by name. Its page (S3) opens
    with what's still open.
  - **Notify owners:** a new notification kind, `meeting.followup` (in-app
    and email). Each owner gets one notification listing what they own from
    the meeting (`POST …/meetings/:mid/notify-owners`). An owner is matched
    exactly to one person who can open the board, as `work.assigned` is.
    The page names any owner who matched no one, and the sender isn't told
    about their own actions. Suggestions still waiting stay out.
  - **Add a board section:** a proposal grouping the meeting's statements
    that aren't in a section yet, under the meeting's name.

  `meeting-followup.test.ts` (2); `scripts/meeting-followup-check.mjs` 7/7
  (two accounts, the dev mailbox).

## 9. Decisions needed

Taken with the recommendation on 2026-09-27, when the owner asked for meetings
that work like Zoom and Meet: **1** (the host ends for everyone; LiveKit closes
an empty room after two minutes; the idle sweep ends orphaned captures), **3**
(viewers speak) and **6** (early join); and **2** (per participant in a call,
one-device capture for a room with no call), with A3.5. 4 and 5 are still open.

| #   | Question                                                                                | Recommendation                                                                                                                         |
| --- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | When does a live meeting end?                                                           | Host "End for everyone", **and** 2 minutes after the last person leaves, **and** an idle sweep for orphaned captures                   |
| 2   | Who records? Today one tab captures its own mic, so everyone else is "Speaker" or "You" | Per participant when in the call (docs/26 §7); one-device capture stays for in-person meetings with no call                            |
| 3   | May a board viewer speak and be transcribed? (Today: yes, every token publishes)        | Yes. Speaking in a meeting is not editing the board. The meeting role governs the call; the board role governs what lands on the board |
| 4   | Who may correct a transcript line?                                                      | The speaker, plus board editors; every correction shows who made it                                                                    |
| 5   | May the host change the AI mode mid-meeting? (Today the picker hides while recording)   | Yes, announced to everyone ("Alice switched Lucent to Record mode")                                                                    |
| 6   | May people join before the scheduled time?                                              | Yes; the meeting goes `live` on the first join                                                                                         |
