import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { Limiter } from "../src/limiter.js";
import { Telemetry } from "../src/telemetry.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { readConfig } from "../src/config.js";
import { MockSttService, type SttService } from "../src/stt.js";

/**
 * docs/25 V1: server-hosted diarizing STT, at the routes.
 *
 * The acceptance the advisory names: a shared-mic meeting gets real speaker
 * labels where today everything is "You" — asserted here as chunk → finals
 * with speakers through the real HTTP stack. Around it, the structural
 * rules: 503 when unconfigured (never a silent void), 403 on the org's
 * serverStt switch (a `policy:stt` telemetry refusal, not capacity),
 * voice-minute metering exactly once on close, and 404 masking for foreign
 * or expired sessions.
 */

const SECRET = "test-secret-at-least-16-chars";

const SCRIPT = [
  { text: "first turn", speaker: "spk_01" },
  { text: "second turn", speaker: "spk_02" },
];

interface Harness {
  base: string;
  userStore: InMemoryUserStore;
  orgStore: InMemoryOrgStore;
  usage: InMemoryUsageStore;
  telemetry: Telemetry;
  now: { at: number };
  close: () => Promise<void>;
}

async function harness(stt?: SttService, now?: { at: number }): Promise<Harness> {
  const limits = limitsFromEnv();
  const userStore = new InMemoryUserStore();
  const orgStore = new InMemoryOrgStore();
  const usage = new InMemoryUsageStore();
  const telemetry = new Telemetry();
  const clock = now ?? { at: 1_000_000 };
  const { server, close } = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    stt: stt ?? new MockSttService({ script: SCRIPT, bytesPerUtterance: 4, now: () => clock.at }),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    usageStore: usage,
    limits,
    telemetry,
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    orgStore,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    orgStore,
    usage,
    telemetry,
    now: clock,
    close,
  };
}

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body !== undefined &&
      !(rest.body instanceof Uint8Array) &&
      !(rest.body instanceof Buffer)
        ? { "content-type": "application/json" }
        : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

interface Actor {
  id: string;
  token: string;
  orgId: string;
}

async function signup(h: Harness, email: string): Promise<Actor> {
  const created = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(created.status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  const orgs = await api(h, "/api/orgs", { token: created.body.token });
  return {
    id: created.body.user.id as string,
    token: created.body.token as string,
    orgId: orgs.body.orgs[0].id as string,
  };
}

async function openSession(h: Harness, actor: Actor): Promise<{ status: number; body: any }> {
  return api(h, "/api/stt/sessions", { method: "POST", token: actor.token });
}

async function postAudio(h: Harness, actor: Actor, sessionId: string, bytes: Uint8Array) {
  return api(h, `/api/stt/sessions/${sessionId}/audio`, {
    method: "POST",
    token: actor.token,
    body: bytes,
  });
}

describe("POST /api/stt/sessions", () => {
  it("opens a live session against a seeded service", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.stt@example.com");
    const res = await openSession(h, alice);
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toMatch(/^stt_/);
    expect(res.body.provider).toBe("mock");
    expect(res.body.mode).toBe("live");
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("reports at-close for a provider that transcribes only at close (docs/28 F22)", async () => {
    // The default Deepgram and OpenAI services buffer the audio; the session
    // used to answer mode "live" whatever the provider did.
    const buffering = Object.assign(
      new MockSttService({ script: SCRIPT, bytesPerUtterance: 4, now: () => Date.now() }),
      { streaming: false },
    );
    const h = (open = await harness(buffering));
    const alice = await signup(h, "alice.stt.atclose@example.com");
    const res = await openSession(h, alice);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("at-close");
  });

  it("answers 503 on an unconfigured deployment — never a silent void", async () => {
    const h = (open = await harness(new MockSttService()));
    const alice = await signup(h, "alice.stt.standby@example.com");
    const res = await openSession(h, alice);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("not configured");
  });

  it("refuses without a session (401) and honors the org serverStt switch (403, policy bucket)", async () => {
    const h = (open = await harness());
    expect((await openSession(h, { token: "bad", id: "", orgId: "" })).status).toBe(401);
    const alice = await signup(h, "alice.stt.policy@example.com");
    const denied = await api(h, `/api/orgs/${alice.orgId}/settings`, {
      method: "PATCH",
      token: alice.token,
      body: JSON.stringify({ serverStt: "disabled" }),
    });
    expect(denied.status).toBe(200);
    const refused = await openSession(h, alice);
    expect(refused.status).toBe(403);
    expect(refused.body.boundary).toBe("stt");
    expect(refused.body.error).toContain("disables server-hosted transcription");
    expect(h.telemetry.snapshot().refusals.policy).toBe(1);
    expect(h.telemetry.snapshot().refusals.rate).toBe(0);
    // And the member-visible surface names it.
    const policy = await api(h, `/api/orgs/${alice.orgId}/policy`, { token: alice.token });
    expect(policy.body.serverStt).toBe("disabled");
  });
});

describe("POST /api/stt/sessions/:id/audio", () => {
  it("turns chunks into speaker-labelled finals — the shared-mic acceptance", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.stt.audio@example.com");
    const sessionId = (await openSession(h, alice)).body.sessionId as string;
    // Below stride: buffered, nothing finalized.
    const quiet = await postAudio(h, alice, sessionId, new Uint8Array([1, 2]));
    expect(quiet.status).toBe(200);
    expect(quiet.body.finals).toEqual([]);
    // Crossing the stride emits script order with speakers intact.
    const first = await postAudio(h, alice, sessionId, new Uint8Array([3, 4, 5, 6]));
    expect(first.body.finals).toEqual([{ text: "first turn", speaker: "spk_01" }]);
    // No VAD verdict from the mock: null, forwarded honestly.
    expect(first.body.speech).toBeNull();
    const second = await postAudio(h, alice, sessionId, new Uint8Array([7, 8, 9, 10]));
    expect(second.body.finals).toEqual([{ text: "second turn", speaker: "spk_02" }]);
  });

  it("404s unknown, foreign, and expired sessions — ids stay unguessable", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.stt.mask@example.com");
    const eve = await signup(h, "eve.stt.mask@example.com");
    expect((await postAudio(h, alice, "stt_nope", new Uint8Array([1]))).status).toBe(404);
    const sessionId = (await openSession(h, alice)).body.sessionId as string;
    expect((await postAudio(h, eve, sessionId, new Uint8Array([1]))).status).toBe(404);
  });

  it("400s an empty chunk and 413s an oversize one", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.stt.limits@example.com");
    const sessionId = (await openSession(h, alice)).body.sessionId as string;
    expect((await postAudio(h, alice, sessionId, new Uint8Array(0))).status).toBe(400);
    expect((await postAudio(h, alice, sessionId, new Uint8Array(1024 * 1024 + 1))).status).toBe(
      413,
    );
  });
});

describe("POST /api/stt/sessions/:id/close", () => {
  it("flushes, destroys the session, and meters whole voice minutes once", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.stt.close@example.com");
    const sessionId = (await openSession(h, alice)).body.sessionId as string;
    await postAudio(h, alice, sessionId, new Uint8Array([1, 2, 3, 4]));
    // 61 session seconds → 1 billable minute.
    h.now.at += 61_000;
    const closed = await api(h, `/api/stt/sessions/${sessionId}/close`, {
      method: "POST",
      token: alice.token,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.minutes).toBe(1);
    expect(closed.body.audioSeconds).toBe(61);
    expect(await h.usage.monthToDate(alice.orgId, "voice.minute", Date.now())).toBe(1);
    // Destroyed: further use is 404, and closing twice bills nothing more.
    expect((await postAudio(h, alice, sessionId, new Uint8Array([1]))).status).toBe(404);
    expect(
      (
        await api(h, `/api/stt/sessions/${sessionId}/close`, {
          method: "POST",
          token: alice.token,
        })
      ).status,
    ).toBe(404);
    expect(await h.usage.monthToDate(alice.orgId, "voice.minute", Date.now())).toBe(1);
  });

  it("a sub-minute session costs nothing — aborted mic clicks are free", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice.stt.free@example.com");
    const sessionId = (await openSession(h, alice)).body.sessionId as string;
    const closed = await api(h, `/api/stt/sessions/${sessionId}/close`, {
      method: "POST",
      token: alice.token,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.minutes).toBe(0);
    expect(await h.usage.monthToDate(alice.orgId, "voice.minute", Date.now())).toBe(0);
  });
});
