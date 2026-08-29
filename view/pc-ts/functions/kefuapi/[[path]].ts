/** Same-origin Pages proxy for the dedicated customer-service security domain. */
const WORKERS_API = "https://cinashop-api.cinagroup.workers.dev";

interface Env {
  WORKERS_API?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const target = (context.env.WORKERS_API ?? WORKERS_API).replace(/\/$/, "");
  const url = new URL(context.request.url);
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  const upstream = await fetch(`${target}${url.pathname}${url.search}`, {
    method: context.request.method,
    headers,
    body: ["GET", "HEAD"].includes(context.request.method)
      ? undefined
      : await context.request.arrayBuffer(),
  });
  if (upstream.status === 101) return upstream;
  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
};
