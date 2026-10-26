import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { systemAdmin, systemRole, systemMenus, systemUserLevel, systemAttachment, user, userLevel } from '@/models/schema';
import { AdminPermissionService } from '@/services/admin/AdminPermissionService';
import { AdminLevelDefinitionService, type AdminLevelDefinitionPage } from '@/services/admin/AdminLevelDefinitionService';
import { detectUserLevel } from '@/services/order/OrderRewardService';
import { ApiErrorCode } from '@/utils/errors';
import { createToken, md5 } from '@/utils/jwt';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, opened: 0, closed: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned level fixture'); return wiring.container; },
  createAdminDatabaseSession: () => {
    if (!wiring.container) throw Error('Missing owned Admin level fixture'); wiring.opened++;
    return { container: wiring.container, close: async () => { wiring.closed++; } };
  },
}));
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Envelope = { status: number; msg: string; data: unknown };
const PASSWORD = 'owned-level-password';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const aliases = ['/adminapi/level/', '/api/admin/level/'];
const createBody = (overrides: Row = {}): Row => ({ name: '新等级', grade: 6, exp_num: 600,
  discount: '65.25', icon: '/api/assets/1', image: '/api/assets/2', color: '#123ABC', is_show: 1,
  explain: '等级说明\n可换行\t制表', ...overrides });
// A timing barrier wraps the real transaction callback, AFTER all its SQL and
// BEFORE its real commit. It never replaces queries, returned rows or DML.
function pauseBeforeCommit(db: DbClient, entered: () => void, gate: Promise<void>): DbClient {
  return new Proxy(db, { get(target, property, receiver) {
    if (property === 'transaction') return (callback: (tx: DbClient) => Promise<unknown>) => target.transaction(async tx => {
      const result = await callback(tx as unknown as DbClient); entered(); await gate; return result;
    });
    const value: unknown = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Actual registered aliases + JWT/live permission + SQL, with DI selecting only
 * this owned database. This is NOT an independent LOGIN-ACL commissioning test.
 * PGlite covers business SQL; native PG16 peers alone prove lock interleavings.
 * No activation, rewards, payment, upload, R2, queue or cache work is performed. */
describe('Admin ordinary level definitions: complete author contract and grant fence', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env, app: ReturnType<typeof createApp>;
  let tables: string[], sequences: string[];
  const tokens = new Map<number, string>();
  const replies: Array<{ path: string; actor: number; method: string; http: number; raw_sha256: string; status: number }> = [];
  const forbidden = async () => { throw Error('Unexpected level-definition resource I/O'); };
  const bucket = { get: vi.fn(forbidden), head: vi.fn(forbidden), list: vi.fn(forbidden), put: vi.fn(forbidden), delete: vi.fn(forbidden) };
  const queue = { send: vi.fn(forbidden), sendBatch: vi.fn(forbidden) };
  const cache = { get: vi.fn(forbidden), put: vi.fn(forbidden), delete: vi.fn(forbidden) };
  const actor = () => ({ id: 101, authVersion: md5(PASSWORD), expiresAt: Math.floor(Date.now()/1000)+3600 });
  const service = (db = f.db) => new AdminLevelDefinitionService(createContainerFromDb(db), env);
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    f = await financePostgres([systemAdmin, systemRole, systemMenus, systemUserLevel, systemAttachment, user, userLevel], { namespace: 'public' });
    env = { APP_KEY: 'owned-level-definition-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ASSETS_BUCKET: bucket, ORDER_QUEUE: queue, CONFIG_KV: cache } as unknown as Env;
    for (const id of [100,101,102,103,104,105,106,107]) tokens.set(id, (await createToken(id,'admin',md5(PASSWORD),env.APP_KEY)).token);
    tokens.set(108, (await createToken(101,'api',md5(PASSWORD),env.APP_KEY)).token);
    wiring.container = createContainerFromDb(f.db); app = createApp();
    tables = (await f.db.execute<{ name: string }>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row => row.name);
    sequences = (await f.db.execute<{ name: string }>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row => row.name);
    expect(tables).toEqual(['system_admin','system_attachment','system_menus','system_role','system_user_level','user','user_level']);
    expect(sequences).toEqual(['system_admin_id_seq','system_attachment_att_id_seq','system_menus_id_seq','system_role_id_seq','system_user_level_id_seq','user_level_id_seq','user_uid_seq']);
  }, 30_000);
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemRole).values([{id:1,roleName:'等级管理',rules:'level.manage',status:1},
      {id:2,roleName:'等级只读',rules:'level.view',status:1},{id:3,roleName:'无等级权限',rules:'user.view',status:1}]);
    await f.db.insert(systemAdmin).values([
      {id:100,account:'level-super',pwd:PASSWORD,level:0,adminType:1,status:1},
      {id:101,account:'level-manager',pwd:PASSWORD,level:1,roles:'1',adminType:1,status:1},
      {id:102,account:'level-reader',pwd:PASSWORD,level:1,roles:'2',adminType:1,status:1},
      {id:103,account:'level-other',pwd:PASSWORD,level:1,roles:'3',adminType:1,status:1},
      {id:104,account:'level-disabled',pwd:PASSWORD,level:1,roles:'1',adminType:1,status:0},
      {id:105,account:'level-deleted',pwd:PASSWORD,level:1,roles:'1',adminType:1,status:1,isDel:1},
      {id:106,account:'level-supplier',pwd:PASSWORD,level:1,roles:'1',adminType:2,status:1},
      {id:107,account:'level-stale',pwd:'changed',level:1,roles:'1',adminType:1,status:1},
    ]);
    await f.db.insert(systemUserLevel).values(Array.from({length:25}, (_,i) => ({id:1001+i,name:`等级 ${String(i+1).padStart(2,'0')}`,
      grade:i+1,expNum:(i+1)*100,discount:'80.25',isShow:i%2,icon:i===0?'/api/assets/1':'/static/logo.png',
      image:i===0?'/api/assets/2':'https://example.test/background.png',color:'#123ABC',explain:'原说明',isForever:1})));
    await f.db.insert(systemAttachment).values([
      {attId:1,name:'attachments/admin/1/level-icon.png',attDir:'/api/assets/1',type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attType:'image/png'},
      {attId:2,name:'attachments/admin/1/level-background.png',attDir:'/api/assets/2',type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attType:'image/png'},
      {attId:3,name:'attachments/supplier/7/private.png',attDir:'/api/assets/3',type:4,relationId:7,moduleType:1,fileType:1,imageType:8,attType:'image/png'},
      {attId:4,name:'attachments/admin/1/document.svg',attDir:'/api/assets/4',type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attType:'image/svg+xml'},
      {attId:5,name:'attachments/admin/9/wrong.png',attDir:'/api/assets/5',type:1,relationId:0,moduleType:1,fileType:1,imageType:8,attType:'image/png'},
    ]);
    await f.db.insert(user).values([{uid:11,account:'level-ordinary',nickname:'普通用户',level:0,levelStatus:1,exp:'150.25'},
      {uid:22,account:'level-occupied',level:1002,levelStatus:0}]);
  });
  afterAll(async () => {
    try { expect(replies.length).toBeGreaterThan(0); expect(wiring.opened).toBe(wiring.closed);
      expect(fetch).not.toHaveBeenCalled(); for (const fn of [...Object.values(bucket),...Object.values(queue),...Object.values(cache)]) expect(fn).not.toHaveBeenCalled();
    } finally { wiring.container=undefined;vi.restoreAllMocks();await f?.close(); }
  },30_000);
  async function snapshot(): Promise<Snapshot> {
    const result:Snapshot={};
    for(const table of tables)result[table]=(await f.db.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`)).map(row=>row.row);
    result.__sequences=await f.db.execute<Row>(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));
    return result;
  }
  const resources=()=>Object.fromEntries([...Object.entries(bucket),...Object.entries(queue),...Object.entries(cache).map(([name,fn])=>['cache_'+name,fn] as const)].map(([name,fn])=>[name,fn.mock.calls.length]));
  async function request(method:'GET'|'POST'|'DELETE',path:string,identity=101,input?:Row|string):Promise<Envelope>{
    const response=await app.request(path,{method,headers:{...(identity?{Authorization:'Bearer '+tokens.get(identity)}:{}),...(input===undefined?{}:{'content-type':'application/json'})},
      ...(input===undefined?{}:{body:typeof input==='string'?input:JSON.stringify(input)})},env);
    const raw=await response.text(), diagnostic=JSON.stringify({path,identity,method,http:response.status,raw});
    expect(response.headers.get('content-type'),diagnostic).toContain('application/json');
    const body=JSON.parse(raw) as Envelope;replies.push({path,actor:identity,method,http:response.status,raw_sha256:sha(raw),status:body.status});
    if([200,400,404,409].includes(body.status))expect(response.headers.get('cache-control'),diagnostic).toContain('no-store');
    return body;
  }
  async function unchanged(method:'GET'|'POST'|'DELETE',path:string,identity=101,input?:Row|string,status=200):Promise<Envelope>{
    const before=await snapshot(),prior=resources();const result=await request(method,path,identity,input);
    expect(result.status,result.msg).toBe(status);expect(await snapshot()).toEqual(before);expect(resources()).toEqual(prior);return result;
  }
  async function page(query='paged=1',prefix=aliases[0]!):Promise<AdminLevelDefinitionPage>{return(await unchanged('GET',prefix+'list?'+query)).data as AdminLevelDefinitionPage;}
  function onlyChanged(before:Snapshot,after:Snapshot,allowed:string[]){for(const table of Object.keys(before))if(!allowed.includes(table))expect(after[table],table).toEqual(before[table]);}

  it.each(aliases)('preserves legacy raw array and offers exact paged/filter DTO at %s',async prefix=>{
    const bare=(await unchanged('GET',prefix+'list',102)).data as Row[];expect(bare).toHaveLength(25);expect(bare.map(row=>row.id)).toEqual(Array.from({length:25},(_,i)=>1001+i));
    expect(bare.every(row=>!Object.hasOwn(row,'icon_preview'))).toBe(true);
    const first=await page('paged=1&page=1&limit=10',prefix),second=await page('paged=1&page=2&limit=10',prefix),last=await page('paged=1&page=3&limit=10',prefix);
    expect([first.count,second.count,last.count]).toEqual([25,25,25]);expect([first.list.length,second.list.length,last.list.length]).toEqual([10,10,5]);
    expect([...first.list,...second.list,...last.list].map(row=>row.id)).toEqual(bare.map(row=>row.id));expect(first).toMatchObject({page:1,limit:10});
    expect(Object.keys(first.list[0]!).sort()).toEqual([...Object.keys(bare[0]!), 'icon_preview','image_preview'].sort());
    for(const[slot,id]of [['icon_preview',1],['image_preview',2]]as const){const url=new URL(first.list[0]![slot],'https://owned.test');expect(url.pathname).toBe('/api/assets/'+id);expect(Number(url.searchParams.get('expires'))).toBeGreaterThan(Date.now()/1000);expect(url.searchParams.get('signature')).toMatch(/^[A-Za-z0-9_-]{43}$/);}
    expect(first.list[0]).toMatchObject({icon:'/api/assets/1',image:'/api/assets/2',discount:'80.25'});
    expect((await page('paged=1&is_show=0',prefix)).count).toBe(13);
    const filtered=await page('paged=1&title='+encodeURIComponent('等级 02')+'&is_show=1',prefix);expect(filtered.count).toBe(1);expect(filtered.list[0]?.id).toBe(1002);
    expect((await page('paged=1&title=%25',prefix)).count).toBe(0);
    expect(await page('paged=1&page=10000&limit=10',prefix)).toMatchObject({page:10000,limit:10,count:25,list:[]});
    expect(await page('paged=1&page=1001&limit=100',prefix)).toMatchObject({page:1001,limit:100,count:25,list:[]});
  });
  it.each(['paged=0','paged=01','paged=1&paged=1','paged=1&limit=0','paged=1&limit=101','paged=1&page=0','paged=1&page=01','paged=1&page=1.0',
    'paged=1&page=10001','paged=1&page=1002&limit=100','paged=1&is_show=2','paged=1&title=a&title=b','paged=1&uid=11','paged=1&title='+ 'x'.repeat(256)])('strictly refuses malformed query %s without writes',async query=>{
      await unchanged('GET',aliases[0]+'list?'+query,101,undefined,400);
    });
  it('uses deterministic ID tie ordering and signs only exact eligible platform raster slots',async()=>{
    await f.db.update(systemUserLevel).set({grade:1}).where(eq(systemUserLevel.id,1002));
    await f.db.update(systemUserLevel).set({icon:'/api/assets/3',image:'/api/assets/4'}).where(eq(systemUserLevel.id,1002));
    await f.db.update(systemUserLevel).set({icon:'/api/assets/5',image:'/api/assets/999'}).where(eq(systemUserLevel.id,1003));
    const rows=(await page('paged=1&limit=3')).list;expect(rows.map(row=>row.id)).toEqual([1001,1002,1003]);
    expect(rows[1]).toMatchObject({icon:'/api/assets/3',image:'/api/assets/4',icon_preview:'',image_preview:''});expect(rows[2]).toMatchObject({icon_preview:'',image_preview:''});
  });
  it('creates complete PHP-shaped definitions with separate stable canonical media and exact lifetime defaults',async()=>{
    await f.db.delete(systemUserLevel);const before=await snapshot();const result=await request('POST',aliases[0]+'save',101,createBody());expect(result.status,result.msg).toBe(200);
    const id=(result.data as{id:number}).id,after=await snapshot();onlyChanged(before,after,['system_user_level','__sequences']);expect(after.system_user_level).toHaveLength(1);
    expect(after.system_user_level![0]).toMatchObject({id,name:'新等级',grade:6,exp_num:600,discount:65.25,icon:'/api/assets/1',image:'/api/assets/2',is_forever:1,valid_date:0,is_pay:0,money:0,mer_id:0,is_del:0});
    const changed=after.__sequences!.filter((row,i)=>JSON.stringify(row)!==JSON.stringify(before.__sequences![i]));expect(changed).toEqual([{name:'system_user_level_id_seq',last:String(id),called:true}]);
  });
  it.each(aliases)('edits all authored fields and toggles while preserving every latent field at %s',async prefix=>{
    const before=await snapshot();expect((await request('POST',prefix+'save',101,{id:1001,name:'基础会员',grade:1,exp_num:100,discount:'79.50',icon:'/api/assets/2',image:'/api/assets/1',color:'#FFFFFF',is_show:1,explain:'新说明\n\t第二行'})).status).toBe(200);
    const after=await snapshot();onlyChanged(before,after,['system_user_level']);
    const old=before.system_user_level!.find(row=>row.id===1001)!;
    expect(after.system_user_level!.find(row=>row.id===1001)).toEqual({...old,name:'基础会员',discount:79.5,icon:'/api/assets/2',image:'/api/assets/1',color:'#FFFFFF',is_show:1,explain:'新说明\n\t第二行'});
    expect((await request('POST',prefix+'save',101,{id:1001,is_show:0})).status).toBe(200);expect((await page('paged=1&title='+encodeURIComponent('基础会员'))).list[0]).toMatchObject({isShow:0});
  });
  it('preserves unchanged imported zero/blank/null values; changed positive→zero and changed blank fields are refused',async()=>{
    await f.db.update(systemUserLevel).set({grade:0,expNum:0,icon:'',image:'',color:'',explain:null}).where(eq(systemUserLevel.id,1001));
    const before=await snapshot();expect((await request('POST',aliases[0]+'save',101,{id:1001,name:'旧零值保留',grade:0,exp_num:0,icon:'',image:'',color:''})).status).toBe(200);
    const after=await snapshot();onlyChanged(before,after,['system_user_level']);expect(after.system_user_level!.find(row=>row.id===1001)).toEqual({...before.system_user_level!.find(row=>row.id===1001),name:'旧零值保留'});
    await unchanged('POST',aliases[0]+'save',101,{id:1002,grade:0},400);await unchanged('POST',aliases[0]+'save',101,{id:1002,exp_num:0},400);
    await unchanged('POST',aliases[0]+'save',101,{id:1002,image:''},400);await unchanged('POST',aliases[0]+'save',101,{id:1002,explain:''},400);
    await unchanged('POST',aliases[0]+'save',101,{id:1001,grade:0,exp_num:0,icon:'',image:'',color:''});
  });
  it.each([{id:1001,name:' 等级 02 '},{id:1001,grade:2},{id:1001,exp_num:200},{id:1001,exp_num:201},{id:1003,exp_num:150},
    {id:1001,discount:'101.00'},{id:1001,discount:'1e2'},{id:1001,discount:'1.001'},{id:1001,is_show:2},{id:1001,icon:'/api/assets/3'},
    {id:1001,image:'/api/assets/4'},{id:1001,image:'/api/assets/5'},{id:1001,image:'/api/assets/1?expires=1&signature=x'},
    {id:1001,name:'x'.repeat(256)},{id:1001,explain:'x'.repeat(10001)},{id:1001,explain:'bad\u0000text'},{id:1001,unknown:1},{id:1001}])('refuses invalid mutation %j atomically',async input=>{
      await unchanged('POST',aliases[0]+'save',101,input,400);
    });
  it('requires positive new grade/experience and refuses missing complete author fields before INSERT',async()=>{
    for(const body of [createBody({grade:0}),createBody({exp_num:0}),createBody({name:''}),{name:'缺字段'}])await unchanged('POST',aliases[0]+'save',101,body,400);
  });
  it('rejects duplicate JSON keys including escaped aliases and invalid IDs before sequence use',async()=>{
    for(const body of ['{"id":1001,"is_show":0,"is_show":1}','{"id":1001,"is_show":0,"is_\\u0073how":1}','[]','null'])await unchanged('POST',aliases[0]+'save',101,body,400);
    await unchanged('DELETE',aliases[0]+'del/01',101,undefined,400);await unchanged('POST',aliases[0]+'save',101,{id:99999,is_show:1},404);
  });
  it.each(aliases)('refuses occupied deletion but retires unoccupied definition and all matching old grants at %s',async prefix=>{
    // PHP occupancy includes disabled users; no pricing-enabled shortcut.
    await unchanged('DELETE',prefix+'del/1002',101,undefined,400);
    await f.db.insert(userLevel).values([{uid:11,levelId:1003,status:1,isDel:0},{uid:22,levelId:1003,status:0,isDel:0},{uid:11,levelId:1004,status:1,isDel:0}]);
    const before=await snapshot();expect(await request('DELETE',prefix+'del/1003')).toMatchObject({status:200,data:null});const after=await snapshot();onlyChanged(before,after,['system_user_level','user_level']);
    expect(new Map(after.system_user_level!.map(row=>[row.id,row]))).toEqual(new Map(before.system_user_level!.map(row=>[row.id,row.id===1003?{...row,is_del:1}:row])));
    expect(new Map(after.user_level!.map(row=>[row.id,row]))).toEqual(new Map(before.user_level!.map(row=>[row.id,row.level_id===1003?{...row,is_del:1}:row])));
    await unchanged('DELETE',prefix+'del/1003');expect((await page()).count).toBe(24);
  });
  it('enforces live registered read/write ACL, realm/account/password and role revocation on both aliases',async()=>{
    const refused=[[0,ApiErrorCode.ERR_LOGIN],[103,ApiErrorCode.ERR_AUTH],[104,ApiErrorCode.ERR_BANNED],[105,ApiErrorCode.ERR_BANNED],[106,ApiErrorCode.ERR_BANNED],[107,ApiErrorCode.ERR_EXPIRED],[108,ApiErrorCode.ERR_BANNED]]as const;
    for(const prefix of aliases){await unchanged('GET',prefix+'list?paged=1',102);await unchanged('POST',prefix+'save',102,{id:1001,is_show:1},ApiErrorCode.ERR_AUTH);
      await unchanged('DELETE',prefix+'del/1001',102,undefined,ApiErrorCode.ERR_AUTH);
      for(const[id,status]of refused)await unchanged('GET',prefix+'list?paged=1',id,undefined,status);}
    await f.db.update(systemRole).set({rules:'user.view'}).where(eq(systemRole.id,1));
    await unchanged('POST',aliases[0]+'save',101,{id:1001,is_show:1},ApiErrorCode.ERR_AUTH);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native RR binds exact count and page to the same snapshot across a concurrent catalogue commit',async()=>{
    const before=await snapshot();await withFinancePeers(f.db,async([reader,editor])=>{
      let enter!:()=>void,release!:()=>void,gated=false;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
      const original=AdminPermissionService.prototype.resolveRoleAssignment;
      const probe=vi.spyOn(AdminPermissionService.prototype,'resolveRoleAssignment').mockImplementation(async function(this:AdminPermissionService,...args:Parameters<typeof original>){
        const result=await original.apply(this,args);if(!gated){gated=true;enter();await gate;}return result;
      });
      const reading=outcome(service(reader.db).list(new URLSearchParams('paged=1&limit=100'),actor()));
      try{await entered;await editor.db.insert(systemUserLevel).values({id:9999,name:'并发新增',grade:26,expNum:2600,isShow:1});release();
        const result=await reading;expect(result.ok).toBe(true);if(result.ok){const data=result.value as AdminLevelDefinitionPage;expect(data.count).toBe(25);expect(data.list).toHaveLength(25);expect(data.list.some(row=>row.id===9999)).toBe(false);}
      }finally{release();await reading;probe.mockRestore();}
    });const after=await snapshot();onlyChanged(before,after,['system_user_level']);expect((await page('paged=1&limit=100')).count).toBe(26);
  },30_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native grant-first locks the real candidate until commit; delete then sees occupied user and rejects',async()=>{
    await f.db.delete(systemUserLevel).where(sql`${systemUserLevel.id}<>1001`);await f.db.update(systemUserLevel).set({isShow:1}).where(eq(systemUserLevel.id,1001));
    await withFinancePeers(f.db,async([grant,admin])=>{
      let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
      const db=pauseBeforeCommit(grant.db,enter,gate);const g=outcome(db.transaction(async tx=>{await tx.execute(sql`SELECT uid FROM "user" WHERE uid=11 FOR UPDATE`);await detectUserLevel(tx as unknown as DbClient,11,'并发用户',15025,1793070000);}));await entered;
      const d=outcome(service(admin.db).remove(1001,actor()));
      try{await waitForFinanceBlock(f.db,admin.pid,grant.pid);release();expect((await g).ok).toBe(true);const result=await d;expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toMatchObject({code:400});}
      finally{release();await g;await d;}
    });
    expect((await f.db.select().from(user).where(eq(user.uid,11)))[0]?.level).toBe(1001);expect((await f.db.select().from(systemUserLevel).where(eq(systemUserLevel.id,1001)))[0]?.isDel).toBe(0);expect(await f.db.select().from(userLevel)).toHaveLength(1);
  },30_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native delete-first forces the actual grant SELECT to recheck isDel after waiting, with no stale grant',async()=>{
    await f.db.delete(systemUserLevel).where(sql`${systemUserLevel.id}<>1001`);await f.db.update(systemUserLevel).set({isShow:1}).where(eq(systemUserLevel.id,1001));
    const before=await snapshot();await withFinancePeers(f.db,async([admin,grant])=>{
      let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
      const d=outcome(service(pauseBeforeCommit(admin.db,enter,gate)).remove(1001,actor()));await entered;
      const g=outcome(grant.db.transaction(async tx=>{await tx.execute(sql`SELECT uid FROM "user" WHERE uid=11 FOR UPDATE`);await detectUserLevel(tx as unknown as DbClient,11,'并发用户',15025,1793070000);}));
      try{await waitForFinanceBlock(f.db,grant.pid,admin.pid);release();expect(await d).toEqual({ok:true,value:null});expect((await g).ok).toBe(true);}finally{release();await d;await g;}
    });const after=await snapshot();onlyChanged(before,after,['system_user_level']);expect(after.user_level).toEqual([]);expect(after.user).toEqual(before.user);
  },30_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native conflicting creates cannot both insert a duplicate name/grade/threshold, including an initially empty catalogue',async()=>{
    await f.db.delete(systemUserLevel);await withFinancePeers(f.db,async([holder,first,second])=>{
      let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});
      const h=holder.db.transaction(async tx=>{await tx.execute(sql`LOCK TABLE system_user_level IN SHARE ROW EXCLUSIVE MODE`);enter();await gate;});await entered;
      const a=outcome(service(first.db).save(createBody(),actor()));let b:Promise<{ok:true;value:{id:number}}|{ok:false;error:unknown}>|undefined;
      try{await waitForFinanceBlock(f.db,first.pid,holder.pid);b=outcome(service(second.db).save(createBody(),actor()));const rejected=await b;expect(rejected.ok).toBe(false);if(!rejected.ok)expect(rejected.error).toMatchObject({code:409});release();await h;expect((await a).ok).toBe(true);}
      finally{release();await h;await a;await b;}
      await expect(service(second.db).save(createBody(),actor())).rejects.toMatchObject({code:400});
    });expect(await f.db.select().from(systemUserLevel)).toHaveLength(1);
  },30_000);
});
