import { resolveEdgeOrigin } from "./_origin.js";

interface Env {
  LUCENT_ORIGIN?: string;
  ENVIRONMENT?: string;
  NODE_ENV?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const originResult = resolveEdgeOrigin(context.env);
  if ("errorResponse" in originResult) {
    return originResult.errorResponse;
  }
  const origin = originResult.origin;
  const targetUrl = new URL(`${origin}${url.pathname}${url.search}`);
  return fetch(targetUrl.toString(), context.request);
};
