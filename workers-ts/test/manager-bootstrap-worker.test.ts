import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './integration/ManagerBootstrapWorker';
import type { ManagerBootstrapEnv } from './integration/manager-bootstrap-bindings';
const mocks = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn(), install: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.create }));
vi.mock('@/migrations/managerRuntimeBootstrap', () => ({ inspectManagerRuntimeBootstrap: mocks.inspect, installManagerRuntimeBootstrap: mocks.install,
  MANAGER_BOOTSTRAP_OPERATION: 'manager-ledger-scope-bootstrap-v1', MANAGER_BOOTSTRAP_TARGET: { database: 'postgres', maintenanceRole: 'postgres' } }));
const token = 'a'.repeat(64), operation = 'manager-ledger-scope-bootstrap-v1';
const request = (path = '/install', method = 'POST', auth = token, body = '') => new Request('https://manager-bootstrap.invalid' + path,
  { method, headers: { 'X-Audit-Token': auth, 'X-Migration-Operation': operation }, ...(method === 'POST' ? { body } : {}) });
let env: ManagerBootstrapEnv, logs: unknown[][];
beforeEach(async () => {
  vi.resetAllMocks(); logs = []; vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args); });
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, '0')).join('');
  env = { HYPERDRIVE: { connectionString: 'postgresql://synthetic-maintenance.invalid/test' } as Hyperdrive,
    AUDIT_TOKEN_SHA256: hash, AUDIT_EXPIRES_AT: String(Date.now() + 600000), BOOTSTRAP_ENABLED: 'true' };
  mocks.create.mockReturnValue({ $client: { end: mocks.end } }); mocks.end.mockResolvedValue(undefined);
  mocks.inspect.mockResolvedValue({ state: 'fresh', ready: false }); mocks.install.mockResolvedValue({ applied: true, state: { ready: true } });
});
afterEach(() => vi.restoreAllMocks());
describe('fixed Manager core bootstrap maintenance HTTP boundary', () => {
  it.each(['', 'x'.repeat(64), 'b'.repeat(64)])('rejects invalid tokens before SQL', async auth => {
    expect((await worker.fetch(request('/install', 'POST', auth), env)).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['0', String(Date.now() + 3600000), 'invalid'])('requires a bounded deployment expiry', async expiry => {
    expect((await worker.fetch(request(), { ...env, AUDIT_EXPIRES_AT: expiry })).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('defaults to read-only and rejects caller-selected operations or payloads', async () => {
    for (const enabled of ['', 'false', '1']) expect((await worker.fetch(request(), { ...env, BOOTSTRAP_ENABLED: enabled })).status).toBe(403);
    const missing = request(); missing.headers.delete('X-Migration-Operation'); expect((await worker.fetch(missing, env)).status).toBe(400);
    for (const payload of ['{}', 'SELECT 1', ' ', '{"role":"postgres"}']) expect((await worker.fetch(request('/install', 'POST', token, payload), env)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('refuses paths, queries and methods that could select a different target', async () => {
    expect((await worker.fetch(request('/install?schema=other'), env)).status).toBe(404);
    expect((await worker.fetch(request('/other'), env)).status).toBe(404);
    expect((await worker.fetch(request('/install', 'GET'), env)).status).toBe(405);
    expect((await worker.fetch(request('/status', 'POST'), env)).status).toBe(405); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('executes only the pinned operation, closes before success and keeps status read-only', async () => {
    expect((await worker.fetch(request(), env)).status).toBe(200);
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value, { database: 'postgres', maintenanceRole: 'postgres' });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
    const result = await worker.fetch(request('/status', 'GET'), { ...env, BOOTSTRAP_ENABLED: 'false' });
    expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('no-store'); expect(mocks.inspect).toHaveBeenCalledOnce(); expect(mocks.install).toHaveBeenCalledOnce();
  });
  it('cancels a throwing body stream without reading a database or reflecting caller content', async () => {
    const req = request(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('private')); }, cancel() { throw Error('private'); } });
    Object.defineProperty(req, 'body', { value: stream }); const result = await worker.fetch(req, env);
    expect(result.status).toBe(400); expect(await result.text()).not.toContain('private'); expect(stream.locked).toBe(false); expect(mocks.create).not.toHaveBeenCalled(); expect(logs).toEqual([]);
  });
  it('supports fixed empty-body POST inspection while mutation is disabled and refuses payload or operation changes', async () => {
    const readonly = request('/inspect'); readonly.headers.set('X-Migration-Operation', 'manager-ledger-scope-inspect-v1');
    expect((await worker.fetch(readonly, { ...env, BOOTSTRAP_ENABLED: 'false' })).status).toBe(200);
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value, { database: 'postgres', maintenanceRole: 'postgres' }); expect(mocks.install).not.toHaveBeenCalled();
    expect((await worker.fetch(request('/inspect'), env)).status).toBe(400);
    const payload = request('/inspect', 'POST', token, '{}'); payload.headers.set('X-Migration-Operation', 'manager-ledger-scope-inspect-v1');
    expect((await worker.fetch(payload, env)).status).toBe(400);
    expect((await worker.fetch(request('/inspect', 'GET'), env)).status).toBe(405);
  });
  it.each(['create', 'install', 'end'] as const)('reports %s ambiguity without retrying or exposing driver SQL', async stage => {
    const error = Object.assign(Error('private'), { cause: { query: 'secret driver SQL' } });
    if (stage === 'create') mocks.create.mockImplementation(() => { throw error; }); else mocks[stage].mockRejectedValue(error);
    const result = await worker.fetch(request(), env); expect(result.status).toBe(503); expect(await result.text()).not.toContain('private');
    expect(JSON.stringify(logs)).not.toContain('secret'); expect(mocks.install.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
