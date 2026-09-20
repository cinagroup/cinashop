/** Same-origin signed customer evidence, not a general-purpose API proxy. */
export const onRequest: PagesFunction<{ WORKERS_API?: string }> = async (context) => {
  const source = new URL(context.request.url);
  const headers = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };
  if (!['GET', 'HEAD'].includes(context.request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  if (!/^\/api\/assets\/[1-9]\d*$/.test(source.pathname)) return new Response(null, { status: 404, headers });
  const target = new URL(context.env.WORKERS_API ?? 'https://cinashop-api.cinagroup.workers.dev');
  target.pathname = source.pathname; target.search = source.search;
  // No cookies or merchant bearer token are needed: the Worker verifies the
  // short-lived signature. Never follow an upstream redirect with credentials.
  const upstream = await fetch(target, { method: context.request.method, redirect: 'manual' });
  const outgoing = new Headers(upstream.headers);
  for (const [key, value] of Object.entries(headers)) outgoing.set(key, value);
  outgoing.delete('Set-Cookie');
  return new Response(upstream.body, { status: upstream.status, headers: outgoing });
};
