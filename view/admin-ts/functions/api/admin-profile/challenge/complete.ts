/** Siteverify completion still checks the server-bound Admin challenge. */
interface Env { WORKERS_API?: string }
const DEFAULT_API = 'https://cinashop-api.cinagroup.workers.dev';
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const target = new URL('api/admin-profile/challenge/complete', (env.WORKERS_API ?? DEFAULT_API).replace(/\/$/, '') + '/');
  target.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  for (const name of ['host', 'authorization', 'authori-zation', 'cookie']) headers.delete(name);
  return fetch(target, { method: 'POST', headers, body: request.body, redirect: 'manual' });
};
