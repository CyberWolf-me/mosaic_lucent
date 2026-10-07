import type { RegisterRoutes } from "./context.js";
import { PUBLIC_TEMPLATES } from "../publicTemplates.js";

/**
 * Public template catalog routes (G1):
 *   GET /api/templates  ->  { templates: PUBLIC_TEMPLATES }
 */
export const registerTemplateRoutes: RegisterRoutes = (router, s) => {
  const { send } = s;

  router.get("/api/templates", async (ctx) => {
    send(ctx.res, 200, { templates: PUBLIC_TEMPLATES });
  });
};
