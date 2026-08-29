# 12. Collaboration & Modes

> **Status correction (audited 2026-08).** This document was written when the
> realtime layer was deferred, and its central framing — "most of these need
> multiplayer, which we do not have, and we do not fake them" — is now wrong.
> Live cursors, presence, named avatars, role-gated live editing, and comments
> **all ship and are wired into the app**.
>
> **Sharing and access control (corrected 2026-08-28).** An earlier revision of
> this note claimed a bare `?board=<id>` link "brings someone else into it".
> That was false: `GET /api/boards/:id` compared `ownerId` and answered 404 for
> everyone else, so the invite path no-opped silently and the read-only UX was
> unreachable code. Access is now explicit:
>
> - **`board_members`** — one row per person granted access, with a role. The
>   owner needs no row; `boards.owner_id` is authoritative for ownership, so
>   existing boards required no backfill.
> - **`board_share_links`** — revocable tokens carrying the role they grant.
>   Redeeming one (`POST /api/boards/:id/join`) writes a membership row, so
>   revoking a link stops _new_ joins without evicting people who already joined.
> - A board id is **not** a capability. A non-member gets 404 (not 403, so ids
>   stay unguessable) from the REST route, and the WebSocket `join` is refused
>   rather than silently admitted read-only.
> - An invite URL is `?board=<id>&invite=<token>`; the client redeems the token,
>   then strips it from the address bar so a spent invite isn't re-forwarded.
> - **Role granting works**: the owner mints editor or viewer links, changes a
>   member's role, and removes access from the Share dialog. The board owner's
>   own role cannot be changed (409) because it lives on the board row.
>
> Two corrections in the other direction, so this doc isn't over-optimistic
> either:
>
> - The sync layer is **not** a CRDT. It is a server-authoritative sequenced
>   operation log (`packages/server/src/room.ts` explains the choice). Wherever
>   this doc treats "WebSocket + CRDT" as the prerequisite, the prerequisite was
>   met by a different design.
> - **Meeting mode is a static preview** — a hardcoded transcript, nothing
>   recorded or extracted. The view labels itself honestly ("PREVIEW · NOT
>   RECORDING"); this doc previously didn't mention it at all.
>
> Still genuinely unbuilt: remote attention-sync modes (Follow me, Bring
> everyone, Spotlight), and invites by email address rather than by link.
> `focusOn(cx, cy, zoom)` remains the extension point for the former.

Miro/FigJam-style "modes" (Follow me, Spotlight, Bring everyone to me,
Presentation) split into ones that need the real-time layer and ones that don't.
This document separates them and defines the mode framework so the remaining
multiplayer modes slot in without a rewrite.

## The landscape (Miro / FigJam / Figma)

Three groups:

### A. Attention-sync — navigation follows a person

- **Follow / Follow me** — viewer-initiated. You click a collaborator's avatar
  and your viewport locks to theirs; you are pulled along as they pan/zoom.
- **Bring everyone to me / Spotlight** — presenter-initiated. One person pulls
  _everyone's_ viewport to their location (Figma calls the presenter side
  "Spotlight me").
- **Presentation mode** — step through frames/slides as a guided sequence;
  viewers keep board access while following the presenter's position.

### B. Presence — seeing who is here and where

- **Live collaborative cursors** — named cursors moving in real time.
- **Cursor chat / reactions** — ephemeral floating text/emoji.
- **Avatars / who's-viewing** — presence stack of who is on the board.

### C. Session structure — facilitation

- **Timer**, **Voting / dot-voting**, **estimation**.
- **Talktrack / async video** — recorded board walkthroughs.
- **Video + screen streaming** — the board as the shared surface.

## What is blocked vs. buildable in Lucent today

| Mode                                      | Needs multiplayer?                     | Status                  |
| ----------------------------------------- | -------------------------------------- | ----------------------- |
| Follow me                                 | Yes — needs presence + shared viewport | Deferred                |
| Bring everyone to me / Spotlight (remote) | Yes                                    | Deferred                |
| Live cursors / cursor chat                | Yes — presence channel                 | Deferred                |
| Video / screen streaming                  | Yes — media infra                      | Deferred                |
| Timer / voting (group)                    | Partial — works solo, syncs later      | Buildable solo          |
| **Presentation / walkthrough**            | **No**                                 | **Build now**           |
| **Focus / Spotlight (local)**             | **No**                                 | **Build now**           |
| **AI narration walkthrough**              | **No**                                 | Future (differentiator) |

The attention-sync and presence modes are meaningless with one local user and
no sync server. Implementing them "for real" means standing up the deferred
collaboration backend (WebSocket/WebRTC presence + shared-viewport protocol,
CRDT for board state per `docs/06`). We do **not** fake them.

## What we build now

Both are pure client/rendering concerns over the existing semantic model and
viewport — no backend, no schema change.

- **Presentation mode.** Turn the current diagram into a guided walkthrough:
  order the nodes (layout order), then step next/prev. Each step auto-pans and
  centers the viewport on the active node, spotlights it (dims the rest), and
  shows a caption bar with the node label + its type. Keyboard: →/← to move,
  Esc to exit. Reuses `computeLayout` positions and the `CanvasViewport` zoom.
- **Focus mode.** A local spotlight: dim everything except the selected node (or
  a node under the cursor), to direct attention during editing. Pure CSS state.
- **Mode switcher.** A small control (`ModeBar`) with `edit | present | focus`.
  State lives in `CanvasView`. This is the extension point: remote modes
  (Follow, Spotlight, Timer) register here once collaboration exists.

## The Lucent-native angle (future)

Rather than only copying Miro, the strongest mode is **AI narration**: the
Explanation agent (`docs/04`) presents the board — panning to each node while
explaining _why_ it exists, optionally spoken. Presentation mode below is built
so this drops in as an "auto-advance + narrate" layer on the same stepping
engine.

## When collaboration lands

The mode framework here is intentionally viewport- and selection-based. When the
multiplayer layer exists, a remote mode is: (1) subscribe to a peer's viewport
over the presence channel, (2) drive the same `focusOn(...)` viewport control
this doc introduces. So Follow me = "focusOn(peerViewport) on every peer
update," and Bring-everyone = "broadcast my viewport; peers focusOn it." No
rewrite of the mode UI is required.
