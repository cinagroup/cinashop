/** Public opaque challenge host. This exact route grants no profile authority. */
interface Env { WORKERS_API?: string }
const DEFAULT_API = 'https://cinashop-api.cinagroup.workers.dev';
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const target = new URL('api/admin-profile/challenge', (env.WORKERS_API ?? DEFAULT_API).replace(/\/$/, '') + '/');
  target.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  for (const name of ['host', 'authorization', 'authori-zation', 'cookie']) headers.delete(name);
  return fetch(target, { method: request.method, headers, redirect: 'manual' });
};
