/**
 * Pages Function: /api/* → Workers API 转发
 *
 * 生产环境 PC 前端部署在 Pages, API 请求打到同源 /api,
 * 这里把请求转发到 Workers (cinashop-api.cinagroup.workers.dev)。
 */
const WORKERS_API = "https://cinashop-api.cinagroup.workers.dev";

interface Env {
  // 可覆盖: 在 Pages 设置环境变量 WORKERS_API 指向其他 Workers
  WORKERS_API?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const target = (context.env.WORKERS_API ?? WORKERS_API).replace(/\/$/, "");
  const url = new URL(context.request.url);
  // 注意: Pages 的 [[path]] 捕获的是 /api 之后的部分,
  // 所以这里需要补回 /api 前缀 (url.pathname 已包含 /api/...)
  const targetUrl = `${target}${url.pathname}${url.search}`;

  // 转发请求 (保留方法/头/body)
  const headers = new Headers(context.request.headers);
  headers.delete("host");

  const upstream = await fetch(targetUrl, {
    method: context.request.method,
    headers,
    body: ["GET", "HEAD"].includes(context.request.method)
      ? undefined
      : await context.request.arrayBuffer(),
  });

  // 返回上游响应 (含 CORS 头)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
};
