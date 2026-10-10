import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from './integration/CustomerCityBindingFkCurrentAuditWorker';

const mocks = vi.hoisted(() => ({ create: vi.fn(), audit: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.create }));
vi.mock('@/migrations/auditCustomerCityBindingFkCurrent',
  () => ({ auditCustomerCityBindingFkCurrent: mocks.audit }));

const token = 'a'.repeat(64);
const request = (path = '/city-binding-fk', method = 'GET', credential = token) =>
  new Request(`https://audit.invalid${path}`, { method,
    headers: credential ? { 'X-Audit-Token': credential } : {} });
let env: { HYPERDRIVE: Hyperdrive; AUDIT_TOKEN_SHA256: string; AUDIT_EXPIRES_AT: string };
let errors: unknown[][];
const audit = { scope: 'city-binding-fk-metadata-only', identityMatch: true, catalogMatch: true,
  readyForIndexDecision: false, tables: {
    customer_city_delivery_attempt: { estimatedRows: '2', liveRowsEstimate: '2',
      modificationsSinceAnalyze: '0', heapBytes: '8192', indexBytes: '8192',
      totalBytes: '16384', lastAnalyzeMs: null, lastAutoanalyzeMs: null },
    customer_city_delivery_binding: { estimatedRows: '2', liveRowsEstimate: '2',
      modificationsSinceAnalyze: '0', heapBytes: '8192', indexBytes: '32768',
      totalBytes: '40960', lastAnalyzeMs: null, lastAutoanalyzeMs: null },
  }, foreignKey: { name: 'ccdbinding_attempt_fk', exact: true },
  indexes: { catalogSha256: 'b'.repeat(64), count: 4, leadingAny: 0,
    leadingUsableNonpartial: 0, leadingUsablePartial: 0, expression: 0 } };

beforeEach(async () => {
  vi.resetAllMocks();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  env = { HYPERDRIVE: { connectionString: 'postgresql://synthetic.invalid/never-connected' } as Hyperdrive,
    AUDIT_TOKEN_SHA256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    AUDIT_EXPIRES_AT: String(Date.now() + 590_000) };
  mocks.create.mockReturnValue({ $client: { end: mocks.end } });
  mocks.end.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(audit);
});
afterEach(() => vi.restoreAllMocks());

describe('fixed current-app city FK diagnostic Worker', () => {
  it('pins one app Hyperdrive and no formal route or other resource', () => {
    const config = JSON.parse(readFileSync('test/integration/customer-city-binding-fk-current-audit.wrangler.jsonc', 'utf8'));
    expect(config.main).toBe('CustomerCityBindingFkCurrentAuditWorker.ts');
    expect(config.hyperdrive).toEqual([{ binding: 'HYPERDRIVE', id: 'ba7faa6680cd48d4b3a1d36a7a5fc8f7' }]);
    expect(config.workers_dev).toBe(true);
    for (const absent of ['routes', 'queues', 'r2_buckets', 'durable_objects', 'services'])
      expect(config).not.toHaveProperty(absent);
  });

  it('rejects missing/wrong tokens, expiry, paths, query and all non-GET methods before DB', async () => {
    for (const credential of ['', 'b'.repeat(64), 'A'.repeat(64), 'a'.repeat(65)])
      expect((await worker.fetch(request('/city-binding-fk', 'GET', credential), env)).status).toBe(403);
    expect((await worker.fetch(request('/other'), env)).status).toBe(404);
    expect((await worker.fetch(request('/city-binding-fk?table=other'), env)).status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
      expect((await worker.fetch(request('/city-binding-fk', method), env)).status).toBe(405);
    env.AUDIT_EXPIRES_AT = String(Date.now() - 1);
    expect((await worker.fetch(request(), env)).status).toBe(403);
    env.AUDIT_EXPIRES_AT = String(Date.now() + 16 * 60_000);
    expect((await worker.fetch(request(), env)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('returns only fixed metadata and always keeps index decisions closed', async () => {
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ scope: 'city-binding-fk-current-app',
      ready: true, readyForIndexDecision: false, audit });
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(env.HYPERDRIVE.connectionString, 1,
      { searchPath: 'public,pg_temp', applicationName: 'cinashop_city_binding_fk_current_audit' });
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value,
      { role: 'cinashop_app_v1', database: 'postgres' });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it('fails closed on role or catalog mismatch without leaking backend identity', async () => {
    mocks.audit.mockResolvedValueOnce({ ...audit, identityMatch: false,
      catalogMatch: false, tables: null, foreignKey: null, indexes: null });
    let body = await (await worker.fetch(request(), env)).json();
    expect(body).toMatchObject({ ready: false, readyForIndexDecision: false,
      audit: { identityMatch: false, catalogMatch: false } });
    expect(JSON.stringify(body)).not.toContain('cinashop_app_v1');
    mocks.audit.mockResolvedValueOnce({ ...audit, catalogMatch: false,
      tables: null, foreignKey: null, indexes: null });
    body = await (await worker.fetch(request(), env)).json();
    expect(body).toMatchObject({ ready: false, audit: { identityMatch: true, catalogMatch: false } });
  });

  it.each(['create', 'audit', 'end'] as const)('redacts %s errors and closes a created client', async stage => {
    const secret = Error('private-connection-or-sql');
    if (stage === 'create') mocks.create.mockImplementation(() => { throw secret; });
    else mocks[stage].mockRejectedValue(secret);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'audit failed',
      stage: { create: 'connect', audit: 'catalog', end: 'close' }[stage], category: 'other' });
    expect(JSON.stringify(errors)).not.toContain(secret.message);
    expect(mocks.end).toHaveBeenCalledTimes(stage === 'create' ? 0 : stage === 'end' ? 2 : 1);
  });

  it('classifies SQLSTATE using fixed categories only', async () => {
    for (const [code, expected] of [['42501', 'permission'], ['55P03', 'lock'],
      ['57014', 'timeout'], ['08006', 'connection'], ['XX000', 'other']]) {
      mocks.audit.mockRejectedValueOnce(Object.assign(Error('never echo'), { code }));
      const response = await worker.fetch(request(), env);
      expect(await response.json()).toEqual({ error: 'audit failed', stage: 'catalog', category: expected });
    }
  });
});
