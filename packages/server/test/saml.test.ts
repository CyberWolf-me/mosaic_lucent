import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemorySsoStore, domainOfEmail, normalizeDomain } from "../src/ssoStore.js";
import { canonicalize, verifySamlResponse, verifyWithAlgorithm } from "../src/saml.js";

/**
 * The SAML vertical (F1 / ADR 0013) proven against a mock IdP the test itself
 * operates: a fresh RSA keypair per suite, real XML, real signatures, real
 * digest algorithms. This is the whole point of ADR 0013's choice — the
 * signature-wrapping defense is a *line of ours*, and a green suite against
 * a hand-minted IdP is stronger evidence than one against a library fixture.
 *
 * The IdP helper signs exactly the way a real one does:
 *   1. canonicalize the signed element → sha256 → DigestValue
 *   2. build SignedInfo with that digest → canonicalize → RSA-SHA256 → SignatureValue
 *   3. enveloped: the Signature element sits inside the signed element
 *
 * The route tests then walk the ACS end-to-end: save a connection (admin
 * leg), start (mints the AuthnRequest id), post a Response, and assert the
 * JIT-provisioned user, the org membership, and the session.
 */

const SECRET = "test-secret-at-least-16-chars";
const ORIGIN = "http://localhost:5173";
const IDP_ENTITY_ID = "https://idp.test/metadata";
const ACS_URL = "https://lucent.test/api/auth/saml/org_test/acs";

// ---- the mock IdP ----------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Mint one signed Response. `overrides` lets a test deliberately break one
 * thing (swap the cert, tamper the XML, move the window) — every negative
 * test below is one override away from the positive path, which is what
 * makes each failure mode isolated rather than incidental.
 */
async function mintSignedResponse(options: {
  responseId: string;
  inResponseTo: string | null;
  email: string;
  notBefore?: number;
  notOnOrAfter?: number;
  issuer?: string;
  /** Omit the signature entirely (for the unsigned-Response refusal). */
  unsigned?: boolean;
}): Promise<string> {
  const now = Date.now();
  const nb = iso(options.notBefore ?? now - 60_000);
  const noa = iso(options.notOnOrAfter ?? now + 5 * 60_000);
  // The Response carries an EMPTY Signature placeholder where the real one
  // will sit. The digest must cover the signed element as the verifier
  // canonicalizes it — and the verifier skips the Signature subtree — so the
  // element the digest covers is the Response with the placeholder excised.
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${options.responseId}" InResponseTo="${options.inResponseTo ?? ""}" Version="2.0" IssueInstant="${iso(now)}">
  <saml:Issuer>${options.issuer ?? IDP_ENTITY_ID}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${iso(now)}">
    <saml:Issuer>${options.issuer ?? IDP_ENTITY_ID}</saml:Issuer>
    <saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${options.email}</saml:NameID></saml:Subject>
    <saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}"/>
    <saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Test User</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;

  if (options.unsigned) return Buffer.from(xml, "utf8").toString("base64");

  // ---- exactly what a real IdP does, in the same order ----
  // 1. Build the Response WITHOUT the Signature.
  // 2. Canonicalize the Response element — with the same parser the verifier
  //    uses, so both sides hash byte-identical canonical XML (the interop
  //    reality ADR 0013's escape hatch exists for).
  // 3. Digest it; build SignedInfo; canonicalize SignedInfo; RSA-sign.
  // 4. Insert the finished Signature into the Response.
  const responseXml = xml;

  // Canonicalize via the shared seam: parse the whole document, take the
  // root (the Response), serialize it.
  const { DOMParser } = await import("@xmldom/xmldom");
  const parsed = new DOMParser().parseFromString(responseXml, "text/xml");
  const responseElement = parsed.documentElement;
  if (!responseElement) throw new Error("mock IdP: Response XML failed to parse");
  const canonicalResponse = canonicalize(responseElement);

  const digest = createHash("sha256").update(canonicalResponse, "utf8").digest("base64");

  // SignedInfo references the Response by its ID (enveloped signature).
  const signedInfoXml = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#${options.responseId}"><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;

  // The signature is over the canonicalized SignedInfo. Same rule as above:
  // the verifier canonicalizes the parsed SignedInfo, so sign the
  // canonicalized form.
  const parsedSi = new DOMParser().parseFromString(signedInfoXml, "text/xml");
  const canonicalSignedInfo = canonicalize(parsedSi.documentElement!);

  const signatureValue = createSign("RSA-SHA256")
    .update(canonicalSignedInfo, "utf8")
    .sign(privateKey)
    .toString("base64");

  const signatureBlock = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${canonicalSignedInfo}<ds:SignatureValue>${signatureValue}</ds:SignatureValue></ds:Signature>`;

  // Insert the Signature as the Response's first child after the Issuer,
  // where enveloped signatures live.
  const insertionPoint = xml.indexOf("<samlp:Status");
  const before = xml.slice(0, insertionPoint);
  const after = xml.slice(insertionPoint);
  const withSignature = before + signatureBlock + after;
  return Buffer.from(withSignature, "utf8").toString("base64");
}

// ---- harness ---------------------------------------------------------------

interface Harness {
  base: string;
  close: () => Promise<void>;
  userStore: InMemoryUserStore;
  ssoStore: InMemorySsoStore;
  api: (
    path: string,
    init: RequestInit & { token?: string },
  ) => Promise<{ status: number; headers: Headers; body: any }>;
  signup: (email: string) => Promise<{ token: string; id: string; orgId: string }>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: ORIGIN });
  const userStore = new InMemoryUserStore();
  const ssoStore = new InMemorySsoStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    ssoStore,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const api: Harness["api"] = async (path, init) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) {
      headers["content-type"] =
        typeof init.body === "string" && init.body.startsWith("SAMLResponse=")
          ? "application/x-www-form-urlencoded"
          : "application/json";
    }
    const res = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
    const text = await res.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, body };
  };

  const signup = async (email: string) => {
    const res = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(res.status).toBe(201);
    const body = res.body as {
      token: string;
      user: { id: string };
      memberships: Array<{ orgId: string }>;
    };
    return { token: body.token, id: body.user.id, orgId: body.memberships[0]!.orgId };
  };

  return { base, close, userStore, ssoStore, api, signup };
}

// ---- the pure verifier -----------------------------------------------------

describe("verifySamlResponse against the mock IdP", () => {
  it("accepts a correctly signed Response and extracts the identity", async () => {
    const encoded = await mintSignedResponse({
      responseId: "_resp1",
      inResponseTo: "_authn1",
      email: "ada@corp.test",
    });
    const result = verifySamlResponse(encoded, CERT_PEM);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.nameId).toBe("ada@corp.test");
      expect(result.identity.issuer).toBe(IDP_ENTITY_ID);
      expect(result.identity.attributes.displayName).toBe("Test User");
      expect(result.inResponseTo).toBe("_authn1");
    }
  });

  it("refuses a tampered Response — the digest catches the edit", async () => {
    const encoded = await mintSignedResponse({
      responseId: "_resp2",
      inResponseTo: "_authn2",
      email: "ada@corp.test",
    });
    // Flip the NameID inside the *signed* content.
    const xml = Buffer.from(encoded, "base64").toString("utf8");
    const tampered = Buffer.from(xml.replace("ada@corp.test", "admin@corp.test"), "utf8").toString(
      "base64",
    );
    const result = verifySamlResponse(tampered, CERT_PEM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/modified|signature/);
  });

  it("refuses a signature made with a different key (the wrong-org cert)", async () => {
    const { privateKey: otherKey, publicKey: otherPub } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    void otherKey;
    const encoded = await mintSignedResponse({
      responseId: "_resp3",
      inResponseTo: "_authn3",
      email: "ada@corp.test",
    });
    // Verify against the WRONG certificate — the cross-org attack.
    const wrongCert = otherPub.export({ type: "spki", format: "pem" }).toString();
    const result = verifySamlResponse(encoded, wrongCert);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/signature|digest/);
  });

  it("refuses an expired assertion (NotOnOrAfter + skew)", async () => {
    const now = Date.now();
    const encoded = await mintSignedResponse({
      responseId: "_resp4",
      inResponseTo: "_authn4",
      email: "ada@corp.test",
      notOnOrAfter: now - 10 * 60_000,
    });
    const result = verifySamlResponse(encoded, CERT_PEM, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/expired/);
  });

  it("refuses an unsigned Response outright", async () => {
    const encoded = await mintSignedResponse({
      responseId: "_resp5",
      inResponseTo: "_authn5",
      email: "ada@corp.test",
      unsigned: true,
    });
    const result = verifySamlResponse(encoded, CERT_PEM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not signed/);
  });

  it("refuses a non-Success status before reading any identity", async () => {
    // Hand-build a failed Response with a valid-looking NameID: the verifier
    // must never get as far as the NameID.
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp6" InResponseTo="_authn6"><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"/></samlp:Status><saml:Assertion><saml:Subject><saml:NameID>attacker@corp.test</saml:NameID></saml:Subject></saml:Assertion></samlp:Response>`;
    const result = verifySamlResponse(Buffer.from(xml).toString("base64"), CERT_PEM);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/failed authentication/);
  });

  it("refuses a NameID that is not an email", async () => {
    // Signed but with a transient NameID: verified, then refused on shape.
    const raw = await mintSignedResponse({
      responseId: "_resp7",
      inResponseTo: "_authn7",
      email: "not-an-email",
    });
    const result = verifySamlResponse(raw, CERT_PEM);
    // If the signature path succeeded, the email-shape check fires; either
    // way, no identity is returned.
    if (!result.ok) expect(result.error).toMatch(/email/);
    else if (result.ok) expect(result.identity.nameId.includes("@")).toBe(true);
  });

  it("refuses an unknown SignatureMethod instead of falling back to RSA-SHA256", () => {
    // Sign canonical bytes with the real key, then ask verification under an
    // unknown algorithm URI. The old fallback would have verified under
    // SHA256 anyway (algorithm downgrade); the strict allowlist refuses.
    const xml = "<SignedInfo>test</SignedInfo>";
    const signer = createSign("RSA-SHA256");
    signer.update(xml, "utf8");
    const sig = signer.sign(privateKey, "base64");
    expect(
      verifyWithAlgorithm("http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", xml, sig, CERT_PEM),
    ).toBe(true);
    expect(verifyWithAlgorithm("http://example.test/unknown-algo", xml, sig, CERT_PEM)).toBe(false);
    expect(verifyWithAlgorithm("", xml, sig, CERT_PEM)).toBe(false);
  });
});

// ---- the admin + ACS routes -------------------------------------------------

describe("SSO routes (F1)", () => {
  let h: Harness;

  afterEach(async () => {
    if (h) await h.close();
  });

  it("saves a connection (owner), then lists it with a redacted cert", async () => {
    h = await harness();
    const owner = await h.signup("sso-admin@lucent.test");
    const saved = await h.api(`/api/orgs/${owner.orgId}/sso`, {
      method: "PUT",
      token: owner.token,
      body: JSON.stringify({ idpEntityId: IDP_ENTITY_ID, acsUrl: ACS_URL, x509CertPem: CERT_PEM }),
    });
    expect(saved.status).toBe(200);

    const list = await h.api(`/api/orgs/${owner.orgId}/sso`, { token: owner.token });
    expect(list.status).toBe(200);
    const conn = (
      list.body as { connections: Array<{ idpEntityId: string; certFingerprint: string }> }
    ).connections[0]!;
    expect(conn.idpEntityId).toBe(IDP_ENTITY_ID);
    // The full PEM never comes back — recognisable prefix only.
    expect(conn.certFingerprint.length).toBeLessThan(64);
  });

  it("refuses a non-owner on the admin surface", async () => {
    h = await harness();
    const owner = await h.signup("owner@lucent.test");
    const stranger = await h.signup("stranger@lucent.test");
    const res = await h.api(`/api/orgs/${owner.orgId}/sso`, { token: stranger.token });
    expect(res.status).toBe(404);
  });

  it("claims a domain, verifies it against the token, and routes an email to it", async () => {
    h = await harness();
    const owner = await h.signup("claimant@lucent.test");
    const claimed = await h.api(`/api/orgs/${owner.orgId}/sso/claim-domain`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ domain: "Corp.Test" }),
    });
    expect(claimed.status).toBe(201);
    const claimBody = claimed.body as { domain: string; token: string; instructions: string };
    // normalizeDomain lowercases and strips a leading @.
    expect(claimBody.domain).toBe("corp.test");

    const verified = await h.api(`/api/orgs/${owner.orgId}/sso/verify-domain`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ domain: "corp.test", txtValue: claimBody.token }),
    });
    expect(verified.status).toBe(200);

    const routed = await h.ssoStore.verifiedClaimForEmail("whoever@corp.test");
    expect(routed?.domain).toBe("corp.test");
    // A different domain has no claim.
    expect(await h.ssoStore.verifiedClaimForEmail("someone@other.test")).toBeUndefined();
  });

  it("rejects a wrong TXT value", async () => {
    h = await harness();
    const owner = await h.signup("txt@lucent.test");
    await h.api(`/api/orgs/${owner.orgId}/sso/claim-domain`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ domain: "acme.test" }),
    });
    const res = await h.api(`/api/orgs/${owner.orgId}/sso/verify-domain`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ domain: "acme.test", txtValue: "lucent-verify=forged" }),
    });
    expect(res.status).toBe(400);
  });

  it("ACS: full SSO login JIT-provisions a new user with org membership", async () => {
    h = await harness();
    const owner = await h.signup("host@lucent.test");
    const orgId = owner.orgId;
    await h.api(`/api/orgs/${orgId}/sso`, {
      method: "PUT",
      token: owner.token,
      body: JSON.stringify({
        idpEntityId: IDP_ENTITY_ID,
        acsUrl: `http://127.0.0.1:1/api/auth/saml/${orgId}/acs`,
        x509CertPem: CERT_PEM,
      }),
    });

    // The SP-initiated leg mints the request id...
    const start = await h.api(`/api/auth/saml/${orgId}/start`, {});
    expect(start.status).toBe(302);
    const location = start.headers.get("location") ?? "";
    const requestId = new URL(location).searchParams.get("SAMLRequest");
    expect(requestId).toBeTruthy();

    // ...the IdP answers it. The ACS is the browser's POST target.
    const acsPath = `/api/auth/saml/${orgId}/acs`;
    const encoded = await mintSignedResponse({
      responseId: "_resp_ok",
      inResponseTo: requestId!,
      email: "newcomer@corp.test",
    });
    const acs = await h.api(acsPath, {
      method: "POST",
      body: `SAMLResponse=${encodeURIComponent(encoded)}`,
    });
    expect(acs.status).toBe(302);

    // JIT: the user exists, is email-verified, and has the org membership.
    const provisioned = await h.userStore.findByEmail("newcomer@corp.test");
    expect(provisioned).toBeTruthy();
    expect(provisioned!.emailVerifiedAt).not.toBeNull();
    const memberships = await h.userStore.membershipsFor(provisioned!.id);
    expect(memberships.some((m) => m.orgId === orgId)).toBe(true);
  });

  it("ACS: refuses a Response that answers no outstanding request (replay + IdP-initiated)", async () => {
    h = await harness();
    const owner = await h.signup("replay@lucent.test");
    const orgId = owner.orgId;
    await h.api(`/api/orgs/${orgId}/sso`, {
      method: "PUT",
      token: owner.token,
      body: JSON.stringify({
        idpEntityId: IDP_ENTITY_ID,
        acsUrl: `http://127.0.0.1:1/api/auth/saml/${orgId}/acs`,
        x509CertPem: CERT_PEM,
      }),
    });
    const forged = await mintSignedResponse({
      responseId: "_resp_replay",
      inResponseTo: "_never-minted",
      email: "ghost@corp.test",
    });
    const acs = await h.api(`/api/auth/saml/${orgId}/acs`, {
      method: "POST",
      body: `SAMLResponse=${encodeURIComponent(forged)}`,
    });
    expect(acs.status).toBe(401);
    // And no user was provisioned by the attempt.
    expect(await h.userStore.findByEmail("ghost@corp.test")).toBeUndefined();
  });

  it("ACS: a Response replayed after its request was consumed is refused", async () => {
    h = await harness();
    const owner = await h.signup("double@lucent.test");
    const orgId = owner.orgId;
    await h.api(`/api/orgs/${orgId}/sso`, {
      method: "PUT",
      token: owner.token,
      body: JSON.stringify({
        idpEntityId: IDP_ENTITY_ID,
        acsUrl: `http://127.0.0.1:1/api/auth/saml/${orgId}/acs`,
        x509CertPem: CERT_PEM,
      }),
    });
    const start = await h.api(`/api/auth/saml/${orgId}/start`, {});
    const requestId = new URL(start.headers.get("location") ?? "").searchParams.get("SAMLRequest")!;
    const encoded = await mintSignedResponse({
      responseId: "_resp_twice",
      inResponseTo: requestId,
      email: "once@corp.test",
    });
    const first = await h.api(`/api/auth/saml/${orgId}/acs`, {
      method: "POST",
      body: `SAMLResponse=${encodeURIComponent(encoded)}`,
    });
    expect(first.status).toBe(302);
    // The exact same POST again: the request id was consumed.
    const second = await h.api(`/api/auth/saml/${orgId}/acs`, {
      method: "POST",
      body: `SAMLResponse=${encodeURIComponent(encoded)}`,
    });
    expect(second.status).toBe(401);
  });
});

// ---- input hygiene ----------------------------------------------------------

describe("domain helpers", () => {
  it("extracts the domain from an email, lowercased", () => {
    expect(domainOfEmail("Ada@Corp.Example.COM")).toBe("corp.example.com");
    expect(domainOfEmail("no-domain")).toBeNull();
    expect(domainOfEmail("ends-with@")).toBeNull();
  });

  it("normalizes the admin's input", () => {
    expect(normalizeDomain("  Acme.com ")).toBe("acme.com");
    expect(normalizeDomain("@acme.com")).toBe("acme.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("nodot")).toBeNull();
  });
});

// Reference the workspace import used by the harness so tree-shaking in the
// test bundle keeps createWorkspace meaningful.
void createWorkspace;
void randomBytes;
