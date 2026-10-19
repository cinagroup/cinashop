import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import type { Sql } from 'postgres';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeProduct, systemAdmin, systemRole, user, userAddress, storeSeckill } from '@/models/schema';
import { supplierOrderFiltersFixture } from './helpers/supplierOrderFilters';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned filters HTTP reader'); return wiring.container;
} }));
type Envelope = { status: number; msg: string; data: any };
const app = createApp();
function afterHeader(callback: (client: Sql) => Promise<void>) {
  let reached = false; const actual = PostgresJsSession.prototype.prepareQuery;
  const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
    const prepared = actual.apply(this, args);
    if (/^select .* from "store_order" where /s.test(args[0].sql) && !args[0].sql.includes('COUNT(')) {
      const execute = prepared.execute.bind(prepared);
      prepared.execute = async values => { const result = await execute(values); if (!reached) { reached = true; await callback(this.client); } return result; };
    }
    return prepared;
  });
  return () => { spy.mockRestore(); expect(reached).toBe(true); };
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier complete order filters actual App/JWT owned SELECT-only PG16', () => {
  let f: Awaited<ReturnType<typeof supplierOrderFiltersFixture>>;
  beforeEach(async () => { f = await supplierOrderFiltersFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Order filtering must not invoke provider')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { wiring.container = undefined; await f?.close(); vi.restoreAllMocks(); } }, 30000);
  async function request(query = '', actor: keyof typeof f.tokens | 'anonymous' = 'viewer') {
    const response = await app.request('/supplierapi/order/list' + (query ? '?' + query : ''), { headers: actor === 'anonymous' ? {}
      : { Authorization: 'Bearer ' + f.tokens[actor], 'X-Supplier-Id': '8' } }, f.env);
    return response.json<Envelope>();
  }
  async function unchanged<T>(work: () => Promise<T>) { const state = await f.snapshot(), seq = await f.sequences(); const result = await work();
    expect(await f.snapshot()).toEqual(state); expect(await f.sequences()).toEqual(seq); return result; }
  async function read(params: Record<string, string> = {}) {
    const result = await unchanged(() => request(new URLSearchParams({ limit: '100', ...params }).toString()));
    expect(result.status, result.msg).toBe(200); expect(result.data.list.length).toBeLessThanOrEqual(Number(params.limit ?? 100)); return result.data as { list: Array<{ id: number; type: number; is_del: number }>; count: number; page: number; limit: number };
  }
  const ids = (data: { list: Array<{ id: number }> }) => data.list.map(row => row.id);

  it('uses a genuine independent SELECT-only LOGIN and keeps every row and sequence unchanged during complete catalog search', async () => f.withReader(async peer => {
    wiring.container = peer.container; const result = await read({ field_key: 'all' }); expect(ids(result)).toEqual(f.visibleIds); expect(result.count).toBe(24);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-ADDRESS|custom_form|virtual_info|trade_no|pwd|ownerUid/);
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns,
      has_schema_privilege(current_user,'public','CREATE') AS creates,
      has_table_privilege(current_user,'store_order','UPDATE') AS order_author,
      has_any_column_privilege(current_user,'store_product','UPDATE') AS product_author,
      has_table_privilege(current_user,'system_admin','UPDATE') AS auth_author,
      has_table_privilege(current_user,'system_form_data','SELECT') AS answers`);
    expect(rights).toEqual({ independent: true, owns: 0, creates: false, order_author: false, product_author: false, auth_author: false, answers: false });
  }));

  it('keeps legacy raw status and three-field wildcard search separate from explicit business status and all-catalog opt-in', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    expect(ids(await read({ status: '1' }))).toEqual([301, 202, 201, 123, 120, 104, 103, 102, 100]);
    expect(ids(await read({ business_status: '1' }))).toEqual([127, 118, 117, 116, 115, 114, 113, 112, 111, 110]);
    expect(ids(await read({ order: '当前买家昵称' }))).toEqual([]);
    expect(ids(await read({ order: '当前买家昵称', field_key: 'all' }))).toEqual(f.visibleIds);
    expect(ids(await read({ order: '%' }))).toEqual(f.visibleIds);
    expect(ids(await read({ order: '%', field_key: 'all' }))).toEqual([]);
    expect(ids(await read({ real_name: '筛选客户7', order: 'no-such' }))).toEqual([117]);
  }));

  it('matches the complete14 shared PHP business selectors without using raw status as their meaning', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const expected: Record<string, number[]> = { 0: [119], 1: [127,118,117,116,115,114,113,112,111,110],
      2: [301,202,201,125,120,104,103,102,100], 3: [121], 4: [122], 5: [125], 6: [], 7: [127,117], 8: [125], 9: [122,121], '-1': [], '-2': [], '-3': [], '-4': [123] };
    for (const [selector, matching] of Object.entries(expected)) { const result = await read({ business_status: selector }); expect(ids(result), selector).toEqual(matching); expect(result.count).toBe(matching.length); }
    // Selector2 intentionally does not infer shipping_type3 from display labels.
    expect(ids(await read({ business_status: '2' }))).not.toContain(126);
    for (const [refund, selectors] of [[1,['-1','-3']],[2,['-2','-3']],[4,['-1','-3']]] as const) {
      await f.db.update(storeOrder).set({ paid: 1, refundStatus: refund }).where(eq(storeOrder.id, 119));
      for (const selector of selectors) expect(ids(await read({ business_status: selector }))).toEqual([119]);
    }
  }));

  it('filters all nine order activity types and actual shipping aliases without confusing them with product_type', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (let type = 0; type <= 8; type++) { const result = await read({ type: String(type) }); expect(ids(result)).toContain(110 + type); expect(result.list.every(row => row.type === type)).toBe(true); }
    expect(ids(await read({ type: '105' }))).toEqual([125]);
    expect(ids(await read({ type: '106' }))).toEqual([]);
    expect(ids(await read({ type: '107' }))).toEqual(f.visibleIds.filter(id => id !== 125));
  }));

  it('maps PHP numeric payment values and preserves real named values including inherited-object property names as strings', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const [alias, name] of [['1','weixin'],['2','yue'],['3','offline'],['4','alipay'],['5','integral']]) {
      const numeric = await read({ pay_type: alias }), named = await read({ pay_type: name }); expect(numeric).toEqual(named); expect(numeric.count).toBeGreaterThan(0);
    }
    for (const name of ['constructor','__proto__','toString']) expect(await read({ pay_type: name })).toMatchObject({ list: [], count: 0 });
  }));

  it('uses five exact fields and exact integer quantities while all remains a literal fuzzy search', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const [field, keyword] of [['order_id','FILTER-TYPE-7'],['real_name','筛选客户7'],['total_num','8']]) expect(ids(await read({ field_key: field, real_name: keyword }))).toEqual([117]);
    expect(ids(await read({ field_key: 'real_name', order: '筛选客户' }))).toEqual([]);
    expect(ids(await read({ field_key: 'uid', order: '11' }))).toEqual(f.visibleIds);
    expect(ids(await read({ field_key: 'user_phone', order: '13800138000' }))).toEqual(f.visibleIds);
    expect(ids(await read({ field_key: 'user_phone', order: '138' }))).toEqual([]);
    expect(ids(await read({ field_key: 'all', order: '筛选客户' }))).toEqual([118,117,116,115,114,113,112,111,110]);
    expect(ids(await read({ field_key: 'all', order: f.expected.addressName }))).toEqual(f.visibleIds);
    expect(ids(await read({ field_key: 'all', order: '13955556666' }))).toEqual(f.visibleIds);
    expect(ids(await read({ field_key: 'all', order: '13999990000' }))).toEqual(f.visibleIds);
  }));

  it('searches actual current product name or keyword rather than frozen cart JSON and sees a later catalog rename', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    expect(ids(await read({ field_key: 'title', order: f.expected.currentTitle }))).toEqual([110,100]);
    expect(ids(await read({ field_key: 'title', order: '目录关键词' }))).toEqual([110,100]);
    expect(ids(await read({ field_key: 'title', order: '冻结历史商品标题' }))).toEqual([]);
    const [old] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1101));
    await f.db.update(storeProduct).set({ storeName: '实际更名商品', keyword: '' }).where(eq(storeProduct.id, 70));
    expect(ids(await read({ field_key: 'all', order: f.expected.currentTitle }))).toEqual([]);
    expect(ids(await read({ field_key: 'title', order: '实际更名商品' }))).toEqual([110,100]);
    expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1101)))[0]).toEqual(old);
  }));

  it('keeps legitimate platform-product and fully legacy cart relations searchable without exposing foreign catalog lineage', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeProduct).set({ type: 0, relationId: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0 }).where(eq(storeOrderCartInfo.id, 1101));
    expect(ids(await read({ field_key: 'title', order: f.expected.currentTitle }))).toEqual([110,100]);
    await f.db.update(storeProduct).set({ type: 2, relationId: 8 }).where(eq(storeProduct.id, 70));
    expect(ids(await read({ field_key: 'title', order: f.expected.currentTitle }))).toEqual([]);
    expect(ids(await read({ field_key: 'all', order: '外店私有商品' }))).toEqual([]);
  }));

  it('does not accept a single legacy cart when another row makes the full order legacy ownership inconsistent', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0 }).where(eq(storeOrderCartInfo.id, 1101));
    expect(ids(await read({ field_key: 'title', order: f.expected.currentTitle }))).toEqual([110,100]);
    await f.db.insert(storeOrderCartInfo).values({ id: 1102, oid: 110, uid: 11, type: 2, relationId: 8, productId: 80,
      cartId: '1102', cartNum: 1, cartInfo: '{}' });
    expect(ids(await read({ field_key: 'title', order: f.expected.currentTitle }))).toEqual([100]);
  }));

  it.each([{ patch: { uid: 12 } }, { patch: { relationId: 8 } }, { patch: { type: 1 } }])('does not use an incoherent cart to make an owned order match another identity $patch', async ({ patch }) => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderCartInfo).set(patch).where(eq(storeOrderCartInfo.id, 1101));
    expect(ids(await read({ field_key: 'title', order: f.expected.currentTitle }))).toEqual([100]);
  }));

  it('uses typed current activity metadata and does not match equal activity IDs belonging to another activity or private tenant', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const [keyword, id] of [['当前秒杀活动',111],['当前砍价活动',112],['当前拼团活动',113],['秒杀检索说明',111],['砍价检索说明',112],['拼团检索说明',113]] as const)
      expect(ids(await read({ field_key: 'all', order: keyword }))).toEqual([id]);
    await f.db.update(storeSeckill).set({ relationId: 8 }).where(eq(storeSeckill.id, 71));
    expect(ids(await read({ field_key: 'all', order: '当前秒杀活动' }))).toEqual([]);
    await f.db.update(storeSeckill).set({ type: 0, relationId: 0 }).where(eq(storeSeckill.id, 71));
    expect(ids(await read({ field_key: 'all', order: '当前秒杀活动' }))).toEqual([111]);
    await f.db.update(user).set({ nickname: '当前更名买家' }).where(eq(user.uid, 11));
    await f.db.update(userAddress).set({ realName: '当前地址更名' }).where(eq(userAddress.id, 11));
    expect(ids(await read({ field_key: 'all', order: f.expected.userNickname }))).toEqual([]);
    expect(ids(await read({ field_key: 'all', order: '当前更名买家' }))).toEqual(f.visibleIds);
    expect(ids(await read({ field_key: 'all', order: '当前地址更名' }))).toEqual(f.visibleIds);
  }));

  it('combines paid, activity, business stage, mapped payment, exact field and closed epoch bounds into one count/list predicate', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect(ids(await read({ ...f.expected.comboQuery, paid: '1' }))).toEqual([117]);
    expect(ids(await read({ ...f.expected.comboQuery, end_time: '1700000699', start_time: '1700000600' }))).toEqual([]);
    expect(ids(await read({ start_time: '1700000700', end_time: '1700000700' }))).toEqual([117]);
    expect(ids(await read({ end_time: '0' }))).toEqual([301,202,201,104,103,102,100]);
    const lower = await read({ start_time: '1700000700' }); expect(ids(lower)).toContain(117); expect(ids(lower)).not.toContain(116);
    expect(await read({ start_time: '2147483647' })).toMatchObject({ list: [], count: 0 });
  }));

  it('preserves exact physical pagination and the same total on empty later pages without returning payment parents or foreign rows', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const first = await read({ field_key: 'all', page: '1', limit: '10' }), second = await read({ field_key: 'all', page: '2', limit: '10' }), third = await read({ field_key: 'all', page: '3', limit: '10' });
    expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(f.visibleIds);
    expect([first.count, second.count, third.count]).toEqual([24,24,24]);
    expect(await read({ page: '4', limit: '10' })).toMatchObject({ list: [], count: 24, page: 4, limit: 10 });
    expect(first.list.every(row => Number.isInteger(row.type) && [0,1].includes(row.is_del))).toBe(true);
  }));

  it('finds only coherent owned current children by exact own or platform payment number without returning parent private columns', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const field_key of ['order_id','all']) {
      expect(ids(await read({ field_key, order: f.expected.rootNumber }))).toEqual([202,201]);
      expect(ids(await read({ field_key, order: f.expected.platformNumber }))).toEqual([301]);
      expect(ids(await read({ field_key, order: 'tracking-child-201' }))).toEqual([201]);
      expect(ids(await read({ field_key, order: 'tracking-own-900' }))).toEqual([]);
    }
    expect(ids(await read({ order: f.expected.rootNumber }))).toEqual([]);
    expect(ids(await read({ field_key: 'real_name', order: f.expected.rootNumber }))).toEqual([]);
    expect(ids(await read({ field_key: 'order_id', order: f.expected.rootNumber, business_status: '1' }))).toEqual([]);
  }));

  it.each([{ label: 'buyer', patch: { uid: 12 } }, { label: 'store', patch: { storeId: 2 } }, { label: 'tenant', patch: { supplierId: 8 } },
    { label: 'not a root', patch: { pid: 400 } }, { label: 'deleted', patch: { isSystemDel: 1 } }])('does not discover children through incoherent parent $label', async ({ patch }) => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 200));
    for (const field_key of ['order_id','all']) {
      // A non-root200 now belongs to the mature pid>=0 flat list itself; its
      // exact own number still matches, while the old children never expand.
      const found = ids(await read({ field_key, order: f.expected.rootNumber }));
      expect(found).toEqual('pid' in patch ? [200] : []); expect(found).not.toContain(201); expect(found).not.toContain(202);
    }
  }));

  it.each([{ patch: { storeId: 2 } }, { patch: { supplierAllocationStatus: 1 } }, { patch: { supplierId: 8 } }])('requires actual platform allocation authority rather than any foreign parent $patch', async ({ patch }) => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 300));
    expect(ids(await read({ field_key: 'order_id', order: f.expected.platformNumber }))).toEqual([]);
  }));

  it('keeps list and exact total in the same real read-only snapshot while another PG connection commits a matching-state change', async () => f.withReader(async peer => {
    wiring.container = peer.container; const before = await read({ type: '7', business_status: '1' }); expect(ids(before)).toEqual([117]);
    let committed: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const restore = afterHeader(async client => {
      const [settings] = await client.unsafe("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout");
      expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' });
      await f.db.update(storeOrder).set({ status: 3 }).where(eq(storeOrder.id, 117)); committed = await f.snapshot();
    });
    try { const actual = await request('limit=100&type=7&business_status=1'); expect(actual.status, actual.msg).toBe(200); expect(actual.data).toEqual(before); } finally { restore(); }
    expect(await f.snapshot()).toEqual(committed); expect(await read({ type: '7', business_status: '1' })).toMatchObject({ list: [], count: 0 });
  }));

  it('performs parent discovery with scalar SQL EXISTS and no independent private parent lookup or whole-order projection', async () => f.withReader(async peer => {
    const queries: string[] = [], db = drizzle((peer.db as unknown as { $client: Sql }).$client, { logger: { logQuery(query) { queries.push(query); } } }) as unknown as DbClient;
    wiring.container = createContainerFromDb(db); expect(ids(await read({ field_key: 'order_id', order: f.expected.rootNumber }))).toEqual([202,201]);
    const business = queries.filter(query => query.includes('from "store_order"')); expect(business).toHaveLength(2);
    for (const query of business) { expect(query).toContain('EXISTS(SELECT 1 FROM public.store_order r'); expect(query).toContain('"store_order"."supplier_id"'); expect(query).not.toMatch(/custom_form|virtual_info|user_address|trade_no|express_dump/); }
  }));

  it('refuses invalid selectors duplicate values and malformed bounds before any business row or sequence changes', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const bad = ['business_status=10','business_status=-5','business_status=01','business_status=1&status=0','status=6','paid=2','type=9','type=01','type=-1','pay_type=6','pay_type=01',
      'field_key=private','field_key=legacy','field_key=uid&order=0','field_key=uid&order=1.2','field_key=uid&order=2147483648','field_key=total_num&order=-1',
      'start_time=-1','start_time=01','start_time=2147483648','start_time=1.5','start_time=1e3','end_time=Infinity','start_time=2&end_time=1','page=0','limit=101',
      'type=1&type=1','field_key=all&field_key=title','business_status=1&business_status=1','start_time=0&start_time=0','pay_type=1&pay_type=2','real_name=a&real_name=b',
      'order='+encodeURIComponent('x'.repeat(257)),'order='+encodeURIComponent('a\nb')];
    for (const query of bad) { const result = await unchanged(() => request(query)); expect(result.status, query).toBe(400); }
  }));

  it.each(['anonymous','denied','admin','customer','kefu'] as const)('denies %s without broadening catalogs or changing data', async actor => f.withReader(async peer => {
    wiring.container = peer.container; const result = await unchanged(() => request('field_key=all&order=当前买家昵称', actor)); expect(result.status).not.toBe(200);
  }));

  it('uses actual token tenant instead of client supplier_id and rejects revoked role or changed password', async () => f.withReader(async peer => {
    wiring.container = peer.container; const foreign = await unchanged(() => request('field_key=order_id&order=FILTER-TYPE-7&supplier_id=7', 'foreign')); expect(foreign.data).toMatchObject({ list: [], count: 0 });
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 22)); expect((await unchanged(() => request('field_key=all'))).status).not.toBe(200);
    await f.db.update(systemRole).set({ status: 1 }).where(eq(systemRole.id, 22)); await f.db.update(systemAdmin).set({ pwd: 'changed' }).where(eq(systemAdmin.id, 22));
    expect((await unchanged(() => request('field_key=all'))).status).not.toBe(200);
  }));

  it('does not disguise missing current-catalog SELECT privilege as an empty successful all search', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.exec(`REVOKE SELECT ON public.user_address FROM "${peer.role}"`);
    const result = await unchanged(() => request('field_key=all&order=地址联系人')); expect(result.status).not.toBe(200);
    // Legacy callers do not suddenly require the additional current catalogs.
    expect(ids(await read({ order: 'FILTER-TYPE-7' }))).toEqual([117]);
  }));
});
