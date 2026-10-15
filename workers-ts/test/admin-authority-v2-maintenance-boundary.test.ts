import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbFromConnectionString } from '../src/lib/di';
import { applyAdminAuthorityV2Maintenance, inspectAdminAuthorityV2Maintenance, inspectAdminAuthorityRuntimeLogin,
  adminAuthorityV2InstallSqlSha256, adminAuthorityInstallSqlSha256, ADMIN_AUTHORITY_MAINTENANCE_OPERATION,
  adminAuthorityV2PreflightEvidence, adminLegacyRolePreflightEvidence, adminAuthorityEvidenceSha256,
  ADMIN_AUTHORITY_V2_MAINTENANCE_SQL, ADMIN_AUTHORITY_PRODUCTION_TARGET, ADMIN_AUTHORITY_V2_MAINTENANCE_OPERATION, AdminAuthorityPreflightMismatch } from '../src/migrations/adminAuthorityOperationMaintenance';
import worker, { approvedAdminAuthorityV2Apply, type AdminAuthorityV2MaintenanceEnv } from './integration/AdminAuthorityV2MaintenanceWorker';

vi.mock('@/lib/di', () => ({ createDbFromConnectionString: vi.fn(() => ({ $client: { end: vi.fn(async () => {}) } })) }));
vi.mock('@/migrations/adminAuthorityOperationMaintenance', async importOriginal => ({
  ...await importOriginal<typeof import('../src/migrations/adminAuthorityOperationMaintenance')>(),
  inspectAdminAuthorityV2Maintenance: vi.fn(), inspectAdminAuthorityRuntimeLogin: vi.fn(), applyAdminAuthorityV2Maintenance: vi.fn(),
}));
const token = 'a'.repeat(64), base = 'https://temporary.example.workers.dev';
const maintenance = { ready: true, addon: 'absent', menuLock: true,
  identity: { database: 'postgres', role: 'postgres', session: 'postgres', backend: 'postgres', primary: true, originSha256: '3'.repeat(64) },
  profiles: {}, snapshot: { tableCount: 284, dataSha256: 'e'.repeat(64), data: [], catalog: { objects: 2000, sha256: 'f'.repeat(64) } } };
const profile = (kind: 'app' | 'admin') => ({ ready: true, readOnly: true, completeServiceCoverageVerified: false,
  identity: { database: 'postgres', role: `cinashop_${kind}_v1`, session: `cinashop_${kind}_v1`,
    backend: `cinashop_${kind}_v1`, supported: true, primary: true, originSha256: '3'.repeat(64) },
  kind, failures: [], tableCount: 284, sequenceCount: 90 });
async function env(): Promise<AdminAuthorityV2MaintenanceEnv> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return { HYPERDRIVE_MAINTENANCE: { connectionString: 'owner-test' }, HYPERDRIVE: { connectionString: 'app-test' },
    HYPERDRIVE_ADMIN: { connectionString: 'admin-test' }, AUDIT_TOKEN_SHA256: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''),
    AUDIT_EXPIRES_AT: String(Date.now() + 600_000), SOURCE_SHA: 'b'.repeat(40), EXPECTED_INSTALL_SQL_SHA256: await adminAuthorityV2InstallSqlSha256(),
    RUN_MARKER: 'd'.repeat(64), APPLY_ARMED: 'false', APPROVED_PREFLIGHT_SHA256: '0'.repeat(64) };
}
function request(path: string, method = 'GET', headers: Record<string, string> = {}, body?: BodyInit, signal?: AbortSignal) {
  return new Request(base + path, { method, headers: { 'X-Audit-Token': token, ...headers }, ...(body === undefined ? {} : { body, duplex: 'half' }), signal } as RequestInit);
}
async function arm(bindings: AdminAuthorityV2MaintenanceEnv) {
  const response = await worker.fetch(request('/preflight'), bindings);
  const result = await response.json() as { fingerprint: string };
  bindings.APPLY_ARMED = 'true'; bindings.APPROVED_PREFLIGHT_SHA256 = result.fingerprint;
  vi.clearAllMocks();
  return { 'X-Migration-Operation': ADMIN_AUTHORITY_V2_MAINTENANCE_OPERATION, 'X-Preflight-SHA256': result.fingerprint };
}
beforeEach(() => {
  vi.mocked(inspectAdminAuthorityV2Maintenance).mockResolvedValue(maintenance as never);
  vi.mocked(inspectAdminAuthorityRuntimeLogin).mockImplementation(async (_db, _target, kind) => profile(kind) as never);
  vi.mocked(applyAdminAuthorityV2Maintenance).mockResolvedValue({ committed: true, atomicBusinessDataProof: false } as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('temporary authority commissioning HTTP guard', () => {
  it('requires constant-time hash-token authority and a <=15 minute future expiry before DB', async () => {
    const bindings = await env();
    for (const header of ['', 'x', 'A'.repeat(64), '9'.repeat(64)]) expect((await worker.fetch(request('/preflight', 'GET', { 'X-Audit-Token': header }), bindings)).status).toBe(403);
    for (const expiry of ['not-a-time', String(Date.now() - 1), String(Date.now() + 901_000)]) {
      bindings.AUDIT_EXPIRES_AT = expiry; expect((await worker.fetch(request('/preflight'), bindings)).status).toBe(403);
    }
    expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('InspectOnly rejects every POST before body, path or DB work', async () => {
    const bindings = await env(), pull = vi.fn();
    for (const path of ['/apply', '/preflight', '/unknown']) {
      const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
      expect((await worker.fetch(request(path, 'POST', {}, body), bindings)).status).toBe(403);
      expect(body.locked).toBe(false);
    }
    expect(pull).not.toHaveBeenCalled(); expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('rejects URL query/other paths and wrong verbs, with no-store and Allow', async () => {
    const bindings = await env();
    for (const path of ['/other', '/preflight?target=other', '/apply/']) expect((await worker.fetch(request(path), bindings)).status).toBe(404);
    const response = await worker.fetch(request('/apply', 'GET'), bindings);
    expect(response.status).toBe(405); expect(response.headers.get('Allow')).toBe('POST');
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('rejects missing pins/config/SQL digest and unapproved fingerprint before DB', async () => {
    for (const [key, value] of [['SOURCE_SHA', ''], ['RUN_MARKER', 'BAD'], ['EXPECTED_INSTALL_SQL_SHA256', 'c'.repeat(64)], ['APPROVED_PREFLIGHT_SHA256', '']] as const) {
      const bindings = await env(); bindings[key] = value;
      expect((await worker.fetch(request('/preflight'), bindings)).status).toBe(503);
    }
    const bindings = await env(); bindings.APPLY_ARMED = 'true'; bindings.APPROVED_PREFLIGHT_SHA256 = 'e'.repeat(64);
    expect((await worker.fetch(request('/apply', 'POST', { 'X-Migration-Operation': ADMIN_AUTHORITY_V2_MAINTENANCE_OPERATION }), bindings)).status).toBe(409);
    expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('uses compiled target and three actual binding identities, never a body-supplied target', async () => {
    const bindings = await env(), headers = await arm(bindings);
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(200);
    expect(createDbFromConnectionString).toHaveBeenCalledTimes(4);
    expect(vi.mocked(createDbFromConnectionString).mock.calls.map(call => call[0])).toEqual(['owner-test', 'app-test', 'admin-test', 'owner-test']);
    const target = { database: 'postgres', maintenance: 'postgres', app: 'cinashop_app_v1', admin: 'cinashop_admin_v1' };
    expect(inspectAdminAuthorityV2Maintenance).toHaveBeenCalledWith(expect.anything(), target);
    expect(inspectAdminAuthorityRuntimeLogin).toHaveBeenNthCalledWith(1, expect.anything(), target, 'app');
    expect(inspectAdminAuthorityRuntimeLogin).toHaveBeenNthCalledWith(2, expect.anything(), target, 'admin');
    expect(applyAdminAuthorityV2Maintenance).toHaveBeenCalledExactlyOnceWith(expect.anything(), target, expect.objectContaining({ fingerprint: headers['X-Preflight-SHA256'], app: profile('app'), admin: profile('admin') }));
    for (const result of vi.mocked(createDbFromConnectionString).mock.results) expect(result.value.$client.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    vi.clearAllMocks();
    expect((await worker.fetch(request('/apply', 'POST', { ...headers, 'Content-Length': '0' }, JSON.stringify({ target: 'other' })), bindings)).status).toBe(400);
    expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('fresh data/source/profile evidence drift safely rejects before apply', async () => {
    const bindings = await env(), headers = await arm(bindings);
    vi.mocked(inspectAdminAuthorityV2Maintenance).mockResolvedValue({ ...maintenance, snapshot: { ...maintenance.snapshot, dataSha256: '0'.repeat(64) } } as never);
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
    expect(applyAdminAuthorityV2Maintenance).not.toHaveBeenCalled();
    vi.mocked(inspectAdminAuthorityV2Maintenance).mockResolvedValue(maintenance as never);
    bindings.SOURCE_SHA = '1'.repeat(40);
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
    expect(applyAdminAuthorityV2Maintenance).not.toHaveBeenCalled();
    vi.mocked(inspectAdminAuthorityRuntimeLogin).mockResolvedValue({ ...profile('app'), ready: false } as never);
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
  });
  it('run marker and arming do not invalidate the evidence fingerprint', async () => {
    const bindings = await env(), response = await worker.fetch(request('/preflight'), bindings), before = await response.json() as { fingerprint: string };
    bindings.RUN_MARKER = '1'.repeat(64); bindings.APPLY_ARMED = 'true'; bindings.APPROVED_PREFLIGHT_SHA256 = before.fingerprint;
    const after = await (await worker.fetch(request('/preflight'), bindings)).json() as { fingerprint: string; runMarker: string };
    expect(after.fingerprint).toBe(before.fingerprint); expect(after.runMarker).toBe(bindings.RUN_MARKER);
  });
  it('postflight requires exact v2 in addition to three independent ready profiles', async () => {
    const bindings = await env();
    expect(await (await worker.fetch(request('/postflight'), bindings)).json()).toMatchObject({ ready: false });
    vi.mocked(inspectAdminAuthorityV2Maintenance).mockResolvedValue({ ...maintenance, addon: 'legacy-admin-v2' } as never);
    expect(await (await worker.fetch(request('/postflight'), bindings)).json()).toMatchObject({ ready: true });
    expect(applyAdminAuthorityV2Maintenance).not.toHaveBeenCalled();
  });
  it('refuses replicas or mismatched physical primary evidence from any runtime connection', async () => {
    const bindings = await env(), headers = await arm(bindings);
    for (const changed of [{ primary: false }, { originSha256: '4'.repeat(64) }]) {
      vi.mocked(inspectAdminAuthorityRuntimeLogin).mockImplementation(async (_db, _target, kind) => ({
        ...profile(kind), identity: { ...profile(kind).identity, ...(kind === 'admin' ? changed : {}) },
      }) as never);
      expect(await (await worker.fetch(request('/preflight'), bindings)).json()).toMatchObject({ ready: false });
      expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
    }
    expect(applyAdminAuthorityV2Maintenance).not.toHaveBeenCalled();
  });
  it('locked fingerprint refusal is 409; unknown POST never retries and redacts causes', async () => {
    const bindings = await env(), headers = await arm(bindings);
    vi.mocked(applyAdminAuthorityV2Maintenance).mockRejectedValueOnce(new AdminAuthorityPreflightMismatch());
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(409);
    vi.clearAllMocks();
    vi.mocked(applyAdminAuthorityV2Maintenance).mockRejectedValueOnce({ message: 'postgres://password-secret SELECT private', cause: { code: '57014', query: 'private SQL' } });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(request('/apply', 'POST', headers), bindings), text = await response.text();
    expect(response.status).toBe(503); expect(JSON.parse(text)).toMatchObject({ outcome: 'unknown', stage: 'single_apply', sqlState: '57014' });
    expect(text).not.toMatch(/password-secret|private SQL|postgres:\/\//); expect(JSON.stringify(log.mock.calls)).not.toMatch(/password-secret|private SQL/);
    expect(applyAdminAuthorityV2Maintenance).toHaveBeenCalledOnce(); expect(createDbFromConnectionString).toHaveBeenCalledTimes(4);
  });
  it('pure approved guard requires armed, nonzero exact supplied and fresh hash', () => {
    const hash = 'a'.repeat(64);
    expect(approvedAdminAuthorityV2Apply('true', hash, hash, hash)).toBe(true);
    const rejected: [string, string, string | null, string][] = [['false', hash, hash, hash], ['true', '0'.repeat(64), '0'.repeat(64), '0'.repeat(64)], ['true', hash, null, hash], ['true', hash, hash, 'b'.repeat(64)]];
    for (const args of rejected) expect(approvedAdminAuthorityV2Apply(...args)).toBe(false);
  });
});

describe('authority empty POST stream is bounded before DB', () => {
  it('accepts only omitted body or exact zero framing with EOF/zero-byte chunks', async () => {
    const bindings = await env(), headers = await arm(bindings);
    for (const body of [undefined, '', new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), new ReadableStream<Uint8Array>({ start(c) { for (let i=0;i<31;i++) c.enqueue(new Uint8Array()); c.close(); } })]) {
      expect((await worker.fetch(request('/apply', 'POST', { ...headers, 'Content-Length': '0' }, body), bindings)).status).toBe(200);
    }
    expect(applyAdminAuthorityV2Maintenance).toHaveBeenCalledTimes(4);
  });
  it('rejects misleading framing without consuming a stream', async () => {
    const bindings = await env(), headers = await arm(bindings), pull = vi.fn();
    const framing: Record<string, string>[] = [{}, { 'Content-Length': '00' }, { 'Content-Length': '1' }, { 'Content-Length': '0', 'Transfer-Encoding': 'chunked' }];
    for (const extra of framing) {
      expect((await worker.fetch(request('/apply', 'POST', { ...headers, ...extra }, new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 })), bindings)).status).toBe(400);
    }
    expect(pull).not.toHaveBeenCalled(); expect(createDbFromConnectionString).not.toHaveBeenCalled();
  });
  it('rejects bytes after empty chunks, >31 chunks, locked/error/stalled/aborted streams', async () => {
    const bindings = await env(), headers = { ...await arm(bindings), 'Content-Length': '0' }, cancelled = vi.fn();
    const streams = [new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array()); c.enqueue(new Uint8Array([1])); }, cancel: cancelled }),
      new ReadableStream<Uint8Array>({ start(c) { for(let i=0;i<32;i++)c.enqueue(new Uint8Array()); c.close(); } }),
      new ReadableStream<Uint8Array>({ start(c) { c.error(Error('private body sentinel')); } }), new ReadableStream<Uint8Array>({ cancel: cancelled })];
    for(const body of streams) { expect((await worker.fetch(request('/apply', 'POST', headers, body), bindings)).status).toBe(400); expect(body.locked).toBe(false); }
    const locked = request('/apply', 'POST', headers, ''), reader = locked.body!.getReader();
    try { expect((await worker.fetch(locked, bindings)).status).toBe(400); } finally { reader.releaseLock(); }
    const abort = new AbortController(); abort.abort();
    expect((await worker.fetch(request('/apply', 'POST', headers, undefined, abort.signal), bindings)).status).toBe(400);
    const during = new AbortController(), pending = worker.fetch(request('/apply', 'POST', headers, new ReadableStream<Uint8Array>({ cancel: cancelled }), during.signal), bindings);
    setTimeout(() => during.abort(), 20); expect((await pending).status).toBe(400);
    expect(cancelled).toHaveBeenCalledTimes(3); expect(createDbFromConnectionString).not.toHaveBeenCalled();
  }, 2_000);
});


describe('fixed v2 runner phase scope', () => {
  it('uses a distinct SQL bundle and rejects combined operation and SQL approval before DB', async () => {
    const bindings = await env(), headers = await arm(bindings);
    const sqlHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(ADMIN_AUTHORITY_V2_MAINTENANCE_SQL))), b => b.toString(16).padStart(2, '0')).join('');
    expect(bindings.EXPECTED_INSTALL_SQL_SHA256).toBe(sqlHash);
    expect((await worker.fetch(request('/apply', 'POST', { ...headers,
      'X-Migration-Operation': ADMIN_AUTHORITY_MAINTENANCE_OPERATION }), bindings)).status).toBe(400);
    bindings.EXPECTED_INSTALL_SQL_SHA256 = await adminAuthorityInstallSqlSha256();
    expect((await worker.fetch(request('/apply', 'POST', headers), bindings)).status).toBe(503);
    expect(createDbFromConnectionString).not.toHaveBeenCalled();
    expect(applyAdminAuthorityV2Maintenance).not.toHaveBeenCalled();
  });
  it('binds its own operation and target catalog and refuses a standalone v3 fingerprint', async () => {
    const bindings = await env(), headers = await arm(bindings);
    const args = [bindings.SOURCE_SHA, bindings.EXPECTED_INSTALL_SQL_SHA256, ADMIN_AUTHORITY_PRODUCTION_TARGET,
      maintenance as never, profile('app') as never, profile('admin') as never] as const;
    expect(adminAuthorityV2PreflightEvidence(...args)).toMatchObject({
      operation: ADMIN_AUTHORITY_V2_MAINTENANCE_OPERATION, targetCatalog: 'legacy-admin-v2',
    });
    const other = await adminAuthorityEvidenceSha256(adminLegacyRolePreflightEvidence(...args));
    expect(other).not.toBe(headers['X-Preflight-SHA256']);
    bindings.APPROVED_PREFLIGHT_SHA256 = other;
    expect((await worker.fetch(request('/apply', 'POST', { ...headers, 'X-Preflight-SHA256': other }), bindings)).status).toBe(409);
    expect(applyAdminAuthorityV2Maintenance).not.toHaveBeenCalled();
  });
});
