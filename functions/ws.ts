export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const targetUrl = new URL(`https://161.33.167.15.sslip.io${url.pathname}${url.search}`);
  return fetch(targetUrl.toString(), context.request);
};
