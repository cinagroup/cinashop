import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './integration/ManagerRoleProvisionWorker';
import type { ManagerRoleProvisionEnv } from './integration/manager-role-provision-bindings';
const mocks = vi.hoisted(() => ({ create: vi.fn(), provision: vi.fn(), status: vi.fn(), runtime: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.create }));
vi.mock('@/migrations/provisionManagerRuntime', () => ({ provisionManagerRuntime: mocks.provision, inspectManagerProvisionState: mocks.status,
  MANAGER_PROVISION_OPERATION: 'provision-manager-runtime-v1', MANAGER_PROVISION_TARGET: { database: 'postgres', maintenanceRole: 'postgres' } }));
vi.mock('@/migrations/auditManagerRuntimePrivileges', () => ({ auditManagerRuntimePrivileges: mocks.runtime }));
const token = 'a'.repeat(64), managerPassword = 'b'.repeat(64), body = JSON.stringify({ managerPassword });
const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const request = (path = '/provision', method = 'POST', input = body, auth = token, operation = 'provision-manager-runtime-v1') =>
  new Request('https://manager-provision.invalid' + path, { method, headers: { 'X-Audit-Token': auth, 'X-Maintenance-Operation': operation, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: input } : {}) });
let env: ManagerRoleProvisionEnv, logs: unknown[][];
beforeEach(async () => {
  vi.resetAllMocks(); logs = []; vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args); });
  env = { HYPERDRIVE: { connectionString: 'postgresql://synthetic-maintenance.invalid/test' } as Hyperdrive,
    HYPERDRIVE_MANAGER: { connectionString: 'postgresql://synthetic-manager.invalid/test' } as Hyperdrive,
    AUDIT_TOKEN_SHA256: await digest(token), AUDIT_EXPIRES_AT: String(Date.now() + 600000), CREDENTIALS_BODY_SHA256: await digest(body), PROVISION_DISABLED: 'false' };
  mocks.create.mockReturnValue({ $client: { end: mocks.end } }); mocks.end.mockResolvedValue(undefined);
  mocks.provision.mockResolvedValue({ created: true, commissioned: true, role: { name: 'cinashop_manager_v1' } });
  mocks.status.mockResolvedValue({ ready: false, role: null }); mocks.runtime.mockResolvedValue({ ready: true });
});
afterEach(() => vi.restoreAllMocks());
describe('fixed Manager provisioning HTTP boundary', () => {
  it.each(['', 'x'.repeat(64), 'c'.repeat(64)])('rejects invalid authentication before SQL', async auth => {
    expect((await worker.fetch(request('/provision', 'POST', body, auth), env)).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([{ AUDIT_EXPIRES_AT: '0' }, { AUDIT_EXPIRES_AT: String(Date.now() + 3600000) }, { CREDENTIALS_BODY_SHA256: '' }])('requires bounded expiry and a pinned credential operation', async changes => {
    expect((await worker.fetch(request(), { ...env, ...changes })).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('defaults read-only and cannot enable mutation through the request', async () => {
    for (const disabled of ['true', '', '0']) expect((await worker.fetch(request(), { ...env, PROVISION_DISABLED: disabled })).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('refuses role/query selection, unsupported paths/methods and missing explicit operation', async () => {
    expect((await worker.fetch(request('/provision?role=postgres'), env)).status).toBe(404);
    expect((await worker.fetch(request('/other'), env)).status).toBe(404);
    expect((await worker.fetch(request('/provision', 'GET'), env)).status).toBe(405);
    expect((await worker.fetch(request('/provision', 'POST', body, token, ''), env)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['', '{', '{}', JSON.stringify({ managerPassword: 'c'.repeat(64) })])('refuses malformed or unpinned bodies', async input => {
    expect((await worker.fetch(request('/provision', 'POST', input), env)).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([{ managerPassword, role: 'postgres' }, { managerPassword: 'short' }, { managerPassword: "';RESET ROLE;--" }])('refuses even deployment-pinned caller-selected fields or credentials', async value => {
    const input = JSON.stringify(value); env.CREDENTIALS_BODY_SHA256 = await digest(input);
    expect((await worker.fetch(request('/provision', 'POST', input), env)).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('bounds transport bytes and cancels without leaking a throwing caller stream', async () => {
    const req = request(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(257)); }, cancel() { throw Error(managerPassword); } });
    Object.defineProperty(req, 'body', { value: stream });
    const reply = await worker.fetch(req, env);
    expect(reply.status).toBe(413); expect(await reply.text()).not.toContain(managerPassword);
    expect(stream.locked).toBe(false); expect(logs).toEqual([]); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('executes exactly one fixed operation and closes before success', async () => {
    const reply = await worker.fetch(request(), env);
    expect(reply.status).toBe(200); expect(reply.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.provision).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value, managerPassword, { database: 'postgres', maintenanceRole: 'postgres' });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 }); expect(await reply.text()).not.toContain(managerPassword);
  });
  it('accepts the PowerShell UTF-8 JSON media type while refusing other charsets or additional parameters', async () => {
    const valid = request(); valid.headers.set('Content-Type', 'application/json; charset=utf-8');
    expect((await worker.fetch(valid, env)).status).toBe(200); expect(mocks.provision).toHaveBeenCalledOnce();
    mocks.create.mockClear(); mocks.provision.mockClear();
    for (const value of ['application/json; charset=utf-16', 'application/json; charset=iso-8859-1', 'application/json; boundary=x', 'text/plain']) {
      const invalid = request(); invalid.headers.set('Content-Type', value);
      expect((await worker.fetch(invalid, env)).status).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.provision).not.toHaveBeenCalled();
  });
  it('keeps status read-only and verifies the actual independent Manager binding', async () => {
    expect((await worker.fetch(request('/status', 'GET'), env)).status).toBe(200);
    expect(mocks.status).toHaveBeenCalledOnce(); expect(mocks.provision).not.toHaveBeenCalled();
    expect((await worker.fetch(request('/runtime', 'GET'), env)).status).toBe(200);
    expect(mocks.create.mock.calls[1][0]).toBe(env.HYPERDRIVE_MANAGER!.connectionString); expect(mocks.runtime).toHaveBeenCalledOnce();
  });
  it('never borrows maintenance credentials for an absent or reused Manager binding', async () => {
    for (const binding of [undefined, env.HYPERDRIVE, { connectionString: env.HYPERDRIVE.connectionString } as Hyperdrive])
      expect((await worker.fetch(request('/runtime', 'GET'), { ...env, HYPERDRIVE_MANAGER: binding })).status).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('accepts only fixed empty-body readonly POST role and independent LOGIN inspections while provisioning is disabled', async () => {
    const inspect = request('/inspect', 'POST', '', token, 'inspect-manager-runtime-role-v1');
    expect((await worker.fetch(inspect, { ...env, PROVISION_DISABLED: 'true' })).status).toBe(200); expect(mocks.status).toHaveBeenCalledOnce(); expect(mocks.provision).not.toHaveBeenCalled();
    const runtime = request('/runtime-inspect', 'POST', '', token, 'inspect-manager-runtime-login-v1');
    expect((await worker.fetch(runtime, { ...env, PROVISION_DISABLED: 'true' })).status).toBe(200); expect(mocks.runtime).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[1][0]).toBe(env.HYPERDRIVE_MANAGER!.connectionString);
    for (const path of ['/inspect','/runtime-inspect']) {
      expect((await worker.fetch(request(path, 'GET'), env)).status).toBe(405);
      expect((await worker.fetch(request(path, 'POST', '{}', token, path === '/inspect' ? 'inspect-manager-runtime-role-v1' : 'inspect-manager-runtime-login-v1'), env)).status).toBe(400);
      expect((await worker.fetch(request(path, 'POST', ''), env)).status).toBe(400);
    }
    expect(mocks.provision).not.toHaveBeenCalled();
  });
  it.each(['create', 'provision', 'end'] as const)('sanitizes %s ambiguity without retry or reflecting driver credentials', async stage => {
    const failure = Object.assign(Error(managerPassword), { cause: { query: 'PASSWORD ' + managerPassword, parameters: [managerPassword] } });
    if (stage === 'create') mocks.create.mockImplementation(() => { throw failure; }); else mocks[stage].mockRejectedValue(failure);
    const reply = await worker.fetch(request(), env);
    expect(reply.status).toBe(503); expect(await reply.text()).not.toContain(managerPassword); expect(JSON.stringify(logs)).not.toContain(managerPassword);
    expect(mocks.provision.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
