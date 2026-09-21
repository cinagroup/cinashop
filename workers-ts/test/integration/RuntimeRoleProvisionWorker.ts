import { timingSafeEqual } from 'node:crypto';
import type { RuntimeRoleProvisionEnv } from './runtime-role-provision-bindings';
import { createDbFromConnectionString } from '@/lib/di';
import { inspectUncommissionedRuntimeRoles, provisionRuntimeRoles, PRODUCTION_RUNTIME_ROLES } from '@/migrations/provisionRuntimeRoles';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const matches = async (value: string, expected: string) => timingSafeEqual(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  Uint8Array.from(expected.match(/../g)!, byte => parseInt(byte, 16)));

/** One-shot expiring maintenance only. Never mounted by the application. Fixed
 * production database and three names, no SQL/role/identity selection by callers.
 * This provisions zero-business-privilege roles; it cannot switch Hyperdrive. */
export default {
  async fetch(request: Request, env: RuntimeRoleProvisionEnv): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '', remaining = Number(env.AUDIT_EXPIRES_AT) - Date.now();
    if (!Number.isSafeInteger(Number(env.AUDIT_EXPIRES_AT)) || remaining <= 0 || remaining > 15 * 60_000
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256) || !/^[a-f0-9]{64}$/.test(token)
      || !/^[a-f0-9]{64}$/.test(env.CREDENTIALS_BODY_SHA256) || !await matches(token, env.AUDIT_TOKEN_SHA256))
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    const url = new URL(request.url);
    if (!['/provision', '/status'].includes(url.pathname) || url.search)
      return Response.json({ error: 'not found' }, { status: 404, headers });
    const method = url.pathname === '/provision' ? 'POST' : 'GET';
    if (request.method !== method) return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...headers, Allow: method } });
    let credentials: { appPassword: string; adminPassword: string } | undefined;
    if (url.pathname === '/provision') {
      if (request.headers.get('X-Maintenance-Operation') !== 'provision-uncommissioned-runtime-roles-v1'
        || request.headers.get('Content-Type') !== 'application/json' || !request.body)
        return Response.json({ error: 'explicit credential operation required' }, { status: 400, headers });
      const reader = request.body.getReader(); let body = '', size = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 512) return Response.json({ error: 'bounded body required' }, { status: 413, headers });
          body += decoder.decode(next.value, { stream: true });
        }
        body += decoder.decode();
        if (!await matches(body, env.CREDENTIALS_BODY_SHA256)) throw Error('unapproved credentials');
        const value: unknown = JSON.parse(body);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'adminPassword,appPassword'
          || !('appPassword' in value) || !('adminPassword' in value)
          || typeof value.appPassword !== 'string' || typeof value.adminPassword !== 'string'
          || !/^[a-f0-9]{64}$/.test(value.appPassword) || !/^[a-f0-9]{64}$/.test(value.adminPassword)
          || value.appPassword === value.adminPassword) throw Error('invalid credentials');
        credentials = { appPassword: value.appPassword, adminPassword: value.adminPassword };
      } catch { return Response.json({ error: 'invalid credential operation' }, { status: 400, headers }); }
      finally {
        // A broken caller stream must not replace our bounded 400/413 response
        // with an uncaught platform error (or reach SQL).
        try { await reader.cancel(); } catch { /* no caller payload logging */ }
        reader.releaseLock();
      }
    }
    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    try {
      db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, { searchPath: 'public,pg_temp', applicationName: 'cinashop_role_provision' });
      const result = credentials ? await provisionRuntimeRoles(db, {
        expectedDatabase: 'postgres', expectedMaintenanceRole: 'postgres', names: PRODUCTION_RUNTIME_ROLES, ...credentials,
      }) : await inspectUncommissionedRuntimeRoles(db);
      await db.$client.end({ timeout: 1 }); db = undefined;
      return Response.json(result, { headers });
    } catch (error) {
      // Only SQLSTATE, never the driver message/query/parameters or credential
      // body. Provisioning deliberately strips its driver cause before here.
      let cause: unknown = error, sqlState: string | null = null;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && typeof cause.code === 'string' && /^[0-9A-Z]{5}$/.test(cause.code)) { sqlState = cause.code; break; }
        if (!('cause' in cause) || cause.cause === cause) break;
        cause = cause.cause;
      }
      console.error(JSON.stringify({ event: 'runtime_role_provision_unconfirmed', sqlState }));
      return Response.json({ error: 'outcome not confirmed; inspect fixed roles before further action', sqlState }, { status: 503, headers });
    } finally {
      if (db) try { await db.$client.end({ timeout: 1 }); }
      catch { console.error(JSON.stringify({ event: 'runtime_role_provision_close_failed' })); }
    }
  },
} satisfies ExportedHandler<RuntimeRoleProvisionEnv>;
