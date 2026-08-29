import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { PUBLIC_TEMPLATES } from "../src/publicTemplates.js";

/**
 * The public template catalog (G1): `GET /api/templates`, anonymous.
 *
 * The drift contract below is written against a literal copy of the client
 * TEMPLATES table rather than a cross-package import (the web package has no
 * `exports` map, and adding one to make one test import-clean would change
 * every consumer's resolution for a test's convenience). The literals are
 * the price: when `packages/web/src/templates.ts` gains a template, this
 * table and `publicTemplates.ts` both need the same line, and the second
 * `it` below is what makes forgetting that fail a build instead of shipping
 * a catalog entry whose insert button does nothing.
 */

/** The client's template table (packages/web/src/templates.ts), by hand. */
const CLIENT_TEMPLATES: ReadonlyArray<{ id: string; name: string; kind: string }> = [
  { id: "swot", name: "SWOT Analysis", kind: "Business" },
  { id: "retro", name: "Retrospective", kind: "Meetings" },
  { id: "kanban", name: "Kanban Board", kind: "Product" },
  { id: "mindmap-seed", name: "Mind Map", kind: "Brainstorm" },
];

/**
 * The public template catalog (G1): `GET /api/templates`, anonymous.
 *
 * Two things pinned here. First the wire contract: the route answers 200
 * with `{ templates: [...] }` to an unauthenticated caller, because the
 * marketing site renders this. Second the drift contract: every id the
 * server catalog lists exists in the web package's `TEMPLATES` with the
 * same name and kind — the catalog is metadata-only (see
 * publicTemplates.ts for why the ops are not serialized), so it must never
 * advertise a template the client cannot build.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";

async function harness(): Promise<{ base: string; close: () => Promise<void> }> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close };
}

describe("GET /api/templates (public catalog, G1)", () => {
  it("answers anonymously with the catalog", async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/templates`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { templates: Array<{ id: string }> };
      expect(Array.isArray(body.templates)).toBe(true);
      expect(body.templates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await h.close();
    }
  });

  it("no server-catalog template is missing from the client TEMPLATES it must describe", () => {
    for (const t of PUBLIC_TEMPLATES) {
      const client = CLIENT_TEMPLATES.find((x) => x.id === t.id);
      expect(
        client,
        `public catalog lists "${t.id}" but the web package has no such template — the catalog would advertise something the client cannot insert`,
      ).toBeDefined();
      if (client) {
        expect(client.name, `name drift on "${t.id}"`).toBe(t.name);
        expect(client.kind, `kind drift on "${t.id}"`).toBe(t.kind);
      }
    }
  });
});
