import { randomBytes } from "node:crypto";

/**
 * SSO connection + domain-claim storage (F1 / ADR 0013).
 *
 * Two concepts, one store, because they are one admin surface:
 *   - `SsoConnection`: the org's IdP trust anchor (entity id, ACS URL, the
 *     certificate signature verification pins) and the `enforceSso` policy.
 *   - `DomainClaim`: an email domain the org proved it owns (TXT challenge),
 *     which routes unauthenticated email addresses to SSO automatically.
 *
 * Rows are immutable facts about trust; the only mutation is a claim's
 * `verifiedAt` flipping from null to a timestamp when the DNS check passes.
 */

export interface SsoConnection {
  id: string;
  orgId: string;
  idpEntityId: string;
  acsUrl: string;
  /** PEM, exactly as pasted by the org owner. The only key verification trusts. */
  x509CertPem: string;
  nameIdFormat: string;
  enforceSso: boolean;
  createdAt: number;
}

export interface NewSsoConnection {
  orgId: string;
  idpEntityId: string;
  acsUrl: string;
  x509CertPem: string;
  nameIdFormat?: string;
  enforceSso?: boolean;
}

export interface DomainClaim {
  id: string;
  orgId: string;
  /** Lowercased, no leading @. */
  domain: string;
  /** The TXT-record value the org must publish. */
  token: string;
  /** Null until the DNS challenge passes; an unverified claim gates nothing. */
  verifiedAt: number | null;
  createdAt: number;
}

export interface SsoStore {
  /** Upsert by (orgId, idpEntityId): the admin "paste the metadata" flow is idempotent. */
  putConnection(input: NewSsoConnection, now: number): Promise<SsoConnection>;
  /** The org's connections, oldest first — in practice one, but not enforced to one. */
  connectionsForOrg(orgId: string): Promise<SsoConnection[]>;
  /** A connection by its IdP entity id: what the ACS resolves from the Response's Issuer. */
  connectionByIssuer(idpEntityId: string): Promise<SsoConnection | undefined>;
  setEnforceSso(orgId: string, idpEntityId: string, enforce: boolean): Promise<boolean>;

  /** Start a claim: returns the row with its TXT token. Idempotent per (org, domain). */
  claimDomain(orgId: string, domain: string, now: number): Promise<DomainClaim>;
  /** Flip verifiedAt. Returns false when no such (org, domain) claim exists. */
  verifyDomain(orgId: string, domain: string, now: number): Promise<boolean>;
  /** The verified claim for an email's domain, if any org holds one. */
  verifiedClaimForEmail(email: string): Promise<DomainClaim | undefined>;
  claimsForOrg(orgId: string): Promise<DomainClaim[]>;
}

export function newSsoConnectionId(): string {
  return "sso_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}
export function newDomainClaimId(): string {
  return "dc_" + Date.now().toString(36) + randomBytes(3).toString("hex");
}

/** `Ada@Corp.Example.COM` → `corp.example.com`. Returns null when there is no domain. */
export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/** Reject obviously-not-a-domain strings; the real check is DNS, this is input hygiene. */
export function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase().replace(/^@/, "");
  if (domain.length === 0 || domain.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  if (!domain.includes(".")) return null;
  return domain;
}

export class InMemorySsoStore implements SsoStore {
  private readonly connections = new Map<string, SsoConnection>();
  private readonly claims = new Map<string, DomainClaim>();

  async putConnection(input: NewSsoConnection, now: number): Promise<SsoConnection> {
    // Upsert keyed on (orgId, idpEntityId): the unique index, by hand.
    const key = `${input.orgId}::${input.idpEntityId}`;
    const existing = [...this.connections.values()].find(
      (c) => `${c.orgId}::${c.idpEntityId}` === key,
    );
    if (existing) {
      const updated: SsoConnection = {
        ...existing,
        acsUrl: input.acsUrl,
        x509CertPem: input.x509CertPem,
        nameIdFormat: input.nameIdFormat ?? existing.nameIdFormat,
        enforceSso: input.enforceSso ?? existing.enforceSso,
      };
      this.connections.set(existing.id, updated);
      return { ...updated };
    }
    const row: SsoConnection = {
      id: newSsoConnectionId(),
      orgId: input.orgId,
      idpEntityId: input.idpEntityId,
      acsUrl: input.acsUrl,
      x509CertPem: input.x509CertPem,
      nameIdFormat: input.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      enforceSso: input.enforceSso ?? false,
      createdAt: now,
    };
    this.connections.set(row.id, row);
    return { ...row };
  }

  async connectionsForOrg(orgId: string): Promise<SsoConnection[]> {
    return [...this.connections.values()]
      .filter((c) => c.orgId === orgId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ ...c }));
  }

  async connectionByIssuer(idpEntityId: string): Promise<SsoConnection | undefined> {
    const hit = [...this.connections.values()].find((c) => c.idpEntityId === idpEntityId);
    return hit ? { ...hit } : undefined;
  }

  async setEnforceSso(orgId: string, idpEntityId: string, enforce: boolean): Promise<boolean> {
    const hit = [...this.connections.values()].find(
      (c) => c.orgId === orgId && c.idpEntityId === idpEntityId,
    );
    if (!hit) return false;
    hit.enforceSso = enforce;
    return true;
  }

  async claimDomain(orgId: string, domain: string, now: number): Promise<DomainClaim> {
    // One claim per domain (the unique index, by hand) — re-claiming returns
    // the existing row so the operator can always find their token.
    const existing = [...this.claims.values()].find((c) => c.domain === domain);
    if (existing) return { ...existing };
    const row: DomainClaim = {
      id: newDomainClaimId(),
      orgId,
      domain,
      token: "lucent-verify=" + randomBytes(20).toString("hex"),
      verifiedAt: null,
      createdAt: now,
    };
    this.claims.set(row.id, row);
    return { ...row };
  }

  async verifyDomain(orgId: string, domain: string, now: number): Promise<boolean> {
    const hit = [...this.claims.values()].find((c) => c.orgId === orgId && c.domain === domain);
    if (!hit) return false;
    hit.verifiedAt = now;
    return true;
  }

  async verifiedClaimForEmail(email: string): Promise<DomainClaim | undefined> {
    const domain = domainOfEmail(email);
    if (!domain) return undefined;
    const hit = [...this.claims.values()].find((c) => c.domain === domain && c.verifiedAt !== null);
    return hit ? { ...hit } : undefined;
  }

  async claimsForOrg(orgId: string): Promise<DomainClaim[]> {
    return [...this.claims.values()]
      .filter((c) => c.orgId === orgId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({ ...c }));
  }
}
