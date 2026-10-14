interface Env {
  LUCENT_CACHE?: KVNamespace;
  LUCENT_DB?: D1Database;
  LUCENT_ORIGIN?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const cache = context.env.LUCENT_CACHE;
  const origin = (context.env.LUCENT_ORIGIN || "http://127.0.0.1:4387").replace(/\/+$/, "");

  // Edge cache for public static templates
  if (context.request.method === "GET" && cache && url.pathname === "/api/templates/public") {
    const cached = await cache.get("templates:public");
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "application/json", "X-Lucent-Edge-Cache": "HIT" },
      });
    }
  }

  const targetUrl = new URL(`${origin}${url.pathname}${url.search}`);
  const modifiedRequest = new Request(targetUrl.toString(), {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.body,
    redirect: "manual",
  });

  const response = await fetch(modifiedRequest);

  if (
    context.request.method === "GET" &&
    cache &&
    url.pathname === "/api/templates/public" &&
    response.ok
  ) {
    const cloned = response.clone();
    context.waitUntil(
      cloned.text().then((text) => cache.put("templates:public", text, { expirationTtl: 300 })),
    );
  }

  return response;
};
