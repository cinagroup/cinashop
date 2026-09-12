// The two maintenance configs intentionally share identical generated bindings;
// their vars/hyperdrive equality is tested. This is never the main API entrypoint.
import type { PaidRuntimeAuditEnv } from './paid-runtime-audit-bindings';
import { timingSafeEqual } from 'node:crypto';
import { createDbFromConnectionString } from '@/lib/di';
import { inspectTestReleaseCoreSchemaUpgrade, runTestReleaseCoreSchemaUpgrade } from '@/migrations/runTestReleaseCoreSchemaUpgrade';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const operation = '0146-0149-0151-test-release-core-schema';
export default {
  async fetch(request: Request, env: PaidRuntimeAuditEnv): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '';
    const expiry = Number(env.AUDIT_EXPIRES_AT);
    const remaining = expiry - Date.now();
    if (!Number.isSafeInteger(expiry) || remaining <= 0 || remaining > 15 * 60_000
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256) || !/^[a-f0-9]{64}$/.test(token)) {
      return Response.json({ error:'forbidden' }, { status:403,headers });
    }
    const actual = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const expected = Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!, byte => parseInt(byte,16));
    if (!timingSafeEqual(new Uint8Array(actual),expected)) return Response.json({ error:'forbidden' }, { status:403,headers });
    const url = new URL(request.url);
    if (!['/migrate/test-release-core','/preflight/test-release-core'].includes(url.pathname) || url.search) return Response.json({ error:'not found' }, { status:404,headers });
    const inspecting = url.pathname === '/preflight/test-release-core';
    const method = inspecting ? 'GET' : 'POST';
    if (request.method !== method) return Response.json({ error:'method not allowed' }, { status:405,headers:{ ...headers,Allow:method } });
    if (!inspecting && request.headers.get('X-Migration-Operation') !== operation) {
      return Response.json({ error:'explicit operation required' }, { status:400,headers });
    }
    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    try {
      db = createDbFromConnectionString(env.HYPERDRIVE.connectionString,1,{ applicationName:'cinashop_test_release_core_schema_upgrade' });
      const result = inspecting ? await inspectTestReleaseCoreSchemaUpgrade(db) : await runTestReleaseCoreSchemaUpgrade(db);
      await db.$client.end({ timeout:1 });
      db = undefined;
      return Response.json(result,{ headers });
    } catch {
      // A network/close error may occur after COMMIT. Return UNKNOWN, not a false
      // rollback claim; operator must inspect catalog before deciding on retry.
      console.error(JSON.stringify({ event:'test_release_core_schema_upgrade_unconfirmed' }));
      return Response.json({ error:'migration outcome unconfirmed; inspect catalog before retry' },{ status:503,headers });
    } finally {
      if (db) {
        try { await db.$client.end({ timeout:1 }); }
        catch { console.error(JSON.stringify({ event:'test_release_core_schema_upgrade_close_failed' })); }
      }
    }
  },
} satisfies ExportedHandler<PaidRuntimeAuditEnv>;
