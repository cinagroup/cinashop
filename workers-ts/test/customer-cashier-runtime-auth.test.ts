import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import type { Container, DbClient } from '@/lib/di';
import { customerCashierRuntimeAuthMiddleware } from '@/middleware/customer-cashier-runtime-auth';
import { errorHandler } from '@/middleware/error';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '@/migrations/customerFinancialRuntimePlan';
import { MANAGER_RUNTIME_ROLE } from '@/migrations/managerRuntimePrivilegePlan';
import { createToken, md5, type TokenType } from '@/utils/jwt';

const CASHIER_ROLE = 'owned_cashier_16', DATABASE = 'owned_database_16', ROLE_OID = '43210', DATABASE_OID = '54321';

// These are bounded unit tests: JWT signing/verification and the complete real
// auth middleware run; UserDAO, token bucket and driver I/O are controlled.
// Actual commissioned LOGIN/profile/business evidence belongs to the native suite.
const wiring = vi.hoisted(() => ({ open: vi.fn(), connect: vi.fn(), drizzle: vi.fn(), bucket: vi.fn(), clear: vi.fn() }));
vi.mock('postgres', () => ({ default: wiring.connect }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: wiring.drizzle }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createCustomerCashierDatabaseSession: wiring.open }));
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(),
  getTokenBucket: wiring.bucket, clearToken: wiring.clear }));

describe('Customer Cashier boundary after complete UserJWT authentication', () => {
  const close = vi.fn(async () => {}), handler = vi.fn(), findForAuth = vi.fn();
  const application = { userDao: { findForAuth } } as unknown as Container;
  const cashier = { db: { boundary: 'independent Cashier' } } as unknown as Container;
  const env = { APP_KEY: 'owned-customer-cashier-boundary-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' };
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('container', application);
    try { await next(); }
    finally { expect(c.get('container')).toBe(application); expect(c.get('applicationContainer')).toBeUndefined(); }
  });
  app.get('/mobile/work/cashier/second-card/creations/:key', customerCashierRuntimeAuthMiddleware(), c => {
    handler(); expect(c.get('container')).toBe(cashier);
    return c.json({ uid: c.get('uid'), verifiedUid: c.get('socketAuthId') });
  });
  app.post('/mobile/work/cashier/second-card/orders', customerCashierRuntimeAuthMiddleware(), async c => {
    handler(c.req.header('Idempotency-Key')); expect(c.get('container')).toBe(cashier); return c.json(await c.req.json());
  });
  app.get('/mobile/work/cashier/second-card/error', customerCashierRuntimeAuthMiddleware(), () => { throw Error('synthetic Cashier handler failure'); });
  app.get('/ordinary', c => { expect(c.get('container')).toBe(application); return c.json({ application: true }); });
  beforeEach(() => {
    vi.clearAllMocks();
    close.mockReset().mockResolvedValue(undefined);
    wiring.open.mockReset().mockResolvedValue({ container: cashier, close });
    wiring.bucket.mockReset().mockResolvedValue(null); wiring.clear.mockReset().mockResolvedValue(undefined);
    findForAuth.mockReset().mockImplementation(async (id: number) => [103, 104, 999].includes(id) ? null : ({
      uid: id, account: 'prior-owner', pwd: 'fixture-hash', status: id === 102 ? 0 : 1,
      nickname: '', avatar: '', phone: '', nowMoney: '0.00', integral: 0, level: 0,
      // No current customer qualification is supplied or required here.
    }));
  });
  const path = '/mobile/work/cashier/second-card/creations/00000000-0000-4000-8000-000000000001';
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
  it.each([102, 103, 104, 999])('refuses disabled/deleted/missing user %s before opening Cashier I/O', async id => {
    expect(await status(await request(id))).not.toBe(200); expect(wiring.open).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5])('refuses a nonpositive or noninteger operator %s before opening Cashier I/O', async id => {
    expect(await status(await request(id))).toBe(410002);
    expect(wiring.open).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });
  it.each(['admin', 'supplier', 'kefu', 'out'] as const)('refuses a signed %s realm before opening Cashier I/O', async type => {
    expect(await status(await request(101, type))).not.toBe(200); expect(wiring.open).not.toHaveBeenCalled();
    expect(findForAuth).not.toHaveBeenCalled();
  });
  it.each([undefined, 'Bearer invalid-jwt'])('refuses absent or invalid token %s before opening Cashier I/O', async token => {
    const response = await app.request(path, { headers: token ? { Authorization: token } : {} }, env);
    expect(await status(response)).not.toBe(200); expect(wiring.open).not.toHaveBeenCalled();
  });
  it('refuses an actually expired signed JWT before UserDAO or privileged connection', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 8 * 24 * 3600;
    expect(await status(await request(101, 'api', md5('fixture-hash'), path, issuedAt))).toBe(410001);
    expect(findForAuth).not.toHaveBeenCalled(); expect(wiring.open).not.toHaveBeenCalled();
  });
  it('rejects a well-formed JWT signed by another key before UserDAO or Cashier I/O', async () => {
    const { token } = await createToken(101, 'api', md5('fixture-hash'), 'another-fixture-signing-key');
    expect(await status(await app.request(path, { headers: { Authorization: 'Bearer ' + token } }, env))).toBe(410001);
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
  it('passes the untouched request body to the existing locked Cashier service', async () => {
    const { token } = await createToken(101, 'api', md5('fixture-hash'), env.APP_KEY);
    const body = { version: 'customer-cashier-v1', order_id: 17, payload: { approved: true } };
    const response = await app.request('/mobile/work/cashier/second-card/orders', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'Idempotency-Key': '00000000-0000-4000-8000-000000000016' }, body: JSON.stringify(body) }, env);
    expect(await response.json()).toEqual(body); expect(close).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000016');
  });
  it('restores App I/O and closes exactly once when business JSON parsing fails', async () => {
    const { token } = await createToken(101, 'api', md5('fixture-hash'), env.APP_KEY);
    const response = await app.request('/mobile/work/cashier/second-card/orders', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{malformed' }, env);
    expect(await status(response)).not.toBe(200); expect(handler).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it.each(['realm', 'token', 'missing-uid'] as const)('refuses a production bucket with %s mismatch before database work', async variant => {
    const { token } = await createToken(101, 'api', md5('fixture-hash'), env.APP_KEY);
    const bucket: Record<string, unknown> = { type: 'api', token, uid: 101 };
    if (variant === 'realm') bucket.type = 'admin';
    else if (variant === 'token') bucket.token = token + 'other';
    else delete bucket.uid;
    wiring.bucket.mockResolvedValue(bucket);
    expect(await status(await app.request(path, { headers: { Authorization: 'Bearer ' + token } },
      { ...env, UPSTASH_REDIS_URL: 'https://owned.invalid', UPSTASH_REDIS_TOKEN: 'unit-only' }))).toBe(410000);
    expect(findForAuth).not.toHaveBeenCalled(); expect(wiring.open).not.toHaveBeenCalled();
  });
  it('restores the App container and closes when the business handler fails', async () => {
    expect(await status(await request(101, 'api', md5('fixture-hash'), '/mobile/work/cashier/second-card/error'))).not.toBe(200);
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

describe('actual Customer Cashier session factory with controlled driver I/O', () => {
  const end = vi.fn(async () => {}), execute = vi.fn(), transaction = vi.fn();
  const db = { $client: { end }, transaction } as unknown as DbClient;
  const identity = () => ({ role: CASHIER_ROLE, session: CASHIER_ROLE,
    backend_role: CASHIER_ROLE, role_oid: ROLE_OID, session_oid: ROLE_OID, backend_role_oid: ROLE_OID,
    database: DATABASE, database_oid: DATABASE_OID, pg16: true, origin: true, restricted: true,
    no_memberships: true, no_ownership: true, connected: true, no_ddl: true, no_replication_bypass: true });
  const env = () => ({ HYPERDRIVE: { connectionString: 'postgres://app.invalid/db' },
    HYPERDRIVE_ADMIN: { connectionString: 'postgres://admin.invalid/db' },
    HYPERDRIVE_MANAGER: { connectionString: 'postgres://manager.invalid/db' },
    HYPERDRIVE_CUSTOMER_FINANCIAL: { connectionString: 'postgres://financial.invalid/db' },
    CUSTOMER_CASHIER_RUNTIME_IDENTITY: { database: DATABASE, databaseOid: DATABASE_OID, role: CASHIER_ROLE, roleOid: ROLE_OID },
    HYPERDRIVE_CUSTOMER_CASHIER: { connectionString: ' postgres://cashier.invalid/db ' } }) as unknown as Env;
  beforeEach(() => {
    vi.clearAllMocks(); end.mockReset().mockResolvedValue(undefined);
    execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([identity()]);
    transaction.mockReset().mockImplementation(async (work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
    wiring.connect.mockReset().mockReturnValue(db.$client); wiring.drizzle.mockReset().mockReturnValue(db);
  });
  const actualFactory = async () => (await vi.importActual<typeof import('@/lib/di')>('@/lib/di')).createCustomerCashierDatabaseSession;
  it('opens a max1 commissioned LOGIN session and performs bounded read-only actual identity SQL before returning a container', async () => {
    const open = await actualFactory(), selected = await open(env());
    expect(selected.container.db).toBe(db);
    expect(wiring.connect).toHaveBeenCalledExactlyOnceWith('postgres://cashier.invalid/db', {
      prepare: false, max: 1, connection: { options: '-c search_path=public,pg_temp', application_name: 'cinashop_customer_cashier' },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(execute).toHaveBeenCalledTimes(2);
    const statements = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql);
    expect(statements[0]).toContain("set_config('statement_timeout',LEAST(NULLIF(");
    expect(statements[0]).toContain("WHERE name='statement_timeout'),0),5000)::text||'ms',true)");
    for (const source of ['current_user AS role', 'session_user AS session', 'pg_catalog.pg_stat_activity',
      'r.oid::text AS role_oid', 'AS session_oid', 'AS backend_role_oid', 'current_database() AS database', 'AS database_oid',
      'pg_catalog.pg_auth_members', 'pg_catalog.pg_shdepend', 'pg_catalog.has_parameter_privilege']) expect(statements[1]).toContain(source);
    for (const [setting, limit] of [['statement_timeout', 5000], ['lock_timeout', 1000], ['idle_in_transaction_session_timeout', 5000]])
      expect(statements[0]).toContain(`WHERE name='${setting}'),0),${limit})::text||'ms',true)`);
    for (const statement of statements) expect(statement).toMatch(/^\s*SELECT\b/u);
    // Privilege-name literals such as 'CREATE' are SELECT data. Strip only
    // SQL single-quoted values before checking actual command tokens.
    const commands = statements.join('\n').replace(/'(?:''|[^'])*'/gu, "''");
    expect(commands).not.toMatch(/\b(?:CREATE|GRANT|ALTER ROLE|SET ROLE)\b/u);
    expect(end).not.toHaveBeenCalled(); await selected.close(); await selected.close(); expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
  it.each(['absent', 'empty', 'main-object', 'main-string', 'admin-object', 'admin-string', 'manager-object', 'manager-string', 'financial-object', 'financial-string'] as const)
    ('refuses %s binding before opening any database client', async variant => {
      const config = env();
      if (variant === 'absent') delete config.HYPERDRIVE_CUSTOMER_CASHIER;
      else if (variant === 'empty') config.HYPERDRIVE_CUSTOMER_CASHIER = { connectionString: '  ' } as Env['HYPERDRIVE'];
      else {
        const shared = variant.startsWith('main') ? config.HYPERDRIVE : variant.startsWith('admin') ? config.HYPERDRIVE_ADMIN! : variant.startsWith('manager') ? config.HYPERDRIVE_MANAGER! : config.HYPERDRIVE_CUSTOMER_FINANCIAL!;
        config.HYPERDRIVE_CUSTOMER_CASHIER = variant.endsWith('object') ? shared
          : { ...shared, connectionString: ' ' + shared.connectionString + ' ' };
      }
      await expect((await actualFactory())(config)).rejects.toMatchObject({ httpStatus: 503, code: 503 });
      expect(wiring.connect).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
    });
  it.each(['role', 'session', 'backend_role', 'role_oid', 'session_oid', 'backend_role_oid', 'database', 'database_oid', 'pg16', 'origin', 'restricted', 'no_memberships', 'no_ownership', 'connected', 'no_ddl', 'no_replication_bypass'] as const)
    ('closes and returns503 when the real identity result has invalid %s', async key => {
      const drift = { ...identity(), [key]: ['role', 'session', 'backend_role', 'role_oid', 'session_oid', 'backend_role_oid', 'database', 'database_oid'].includes(key) ? 'wrong-login' : false };
      execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([drift]);
      await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503, code: 503 });
      expect(end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
    });
  it.each([
    ['absent', undefined], ['empty', {}], ['array', []],
    ['extra-key', { database: DATABASE, databaseOid: DATABASE_OID, role: CASHIER_ROLE, roleOid: ROLE_OID, extra: true }],
    ['symbol-key', { database: DATABASE, databaseOid: DATABASE_OID, role: CASHIER_ROLE, roleOid: ROLE_OID, [Symbol('untrusted')]: true }],
    ['numeric-oid', { database: DATABASE, databaseOid: DATABASE_OID, role: CASHIER_ROLE, roleOid: 43210 }],
    ['zero-oid', { database: DATABASE, databaseOid: DATABASE_OID, role: CASHIER_ROLE, roleOid: '0' }],
    ['overflow-oid', { database: DATABASE, databaseOid: '4294967296', role: CASHIER_ROLE, roleOid: ROLE_OID }],
    ['unsafe-name', { database: DATABASE, databaseOid: DATABASE_OID, role: 'owned;SET ROLE app', roleOid: ROLE_OID }],
  ])('rejects malformed or absent trusted identity %s before opening any client', async (_name, value) => {
    const config = env(); config.CUSTOMER_CASHIER_RUNTIME_IDENTITY = value as Env['CUSTOMER_CASHIER_RUNTIME_IDENTITY'];
    await expect((await actualFactory())(config)).rejects.toMatchObject({ httpStatus: 503, code: 503 });
    expect(wiring.connect).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
  });
  it.each([MANAGER_RUNTIME_ROLE, CUSTOMER_FINANCIAL_RUNTIME_ROLE])('rejects trusted identity aliasing fixed non-Cashier role %s before connecting', async role => {
    const config = env(); config.CUSTOMER_CASHIER_RUNTIME_IDENTITY!.role = role;
    await expect((await actualFactory())(config)).rejects.toMatchObject({ httpStatus: 503 }); expect(wiring.connect).not.toHaveBeenCalled();
  });
  it.each(['renamed-original', 'same-name-replacement', 'different-database'] as const)('rejects realistic %s identity without credential inference', async variant => {
    const drift = identity();
    if (variant === 'renamed-original') drift.role = drift.session = drift.backend_role = 'ConditionalCashierMixed16';
    else if (variant === 'same-name-replacement') drift.role_oid = drift.session_oid = drift.backend_role_oid = '43211';
    else drift.database_oid = '54322';
    execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([drift]);
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503 }); expect(end).toHaveBeenCalledOnce();
  });
  it('compares the actual principal to the trusted receipt even when a distinct DSN authenticates App', async () => {
    execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...identity(), role: 'owned_app_16', session: 'owned_app_16',
      backend_role: 'owned_app_16', role_oid: '43209', session_oid: '43209', backend_role_oid: '43209' }]);
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503 }); expect(end).toHaveBeenCalledOnce();
  });
  it('closes on an absent catalog identity result', async () => {
    execute.mockReset().mockResolvedValue([]);
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503 }); expect(end).toHaveBeenCalledOnce();
  });
  it('closes and returns a controlled503 on actual identity-query failure without exposing driver details', async () => {
    execute.mockReset().mockResolvedValueOnce([]).mockRejectedValueOnce(Error('sensitive synthetic driver diagnostic'));
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503, message: '客服收银运行环境尚未完成独立配置' });
    expect(end).toHaveBeenCalledOnce();
  });
  it('retains the503 boundary if cleanup itself fails', async () => {
    execute.mockReset().mockRejectedValue(Error('synthetic failed read')); end.mockRejectedValue(Error('synthetic failed close'));
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503 }); expect(end).toHaveBeenCalledOnce();
  });
  it('returns a controlled503 without an invented cleanup handle when driver opening fails', async () => {
    wiring.connect.mockImplementation(() => { throw Error('sensitive opening diagnostic'); });
    await expect((await actualFactory())(env())).rejects.toMatchObject({ httpStatus: 503, message: '客服收银运行环境尚未完成独立配置' });
    expect(end).not.toHaveBeenCalled();
  });
  it('does not retry closing when the returned idempotent close handle fails', async () => {
    const selected = await (await actualFactory())(env()); end.mockRejectedValue(Error('sensitive close diagnostic'));
    await expect(selected.close()).rejects.toMatchObject({ httpStatus: 503, message: '客服收银运行环境尚未完成独立配置' });
    await selected.close(); expect(end).toHaveBeenCalledOnce();
  });
  it('captures the maintenance receipt before asynchronous identity reads', async () => {
    const config = env();
    execute.mockReset().mockImplementationOnce(async () => {
      config.CUSTOMER_CASHIER_RUNTIME_IDENTITY!.role = 'replacement_during_read'; return [];
    }).mockResolvedValueOnce([identity()]);
    const selected = await (await actualFactory())(config);
    expect(selected.container.db).toBe(db); await selected.close(); expect(end).toHaveBeenCalledOnce();
  });
});

describe('production second-card Cashier route wiring', () => {
  it('retains all eighteen existing second-card handlers and selects one separate capability reader', () => {
    const routes = readFileSync(new URL('../src/routes/v1/index.ts', import.meta.url), 'utf8');
    const actual = [...routes.matchAll(/^v1Routes\.(get|post)\('(\/mobile\/work\/cashier\/second-card[^']*)',([^,]+),((?:CustomerWorkCashier|CustomerCashierFormImages)\.\w+)\);$/gmu)]
      .map(([, method, path, middleware, controller]) => [method, path, middleware, controller]);
    expect(actual).toEqual([
      ['post', '/mobile/work/cashier/second-card/drafts', 'customerCashierAuth', 'CustomerWorkCashier.cashierDraft'],
      ['post', '/mobile/work/cashier/second-card/quote', 'customerCashierAuth', 'CustomerWorkCashier.cashierQuote'],
      ['post', '/mobile/work/cashier/second-card/orders', 'customerCashierAuth', 'CustomerWorkCashier.cashierCreate'],
      ['post', '/mobile/work/cashier/second-card/orders/:id/cash', 'customerCashierAuth', 'CustomerWorkCashier.cashierCash'],
      ['get', '/mobile/work/cashier/second-card/creations/:key', 'customerCashierAuth', 'CustomerWorkCashier.cashierCreationStatus'],
      ['get', '/mobile/work/cashier/second-card/payments/:key', 'customerCashierAuth', 'CustomerWorkCashier.cashierPaymentStatus'],
      ['post', '/mobile/work/cashier/second-card/creations/:key/abandon', 'customerCashierAuth', 'CustomerWorkCashier.cashierCreationAbandon'],
      ['post', '/mobile/work/cashier/second-card/payments/:key/abandon', 'customerCashierAuth', 'CustomerWorkCashier.cashierPaymentAbandon'],
      ['get', '/mobile/work/cashier/second-card/records', 'customerCashierAuth', 'CustomerWorkCashier.cashierRecords'],
      ['get', '/mobile/work/cashier/second-card/records/:id', 'customerCashierAuth', 'CustomerWorkCashier.cashierRecord'],
      ['get', '/mobile/work/cashier/second-card/catalog', 'customerCashierAuth', 'CustomerWorkCashier.cashierCatalog'],
      ['get', '/mobile/work/cashier/second-card/catalog/:id', 'customerCashierAuth', 'CustomerWorkCashier.cashierSelection'],
      ['post', '/mobile/work/cashier/second-card/form-sessions', 'customerCashierAuth', 'CustomerCashierFormImages.formSessionCreate'],
      ['get', '/mobile/work/cashier/second-card/form-sessions/:key', 'customerCashierAuth', 'CustomerCashierFormImages.formSessionRead'],
      ['post', '/mobile/work/cashier/second-card/form-sessions/:key/cancel', 'customerCashierAuth', 'CustomerCashierFormImages.formSessionCancel'],
      ['post', '/mobile/work/cashier/second-card/form-sessions/:key/images', 'customerCashierAuth', 'CustomerCashierFormImages.formImageUpload'],
      ['post', '/mobile/work/cashier/second-card/form-sessions/:key/previews', 'customerCashierAuth', 'CustomerCashierFormImages.formSessionPreviews'],
      ['get', '/mobile/work/cashier/second-card/form-images/:key', 'customerCashierAuth', 'CustomerCashierFormImages.formImageRead'],
    ]);
    const ordinary = [...routes.matchAll(/^v1Routes\.(get|post)\('(\/mobile\/work\/cashier\/ordinary[^']*)',(.+),(CustomerWorkOrdinaryCashier\.\w+)\);$/gmu)]
      .map(([, method, path, middleware, controller]) => [method, path, middleware, controller]);
    expect(ordinary).toEqual([
      ['post', '/mobile/work/cashier/ordinary/drafts', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.draft'],
      ['get', '/mobile/work/cashier/ordinary/drafts/:key', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.draftRead'],
      ['post', '/mobile/work/cashier/ordinary/drafts/:key/rows', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.rows'],
      ['post', '/mobile/work/cashier/ordinary/drafts/:key/quantity', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.quantity'],
      ['post', '/mobile/work/cashier/ordinary/drafts/:key/remove', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.remove'],
      ['post', '/mobile/work/cashier/ordinary/quote', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.quote'],
      ['post', '/mobile/work/cashier/ordinary/orders', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.create'],
      ['post', '/mobile/work/cashier/ordinary/orders/:id/cash', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.cash'],
      ['get', '/mobile/work/cashier/ordinary/operations/:key', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.operation'],
      ['post', '/mobile/work/cashier/ordinary/operations/:key/abandon', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.abandon'],
      ['get', '/mobile/work/cashier/ordinary/readiness', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.readiness'],
      ['get', '/mobile/work/cashier/ordinary/catalog', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.catalog'],
      ['get', '/mobile/work/cashier/ordinary/catalog/:id', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.selection'],
      ['get', '/mobile/work/cashier/ordinary/users', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.users'],
      ['get', '/mobile/work/cashier/ordinary/users/:uid/addresses', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.addresses'],
      ['get', '/mobile/work/cashier/ordinary/quotes/:token/coupons', 'authMiddleware({force:true})', 'CustomerWorkOrdinaryCashier.coupons'],
    ]);
    expect(routes.match(/^v1Routes\.\w+\('\/mobile\/work\/cashier\/second-card/gmu)).toHaveLength(19);
    expect(routes).toContain("v1Routes.get('/mobile/work/cashier/second-card/capabilities',customerCashierCapabilitiesAuth,CustomerCashierCapabilities.cashierCapabilities);");
    expect(routes.match(/customerCashierRuntimeAuthMiddleware\(\{ capabilities: true \}\)/gu)).toHaveLength(1);
    expect(routes.match(/customerCashierRuntimeAuthMiddleware\(\)/gu)).toHaveLength(1);
    expect(routes.split('\n').filter(line => line.includes(',customerCashierAuth,'))).toHaveLength(18);
    expect(routes).not.toMatch(/\.use\([^\n]*customerCashierAuth/u);
    for (const existing of ["v1Routes.get('/mobile/work/context',authMiddleware({force:true}),CustomerWork.context);",
      "v1Routes.get('/mobile/work/writeoff/orders/:id',authMiddleware({force:true}),CustomerWorkWriteoff.writeoffOrder);",
      "v1Routes.get('/mobile/work/products',authMiddleware({force:true}),CustomerWorkProduct.productList);",
      "v1Routes.get('/mobile/work/users',authMiddleware({force:true}),CustomerWorkUser.userList);",
      "v1Routes.get('/mobile/work/financial/operations/:key',customerFinancialAuth,CustomerWorkFinancial.financialOperationStatus);"])
      expect(routes).toContain(existing);
  });
});

