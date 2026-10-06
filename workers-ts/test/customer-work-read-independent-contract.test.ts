import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import type { Container, DbClient } from '../src/lib/di';
import type { Env } from '../src/env';
import { CustomerWorkReadService } from '../src/services/customer-work/CustomerWorkReadService';
import {
  authorizeCustomerWorkActor,
  readCustomerWorkScope,
  withCustomerWorkRead,
  type CustomerWorkActor,
} from '../src/services/customer-work/CustomerWorkScope';
import {
  AdminStatisticService,
  parseMobileOrderDataQuery,
  parseMobileOrderPeriod,
} from '../src/services/admin/AdminStatisticService';
import { refundTypesForFilter } from '../src/services/admin/AdminMobileRefundService';
import {
  CUSTOMER_WORK_SCOPES,
  customerWorkImage,
  isCustomerWorkContext,
  isCustomerWorkOverview,
  isCustomerWorkTrend,
  isCustomerWorkDaily,
  isCustomerWorkPaged,
  isCustomerWorkOrder,
  parseCustomerWorkEnvelope,
  parseCustomerWorkQuery,
  resolveCustomerWorkPageRoute,
} from '../../view/uniapp-ts/src/utils/customerWork';
import type { CustomerWorkPage } from '../../view/common/customerWorkRoute';

// Execute the actual scope service and withTx. Only the database transport is
// scripted here: native PostgreSQL independently proves the SQL predicates,
// actual RR isolation, UserJWT route boundary and ordinary LOGIN privileges.
// No permission algorithm or service source is reproduced in this fixture.
type Row = Record<string, unknown>;
function scriptedDatabase(selectResults: Row[][], executeResults: Row[][] = []) {
  const remaining = selectResults.map(rows => rows.map(row => ({ ...row })));
  const statements: unknown[] = [];
  let selected = 0;
  const select = vi.fn(() => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => {
        selected++;
        if (!remaining.length) throw new Error('Unexpected additional database read');
        return remaining.shift()!;
      },
    };
    return chain;
  });
  const execute = vi.fn(async (statement: unknown) => {
    statements.push(statement);
    return executeResults.length ? executeResults.shift()! : [];
  });
  const db = { select, execute } as unknown as DbClient;
  return { db, select, execute, remaining, statements, selected: () => selected };
}
const auth = 'a'.repeat(32);
const identity = (service_id = 81, mer_id = 0): Row => ({ service_id, uid: 42, mer_id });
const account = (value = auth): Row => ({ auth: value });
const actor = (): CustomerWorkActor => ({ uid: 42, auth_version: auth, expires_at: Math.floor(Date.now() / 1000) + 3600 });
function readFixture(freshRows: Row[][] = [[account()], [identity()]], businessRows: Row[][] = []) {
  const transaction = scriptedDatabase([[account()], [identity()]], [[], [], ...businessRows, [{ value: [['orders', '2', '3', '4', '5']] }]]);
  const fresh = scriptedDatabase(freshRows);
  const transact = vi.fn(async (callback: (db: DbClient) => Promise<unknown>) => callback(transaction.db));
  Object.assign(fresh.db, { transaction: transact });
  return { container: { db: fresh.db } as Container, transaction, fresh, transact };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('independent actual customer scope and read publication', () => {
  it('fails closed for missing and duplicate current customer identities', async () => {
    const missing = scriptedDatabase([[]]);
    await expect(readCustomerWorkScope(missing.db, 42)).rejects.toThrow('手机订单管理权限');
    const optional = scriptedDatabase([[]]);
    await expect(readCustomerWorkScope(optional.db, 42, false)).resolves.toBeNull();
    const duplicate = scriptedDatabase([[identity(), identity(82)]]);
    await expect(readCustomerWorkScope(duplicate.db, 42)).rejects.toThrow('身份重复');
  });

  it.each([
    { label: 'expired token', patch: { expires_at: 0 } },
    { label: 'invalid credential version', patch: { auth_version: 'not-a-password-claim' } },
    { label: 'invalid actor UID', patch: { uid: 0 } },
  ])('rejects $label before reading business data', async ({ patch }) => {
    const db = scriptedDatabase([]);
    await expect(authorizeCustomerWorkActor(db.db, { ...actor(), ...patch })).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects changed password claims before looking up the customer grant', async () => {
    const db = scriptedDatabase([[account('b'.repeat(32))]]);
    await expect(authorizeCustomerWorkActor(db.db, actor())).rejects.toThrow('会话已失效');
    expect(db.selected()).toBe(1);
  });

  it('does not execute a business reader for an old expected scope', async () => {
    const fixture = readFixture();
    const read = vi.fn(async () => ({ secret: 'must not be reached' }));
    await expect(withCustomerWorkRead(fixture.container, actor(), 'f'.repeat(64), read)).rejects.toThrow('身份已变化');
    expect(read).not.toHaveBeenCalled();
    expect(fixture.fresh.select).not.toHaveBeenCalled();
  });

  it('withholds an already-read response after live role revocation', async () => {
    const fixture = readFixture([[account()], []]);
    const read = vi.fn(async () => ({ private_order: 'CW_42' }));
    await expect(withCustomerWorkRead(fixture.container, actor(), undefined, read)).rejects.toThrow('手机订单管理权限');
    expect(read).toHaveBeenCalledTimes(1);
    expect(fixture.fresh.selected()).toBe(2);
  });

  it.each([
    { label: 'reassigned service identity', serviceId: 82, merId: 0 },
    { label: 'changed service context', serviceId: 81, merId: 7 },
  ])('withholds a response after $label', async ({ serviceId, merId }) => {
    const fixture = readFixture([[account()], [identity(serviceId, merId)]]);
    await expect(withCustomerWorkRead(fixture.container, actor(), undefined, async () => ({ count: 2 }))).rejects.toThrow('身份已变化');
  });

  it('withholds an already-read response after live password revocation', async () => {
    const fixture = readFixture([[account('b'.repeat(32))]]);
    await expect(withCustomerWorkRead(fixture.container, actor(), undefined, async () => ({ count: 2 }))).rejects.toThrow('会话已失效');
    expect(fixture.fresh.selected()).toBe(1);
  });

  it('rechecks expiry after an asynchronous business read', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
    const fixture = readFixture();
    const initial = { ...actor(), expires_at: Math.floor(Date.now() / 1000) + 1 };
    await expect(withCustomerWorkRead(fixture.container, initial, undefined, async () => {
      vi.setSystemTime(new Date('2026-10-04T00:00:02Z')); return { count: 2 };
    })).rejects.toThrow('会话已失效');
    expect(fixture.fresh.select).not.toHaveBeenCalled();
  });

  it('copies actor claims and publishes only after the ordinary-connection recheck', async () => {
    const fixture = readFixture(), initial = actor();
    const result = await withCustomerWorkRead(fixture.container, initial, undefined, async (db, scope) => {
      expect(db).toBe(fixture.transaction.db);
      expect(fixture.transaction.selected()).toBe(2);
      expect(fixture.transaction.execute).toHaveBeenCalledTimes(2);
      expect(fixture.fresh.select).not.toHaveBeenCalled();
      initial.uid = 99; initial.auth_version = 'b'.repeat(32);
      expect(scope.actor_uid).toBe(42);
      return { count: 2 };
    });
    expect(result.actor_uid).toBe(42);
    expect(result.principal).toEqual({ kind: 'customer-order-manager', service_id: 81, scope: 'global' });
    expect(result.scope_key).toMatch(/^[a-f0-9]{64}$/);
    expect(result.consistency_key).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data).toEqual({ count: 2 });
    expect(fixture.fresh.remaining).toHaveLength(0);
    expect(fixture.transact).toHaveBeenCalledTimes(1);
  });
});

describe('independent actual customer read projections consumed by real frontend guards', () => {
  const now = Math.floor(Date.parse('2026-10-03T16:05:00Z') / 1000);
  it('keeps one-cent growth exact and publishes the actual overview as its public frontend DTO', async () => {
    const f = readFixture(undefined, [[{ unshipped_count: 1, refunding_count: 2, refunded_count: 3, outofstock: 4, policeforce: 5 }],
      [{ after_price: '0.29', front_price: '0.28', after_number: 2, after_pay_number: 1, today_visits: 3 }]]);
    const result = await new CustomerWorkReadService(f.container, {} as Env).overview(actor(), {}, now);
    const consumed = parseCustomerWorkEnvelope(result, 42, isCustomerWorkOverview);
    expect(consumed.data.today).toEqual({ after_price: '0.29', growth_rate: 3, increase_time: '0.01', increase_time_status: 1, after_number: 2, after_pay_number: 1, today_visits: 3 });
    expect(consumed.data.badges.refund_count).toBe(5);
  });
  it('executes the actual customer trend and fills yesterday and today in the frontend contract', async () => {
    const f = readFixture(undefined, [[{ day: '2026-10-03', num: 2, price: '7.00' }]]);
    const result = await new CustomerWorkReadService(f.container, {} as Env).trend(actor(), { type: '1' }, now);
    expect(parseCustomerWorkEnvelope(result, 42, isCustomerWorkTrend).data.list).toEqual([
      { date: '2026-10-03', time: '10-03', num: 2, price: '7.00' }, { date: '2026-10-04', time: '10-04', num: 0, price: '0.00' },
    ]);
  });
  it('executes daily pagination and projects count, visits, whole-year date and has_more', async () => {
    const f = readFixture(undefined, [[{ day: '2026-10-04', count: 2, price: '7.00', add_time: now, visit: 3 }], [{ count: 11 }]]);
    const result = await new CustomerWorkReadService(f.container, {} as Env).daily(actor(), { page: '2', limit: '5' }, now);
    const consumed = parseCustomerWorkEnvelope(result, 42, isCustomerWorkPaged(isCustomerWorkDaily));
    expect(consumed.data).toEqual({ metric_scopes: CUSTOMER_WORK_SCOPES, list: [{ date: '2026-10-04', time: '10-04', count: 2, price: '7.00', add_time: now, visit: 3 }], count: 11, page: 2, limit: 5, has_more: true });
  });
});

describe('independent actual legacy calendar and refund selector helpers', () => {
  const now = Math.floor(Date.parse('2026-10-03T16:05:00Z') / 1000); // Shanghai Oct 4 00:05.
  const midnight = Math.floor(Date.parse('2026-10-03T16:00:00Z') / 1000);
  it.each([1, 7, 30] as const)('uses Shanghai day boundaries and an equal-duration prior period for %i days', type => {
    const p = parseMobileOrderPeriod(String(type), now);
    expect(p.currentStart).toBe(midnight - (type - 1) * 86400);
    expect(p.currentEndExclusive).toBe(now + 1);
    expect(p.currentStart - p.previousStart).toBe(p.currentEndExclusive - p.currentStart);
    expect(p.chartStart).toBe(type === 1 ? midnight - 86400 : p.currentStart);
  });
  it.each(['0', '2', '31', '-1', '1,7', '1.0'])('rejects unsupported period %s', value => {
    expect(() => parseMobileOrderPeriod(value, now)).toThrow();
  });
  it('preserves inclusive stop, explicit page offsets and invalid-date ordering', () => {
    const q = parseMobileOrderDataQuery({ start: String(midnight), stop: String(now), page: '2', limit: '15' }, now);
    expect(q).toEqual({ start: midnight, endExclusive: now + 1, page: 2, limit: 15, offset: 15 });
    expect(() => parseMobileOrderDataQuery({ start: String(now), stop: String(midnight) }, now)).toThrow('结束时间');
    expect(() => parseMobileOrderDataQuery({ page: '0' }, now)).toThrow();
    expect(() => parseMobileOrderDataQuery({ limit: '101' }, now)).toThrow();
  });
  it.each([
    [0, [0]], [2, [4, 5]], [5, [0, 1, 2, 4, 5]], [6, [3, 6]],
  ])('keeps refund selector %i distinct from raw order status', (selector, expected) => {
    expect(refundTypesForFilter(selector as number)).toEqual(expected);
  });
  it('executes the actual mobile chart projection and fills both Shanghai days without grouping MM-DD across years', async () => {
    const execute = vi.fn(async () => [{ bucket: '2026-10-03', num: 2, price: '7.00' }]);
    const service = new AdminStatisticService({ db: { execute } } as unknown as Container);
    await expect(service.mobileOrderTimeChart(parseMobileOrderPeriod('1', now))).resolves.toEqual([
      { time: '10-03', num: 2, price: 7 }, { time: '10-04', num: 0, price: 0 },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function contextEnvelope(profileUid = 42) {
  return {
    version: 'customer-work-read-v1', actor_uid: 42,
    principal: { kind: 'customer-order-manager', service_id: 81, scope: 'global' },
    scope_key: 'c'.repeat(64), consistency_key: 'd'.repeat(64),
    data: {
      metric_scopes: { ...CUSTOMER_WORK_SCOPES },
      profile: { uid: profileUid, nickname: 'Current operator', phone: '10000000000', avatar: '' },
      capabilities: { statistics: true, orders: true, refunds: true, logistics: true,
        product_management: false, user_management: false, assisted_order: false, writes: false },
    },
  };
}
describe('independent actual frontend envelope and route consumers', () => {
  it('validates public images without a native URL global and rejects decoded unsafe paths', () => {
    vi.stubGlobal('URL', undefined);
    for (const value of ['', '/api/assets/1', 'https://images.example.test/cart.jpg']) expect(customerWorkImage(value)).toBe(true);
    for (const value of ['/../private', '/%2e%2e/private', '/%252e%252e/private', '//external.test/a', '/%2f%2fexternal.test/a', 'https://name:pass@external.test/a', 'javascript:alert(1)']) {
      expect(customerWorkImage(value)).toBe(false);
    }
  });
  it('accepts only the bound current profile and refuses another profile under the same envelope actor', () => {
    expect(parseCustomerWorkEnvelope(contextEnvelope(), 42, isCustomerWorkContext).data.profile.uid).toBe(42);
    expect(() => parseCustomerWorkEnvelope(contextEnvelope(99), 42, isCustomerWorkContext)).toThrow();
  });
  it.each([
    ['wrong actor', (body: ReturnType<typeof contextEnvelope>) => { body.actor_uid = 99; }],
    ['wrong realm', (body: ReturnType<typeof contextEnvelope>) => { body.principal.kind = 'admin'; }],
    ['wrong data scope', (body: ReturnType<typeof contextEnvelope>) => {
      Object.assign(body.data.metric_scopes, { order_state_counts: 'global_fulfillment_orders' });
    }],
    ['unexpected writes', (body: ReturnType<typeof contextEnvelope>) => { body.data.capabilities.writes = true; }],
  ] as const)('rejects %s instead of applying a compatible-looking DTO', (_label, mutate) => {
    const body = contextEnvelope(); mutate(body);
    expect(() => parseCustomerWorkEnvelope(body, 42, isCustomerWorkContext)).toThrow();
  });
  it('rejects a cross-snapshot response when the current context authority is known', () => {
    const authority = parseCustomerWorkEnvelope(contextEnvelope(), 42, isCustomerWorkContext);
    const body = contextEnvelope(); body.consistency_key = 'e'.repeat(64);
    expect(() => parseCustomerWorkEnvelope(body, 42, isCustomerWorkContext, authority)).toThrow('数据依据已变化');
  });
  it('keeps legitimate cancelled raw-status orders readable in the all-order DTO', () => {
    const order = { id: 901, pid: 0, order_id: 'CW_CANCELLED', uid: 7, store_id: 0, supplier_id: 0,
      total_num: 1, paid: 0, status: -2, shipping_type: 1, type: 0, refund_status: 0, refund_type: 0,
      add_time: 1, pay_time: 0, total_price: '5.00', total_postage: '0.00', pay_price: '5.00', pay_postage: '0.00',
      nickname: 'Customer', real_name: '', user_phone: '', user_address: '', pay_type: 'weixin', type_name: '',
      delivery_type: '', delivery_name: '', delivery_code: '', delivery_id: '', mark: '', remark: '',
      _add_time: '', _pay_time: '', revision: 'a'.repeat(64), write_available: false,
      _status: { _type: -2, _title: '已取消', _msg: '' }, cartInfo: [], refund: [] };
    expect(isCustomerWorkOrder(order)).toBe(true);
  });
  it('preserves zero selectors and rejects duplicate aliases before they can be collapsed', () => {
    expect(parseCustomerWorkQuery('orders', 'types=0')).toEqual({ status: '0' });
    expect(parseCustomerWorkQuery('refunds', 'refundTypes=0')).toEqual({ refundTypes: '0' });
    expect(() => parseCustomerWorkQuery('orders', 'types=0&status=1')).toThrow('冲突');
    expect(() => parseCustomerWorkQuery('orders', 'status=0&status=1')).toThrow('重复');
    expect(() => parseCustomerWorkQuery('index', 'uid=99')).toThrow();
    expect(() => parseCustomerWorkQuery('orderDetail', 'id=CW_42&orderId=CW_99')).toThrow('冲突');
  });
  it.each([
    ['index', '/pages/admin/work/index', ''], ['statistics', '/pages/admin/order/index', 'type=7'],
    ['orders', '/pages/admin/orderList/index', 'types=0'], ['orderDetail', '/pages/admin/orderDetail/index', 'id=CW_42'],
    ['refunds', '/pages/admin/refundOrderList/index', 'refundTypes=0'], ['refundDetail', '/pages/admin/refundOrderDetail/index', 'id=RF_42'],
    ['logistics', '/pages/admin/logistics/index', 'id=CW_42'],
  ])('resolves both actual and legacy %s routes through the same strict query parser', (page, legacy, query) => {
    const actual = resolveCustomerWorkPageRoute(`/pages/customer-work/${page}`, query);
    expect(actual).toMatch(new RegExp(`^/pages/customer-work/${page}(?:\\?|$)`));
    expect(resolveCustomerWorkPageRoute(legacy, query)).toBe(actual);
    expect(resolveCustomerWorkPageRoute(legacy, `${query}${query ? '&' : ''}token=stale`)).toBe('');
  });
});

// Actual seven SFC setup bodies, their shared composable, request transport and
// DTO validators remain bundled from source. Only lifecycle registration, auth
// storage, navigation and UniApp network delivery are controlled boundaries.
// This checks method wiring and late delivery, not DOM or a native device.
describe('independent actual customer SFC and UserJWT request lifecycle', () => {
  // Use the existing physical UniApp dependency rehearsal. The main checkout's
  // empty node_modules is deliberately not installed or replaced for this test.
  const frontendRequire = createRequire(resolve('../.cache/worktrees/uniapp-dependency-rehearsal-20260925/view/uniapp-ts/package.json'));
  const vue = frontendRequire('vue') as typeof import('../../view/kefu-ts/node_modules/vue');
  const code = new Map<CustomerWorkPage, string>();
  beforeAll(async () => {
    const compiler = frontendRequire('@vue/compiler-sfc');
    for (const page of ['index', 'statistics', 'orders', 'orderDetail', 'refunds', 'refundDetail', 'logistics'] as CustomerWorkPage[]) {
      const path = resolve(`../view/uniapp-ts/src/pages/customer-work/${page}.vue`);
      const descriptor = compiler.parse(await readFile(path, 'utf8'), { filename: path }).descriptor;
      const compiled = compiler.compileScript(descriptor, { id: `independent-customer-${page}` }).content;
      const built = await build({
        stdin: { contents: compiled + '\nexport { createCustomerWorkRequests } from "@/api/customerWork";', loader: 'ts', resolveDir: resolve('../view/uniapp-ts/src/pages/customer-work'), sourcefile: `actual-${page}.ts` },
        bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
        plugins: [{ name: 'independent-uniapp-transport-boundaries', setup(plugin) {
          plugin.onResolve({ filter: /^vue$|^@dcloudio\/uni-app$|^@\/stores\/auth$|^@\/utils\/request$|\.vue$/ }, args => ({ path: args.path, namespace: 'customer-boundary' }));
          plugin.onLoad({ filter: /.*/, namespace: 'customer-boundary' }, args => ({ loader: 'js', contents:
            args.path === 'vue' ? 'module.exports=globalThis.__independentCustomerPage.vue;'
            : args.path === '@dcloudio/uni-app' ? ['onLoad','onShow','onHide','onUnload','onReachBottom'].map(name => `export const ${name}=callback=>globalThis.__independentCustomerPage.hooks.${name}.push(callback);`).join('')
            : args.path === '@/stores/auth' ? 'export const useAuthStore=()=>globalThis.__independentCustomerPage.auth;'
            : args.path === '@/utils/request' ? 'export const API_BASE="https://shop.example.test";export const getFormType=()=>"h5";export class RequestError extends Error {constructor(message,status,unused,httpStatus){super(message);this.status=status;this.httpStatus=httpStatus;}}'
            : 'export default {};' }));
          plugin.onResolve({ filter: /^@\// }, args => ({ path: resolve('../view/uniapp-ts/src', args.path.slice(2)) + '.ts' }));
        } }],
      });
      code.set(page, built.outputFiles[0].text);
    }
  }, 30_000);
  interface NetworkRequest {
    url: string; method: string; data: Record<string, unknown>; header: Record<string,string>;
    success(response: { statusCode: number; data: unknown }): void;
    fail(response: { errMsg: string }): void;
  }
  async function settle() { await vue.nextTick(); await new Promise<void>(done => setImmediate(done)); await vue.nextTick(); }
  function fixture(page: CustomerWorkPage = 'index', query: Record<string,unknown> = {}, rawHash?: string) {
    const hooks = { onLoad: [] as Array<(query: Record<string,unknown>) => void>, onShow: [] as Array<() => void>,
      onHide: [] as Array<() => void>, onUnload: [] as Array<() => void>, onReachBottom: [] as Array<() => void> };
    const pending: Array<{ options: NetworkRequest; abort: ReturnType<typeof vi.fn> }> = [];
    const auth = vue.reactive({ uid: 42, token: 'independent-user-token', sessionVersion: 1, isLoggedIn: true,
      clear: vi.fn(() => { auth.uid = 0; auth.token = ''; auth.sessionVersion++; auth.isLoggedIn = false; }) });
    const navigateTo = vi.fn(), navigateBack = vi.fn(), switchTab = vi.fn();
    vi.stubGlobal('uni', { navigateTo, navigateBack, switchTab, request(options: NetworkRequest) {
      const abort = vi.fn(); pending.push({ options, abort }); return { abort };
    } });
    if (rawHash !== undefined) vi.stubGlobal('window', { location: { hash: rawHash } });
    vi.stubGlobal('__independentCustomerPage', { vue, auth, hooks });
    const loaded = { exports: {} as { default: { setup(props: unknown, context: unknown): Record<string, any> };
      createCustomerWorkRequests(current: () => boolean, deadline?: number): { owner: { uid:number }; active():boolean; abort():void; request(path:string, data?:Record<string,unknown>):Promise<unknown> } } };
    new Function('module', 'exports', 'require', code.get(page)!)(loaded, loaded.exports, frontendRequire);
    const effect = vue.effectScope(), state = effect.run(() => loaded.exports.default.setup({}, { expose() {} }))!;
    const enter = () => { hooks.onLoad.forEach(fn => fn(query)); hooks.onShow.forEach(fn => fn()); };
    function respond(index: number, value: unknown, status = 200) {
      const request = pending[index]; if (!request) throw Error(`Missing actual request ${index}`);
      request.options.success({ statusCode: 200, data: { status, data: value, msg: 'independent fixture' } });
    }
    return { state, auth, pending, hooks, enter, respond, navigateTo, api: loaded.exports.createCustomerWorkRequests,
      cleanup() { hooks.onUnload.forEach(fn => fn()); effect.stop(); } };
  }
  const summary = () => ({ after_price: '12.00', growth_rate: 0, increase_time: '0.00', increase_time_status: 1, after_number: 2, after_pay_number: 1, today_visits: 3 });
  const overview = () => ({ metric_scopes: { ...CUSTOMER_WORK_SCOPES }, today: summary(), badges: { unshipped_count: 1, refunding_count: 0, refunded_count: 0, refund_count: 0, outofstock: 0, policeforce: 1 } });
  const counters = () => ({ order_count: 2, sum_price: '12.00', unpaid_count: 0, unshipped_count: 1, received_count: 0, evaluated_count: 0, unwritoff_count: 0, complete_count: 1, refunding_count: 0, refunded_count: 0, refund_count: 0, todayPrice: '12.00', todayCount: 2, proPrice: '0.00', proCount: 0, monthPrice: '12.00', monthCount: 2 });
  const envelope = (data: unknown) => ({ ...contextEnvelope(), data });
  const pageRows = (list: unknown[] = [], page = 1, more = false) => ({ metric_scopes: { ...CUSTOMER_WORK_SCOPES }, list, count: more ? 20 : list.length, page, limit: 10, has_more: more });
  const orderRow = () => ({ id: 901, pid: 0, order_id: 'CW_42', uid: 7, store_id: 0, supplier_id: 0,
    total_num: 1, paid: 0, status: -2, shipping_type: 1, type: 0, refund_status: 0, refund_type: 0,
    add_time: 1, pay_time: 0, total_price: '5.00', total_postage: '0.00', pay_price: '5.00', pay_postage: '0.00',
    nickname: 'Customer', real_name: '', user_phone: '', user_address: '', pay_type: 'weixin', type_name: '',
    delivery_type: '', delivery_name: '', delivery_code: '', delivery_id: '', mark: '', remark: '',
    _add_time: '', _pay_time: '', revision: 'a'.repeat(64), write_available: false,
    _status: { _type: -2, _title: '已取消', _msg: '' }, cartInfo: [], refund: [] });
  const refundRow = () => ({ id: 902, order_id: 'RF_42', store_order_id: 901, store_order_sn: 'CW_42', uid: 7,
    apply_type: 0, refund_type: 0, refund_price: '1.00', refunded_price: '0.00', refund_num: 1,
    refund_reason: '', refund_explain: '', refuse_reason: '', remark: '', add_time: 1, _add_time: '',
    _status: { status_name: '待审核' }, cartInfo: [], write_available: false });
  const orderDetail = () => ({ ...orderRow(), metric_scopes: { ...CUSTOMER_WORK_SCOPES },
    customer: { uid: 7, nickname: 'Customer', avatar: '' }, vip_true_price: '0.00', custom_form: null,
    refund_img: [], refund_goods_img: [], refund_reason_wap: '', refund_reason_wap_explain: '', refund_reason_time: 0, split: [] });
  const refundDetail = () => ({ ...refundRow(), metric_scopes: { ...CUSTOMER_WORK_SCOPES }, real_name: '', user_phone: '', user_address: '',
    refund_express: '', refund_express_name: '', refund_phone: '', refund_img: [], refund_goods_img: [] });
  const logistics = () => ({ metric_scopes: { ...CUSTOMER_WORK_SCOPES }, orderId: 'CW_42', deliveryStatus: '', expressName: '', expressCode: '', expressNo: '',
    trackingState: 'not_configured', trackingSource: 'merchant', lastUpdatedAt: 0, message: '尚未配置物流服务', traces: [], packages: [],
    order: { order_id: 'CW_42', delivery_id: '', delivery_name: '', delivery_code: '', delivery_type: '' } });

  it('uses only the captured UserJWT GET scope and refuses write or Admin URLs', async () => {
    const f = fixture();
    try {
      const request = f.api(() => true);
      const pending = request.request('/mobile/work/orders', { status: '0' });
      expect(f.pending[0].options.method).toBe('GET');
      expect(f.pending[0].options.header['Authori-zation']).toBe('Bearer independent-user-token');
      expect(f.pending[0].options.data).toEqual({ status: '0' });
      f.respond(0, { list: [] }); await expect(pending).resolves.toEqual({ list: [] });
      await expect(request.request('/admin/order/list')).rejects.toThrow('地址');
      await expect(request.request('/mobile/work/orders/CW_42/shipping')).rejects.toThrow('地址');
      expect(f.pending).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  it('does not clear a new login when an old login response reports expiry', async () => {
    const f = fixture();
    try {
      const scope = f.api(() => true), pending = scope.request('/mobile/work/context');
      const rejected = expect(pending).rejects.toThrow('状态已变化');
      f.auth.sessionVersion++;
      f.respond(0, null, 410000); await rejected;
      expect(f.auth.clear).not.toHaveBeenCalled(); expect(f.pending[0].abort).toHaveBeenCalledTimes(1);
    } finally { f.cleanup(); }
  });
  it('aborts timed out requests and ignores later network delivery', async () => {
    const f = fixture(); vi.useFakeTimers();
    try {
      const scope = f.api(() => true, 20), pending = scope.request('/mobile/work/context');
      const rejected = expect(pending).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(21); await rejected;
      expect(f.pending[0].abort).toHaveBeenCalledTimes(1);
      f.respond(0, contextEnvelope()); expect(f.auth.clear).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  });
  it('applies overview through the actual context/read guards and clears it on hide', async () => {
    const f = fixture();
    try {
      f.enter(); expect(f.state.manager.loading.value).toBe(true); f.respond(0, contextEnvelope()); await settle();
      expect(f.pending[1].options.url).toContain('/mobile/work/overview');
      expect(f.pending[1].options.data).toEqual({ scope_key: 'c'.repeat(64) });
      f.respond(1, envelope(overview())); await settle();
      expect(f.state.overview.value.today.after_price).toBe('12.00'); expect(f.state.manager.loading.value).toBe(false);
      f.state.manager.go('orders', { types: 0 }); expect(f.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: '/pages/customer-work/orders?status=0' }));
      f.hooks.onHide.forEach(fn => fn()); expect(f.state.overview.value).toBeNull(); expect(f.state.manager.context.value).toBeNull();
    } finally { f.cleanup(); }
  });
  it('withholds overview already in flight after a same-UID credential revision', async () => {
    const f = fixture();
    try {
      f.enter(); f.respond(0, contextEnvelope()); await settle(); f.auth.sessionVersion++; await settle();
      expect(f.pending[1].abort).toHaveBeenCalledTimes(1); f.respond(1, envelope(overview())); await settle();
      expect(f.state.overview.value).toBeNull(); expect(f.state.manager.context.value).toBeNull();
    } finally { f.cleanup(); }
  });
  it('does not fetch a query whose raw H5 aliases conflict before UniApp collapses them', async () => {
    const f = fixture('orders', { types: '0' }, '#/pages/customer-work/orders?types=0&status=1');
    try { f.enter(); await settle(); expect(f.pending).toHaveLength(0); expect(f.state.manager.error.value).toContain('冲突'); }
    finally { f.cleanup(); }
  });
  it('accepts yesterday and today for type=1 and wires real statistics/trend/daily page methods', async () => {
    const f = fixture('statistics');
    try {
      f.enter(); f.respond(0, contextEnvelope()); await settle();
      f.respond(1, envelope({ metric_scopes: { ...CUSTOMER_WORK_SCOPES }, type: 1, summary: summary(), counters: counters() })); await settle();
      f.respond(2, envelope({ metric_scopes: { ...CUSTOMER_WORK_SCOPES }, type: 1, list: [
        { date: '2026-10-03', time: '10-03', num: 0, price: '0.00' }, { date: '2026-10-04', time: '10-04', num: 2, price: '12.00' },
      ] })); await settle();
      expect(f.pending[3].options.url).toContain('/mobile/work/statistics/orders');
      f.respond(3, envelope(pageRows([{ date: '2026-10-04', time: '10-04', price: '12.00', count: 2, visit: 3, add_time: 1791043200 }]))); await settle();
      expect(f.state.statistics.value.summary.after_number).toBe(2); expect(f.state.trend.value.list).toHaveLength(2);
      expect(f.state.rows.value).toHaveLength(1); expect(f.state.manager.error.value).toBe('');
      f.state.choosePeriod({ detail: { value: 1 } }); await settle(); expect(f.state.periodIndex.value).toBe(1);
      expect(f.state.statistics.value).toBeNull(); expect(f.pending[4].options.url).toContain('/mobile/work/context');
    } finally { f.cleanup(); }
  });
  it.each([
    { page: 'orders' as const, query: { types: '0' }, filter: 'status', row: orderRow, target: 'orderDetail', idKey: 'orderId', id: 'CW_42' },
    { page: 'refunds' as const, query: { refundTypes: '0' }, filter: 'refundTypes', row: refundRow, target: 'refundDetail', idKey: 'refundOrderId', id: 'RF_42' },
  ])('executes the actual $page list selector, DTO application and detail navigation', async input => {
    const f = fixture(input.page, input.query);
    try {
      f.enter(); f.respond(0, contextEnvelope()); await settle();
      expect(f.pending[1].options.data[input.filter]).toBe('0');
      f.respond(1, envelope(pageRows([input.row()]))); await settle();
      expect(f.state.rows.value[0].id).toBe(input.row().id); expect(f.state.count.value).toBe(1);
      f.state.manager.go(input.target, { [input.idKey]: input.id });
      expect(f.navigateTo).toHaveBeenCalledWith(expect.objectContaining({ url: `/pages/customer-work/${input.target}?${input.idKey}=${input.id}` }));
      f.hooks.onHide.forEach(fn => fn()); expect(f.state.rows.value).toEqual([]); expect(f.state.count.value).toBe(0);
    } finally { f.cleanup(); }
  });
  it.each([
    { page: 'orderDetail' as const, query: { orderId: 'CW_42' }, path: '/orders/CW_42', state: 'order', data: orderDetail },
    { page: 'refundDetail' as const, query: { refundOrderId: 'RF_42' }, path: '/refunds/RF_42', state: 'refund', data: refundDetail },
    { page: 'logistics' as const, query: { orderId: 'CW_42' }, path: '/orders/CW_42/logistics', state: 'logistics', data: logistics },
  ])('executes the actual $page bound business-ID reader and clears private data on hide', async input => {
    const f = fixture(input.page, input.query);
    try {
      f.enter(); f.respond(0, contextEnvelope()); await settle(); expect(f.pending[1].options.url).toContain(input.path);
      f.respond(1, envelope(input.data())); await settle();
      expect(f.state[input.state].value).toEqual(input.data()); expect(f.state.manager.error.value).toBe('');
      f.hooks.onHide.forEach(fn => fn()); expect(f.state[input.state].value).toBeNull();
    } finally { f.cleanup(); }
  });
  it('rejects a valid-looking order detail for another business ID through the actual SFC', async () => {
    const f = fixture('orderDetail', { orderId: 'CW_42' });
    try {
      f.enter(); f.respond(0, contextEnvelope()); await settle(); f.respond(1, envelope({ ...orderDetail(), order_id: 'CW_99' })); await settle();
      expect(f.state.order.value).toBeNull(); expect(f.state.manager.context.value).toBeNull(); expect(f.state.manager.error.value).toContain('编号不匹配');
    } finally { f.cleanup(); }
  });
  it('clears the whole order list on a duplicate pagination response rather than retaining partial private data', async () => {
    const f = fixture('orders');
    try {
      f.enter(); f.respond(0, contextEnvelope()); await settle(); f.respond(1, envelope(pageRows([orderRow()], 1, true))); await settle();
      const pending = f.state.more(); await settle(); expect(f.pending[2].options.data.page).toBe(2);
      f.respond(2, envelope(pageRows([orderRow()], 2, true))); await pending; await settle();
      expect(f.state.rows.value).toEqual([]); expect(f.state.manager.context.value).toBeNull(); expect(f.state.manager.error.value).toContain('列表已变化');
    } finally { f.cleanup(); }
  });
});
