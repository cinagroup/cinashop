/** Public branding is read-only and must not fall through to the SPA shell. */
export const onRequest: PagesFunction<{ WORKERS_API?: string }> = async (context) => {
  const { method } = context.request;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
    });
  }
  const target = (context.env.WORKERS_API ?? 'https://cinashop-api.cinagroup.workers.dev').replace(/\/$/, '');
  const headers = new Headers();
  // This public endpoint needs neither administrator cookies nor bearer tokens.
  for (const name of ['Accept', 'If-None-Match', 'If-Modified-Since']) {
    const value = context.request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return fetch(`${target}/api/site_config${new URL(context.request.url).search}`, {
    method, headers, redirect: 'manual',
  });
};
