import type { PaidRuntimeAuditEnv } from './paid-runtime-audit-bindings';
import { timingSafeEqual } from 'node:crypto';
import { createDbFromConnectionString } from '@/lib/di';
import { auditPaidOrderRuntimePermissions } from '@/migrations/auditPaidOrderRuntimePermissions';
import { auditReleasePrerequisiteCatalog } from '@/migrations/auditReleasePrerequisiteCatalog';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** Temporary, expiring preflight. Never mounted in the application Worker.
 * The imported auditor uses a bounded READ ONLY REPEATABLE READ transaction
 * and fixed catalog queries only. It does not install migrations or grant roles.
 */
export default {
  async fetch(request: Request, env: PaidRuntimeAuditEnv): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '';
    const expiry = Number(env.AUDIT_EXPIRES_AT);
    const remaining = expiry - Date.now();
    if (!Number.isSafeInteger(expiry) || remaining <= 0 || remaining > 15 * 60_000
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256)
      || !/^[a-f0-9]{64}$/.test(token)) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }
    const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const expected = Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!, byte => parseInt(byte, 16));
    if (!timingSafeEqual(new Uint8Array(actual), expected)) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }
    const url = new URL(request.url);
    if (!['/audit', '/catalog'].includes(url.pathname) || url.search) {
      return Response.json({ error: 'not found' }, { status: 404, headers });
    }
    if (request.method !== 'GET') {
      return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    }
    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    try {
      db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
        searchPath: 'public,pg_temp', applicationName: 'cinashop_paid_runtime_audit',
      });
      const result = url.pathname === '/catalog'
        ? { scope: 'release-prerequisite-catalog', catalog: await auditReleasePrerequisiteCatalog(db) }
        : { scope: 'paid-order-runtime-permissions', ...await auditPaidOrderRuntimePermissions(db) };
      // A close failure must not escape this handler or expose a raw DB error.
      await db.$client.end({ timeout: 1 });
      db = undefined;
      return Response.json(result, { headers });
    } catch {
      console.error(JSON.stringify({ event: 'paid_runtime_audit_failed' }));
      return Response.json({ error: 'audit failed' }, { status: 503, headers });
    } finally {
      if (db) {
        try { await db.$client.end({ timeout: 1 }); }
        catch { console.error(JSON.stringify({ event: 'paid_runtime_audit_close_failed' })); }
      }
    }
  },
} satisfies ExportedHandler<PaidRuntimeAuditEnv>;
