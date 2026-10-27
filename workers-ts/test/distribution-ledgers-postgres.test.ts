import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { user, userBrokerage, userExtract } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const value = wiring.context?.getStore(); if (!value) throw Error('Owned real App LOGIN context required'); return value;
} }));
const base = 205000, password = md5('synthetic-distribution-ledgers');
const october = Date.parse('2026-09-30T16:00:00Z') / 1000;
const modern = '/api/v2/user/money_list/3?view=distribution_ledger';
const payload = (body: Row) => body.data as Row;
const rows = (body: Row) => payload(body).list as Row[];
const input = (extra: Row = {}) => ({ page: 1, limit: 20, start: 0, stop: 0, keyword: '', ...extra });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('distribution ledgers real API JWT/App LOGIN and readonly PG16', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>, tables: string[], sequences: string[], now: number, fixtureOpen = false;
  let activeProfile: Promise<void> | undefined;
  const app = createApp(), tokens = new Map<number, string>();
  const writes = { get:vi.fn(), put:vi.fn(), delete:vi.fn(), head:vi.fn(), list:vi.fn(), queue:vi.fn(), sequence:vi.fn() };
  const resources = () => Object.fromEntries(Object.entries(writes).map(([key,fn])=>[key,fn.mock.calls.length]));
  beforeEach(async () => {
    fixtureOpen = false; f = await refundRuntimeFixture(); fixtureOpen = true;
    f.env.APP_KEY = crypto.randomUUID() + crypto.randomUUID(); now = Math.floor(Date.now() / 1000);
    wiring.context = new AsyncLocalStorage<Container>();
    await f.db.delete(userBrokerage);
    await f.db.update(user).set({pwd:password,nickname:'流水本人',account:'owner-account',phone:'13811111111',status:1,isDel:0}).where(eq(user.uid,11));
    await f.db.update(user).set({pwd:password,nickname:'另一个用户',account:'buyer-account',status:1,isDel:0}).where(eq(user.uid,22));
    await f.db.insert(userBrokerage).values([
      ...Array.from({length:43},(_,i)=>({id:base+i+1,uid:11,type:'custom_history',linkId:String(base+i+1),title:'佣金记录'+(i+1),pm:1,status:i%3-1,number:'1.01',addTime:october+i})),
      {id:base+101,uid:22,type:'custom_history',title:'外属流水',pm:1,number:'99.99',addTime:october},
    ]);
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); expect(sequences).toHaveLength(229); for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const uid of [11, 22]) tokens.set(uid, (await createToken(uid, 'api', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    for (const fn of Object.values(writes)) fn.mockReset().mockImplementation(() => { throw Error('Readonly distribution-ledger query may not use external resources'); });
  });
  afterEach(async () => {
    try { await activeProfile; if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled(); for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled(); }
    finally { wiring.context = undefined; tokens.clear(); vi.restoreAllMocks(); if (fixtureOpen) { fixtureOpen = false; await f.close(); } }
  }, 30000);
  type Peer = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (role: infer T) => unknown ? T : never;
  async function profile(run: (env: Env, application: Peer) => Promise<void>) {
    const running = f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS name');
      const names = { app: application.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(application.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      const env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', HYPERDRIVE: { connectionString: application.connectionString },
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString }, ASSETS_BUCKET: writes,
        CONFIG_KV: { get: writes.head, put: writes.put, delete: writes.delete, list: writes.list },
        ORDER_QUEUE: { send: writes.queue, sendBatch: writes.queue }, SEQUENCE: { idFromName: writes.sequence, get: writes.sequence } } as unknown as Env;
      Object.assign(env, { NODE_ENV: 'test' }); await run(env, application);
    }));
    activeProfile = running;
    try { await running; } finally { if (activeProfile === running) activeProfile = undefined; }
  }
  async function snapshot(): Promise<DiyStateSnapshot> {
    const state: DiyStateSnapshot = {};
    for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,
      COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
    state.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,
      is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
    return sortedDiyState(state);
  }
  async function readonly<T>(run: () => Promise<T>) {
    const before = await snapshot(), io = resources(), result = await run();
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(io); return result;
  }
  async function request(env: Env, db: DbClient, body: unknown = input(), uid: number | null = 11, token?: string,
    path = modern, contentType = 'application/json', method = 'POST') {
    const headers = new Headers({ 'Form-type': 'h5', 'Content-Type': contentType });
    if (uid !== null) headers.set('Authori-zation', 'Bearer ' + (token ?? tokens.get(uid)));
    const response = await wiring.context!.run(createContainerFromDb(db), () => app.fetch(new Request('https://owned.local' + path,
      { method, headers, ...(method==='GET'?{}:{body:typeof body === 'string' ? body : body instanceof Uint8Array ? new Uint8Array(body).buffer : JSON.stringify(body)}) }), env,
      { waitUntil: () => { throw Error('Distribution ledgers may not queue asynchronous work'); }, passThroughOnException: () => {} } as never));
    return { response, body: await response.json() as Row };
  }
  const withdrawal='/api/v2/user/money_list/4?view=distribution_ledger';
  const legacy=(type:number,query='')=>'/api/v2/user/money_list/'+type+query;
  it('returns exact owner-bound commission20/20/3 pages and full filtered sums without exposing complete ledger records',async()=>{
    await profile(async(env,peer)=>readonly(async()=>{
      const first=await request(env,peer.db),second=await request(env,peer.db,input({page:2})),third=await request(env,peer.db,input({page:3}));
      expect(first.body.status).toBe(200);expect(first.response.headers.get('Cache-Control')).toBe('private, no-store');
      const data=payload(first.body);expect(Object.keys(data).sort()).toEqual(['count','expend','income','list','mode','owner_uid','query']);
      expect(data).toMatchObject({owner_uid:11,mode:'commission',query:input(),count:43,income:'43.43',expend:'0.00'});
      expect([rows(first.body).length,rows(second.body).length,rows(third.body).length]).toEqual([20,20,3]);
      const all=[...rows(first.body),...rows(second.body),...rows(third.body)];expect(all.map(row=>row.id)).toEqual(Array.from({length:43},(_,i)=>base+43-i));
      for(const row of all){expect(Object.keys(row).sort()).toEqual(['add_time','id','number','pm','time','title','type','withdrawal_message','withdrawal_status']);expect(row).toMatchObject({pm:1,number:'1.01',withdrawal_status:null,withdrawal_message:''});expect(row.time).toBe('2026/10/01 00:00');}
      for(const response of [second,third])expect(payload(response.body)).toMatchObject({count:43,income:'43.43',expend:'0.00'});
      expect(payload((await request(env,peer.db,{})).body).query).toEqual(input());
      expect(payload((await request(env,peer.db,input({page:500}))).body)).toMatchObject({count:43,list:[],income:'43.43',expend:'0.00'});
      expect(payload((await request(env,peer.db,input(),22)).body)).toMatchObject({owner_uid:22,count:1,income:'99.99',list:[{title:'外属流水'}]});
    }));
  },20000);

  it('paginates withdrawal20/20/3 as the three historical types with null totals and no keyword scope',async()=>{
    await f.db.update(userBrokerage).set({type:'extract',pm:0}).where(sql`uid=11`);
    await profile(async(env,peer)=>readonly(async()=>{
      const responses=[];for(const page of [1,2,3])responses.push(await request(env,peer.db,input({page}),11,undefined,withdrawal));
      expect(responses.map(r=>rows(r.body).length)).toEqual([20,20,3]);for(const r of responses)expect(payload(r.body)).toMatchObject({mode:'withdrawal',count:43,income:null,expend:null});
      expect(responses.flatMap(r=>rows(r.body).map(row=>row.id))).toEqual(Array.from({length:43},(_,i)=>base+43-i));
      expect((await request(env,peer.db,input({keyword:'NO'}),11,undefined,withdrawal)).body.status).toBe(400);
      expect((await request(env,peer.db,input({keyword:' '}),11,undefined,withdrawal)).body.status).toBe(400);
    }));
  },20000);

  it('retains every source type/status and normalizes only PHP display direction while sums use raw pm',async()=>{
    await f.db.delete(userBrokerage);
    const types=['self_brokerage','one_brokerage','two_brokerage','brokerage_user','division_brokerage','agent_brokerage','staff_brokerage','refund','extract','extract_money','extract_fail','custom','invalid_pm','invalid_pm'];
    await f.db.insert(userBrokerage).values(types.map((type,i)=>({id:base+i+1,uid:11,type,linkId:String(base+i),title:type,pm:i<7||[10,11].includes(i)?1:i===12?2:i===13?-1:0,status:i%4-1,number:i===7?'-0.25':i===11?'-12.00':(i+1)+'.00',addTime:0})));
    await profile(async(env,peer)=>readonly(async()=>{
      const response=await request(env,peer.db),data=payload(response.body);expect(data).toMatchObject({count:14,income:'16.00',expend:'18.75'});expect(rows(response.body).map(row=>row.type)).toEqual(types.slice().reverse());
      expect(rows(response.body).slice(0,2).map(row=>row.pm)).toEqual([0,0]);expect(rows(response.body).every(row=>row.time===''&&row.add_time===0)).toBe(true);
      expect(rows(response.body).find(row=>row.type==='extract_money')).toMatchObject({withdrawal_status:1,withdrawal_message:''});
      const wd=await request(env,peer.db,input(),11,undefined,withdrawal);expect(payload(wd.body)).toMatchObject({count:3,income:null,expend:null});expect(rows(wd.body).map(row=>row.type)).toEqual(['extract_fail','extract_money','extract']);
    }));
  },20000);

  it('searches zero, caller uid/account/nickname/phone and ledger title with PHP wildcard semantics, without inventing buyer search',async()=>{
    await profile(async(env,peer)=>readonly(async()=>{
      expect(payload((await request(env,peer.db,input({keyword:'0'}))).body)).toMatchObject({count:4,income:'4.04'});
      for(const keyword of ['11','流水本人','owner-account','13811111111','%','_'])expect(payload((await request(env,peer.db,input({keyword}))).body).count,keyword).toBe(43);
      for(const keyword of ['另一个用户','buyer-account',"%' OR true --"]){const data=payload((await request(env,peer.db,input({keyword}))).body);expect(data).toMatchObject({count:0,income:'0.00',expend:'0.00',list:[]});}
      expect(payload((await request(env,peer.db,input({keyword:'  佣金记录43  '}))).body)).toMatchObject({query:input({keyword:'佣金记录43'}),count:1,income:'1.01'});
    }));
  },20000);

  it('uses exact inclusive Shanghai modern days, preserves zero/negative source times and restricts legacy day expansion to3/4',async()=>{
    await f.db.delete(userBrokerage);
    await f.db.insert(userBrokerage).values([october-1,october,october+86399,october+86400,october+86401,0,-1].map((addTime,i)=>({id:base+i+1,uid:11,type:'extract',pm:0,number:'1.01',addTime})));
    await profile(async(env,peer)=>readonly(async()=>{
      const filtered=await request(env,peer.db,input({start:october,stop:october+86399}));expect(payload(filtered.body)).toMatchObject({count:2,income:'0.00',expend:'2.02'});expect(rows(filtered.body).map(row=>row.id)).toEqual([base+3,base+2]);
      const all=await request(env,peer.db);expect(rows(all.body).slice(0,2)).toMatchObject([{add_time:-1,time:'1970/01/01 07:59'},{add_time:0,time:''}]);
      for(const type of [3,4]){const legacyRead=await request(env,peer.db,{},11,undefined,legacy(type,'?start='+october+'&stop='+october),'application/json','GET');expect(rows(legacyRead.body).map(row=>row.id)).toEqual([base+4,base+3,base+2]);}
      expect(rows((await request(env,peer.db,{},11,undefined,legacy(3,'?start='+october+'&stop=0'),'application/json','GET')).body)).toEqual([]);
      for(const type of [3,4])expect(rows((await request(env,peer.db,{},11,undefined,legacy(type,'?start=2147483647&stop=2147483647'),'application/json','GET')).body)).toEqual([]);
    }));
  },20000);

  it('resolves only owned withdrawals, keeps missing or unknown status null, and reveals only real owned rejection messages',async()=>{
    await f.db.delete(userBrokerage);
    await f.db.insert(userExtract).values([{id:base+201,uid:11,status:-1,failMsg:'本人拒绝原因'},{id:base+202,uid:11,status:0,failMsg:'STALE-PENDING'},{id:base+203,uid:11,status:1,failMsg:'STALE-APPROVED'},{id:base+204,uid:22,status:-1,failMsg:'FOREIGN-SECRET'},{id:base+205,uid:11,status:2,failMsg:'UNKNOWN-SECRET'}]);
    const links=[['extract','00'+(base+201)],['extract',String(base+202)],['extract_fail',String(base+203)],['extract_fail',String(base+204)],['extract_money',String(base+204)],['refund',String(base+201)],['extract','missing'],['extract',String(base+205)],['extract','2147483648'],['extract','99999999999999999999999999999999'],['extract','0']];
    await f.db.insert(userBrokerage).values(links.map(([type,linkId],i)=>({id:base+i+1,uid:11,type,linkId,pm:0,number:'1.00',addTime:october})));
    await profile(async(env,peer)=>readonly(async()=>{
      const modernRead=await request(env,peer.db),list=rows(modernRead.body),byId=(n:number)=>list.find(row=>row.id===base+n)!;
      expect(byId(1)).toMatchObject({withdrawal_status:-1,withdrawal_message:'本人拒绝原因'});expect(byId(2)).toMatchObject({withdrawal_status:0,withdrawal_message:''});expect(byId(3)).toMatchObject({withdrawal_status:1,withdrawal_message:''});expect(byId(5)).toMatchObject({withdrawal_status:1,withdrawal_message:''});
      for(const n of [4,6,7,8,9,10,11])expect(byId(n)).toMatchObject({withdrawal_status:null,withdrawal_message:''});
      for(const secret of ['FOREIGN-SECRET','STALE-PENDING','STALE-APPROVED','UNKNOWN-SECRET'])expect(JSON.stringify(modernRead.body)).not.toContain(secret);
      const old=await request(env,peer.db,{},11,undefined,legacy(3),'application/json','GET');expect(JSON.stringify(old.body)).not.toContain('FOREIGN-SECRET');expect(rows(old.body).find(row=>row.id===base+4)).toMatchObject({extract_status:0,extract_msg:''});
      const oldWithdraw=await request(env,peer.db,{},11,undefined,legacy(4),'application/json','GET');for(const row of rows(oldWithdraw.body))expect(row).not.toHaveProperty('extract_status');
    }));
  },20000);

  it('retains exact aggregate cents beyond numeric14,2 in both modern and legacy, including negative source reversals',async()=>{
    await f.db.delete(userBrokerage);await f.db.insert(userBrokerage).values([...Array.from({length:101},(_,i)=>({uid:11,type:'custom',linkId:String(i),pm:1,number:'9999999999.99'})),{uid:11,type:'refund',pm:0,number:'-0.25'},{uid:11,type:'extract_fail',pm:1,number:'123.45'}]);
    await profile(async(env,peer)=>readonly(async()=>{
      expect(payload((await request(env,peer.db)).body)).toMatchObject({count:103,income:'1009999999998.99',expend:'-0.25'});
      expect(payload((await request(env,peer.db,{},11,undefined,legacy(3,'?limit=1'),'application/json','GET')).body)).toMatchObject({income:'1009999999998.99',expend:'-0.25'});
    }));
  },20000);

  it('rejects duplicate JSON/UTF8, coercions, extra controls, noncanonical type paths and incomplete day boundaries',async()=>{
    const invalid:unknown[]=[null,[],1,'null','{','{"page":1,"page":2}','{"page":1,"pa\\u0067e":2}',{page:'1'},{page:0},{page:501},{page:1.5},{limit:10},{limit:'20'},{uid:22},{type:3},{mode:'commission'},{start:october},{start:october,stop:october+86400},{start:october+1,stop:october+86399},{start:october+86400,stop:october+86399},{start:2147483648,stop:2147483648},{start:-1},{keyword:1},{keyword:'字'.repeat(65)},{keyword:'\u0000'},{keyword:'\ud800'},{keyword:'x'.repeat(4097)},'{"page":-0}'];
    await profile(async(env,peer)=>readonly(async()=>{
      for(const body of invalid){const result=await request(env,peer.db,body);expect(result.body.status,JSON.stringify(body)).toBe(400);expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');}
      for(const type of ['03','+3','3.0','3x','0','1','9','4x','%33'])expect((await request(env,peer.db,input(),11,undefined,'/api/v2/user/money_list/'+type+'?view=distribution_ledger')).body.status,type).toBe(400);
      for(const query of ['','view=','view=other','view=distribution_ledger&view=distribution_ledger','view=distribution_ledger&page=1','view=distribution_ledger&uid=22'])expect((await request(env,peer.db,input(),11,undefined,'/api/v2/user/money_list/3?'+query)).body.status,query).toBe(400);
      expect((await request(env,peer.db,input(),11,undefined,modern,'text/plain')).body.status).toBe(400);
      expect((await request(env,peer.db,Uint8Array.from([123,34,107,101,121,119,111,114,100,34,58,34,255,34,125]))).body.status).toBe(400);
      expect(payload((await request(env,peer.db,input({keyword:'😀'.repeat(64)}))).body).query).toEqual(input({keyword:'😀'.repeat(64)}));
    }));
  },20000);
  it('requires live API JWT authority, rejecting guests, expired or wrong-token types and changed account credentials', async () => {
    await profile(async (env,peer) => {
      const expired = (await createToken(11,'api',md5(password),env.APP_KEY,'cinashop',now - 8 * 86400)).token;
      const other = (await createToken(11,'admin',md5(password),env.APP_KEY)).token;
      await readonly(async () => { for (const [uid, token, status] of [[null,undefined,410000],[11,'invalid',410001],[11,expired,410001],[11,other,410002]] as const)
        expect((await request(env,peer.db,input(),uid,token)).body.status).toBe(status); });
      for (const [update,status] of [[{ status: 0 },410002],[{ isDel: 1 },410001],[{ deleteTime: new Date(now * 1000) },410001],[{ pwd: 'changed-ledger-password' },410001]] as const) {
        await f.db.update(user).set(update).where(eq(user.uid,11));
        try { await readonly(async () => expect((await request(env,peer.db)).body.status).toBe(status)); }
        finally { await f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null, pwd: password }).where(eq(user.uid,11)); }
      }
      await readonly(async () => { const peerData=payload((await request(env,peer.db,input(),22)).body); expect(peerData).toMatchObject({ owner_uid:22,count:1,income:'99.99' }); });
    });
  }, 20000);

  it('binds caller keyword, ledger rows/full sums and owned withdrawal review state to one readonly repeatable snapshot',async()=>{
    await f.db.update(user).set({nickname:'OLD_SNAPSHOT'}).where(eq(user.uid,11));
    await f.db.insert(userExtract).values({id:base+201,uid:11,status:-1,failMsg:'旧审核原因'});
    await f.db.update(userBrokerage).set({type:'extract',linkId:String(base+201)}).where(eq(userBrokerage.id,base+43));
    await profile(async(env,peer)=>{
      const before=await snapshot(),io=resources();
      await f.withPeer!(async holder=>{
        let release!:()=>void,acquired!:()=>void;const gate=new Promise<void>(yes=>release=yes),ready=new Promise<void>(yes=>acquired=yes);
        const lock=holder.db.transaction(async tx=>{await tx.execute(sql`LOCK TABLE user_brokerage IN ACCESS EXCLUSIVE MODE`);await tx.update(userBrokerage).set({number:'9.99'}).where(eq(userBrokerage.id,base+43));acquired();await gate;});
        await ready;const pending=request(env,peer.db,input({keyword:'OLD_SNAPSHOT'}));
        try{
          const end=performance.now()+1500;let blocked=false;
          do{const[state]=await f.db.execute<{blockers:number[];query:string}>(sql`SELECT pg_blocking_pids(${peer.pid}) AS blockers,query FROM pg_stat_activity WHERE pid=${peer.pid}`);
            if(state?.blockers.includes(holder.pid)&&/user_brokerage/.test(state.query)){blocked=true;break;}await delay(20);
          }while(performance.now()<end);
          expect(blocked,'Actual report waits inside its RR').toBe(true);
          await f.db.update(user).set({nickname:'NEW_SNAPSHOT'}).where(eq(user.uid,11));
          await f.db.update(userExtract).set({status:1,failMsg:'NEW-NO-DISCLOSURE'}).where(eq(userExtract.id,base+201));
        }finally{release();await lock;}
        const data=payload((await pending).body);expect(data).toMatchObject({count:43,income:'43.43',expend:'0.00'});expect((data.list as Row[])[0]).toMatchObject({number:'1.01',withdrawal_status:-1,withdrawal_message:'旧审核原因'});
        const expected=structuredClone(before);expected.user.find(row=>row.uid===11)!.nickname='NEW_SNAPSHOT';expected.user_brokerage.find(row=>row.id===base+43)!.number=9.99;const extract=expected.user_extract.find(row=>row.id===base+201)!;extract.status=1;extract.fail_msg='NEW-NO-DISCLOSURE';
        expect(await snapshot()).toEqual(sortedDiyState(expected));expect(resources()).toEqual(io);
        await readonly(async()=>{expect(payload((await request(env,peer.db,input({keyword:'OLD_SNAPSHOT'}))).body)).toMatchObject({count:0,income:'0.00'});const fresh=await request(env,peer.db);expect(payload(fresh.body)).toMatchObject({count:43,income:'52.41'});expect(rows(fresh.body)[0]).toMatchObject({number:'9.99',withdrawal_status:1,withdrawal_message:''});});
      });
    });
  },20000);
});
