import { timingSafeEqual } from 'node:crypto';
import { createDbFromConnectionString } from '@/lib/di';
import { inspectManagerRuntimeBootstrap, installManagerRuntimeBootstrap, MANAGER_BOOTSTRAP_OPERATION, MANAGER_BOOTSTRAP_TARGET } from '@/migrations/managerRuntimeBootstrap';
import type { ManagerBootstrapEnv } from './manager-bootstrap-bindings';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** Fixed two-protocol additive maintenance only, absent from application routes.
 * No caller-selected SQL, role, schema, credentials, or business operation. */
export default {
  async fetch(request: Request, env: ManagerBootstrapEnv): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '', expiry = Number(env.AUDIT_EXPIRES_AT), remaining = expiry - Date.now();
    if (!Number.isSafeInteger(expiry) || remaining <= 0 || remaining > 15 * 60000 || !/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256))
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), expected = Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!, value => parseInt(value, 16));
    if (!timingSafeEqual(actual, expected)) return Response.json({ error: 'forbidden' }, { status: 403, headers });
    const url = new URL(request.url);
    if (!['/status','/inspect','/install'].includes(url.pathname) || url.search) return Response.json({ error: 'not found' }, { status: 404, headers });
    const method = url.pathname === '/status' ? 'GET' : 'POST';
    if (request.method !== method) return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...headers, Allow: method } });
    if (method === 'POST') {
      if (url.pathname === '/install' && env.BOOTSTRAP_ENABLED !== 'true') return Response.json({ error: 'mutation disabled' }, { status: 403, headers });
      const operation = url.pathname === '/install' ? MANAGER_BOOTSTRAP_OPERATION : 'manager-ledger-scope-inspect-v1';
      if (request.headers.get('X-Migration-Operation') !== operation) return Response.json({ error: 'explicit fixed operation required' }, { status: 400, headers });
      if (request.body) {
        const reader = request.body.getReader();
        try { for (;;) { const next = await reader.read(); if (next.done) break; if (next.value.byteLength) return Response.json({ error: 'empty body required' }, { status: 400, headers }); } }
        catch { return Response.json({ error: 'invalid body' }, { status: 400, headers }); }
        finally { try { await reader.cancel(); } catch { /* No caller payload logging. */ } reader.releaseLock(); }
      }
    }
    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    try {
      db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, { searchPath: 'public,pg_temp', applicationName: 'cinashop_manager_bootstrap' });
      const result = url.pathname === '/install' ? await installManagerRuntimeBootstrap(db, MANAGER_BOOTSTRAP_TARGET) : await inspectManagerRuntimeBootstrap(db, MANAGER_BOOTSTRAP_TARGET);
      await db.$client.end({ timeout: 1 }); db = undefined;
      return Response.json(result, { headers });
    } catch {
      console.error(JSON.stringify({ event: 'manager_bootstrap_unconfirmed' }));
      return Response.json({ error: 'outcome not confirmed; inspect the fixed Manager catalogs before further action' }, { status: 503, headers });
    } finally { if (db) try { await db.$client.end({ timeout: 1 }); } catch { console.error(JSON.stringify({ event: 'manager_bootstrap_close_failed' })); } }
  },
} satisfies ExportedHandler<ManagerBootstrapEnv>;
