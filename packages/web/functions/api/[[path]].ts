interface Env {
  LUCENT_CACHE?: KVNamespace;
  LUCENT_DB?: D1Database;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const cache = context.env.LUCENT_CACHE;

  // Edge cache for public static templates
  if (context.request.method === "GET" && cache && url.pathname === "/api/templates/public") {
    const cached = await cache.get("templates:public");
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "application/json", "X-Lucent-Edge-Cache": "HIT" },
      });
    }
  }

  const targetUrl = new URL(`https://161.33.167.15.sslip.io${url.pathname}${url.search}`);
  const modifiedRequest = new Request(targetUrl.toString(), {
    method: context.request.method,
    headers: context.request.headers,
    body: context.request.body,
    redirect: "manual",
  });

  const response = await fetch(modifiedRequest);

  if (context.request.method === "GET" && cache && url.pathname === "/api/templates/public" && response.ok) {
    const cloned = response.clone();
    context.waitUntil(
      cloned.text().then((text) => cache.put("templates:public", text, { expirationTtl: 300 }))
    );
  }

  return response;
};
