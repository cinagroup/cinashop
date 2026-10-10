import { timingSafeEqual } from 'node:crypto';
import { createDbFromConnectionString } from '@/lib/di';
import { auditWorkParentIdentityPermissions } from '@/migrations/auditWorkParentIdentityPermissions';
import { auditWorkParentCapacityStats } from '@/migrations/auditWorkParentCapacityStats';

interface WorkParentCurrentAuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
  AUDIT_EXPIRES_AT: string;
}

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
};
const expectedRole = 'cinashop_app_v1';
const expectedDatabase = 'postgres';
type AuditStage = 'connect' | 'permission' | 'capacity' | 'close';
type SqlstateCategory = 'permission' | 'lock' | 'timeout' | 'connection' | 'other';

function sqlstateCategory(error: unknown): SqlstateCategory {
  // Only fixed categories leave the Worker. Never log a driver error, its SQL,
  // connection string, or message. A malformed error object is also "other".
  let code: unknown;
  try { code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined; }
  catch { return 'other'; }
  if (code === '42501') return 'permission';
  if (code === '55P03') return 'lock';
  if (code === '57014') return 'timeout';
  if (typeof code === 'string' && /^08[0-9A-Z]{3}$/.test(code)) return 'connection';
  return 'other';
}

/** Single-purpose, expiring production probe. No arbitrary SQL or business data. */
export default {
  async fetch(request: Request, env: WorkParentCurrentAuditEnv): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '';
    const remaining = Number(env.AUDIT_EXPIRES_AT) - Date.now();
    if (!Number.isSafeInteger(Number(env.AUDIT_EXPIRES_AT)) || remaining <= 0 || remaining > 10 * 60_000
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256)
      || !/^[a-f0-9]{64}$/.test(token)) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }
    const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const expected = Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!, byte => Number.parseInt(byte, 16));
    if (!timingSafeEqual(new Uint8Array(actual), expected)) {
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    }
    const url = new URL(request.url);
    if (url.pathname !== '/work-parents' || url.search || url.hash) {
      return Response.json({ error: 'not found' }, { status: 404, headers });
    }
    if (request.method !== 'GET') {
      return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET' } });
    }

    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    let stage: AuditStage = 'connect';
    try {
      db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
        searchPath: 'public,pg_temp', applicationName: 'cinashop_work_parent_current_audit',
      });
      stage = 'permission';
      const permission = await auditWorkParentIdentityPermissions(db, 'public', 'shared-shop', {
        role: expectedRole, database: expectedDatabase,
      });
      stage = 'capacity';
      const capacity = permission.identityMatch === true
        ? await auditWorkParentCapacityStats(db, { role: expectedRole, database: expectedDatabase })
        : null;
      const identityMatch = permission.identityMatch === true;
      const result = {
        scope: 'work-parent-current-app' as const,
        identityMatch,
        ready: identityMatch && permission.ready === true
          && capacity?.identityMatch === true && capacity.catalogMatch === true,
        checks: permission.checks,
        failures: permission.failures,
        capacity,
      };
      stage = 'close';
      await db.$client.end({ timeout: 1 });
      db = undefined;
      return Response.json(result, { headers });
    } catch (error) {
      const category = sqlstateCategory(error);
      console.error(JSON.stringify({ event: 'work_parent_current_audit_failed', stage, category }));
      return Response.json({ error: 'audit failed', stage, category }, { status: 503, headers });
    } finally {
      if (db) {
        try { await db.$client.end({ timeout: 1 }); }
        catch { console.error(JSON.stringify({ event: 'work_parent_current_audit_close_failed' })); }
      }
    }
  },
} satisfies ExportedHandler<WorkParentCurrentAuditEnv>;
