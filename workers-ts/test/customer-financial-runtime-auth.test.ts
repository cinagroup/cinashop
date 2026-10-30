import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import type { Container, DbClient } from '@/lib/di';
import { customerFinancialRuntimeAuthMiddleware } from '@/middleware/customer-financial-runtime-auth';
import { errorHandler } from '@/middleware/error';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { createToken, md5, type TokenType } from '@/utils/jwt';

// These are bounded unit tests: JWT signing/verification and the complete real
// auth middleware run; UserDAO, token bucket and driver I/O are controlled.
// Actual fixed LOGIN/profile/business evidence belongs to the native suite.
const wiring = vi.hoisted(() => ({ open: vi.fn(), connect: vi.fn(), drizzle: vi.fn(), bucket: vi.fn(), clear: vi.fn() }));
vi.mock('postgres', () => ({ default: wiring.connect }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: wiring.drizzle }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createCustomerFinancialDatabaseSession: wiring.open }));
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(),
  getTokenBucket: wiring.bucket, clearToken: wiring.clear }));

describe('Customer financial boundary after complete UserJWT authentication', () => {
  const close = vi.fn(async () => {}), handler = vi.fn(), findForAuth = vi.fn();
  const application = { userDao: { findForAuth } } as unknown as Container;
  const financial = { db: { boundary: 'independent financial' } } as unknown as Container;
  const env = { APP_KEY: 'owned-customer-financial-boundary-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' };
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('container', application);
    try { await next(); }
    finally { expect(c.get('container')).toBe(application); expect(c.get('applicationContainer')).toBeUndefined(); }
  });
  app.get('/mobile/work/financial/operations/:key', customerFinancialRuntimeAuthMiddleware(), c => {
    handler(); expect(c.get('container')).toBe(financial);
    return c.json({ uid: c.get('uid'), verifiedUid: c.get('socketAuthId') });
  });
  app.post('/mobile/work/financial/confirm-offline', customerFinancialRuntimeAuthMiddleware(), async c => {
    handler(); expect(c.get('container')).toBe(financial); return c.json(await c.req.json());
  });
  app.get('/mobile/work/financial/error', customerFinancialRuntimeAuthMiddleware(), () => { throw Error('synthetic financial handler failure'); });
  app.get('/ordinary', c => { expect(c.get('container')).toBe(application); return c.json({ application: true }); });
  beforeEach(() => {
    vi.clearAllMocks();
    close.mockReset().mockResolvedValue(undefined);
    wiring.open.mockReset().mockResolvedValue({ container: financial, close });
    wiring.bucket.mockReset().mockResolvedValue(null); wiring.clear.mockReset().mockResolvedValue(undefined);
    findForAuth.mockReset().mockImplementation(async (id: number) => [103, 104, 999].includes(id) ? null : ({
      uid: id, account: 'prior-owner', pwd: 'fixture-hash', status: id === 102 ? 0 : 1,
      nickname: '', avatar: '', phone: '', nowMoney: '0.00', integral: 0, level: 0,
      // No current customer qualification is supplied or required here.
    }));
  });
  const path = '/mobile/work/financial/operations/00000000-0000-4000-8000-000000000001';
  async function request(id = 101, type: TokenType = 'api', auth = md5('fixture-hash'), target = path, issuedAt?: number) {
    const { token } = await createToken(id, type, auth, env.APP_KEY, 'cinashop', issuedAt);
    return app.request(target, { headers: { Authorization: 'Bearer ' + token } }, env);
  }
  async function status(response: Response) { return (await response.json() as { status: number }).status; }

  it('opens only after real JWT, active UserDAO and password checks; restores/closes on success', async () => {
    const response = await request();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ uid: 101, verifiedUid: 101 });
    expect(findForAuth).toHaveBeenCalledExactlyOnceWith(101); expect(wiring.open).toHaveBeenCalledExactlyOnceWith(env);
    expect(findForAuth.mock.invocationCallOrder[0]).toBeLessThan(wiring.open.mock.invocationCallOrder[0]);
    expect(handler).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it('retains the authenticated original receipt owner boundary without rechecking current customer qualification', async () => {
    expect((await request()).status).toBe(200);
    expect(Object.keys(application)).toEqual(['userDao']); expect(wiring.open).toHaveBeenCalledOnce();
  });
  it.each([102, 103, 104, 999])('refuses disabled/deleted/missing user %s before opening financial I/O', async id => {
    expect(await status(await request(id))).not.toBe(200); expect(wiring.open).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it.each(['admin', 'supplier', 'kefu', 'out'] as const)('refuses a signed %s realm before opening financial I/O', async type => {
    expect(await status(await request(101, type))).not.toBe(200); expect(wiring.open).not.toHaveBeenCalled();
    expect(findForAuth).not.toHaveBeenCalled();
  });
  it.each([undefined, 'Bearer invalid-jwt'])('refuses absent or invalid token %s before opening financial I/O', async token => {
    const response = await app.request(path, { headers: token ? { Authorization: token } : {} }, env);
    expect(await status(response)).not.toBe(200); expect(wiring.open).not.toHaveBeenCalled();
  });
  it('refuses an actually expired signed JWT before UserDAO or privileged connection', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
    expect(await status(await request(101, 'api', md5('fixture-hash'), path, issuedAt))).toBe(410001);
    expect(findForAuth).not.toHaveBeenCalled(); expect(wiring.open).not.toHaveBeenCalled();
  });
  it('refuses a password-changed claim after real JWT verification', async () => {
    expect(await status(await request(101, 'api', md5('obsolete-hash')))).toBe(410001);
    expect(findForAuth).toHaveBeenCalledOnce(); expect(wiring.open).not.toHaveBeenCalled();
  });
  it('keeps the required production token-bucket gate ahead of the privileged connection', async () => {
    const { token } = await createToken(101, 'api', md5('fixture-hash'), env.APP_KEY);
    const redisEnv = { ...env, UPSTASH_REDIS_URL: 'https://owned.invalid', UPSTASH_REDIS_TOKEN: 'unit-only' };
    expect(await status(await app.request(path, { headers: { Authorization: 'Bearer ' + token } }, redisEnv))).toBe(410000);
    expect(findForAuth).not.toHaveBeenCalled(); expect(wiring.open).not.toHaveBeenCalled();
    wiring.bucket.mockResolvedValue({ type: 'api', token, uid: 999 });
    expect(await status(await app.request(path, { headers: { Authorization: 'Bearer ' + token } }, redisEnv))).toBe(410002);
    expect(wiring.open).not.toHaveBeenCalled();
    wiring.bucket.mockResolvedValue({ type: 'api', token, uid: 101 });
    expect((await app.request(path, { headers: { Authorization: 'Bearer ' + token } }, redisEnv)).status).toBe(200);
  });
  it('passes the untouched request body to the existing locked financial service', async () => {
    const { token } = await createToken(101, 'api', md5('fixture-hash'), env.APP_KEY);
    const body = { version: 'customer-financial-v1', order_id: 17, payload: { approved: true } };
    const response = await app.request('/mobile/work/financial/confirm-offline', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
    expect(await response.json()).toEqual(body); expect(close).toHaveBeenCalledOnce();
  });
  it('restores the App container and closes when the business handler fails', async () => {
    expect(await status(await request(101, 'api', md5('fixture-hash'), '/mobile/work/financial/error'))).not.toBe(200);
    expect(close).toHaveBeenCalledOnce();
  });
  it('restores the App container even if selected-session close fails', async () => {
    close.mockRejectedValue(Error('synthetic close failure'));
    expect(await status(await request())).not.toBe(200); expect(close).toHaveBeenCalledOnce();
  });
  it('does not invoke business work or invent a close handle when opening rejects', async () => {
    wiring.open.mockRejectedValue(Error('synthetic rejected independent session'));
    expect(await status(await request())).not.toBe(200); expect(handler).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it('keeps unrelated routes on the original App connection', async () => {
    expect(await (await app.request('/ordinary', {}, env)).json()).toEqual({ application: true });
    expect(wiring.open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
});

describe('actual Customer financial session factory with controlled driver I/O', () => {
  const end = vi.fn(async () => {}), execute = vi.fn(), transaction = vi.fn();
  const db = { $client: { end }, transaction } as unknown as DbClient;
  const identity = () => ({ role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, session: CUSTOMER_FINANCIAL_RUNTIME_ROLE,
    backend_role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, pg16: true, origin: true, restricted: true,
    no_memberships: true, no_ownership: true, connected: true, no_ddl: true, no_replication_bypass: true });
  const env = () => ({ HYPERDRIVE: { connectionString: 'postgres://app.invalid/db' },
    HYPERDRIVE_ADMIN: { connectionString: 'postgres://admin.invalid/db' },
    HYPERDRIVE_MANAGER: { connectionString: 'postgres://manager.invalid/db' },
    HYPERDRIVE_CUSTOMER_FINANCIAL: { connectionString: ' postgres://financial.invalid/db ' } }) as unknown as Env;
  beforeEach(() => {
    vi.clearAllMocks(); end.mockReset().mockResolvedValue(undefined);
    execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([identity()]);
    transaction.mockReset().mockImplementation(async (work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
    wiring.connect.mockReset().mockReturnValue(db.$client); wiring.drizzle.mockReset().mockReturnValue(db);
  });
  const actualFactory = async () => (await vi.importActual<typeof import('@/lib/di')>('@/lib/di')).createCustomerFinancialDatabaseSession;
  it('opens a max1 fixed-LOGIN session and performs bounded read-only actual identity SQL before returning a container', async () => {
    const open = await actualFactory(), selected = await open(env());
    expect(selected.container.db).toBe(db);
    expect(wiring.connect).toHaveBeenCalledExactlyOnceWith('postgres://financial.invalid/db', {
      prepare: false, max: 1, connection: { options: '-c search_path=public,pg_temp', application_name: 'cinashop_customer_financial' },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(execute).toHaveBeenCalledTimes(2);
    const statements = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql);
    expect(statements[0]).toContain("set_config('statement_timeout',LEAST(NULLIF(");
    expect(statements[0]).toContain("WHERE name='statement_timeout'),0),5000)::text||'ms',true)");
    for (const source of ['current_user AS role', 'session_user AS session', 'pg_catalog.pg_stat_activity',
      'pg_catalog.pg_auth_members', 'pg_catalog.pg_shdepend', 'pg_catalog.has_parameter_privilege']) expect(statements[1]).toContain(source);
    for (const statement of statements) expect(statement).toMatch(/^\s*SELECT\b/u);
    // Privilege-name literals such as 'CREATE' are SELECT data. Strip only
    // SQL single-quoted values before checking actual command tokens.
    const commands = statements.join('\n').replace(/'(?:''|[^'])*'/gu, "''");
    expect(commands).not.toMatch(/\b(?:CREATE|GRANT|ALTER ROLE|SET ROLE)\b/u);
    expect(end).not.toHaveBeenCalled(); await selected.close(); await selected.close(); expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
  it.each(['absent', 'empty', 'main-object', 'main-string', 'admin-object', 'admin-string', 'manager-object', 'manager-string'] as const)
    ('refuses %s binding before opening any database client', async variant => {
      const config = env();
      if (variant === 'absent') delete config.HYPERDRIVE_CUSTOMER_FINANCIAL;
      else if (variant === 'empty') config.HYPERDRIVE_CUSTOMER_FINANCIAL = { connectionString: '  ' } as Env['HYPERDRIVE'];
      else {
        const shared = variant.startsWith('main') ? config.HYPERDRIVE : variant.startsWith('admin') ? config.HYPERDRIVE_ADMIN! : config.HYPERDRIVE_MANAGER!;
        config.HYPERDRIVE_CUSTOMER_FINANCIAL = variant.endsWith('object') ? shared
          : { ...shared, connectionString: ' ' + shared.connectionString + ' ' };
      }
      await expect((await actualFactory())(config)).rejects.toMatchObject({ httpStatus: 503, code: 503 });
      expect(wiring.connect).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
    });
  it.each(['role', 'session', 'backend_role', 'pg16', 'origin', 'restricted', 'no_memberships', 'no_ownership', 'connected', 'no_ddl', 'no_replication_bypass'] as const)
    ('closes and returns503 when the real identity result has invalid %s', async key => {
      const drift = { ...identity(), [key]: ['role', 'session', 'backend_role'].includes(key) ? 'wrong-login' : false };
      execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([drift]);
      await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503, code: 503 });
      expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
    });
  it('closes on an absent catalog identity result', async () => {
    execute.mockReset().mockResolvedValue([]);
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503 }); expect(end).toHaveBeenCalledOnce();
  });
  it('closes and returns a controlled503 on actual identity-query failure without exposing driver details', async () => {
    execute.mockReset().mockResolvedValueOnce([]).mockRejectedValueOnce(Error('sensitive synthetic driver diagnostic'));
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503, message: '客服财务运行环境尚未完成独立配置' });
    expect(end).toHaveBeenCalledOnce();
  });
  it('retains the503 boundary if cleanup itself fails', async () => {
    execute.mockReset().mockRejectedValue(Error('synthetic failed read')); end.mockRejectedValue(Error('synthetic failed close'));
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503 }); expect(end).toHaveBeenCalledOnce();
  });
});

describe('production Customer financial route wiring', () => {
  it('binds exactly the13 existing financial routes and preserves unrelated App routes', () => {
    const routes = readFileSync(new URL('../src/routes/v1/index.ts', import.meta.url), 'utf8');
    const actual = [...routes.matchAll(/^v1Routes\.(get|post)\('(\/mobile\/work\/financial[^']*)',([^,]+),(CustomerWorkFinancial\.\w+)\);$/gmu)]
      .map(([, method, path, middleware, controller]) => [method, path, middleware, controller]);
    expect(actual).toEqual([
      ['get', '/mobile/work/financial/orders/:id', 'customerFinancialAuth', 'CustomerWorkFinancial.financialOrder'],
      ['get', '/mobile/work/financial/orders/:id/supplier-refund-settlement', 'customerFinancialAuth', 'CustomerWorkFinancial.supplierRefundSettlement'],
      ['get', '/mobile/work/financial/refunds/:id', 'customerFinancialAuth', 'CustomerWorkFinancial.financialRefundReview'],
      ['post', '/mobile/work/financial/refund-quote', 'customerFinancialAuth', 'CustomerWorkFinancial.financialRefundQuote'],
      ['post', '/mobile/work/financial/change-price', 'customerFinancialAuth', 'CustomerWorkFinancial.changePrice'],
      ['post', '/mobile/work/financial/confirm-offline', 'customerFinancialAuth', 'CustomerWorkFinancial.confirmOffline'],
      ['post', '/mobile/work/financial/refund-create', 'customerFinancialAuth', 'CustomerWorkFinancial.refundCreate'],
      ['post', '/mobile/work/financial/refund-return', 'customerFinancialAuth', 'CustomerWorkFinancial.refundReturn'],
      ['post', '/mobile/work/financial/refund-refuse', 'customerFinancialAuth', 'CustomerWorkFinancial.refundRefuse'],
      ['post', '/mobile/work/financial/refund-execute', 'customerFinancialAuth', 'CustomerWorkFinancial.refundExecute'],
      ['post', '/mobile/work/financial/refund-remark', 'customerFinancialAuth', 'CustomerWorkFinancial.refundRemark'],
      ['get', '/mobile/work/financial/operations/:key', 'customerFinancialAuth', 'CustomerWorkFinancial.financialOperationStatus'],
      ['post', '/mobile/work/financial/operations/:key/abandon', 'customerFinancialAuth', 'CustomerWorkFinancial.abandonFinancialOperation'],
    ]);
    expect(routes.match(/^v1Routes\.\w+\('\/mobile\/work\/financial/gmu)).toHaveLength(13);
    expect(routes.match(/customerFinancialRuntimeAuthMiddleware\(\)/gu)).toHaveLength(1);
    expect(routes.split('\n').filter(line => line.includes(',customerFinancialAuth,'))).toHaveLength(13);
    for (const existing of ["v1Routes.get('/mobile/work/context',authMiddleware({force:true}),CustomerWork.context);",
      "v1Routes.get('/mobile/work/writeoff/orders/:id',authMiddleware({force:true}),CustomerWorkWriteoff.writeoffOrder);"])
      expect(routes).toContain(existing);
  });
});
