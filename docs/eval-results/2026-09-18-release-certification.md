# Lucent release certification — 2026-09-18

Run by an automated agent on a Windows dev host, against a **real server
artifact** (`packages/server/dist/main.js`), **real PostgreSQL 16**, the
**real LLM provider** configured in `packages/server/.env`, and the **real
LiveKit / Deepgram STT / TTS** endpoints. No MockProvider, no stub STT/TTS, no
fixture backend was used for any PASS below.

**This is not the certification the release standard asks for.** That document
requires real browsers, real HTTPS behind an ingress, real LiveKit participants
on real devices, three real humans speaking into real microphones, real
OAuth applications, real Linear/Jira/GitHub tenants, a 2-hour meeting, a
load-test ladder, and a canary with 5–10 trusted users. None of those ran here
and none are claimed. Every such item is marked **NOT CERTIFIED** below, which
per the standard is *not* a PASS.

Read the two sections that follow before the table: what the environment
actually proved, and the two defects the run surfaced.

---

## 1. What was actually exercised

| Component | Real? | Evidence |
|---|---|---|
| Server artifact | Yes | `packages/server/dist/main.js`, booted as a separate OS process |
| Database | Yes | PostgreSQL 16 in Docker; `storage: postgres` in the boot line |
| Migrations | Yes | 30 migrations applied on boot; advisory-lock suite green |
| LLM | Yes | `provider=kiosapi model=agnes-2.5-flash`; 6–10 s round-trips, 8 ops returned |
| LiveKit | Yes | `POST /api/livekit/token` → 200 with a minted token |
| STT | Yes | `POST /api/stt/sessions` → `provider: "deepgram"`, `mode: "live"` |
| TTS | Yes | `POST /api/tts/speak` → 200, ~8 KB of real audio bytes |
| WebSocket | Yes | Real `ws` clients against `/ws?ticket=`, two concurrent peers |
| MCP | Yes | Real `@lucent/mcp` stdio process driven over JSON-RPC |
| Browser | **No** | no browser was driven; the web client was not run against this stack |
| Human speech | **No** | no microphone, no speakers, no humans |

Also run: `npm run typecheck` (all six packages, clean) and the full test suite
both in-memory (**778 passed / 71 files**) and against real Postgres
(**1387 passed / 122 files**, 126 of which skip without a database).

## 2. Defects found

### D1 — MCP local sandbox reports success for a batch it applied nothing from

`packages/mcp/src/tools.ts:246-251` filters human-only ops (correctly), but when
the filter empties the batch the code falls through to
`Applied ${operations.length} operation(s)` at line 276 and returns success.

Reproduced: an agent calling `apply_canvas_operations` with a single `MOVE_NODE`
receives `Applied 0 operation(s).` with `isError` unset.

The HTTP route deliberately does the opposite — `packages/server/src/routes/boardOps.ts:163-172`
returns **422** `"batch contains no agent-applicable operations"` with the
comment *"saying so beats an empty 200 that reads as success."* The **remote**
MCP path agrees with the route (`packages/mcp/src/remote.ts:193-197` returns
`"No applicable operations in the batch…"`).

So two of three paths refuse loudly and the local sandbox reports success. An
agent has no way to tell "I did nothing" from "I changed the board." Severity is
bounded: no invalid state enters the workspace (the ops are filtered before the
reducer), and the remote path — the one that touches a real board — is correct.

### D2 — a stale `.env` database URL silently splits the deployment

Not a product defect, recorded because it produced a false negative during this
run and would produce a false confidence in a real one. `loadDotEnv` does not
override an already-set variable (`packages/server/src/main.ts:127`), so a shell
that exports `LUCENT_DATABASE_URL` and a `.env` that sets a different one are
both "configured" — and the process silently uses whichever the shell supplied.
My first durability run wrote to one database and read from another, which
looked exactly like data loss until the two were pinned together. Worth a boot
warning when the two disagree; today the boot line prints `storage: postgres`
without the target.

## 3. Results

### Gate A — Infrastructure

| ID | Check | Status | Evidence |
|---|---|---|---|
| A1 | `/health` | PASS | 200 `{"ok":true}` |
| A2 | Migrations on boot | PASS | 30 applied; migration-lock suite green |
| A3 | Metrics gated unauthenticated | PASS | 401 on `/metrics` and `/metrics/prometheus` |
| A4 | Metrics readable authenticated | PASS | 200, 15–34 KB Prometheus exposition |
| A5 | Object storage (S3) | NOT CERTIFIED | assets backend was `memory`; no S3 endpoint exercised |
| A6 | TLS / ingress / replicas | NOT CERTIFIED | single loopback process, plain HTTP |
| A7 | Monitoring + alert firing | NOT CERTIFIED | no alerting stack |

### Gate B — Core

| ID | Check | Status | Evidence |
|---|---|---|---|
| B1 | Valid ops applied through the real op path | PASS | 5 ops, `seq:1`, `operationId` returned |
| B2 | Dangling reference rejected | PASS | 422, `target node "n_does_not_exist" does not exist` |
| B3 | Rejected batch left no state | PASS | edges unchanged at 2 |
| B4 | Unknown top-level op key refused | PASS | 422 (strict schema, not silently stripped) |
| B5 | MOVE_NODE refused on the agent surface | PASS | 422 |
| B6 | Idempotent retry by `requestId` | PASS | replay applied 0 extra ops; node count stayed 3 |
| B7 | Layout produces finite geometry | PASS | 8/8 nodes placed |
| B8 | Layout deterministic | PASS | identical geometry on re-run |
| B9 | No node overlap | PASS | 0 overlapping pairs |
| B10 | Server stores semantics only | PASS | 8 nodes, **0** server-side positions — geometry is the client's |
| B11 | MOVE_NODE absent from the AI vocabulary | PASS | 36 ops total, 35 AI-permitted, `MOVE_NODE` the only exclusion |
| B12 | Model-facing tool schema has no coordinate op | PASS | 35 op variants advertised; the only `position` fields belong to `CREATE_SHAPE`/`UPDATE_SHAPE` (the manual layer) |
| B13 | History recorded the batches | PASS | 200 with items |

### Gate C — Realtime

| ID | Check | Status | Evidence |
|---|---|---|---|
| C1 | Ticket minted | PASS | 200, `ttlMs: 60000` |
| C2 | WS connect + welcome | PASS | `type=welcome`, version reported |
| C3 | Forged ticket refused | PASS | connection rejected |
| C4 | Cross-client broadcast | PASS | A's ack and B's broadcast agree on `seq` **and** `operationId` |
| C5 | Server-stamped actor attribution | PASS | `actorType=user`, `actorId` = the real user, not a client claim |
| C6 | Disconnect → reconnect replay | PASS | rejoined with `fromSeq`; catch-up contained the missed node id |
| C7 | Replica kill + session recovery | NOT CERTIFIED | single process; no second replica to kill |
| C8 | DB outage mid-session | NOT CERTIFIED | database was not taken down |
| C9 | Sticky-session independence | NOT CERTIFIED | needs ≥2 instances |

### Gate D — AI

| ID | Check | Status | Evidence |
|---|---|---|---|
| D1 | Real model returns structured ops | PASS | 8 ops in 6.4–10.5 s, `provider=kiosapi` |
| D2 | No coordinates in model output | PASS | 0 coordinate-bearing ops of 8 |
| D3 | Ops validated and persisted server-side | PASS | 3 created nodes landed |
| D4 | Adversarial: "place at exactly x=500 y=300" | PASS | 0 ops returned; board unchanged |
| D5 | Adversarial: connect to a non-existent id | PASS | 3 ops returned, 0 coordinate-bearing, 0 dangling edges landed |
| D6 | SSE streaming shape | PASS | `start,delta×4,done` — exactly one terminal frame |
| D7 | Streamed `done` carries validated ops | PASS | 2 ops, no coordinates |
| D8 | Hallucination / provenance honesty | NOT CERTIFIED | needs the Ask path against real meeting evidence; not driven |
| D9 | Policy routing to a private provider | NOT CERTIFIED | no self-hosted provider configured |
| D10 | Provider-side request-log inspection | NOT CERTIFIED | no access to the provider's logs; D4/D5 assert only the board's final state |

### Gate E — Meetings

| ID | Check | Status | Evidence |
|---|---|---|---|
| E1 | LiveKit token route | PASS | 200 with a real minted token |
| E2 | Native room, real A/V, 3 humans | NOT CERTIFIED | no browsers, no cameras, no microphones |
| E3 | Screen share | NOT CERTIFIED | — |
| E4 | Participant identity | NOT CERTIFIED | no participants joined |
| E5 | Transcript persistence | NOT CERTIFIED | no transcript was produced by a real meeting |

### Gate F — Voice

| ID | Check | Status | Evidence |
|---|---|---|---|
| F1 | Hosted STT session opens | PASS | 200, `provider: "deepgram"`, `mode: "live"` |
| F2 | Real audio transcribed | NOT CERTIFIED | no audio was sent; the session was opened, not used |
| F3 | TTS synthesis | PASS | 200, ~8 KB audio |
| F4 | SpeechEvent ordering | NOT CERTIFIED | no speech |
| F5 | Speaker attribution / diarization | NOT CERTIFIED | no speakers |
| F6 | Barge-in / interruption | NOT CERTIFIED | no audio path |
| F7 | VAD, turn detection, address detection | NOT CERTIFIED | no speech |

### Gate G — Intelligence

| ID | Check | Status | Evidence |
|---|---|---|---|
| G1–G6 | Decision/action/question/risk extraction, provenance, cross-meeting memory | NOT CERTIFIED | requires real meeting turns; the scripted-fixture path is covered by `docs/eval-results/2026-09-17-cert-rerun.md`, which is a separate, weaker standard (scripted input, human reviewer) |

### Gate H — Agents

| ID | Check | Status | Evidence |
|---|---|---|---|
| H1 | MCP initialize | PASS | `lucent-mcp`, protocol `2024-11-05` |
| H2 | Four tools advertised | PASS | `apply_canvas_operations`, `get_board`, `list_external_links`, `reset_board` |
| H3 | Apply schema excludes MOVE_NODE | PASS | 14 KB schema, `MOVE_NODE` absent |
| H4 | `get_board` returns a summary | PASS | 182 bytes |
| H5 | Valid batch applies | PASS | 3 ops applied |
| H6 | Invalid op rejected by the validator | PASS | `Rejected 1 invalid operation(s): target node "n_ghost" does not exist` |
| H7 | Human-only batch reported honestly | **FAIL** | returns `Applied 0 operation(s)` as success — see **D1** |
| H8 | `list_external_links` honest locally | PASS | `{"links": [], "note": "no link registry in the local session"}` |
| H9 | MCP against a real board (remote mode) | NOT CERTIFIED | local sandbox only; no `LUCENT_MCP_URL`/`TOKEN` pairing run |
| H10 | Real external MCP client (Claude/Codex) | NOT CERTIFIED | driven by a scripted JSON-RPC client, not a third-party agent |

### Gate I — Integrations

| ID | Check | Status | Evidence |
|---|---|---|---|
| I1–I6 | Linear/Jira/GitHub outbound, inbound, OAuth, webhook verification, idempotency, approval gate | NOT CERTIFIED | no external tenant credentials were used; the in-repo suites cover the logic against fakes, which this standard does not accept as certification |

### Gate J — Security

| ID | Check | Status | Evidence |
|---|---|---|---|
| J1 | Unauthenticated board read refused | PASS | 401 |
| J2 | CSRF enforced | PASS | missing header → 403 `reason=missing-header` |
| J3 | Same call with a valid header succeeds | PASS | 201 (proves J2 isn't passing for the wrong reason) |
| J4 | Cross-tenant board read refused | PASS | 404 |
| J5 | Cross-tenant write refused | PASS | 404 |
| J6 | Restricted board refuses the agent boundary | PASS | 403 `boundary=agent` |
| J7 | Restricted board refuses external AI, no silent fallback | PASS | 403 with the classification sentence |
| J8 | Secret does not leak into `/metrics` | PASS | `TEST_SECRET_89371` absent |
| J9 | Secret does not leak into `/metrics/prometheus` | PASS | absent, 34 KB scanned |
| J10 | Owner can still read their own content | PASS | not over-redacted |
| J11 | Session revocation, expired tokens, replayed webhooks | NOT CERTIFIED | not attempted |
| J12 | SAML / SCIM / 2FA end-to-end | NOT CERTIFIED | not attempted |
| J13 | Retention sweep deletes from Postgres and object storage | NOT CERTIFIED | not driven; no object storage configured |

### Gate K — Production

| ID | Check | Status | Evidence |
|---|---|---|---|
| K1 | Durability across a real process restart | PASS | sentinel + secret survived; nodes 4→5 on a fresh process |
| K2 | Load ladder (10→500 users) | NOT CERTIFIED | not run; `packages/load/` k6 scripts need k6, which is not installed |
| K3 | Failure isolation per dependency | NOT CERTIFIED | only the AI-provider timeout path is covered, by the suite |
| K4 | Backup / restore | NOT CERTIFIED | not attempted |
| K5 | Rollback across a deploy window | NOT CERTIFIED | no deployment pipeline was exercised |
| K6 | Canary with real users | NOT CERTIFIED | — |

## 4. Tally

| | Round 1 | Round 2 | MCP | Total |
|---|---|---|---|---|
| PASS | 42 | 10 | 7 | **59** |
| FAIL | 0 | 0 | 1 | **1** |
| NOT CERTIFIED | 0 | 0 | 0 | **~40 items listed above** |

Every gate the standard makes release-blocking still has unrun items. **Gates
A, C, E, F, G, I, and K are not certified.** The release standard's own rule
applies: NOT CERTIFIED is not a PASS merely because a dependency was not
configured.

## 5. Environment

```
host        Windows 10.0.26200, Node v24.12.0, npm 11.6.2
database    postgres:16-alpine (Docker), 127.0.0.1:55433 -> 5432
server      packages/server/dist/main.js, LUCENT_REQUIRE_AUTH=1, loopback:4387
llm         kiosapi / agnes-2.5-flash (real network, 6-10 s per generation)
livekit     configured (real token minted)
stt         deepgram (real session opened)
tts         configured (real audio returned)
assets      memory backend (not S3)
billing     off
note        a native Windows PostgreSQL also holds port 5432 on this host; the
            Docker container was remapped to 55433 to avoid the collision
```

## 6. What would close the gaps

1. Fix **D1** — make the local MCP sandbox refuse a batch it filtered to empty,
   matching `boardOps.ts` and `remote.ts`. This is a small, self-contained change.
2. Add a boot warning when `LUCENT_DATABASE_URL` in the environment disagrees
   with the one in `.env` (**D2**).
3. Run the browser-based gates on a real deployment with real humans — Gates E,
   F, and G in particular cannot be certified any other way.
4. Run Gate I against real Linear/Jira/GitHub tenants.
5. Run Gate K's load ladder and rollback once a staging environment exists.
