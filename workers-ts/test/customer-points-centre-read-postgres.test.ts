import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemConfig, user, userBill, userSign, userSpread } from '@/models/schema';
import { ApiErrorCode } from '@/utils/errors';
import { diyFooterBrowserFixture } from './helpers/diyFooterBrowserFixture';
import { sortedDiyState, type DiyStateSnapshot } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned points-centre fixture'); return wiring.container;
} }));

const NOW = new Date('2026-10-25T04:00:00.000Z'), now = Math.floor(NOW.getTime() / 1000);
const seconds = (date: string) => Math.floor(Date.parse(date) / 1000);
const settings = ['sign_status','sign_in_switch','sign_give_point','sign_in_integral','sign_mode','sign_give_exp','sign_remind','member_func_status','member_card_status','integral_effective_status','integral_effective_time'];
type Envelope = { status: number; msg: string; data: unknown };
type Row = Record<string, unknown>;
type Ledger = { list: Row[]; count: number; times: string[] };
type Bill = typeof userBill.$inferInsert;
const financeRoutes: Array<{path:string;input?:Row}> = [
  {path:'/integral/list'}, {path:'/extract/bank'}, {path:'/spread/order',input:{}},
  {path:'/spread/count/3'}, {path:'/brokerage_rank'}, {path:'/rank'},
  {path:'/spread/people',input:{grade:0}}, {path:'/spread/commission/3'},
  {path:'/user/commission/list/1'}, {path:'/extract/cash',input:{extract_type:'balance',extract_price:'0'}},
];

/** Actual registered createApp routes, auth/JWT and SQL; only the existing owned
 * fixture's container is injected. This does not claim independent LOGIN ACL or
 * login-form verification. Ordinary CI runs real PGlite SQL; TEST_FINANCE_POSTGRES_URL
 * selects the coordinator-owned PG16. Every exercised operation is read-only. */
describe('customer points centre and monthly ledger registered read contracts', () => {
  let f: Awaited<ReturnType<typeof diyFooterBrowserFixture>>, app: ReturnType<typeof createApp>;
  let originalPasswords: Map<number, string>, snapshot: () => Promise<DiyStateSnapshot>;
  beforeAll(async () => {
    vi.setSystemTime(NOW);
    f = await diyFooterBrowserFixture({ now: NOW }); wiring.container = f.container; app = createApp();
    // One extra read-only ranking table, built only in this owned suite from the
    // actual ORM column/default definitions; no shared fixture/migration change.
    const definition = getTableConfig(userSpread), dialect = new PgDialect();
    if (!f.tables.includes(definition.name)) {
      const columns = definition.columns.map(column => { const initial = column.default,
        initialSql = initial === undefined ? '' : ` default ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `"${column.name}" ${column.getSQLType()}${initialSql}${column.notNull ? ' not null' : ''}${column.primary ? ' primary key' : ''}`; });
      await f.exec(`create table "${definition.name}" (${columns.join(', ')})`);
    }
    const tables = (await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row=>row.name);
    const sequences = (await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row=>row.name);
    snapshot = async () => {
      const value: DiyStateSnapshot = {};
      const rows = await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `));
      for (const row of rows) value[row.name]=row.rows;
      value.__sequences = await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));
      return sortedDiyState(value);
    };
    originalPasswords = new Map<number, string>((await f.db.select({ uid: user.uid, pwd: user.pwd }).from(user).where(inArray(user.uid, [11,22]))).map(row => [row.uid, row.pwd] as const));
  }, 60_000);
  afterAll(async () => { wiring.container = undefined; await f?.close(); vi.useRealTimers(); vi.restoreAllMocks(); }, 30_000);
  beforeEach(async () => {
    await f.db.delete(userBill); await f.db.delete(userSign);
    await f.db.update(systemConfig).set({value:'1'}).where(and(eq(systemConfig.menuName,'station_open'),eq(systemConfig.isStore,0)));
    for (const uid of [11,22]) await f.db.update(user).set({ integral: uid === 11 ? 75 : 200, status: 1, pwd: originalPasswords.get(uid)!, signNum: 0 }).where(eq(user.uid, uid));
    await f.db.delete(systemConfig).where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, settings)));
    await f.db.insert(systemConfig).values(Object.entries({ sign_in_switch:'1',sign_in_integral:'7',sign_mode:'1',sign_give_exp:'0',sign_remind:'1',member_func_status:'1',member_card_status:'0',integral_effective_status:'1',integral_effective_time:'3' }).map(([menuName,value]) => ({ menuName,value,isStore:0,status:1 })));
    f.cache.clear();
  });
  const resources = () => ({ puts: f.bucket.put.mock.calls.length, deletes: f.bucket.delete.mock.calls.length, objects: [...f.objects].map(([key, value]) => ({ key, type:value.type, bytes:[...value.bytes] })).sort((a,b) => a.key.localeCompare(b.key)), queue: vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length });
  async function read(path: string, token: string = f.token, input?: Row): Promise<Envelope> {
    const before = await snapshot(), resourceBefore = resources();
    const response = await app.fetch(new Request('http://localhost/api' + path, { method: input === undefined ? 'GET' : 'POST', headers: { ...(token ? { 'Authori-zation':'Bearer ' + token } : {}), ...(input === undefined ? {} : { 'Content-Type':'application/json' }) }, ...(input === undefined ? {} : { body:JSON.stringify(input) }) }), f.env);
    const raw = await response.text(), diagnostic = { path, http_status:response.status, headers:Object.fromEntries(response.headers), raw_body:raw };
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(resourceBefore);
    expect(response.status, JSON.stringify(diagnostic)).toBe(200);
    expect(response.headers.get('Cache-Control'), JSON.stringify(diagnostic)).toContain('no-store');
    expect(response.headers.get('Content-Type'), JSON.stringify(diagnostic)).toContain('application/json');
    expect(raw.length, JSON.stringify(diagnostic)).toBeGreaterThan(0);
    const body: unknown = JSON.parse(raw);
    expect(body).toMatchObject({ status:expect.any(Number), msg:expect.any(String) }); return body as Envelope;
  }
  const bill = (uid: number, number: string, pm: number, addTime: number, extra: Partial<Bill> = {}): Bill => ({ uid, category:'integral',type:'fixture_points',title:'真实积分账单',mark:'积分变动',number,balance:'75.99',pm,addTime,status:1,...extra });
  async function statistics() {
    await f.db.insert(userBill).values([
      bill(11,'100.75',1,seconds('2025-03-10T04:00:00Z')),
      bill(11,'5.25',0,seconds('2025-04-10T04:00:00Z')),
      bill(11,'7.80',1,now,{frozenTime:now+3600}), bill(11,'0.80',1,now),
      bill(11,'99.99',1,now,{status:0}), bill(11,'2.20',0,seconds('2026-09-10T04:00:00Z')),
      bill(22,'1000.00',1,now), bill(11,'1000.00',1,now,{category:'now_money'}),
    ]);
  }
  async function ledger(): Promise<Array<{ id: number }>> {
    const augustEnd = seconds('2026-08-31T15:59:59Z'), septemberStart = augustEnd + 1;
    const rows = Array.from({length:22}, (_, i) => bill(11, i === 0 ? '-3.90' : i === 1 ? '0.75' : '2.90', i % 2,
      i < 6 ? augustEnd : i < 17 ? septemberStart + i : now + i, { title:'账单' + i,mark:'原始账单' + i,status:i === 20 ? 0 : 1 }));
    rows.push(bill(11,'-2.99',0,0,{title:'日期未知',mark:'无历史时间'}));
    const inserted = await f.db.insert(userBill).values(rows).returning({id:userBill.id});
    await f.db.insert(userBill).values([bill(22,'999.00',1,now),bill(11,'888.00',1,now,{category:'now_money'})]); return inserted;
  }
  async function page(number: number, extra = ''): Promise<Ledger> {
    const result = await read('/integral/list?page=' + number + '&limit=10' + extra); expect(result.status).toBe(200); return result.data as Ledger;
  }

  it('executes the station gate before authentication on all ten actual registered finance routes, while an open station still requires a user JWT', async () => {
    await f.db.update(systemConfig).set({value:'0'}).where(and(eq(systemConfig.menuName,'station_open'),eq(systemConfig.isStore,0)));
    for (const route of financeRoutes) for (const token of ['',f.token]) {
      const closed = await read(route.path,token,route.input);
      expect(closed).toMatchObject({status:410010,msg:'站点升级中，请稍候访问'});
    }
    await f.db.update(systemConfig).set({value:'1'}).where(and(eq(systemConfig.menuName,'station_open'),eq(systemConfig.isStore,0)));
    for (const route of financeRoutes) expect((await read(route.path,'',route.input)).status).toBe(ApiErrorCode.ERR_LOGIN);
  });
  it('reaches the eight other actual read handlers with an owned JWT and real SQL instead of returning an empty factory value', async () => {
    const bank = await read('/extract/bank'); expect(bank.status).toBe(200);
    expect(bank.data).toMatchObject({extractBank:[],commissionCount:expect.any(String),brokerage_price:expect.any(String)});
    const orders = await read('/spread/order',f.token,{}); expect(orders.status).toBe(200); expect(orders.data).toMatchObject({list:[],count:0,time:[]});
    const count = await read('/spread/count/3'); expect(count.status).toBe(200); expect(count.data).toEqual({count:0});
    const brokerage = await read('/brokerage_rank'); expect(brokerage.status).toBe(200); expect(brokerage.data).toMatchObject({rank:[],position:0});
    const ranking = await read('/rank'); expect(ranking.status).toBe(200); expect(ranking.data).toMatchObject({list:[],rank:0,week:0,month:0,uid:11});
    const people = await read('/spread/people',f.token,{grade:0}); expect(people.status).toBe(200); expect(people.data).toMatchObject({list:[],total:0,totalLevel:0,count:0});
    const legacy = await read('/spread/commission/3'); expect(legacy.status).toBe(200); expect(legacy.data).toEqual([]);
    const current = await read('/user/commission/list/1'); expect(current.status).toBe(200); expect(current.data).toEqual([]);
  });
  it('reaches real withdrawal validation for an owned zero-amount request without creating any financial record, sequence value or resource effect', async () => {
    const result = await read('/extract/cash',f.token,{extract_type:'balance',extract_price:'0'});
    expect(result).toMatchObject({status:400,msg:'提现金额必须大于0'});
  });

  it('returns all-flags owned lifetime, current-day, frozen and expiry statistics without changing any table or sequence', async () => {
    await statistics();
    const result = await read('/sign/user', f.token, { sign:1,integral:1,all:1 }); expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ uid:11,integral:75,sum_integral:109,deduction_integral:7,today_integral:8,frozen_integral:7,clear_integral:75,clear_time:seconds('2026-12-30T16:00:00Z'),clear_end:'2026-12-31',integral_effective_status:1,sum_sgin_day:0,is_day_sgin:false,is_YesterDay_sgin:false,sign_num:0 });
    const config = await read('/sign/config'); expect(config.status).toBe(200); expect(config.data).toMatchObject({signStatus:1});
  });
  it('preserves optional legacy statistics flags and uses authenticated UID rather than query/body UID', async () => {
    await statistics();
    const plain = await read('/sign/user',f.token,{}); expect(plain.status).toBe(200); expect(plain.data).toMatchObject({uid:11,integral:75}); expect(plain.data).not.toHaveProperty('sum_integral');
    const forged = await read('/sign/user?uid=22',f.token,{all:1,uid:22}); expect(forged.status).toBe(200); expect(forged.data).toMatchObject({uid:11,sum_integral:109});
    const mine = await page(1,'&uid=22'), other = await read('/integral/list?page=1&limit=10&uid=11',f.otherToken);
    expect(mine.count).toBe(6); expect(mine.list.every(row => row.uid === 11 && row.category === 'integral')).toBe(true);
    expect(other.status).toBe(200); expect(other.data).toMatchObject({count:1,list:[{uid:22,number:1000}]});
  });
  it('pages ten records rather than ten months, preserves status0, descending IDs and complete count across shared page months', async () => {
    const inserted = await ledger(), expectedIds = inserted.map(row => row.id).reverse();
    const first = await page(1), second = await page(2), third = await page(3), terminal = await page(4);
    for (const current of [first,second,third,terminal]) expect(current.count).toBe(23);
    expect([first.list.length,second.list.length,third.list.length,terminal.list.length]).toEqual([10,10,3,0]);
    expect([...first.list,...second.list,...third.list].map(row => row.id)).toEqual(expectedIds);
    expect(first.times).toEqual(['','2026-10','2026-09']); expect(second.times).toEqual(['2026-09','2026-08']); expect(third.times).toEqual(['2026-08']); expect(terminal.times).toEqual([]);
    expect(first.list.some(row => row.status === 0)).toBe(true);
  });
  it('retains unknown dates and raw signed/decimal-truncated ledger values without inventing a1970 date', async () => {
    await ledger(); const first = await page(1), last = await page(3);
    expect(first.list[0]).toMatchObject({uid:11,title:'日期未知',number:-2,balance:75,pm:0,add_time:'',time_key:'',time:'',day:''});
    expect(last.list.find(row => row.title === '账单0')).toMatchObject({number:-3,pm:0});
    expect(last.list.find(row => row.title === '账单1')).toMatchObject({number:0,pm:1});
    const boundaryRows = (await page(2)).list; expect(boundaryRows.some(row => row.day === '2026-09-01' && row.add_time === '2026-09-01 00:00:06')).toBe(true);
    expect(last.list.every(row => row.day === '2026-08-31' && row.add_time === '2026-08-31 23:59:59')).toBe(true);
  });
  it('allows safe totals above int4 while keeping the wallet signed int4 and truncating sums only after aggregation', async () => {
    await statistics(); await f.db.insert(userBill).values(bill(11,'3000000000.99',1,now));
    const result = await read('/sign/user',f.token,{all:1}); expect(result.status).toBe(200); expect(result.data).toMatchObject({integral:75,sum_integral:3000000110,today_integral:3000000009});
    expect((await page(1)).list[0]).toMatchObject({number:3000000000,balance:75});
    await f.db.update(systemConfig).set({value:'0'}).where(and(eq(systemConfig.isStore,0),eq(systemConfig.menuName,'integral_effective_status')));
    await f.db.update(user).set({integral:-7}).where(eq(user.uid,11)); f.cache.clear();
    const negative = await read('/sign/user',f.token,{all:1}); expect(negative.status).toBe(200); expect(negative.data).toMatchObject({uid:11,integral:-7,clear_integral:0,clear_time:0});
  });
  it('keeps the existing bounded legacy pagination grammar without admitting another account or unbounded reads', async () => {
    await ledger();
    const wide = await read('/integral/list?page=-1&limit=999999&uid=22'); expect(wide.status).toBe(200); expect(wide.data).toMatchObject({count:23}); expect((wide.data as Ledger).list).toHaveLength(23);
    const far = await read('/integral/list?page=999999&limit=100'); expect(far.status).toBe(200); expect(far.data).toEqual({list:[],count:23,times:[]});
  });
  it('rejects guest, invalid and freshly revoked password/account states on both registered private routes without writes', async () => {
    await statistics();
    for (const [token,code] of [['',ApiErrorCode.ERR_LOGIN],['invalid.owned.token',ApiErrorCode.ERR_EXPIRED]] as const) {
      expect((await read('/sign/user',token,{all:1})).status).toBe(code); expect((await read('/integral/list',token)).status).toBe(code);
    }
    await f.db.update(user).set({status:0}).where(eq(user.uid,11));
    expect((await read('/sign/user',f.token,{all:1})).status).toBe(ApiErrorCode.ERR_BANNED); expect((await read('/integral/list')).status).toBe(ApiErrorCode.ERR_BANNED);
    await f.db.update(user).set({status:1,pwd:'changed-owned-password'}).where(eq(user.uid,11));
    expect((await read('/sign/user',f.token,{all:1})).status).toBe(ApiErrorCode.ERR_EXPIRED); expect((await read('/integral/list')).status).toBe(ApiErrorCode.ERR_EXPIRED);
  });
});
