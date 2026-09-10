import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from './integration/PaidRuntimeAuditWorker';
import type { PaidRuntimeAuditEnv } from './integration/paid-runtime-audit-bindings';

const mocks = vi.hoisted(() => ({ create: vi.fn(), audit: vi.fn(), catalog: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.create }));
vi.mock('@/migrations/auditPaidOrderRuntimePermissions', () => ({ auditPaidOrderRuntimePermissions: mocks.audit }));
vi.mock('@/migrations/auditReleasePrerequisiteCatalog', () => ({ auditReleasePrerequisiteCatalog: mocks.catalog }));

const token = 'a'.repeat(64); // synthetic token, not a deployed credential
let env: PaidRuntimeAuditEnv;
let logCalls: unknown[][];
const request = (path = '/audit', method = 'GET', credential = token) => new Request(`https://audit.invalid${path}`, {
  method, headers: credential ? { 'X-Audit-Token': credential } : {},
});

beforeEach(async () => {
  vi.resetAllMocks();
  logCalls = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logCalls.push(args); });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  env = {
    HYPERDRIVE: { connectionString: 'postgresql://synthetic.invalid/test' } as Hyperdrive,
    AUDIT_TOKEN_SHA256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    AUDIT_EXPIRES_AT: String(Date.now() + 600_000),
  };
  mocks.create.mockReturnValue({ $client: { end: mocks.end } });
  mocks.end.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue({ ready: false, checks: { objectsPresent: false }, failures: ['objectsPresent'] });
  mocks.catalog.mockResolvedValue({ schemaPresent: true });
});
afterEach(() => vi.restoreAllMocks());

describe('temporary production runtime permission audit', () => {
  it('serves the fixed catalog separately without interpreting it as readiness', async () => {
    const response = await worker.fetch(request('/catalog'), env);
    expect(await response.json()).toEqual({ scope: 'release-prerequisite-catalog', catalog: { schemaPresent: true } });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.catalog).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });
  it('denies anonymous, mutating or parameterized catalog requests before SQL', async () => {
    expect((await worker.fetch(request('/catalog', 'GET', ''), env)).status).toBe(403);
    expect((await worker.fetch(request('/catalog', 'POST'), env)).status).toBe(405);
    expect((await worker.fetch(request('/catalog?schema=private'), env)).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('redacts catalog failures and closes the client', async () => {
    mocks.catalog.mockRejectedValue(new Error('private catalog context'));
    const response = await worker.fetch(request('/catalog'), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'audit failed' });
    expect(logCalls).toContainEqual([JSON.stringify({ event: 'paid_runtime_audit_failed' })]);
    expect(JSON.stringify(logCalls)).not.toContain('private catalog context');
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });
  it.each(['', 'b'.repeat(64), 'a'.repeat(65), 'A'.repeat(64)])('denies invalid token %s before connecting', async credential => {
    const response = await worker.fetch(request('/audit', 'GET', credential), env);
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['', 'invalid', '0', 'NaN'])('denies invalid expiry %s', async expiry => {
    env.AUDIT_EXPIRES_AT = expiry;
    expect((await worker.fetch(request(), env)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects expired or excessively long-lived verifier and an unset hash', async () => {
    for (const expiry of [Date.now() - 1, Date.now() + 3_600_000]) {
      env.AUDIT_EXPIRES_AT = String(expiry);
      expect((await worker.fetch(request(), env)).status).toBe(403);
    }
    env.AUDIT_EXPIRES_AT = String(Date.now() + 600_000);
    env.AUDIT_TOKEN_SHA256 = '';
    expect((await worker.fetch(request(), env)).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['/other', '/audit?schema=other'])('rejects other routes and query input %s', async path => {
    expect((await worker.fetch(request(path), env)).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'])('denies %s before connecting', async method => {
    const response = await worker.fetch(request('/audit', method), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('returns permission failures truthfully and closes its single client', async () => {
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ scope: 'paid-order-runtime-permissions', ready: false,
      checks: { objectsPresent: false }, failures: ['objectsPresent'] });
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(env.HYPERDRIVE.connectionString, 1, {
      searchPath: 'public,pg_temp', applicationName: 'cinashop_paid_runtime_audit',
    });
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value);
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });
  it.each(['create', 'audit', 'end'] as const)('redacts %s errors, including close failure', async stage => {
    const secretError = new Error('private host or business detail must not escape');
    if (stage === 'create') mocks.create.mockImplementation(() => { throw secretError; });
    else mocks[stage].mockRejectedValue(secretError);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'audit failed' });
    // workerd may wrap console methods, so observe the installed implementation
    // instead of assuming the next console.error getter exposes Vitest metadata.
    expect(logCalls).toContainEqual([JSON.stringify({ event: 'paid_runtime_audit_failed' })]);
    if (stage === 'end') expect(logCalls).toContainEqual([JSON.stringify({ event: 'paid_runtime_audit_close_failed' })]);
    expect(JSON.stringify(logCalls)).not.toContain(secretError.message);
    if (stage !== 'create') expect(mocks.end).toHaveBeenCalledWith({ timeout: 1 });
  });
});
