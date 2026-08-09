/**
 * Pages Function: /adminapi/* → Workers API 转发
 * 路径重写: /adminapi/xxx → /api/admin/xxx (Worker 的 admin 路由前缀)
 */
const WORKERS_API = "https://cinashop-api.cinagroup.workers.dev";

interface Env {
  WORKERS_API?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const target = (context.env.WORKERS_API ?? WORKERS_API).replace(/\/$/, "");
  const url = new URL(context.request.url);
  // /adminapi/config/list → /api/admin/config/list
  const apiPath = url.pathname.replace(/^\/adminapi/, "/api/admin");
  const targetUrl = `${target}${apiPath}${url.search}`;

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
