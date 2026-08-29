/** Pages Function: keep the Supplier API same-origin with the browser app. */
const DEFAULT_WORKER = "https://cinashop-api.cinagroup.workers.dev";

interface Env {
  WORKERS_API?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const target = (context.env.WORKERS_API ?? DEFAULT_WORKER).replace(/\/$/, "");
  const source = new URL(context.request.url);
  const targetUrl = `${target}${source.pathname}${source.search}`;
  const headers = new Headers(context.request.headers);
  headers.delete("host");
  return fetch(new Request(targetUrl, {
    method: context.request.method,
    headers,
    body: ["GET", "HEAD"].includes(context.request.method)
      ? undefined
      : context.request.body,
    redirect: "manual",
  }));
};
