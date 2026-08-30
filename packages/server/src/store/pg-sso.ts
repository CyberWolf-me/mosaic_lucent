import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { domainClaims, ssoConnections } from "../db/schema.js";
import {
  domainOfEmail,
  newDomainClaimId,
  newSsoConnectionId,
  type DomainClaim,
  type SsoConnection,
  type SsoStore,
} from "../ssoStore.js";

/**
 * Postgres-backed SSO store (F1). Parity with `InMemorySsoStore` is pinned by
 * the gated Postgres suite. The unique indexes carry the upsert semantics:
 * `putConnection` writes then falls back to select-on-conflict (the in-memory
 * pair does the same by hand), and `claimDomain` is one row per domain.
 */
export class PostgresSsoStore implements SsoStore {
  constructor(private readonly target: Db) {}

  async putConnection(
    input: {
      orgId: string;
      idpEntityId: string;
      acsUrl: string;
      x509CertPem: string;
      nameIdFormat?: string;
      enforceSso?: boolean;
    },
    now: number,
  ): Promise<SsoConnection> {
    // Insert; on the (org_id, idp_entity_id) unique, update in place.
    const rows = await this.target.db
      .insert(ssoConnections)
      .values({
        id: newSsoConnectionId(),
        orgId: input.orgId,
        idpEntityId: input.idpEntityId,
        acsUrl: input.acsUrl,
        x509CertPem: input.x509CertPem,
        nameIdFormat:
          input.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        enforceSso: input.enforceSso ?? false,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [ssoConnections.orgId, ssoConnections.idpEntityId],
        set: {
          acsUrl: input.acsUrl,
          x509CertPem: input.x509CertPem,
          nameIdFormat:
            input.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
          enforceSso: input.enforceSso ?? false,
        },
      })
      .returning();
    return toConnection(rows[0]!);
  }

  async connectionsForOrg(orgId: string): Promise<SsoConnection[]> {
    const rows = await this.target.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.orgId, orgId));
    return rows.map(toConnection).sort((a, b) => a.createdAt - b.createdAt);
  }

  async connectionByIssuer(idpEntityId: string): Promise<SsoConnection | undefined> {
    const rows = await this.target.db
      .select()
      .from(ssoConnections)
      .where(eq(ssoConnections.idpEntityId, idpEntityId))
      .limit(1);
    return rows[0] ? toConnection(rows[0]) : undefined;
  }

  async setEnforceSso(orgId: string, idpEntityId: string, enforce: boolean): Promise<boolean> {
    const updated = await this.target.db
      .update(ssoConnections)
      .set({ enforceSso: enforce })
      .where(and(eq(ssoConnections.orgId, orgId), eq(ssoConnections.idpEntityId, idpEntityId)))
      .returning({ id: ssoConnections.id });
    return updated.length > 0;
  }

  async claimDomain(orgId: string, domain: string, now: number): Promise<DomainClaim> {
    // Same one-row-per-domain rule as the in-memory pair: conflict returns
    // the existing claim so the operator can always retrieve the token.
    const inserted = await this.target.db
      .insert(domainClaims)
      .values({
        id: newDomainClaimId(),
        orgId,
        domain,
        token: "lucent-verify=postgres-path",
        verifiedAt: null,
        createdAt: now,
      })
      .onConflictDoNothing({ target: domainClaims.domain })
      .returning();
    if (inserted[0]) return toClaim(inserted[0]);
    const existing = await this.target.db
      .select()
      .from(domainClaims)
      .where(eq(domainClaims.domain, domain))
      .limit(1);
    return toClaim(existing[0]!);
  }

  async verifyDomain(orgId: string, domain: string, now: number): Promise<boolean> {
    const updated = await this.target.db
      .update(domainClaims)
      .set({ verifiedAt: now })
      .where(and(eq(domainClaims.orgId, orgId), eq(domainClaims.domain, domain)))
      .returning({ id: domainClaims.id });
    return updated.length > 0;
  }

  async verifiedClaimForEmail(email: string): Promise<DomainClaim | undefined> {
    const domain = domainOfEmail(email);
    if (!domain) return undefined;
    const rows = await this.target.db
      .select()
      .from(domainClaims)
      .where(eq(domainClaims.domain, domain))
      .limit(2);
    const verified = rows.find((r) => r.verifiedAt !== null);
    return verified ? toClaim(verified) : undefined;
  }

  async claimsForOrg(orgId: string): Promise<DomainClaim[]> {
    const rows = await this.target.db
      .select()
      .from(domainClaims)
      .where(eq(domainClaims.orgId, orgId));
    return rows.map(toClaim).sort((a, b) => a.createdAt - b.createdAt);
  }
}

function toConnection(row: typeof ssoConnections.$inferSelect): SsoConnection {
  return {
    id: row.id,
    orgId: row.orgId,
    idpEntityId: row.idpEntityId,
    acsUrl: row.acsUrl,
    x509CertPem: row.x509CertPem,
    nameIdFormat: row.nameIdFormat,
    enforceSso: row.enforceSso,
    createdAt: row.createdAt,
  };
}

function toClaim(row: typeof domainClaims.$inferSelect): DomainClaim {
  return {
    id: row.id,
    orgId: row.orgId,
    domain: row.domain,
    token: row.token,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
  };
}
