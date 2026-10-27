import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { user, userBrokerage, storeOrder, systemAttachment, systemConfig } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const value = wiring.context?.getStore(); if (!value) throw Error('Owned real App LOGIN context required'); return value;
} }));
const base = 204000, password = md5('synthetic-promoter-people');
const september = Date.parse('2026-08-31T16:00:00Z') / 1000, october = Date.parse('2026-09-30T16:00:00Z') / 1000;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0sAAAAASUVORK5CYII=', 'base64'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const modern = '/api/spread/people?view=promoter_people';
const payload = (body: Row) => body.data as Row;
const rows = (body: Row) => payload(body).list as Row[];
const input = (extra: Row = {}) => ({ page: 1, limit: 20, grade: 0, start: 0, stop: 0, keyword: '', ...extra });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('promoter people real API JWT/App LOGIN and readonly PG16', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>, tables: string[], sequences: string[], now: number, fixtureOpen = false;
  let activeProfile: Promise<void> | undefined;
  const app = createApp(), tokens = new Map<number, string>();
  const writes = { put: vi.fn(), delete: vi.fn(), head: vi.fn(), list: vi.fn(), queue: vi.fn(), sequence: vi.fn() };
  const objects = new Map<string, Uint8Array>([['attachments/user/22/people.png', png]]);
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key); if (!bytes) throw Error('Unexpected owned R2 key');
    return { body: bytes, size: bytes.length, etag: digest(bytes), httpEtag: '"' + digest(bytes) + '"',
      httpMetadata: { contentType: 'image/png' }, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
  });
  const resources = () => ({ writes: Object.fromEntries(Object.entries(writes).map(([key, fn]) => [key, fn.mock.calls.length])),
    gets: get.mock.calls.map(([key]) => key), objects: [...objects].map(([key, bytes]) => ({ key, bytes: bytes.length, sha256: digest(bytes) })) });
  beforeEach(async () => {
    fixtureOpen = false; f = await refundRuntimeFixture(); fixtureOpen = true;
    f.env.APP_KEY = crypto.randomUUID() + crypto.randomUUID(); now = Math.floor(Date.now() / 1000);
    wiring.context = new AsyncLocalStorage<Container>();
    await f.db.delete(userBrokerage);
    await f.db.update(user).set({ pwd: password, nickname: '推广人', avatar: '', spreadUid: 0, status: 1, isDel: 0 }).where(eq(user.uid, 11));
    await f.db.update(user).set({ pwd: password, nickname: '推广成员0', phone: '13800000022', avatar: '/api/assets/' + base,
      spreadUid: 11, spreadTime: october, addTime: september + 50, status: 1, isDel: 0 }).where(eq(user.uid, 22));
    await f.db.insert(user).values([
      ...Array.from({ length: 40 }, (_, i) => ({ uid: base + i + 1, nickname: `一级成员${i+1}`, spreadUid: 11,
        spreadTime: october + i + 1, addTime: september + (i === 38 ? 40 : i + 1), status: i === 39 ? 0 : 1 })),
      ...Array.from({ length: 4 }, (_, i) => ({ uid: base + 101 + i, nickname: `二级成员${i+1}`,
        spreadUid: i === 3 ? base + 1 : 22, spreadTime: october, addTime: september })),
      { uid: base + 50, nickname: 'deleted flag', spreadUid: 11, isDel: 1 },
      { uid: base + 51, nickname: 'soft deleted', spreadUid: 11, deleteTime: new Date() },
      { uid: base + 52, nickname: 'division-only invisible', divisionId: 11, agentId: 11, spreadUid: 0 },
    ]);
    await f.db.insert(storeOrder).values([
      { oneBrokerage: '1.25', twoBrokerage: '0.50', divisionBrokerage: '2.00', payPrice: '10.00' },
      { oneBrokerage: '-0.25', twoBrokerage: '0.75', divisionBrokerage: '3.00', payPrice: '-0.50' },
    ].map((extra,i) => ({ id: base + i + 1, unique: `people-base-${i}`, orderId: `PEOPLE-${i}`, uid: 22,
      paid: 1, spreadUid: 11, spreadTwoUid: 11, divisionId: 11, addTime: september, ...extra })));
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName,'brokerage_level'));
    await f.db.insert(systemConfig).values({ menuName:'brokerage_level',value:'"2"',sort:5,isStore:0 });
    await f.db.insert(systemAttachment).values([
      { attId: base, name: 'attachments/user/22/people.png', type: 3, relationId: 22, moduleType: 3 },
      { attId: base + 1, name: 'attachments/user/11/private.png', type: 3, relationId: 11, moduleType: 3 },
      { attId: base + 2, name: 'attachments/supplier/7/people.png', type: 4, relationId: 7, moduleType: 1 },
      { attId: base + 3, name: 'attachments/user/22/mismatch.png', type: 3, relationId: 22, moduleType: 3, attType: 'image/jpeg' },
      { attId: base + 4, name: 'attachments/user/11/path.png', type: 3, relationId: 22, moduleType: 3 },
      { attId: base + 5, name: 'attachments/user/22/module.png', type: 3, relationId: 22, moduleType: 4 },
    ].map(row => ({ ...row, attDir: '/api/assets/' + row.attId, imageType: 8, fileType: 1, attType: row.attType ?? 'image/png' })));
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const uid of [11, 22]) tokens.set(uid, (await createToken(uid, 'api', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    for (const fn of Object.values(writes)) fn.mockReset().mockImplementation(() => { throw Error('Readonly promoter-people query may not use external resources'); });
    get.mockClear();
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
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString }, ASSETS_BUCKET: { ...writes, get },
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
    path = modern, contentType = 'application/json') {
    const headers = new Headers({ 'Form-type': 'h5', 'Content-Type': contentType });
    if (uid !== null) headers.set('Authori-zation', 'Bearer ' + (token ?? tokens.get(uid)));
    const response = await wiring.context!.run(createContainerFromDb(db), () => app.fetch(new Request('https://owned.local' + path,
      { method: 'POST', headers, body: typeof body === 'string' ? body : body instanceof Uint8Array ? new Uint8Array(body).buffer : JSON.stringify(body) }), env,
      { waitUntil: () => { throw Error('Promoter people may not queue asynchronous work'); }, passThroughOnException: () => {} } as never));
    return { response, body: await response.json() as Row };
  }
  function ticket(value: unknown, id: number) {
    expect(typeof value).toBe('string'); const url = new URL(String(value), 'https://owned.local');
    expect(url.pathname).toBe('/api/assets/' + id); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    const expires = Number(url.searchParams.get('expires')); expect(expires).toBe(now + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update(`GET\n/api/assets/${id}\n${expires}`).digest('base64url'));
  }
  it('returns the exact projection, deterministic full pages, independent totals and exact lifetime money', async () => {
    await profile(async (env,peer) => readonly(async () => {
      const first=await request(env,peer.db), second=await request(env,peer.db,input({page:2})), third=await request(env,peer.db,input({page:3}));
      expect(first.body.status).toBe(200);expect(first.response.headers.get('Cache-Control')).toBe('private, no-store');
      const data=payload(first.body);expect(Object.keys(data).sort()).toEqual(['brokerage_level','commission','division_mode','filtered_count','list','owner_uid','page_count','query','total','total_level']);
      expect(data).toMatchObject({owner_uid:11,query:input(),total:41,total_level:4,filtered_count:41,page_count:20,brokerage_level:2,division_mode:false,commission:'1.00'});
      const all=[...rows(first.body),...rows(second.body),...rows(third.body)];
      expect(all.map(row=>row.uid)).toEqual([22,...Array.from({length:40},(_,i)=>base+40-i)]);
      expect(payload(second.body)).toMatchObject({page_count:20,filtered_count:41,commission:'1.00'});
      expect(payload(third.body)).toMatchObject({page_count:1,filtered_count:41,commission:'1.00'});
      for(const row of all){expect(Object.keys(row).sort()).toEqual(['add_time','avatar','avatar_source','child_count','joined_at','nickname','number_count','order_count','time','uid']);expect(row.number_count).toMatch(/^-?\d+\.\d{2}$/);}
      expect(all[0]).toMatchObject({uid:22,child_count:3,order_count:2,number_count:'9.50',time:'2026-10-01',joined_at:october});ticket(all[0]?.avatar,base);
      expect(all[1]).toMatchObject({uid:base+40,order_count:0,number_count:'0.00'});
      expect(payload((await request(env,peer.db,{})).body).query).toEqual(input());
      expect(payload((await request(env,peer.db,input({page:500}))).body)).toMatchObject({filtered_count:41,page_count:0,list:[],commission:'0.00'});
      expect(payload((await request(env,peer.db,input({grade:1}))).body)).toMatchObject({total:41,total_level:4,filtered_count:4,page_count:4,commission:'1.25'});
      expect(payload((await request(env,peer.db,input(),22)).body)).toMatchObject({owner_uid:22,total:3,total_level:0,filtered_count:3,commission:'0.00'});
    }));
  },20000);

  it('filters nickname and phone literally, searches zero, and keeps join-date filtering separate from all-time counts and commission', async()=>{
    await f.db.update(user).set({nickname:'literal_%\\ token',spreadTime:october-1}).where(eq(user.uid,base+1));
    await f.db.update(user).set({spreadTime:october+86399}).where(eq(user.uid,base+2));
    await f.db.update(user).set({spreadTime:october+86400}).where(eq(user.uid,base+3));
    await f.db.update(user).set({spreadTime:0,addTime:0}).where(eq(user.uid,base+4));
    await profile(async(env,peer)=>readonly(async()=>{
      for(const keyword of ['13800000022','推广成员0'])expect(payload((await request(env,peer.db,input({keyword}))).body)).toMatchObject({filtered_count:1,page_count:1,total:41,total_level:4,commission:'1.00',list:[{uid:22,child_count:3}]});
      for(const keyword of ['%','_','\\'])expect(rows((await request(env,peer.db,input({keyword}))).body).map(row=>row.uid)).toEqual([base+1]);
      expect(payload((await request(env,peer.db,input({keyword:'不存在'}))).body)).toMatchObject({total:41,total_level:4,filtered_count:0,page_count:0,commission:'0.00',list:[]});
      const filtered=payload((await request(env,peer.db,input({start:october,stop:october+86399}))).body);
      expect(filtered).toMatchObject({total:41,total_level:4,filtered_count:38,commission:'1.00'});
      expect((filtered.list as Row[]).some(row=>row.uid===22)).toBe(true);
      const fallback=rows((await request(env,peer.db,input({keyword:'一级成员4'}))).body).find(row=>row.uid===base+4);
      expect(fallback).toMatchObject({joined_at:0,add_time:0,time:'1970/01/01'});
      expect(payload((await request(env,peer.db,input({keyword:'0'}))).body).filtered_count).toBe(5);
    }));
  },20000);

  it('uses lifetime purchases of all types with pid zero or minus one, while commission uses only raw ordinary roots and exact signed sums',async()=>{
    await f.db.delete(storeOrder);
    const variants=[{pid:0,type:0,payPrice:'9999999999.99',oneBrokerage:'9999999999.99'},
      {pid:-1,type:1,payPrice:'9999999999.99',oneBrokerage:'50.00'},
      {pid:0,type:2,refundStatus:3,payPrice:'-0.25',oneBrokerage:'50.00'},
      {pid:base+1,payPrice:'100.00'},{paid:0},{refundStatus:1},{refundStatus:2},{refundStatus:4},{isDel:1},{isSystemDel:1},
      {uid:11,pid:0,payPrice:'1.00',oneBrokerage:'-0.25'}];
    await f.db.insert(storeOrder).values(variants.map((extra,i)=>({id:base+i+1,unique:`eligibility-${i}`,orderId:`ELIGIBILITY-${i}`,uid:22,paid:1,spreadUid:11,payPrice:'1.00',oneBrokerage:'1.00',addTime:september,...extra})));
    await profile(async(env,peer)=>readonly(async()=>{
      const data=payload((await request(env,peer.db,input({keyword:'13800000022'}))).body);
      expect(data).toMatchObject({filtered_count:1,commission:'9999999999.74',list:[{uid:22,order_count:3,number_count:'19999999999.73'}]});
      expect(payload((await request(env,peer.db,input({keyword:'一级成员1'}))).body).commission).toBe('9999999999.74');
    }));
  },20000);

  it('uses actual caller division type only for labels and commission, preserving referral relationships for every role and grade',async()=>{
    await profile(async(env,peer)=>{
      for(const divisionType of [1,2,3]){
        await f.db.update(user).set({divisionType,divisionStatus:0,divisionEndTime:1}).where(eq(user.uid,11));
        await readonly(async()=>{for(const grade of [0,1])expect(payload((await request(env,peer.db,input({grade}))).body)).toMatchObject({total:41,total_level:4,filtered_count:grade===0?41:4,division_mode:divisionType===1,commission:divisionType===1?'5.00':grade===0?'1.00':'1.25'});});
      }
    });
  },20000);

  it('preserves legacy cached sorting, nullable purchase stats, exact between and page-local count without leaking modern fields',async()=>{
    await f.db.update(user).set({spreadCount:100}).where(eq(user.uid,base+1));
    await profile(async(env,peer)=>readonly(async()=>{
      const legacyEnv={...env,CONFIG_KV:{...env.CONFIG_KV,get:async()=> '"2"'}} as unknown as Env;
      const legacy=payload((await request(legacyEnv,peer.db,{sort:'childCount DESC',limit:1},11,undefined,'/api/spread/people')).body);
      expect(Object.keys(legacy).sort()).toEqual(['brokerage_level','count','list','price','total','totalLevel']);
      expect(legacy).toMatchObject({count:1,total:41,totalLevel:4,price:'1.00',list:[{uid:base+1,childCount:1,orderCount:null,numberCount:null}]});
      expect((legacy.list as Row[])[0]).not.toHaveProperty('add_time');expect((legacy.list as Row[])[0]).toHaveProperty('addTime');
      const equal=payload((await request(legacyEnv,peer.db,{start:october,stop:october},11,undefined,'/api/spread/people')).body);
      expect((equal.list as Row[]).map(row=>row.uid)).toEqual([22]);
      expect(payload((await request(legacyEnv,peer.db,{start:october,stop:0},11,undefined,'/api/spread/people')).body)).toMatchObject({count:0,price:'0',list:[]});
      const nulls=payload((await request(legacyEnv,peer.db,{sort:'numberCount ASC',limit:1},11,undefined,'/api/spread/people')).body);
      expect((nulls.list as Row[])[0]).toMatchObject({uid:base+40,numberCount:null});
    }));
  },20000);

  it('rejects duplicate decoded JSON, scalar coercions, unknown authority or sort, partial days and ambiguous query controls',async()=>{
    const invalid:unknown[]=[null,[],1,'null','{','{"page":1,"page":2}','{"page":1,"pa\\u0067e":2}',{page:'1'},{page:0},{page:501},{page:1.5},{limit:10},{limit:'20'},{grade:2},{grade:'1'},{uid:22},{type:1},{sort:'childCount DESC'},{start:october},{start:october,stop:october+86400},{start:october+1,stop:october+86399},{start:october+86400,stop:october+86399},{start:2147483648,stop:2147483648},{start:-1},{keyword:1},{keyword:'字'.repeat(65)},{keyword:'\u0000'},{keyword:'\ud800'},{keyword:'x'.repeat(4097)},'{"page":-0}'];
    await profile(async(env,peer)=>readonly(async()=>{
      for(const body of invalid){const result=await request(env,peer.db,body);expect(result.body.status,JSON.stringify(body)).toBe(400);expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');}
      for(const query of ['view=','view=other','view=promoter_people&view=promoter_people','view=promoter_people&page=1','view=promoter_people&uid=22','view=promoter_people&grade=1'])expect((await request(env,peer.db,input(),11,undefined,'/api/spread/people?'+query)).body.status,query).toBe(400);
      expect((await request(env,peer.db,input(),11,undefined,modern,'text/plain')).body.status).toBe(400);
      expect((await request(env,peer.db,Uint8Array.from([123,34,107,101,121,119,111,114,100,34,58,34,255,34,125]))).body.status).toBe(400);
      expect(payload((await request(env,peer.db,input({keyword:'😀'.repeat(64)}))).body).query).toEqual(input({keyword:'😀'.repeat(64)}));
      expect(payload((await request(env,peer.db,input({keyword:'  13800000022  '}))).body).query).toEqual(input({keyword:'13800000022'}));
    }));
  },20000);
  it('requires live API JWT authority, rejecting guests, expired or wrong-token types and changed account credentials', async () => {
    await profile(async (env,peer) => {
      const expired = (await createToken(11,'api',md5(password),env.APP_KEY,'cinashop',now - 8 * 86400)).token;
      const other = (await createToken(11,'admin',md5(password),env.APP_KEY)).token;
      await readonly(async () => { for (const [uid, token, status] of [[null,undefined,410000],[11,'invalid',410001],[11,expired,410001],[11,other,410002]] as const)
        expect((await request(env,peer.db,input(),uid,token)).body.status).toBe(status); });
      for (const [update,status] of [[{ status: 0 },410002],[{ isDel: 1 },410001],[{ deleteTime: new Date(now * 1000) },410001],[{ pwd: 'changed-people-password' },410001]] as const) {
        await f.db.update(user).set(update).where(eq(user.uid,11));
        try { await readonly(async () => expect((await request(env,peer.db)).body.status).toBe(status)); }
        finally { await f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null, pwd: password }).where(eq(user.uid,11)); }
      }
      await readonly(async () => { const peerData=payload((await request(env,peer.db,input(),22)).body); expect(peerData).toMatchObject({ owner_uid:22,total:3,total_level:0,filtered_count:3,commission:'0.00' }); });
    });
  }, 20000);

  it('authorizes persisted member avatars by owner metadata and drops deleted participants without exposing their identity',async()=>{
    await profile(async(env,peer)=>{
      for(const avatar of [1,2,3,4,5].map(i=>'/api/assets/'+(base+i)).concat(['/api/assets/2147483647','javascript:alert(1)','//evil.invalid/x','https://user:secret@invalid.example/x.png','http://invalid.example/x.png','/bad\\path.png'])){
        await f.db.update(user).set({avatar}).where(eq(user.uid,22));
        await readonly(async()=>expect(rows((await request(env,peer.db)).body)[0]).toMatchObject({uid:22,avatar:'',avatar_source:''}));
      }
      await f.db.update(user).set({avatar:'/api/assets/'+base}).where(eq(user.uid,22));
      for(const update of [{attDir:'/api/assets/'+(base+1)},{fileType:2},{imageType:0}]){
        await f.db.update(systemAttachment).set(update).where(eq(systemAttachment.attId,base));
        try{await readonly(async()=>expect(rows((await request(env,peer.db)).body)[0]).toMatchObject({avatar:'',avatar_source:''}));}
        finally{await f.db.update(systemAttachment).set({attDir:'/api/assets/'+base,fileType:1,imageType:8}).where(eq(systemAttachment.attId,base));}
      }
      for(const update of [{isDel:1},{deleteTime:new Date(now*1000)}]){
        await f.db.update(user).set(update).where(eq(user.uid,22));
        try{await readonly(async()=>{const data=payload((await request(env,peer.db)).body);expect(data).toMatchObject({total:40,total_level:1,filtered_count:40});expect((data.list as Row[]).some(row=>row.uid===22)).toBe(false);});}
        finally{await f.db.update(user).set({isDel:0,deleteTime:null}).where(eq(user.uid,22));}
      }
      for(const avatar of ['/static/safe-people.png','https://static.example.invalid/people.png']){
        await f.db.update(user).set({avatar}).where(eq(user.uid,22));await readonly(async()=>expect(rows((await request(env,peer.db)).body)[0]).toMatchObject({avatar,avatar_source:avatar}));
      }
    });
  },30000);
  it('serves real authorized R2 bytes and refuses forged signatures without writes', async () => {
    await profile(async (env,peer) => {
      const data=payload((await readonly(() => request(env,peer.db))).body), row=(data.list as Row[])[0]!, before=await snapshot(), io=resources();
      const asset = (url:string) => wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request('https://owned.local' + url),env,
        { waitUntil:()=>{throw Error('No asynchronous reads');},passThroughOnException:()=>{} } as never));
      const response=await asset(String(row.avatar)); expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(png));
      expect((await asset(String(row.avatar).replace('signature=','signature=bad'))).status).toBe(404);
      expect(await snapshot()).toEqual(before); expect(resources()).toEqual({ ...io,gets:['attachments/user/22/people.png'] });
    });
  });

  it('uses the SQL config winner without KV writes, distinguishes missing from explicit empty, and excludes cyclic self from level two',async()=>{
    await f.db.update(user).set({spreadUid:22}).where(eq(user.uid,11));
    await f.db.insert(systemConfig).values([{menuName:'brokerage_level',value:'1',sort:4,isStore:0},{menuName:'brokerage_level',value:'1',sort:5,isStore:0},{menuName:'brokerage_level',value:'9',sort:99,isStore:1}]);
    await profile(async(env,peer)=>{
      await readonly(async()=>{const data=payload((await request(env,peer.db,input({grade:1}))).body);expect(data).toMatchObject({brokerage_level:1,total:41,total_level:4,filtered_count:4});expect((data.list as Row[]).some(row=>row.uid===11)).toBe(false);});
      await f.db.delete(systemConfig).where(eq(systemConfig.menuName,'brokerage_level'));
      await readonly(async()=>expect(payload((await request(env,peer.db)).body).brokerage_level).toBe(2));
      await f.db.insert(systemConfig).values({menuName:'brokerage_level',value:'',sort:0,isStore:0});
      await readonly(async()=>expect(payload((await request(env,peer.db)).body).brokerage_level).toBe(0));
    });
  },20000);

  it('binds report, config winner, relationships and avatar authority to one repeatable readonly snapshot',async()=>{
    await profile(async(env,peer)=>{
      const before=await snapshot(),io=resources();
      await f.withPeer!(async holder=>{
        let release!:()=>void,acquired!:()=>void;const gate=new Promise<void>(yes=>release=yes),ready=new Promise<void>(yes=>acquired=yes);
        const lock=holder.db.transaction(async tx=>{await tx.execute(sql`LOCK TABLE store_order IN ACCESS EXCLUSIVE MODE`);acquired();await gate;});
        await ready;const pending=request(env,peer.db);
        try{
          const end=performance.now()+1500;let blocked=false;
          do{const[state]=await f.db.execute<{blockers:number[];query:string}>(sql`SELECT pg_blocking_pids(${peer.pid}) AS blockers,query FROM pg_stat_activity WHERE pid=${peer.pid}`);
            if(state?.blockers.includes(holder.pid)&&/store_order/.test(state.query)){blocked=true;break;}await delay(20);
          }while(performance.now()<end);
          expect(blocked,'Actual report must block within its RR').toBe(true);
          await f.db.update(user).set({divisionType:1}).where(eq(user.uid,11));
          await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'brokerage_level'));
          await f.db.update(systemAttachment).set({attType:'image/jpeg'}).where(eq(systemAttachment.attId,base));
        }finally{release();await lock;}
        const data=payload((await pending).body);expect(data).toMatchObject({division_mode:false,brokerage_level:2,commission:'1.00'});ticket((data.list as Row[])[0]?.avatar,base);
        const expected=structuredClone(before);expected.user.find(row=>row.uid===11)!.division_type=1;
        for(const row of expected.system_config.filter(row=>row.menu_name==='brokerage_level'))row.value='1';
        expected.system_attachment.find(row=>row.att_id===base)!.att_type='image/jpeg'.padEnd(30,' ');
        expect(await snapshot()).toEqual(sortedDiyState(expected));expect(resources()).toEqual(io);
        await readonly(async()=>{const fresh=payload((await request(env,peer.db)).body);expect(fresh).toMatchObject({division_mode:true,brokerage_level:1,commission:'5.00'});expect((fresh.list as Row[])[0]).toMatchObject({uid:22,avatar:'',avatar_source:''});});
      });
    });
  },20000);
});
