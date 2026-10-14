interface Env {
  LUCENT_ORIGIN?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const origin = (context.env.LUCENT_ORIGIN || "http://127.0.0.1:4387").replace(/\/+$/, "");
  const targetUrl = new URL(`${origin}${url.pathname}${url.search}`);
  return fetch(targetUrl.toString(), context.request);
};
