import { timingSafeEqual } from 'node:crypto';
import type { ManagerRoleProvisionEnv } from './manager-role-provision-bindings';
import { createDbFromConnectionString } from '@/lib/di';
import { inspectManagerProvisionState, provisionManagerRuntime, MANAGER_PROVISION_OPERATION, MANAGER_PROVISION_TARGET } from '@/migrations/provisionManagerRuntime';
import { auditManagerRuntimePrivileges } from '@/migrations/auditManagerRuntimePrivileges';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const matches = async (value: string, expected: string) => timingSafeEqual(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  Uint8Array.from(expected.match(/../g)!, byte => parseInt(byte, 16)));

/** Expiring fixed maintenance surface, never mounted in the application.
 * It installs no catalogs and never reaches provider or business operations. */
export default {
  async fetch(request: Request, env: ManagerRoleProvisionEnv): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '', expiry = Number(env.AUDIT_EXPIRES_AT), remaining = expiry - Date.now();
    if (!Number.isSafeInteger(expiry) || remaining <= 0 || remaining > 15 * 60_000
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256) || !/^[a-f0-9]{64}$/.test(token)
      || !/^[a-f0-9]{64}$/.test(env.CREDENTIALS_BODY_SHA256) || !await matches(token, env.AUDIT_TOKEN_SHA256))
      return Response.json({ error: 'forbidden' }, { status: 403, headers });
    const url = new URL(request.url);
    if (!['/provision', '/status', '/runtime', '/inspect', '/runtime-inspect'].includes(url.pathname) || url.search)
      return Response.json({ error: 'not found' }, { status: 404, headers });
    const method = ['/provision','/inspect','/runtime-inspect'].includes(url.pathname) ? 'POST' : 'GET';
    if (request.method !== method) return Response.json({ error: 'method not allowed' }, { status: 405, headers: { ...headers, Allow: method } });
    let managerPassword: string | undefined;
    if (url.pathname === '/inspect' || url.pathname === '/runtime-inspect') {
      const operation = url.pathname === '/inspect' ? 'inspect-manager-runtime-role-v1' : 'inspect-manager-runtime-login-v1';
      if (request.headers.get('X-Maintenance-Operation') !== operation) return Response.json({ error: 'explicit read-only inspection required' }, { status: 400, headers });
      if (request.body) {
        const reader = request.body.getReader();
        try { for (;;) { const next = await reader.read(); if (next.done) break; if (next.value.byteLength) return Response.json({ error: 'empty inspection body required' }, { status: 400, headers }); } }
        catch { return Response.json({ error: 'invalid inspection body' }, { status: 400, headers }); }
        finally { try { await reader.cancel(); } catch { /* Never log caller input. */ } reader.releaseLock(); }
      }
    }
    if (url.pathname === '/provision') {
      if (env.PROVISION_DISABLED !== 'false') return Response.json({ error: 'mutation disabled' }, { status: 403, headers });
      if (request.headers.get('X-Maintenance-Operation') !== MANAGER_PROVISION_OPERATION
        || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') ?? '') || !request.body)
        return Response.json({ error: 'explicit credential operation required' }, { status: 400, headers });
      const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let body = '', size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > 256) return Response.json({ error: 'bounded body required' }, { status: 413, headers });
          body += decoder.decode(next.value, { stream: true });
        }
        body += decoder.decode();
        if (!await matches(body, env.CREDENTIALS_BODY_SHA256)) throw Error('Unapproved body');
        const value: unknown = JSON.parse(body);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'managerPassword'
          || !('managerPassword' in value) || typeof value.managerPassword !== 'string' || !/^[a-f0-9]{64}$/.test(value.managerPassword))
          throw Error('Invalid fixed credential body');
        managerPassword = value.managerPassword;
      } catch { return Response.json({ error: 'invalid credential operation' }, { status: 400, headers }); }
      finally { try { await reader.cancel(); } catch { /* Never log caller input. */ } reader.releaseLock(); }
    }
    const runtime = url.pathname === '/runtime' || url.pathname === '/runtime-inspect', binding = runtime ? env.HYPERDRIVE_MANAGER : env.HYPERDRIVE;
    if (!binding?.connectionString?.trim() || runtime && (binding === env.HYPERDRIVE || binding.connectionString === env.HYPERDRIVE.connectionString))
      return Response.json({ error: 'independent Manager binding required' }, { status: 503, headers });
    let db: ReturnType<typeof createDbFromConnectionString> | undefined;
    try {
      db = createDbFromConnectionString(binding.connectionString, 1, { searchPath: 'public,pg_temp', applicationName: runtime ? 'cinashop_manager_login_audit' : 'cinashop_manager_provision' });
      const result = runtime ? await auditManagerRuntimePrivileges(db)
        : managerPassword ? await provisionManagerRuntime(db, managerPassword, MANAGER_PROVISION_TARGET)
          : await inspectManagerProvisionState(db, MANAGER_PROVISION_TARGET);
      await db.$client.end({ timeout: 1 }); db = undefined;
      return Response.json(result, { headers });
    } catch {
      // Even an ambiguous committed result/failed close gets a bounded reply.
      // No driver message, query, credential, nested cause, or automatic retry.
      console.error(JSON.stringify({ event: 'manager_runtime_provision_unconfirmed' }));
      return Response.json({ error: 'outcome not confirmed; inspect the fixed role and original attempt' }, { status: 503, headers });
    } finally {
      managerPassword = undefined;
      if (db) try { await db.$client.end({ timeout: 1 }); } catch { console.error(JSON.stringify({ event: 'manager_runtime_close_failed' })); }
    }
  },
} satisfies ExportedHandler<ManagerRoleProvisionEnv>;
