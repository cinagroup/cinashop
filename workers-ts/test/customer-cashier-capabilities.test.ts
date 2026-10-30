import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '../src/env';
import type { Container, DbClient } from '../src/lib/di';
import { errorHandler } from '../src/middleware/error';
import { customerCashierRuntimeAuthMiddleware } from '../src/middleware/customer-cashier-runtime-auth';
import { cashierCapabilities } from '../src/controllers/api/v1/CustomerCashierCapabilitiesController';
import { CustomerCashierCapabilities, prepareCustomerCashierCapabilityContext } from '../src/services/customer-work/CustomerCashierCapabilities';
import { createToken, md5 } from '../src/utils/jwt';
import { outRequestHash } from '../src/services/out/OutIdempotency';

const wire = vi.hoisted(() => ({ open: vi.fn(), conditional: vi.fn(), origin: vi.fn(), base: vi.fn(), abandon: vi.fn(), images: vi.fn() }));
vi.mock('../src/lib/di', async original => ({ ...await original<typeof import('../src/lib/di')>(), createCustomerCashierDatabaseSession: wire.open }));
vi.mock('../src/migrations/cashierRuntimeConditionalBoundary', async original => ({ ...await original<typeof import('../src/migrations/cashierRuntimeConditionalBoundary')>(), inspectCashierRuntimeConditionalBoundary: wire.conditional }));
vi.mock('../src/migrations/runCashierSecondCardOrigin', async original => ({ ...await original<typeof import('../src/migrations/runCashierSecondCardOrigin')>(), cashierSecondCardOriginReadiness: wire.origin }));
vi.mock('../src/migrations/runCashierSecondCardAbandon', async original => ({ ...await original<typeof import('../src/migrations/runCashierSecondCardAbandon')>(), cashierSecondCardAbandonReadiness: wire.abandon }));
vi.mock('../src/migrations/runCashierSecondCardFormImages', async original => ({ ...await original<typeof import('../src/migrations/runCashierSecondCardFormImages')>(), cashierSecondCardFormImagesReadiness: wire.images }));
vi.mock('../src/services/customer-work/CustomerCashierFormImages', async original => ({ ...await original<typeof import('../src/services/customer-work/CustomerCashierFormImages')>(), cashierFormBaseReadiness: wire.base }));

const binding = { database: 'capability_database17', databaseOid: '51700', role: 'capability_cashier17', roleOid: '51701' };
const target = { database: binding.database, maintenance: 'capability_owner17', app: 'capability_app17', admin: 'capability_admin17',
  local: [binding.role, 'cinashop_customer_financial_v1', 'cinashop_manager_v1'] };
const actor = () => ({ uid: 101, auth_version: md5('owned-cap-password'), expires_at: Math.floor(Date.now()/1000)+3600 });
function transport() {
  let account: Record<string, unknown> = { status: 1, isDel: 0, deleteTime: null, auth: actor().auth_version };
  let scopes: Record<string, unknown>[] = [{ service_id: 19, uid: 101, mer_id: 0 }];
  let identityReady = true, currentOid = '51702', inside = false;
  const statements: string[] = [];
  const execute = vi.fn(async (query: Parameters<DbClient['execute']>[0]) => {
    statements.push(new PgDialect().sqlToQuery(query as Parameters<PgDialect['sqlToQuery']>[0]).sql);
    return statements.at(-1)!.includes('AS role_oid') ? [{ ready: identityReady, role_oid: currentOid }] : [];
  });
  const select = vi.fn((projection: object) => {
    const isAccount = 'auth' in projection;
    const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain,
      limit: async () => isAccount ? [{ ...account }] : scopes.map(row => ({ ...row })) };
    return chain;
  });
  const transaction = vi.fn(async (work: (tx: DbClient) => Promise<unknown>, options: unknown) => {
    expect(options).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(inside).toBe(false); inside = true;
    try { return await work(db); } finally { inside = false; }
  });
  const db = { select, execute, transaction } as unknown as DbClient;
  return { db, execute, transaction, select, statements,
    setAccount: (value: Record<string, unknown>) => { account = { ...account, ...value }; },
    setScopes: (value: Record<string, unknown>[]) => { scopes = value; },
    setIdentity: (ready: boolean, oid = currentOid) => { identityReady = ready; currentOid = oid; } };
}
const env = () => ({ APP_KEY: 'capabilities-unit-signing-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
  CUSTOMER_CASHIER_RUNTIME_IDENTITY: { ...binding }, CUSTOMER_CASHIER_RUNTIME_TARGET: { ...target, local: [...target.local] } } satisfies Partial<Env>) as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks(); wire.open.mockReset();
  wire.origin.mockReset().mockResolvedValue({ ready: true, reason: '', catalog: { complete: true, fingerprint: 'a'.repeat(64) } });
  wire.base.mockReset().mockResolvedValue({ ready: true, reason: '' }); wire.abandon.mockReset().mockResolvedValue({ ready: true, reason: '' });
  wire.images.mockReset().mockResolvedValue({ ready: true, reason: '', catalog: { complete: true, fingerprint: 'b'.repeat(64) } });
  wire.conditional.mockReset().mockResolvedValue({ ready: true, binding: { ...binding }, functions: [], triggers: [] });
});

describe('capability source publication with real scope/account logic and controlled SQL transport', () => {
  async function fixture() {
    const app = transport(), cashier = transport(); cashier.setIdentity(true, binding.roleOid);
    const application = { db: app.db } as Container, container = { db: cashier.db } as Container;
    const context = await prepareCustomerCashierCapabilityContext(application, env());
    return { app, cashier, context, service: new CustomerCashierCapabilities(container, context) };
  }
  it('returns a bounded separate lease and verifiable domain digest without leaking runtime identity or making writes', async () => {
    const f = await fixture(), result = await f.service.read(actor());
    expect(result.version).toBe('customer-cashier-capabilities-v1'); expect(result.actor_uid).toBe(101);
    expect(result.principal.service_id).toBe(19); expect(result.data.capabilities).toEqual({ cashier_second_card: true, cashier_form_images: true });
    expect(result.data.lease.expires_at-result.data.lease.issued_at).toBe(60);
    expect(result.data.lease.expires_at).toBeLessThanOrEqual(result.data.lease.session_expires_at);
    expect(result.consistency_key).toBe(await outRequestHash({ version: result.version, actor_uid: result.actor_uid,
      service_id: result.principal.service_id, scope_key: result.scope_key, data: result.data }));
    expect(JSON.stringify(result)).not.toContain(binding.role); expect(JSON.stringify(result)).not.toContain(binding.database);
    expect(f.app.transaction).toHaveBeenCalledTimes(3); expect(f.cashier.transaction).toHaveBeenCalledTimes(2);
    const commands = [...f.app.statements,...f.cashier.statements].join('\n').replace(/'(?:''|[^'])*'/gu, "''");
    expect(commands).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|GRANT|CREATE|FOR SHARE|FOR UPDATE|SET ROLE)\b/u);
  });
  it('keeps base capability true when only the image append addon drifts', async () => {
    const f = await fixture(); wire.images.mockResolvedValue({ ready: false, reason: 'cashier_images_unavailable', catalog: {} });
    const result = await f.service.read(actor());
    expect(result.data.capabilities).toEqual({ cashier_second_card: true, cashier_form_images: false });
    expect(result.data.readiness.form_images).toEqual({ ready: false, reason: 'cashier_images_unavailable' });
  });
  it.each(['origin', 'base', 'abandon', 'conditional'] as const)('disables both capabilities for %s readiness failure', async key => {
    const f = await fixture(); wire[key].mockResolvedValue({ ready: false, reason: 'unavailable', binding: { ...binding }, functions: [], triggers: [], catalog: {} });
    expect((await f.service.read(actor())).data.capabilities).toEqual({ cashier_second_card: false, cashier_form_images: false });
  });
  it.each(['revoked', 'duplicate', 'scope-changed', 'password', 'disabled', 'deleted', 'App-identity'] as const)
    ('withholds the read after a fresh %s change', async kind => {
      const f = await fixture(); wire.images.mockImplementationOnce(async () => {
        if (kind === 'revoked') f.app.setScopes([]);
        else if (kind === 'duplicate') f.app.setScopes([{service_id:19,uid:101,mer_id:0},{service_id:20,uid:101,mer_id:0}]);
        else if (kind === 'scope-changed') f.app.setScopes([{service_id:19,uid:101,mer_id:1}]);
        else if (kind === 'password') f.app.setAccount({ auth: 'f'.repeat(32) });
        else if (kind === 'disabled') f.app.setAccount({ status: 0 });
        else if (kind === 'deleted') f.app.setAccount({ isDel: 1 });
        else f.app.setIdentity(false);
        return { ready: true, reason: '', catalog: {} };
      });
      await expect(f.service.read(actor())).rejects.toMatchObject(kind === 'password' || kind === 'deleted' ? { code: 410001 }
        : kind === 'disabled' ? { code: 410002 } : kind === 'App-identity' ? { httpStatus: 503 } : { httpStatus: 403, code: 403 });
    });
  it('rejects a changed Cashier binding instead of accepting a scope-only match', async () => {
    const f = await fixture(); wire.conditional.mockResolvedValue({ ready: true, binding: { ...binding, databaseOid: '51799' }, functions: [], triggers: [] });
    await expect(f.service.read(actor())).rejects.toMatchObject({ httpStatus: 503 });
  });
  it.each(['missing-target','wrong-database','aliased-cashier','wrong-App-identity'] as const)('rejects %s before obtaining a capability context', async kind => {
    const app = transport(), config = env();
    if (kind === 'missing-target') delete config.CUSTOMER_CASHIER_RUNTIME_TARGET;
    else if (kind === 'wrong-database') config.CUSTOMER_CASHIER_RUNTIME_TARGET!.database = 'wrong_database17';
    else if (kind === 'aliased-cashier') config.CUSTOMER_CASHIER_RUNTIME_TARGET!.app = binding.role;
    else app.setIdentity(false);
    await expect(prepareCustomerCashierCapabilityContext({db:app.db} as Container,config)).rejects.toMatchObject({ httpStatus: 503 });
  });
});

describe('dedicated capability middleware and real UserJWT authentication', () => {
  it('restores App and removes the server-only context before closing the selected session', async () => {
    const application = transport(), selected = transport(); selected.setIdentity(true,binding.roleOid);
    const findForAuth = vi.fn(async () => ({uid:101,account:'operator',pwd:'owned-cap-password',status:1,nickname:'',avatar:'',phone:'',nowMoney:'0.00',integral:0,level:0}));
    const container = { db:application.db,userDao:{findForAuth} } as unknown as Container, close = vi.fn(async () => {});
    wire.open.mockResolvedValue({container:{db:selected.db} as Container,close});
    const h = new Hono<{Bindings:Env;Variables:AppVariables}>(); h.onError(errorHandler);
    h.use('*',async(c,next)=>{c.set('container',container);try{await next();}finally{expect(c.get('container')).toBe(container);expect(c.get('cashierCapabilityContext')).toBeUndefined();}});
    h.get('/capabilities',customerCashierRuntimeAuthMiddleware({capabilities:true}),cashierCapabilities);
    const config = env(), token = (await createToken(101,'api',md5('owned-cap-password'),config.APP_KEY)).token;
    const response = await h.request('/capabilities',{headers:{Authorization:'Bearer '+token}},config);
    expect((await response.json() as {status:number}).status).toBe(200); expect(close).toHaveBeenCalledOnce();
    expect(findForAuth.mock.invocationCallOrder[0]).toBeLessThan(wire.open.mock.invocationCallOrder[0]);
  });
});

describe('capability entry does not accept an ordinary App context as authority', () => {
  it('refuses the capability controller through the ordinary Cashier auth mode and still restores/closes', async () => {
    const application = transport(), selected = transport(), close = vi.fn(async () => {});
    const findForAuth = vi.fn(async () => ({uid:101,account:'operator',pwd:'owned-cap-password',status:1,nickname:'',avatar:'',phone:'',nowMoney:'0.00',integral:0,level:0}));
    const container = {db:application.db,userDao:{findForAuth}} as unknown as Container;
    wire.open.mockResolvedValue({container:{db:selected.db} as Container,close});
    const h=new Hono<{Bindings:Env;Variables:AppVariables}>();h.onError(errorHandler);
    h.use('*',async(c,next)=>{c.set('container',container);await next();expect(c.get('container')).toBe(container);});
    h.get('/ordinary-mode',customerCashierRuntimeAuthMiddleware(),cashierCapabilities);
    const config=env(),token=(await createToken(101,'api',md5('owned-cap-password'),config.APP_KEY)).token;
    const response=await h.request('/ordinary-mode',{headers:{Authorization:'Bearer '+token}},config);
    expect(response.status).toBe(503);expect(close).toHaveBeenCalledOnce();expect(wire.conditional).not.toHaveBeenCalled();
  });
});
