import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { adminRuntimeAuthMiddleware } from '@/middleware/admin-runtime-auth';
import { systemAdmin, systemRole, systemMenus } from '@/models/schema';
import { createToken, md5, type TokenType } from '@/utils/jwt';
import { errorHandler } from '@/middleware/error';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createAdminDatabaseSession: wiring.open }));

describe('Admin runtime connection selection after complete authorization', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, application: Container, admin: Container;
  const close = vi.fn(async () => {}), handler = vi.fn();
  const env = { APP_KEY: 'local-runtime-boundary-signing-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' };
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => { c.set('container', application); await next();
    expect(c.get('container')).toBe(application); expect(c.get('applicationContainer')).toBeUndefined(); });
  app.get('/adminapi/home/header', adminRuntimeAuthMiddleware(), c => {
    handler(); expect(c.get('container')).toBe(admin);
    expect(c.get('applicationContainer')).toBe(application);
    return c.json({ id: c.get('adminId') });
  });
  app.get('/adminapi/order/list', adminRuntimeAuthMiddleware(), () => { throw Error('synthetic handler failure'); });
  beforeAll(async () => {
    f = await financePostgres([systemAdmin, systemRole, systemMenus]);
    application = createContainerFromDb(f.db); admin = createContainerFromDb(f.db);
    await f.db.insert(systemAdmin).values([
      { id: 1, account: 'root', pwd: 'fixture-hash', level: 0 },
      { id: 2, account: 'disabled', pwd: 'fixture-hash', status: 0 },
      { id: 3, account: 'supplier', pwd: 'fixture-hash', adminType: 4 },
      { id: 4, account: 'no-permission', pwd: 'fixture-hash', roles: '', level: 1 },
      { id: 5, account: 'deleted', pwd: 'fixture-hash', isDel: 1 },
    ]);
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(() => { vi.clearAllMocks(); wiring.open.mockReturnValue({ container: admin, close }); });
  async function status(response: Response) {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || !('status' in value)) throw Error('Invalid error envelope');
    return value.status;
  }
  async function request(id = 1, type: TokenType = 'admin', auth = md5('fixture-hash'), path = '/adminapi/home/header') {
    const { token } = await createToken(id, type, auth, env.APP_KEY);
    return app.request(path, { headers: { Authorization: `Bearer ${token}` } }, env);
  }
  it('opens only for the verified account and restores/closes the scoped connection', async () => {
    const response = await request(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 1 });
    expect(wiring.open).toHaveBeenCalledExactlyOnceWith(env); expect(handler).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([2, 3, 4, 5, 999])('never opens Admin for disabled/type/permission/deleted/missing account %s', async id => {
    const response = await request(id); expect(await status(response)).not.toBe(200);
    expect(wiring.open).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });
  it.each(['api', 'supplier', 'kefu'] as const)('never opens Admin for a signed %s token', async type => {
    expect(await status(await request(1, type))).not.toBe(200);
    expect(wiring.open).not.toHaveBeenCalled();
  });
  it('rejects changed password claims before opening Admin', async () => {
    expect(await status(await request(1, 'admin', 'obsolete'))).not.toBe(200);
    expect(wiring.open).not.toHaveBeenCalled();
  });
  it.each([undefined, 'Bearer invalid-jwt'])('rejects missing/invalid tokens even on an Admin URL', async token => {
    const response = await app.request('/adminapi/home/header', { headers: token ? { Authorization: token } : {} }, env);
    expect(await status(response)).not.toBe(200); expect(wiring.open).not.toHaveBeenCalled();
  });
  it('closes and restores after a handler error', async () => {
    await request(1, 'admin', md5('fixture-hash'), '/adminapi/order/list'); expect(close).toHaveBeenCalledOnce();
  });
  it('does not run business work when the independent binding is missing', async () => {
    wiring.open.mockImplementation(() => { throw Error('Independent Admin database binding is required'); });
    expect(await status(await request())).not.toBe(200);
    expect(handler).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it('the real factory rejects missing and reused bindings before any database I/O', async () => {
    const actual = await vi.importActual<typeof import('@/lib/di')>('@/lib/di');
    expect(() => actual.createAdminDatabaseSession({} as Env)).toThrow('Independent');
    const binding = { connectionString: 'postgres://local.invalid/unused' };
    expect(() => actual.createAdminDatabaseSession({ HYPERDRIVE: binding, HYPERDRIVE_ADMIN: binding } as Env)).toThrow('Independent');
    expect(() => actual.createAdminDatabaseSession({ HYPERDRIVE: binding, HYPERDRIVE_ADMIN: { ...binding } } as Env)).toThrow('Independent');
  });
});
