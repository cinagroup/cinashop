/**
 * Pages Function: /api/* → Workers API 转发 (H5)
 */
const WORKERS_API = "https://cinashop-api.cinagroup.workers.dev";

interface Env {
  WORKERS_API?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const target = (context.env.WORKERS_API ?? WORKERS_API).replace(/\/$/, "");
  const url = new URL(context.request.url);
  const targetUrl = `${target}${url.pathname}${url.search}`;

  const headers = new Headers(context.request.headers);
  headers.delete("host");

  const upstream = await fetch(targetUrl, {
    method: context.request.method,
    headers,
    body: ["GET", "HEAD"].includes(context.request.method)
      ? undefined
      : await context.request.arrayBuffer(),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
};
