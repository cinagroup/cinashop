import { timingSafeEqual } from 'node:crypto';
import { createDbFromConnectionString } from '@/lib/di';
import { auditCustomerCityBindingFkCurrent } from '@/migrations/auditCustomerCityBindingFkCurrent';

interface Env { HYPERDRIVE: Hyperdrive; AUDIT_TOKEN_SHA256: string; AUDIT_EXPIRES_AT: string }
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'" };
type Stage = 'connect' | 'catalog' | 'close';
type Category = 'permission' | 'lock' | 'timeout' | 'connection' | 'other';

function category(error: unknown): Category {
  let code: unknown;
  try { code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined; }
  catch { return 'other'; }
  if (code === '42501') return 'permission';
  if (code === '55P03') return 'lock';
  if (code === '57014') return 'timeout';
  if (typeof code === 'string' && /^08[0-9A-Z]{3}$/.test(code)) return 'connection';
  return 'other';
}

/** One expiring, fixed-target metadata read; no formal application route. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '';
    const remaining = Number(env.AUDIT_EXPIRES_AT) - Date.now();
    if (!Number.isSafeInteger(Number(env.AUDIT_EXPIRES_AT)) || remaining <= 0 || remaining > 600_000
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256) || !/^[a-f0-9]{64}$/.test(token))
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const expected = Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!, byte => Number.parseInt(byte, 16));
    if (!timingSafeEqual(new Uint8Array(actual), expected))
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    const url = new URL(request.url);
    if (url.pathname !== '/city-binding-fk' || url.search || url.hash)
      return Response.json({ error: 'not found' }, { status: 404, headers });
    if (request.method !== 'GET')
      return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });

    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    let stage: Stage = 'connect';
    try {
      db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1,
        { searchPath: 'public,pg_temp', applicationName: 'cinashop_city_binding_fk_current_audit' });
      stage = 'catalog';
      const audit = await auditCustomerCityBindingFkCurrent(db,
        { role: 'cinashop_app_v1', database: 'postgres' });
      stage = 'close';
      await db.$client.end({ timeout: 1 });
      db = undefined;
      return Response.json({ scope: 'city-binding-fk-current-app',
        ready: audit.identityMatch && audit.catalogMatch,
        readyForIndexDecision: false, audit }, { headers });
    } catch (error) {
      const fixedCategory = category(error);
      console.error(JSON.stringify({ event: 'city_binding_fk_current_audit_failed', stage, category: fixedCategory }));
      return Response.json({ error: 'audit failed', stage, category: fixedCategory }, { status: 503, headers });
    } finally {
      if (db) {
        try { await db.$client.end({ timeout: 1 }); }
        catch { console.error(JSON.stringify({ event: 'city_binding_fk_current_audit_close_failed' })); }
      }
    }
  },
} satisfies ExportedHandler<Env>;
