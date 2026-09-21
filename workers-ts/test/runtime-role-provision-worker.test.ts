import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './integration/RuntimeRoleProvisionWorker';
import type { RuntimeRoleProvisionEnv } from './integration/runtime-role-provision-bindings';
const mocks = vi.hoisted(() => ({ create: vi.fn(), provision: vi.fn(), status: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.create }));
vi.mock('@/migrations/provisionRuntimeRoles', () => ({ provisionRuntimeRoles: mocks.provision, inspectUncommissionedRuntimeRoles: mocks.status,
  PRODUCTION_RUNTIME_ROLES: { app: 'cinashop_app_v1', admin: 'cinashop_admin_v1', pricingOwner: 'cinashop_pricing_owner_v1' } }));
const token = 'a'.repeat(64), credentials = { appPassword: 'b'.repeat(64), adminPassword: 'c'.repeat(64) };
const operation = 'provision-uncommissioned-runtime-roles-v1';
let env: RuntimeRoleProvisionEnv, logs: unknown[][];
const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
const req = (path = '/provision', method = 'POST', credential = token, body = JSON.stringify(credentials), op = operation) =>
  new Request('https://role.invalid' + path, { method, headers: { 'X-Audit-Token': credential,
    'X-Maintenance-Operation': op, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body } : {}) });
beforeEach(async () => {
  vi.resetAllMocks(); logs = []; vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args); });
  env = { HYPERDRIVE: { connectionString: 'postgresql://synthetic.invalid/test' } as Hyperdrive,
    AUDIT_TOKEN_SHA256: await digest(token), AUDIT_EXPIRES_AT: String(Date.now() + 600000), CREDENTIALS_BODY_SHA256: await digest(JSON.stringify(credentials)) };
  mocks.create.mockReturnValue({ $client: { end: mocks.end } }); mocks.end.mockResolvedValue(undefined);
  mocks.provision.mockResolvedValue({ created: true, commissioned: false, roles: [] }); mocks.status.mockResolvedValue({ roles: [], commissioned: false });
});
afterEach(() => vi.restoreAllMocks());
describe('runtime role provisioning HTTP boundary', () => {
  it.each(['', 'x'.repeat(64), 'd'.repeat(64)])('rejects invalid token before SQL', async token => {
    expect((await worker.fetch(req('/provision', 'POST', token), env)).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('requires valid expiry and deployment-pinned credential hash', async () => {
    for (const overrides of [{ AUDIT_EXPIRES_AT: '0' }, { AUDIT_EXPIRES_AT: String(Date.now() + 3600000) }, { CREDENTIALS_BODY_SHA256: '' }])
      expect((await worker.fetch(req(), { ...env, ...overrides })).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects path, query, method and missing explicit operation before connecting', async () => {
    expect((await worker.fetch(req('/provision?role=postgres'), env)).status).toBe(404);
    expect((await worker.fetch(req('/unknown'), env)).status).toBe(404);
    expect((await worker.fetch(req('/provision', 'GET'), env)).status).toBe(405);
    expect((await worker.fetch(req('/provision', 'POST', token, '{}', ''), env)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(['', '{', '{}', JSON.stringify({ ...credentials, appPassword: 'd'.repeat(64) })])('refuses invalid or unpinned body', async body => {
    expect((await worker.fetch(req('/provision', 'POST', token, body), env)).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([{ ...credentials, role: 'postgres' }, { ...credentials, appPassword: 'short' }, { ...credentials, adminPassword: credentials.appPassword }])('refuses even pinned malformed credential objects', async value => {
    const body = JSON.stringify(value); env.CREDENTIALS_BODY_SHA256 = await digest(body);
    expect((await worker.fetch(req('/provision', 'POST', token, body), env)).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('bounds the body before decoding and never reflects credentials', async () => {
    const response = await worker.fetch(req('/provision', 'POST', token, 'x'.repeat(513)), env);
    expect(response.status).toBe(413); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('preserves the bounded rejection when the caller stream refuses cancellation', async () => {
    const request = req();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(513)); },
      cancel() { throw Error(credentials.appPassword); },
    });
    Object.defineProperty(request, 'body', { value: stream });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled(); expect(logs).toEqual([]);
    expect(await response.text()).not.toContain(credentials.appPassword);
    expect(stream.locked).toBe(false);
  });
  it('rejects a failed caller stream without SQL or payload logging', async () => {
    const request = req();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(Error(credentials.adminPassword)); } });
    Object.defineProperty(request, 'body', { value: stream });
    expect((await worker.fetch(request, env)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled(); expect(logs).toEqual([]);
    expect(stream.locked).toBe(false);
  });
  it('performs one fixed operation and closes before success', async () => {
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.provision).toHaveBeenCalledExactlyOnceWith(mocks.create.mock.results[0].value,
      { expectedDatabase: 'postgres', expectedMaintenanceRole: 'postgres', names: { app: 'cinashop_app_v1', admin: 'cinashop_admin_v1', pricingOwner: 'cinashop_pricing_owner_v1' }, ...credentials });
    expect(mocks.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 }); expect(logs).toEqual([]);
    expect(await response.text()).not.toContain(credentials.appPassword);
  });
  it('keeps status read-only', async () => {
    expect((await worker.fetch(req('/status', 'GET'), env)).status).toBe(200);
    expect(mocks.status).toHaveBeenCalledOnce(); expect(mocks.provision).not.toHaveBeenCalled();
  });
  it.each(['create', 'provision', 'end'] as const)('sanitizes %s error without retry', async stage => {
    if (stage === 'create') mocks.create.mockImplementation(() => { throw Error(credentials.appPassword); });
    else mocks[stage].mockRejectedValue(Error(credentials.appPassword));
    const response = await worker.fetch(req(), env);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(credentials.appPassword);
    expect(JSON.stringify(logs)).not.toContain(credentials.appPassword); expect(mocks.provision.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
