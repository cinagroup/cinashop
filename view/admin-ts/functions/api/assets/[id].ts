/** Read-only same-origin forwarding of signed customer return evidence. */
export const onRequest: PagesFunction<{ WORKERS_API?: string }> = async context => {
  const source = new URL(context.request.url);
  const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };
  if (!['GET', 'HEAD'].includes(context.request.method)) return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: 'GET, HEAD' } });
  if (!/^\/api\/assets\/[1-9]\d*$/.test(source.pathname)) return new Response(null, { status: 404, headers: privateHeaders });
  const target = new URL(context.env.WORKERS_API ?? 'https://cinashop-api.cinagroup.workers.dev');
  target.pathname = source.pathname; target.search = source.search;
  const response = await fetch(target, { method: context.request.method, redirect: 'manual' });
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(privateHeaders)) headers.set(key, value);
  headers.delete('Set-Cookie');
  return new Response(response.body, { status: response.status, headers });
};
