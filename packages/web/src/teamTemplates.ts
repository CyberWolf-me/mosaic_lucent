import type { Operation } from "@lucent/core";
import { apiFetch } from "./http.js";

/**
 * Team template client (B1/M2.5).
 *
 * Server-backed templates are operations stored on the server under an org,
 * visible to every member of that org, ready to apply one-click. The wire
 * contract mirrors `templates.ts` (`name`, `kind`, `ops: Operation[]`) so the
 * gallery can render both lists through one component, differentiated only
 * by a `source` field.
 */

export interface OrgTemplate {
  id: string;
  orgId: string;
  name: string;
  kind: string;
  description: string | null;
  /** Author of the row — the user the team library will remember for the contribution. */
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Wire shape returned by `GET /api/orgs/:id/templates`. */
interface ListTemplatesBody {
  templates: OrgTemplate[];
}

/** Wire shape returned by `GET /api/orgs/:id/templates/:templateId`. */
interface GetTemplateBody {
  template: { id: string; name: string; kind: string; ops: Operation[] } | null;
}

/**
 * Fetch the active org's templates, newest first. Null when the call failed,
 * which the picker renders as "team templates are unavailable" rather than an
 * error toast — the local list still works.
 */
export async function listOrgTemplates(orgId: string): Promise<OrgTemplate[] | null> {
  const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/templates`);
  if (!res.ok) return null;
  const body = (await res.json()) as ListTemplatesBody;
  return Array.isArray(body.templates) ? body.templates : [];
}

/**
 * Fetch the ops for one team template, so the picker can `applyManual` it.
 * Returns null when the template is gone (caller: treat as "missing card").
 */
export async function getOrgTemplate(
  orgId: string,
  templateId: string,
): Promise<{ id: string; name: string; kind: string; ops: Operation[] } | null> {
  const res = await apiFetch(
    `/api/orgs/${encodeURIComponent(orgId)}/templates/${encodeURIComponent(templateId)}`,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as GetTemplateBody;
  return body.template ?? null;
}
