import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbFromConnectionString } from '../src/lib/di';
import {
  applyAdminLegacyRoleMaintenance, inspectAdminLegacyRoleMaintenance, inspectAdminAuthorityRuntimeLogin,
  adminLegacyRoleInstallSqlSha256, ADMIN_LEGACY_ROLE_MAINTENANCE_OPERATION,
  AdminAuthorityPreflightMismatch,
} from '../src/migrations/adminAuthorityOperationMaintenance';
import worker, { approvedAdminLegacyRoleApply, type AdminLegacyRoleMaintenanceEnv } from './integration/AdminLegacyRoleMaintenanceWorker';

vi.mock('@/lib/di', () => ({ createDbFromConnectionString: vi.fn(() => ({ $client: { end: vi.fn(async () => {}) } })) }));
vi.mock('@/migrations/adminAuthorityOperationMaintenance', async importOriginal => ({
  ...await importOriginal<typeof import('../src/migrations/adminAuthorityOperationMaintenance')>(),
  inspectAdminLegacyRoleMaintenance: vi.fn(), inspectAdminAuthorityRuntimeLogin: vi.fn(), applyAdminLegacyRoleMaintenance: vi.fn(),
}));
const token = 'a'.repeat(64), base = 'https://temporary.example.workers.dev';
const maintenance = { ready: true, addon: 'legacy-admin-v2', menuLock: true,
  identity: { database: 'postgres', role: 'postgres', session: 'postgres', backend: 'postgres', primary: true, originSha256: '3'.repeat(64) },
  profiles: {}, snapshot: { tableCount: 284, dataSha256: 'e'.repeat(64), data: [], catalog: { objects: 2000, sha256: 'f'.repeat(64) } } };
const profile = (kind: 'app' | 'admin') => ({ ready: true, readOnly: true, completeServiceCoverageVerified: false,
  identity: { database: 'postgres', role: `cinashop_${kind}_v1`, session: `cinashop_${kind}_v1`,
    backend: `cinashop_${kind}_v1`, supported: true, primary: true, originSha256: '3'.repeat(64) },
  kind, failures: [], tableCount: 284, sequenceCount: 90 });
async function env(): Promise<AdminLegacyRoleMaintenanceEnv> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return { HYPERDRIVE_MAINTENANCE: { connectionString: 'owner-test' }, HYPERDRIVE: { connectionString: 'app-test' },
    HYPERDRIVE_ADMIN: { connectionString: 'admin-test' }, AUDIT_TOKEN_SHA256: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''),
    AUDIT_EXPIRES_AT: String(Date.now() + 600_000), SOURCE_SHA: 'b'.repeat(40), EXPECTED_INSTALL_SQL_SHA256: await adminLegacyRoleInstallSqlSha256(),
    RUN_MARKER: 'd'.repeat(64), APPLY_ARMED: 'false', APPROVED_PREFLIGHT_SHA256: '0'.repeat(64) };
}
function request(path: string, method = 'GET', headers: Record<string, string> = {}, body?: BodyInit) {
  return new Request(base + path, { method, headers: { 'X-Audit-Token': token, ...headers }, ...(body === undefined ? {} : { body, duplex: 'half' }) } as RequestInit);
}
async function arm(bindings: AdminLegacyRoleMaintenanceEnv) {
  const response = await worker.fetch(request('/preflight'), bindings);
  const result = await response.json() as { fingerprint: string };
  bindings.APPLY_ARMED = 'true'; bindings.APPROVED_PREFLIGHT_SHA256 = result.fingerprint;
  vi.clearAllMocks();
  return { 'X-Migration-Operation': ADMIN_LEGACY_ROLE_MAINTENANCE_OPERATION, 'X-Preflight-SHA256': result.fingerprint };
}
beforeEach(() => {
  vi.mocked(inspectAdminLegacyRoleMaintenance).mockResolvedValue(maintenance as never);
  vi.mocked(inspectAdminAuthorityRuntimeLogin).mockImplementation(async (_db, _target, kind) => profile(kind) as never);
  vi.mocked(applyAdminLegacyRoleMaintenance).mockResolvedValue({ committed: true, v3: { applied: true } } as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('temporary v3 maintenance HTTP guard', () => {
  it('rejects unauthenticated, expired, query, wrong operation and unarmed apply before DB', async () => {
    const bindings = await env();
    expect((await worker.fetch(request('/preflight', 'GET', { 'X-Audit-Token': '9'.repeat(64) }), bindings)).status).toBe(403);
    bindings.AUDIT_EXPIRES_AT = String(Date.now() - 1);
    expect((await worker.fetch(request('/preflight'), bindings)).status).toBe(403);
    bindings.AUDIT_EXPIRES_AT = String(Date.now() + 600_000);
    expect((await worker.fetch(request('/apply', 'POST'), bindings)).status).toBe(403);
    expect((await worker.fetch(request('/preflight?target=other'), bindings)).status).toBe(404);
    expect((await worker.fetch(request('/apply', 'POST', { 'X-Migration-Operation': 'admin-authority-install-v1-and-legacy-v2' }), bindings)).status).toBe(403);
    expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('pins the distinct v3 SQL digest and requires fresh v2 profile evidence', async () => {
    const bindings = await env();
    expect(await adminLegacyRoleInstallSqlSha256()).toMatch(/^[0-9a-f]{64}$/);
    bindings.EXPECTED_INSTALL_SQL_SHA256 = 'c'.repeat(64);
    expect((await worker.fetch(request('/preflight'), bindings)).status).toBe(503);
    expect(createDbFromConnectionString).not.toHaveBeenCalled();
    bindings.EXPECTED_INSTALL_SQL_SHA256 = await adminLegacyRoleInstallSqlSha256();
    vi.mocked(inspectAdminLegacyRoleMaintenance).mockResolvedValue({ ...maintenance, ready: false, addon: 'v1' } as never);
    expect(await (await worker.fetch(request('/preflight'), bindings)).json()).toMatchObject({ ready: false });
    expect(await (await worker.fetch(request('/postflight'), bindings)).json()).toMatchObject({ ready: false });
    vi.mocked(inspectAdminLegacyRoleMaintenance).mockResolvedValue({ ...maintenance, addon: 'legacy-role-v3' } as never);
    expect(await (await worker.fetch(request('/postflight'), bindings)).json()).toMatchObject({ ready: true });
  });
  it('uses fixed three connections and invokes exactly one approved v3 apply', async () => {
    const bindings = await env(), headers = await arm(bindings);
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(200);
    expect(vi.mocked(createDbFromConnectionString).mock.calls.map(call => call[0])).toEqual(['owner-test', 'app-test', 'admin-test', 'owner-test']);
    expect(applyAdminLegacyRoleMaintenance).toHaveBeenCalledExactlyOnceWith(expect.anything(),
      { database: 'postgres', maintenance: 'postgres', app: 'cinashop_app_v1', admin: 'cinashop_admin_v1' },
      expect.objectContaining({ fingerprint: headers['X-Preflight-SHA256'] }));
    for (const result of vi.mocked(createDbFromConnectionString).mock.results) expect(result.value.$client.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    vi.clearAllMocks();
    expect((await worker.fetch(request('/apply', 'POST', { ...headers, 'Content-Length': '0' }, '{"target":"other"}'), bindings)).status).toBe(400);
    expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('refuses stale evidence and reports unknown POST outcome without secret or retry', async () => {
    const bindings = await env(), headers = await arm(bindings);
    vi.mocked(inspectAdminLegacyRoleMaintenance).mockResolvedValue({ ...maintenance, snapshot: { ...maintenance.snapshot, dataSha256: '0'.repeat(64) } } as never);
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
    expect(applyAdminLegacyRoleMaintenance).not.toHaveBeenCalled();
    vi.mocked(inspectAdminLegacyRoleMaintenance).mockResolvedValue(maintenance as never);
    vi.mocked(applyAdminLegacyRoleMaintenance).mockRejectedValueOnce(new AdminAuthorityPreflightMismatch());
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(applyAdminLegacyRoleMaintenance).mockRejectedValueOnce({ message: 'postgres://password-secret SELECT private', cause: { code: '57014', query: 'private SQL' } });
    const response = await worker.fetch(request('/apply', 'POST', headers), bindings), body = await response.text();
    expect(response.status).toBe(503); expect(JSON.parse(body)).toMatchObject({ outcome: 'unknown', stage: 'single_apply', sqlState: '57014' });
    expect(body).not.toMatch(/password-secret|private SQL|postgres:\/\//); expect(JSON.stringify(log.mock.calls)).not.toMatch(/password-secret|private SQL/);
    expect(applyAdminLegacyRoleMaintenance).toHaveBeenCalledTimes(2);
  });
  it('requires a nonzero exact approval hash', () => {
    const hash = 'a'.repeat(64);
    expect(approvedAdminLegacyRoleApply('true', hash, hash, hash)).toBe(true);
    expect(approvedAdminLegacyRoleApply('false', hash, hash, hash)).toBe(false);
    expect(approvedAdminLegacyRoleApply('true', hash, hash, 'b'.repeat(64))).toBe(false);
    expect(approvedAdminLegacyRoleApply('true', '0'.repeat(64), '0'.repeat(64), '0'.repeat(64))).toBe(false);
  });
  it('refuses recovery and different physical-primary hashes even if each profile says ready', async () => {
    const bindings = await env(), headers = await arm(bindings);
    for (const changed of [{ primary: false }, { originSha256: '4'.repeat(64) }]) {
      vi.mocked(inspectAdminAuthorityRuntimeLogin).mockImplementation(async (_db, _target, kind) => ({
        ...profile(kind), identity: { ...profile(kind).identity, ...(kind === 'app' ? changed : {}) },
      }) as never);
      expect(await (await worker.fetch(request('/preflight'), bindings)).json()).toMatchObject({ ready: false });
      expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
    }
    expect(applyAdminLegacyRoleMaintenance).not.toHaveBeenCalled();
  });
});
