import { timingSafeEqual } from 'node:crypto';
import { createDbFromConnectionString } from '@/lib/di';
import {
  applyAdminAuthorityMaintenance, inspectAdminAuthorityMaintenance, inspectAdminAuthorityRuntimeLogin,
  adminAuthorityEvidenceSha256, adminAuthorityInstallSqlSha256, adminAuthorityPreflightEvidence,
  ADMIN_AUTHORITY_MAINTENANCE_OPERATION, AdminAuthorityPreflightMismatch,
  ADMIN_AUTHORITY_MAINTENANCE_TARGET_CATALOG,
  ADMIN_AUTHORITY_PRODUCTION_TARGET,
} from '@/migrations/adminAuthorityOperationMaintenance';

type Binding = { connectionString: string };
export interface AdminAuthorityMaintenanceEnv {
  HYPERDRIVE_MAINTENANCE: Binding;
  HYPERDRIVE: Binding;
  HYPERDRIVE_ADMIN: Binding;
  AUDIT_TOKEN_SHA256: string;
  AUDIT_EXPIRES_AT: string;
  SOURCE_SHA: string;
  EXPECTED_INSTALL_SQL_SHA256: string;
  RUN_MARKER: string;
  APPLY_ARMED: 'true' | 'false';
  APPROVED_PREFLIGHT_SHA256: string;
}

const target = ADMIN_AUTHORITY_PRODUCTION_TARGET;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;

export function approvedAdminAuthorityApply(armed: string, approved: string,
  supplied: string | null, fresh: string): boolean {
  return armed === 'true' && hex64.test(approved) && approved !== '0'.repeat(64)
    && approved === supplied && supplied === fresh;
}

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers });
}

async function useBinding<T>(binding: Binding, label: string,
  fn: (db: ReturnType<typeof createDbFromConnectionString>) => Promise<T>): Promise<T> {
  const db = createDbFromConnectionString(binding.connectionString, 1, {
    searchPath: 'public,pg_temp', applicationName: `cinashop_aao_${label}`,
  });
  try { return await fn(db); }
  finally { await db.$client.end({ timeout: 1 }); }
}

async function inspectBefore(env: AdminAuthorityMaintenanceEnv, sourceSha: string,
  installSqlSha256: string, postflight = false) {
  const maintenance = await useBinding(env.HYPERDRIVE_MAINTENANCE, 'preflight_owner',
    db => inspectAdminAuthorityMaintenance(db, target));
  const app = await useBinding(env.HYPERDRIVE, 'preflight_app',
    db => inspectAdminAuthorityRuntimeLogin(db, target, 'app'));
  const admin = await useBinding(env.HYPERDRIVE_ADMIN, 'preflight_admin',
    db => inspectAdminAuthorityRuntimeLogin(db, target, 'admin'));
  // The marker and execution mode differ across inspect/apply deployments.
  // Their omission makes the reviewed preflight fingerprint reusable while
  // each response still exposes its own mode and control-plane marker.
  const evidence = adminAuthorityPreflightEvidence(sourceSha, installSqlSha256, target, maintenance, app, admin);
  return { ...evidence,
    ready: maintenance.ready && app.ready && admin.ready && (!postflight || maintenance.addon === ADMIN_AUTHORITY_MAINTENANCE_TARGET_CATALOG),
    fingerprint: await adminAuthorityEvidenceSha256(evidence),
    runMarker: env.RUN_MARKER, applyArmed: env.APPLY_ARMED === 'true' };
}

// Body identity is not a byte count: an HTTP POST may expose an empty stream.
// Never aggregate a body or await cancellation; every rejected body stays before DB access.
async function emptyMaintenanceBody(request: Request): Promise<boolean> {
  if (request.signal.aborted || request.headers.has('transfer-encoding')) return false;
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && contentLength !== '0') return false;
  if (request.body === null) return true;
  if (contentLength !== '0') return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let ended = false;
  try {
    reader = request.body.getReader();
    const stopped = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), 250);
      abort = () => resolve(null);
      request.signal.addEventListener('abort', abort, { once: true });
    });
    // Bound pending reads and empty-chunk loops: at most 32 reads, including EOF.
    for (let emptyChunks = 0; emptyChunks < 32; emptyChunks++) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next === null) return false;
      if (next.done) { ended = true; return !request.signal.aborted; }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength !== 0) return false;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) request.signal.removeEventListener('abort', abort);
    if (reader) {
      try { if (!ended) void reader.cancel().catch(() => undefined); } catch { }
      try { reader.releaseLock(); } catch { }
    }
  }
}

/** Temporary, fixed-operation Worker only. It is never imported by the API.
 * A 503 after POST is an unknown transaction outcome, not a retry signal. */
export default {
  async fetch(request: Request, env: AdminAuthorityMaintenanceEnv): Promise<Response> {
    const token = request.headers.get('X-Audit-Token') ?? '';
    const expires = Number(env.AUDIT_EXPIRES_AT);
    const remaining = expires - Date.now();
    if (!Number.isSafeInteger(expires) || remaining <= 0 || remaining > 15 * 60_000
      || !hex64.test(token) || !hex64.test(env.AUDIT_TOKEN_SHA256)) return reply({ error: 'forbidden' }, 403);
    const actual = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    const expected = Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!, byte => parseInt(byte, 16));
    if (!timingSafeEqual(actual, expected)) return reply({ error: 'forbidden' }, 403);
    // InspectOnly denies every POST before path/config/body/DB work.
    if (request.method === 'POST' && env.APPLY_ARMED !== 'true') {
      return reply({ error: 'apply is not armed in this deployment' }, 403);
    }
    const url = new URL(request.url);
    if (!['/preflight', '/apply', '/postflight'].includes(url.pathname) || url.search) {
      return reply({ error: 'not found' }, 404);
    }
    const method = url.pathname === '/apply' ? 'POST' : 'GET';
    if (request.method !== method) return Response.json({ error: 'method not allowed' },
      { status: 405, headers: { ...headers, Allow: method } });
    // InspectOnly is a database read-only *and* server-side non-write mode.
    if (url.pathname === '/apply' && env.APPLY_ARMED !== 'true') {
      return reply({ error: 'apply is not armed in this deployment' }, 403);
    }
    if (method === 'POST' && (request.headers.get('X-Migration-Operation')
        !== ADMIN_AUTHORITY_MAINTENANCE_OPERATION || !(await emptyMaintenanceBody(request)))) {
      return reply({ error: 'explicit operation and empty body required' }, 400);
    }
    if (method === 'POST' && (!hex64.test(request.headers.get('X-Preflight-SHA256') ?? '')
        || request.headers.get('X-Preflight-SHA256') !== env.APPROVED_PREFLIGHT_SHA256)) {
      return reply({ error: 'approved preflight fingerprint required' }, 409);
    }
    if (!hex40.test(env.SOURCE_SHA) || !hex64.test(env.EXPECTED_INSTALL_SQL_SHA256)
      || !hex64.test(env.RUN_MARKER)
      || !['true', 'false'].includes(env.APPLY_ARMED)
      || !hex64.test(env.APPROVED_PREFLIGHT_SHA256)
      || (env.APPLY_ARMED === 'true'
        && env.APPROVED_PREFLIGHT_SHA256 === '0'.repeat(64))) {
      return reply({ error: 'fixed source or SQL digest missing' }, 503);
    }
    const installSqlSha256 = await adminAuthorityInstallSqlSha256();
    if (installSqlSha256 !== env.EXPECTED_INSTALL_SQL_SHA256) {
      return reply({ error: 'reviewed installation SQL digest mismatch' }, 503);
    }
    let stage = 'preflight';
    try {
      if (url.pathname === '/preflight') {
        return reply(await inspectBefore(env, env.SOURCE_SHA, installSqlSha256));
      }
      if (url.pathname === '/postflight') {
        stage = 'postflight';
        return reply(await inspectBefore(env, env.SOURCE_SHA, installSqlSha256, true));
      }
      const before = await inspectBefore(env, env.SOURCE_SHA, installSqlSha256);
      if (!before.ready || !approvedAdminAuthorityApply(env.APPLY_ARMED,
        env.APPROVED_PREFLIGHT_SHA256,
        request.headers.get('X-Preflight-SHA256'), before.fingerprint)) {
        return reply({ error: 'current preflight differs from the reviewed evidence' }, 409);
      }
      stage = 'single_apply';
      const result = await useBinding(env.HYPERDRIVE_MAINTENANCE, 'apply_owner',
        db => applyAdminAuthorityMaintenance(db, target, { sourceSha: env.SOURCE_SHA,
          installSqlSha256, fingerprint: before.fingerprint, app: before.app, admin: before.admin }));
      return reply({ ...result, sourceSha: env.SOURCE_SHA, installSqlSha256,
        runMarker: env.RUN_MARKER, approvedPreflightFingerprint: before.fingerprint });
    } catch (error) {
      if (error instanceof AdminAuthorityPreflightMismatch) {
        return reply({ error: 'current locked preflight differs from the reviewed evidence', stage }, 409);
      }
      let cause: unknown = error;
      let sqlState: string | null = null;
      for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
        if ('code' in cause && typeof cause.code === 'string' && /^[0-9A-Z]{5}$/.test(cause.code)) {
          sqlState = cause.code; break;
        }
        if (!('cause' in cause) || cause.cause === cause) break;
        cause = cause.cause;
      }
      console.error(JSON.stringify({ event: 'admin_authority_maintenance_unconfirmed', stage, sqlState }));
      return reply({ error: 'outcome unconfirmed; inspect read-only before any further action',
        outcome: method === 'POST' ? 'unknown' : 'inspection_failed', stage, sqlState }, 503);
    }
  },
} satisfies ExportedHandler<AdminAuthorityMaintenanceEnv>;
