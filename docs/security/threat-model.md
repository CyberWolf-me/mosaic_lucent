# Threat model

The Lucent server (`packages/server`), the browser client (`packages/web`), and
every party either of them talks to. Written by reading the code: each control
cites the file that enforces it, and each gap says what would have to be built.
Where a boundary does not exist yet it is listed as not existing rather than
left out, because a boundary nobody wrote down is the one nobody guards.

**Pointer convention.** Line numbers are as of 2026-08-28 and are given for every
file but one. `packages/server/src/app.ts` is being dismantled: routes are moving
onto `Router` (`src/http/router.ts`) a domain at a time and two have already gone
(`src/routes/system.ts` and `src/routes/notifications.ts`, wired by
`registerSystemRoutes` and `registerNotificationRoutes`). Its line numbers moved
twice while this document was being written, so citations into that one file name
the **symbol only** — grep it. Everything else is file:line.

## What this model assumes

- **One process, no shared cache.** `LUCENT_DATABASE_URL` unset selects the
  in-memory stores (ADR [0006](../adr/0006-optional-postgres.md)); set, it
  selects Postgres. Multi-instance is examined in B2 and is **not safe today**.
- **TLS terminates upstream.** The server speaks plain HTTP on
  `LUCENT_HOST:LUCENT_PORT` and sets no HSTS. See
  [encryption.md](./encryption.md).
- **Authentication is on by default.** `requireAuth = env.LUCENT_REQUIRE_AUTH
!== "0"` (`config.ts:114`), so the opt-out is explicit. Everything below
  assumes it is on; `LUCENT_REQUIRE_AUTH=0` deletes most of B1 and is documented
  as a localhost-only mode.
- **The actors that matter**: an authenticated tenant reaching another tenant's
  data; an unauthenticated caller on the port; a person who can put text or an
  image on a board someone else opens; a hostile or compromised AI provider; and
  an operator misconfiguration. A malicious operator is out of scope — they
  hold the database.

## Boundaries

| #   | Boundary                         | Direction | State                                             |
| --- | -------------------------------- | --------- | ------------------------------------------------- |
| B1  | Browser to HTTP API              | in        | Guarded: session, CSRF, role, limiter, body cap   |
| B2  | Browser to WebSocket `/ws`       | in        | Guarded at the upgrade; **unmetered once open**   |
| B3  | Board content to the AI provider | out       | Enveloped; egress is operator-configured only     |
| B4  | Board content to other browsers  | lateral   | Schema-narrowed at the sinks; no HTML rendering   |
| B5  | Server to SMTP / mail API        | out       | Injection refused; **STARTTLS opportunistic**     |
| B6  | Server to Postgres               | out       | Parameterised; TLS and at-rest are deployment     |
| B7  | Server to object storage         | out       | **Not built.** Schema landed, no route, no client |
| B8  | Webhook / OAuth ingress          | in        | **Not built.** `stripe_events` table only         |
| B9  | Operator to deployment           | in        | Fail-loud config; `/metrics` is session-gated     |

---

## B1. Browser to HTTP API

**What crosses.** Every `/api/*` request: credentials, board workspaces up to
`maxWorkspaceBytes` (8 MiB default, `config.ts:123`), AI prompts, org and board
administration.

### Enforced today

- **Body cap before parsing.** `MAX_BODY_BYTES = 25_000_000` (`app.ts`) is
  the hard read limit; the workspace route additionally rejects on
  `config.maxWorkspaceBytes`. Evidence: `test/security.test.ts`, "workspace body
  validation".
- **Authentication.** Cookie sessions first, bearer second (`authenticate` in
  `accounts.ts`; `test/sessions.test.ts`, "authenticate reads cookie first, then
  bearer"). The cookie is `lucent_session`, `httpOnly`, `SameSite=Lax`, 30-day
  sliding expiry, `Secure` whenever `LUCENT_WEB_ORIGIN` is `https://`
  (the `sessionCookie` block in `app.ts`). Sessions are rows, so they are
  revocable:
  `revokeAllForUser` backs sign-out-everywhere (`sessions.ts`).
- **Authorization is one path.** `requireBoardRole` (`app.ts`) resolves the
  effective role as the maximum of the org role and the `board_members` role
  through `boardStore.memberRole(boardId, userId, orgRoleFor)`, and
  `requireOrgRole` (`app.ts`) does the org half. Both **answer 404 with an
  identical body** whether the object is absent or merely out of reach, so ids
  stay unguessable. Denials increment
  `lucent_authz_denials_total{route,scope}` by `authzDenials.inc` in both guards.
  Evidence:
  `test/crossTenant.test.ts` (three suites, including "effective roles"),
  `test/tenancy.test.ts`, `test/access.test.ts`, `test/shareGate.test.ts`.
- **CSRF.** Double-submit cookie plus an `Origin` check: `requireCsrf`
  (`app.ts`) calls `verifyCsrf` (`csrf.ts`). Safe methods pass
  (`csrf.ts:42`); the cookie is compared against `signToken(header, secret)` with
  `timingSafeStringEqual` (`csrf.ts:86-88`). Every session-authenticated mutating
  route calls it. The pre-session routes — signup, login, `2fa/verify`, the four
  verify and reset routes — deliberately do not, because `verifyCsrf` returns ok
  when no session cookie is present (`csrf.ts:68`) and a request carrying no
  ambient credential is not a CSRF target. Evidence: `test/csrf.test.ts`.
- **Rate limiting.** Three buckets — `applyAuthLimiter` (`app.ts`; 10 per 5
  minutes, `config.ts:125-127`), `applyAccountLimiter` (`app.ts`) and
  `applyMailLimiter` (`app.ts`, keyed both `mail|ip|email` and `mail|ip`) —
  plus `meter()` (`app.ts`), the sliding window and daily quota on the AI
  routes. Refusals answer 429 with `Retry-After` and increment
  `lucent_refusals_total{route,reason}` (`app.ts`). Evidence:
  `test/limiter.test.ts`, `test/security.test.ts`,
  `test/request-provenance.test.ts`.
- **Credential storage.** Passwords are scrypt as `salt:hash`
  (`auth.ts:23-27`), verified with `timingSafeEqual` (`auth.ts:29-36`).
  Verification and reset tokens are stored as SHA-256 of the raw token and looked
  up by hashing the input (`tokens.ts`). TOTP recovery codes are scrypt hashes
  (`totp.ts:179-183`).
- **Errors do not leak.** `observe()` (`app.ts`) is the outermost handler:
  it records the RED metrics, emits one access-log line, and on an unhandled
  throw answers `{error:"internal error", requestId}` while logging the real
  error. `requestIdOf` (`app.ts`) trusts an inbound `x-request-id` only when
  `trustProxy` is on. Evidence: `test/obs.test.ts`.
- **Admin accountability.** `GET /api/orgs/:id/audit` requires org owner
  (`app.ts`). `audit_log` denormalises `actor_email`, `ip` and
  `user_agent` and deliberately holds no foreign key to `users`, so the trail
  survives the actor (`db/schema.ts:376-399`). Four write sites exist today: role
  change, invite, share, org delete. Evidence: `test/audit-store.test.ts`,
  `test/request-provenance.test.ts`.

### Unmitigated

- **No security response headers on JSON.** `jsonHeaders` (`app.ts`) is a
  content type plus five CORS headers. `nosniff`, `referrer-policy`,
  `x-frame-options` and the CSP are added only by `securityHeaders()`
  (`static.ts:104-115`), so no API response carries them. Low severity behind a
  same-origin SPA, real the moment an API response is navigated to directly.
- **No HSTS anywhere.** `grep -rni "strict-transport" .` finds nothing, so a
  first request over `http://` is downgradeable whatever the proxy does.
- **Session identifiers are plaintext at rest.** `newSessionId()` is
  `randomBytes(32).toString("hex")` (`sessions.ts:57-59`) and that exact value is
  both the cookie and the row's primary key in `InMemorySessionStore` and
  `PostgresSessionStore`. A database read or a leaked backup therefore yields
  _usable_ cookies for up to 30 days, unlike the token stores above, which hash.
  **Fix**: key the row on `sha256(id)` and hash on lookup, mirroring `tokens.ts`.
- **The CSRF cookie has no `Secure` attribute.** `mintCsrf` (`csrf.ts:93-99`)
  hand-builds `Max-Age=2592000; Path=/; SameSite=Lax; HttpOnly` rather than going
  through `serializeCookie`, which defaults `secure` to true (`cookies.ts:51`).
  The token is not a credential by itself, so impact is bounded, but it is an
  inconsistency an auditor will find in a minute.
- **scrypt runs at Node's defaults.** `auth.ts:15-19` promisifies
  `scrypt(password, salt, 64)` with no `cost` argument, so N=16384, r=8, p=1 —
  below current OWASP guidance. Raising it needs a rehash-on-login path, not just
  a new constant.
- **Login timing discloses account existence.** The response body is a uniform
  "invalid email or password" (`accounts.ts:409`), but a missing user skips the
  scrypt verification entirely and so answers measurably faster. **Fix**: verify
  against a dummy hash when the user is absent.

---

## B2. Browser to WebSocket `/ws`

**What crosses.** Board joins, operation commits, presence frames.

### Enforced today

- **Single-use tickets rather than tokens in URLs.** The upgrade requires
  `?ticket=`, and `tickets.consume(ticket)` is an atomic take, so a ticket used
  by a parallel upgrade is already gone (`realtime.ts:110-136`). The ticket comes
  from `POST /api/realtime/ticket`, which is CSRF-guarded (`app.ts`)
  and expires in `realtimeTicketTtlMs`, 60 seconds (`config.ts:130`). There is no
  `Origin` check on the upgrade itself and none is needed: a cross-origin page
  cannot obtain a ticket. Evidence: `test/security.test.ts`, "realtime tickets".
- **The same authorization as HTTP.** `join()` (`realtime.ts:192-249`) resolves
  the effective role through the same resolver and refuses a non-member with
  "board not found".
- **Server-authoritative validation.** Every op passes the Zod operation union
  and the validator before it is sequenced; `room.commit` answers `op-rejected`
  rather than applying (`room.ts`, `realtime.ts:255-262`). Evidence:
  `test/room.test.ts`, `test/collab.e2e.test.ts`.

### Unmitigated

- **No frame size limit.** `new WebSocketServer({ noServer: true })`
  (`realtime.ts:105-108`) sets no `maxPayload`, so the `ws` default of 100 MiB
  applies per frame — four times the HTTP body cap, on a socket that has already
  passed authentication. **Fix**: pass `maxPayload: config.maxWorkspaceBytes`.
- **No rate limit on the commit path.** `applyOp` (`realtime.ts:255-303`) calls
  neither `meter()` nor any limiter, so one authenticated editor can commit as
  fast as the event loop allows, and each commit writes the op log _and_ rewrites
  the whole workspace row. **Fix**: a per-connection token bucket in `applyOp`.
- **Multi-instance sequencing is unsound, so sticky sessions remain mandatory.**
  The durable mechanism exists: `PostgresBoardStore.appendOp` allocates
  `max(seq)+1` in one statement, guarded by a compare-and-set on `expectedSeq`
  and `on conflict ("board_id","seq") do nothing`, and returns `conflict` or
  `lost` (`store/pg-boards.ts:245-268`). The caller does not use it. The `Room` is
  constructed with no `append` option (`realtime.ts:489`), so it numbers from its
  own in-memory log (`room.ts:233`) — which `room.ts:66-74` itself says is
  "a correct sequence only while one process owns" the board — and `applyOp`
  **discards the `appendOp` result** and passes no `expectedSeq`, then broadcasts
  the in-memory number. Two processes serving one board would each broadcast
  their own seq for different operations, and the workspace `put` is a
  last-writer-wins overwrite of the entire row. Cross-instance fanout and shared
  presence _are_ wired (`main.ts:220-284`, `store/pg-fanout.ts`,
  `store/pg-presence.ts`), which makes this worse rather than better: the
  operations do arrive, numbered inconsistently. **Fix**: pass `append` into the
  `Room` so it allocates through the store, send `expectedSeq`, and on
  `{ok:false, reason:"conflict"}` reseed the room from the log.

---

## B3. Board content to the AI provider

**What crosses.** A board summary, attached document text, comment bodies, prior
conversation turns, and optionally an image, to whatever `LUCENT_AI_BASE_URL`
points at.

### Enforced today

- **Egress is operator-configured only.** The server never fetches a
  caller-supplied URL. Every `fetch(` outside tests is either in the browser
  (`web/src/http.ts`, `web/src/stt/livekit.ts`) or targets a base URL from the
  environment. `packages/server/src/image.ts` is image _generation_ — its request
  schema is `{prompt, size?}`, with no URL field — so there is no SSRF sink in
  the tree. Worth stating plainly, because it is the control a questionnaire
  usually assumes is missing.
- **Untrusted text is enveloped, not interpolated.** `packages/ai/src/prompt.ts`
  wraps documents, comment bodies and prior turns in tags it is the sole author
  of, escapes that whole tag family inside the payload so content cannot close
  its own envelope (`escapeHarnessTags`, `prompt.ts:140-159`), strips quotes and
  angle brackets from attacker-controlled attributes (`prompt.ts:161-`), and
  states in `SYSTEM_PROMPT` that enveloped content is data which can never widen
  what the model may do (`prompt.ts:106-119`). The user's own message is escaped
  but not enveloped, and is last (`prompt.ts:506-509`). Evidence:
  `packages/ai/test/injection.test.ts`, 368 lines, one case per attack shape
  against the framing, the escaping and the filter.
- **The model cannot exceed the operation contract.** Output is validated
  against the same Zod union the human path uses, and anything else is refused
  with 422 (`generate.ts:438-442`). The model never assigns node coordinates.
- **Timeout and instrumentation.** `aiTimeoutMs` is 90 seconds
  (`config.ts:129`); provider latency lands in
  `lucent_ai_call_duration_seconds{kind,provider}` (`app.ts`).
- **Billing cannot be redirected.** `resolveAiContext` bills the org the caller
  actually holds an editor grant on, so naming a stranger's board id cannot spend
  their allowance (`app.ts`).

### Unmitigated

- **Residual prompt injection is a model property, not a code property.** The
  envelope makes injected text unambiguously data; it cannot prove the model will
  respect the framing. Blast radius is bounded by what the operation schema
  permits on a board the caller can already edit, plus the confidentiality of
  whatever was in that prompt. There is no eval gate on injection resistance:
  `packages/ai` has no `eval` script — verified 2026-08-28, its `scripts` block
  is build, typecheck, test, test:watch — so the eval job in
  `.github/workflows/quality.yml` detects the script's absence and skips rather
  than pretending to gate.
- **Provider retention is the provider's terms.** No no-training header is sent,
  because no cross-provider standard one exists;
  `../06-tech-stack-and-security.md` says so and the UI matches. There is no
  per-workspace provider policy.
- **A hostile gateway can hand back a remote image URL.**
  `OpenAIImageProvider` asks for `b64_json` but falls back to `src: first.url`
  when the gateway ignores `response_format` (`packages/ai/src/image.ts:148-154`).
  That URL still has to satisfy `imageSrc`, so it can only be `http(s)`, and the
  CSP permits `img-src … https:` — the outcome is a third-party image load in the
  user's browser, not script execution. **Fix**: refuse a response with no
  `b64_json`.

---

## B4. Board content to other users' browsers

**What crosses.** Every string in a workspace — node labels, sticky text,
comment bodies, filenames, colours, SVG path data, image sources — reaches every
other member of the board and the PNG, SVG and PDF export paths.

### Enforced today

- **No HTML rendering path.** Board text is set as text content, never as
  markup.
- **The sinks are narrowed at the schema rather than at the sink.**
  `packages/core/src/schemaPrimitives.ts` gives each sink-bearing field its own
  grammar: `svgPathData`, `cssColor`, `httpUrl` (`:49-52`, max 2000 chars) and
  `imageSrc` as a union of `httpUrl | assetRef | imageDataUrl` (`:155`).
  `IMAGE_DATA_URL` (`:82-84`) admits only a known raster type or `svg+xml`
  followed by **strict** base64 — no space, quote or angle bracket survives it,
  so the SVG and `srcdoc` sinks cannot be broken out of even before per-sink
  escaping. Percent-encoded data URLs are refused for exactly that reason
  (`:74-77`). An `asset:ast_…` reference "is deliberately not a fetchable URL"
  (`:111-115`).
- **`embed` stays http(s)-only**, because an embed reaches an iframe `src`
  (`schemaPrimitives.ts:78-81`); only `kind:"image"` may carry a data URL. Embeds
  render in an iframe whose sandbox deliberately omits `allow-same-origin`, with
  the reasoning in place (`web/src/ui/ShapeToolbar.tsx:337-363`).
- **Export escapes on the way out regardless.** `escapeAttr`/`escapeXml` wrap
  every interpolated value in the SVG writer, including `path` data the schema
  has already validated (`web/src/board/geometry.ts:252-334`).
- **CSP with no `unsafe-eval` and no framing.** `default-src 'self'`,
  `script-src 'self' 'wasm-unsafe-eval'`, `object-src 'none'`,
  `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`
  (`static.ts:76-90`), alongside a `PERMISSIONS_POLICY` granting only
  `microphone=(self)` (`static.ts:93-102`). Evidence: `test/static.test.ts`.
- **Path traversal.** `safePath` decodes, rejects NUL, and requires the resolved
  candidate to be the root or below `root + sep` (`static.ts:122-135`).

### Unmitigated

- **`style-src 'unsafe-inline'`** (`static.ts:76-90`) is required by the current
  build, which means a CSS-injection primitive would not be stopped by the CSP.
- **A base64 SVG is inert only because of where it is used.** Script inside an
  SVG does not run through `<img>` or an SVG `<image href>`, which are the only
  two places a board `src` lands today (`web/src/board/geometry.ts:310`). Any
  future sink that renders a board `src` as a _document_ — `<object>`,
  `<iframe>`, `window.open` — turns an accepted `data:image/svg+xml;base64,…`
  into script execution in the viewer's origin. Treat "where does `src` go" as a
  standing review gate.
- **`img-src … https:` and `frame-src https:` allow arbitrary hosts**, so a
  pasted URL is an outbound request from every viewer's browser and therefore an
  IP-address disclosure to that host.

---

## B5. Server to SMTP or the mail API

**What crosses.** Verification, reset and invite mail: the recipient address, a
subject, board and inviter names, and a token URL.

### Enforced today

- **Header and command injection are refused, not escaped.** `assertNoCrlf`
  (`email/smtp.ts:305-309`) is applied to the recipient, the subject and every
  custom header name and value (`:58-63`), with the reasoning stated at `:53-57`:
  no legitimate address or subject contains a line break.
- **RFC-correct body framing.** `dataPayload` (`:290-303`) normalises to CRLF
  and dot-stuffs a leading `.` per RFC 5321 section 4.5.2.
- **STARTTLS is performed correctly when offered.** EHLO is re-issued after the
  handshake and the pre-TLS buffer discarded per RFC 3207 section 4.2 (`:70-76`,
  `:257-259`); the TLS connection keeps Node's default certificate validation.
- **Template escaping is tested.** HTML metacharacters in board and inviter
  names, token URL-encoding, and control-character stripping
  (`test/mailer.test.ts:84-168`).
- **Wire-level tests exist.** `test/smtp.test.ts`, 322 lines, drives the
  transport against a scripted server on 127.0.0.1, including a multi-line EHLO
  delivered in one `write()` and a byte-at-a-time dribble.

### Unmitigated

- **STARTTLS is opportunistic.** If the server does not advertise it the session
  stays plaintext (`email/smtp.ts:70-76`, admitted at `:14-17`), and AUTH is PLAIN
  only. The client does refuse to send credentials over a connection the server
  declined to secure, which is the important half — but a message body containing
  a password-reset token can still cross in the clear. **Fix**: a
  `LUCENT_SMTP_REQUIRE_TLS` that aborts rather than continuing.
- **The successful STARTTLS handshake is untested**, and the test file says so
  rather than implying coverage (`test/smtp.test.ts:18-21`).
- **Address enumeration through mail** is rate-limited on two keys
  (`applyMailLimiter`, `app.ts`) but not eliminated.

---

## B6. Server to Postgres

### Enforced today

- **Parameterised access throughout.** drizzle-orm query builders; the one
  hand-written statement, `appendOp` (`store/pg-boards.ts:245-268`), interpolates
  only through bindings. No `sql.identifier()` or `sql.raw()` call site exists in
  `packages/server`, which is precisely why the standing drizzle-orm advisory
  (GHSA-gpj5-g38j-94v9, SQL injection through improperly escaped dynamic
  identifiers) is unreachable here. That triage is recorded at
  `../../.github/workflows/ci.yml:128-140` and is to be re-checked, not assumed.
- **Migrations are committed SQL, applied under an advisory lock, and fail the
  boot loudly** (`main.ts:163-170`; `test/pg-migrate-lock.test.ts`).
- **Tenant scoping lives in the queries, not the callers** (`test/pg-store.test.ts`,
  `test/tenancy.test.ts`).

### Unmitigated

- **`LUCENT_DATABASE_URL` carries the password** and is read from the process
  environment or an optional `.env` file (`main.ts:60-84`). There is no secret
  manager integration.
- **TLS to the database and encryption at rest are both deployment
  configuration.** Nothing in the tree sets `sslmode`. See
  [encryption.md](./encryption.md).
- **No row-level security and no per-tenant key.** Isolation is entirely
  application-enforced, which is why B1's single authorization path carries so
  much weight: there is no second line behind it.

---

## B7. Server to object storage

**Landing as this was written; audited 2026-08-28 and to be re-checked before it
is relied on.** `packages/server/src/assets.ts` (1007 lines) now exists and
splits the problem three ways: `AssetStore` for metadata (Postgres in
`store/pg-assets.ts` against the `assets` table, `db/schema.ts:769-800`, migration
`0011_eager_stone_men.sql`), `BlobBackend` for bytes (memory, disk, and an
S3-or-R2 implementation), and an optional `Thumbnailer` allowed to fail. The
module states the invariant that orders every write: a metadata row must never
point at bytes that are not there (`assets.ts:29-31`). `asset:ast_…` references
parse in core (`schemaPrimitives.ts:98-155`).

**No HTTP route reaches it yet**: `grep -n "asset" packages/server/src/app.ts`
returns nothing. Image bytes therefore still travel as base64 data URLs inside
the workspace, which is the cost `assets.ts:8-15` describes. Nothing in this
section is a shipped control.

Threats to model as the route lands, none of them addressed today because the
route does not exist: unauthenticated object reads if bytes are served from a
public bucket instead of through the access-checked route the schema comment
promises (`schemaPrimitives.ts:111-115`); MIME confusion between the declared and
the sniffed type on upload; a decompression or pixel bomb reaching the
thumbnailer; a content-addressed `checksum` unique per org turning into a
cross-tenant existence oracle if the dedupe path is ever made global; and an
orphan sweep deleting an object another board still references.

## B8. Webhook and OAuth ingress

**Also mid-flight; audited 2026-08-28.** `packages/server/src/billing/` now holds
`stripe.ts`, `events.ts`, `handlers.ts` and `objects.ts` (1525 lines together),
`stripe_events` exists as an idempotency ledger keyed on the Stripe `evt_…` id
(`db/schema.ts:822-847`), and `GET /api/orgs/:id/billing` is live and viewer-gated
(`app.ts`), answering 503 rather than a confident "Free" when billing is
unconfigured (`app.ts`). **No inbound webhook route exists yet**:
`grep -rn "stripe-signature" packages/server/src` finds only a design comment
about using a constant-time compare from `node:crypto` (`billing/stripe.ts:29`).
Signature forgery is therefore not a reachable threat today, and equally there is
no signature verification to point a questionnaire at.

What the boundary needs when the route lands: `Stripe-Signature` verified against
the **raw, unparsed** body, since a body already through `JSON.parse` cannot be
verified; a constant-time comparison; a timestamp tolerance to bound replay; the
event id as the idempotency key, which the table's primary key already provides;
and a refusal to trust `livemode` from anywhere but the verified payload. For
OAuth: linking only on a provider-verified email, which the schema comment already
commits to (`db/schema.ts:418-424`), plus `state` bound to the session.

## B9. Operator to deployment

### Enforced today

- **Fail-loud configuration.** `sessionSecret()` throws in production below 16
  characters rather than falling back to a random key (`config.ts:147-158`); an
  unmigrated database exits 1 (`main.ts:163-170`); plan seeding fails loud
  (`main.ts:183-186`).
- **The two dangerous switches are opt-in and named as such**:
  `LUCENT_REQUIRE_AUTH=0` and `LUCENT_TRUST_PROXY=1` (`config.ts:12`).
  `../runbooks/incident.md` tells the on-call that `auth: optional` in production
  is a security incident, not a performance one.
- **`/metrics` needs a session** unless auth is off (`test/security.test.ts:97`,
  "/metrics auth gating"), and `/health` is deliberately minimal and does not
  touch the database.
- **Non-root container, tini as PID 1, production-only install, healthcheck**
  (root `Dockerfile`), built and boot-tested in CI
  (`../../.github/workflows/ci.yml`, `build-image`).
- **Logs redact secret-shaped keys** before serialisation (`obs/logger.ts`).

### Unmitigated

- **`GET /metrics/prometheus` is shadowed by the SPA fallback in any deployment
  that serves the built web app.** The static handler runs before every API route
  (the `staticHandler.serve` call in `app.ts`, whose own comment claims that
  "API / WS / health / metrics all keep flowing into the rest of the router"); the
  handler's bypass list is `/api/`, `/ws`, `/health` and exactly `/metrics`
  (`static.ts:182`); `/metrics/prometheus` has no file extension,
  so it reaches the SPA fallback and gets `index.html` with a 200
  (`static.ts:222-239`). The route registered at `routes/system.ts:70` is never
  entered.
  `test/obs.test.ts:431` passes because it builds the app with no static handler,
  so the bug is untested rather than known-broken. Every alert rule in
  [../slo.md](../slo.md) depends on this endpoint. **Fix**: make that condition
  `pathname === "/metrics" || pathname.startsWith("/metrics/")`, and add a case to
  `test/obs.test.ts` that builds the app _with_ a static handler.
- **`docker-compose.yml` ships a placeholder session secret** and publishes the
  app port with no TLS. It is a development artifact and is not labelled unfit for
  production next to the port mapping.
- **No deploy automation, no feature flags, no error tracker or tracing** —
  stated in `../runbooks/README.md` under "What is honestly missing", repeated
  here because each is a detection-and-response gap and not only an operations
  one.

---

## The short list

Ranked by what an attacker or a bad day reaches first. Every row is a code
change, and none of them is in `docs/`.

| Finding                                            | Where                                    | Severity                |
| -------------------------------------------------- | ---------------------------------------- | ----------------------- |
| Multi-instance op sequencing is unsound            | `realtime.ts:489`, `:269`; `room.ts:233` | High (correctness/data) |
| `/metrics/prometheus` shadowed by the SPA fallback | `static.ts:181-183`                      | High (blind operations) |
| No WebSocket `maxPayload`, no commit rate limit    | `realtime.ts:105`, `:255`                | Medium-high (DoS)       |
| Session ids stored in plaintext                    | `sessions.ts:57-59`, both stores         | Medium (DB/backup leak) |
| STARTTLS optional with no strict mode              | `email/smtp.ts:70-76`                    | Medium                  |
| No HSTS; no security headers on JSON               | nothing sets HSTS; `app.ts`              | Medium                  |
| scrypt at Node's default cost                      | `auth.ts:15-19`                          | Low-medium              |
| CSRF cookie missing `Secure`                       | `csrf.ts:93-99`                          | Low                     |
| Login timing discloses account existence           | `accounts.ts:400-409`                    | Low                     |

The remediation table that tracks these to closure is in
[pentest-checklist.md](./pentest-checklist.md).
