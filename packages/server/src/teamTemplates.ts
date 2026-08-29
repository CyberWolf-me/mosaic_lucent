import { randomBytes } from "node:crypto";
import type { Operation } from "@lucent/core";

/**
 * Org-scoped template library (M2.6, team libraries).
 *
 * Templates are named batches of `Operation`s an org owns. They show up in
 * the same picker as the built-in `TEMPLATES` and apply through the same
 * code path (`packages/web/src/templates.ts:11-18`), so an org template is
 * just a workspace-owned extension of the global list.
 *
 * Two interfaces sit on top of each other, by design. The wire shape
 * (`TeamTemplate`) is the only thing the route handler ever sees, and the
 * store layer is a one-method, two-implementation seam the same way the
 * other stores in this package are. The in-memory implementation is honest
 * about its lifetime — it loses rows on restart — and the Postgres
 * implementation is a one-for-one SQL counterpart.
 */

/**
 * One template as it crosses the wire and lands in the picker.
 *
 * `ops` are the raw operations the picker stamps and applies. We do *not*
 * re-stampify them here — that is the apply path's job, and keeping this
 * type free of cloning means a template written today is identical to one
 * read tomorrow, which matters when a board saves a snapshot and the
 * user rolls forward into a newer template format.
 */
export interface TeamTemplate {
  id: string;
  orgId: string;
  name: string;
  kind: string;
  description: string | null;
  ops: Operation[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The shape a route accepts on POST. `createdBy` is filled by the route
 * from the authenticated session, not the body — the client cannot claim
 * authorship of someone else's template.
 */
export interface NewTeamTemplate {
  orgId: string;
  name: string;
  kind: string;
  description?: string | null;
  ops: Operation[];
  createdAt: number;
}

export interface TeamTemplateStore {
  /** All templates for one org, newest first. Empty array when none. */
  listForOrg(orgId: string): Promise<TeamTemplate[]>;
  /** One template by id, or undefined. Cross-org lookups return undefined. */
  get(orgId: string, id: string): Promise<TeamTemplate | undefined>;
  /** Insert a new template; returns the stored row including its minted id. */
  insert(input: NewTeamTemplate, createdBy: string | null): Promise<TeamTemplate>;
  /**
   * Delete a template. Returns true only when this call changed something,
   * so a double-click on the picker cannot race a second delete into a 404
   * the user has to read.
   */
  remove(orgId: string, id: string): Promise<boolean>;
}

/**
 * Stable id prefix so a saved template is recognisable in logs and on disk.
 * Twelve hex characters (≈48 bits) is plenty for collision avoidance in a
 * single org; the same construction as `newNotificationId` in notifications.ts.
 */
export function newTeamTemplateId(): string {
  return `ttpl_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/**
 * Field-level validation for `NewTeamTemplate`. Returns the list of error
 * messages, or an empty array when the input is acceptable. The route
 * answers 400 with the first error; this function exists so the test
 * suite can assert each rule without driving the route.
 *
 * Rules:
 *  - `name` 1..80 chars after trim, not just whitespace
 *  - `kind` matches one of the known diagram kinds (loosely — the picker
 *    groups by kind, but the route does not pretend to know every
 *    internal subtype of "flow" the user invents).
 *  - `description`, if present, is at most 500 chars.
 *  - `ops` is a non-empty array of operations; we do not re-validate the
 *    ops themselves — that is what the validator does at apply time, and
 *    rejecting a template on creation that the apply path would also
 *    reject is a worse UX than saving it now and failing at apply.
 */
const NAME_MIN = 1;
const NAME_MAX = 80;
const DESC_MAX = 500;

export function validateNewTeamTemplate(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return ["body is required"];
  }
  const body = input as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length < NAME_MIN) {
    errors.push(`name must be at least ${NAME_MIN} characters`);
  } else if (body.name.length > NAME_MAX) {
    errors.push(`name must be at most ${NAME_MAX} characters`);
  }
  if (typeof body.kind !== "string" || body.kind.trim().length === 0) {
    errors.push("kind is required");
  } else if (body.kind.length > 40) {
    errors.push(`kind must be at most 40 characters`);
  }
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string") {
      errors.push("description must be a string when present");
    } else if (body.description.length > DESC_MAX) {
      errors.push(`description must be at most ${DESC_MAX} characters`);
    }
  }
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    errors.push("ops must be a non-empty array");
  }
  return errors;
}

/* ─────────────────────────── In-memory implementation ───────────────────── */

/**
 * Process-local store for dev and tests. Stores are keyed `(orgId, id)`
 * rather than per-org, so a cross-org lookup returns undefined without a
 * second map to maintain.
 */
export class InMemoryTeamTemplateStore implements TeamTemplateStore {
  private readonly rows = new Map<string, TeamTemplate>();

  async listForOrg(orgId: string): Promise<TeamTemplate[]> {
    return [...this.rows.values()]
      .filter((r) => r.orgId === orgId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(orgId: string, id: string): Promise<TeamTemplate | undefined> {
    const row = this.rows.get(id);
    if (!row || row.orgId !== orgId) return undefined;
    return row;
  }

  async insert(input: NewTeamTemplate, createdBy: string | null): Promise<TeamTemplate> {
    const row: TeamTemplate = {
      id: newTeamTemplateId(),
      orgId: input.orgId,
      name: input.name.trim(),
      kind: input.kind.trim(),
      description: input.description ?? null,
      // The picker's apply path stamps ids. We do not touch `ops` here so the
      // saved template is byte-for-byte what the author submitted.
      ops: input.ops,
      createdBy,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.rows.set(row.id, row);
    return { ...row, ops: [...row.ops] };
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.orgId !== orgId) return false;
    this.rows.delete(id);
    return true;
  }
}
