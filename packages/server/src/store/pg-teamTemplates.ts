import { and, desc, eq } from "drizzle-orm";
import type { Operation } from "@lucent/core";
import type { Db } from "../db/client.js";
import { teamTemplates } from "../db/schema.js";
import {
  newTeamTemplateId,
  type NewTeamTemplate,
  type TeamTemplate,
  type TeamTemplateStore,
} from "../teamTemplates.js";

/**
 * Postgres-backed TeamTemplateStore.
 *
 * Schema lives at `db/schema.ts:teamTemplates`. The table has the
 * `(org_id, created_at)` index the list query needs, and a secondary
 * `(org_id, kind)` index for the picker when it groups by kind.
 *
 * Cross-org safety: every method scopes by `orgId` so a caller can only
 * see rows in orgs they have already authenticated into. The `get` and
 * `remove` paths combine `id` and `orgId` in the WHERE clause so a guessed
 * template id from another org answers undefined / false, never the row.
 */
export class PostgresTeamTemplateStore implements TeamTemplateStore {
  constructor(private readonly target: Db) {}

  async listForOrg(orgId: string): Promise<TeamTemplate[]> {
    const rows = await this.target.db
      .select()
      .from(teamTemplates)
      .where(eq(teamTemplates.orgId, orgId))
      // The (org_id, created_at) index serves both the WHERE and the ORDER BY,
      // so the planner can read this list straight from the index.
      .orderBy(desc(teamTemplates.createdAt));
    return rows.map(rowToTemplate);
  }

  async get(orgId: string, id: string): Promise<TeamTemplate | undefined> {
    const rows = await this.target.db
      .select()
      .from(teamTemplates)
      .where(and(eq(teamTemplates.orgId, orgId), eq(teamTemplates.id, id)))
      .limit(1);
    return rows[0] ? rowToTemplate(rows[0]) : undefined;
  }

  async insert(input: NewTeamTemplate, createdBy: string | null): Promise<TeamTemplate> {
    const id = newTeamTemplateId();
    await this.target.db.insert(teamTemplates).values({
      id,
      orgId: input.orgId,
      name: input.name.trim(),
      kind: input.kind.trim(),
      description: input.description ?? null,
      // Drizzle's jsonb accepts unknown; cast for the runtime shape that
      // matches the wire type. A malformed `ops` is the apply path's
      // problem, not this one.
      ops: input.ops as unknown as Record<string, unknown>[],
      createdBy,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    const inserted = await this.get(input.orgId, id);
    // `get` answers undefined only on a missing row, and we just wrote it;
    // the !-assertion is load-bearing for the return shape.
    return inserted!;
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    // DELETE ... RETURNING gives us the row count in one round trip without a
    // pre-SELECT, and the org-scoped WHERE keeps a guessed id in another org
    // from removing anything.
    const deleted = await this.target.db
      .delete(teamTemplates)
      .where(and(eq(teamTemplates.orgId, orgId), eq(teamTemplates.id, id)))
      .returning({ id: teamTemplates.id });
    return deleted.length > 0;
  }
}

interface TeamTemplateRow {
  id: string;
  orgId: string;
  name: string;
  kind: string;
  description: string | null;
  ops: unknown;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToTemplate(row: TeamTemplateRow): TeamTemplate {
  // `ops` is jsonb; Drizzle hands it back as `unknown` and the wire type
  // expects `Operation[]`. The cast is safe because `insert` is the only
  // write path, and it accepts `Operation[]` at the type level — anything
  // a malicious caller writes via a direct INSERT lands on the apply path
  // where the validator (or the core Zod schema) refuses it.
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    kind: row.kind,
    description: row.description,
    ops: row.ops as Operation[],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
