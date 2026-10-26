import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { user, userBill } from '@/models/schema';
import { ApiErrorCode, ValidateException } from '@/utils/errors';
import { UserLevelService } from '@/services/user/UserLevelService';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned growth ledger fixture'); return wiring.container; },
}));

type DbRow = Record<string, unknown>;
type Snapshot = Record<string, DbRow[]>;
type Envelope = { status: number; msg: string; data: unknown };
type GrowthRow = { id: number; title: string; number: string; pm: number; add_time: string; time_key: string; time: string };
type GrowthPage = { count: number; list: GrowthRow[]; time: string[] };
type Bill = typeof userBill.$inferInsert;
const ROUTE = '/api/user/level/expList';
const PASSWORD = md5('owned-growth-records-password');
const shanghaiAugustEnd = 1_788_191_999; // 2026-08-31T15:59:59Z => 2026-08-31 23:59:59.
const shanghaiSeptemberStart = shanghaiAugustEnd + 1;
const shanghaiOctoberStart = 1_790_784_000; // 2026-09-30T16:00:00Z => 2026-10-01 00:00:00.
const amount = (index: number): string => ['-2.25','-3.50','0.00','12.75','9999999999.99','-9999999999.99','0.10'][index % 7]!;
const seeds: Bill[] = Array.from({ length: 45 }, (_, index) => ({
  uid: 11, category: 'exp', type: 'owned_growth', eventKey: '', title: `成长记录${String(index).padStart(2,'0')}`,
  number: amount(index), balance: '400.25', pm: index % 2, status: 1,
  // High IDs intentionally include old dates, equal seconds and a missing date.
  // Chronological ordering cannot accidentally pass the independent ID oracle.
  addTime: index === 44 ? 0 : index === 42 || index < 8 ? shanghaiAugustEnd
    : index < 31 ? shanghaiSeptemberStart : shanghaiOctoberStart,
}));
const uniqueMonths = (rows: GrowthRow[]) => [...new Set(rows.map(row => row.time_key))];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Actual createApp registration, user JWT/auth/account lookup and SQL. Only the
 * database connection is directed at this suite's owned fixture. This does not
 * prove production Redis-bucket enrollment, an independent PostgreSQL LOGIN ACL,
 * login-form behavior, or concurrent count/page snapshot isolation. Real PGlite
 * SQL is the ordinary mode; TEST_FINANCE_POSTGRES_URL selects owned PG16.
 * No detection, activation, reward, business POST or resource I/O is exercised. */
describe('customer growth records registered read-only HTTP contract', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, app: ReturnType<typeof createApp>, env: Env;
  let tables: string[], sequences: string[], expected: GrowthRow[];
  const tokens = new Map<string, string>();
  const requests: Array<{ method: string; path: string; actor: string; http_status: number; body_sha256: string }> = [];
  const objects = new Map([['owned-growth-sentinel', { type: 'image/png', bytes: [137,80,78,71] }]]);
  const forbiddenResource = async (): Promise<never> => { throw Error('Growth ledger attempted resource I/O'); };
  const bucket = { get: vi.fn(forbiddenResource), head: vi.fn(forbiddenResource), list: vi.fn(forbiddenResource),
    put: vi.fn(forbiddenResource), delete: vi.fn(forbiddenResource) };
  const queue = { send: vi.fn(forbiddenResource), sendBatch: vi.fn(forbiddenResource) };

  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Growth fixture forbids external I/O'));
    f = await financePostgres([user, userBill], { namespace: 'public' });
    env = { APP_KEY: 'owned-growth-records-jwt-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ASSETS_BUCKET: bucket, ORDER_QUEUE: queue } as unknown as Env;
    wiring.container = createContainerFromDb(f.db); app = createApp();
    tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    expect(tables).toEqual(['user','user_bill']); expect(sequences).toEqual(['user_bill_id_seq','user_uid_seq']);
    for (const [name, uid, realm, pwd] of [
      ['mine',11,'api',PASSWORD], ['other',22,'api',PASSWORD], ['deleted',33,'api',PASSWORD],
      ['disabled',44,'api',PASSWORD], ['password-stale',55,'api',PASSWORD], ['soft-deleted',66,'api',PASSWORD],
      ['empty',77,'api',PASSWORD], ['missing',8888,'api',PASSWORD], ['wrong-realm',11,'admin',PASSWORD],
    ] as const) tokens.set(name, (await createToken(uid,realm,md5(pwd),env.APP_KEY)).token);
    tokens.set('guest',''); tokens.set('invalid','invalid.owned.token');
  }, 30_000);
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(user).values([
      { uid:11,account:'growth-owner',pwd:PASSWORD,status:1,exp:'400.25',level:0,levelStatus:0 },
      { uid:22,account:'growth-other',pwd:PASSWORD,status:1,exp:'5.50' },
      { uid:33,account:'growth-deleted',pwd:PASSWORD,status:1,isDel:1 },
      { uid:44,account:'growth-disabled',pwd:PASSWORD,status:0 },
      { uid:55,account:'growth-stale',pwd:md5('new-owned-password'),status:1 },
      { uid:66,account:'growth-soft-deleted',pwd:PASSWORD,status:1,deleteTime:new Date('2026-01-01T00:00:00Z') },
      { uid:77,account:'growth-empty',pwd:PASSWORD,status:1 },
    ]);
    const inserted = await f.db.insert(userBill).values(seeds).returning({id:userBill.id});
    expected = inserted.map((row,index): GrowthRow => {
      const entry=seeds[index]!, stamp=Number(entry.addTime), month=stamp===0?'':stamp===shanghaiAugustEnd?'2026-08':stamp===shanghaiSeptemberStart?'2026-09':'2026-10';
      const date=stamp===0?'':stamp===shanghaiAugustEnd?'2026-08-31 23:59:59':stamp===shanghaiSeptemberStart?'2026-09-01 00:00:00':'2026-10-01 00:00:00';
      return {id:row.id,title:String(entry.title),number:String(entry.number),pm:Number(entry.pm),add_time:date,time_key:month,time:month};
    }).reverse();
    // Higher IDs and newer timestamps must not leak into count, list or groups.
    await f.db.insert(userBill).values([
      { uid:11,category:'exp',status:0,title:'待定经验禁止出现',number:'99.00',pm:1,addTime:2_000_000_000 },
      { uid:11,category:'exp',status:-1,title:'无效经验禁止出现',number:'99.00',pm:1,addTime:2_000_000_000 },
      { uid:11,category:'integral',status:1,title:'积分非经验',number:'99.00',pm:1,addTime:2_000_000_000 },
      { uid:11,category:'EXP',status:1,title:'区分大小写',number:'99.00',pm:1,addTime:2_000_000_000 },
      { uid:22,category:'exp',status:1,title:'另一账号经验',number:'5.50',pm:1,addTime:2_000_000_000 },
      { uid:22,category:'exp',status:0,title:'另一账号无效经验',number:'8.00',pm:0,addTime:2_000_000_000 },
    ]);
  }, 30_000);
  afterAll(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled();
      for (const operation of [...Object.values(bucket),...Object.values(queue)]) expect(operation).not.toHaveBeenCalled();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(row=>row.method==='GET' && new URL(row.path,'http://localhost').pathname===ROUTE)).toBe(true);
    } finally { wiring.container=undefined;tokens.clear();vi.restoreAllMocks();await f?.close(); }
  }, 30_000);

  async function snapshot(): Promise<Snapshot> {
    const state: Snapshot = {};
    for (const table of tables) state[table] = (await f.db.execute<{row:DbRow}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`)).map(row=>row.row);
    state.__sequences = await f.db.execute<DbRow>(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));
    return state;
  }
  const resources = () => ({ objects:[...objects].map(([key,value])=>({key,type:value.type,bytes:[...value.bytes]})),
    bucket:Object.fromEntries(Object.entries(bucket).map(([name,operation])=>[name,operation.mock.calls.length])),
    queue:Object.fromEntries(Object.entries(queue).map(([name,operation])=>[name,operation.mock.calls.length])),fetch:vi.mocked(fetch).mock.calls.length });
  async function read(query='',actor='mine'): Promise<Envelope> {
    const before=await snapshot(),resourceBefore=resources(),path=ROUTE+query;
    const response=await app.fetch(new Request('http://localhost'+path,{method:'GET',headers:tokens.get(actor)?{'Authori-zation':'Bearer '+tokens.get(actor)}:{}}),env);
    const raw=await response.text(),diagnostic=JSON.stringify({path,actor,http:response.status,headers:Object.fromEntries(response.headers),raw,sha256:sha(raw)});
    requests.push({method:'GET',path,actor,http_status:response.status,body_sha256:sha(raw)});
    expect(await snapshot(),diagnostic).toEqual(before);expect(resources(),diagnostic).toEqual(resourceBefore);
    expect(response.status,diagnostic).toBe(200);expect(response.headers.get('content-type'),diagnostic).toContain('application/json');
    expect(response.headers.get('cache-control'),diagnostic).toContain('no-store');expect(raw.length,diagnostic).toBeGreaterThan(0);
    const data:unknown=JSON.parse(raw);expect(data,diagnostic).toMatchObject({status:expect.any(Number),msg:expect.any(String)});return data as Envelope;
  }
  async function page(pageNumber=1,limit=20,actor='mine'): Promise<GrowthPage> {
    const response=await read('?page='+pageNumber+'&limit='+limit,actor);expect(response.status,response.msg).toBe(200);
    const result=response.data as GrowthPage;expect(Object.keys(result).sort()).toEqual(['count','list','time']);
    expect(Number.isSafeInteger(result.count)).toBe(true);expect(result.count).toBeGreaterThanOrEqual(0);expect(Array.isArray(result.list)).toBe(true);
    for(const row of result.list){expect(Object.keys(row).sort()).toEqual(['add_time','id','number','pm','time','time_key','title']);expect(typeof row.number).toBe('string');expect(row.number).toMatch(/^-?(?:0|[1-9]\d*)\.\d{2}$/u);expect(row.time).toBe(row.time_key);}
    expect(result.time).toEqual(uniqueMonths(result.list));return result;
  }

  it('returns45owned valid exp records in true20/20/5 ID-desc pages with exact stable count and terminal empty groups',async()=>{
    const pages=[await page(1),await page(2),await page(3),await page(4)];
    expect(pages.map(row=>row.count)).toEqual([45,45,45,45]);expect(pages.map(row=>row.list.length)).toEqual([20,20,5,0]);
    expect(pages.flatMap(row=>row.list)).toEqual(expected);expect(pages[3]!.time).toEqual([]);
    const ids=pages.flatMap(row=>row.list.map(item=>item.id));expect(new Set(ids).size).toBe(45);expect(ids).toEqual([...ids].sort((a,b)=>b-a));
    expect(pages[0]!.list.some(row=>row.add_time==='2026-08-31 23:59:59')).toBe(true);
    expect(pages[0]!.list.some(row=>row.add_time==='2026-10-01 00:00:00')).toBe(true);
    // Same timestamp records on either side of page boundaries remain ID ordered.
    expect(pages[0]!.time).toContain('2026-09');expect(pages[1]!.time).toContain('2026-09');
    expect(pages[1]!.time).toContain('2026-08');expect(pages[2]!.time).toContain('2026-08');
  });
  it('preserves actualpm and positive/negative decimals without integral/list truncation or absolute-value conversion',async()=>{
    const rows=[...(await page(1)).list,...(await page(2)).list,...(await page(3)).list];
    expect(rows.find(row=>row.title==='成长记录00')).toMatchObject({number:'-2.25',pm:0});
    expect(rows.find(row=>row.title==='成长记录01')).toMatchObject({number:'-3.50',pm:1});
    expect(rows.find(row=>row.title==='成长记录02')).toMatchObject({number:'0.00',pm:0});
    expect(rows.find(row=>row.title==='成长记录03')).toMatchObject({number:'12.75',pm:1});
    expect(rows.find(row=>row.title==='成长记录04')).toMatchObject({number:'9999999999.99',pm:0});
    expect(rows.find(row=>row.title==='成长记录05')).toMatchObject({number:'-9999999999.99',pm:1});
  });
  it('formats Shanghai midnight month boundaries and retains unknown0 as empty rather than a1970 month',async()=>{
    const rows=[...(await page(1)).list,...(await page(2)).list,...(await page(3)).list];
    expect(rows[0]).toMatchObject({title:'成长记录44',add_time:'',time_key:'',time:''});
    expect(rows.find(row=>row.title==='成长记录07')).toMatchObject({add_time:'2026-08-31 23:59:59',time_key:'2026-08',time:'2026-08'});
    expect(rows.find(row=>row.title==='成长记录08')).toMatchObject({add_time:'2026-09-01 00:00:00',time_key:'2026-09',time:'2026-09'});
    expect(rows.some(row=>row.add_time.startsWith('1970')||row.time_key==='1970-01')).toBe(false);
    const current=await page(1);expect(current.time).toEqual(['','2026-10','2026-08','2026-09']);
  });
  it('derives identity only from actual authenticatedUID and keeps another account and an empty account isolated',async()=>{
    const mine=await page(1),other=await page(1,20,'other'),empty=await page(1,20,'empty');
    expect(mine.count).toBe(45);expect(other).toMatchObject({count:1,list:[{title:'另一账号经验',number:'5.50',pm:1}],time:['2033-05']});
    expect(empty).toEqual({count:0,list:[],time:[]});expect((await page(5,20,'other')).count).toBe(1);
  });
  it('has deterministic bounded default pagination and supports explicit100 without an unbounded query',async()=>{
    const response=await read();expect(response.status).toBe(200);expect(response.data).toEqual(await page(1,20));
    const wide=await page(1,100);expect(wide.list).toEqual(expected);expect(wide.count).toBe(45);
    const far=await page(1_000,100);expect(far).toEqual({count:45,list:[],time:[]});
  });
  it('ignores unknown legacy query keys and forgedUID rather than changing the actual authenticated owner',async()=>{
    const baseline=await page(2),response=await read('?page=2&limit=20&uid=22&uid=33&status=0&category=integral&future_key=keep');
    expect(response.status).toBe(200);expect(response.data).toEqual(baseline);expect((response.data as GrowthPage).count).toBe(45);
    expect((response.data as GrowthPage).list.some(row=>row.title==='另一账号经验')).toBe(false);
    const other=await read('?page=1&limit=20&uid=11','other');expect(other.status).toBe(200);
    expect(other.data).toEqual(await page(1,20,'other'));
  });
  it('keeps negative signed timestamps meaningful while0alone denotes a missing historical date',async()=>{
    await f.db.insert(userBill).values([
      {uid:11,category:'exp',status:1,title:'上海纪元前一秒',number:'1.25',pm:1,addTime:-28_801},
      {uid:11,category:'exp',status:1,title:'上海纪元开始',number:'-2.50',pm:0,addTime:-28_800},
    ]);
    const result=await page(1);expect(result.count).toBe(47);
    expect(result.list[0]).toMatchObject({title:'上海纪元开始',add_time:'1970-01-01 00:00:00',time_key:'1970-01',time:'1970-01'});
    expect(result.list[1]).toMatchObject({title:'上海纪元前一秒',add_time:'1969-12-31 23:59:59',time_key:'1969-12',time:'1969-12'});
    expect(result.list[2]).toMatchObject({title:'成长记录44',add_time:'',time_key:'',time:''});
    expect(result.time.slice(0,3)).toEqual(['1970-01','1969-12','']);
  });
  it('also enforces the same bounded pagination and live user predicates for direct service callers',async()=>{
    const service=new UserLevelService(wiring.container!,env),before=await snapshot(),resourceBefore=resources();
    expect(await service.expList(11)).toEqual(await page(1,20));
    for(const [pageNumber,limit] of [[0,20],[-1,20],[1_001,20],[1,0],[1,101],[1.5,20],[NaN,20],[Infinity,20],['1',20],[1,'20'],[true,20],[9_007_199_254_740_992,20]]) {
      await expect(service.expList(11,pageNumber as unknown as number,limit as unknown as number)).rejects.toBeInstanceOf(ValidateException);
    }
    for(const uid of [0,-1,2_147_483_648,1.5,NaN,8888,33,44,66]) {
      await expect(service.expList(uid,1,20)).rejects.toBeInstanceOf(ValidateException);
    }
    expect(await snapshot()).toEqual(before);expect(resources()).toEqual(resourceBefore);
  });
  // Bounded migration grammar; the PHP UI already requests explicit page1/limit20.
  it.each(['?page=0','?page=-1','?page=01','?page=1.5','?page=1e2','?page=%201','?page=NaN',
    '?page=1001','?page=9007199254740992','?limit=0','?limit=-1','?limit=101','?limit=1.5',
    '?limit=1e2','?limit=01','?limit=9007199254740992','?page=1&page=1','?limit=20&limit=20',
    '?page=1&page=2','?limit=20&limit=100','?page=','?limit=','?%70age=1&page=1'])('rejects malformed/repeated/untrusted query without writes %s',async query=>{
    const result=await read(query);expect(result).toMatchObject({status:400,data:null});
  });
  it.each([['guest',ApiErrorCode.ERR_LOGIN],['invalid',ApiErrorCode.ERR_EXPIRED],['wrong-realm',ApiErrorCode.ERR_BANNED],
    ['disabled',ApiErrorCode.ERR_BANNED],['deleted',ApiErrorCode.ERR_EXPIRED],['soft-deleted',ApiErrorCode.ERR_EXPIRED],
    ['password-stale',ApiErrorCode.ERR_EXPIRED],['missing',ApiErrorCode.ERR_EXPIRED]] as const)('rejects actual %s token/account boundary without reading somebodyelse ledger',async(actor,status)=>{
    const result=await read('?page=1&limit=20',actor);expect(result).toMatchObject({status,data:null});
  });
});
