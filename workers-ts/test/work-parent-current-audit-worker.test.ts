import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from './integration/WorkParentCurrentAuditWorker';

const mocks = vi.hoisted(() => ({ create: vi.fn(), audit: vi.fn(), capacity: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.create }));
vi.mock('@/migrations/auditWorkParentIdentityPermissions', () => ({ auditWorkParentIdentityPermissions: mocks.audit }));
vi.mock('@/migrations/auditWorkParentCapacityStats', () => ({ auditWorkParentCapacityStats: mocks.capacity }));

const token = 'a'.repeat(64); // Synthetic test token, never deployed.
const request = (path = '/work-parents', method = 'GET', credential = token) =>
  new Request(`https://audit.invalid${path}`, { method,
    headers: credential ? { 'X-Audit-Token': credential } : {} });
let env: { HYPERDRIVE: Hyperdrive; AUDIT_TOKEN_SHA256: string; AUDIT_EXPIRES_AT: string };
let errors: unknown[][];
const capacity = { scope: 'work-parent-capacity-metadata-only', identityMatch: true,
  catalogMatch: true, tables: {
    work_client_current: { estimatedRows: '10', liveRowsEstimate: '10', modificationsSinceAnalyze: '0',
      heapBytes: '8192', indexBytes: '8192', totalBytes: '16384', lastAnalyzeMs: null, lastAutoanalyzeMs: null },
    work_callback_event: { estimatedRows: '20', liveRowsEstimate: '20', modificationsSinceAnalyze: '0',
      heapBytes: '8192', indexBytes: '8192', totalBytes: '16384', lastAnalyzeMs: null, lastAutoanalyzeMs: null },
    work_contact_action_outbox: { estimatedRows: '30', liveRowsEstimate: '30', modificationsSinceAnalyze: '0',
      heapBytes: '8192', indexBytes: '8192', totalBytes: '16384', lastAnalyzeMs: null, lastAutoanalyzeMs: null },
  }, index: { name: 'wcao_client_ref', exact: true, estimatedRows: '30', bytes: '8192' },
  statisticsTargets: { corp_id: { configured: -1, effective: 100 },
    client_id: { configured: -1, effective: 100 } } };

beforeEach(async () => {
  vi.resetAllMocks();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  env = {
    HYPERDRIVE: { connectionString: 'postgresql://synthetic.invalid/never-connected' } as Hyperdrive,
    AUDIT_TOKEN_SHA256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    AUDIT_EXPIRES_AT: String(Date.now() + 590_000),
  };
  mocks.create.mockReturnValue({ $client: { end: mocks.end } });
  mocks.end.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue({ scope: 'work-parent-identity-only', identityMatch: true, ready: true,
    checks: { noReferencedKeyUpdate: true }, failures: [] });
  mocks.capacity.mockResolvedValue(capacity);
});
afterEach(() => vi.restoreAllMocks());

describe('current app work-parent diagnostic Worker', () => {
  it('pins one current-app binding and exposes no other route or resource', () => {
    const config = JSON.parse(readFileSync('test/integration/work-parent-current-audit.wrangler.jsonc', 'utf8'));
    expect(config.main).toBe('WorkParentCurrentAuditWorker.ts');
    expect(config.hyperdrive).toEqual([{ binding: 'HYPERDRIVE', id: 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' }]);
    expect(config.workers_dev).toBe(true);
    for (const absent of ['routes', 'queues', 'r2_buckets', 'durable_objects', 'services'])
      expect(config).not.toHaveProperty(absent);
  });

  it('denies missing, malformed, expired and wrong tokens, paths, methods and queries before creating a client', async () => {
    for (const credential of ['', 'b'.repeat(64), 'A'.repeat(64), 'a'.repeat(65)])
      expect((await worker.fetch(request('/work-parents', 'GET', credential), env)).status).toBe(403);
    expect((await worker.fetch(request('/other'), env)).status).toBe(404);
    expect((await worker.fetch(request('/work-parents?scope=admin'), env)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
      expect((await worker.fetch(request('/work-parents', method), env)).status).toBe(405);
    env.AUDIT_EXPIRES_AT = String(Date.now() - 1);
    expect((await worker.fetch(request(), env)).status).toBe(403);
    env.AUDIT_EXPIRES_AT = String(Date.now() + 16 * 60_000);
    expect((await worker.fetch(request(), env)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.capacity).not.toHaveBeenCalled();
  });

  it('requests exact backend identity and shared-shop permissions in one audit transaction', async () => {
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ scope: 'work-parent-current-app', identityMatch: true,
      ready: true, checks: { noReferencedKeyUpdate: true }, failures: [], capacity });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value,
      'public', 'shared-shop', { role: 'cinashop_app_v1', database: 'postgres' });
    expect(mocks.capacity).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value,
      { role: 'cinashop_app_v1', database: 'postgres' });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    expect(errors).toHaveLength(0);
  });

  it('fails closed for the wrong LOGIN and does not expose any identity string', async () => {
    mocks.audit.mockResolvedValueOnce({ scope: 'work-parent-identity-only', identityMatch: false,
      ready: false, checks: null, failures: ['connectionIdentityMismatch'] });
    const response = await worker.fetch(request(), env);
    const body = await response.json();
    expect(body).toEqual({ scope: 'work-parent-current-app', identityMatch: false,
      ready: false, checks: null, failures: ['connectionIdentityMismatch'], capacity: null });
    expect(JSON.stringify(body)).not.toContain('cinashop_app_v1');
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.capacity).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it('fails closed for identity mismatch even if a faulty audit reports ready', async () => {
    mocks.audit.mockResolvedValueOnce({ scope: 'work-parent-identity-only', identityMatch: false,
      ready: true, checks: { noReferencedKeyUpdate: true }, failures: [] });
    const response = await worker.fetch(request(), env);
    expect(await response.json()).toMatchObject({ identityMatch: false, ready: false });
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.capacity).not.toHaveBeenCalled();
  });

  it('fails closed if the capacity transaction has another backend or catalog drift', async () => {
    mocks.capacity.mockResolvedValueOnce({ ...capacity, identityMatch: false,
      catalogMatch: false, tables: null, index: null, statisticsTargets: null });
    expect(await (await worker.fetch(request(), env)).json()).toMatchObject({ ready: false,
      capacity: { identityMatch: false, catalogMatch: false } });
    mocks.capacity.mockResolvedValueOnce({ ...capacity, catalogMatch: false,
      tables: null, index: null, statisticsTargets: null });
    expect(await (await worker.fetch(request(), env)).json()).toMatchObject({ ready: false,
      capacity: { identityMatch: true, catalogMatch: false } });
  });

  it.each(['create', 'audit', 'capacity', 'end'] as const)('redacts %s failure and closes any created client', async stage => {
    const secret = Error('private connection and SQL');
    if (stage === 'create') mocks.create.mockImplementation(() => { throw secret; });
    else mocks[stage].mockRejectedValue(secret);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    const expectedStage = { create: 'connect', audit: 'permission', capacity: 'capacity', end: 'close' }[stage];
    expect(await response.json()).toEqual({ error: 'audit failed', stage: expectedStage, category: 'other' });
    expect(JSON.stringify(errors)).not.toContain(secret.message);
    expect(errors).toEqual([
      [JSON.stringify({ event: 'work_parent_current_audit_failed',
        stage: expectedStage, category: 'other' })],
      ...(stage === 'end' ? [[JSON.stringify({ event: 'work_parent_current_audit_close_failed' })]] : []),
    ]);
    if (stage !== 'create') expect(mocks.end).toHaveBeenCalled();
  });

  it.each([
    ['42501', 'permission'], ['55P03', 'lock'], ['57014', 'timeout'],
    ['08006', 'connection'], ['42P01', 'other'], ['private-connection-or-sql', 'other'],
  ] as const)('classifies only fixed SQLSTATE category for %s', async (code, category) => {
    mocks.capacity.mockRejectedValueOnce(Object.assign(Error('private connection and SQL'), { code }));
    const response = await worker.fetch(request(), env);
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'audit failed', stage: 'capacity', category });
    expect(JSON.stringify([body, errors])).not.toMatch(/private connection|private-connection-or-sql/);
  });
});
