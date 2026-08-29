/**
 * The public template catalog (G1: "templates gallery at org scope + public
 * scope").
 *
 * The org scope (B1) is `TeamTemplateStore`: rows an org owns, member-gated.
 * This is the other scope — the catalog every visitor shares, anonymous
 * included. It answers one question over HTTP that the bundled client
 * `templates.ts` could only answer from inside the app: "what does Lucent
 * ship with?", so the marketing site, the MCP server and any future client
 * can render the same gallery the picker does without importing web code.
 *
 * Metadata only, deliberately. The *ops* each template expands to are built
 * client-side with per-insert ids (`templates.ts: runId`), because "the same
 * template twice on one board" must produce two distinct object sets and
 * that id-minting belongs at apply time, not at listing time. Serving
 * pre-serialized ops here would either bake the collision in or ship a
 * different template than the one the button inserts — both worse than
 * the split.
 */

export interface PublicTemplate {
  id: string;
  name: string;
  kind: string;
  description: string;
}

/**
 * The catalog. Kept in lockstep with `packages/web/src/templates.ts` by the
 * test in `public-templates.test.ts`, which asserts every id here has a
 * matching `TEMPLATES` entry with the same name and kind — the one drift
 * this split otherwise invites.
 */
export const PUBLIC_TEMPLATES: readonly PublicTemplate[] = [
  {
    id: "swot",
    name: "SWOT Analysis",
    kind: "Business",
    description: "Four-quadrant strengths / weaknesses / opportunities / threats board.",
  },
  {
    id: "retro",
    name: "Retrospective",
    kind: "Meetings",
    description: "Went well / to improve / action items columns for a team retro.",
  },
  {
    id: "kanban",
    name: "Kanban Board",
    kind: "Product",
    description: "To do / in progress / done columns for tracking work.",
  },
  {
    id: "mindmap-seed",
    name: "Mind Map",
    kind: "Brainstorm",
    description: "Central idea with three labelled branches, in mind-map view.",
  },
];
