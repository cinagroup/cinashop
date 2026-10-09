import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from './integration/WorkParentCurrentAuditWorker';

const mocks = vi.hoisted(() => ({ create: vi.fn(), audit: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.create }));
vi.mock('@/migrations/auditWorkParentIdentityPermissions', () => ({ auditWorkParentIdentityPermissions: mocks.audit }));

const token = 'a'.repeat(64); // Synthetic test token, never deployed.
const request = (path = '/work-parents', method = 'GET', credential = token) =>
  new Request(`https://audit.invalid${path}`, { method,
    headers: credential ? { 'X-Audit-Token': credential } : {} });
let env: { HYPERDRIVE: Hyperdrive; AUDIT_TOKEN_SHA256: string; AUDIT_EXPIRES_AT: string };
let errors: unknown[][];

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
  });

  it('requests exact backend identity and shared-shop permissions in one audit transaction', async () => {
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ scope: 'work-parent-current-app', identityMatch: true,
      ready: true, checks: { noReferencedKeyUpdate: true }, failures: [] });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value,
      'public', 'shared-shop', { role: 'cinashop_app_v1', database: 'postgres' });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    expect(errors).toHaveLength(0);
  });

  it('fails closed for the wrong LOGIN and does not expose any identity string', async () => {
    mocks.audit.mockResolvedValueOnce({ scope: 'work-parent-identity-only', identityMatch: false,
      ready: false, checks: null, failures: ['connectionIdentityMismatch'] });
    const response = await worker.fetch(request(), env);
    const body = await response.json();
    expect(body).toEqual({ scope: 'work-parent-current-app', identityMatch: false,
      ready: false, checks: null, failures: ['connectionIdentityMismatch'] });
    expect(JSON.stringify(body)).not.toContain('cinashop_app_v1');
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it('fails closed for identity mismatch even if a faulty audit reports ready', async () => {
    mocks.audit.mockResolvedValueOnce({ scope: 'work-parent-identity-only', identityMatch: false,
      ready: true, checks: { noReferencedKeyUpdate: true }, failures: [] });
    const response = await worker.fetch(request(), env);
    expect(await response.json()).toMatchObject({ identityMatch: false, ready: false });
    expect(mocks.audit).toHaveBeenCalledOnce();
  });

  it.each(['create', 'audit', 'end'] as const)('redacts %s failure and closes any created client', async stage => {
    const secret = Error('private connection and SQL');
    if (stage === 'create') mocks.create.mockImplementation(() => { throw secret; });
    else mocks[stage].mockRejectedValue(secret);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'audit failed' });
    expect(JSON.stringify(errors)).not.toContain(secret.message);
    if (stage !== 'create') expect(mocks.end).toHaveBeenCalled();
  });
});
