import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createHash, createHmac } from 'node:crypto';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type Container } from '@/lib/di';
import { systemAttachment, systemConfig, systemSupplier, systemUserLevel, user, userBill, userLevel,
  userMoney, userSign, storeCouponUser, storeCouponIssueUser, storeOrder } from '@/models/schema';
import { UserLevelService } from '@/services/user/UserLevelService';
import { MAX_OVERVIEW_LEVELS, type UserLevelOverview } from '@/services/user/UserLevelOverviewService';
import { createToken, md5 } from '@/utils/jwt';
import { UserDao } from '@/dao/user/UserDao';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned level overview SQL'); return wiring.container;
} }));
type Row = Record<string, unknown>;
type Snapshot = Record<string, Row[]>;
type Envelope = { status: number; msg: string; data: Record<string, unknown> & { overview?: UserLevelOverview } };
const password = md5('owned-level-overview-password');
const originalKeys = ['currentExp','level','level_info','level_list','nextExpNeed','nextLevel'];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Genuine registered routes/JWT/account lookup and actual PostgreSQL SQL.
 * Ordinary CI uses PGlite; the shared runner selects owned PG16. DI only directs
 * the connection. This does not claim independent production LOGIN ACLs or
 * production Redis/login-form acceptance. All overview reads are complete-state
 * checked; detection is separately measured as a real business write. */
describe('customer level overview opt-in and PHP automatic detection boundary', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, app: ReturnType<typeof createApp>, env: Env;
  let tables: string[], sequences: string[];
  const tokens = new Map<string,string>();
  const forbidden = async (): Promise<never> => { throw Error('Level overview forbids resource I/O'); };
  const bucket = { get:vi.fn(forbidden), head:vi.fn(forbidden), list:vi.fn(forbidden), put:vi.fn(forbidden), delete:vi.fn(forbidden) };
  const queue = { send:vi.fn(forbidden), sendBatch:vi.fn(forbidden) };
  const cache = { get:vi.fn(async()=>null), put:vi.fn(forbidden), delete:vi.fn(forbidden) };
  const responses: Array<{path:string;actor:string;http:number;body_sha256:string;status:number}> = [];
  beforeAll(async()=>{
    vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No external overview I/O'));
    const models=[user,systemUserLevel,userLevel,userSign,systemConfig,systemAttachment,systemSupplier,
      userBill,userMoney,storeCouponUser,storeCouponIssueUser,storeOrder];
    f=await financePostgres(models,{namespace:'public'});
    env={APP_KEY:'owned-level-overview-jwt-key',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',
      CONFIG_KV:cache,ASSETS_BUCKET:bucket,ORDER_QUEUE:queue} as unknown as Env;
    wiring.container=createContainerFromDb(f.db);app=createApp();
    tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(row=>row.name);
    sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(row=>row.name);
    expect(tables).toEqual(models.map(model=>getTableConfig(model).name).sort());
    const expectedSequences=models.flatMap(model=>{const table=getTableConfig(model);return table.columns
      .filter(column=>column.getSQLType()==='serial').map(column=>`${table.name}_${column.name}_seq`);}).sort();
    expect(sequences).toEqual(expectedSequences);expect(sequences).toHaveLength(11);
    for(const [name,uid,realm,pwd] of [['mine',11,'api',password],['other',22,'api',password],['disabled',33,'api',password],
      ['deleted',44,'api',password],['stale',55,'api',password],['missing',99,'api',password],['wrong-realm',11,'admin',password]] as const) {
      tokens.set(name,(await createToken(uid,realm,md5(pwd),env.APP_KEY)).token);
    }
    tokens.set('guest','');tokens.set('invalid','not.a.valid-token');
  },30_000);
  beforeEach(async()=>{
    await f.reset();
    await f.db.insert(user).values([
      {uid:11,account:'level-overview-owner',pwd:password,status:1,level:1,levelStatus:1,exp:'42.75',integral:17,nowMoney:'1.25'},
      {uid:22,account:'level-overview-other',pwd:password,status:1,level:2,levelStatus:1,exp:'125.50',integral:9,nowMoney:'9.75'},
      {uid:33,account:'level-overview-disabled',pwd:password,status:0},
      {uid:44,account:'level-overview-deleted',pwd:password,status:1,isDel:1},
      {uid:55,account:'level-overview-stale',pwd:md5('changed-owner-password'),status:1},
    ]);
    await f.db.insert(systemUserLevel).values([
      {id:1,name:'青铜会员',grade:1,discount:'95.25',expNum:0,isShow:1,color:'#ab812c',icon:'/static/bronze.png',image:'/static/bronze-bg.png'},
      {id:2,name:'白银会员',grade:2,discount:'90.00',expNum:100,isShow:1,color:'#657c92',icon:'/static/silver.png',image:'/static/silver-bg.png'},
      {id:3,name:'黄金会员',grade:3,discount:'80.00',expNum:200,isShow:1,color:'#c9a13a',icon:'/static/gold.png',image:'/static/gold-bg.png'},
    ]);
    await f.db.insert(userLevel).values([{uid:11,levelId:1,grade:1,status:1,isDel:0},{uid:22,levelId:2,grade:2,status:1,isDel:0}]);
    await f.db.insert(systemConfig).values(Object.entries({station_open:'1',member_func_status:'1',sign_status:'1',
      sign_give_exp:'"10"',order_give_exp:'"1.25"',invite_user_exp:'"25"'}).map(([menuName,value])=>({menuName,value,isStore:0})));
    await f.db.insert(userSign).values([{uid:11,addTime:1793070000},{uid:11,addTime:1793070000},
      {uid:11,addTime:0},{uid:22,addTime:1793070000}]);
  },30_000);
  afterAll(async()=>{
    try { expect(responses.length).toBeGreaterThan(0);expect(fetch).not.toHaveBeenCalled();
      for(const operation of [...Object.values(bucket),...Object.values(queue),cache.get,cache.put,cache.delete]) expect(operation).not.toHaveBeenCalled();
    } finally {wiring.container=undefined;tokens.clear();vi.restoreAllMocks();await f?.close();}
  },30_000);
  async function snapshot(db=f.db):Promise<Snapshot>{
    const result:Snapshot={};
    for(const table of tables)result[table]=(await db.execute<{row:Row}>(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`)).map(row=>row.row);
    result.__sequences=await db.execute<Row>(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));
    return result;
  }
  const resources=()=>({bucket:Object.fromEntries(Object.entries(bucket).map(([key,value])=>[key,value.mock.calls.length])),
    queue:Object.fromEntries(Object.entries(queue).map(([key,value])=>[key,value.mock.calls.length])),
    cache_get:cache.get.mock.calls.length,cache_put:cache.put.mock.calls.length,cache_delete:cache.delete.mock.calls.length,fetch:vi.mocked(fetch).mock.calls.length});
  async function request(path:string,actor='mine'):Promise<Envelope>{
    const response=await app.fetch(new Request('http://localhost'+path,{method:'GET',headers:tokens.get(actor)?{Authorization:'Bearer '+tokens.get(actor)}:{}}),env);
    const raw=await response.text();const diagnostic={path,actor,http:response.status,headers:Object.fromEntries(response.headers),raw,sha256:sha(raw)};
    expect(response.status,JSON.stringify(diagnostic)).toBe(200);expect(response.headers.get('content-type'),JSON.stringify(diagnostic)).toContain('application/json');
    const body=JSON.parse(raw) as Envelope;responses.push({path,actor,http:response.status,body_sha256:sha(raw),status:body.status});
    if(path.startsWith('/api/user/level/info'))expect(response.headers.get('cache-control'),JSON.stringify(diagnostic)).toContain('no-store');
    return body;
  }
  async function read(path='/api/user/level/info?overview=1',actor='mine'){
    const before=await snapshot(),beforeResources=resources();const body=await request(path,actor);
    expect(await snapshot()).toEqual(before);expect(resources()).toEqual(beforeResources);return body;
  }
  async function overview(actor='mine'):Promise<UserLevelOverview>{const body=await read(undefined,actor);expect(body.status,body.msg).toBe(200);expect(body.data.overview).toBeDefined();return body.data.overview!;}
  async function config(name:string,value?:string){await f.db.delete(systemConfig).where(and(eq(systemConfig.menuName,name),eq(systemConfig.isStore,0)));if(value!==undefined)await f.db.insert(systemConfig).values({menuName:name,value,isStore:0});}
  const service=()=>new UserLevelService(wiring.container!,env);

  it('keeps the exact six-field legacy default and bare grade array while opting into one narrow overview',async()=>{
    const legacy=await read('/api/user/level/info');expect(legacy.status).toBe(200);expect(Object.keys(legacy.data).sort()).toEqual(originalKeys);
    const current=await read();expect(current.status).toBe(200);const {overview:detail,...six}=current.data;
    expect(six).toEqual(legacy.data);expect(Object.keys(current.data).sort()).toEqual([...originalKeys,'overview']);
    expect(detail).toMatchObject({actor_uid:11,enabled:true,level_active:true,preview_only:false,current_level_id:1,current_grade:1,exp:'42.75',
      task:{sign_count:3,sign:'10',order:'1.25',invite:'25',sign_enabled:true}});
    expect(detail!.levels.map(row=>[row.id,row.discount,row.exp_num,row.lack_exp_num])).toEqual([[1,'95.25',0,'0'],[2,'90.00',100,'57'],[3,'80.00',200,'157']]);
    expect(await service().getLevel(1)).toEqual({id:1,name:'青铜会员',discount:95.25,grade:1});
    const grades=await read('/api/user/level/grade','guest');expect(Array.isArray(grades.data)).toBe(true);expect(grades.data).toHaveLength(3);
  });
  it.each(['?overview=','?overview=0','?overview=true','?overview=01','?overview=%201','?overview=1&overview=1','?overview=1&overview=0'])('rejects only malformed or repeated explicit overview flag %s without writes',async query=>{
    expect((await read('/api/user/level/info'+query)).status).toBe(400);
  });
  it('ignores unknown query UID and never adopts another owner or exposes an entire PHP user object',async()=>{
    const mine=await overview(),other=await overview('other');expect(other).toMatchObject({actor_uid:22,exp:'125.50',current_level_id:2,task:{sign_count:1}});
    expect((await read('/api/user/level/info?overview=1&uid=22&uid=33&future=keep')).data.overview).toEqual(mine);
    const data=(await read()).data;expect(data).not.toHaveProperty('user');expect(JSON.stringify(data)).not.toContain(password);
  });
  it.each([['guest',410000],['invalid',410001],['wrong-realm',410002],['missing',410001],['disabled',410002],['deleted',410001],['stale',410001]] as const)('rejects %s at real mandatory authentication',async(actor,status)=>{
    expect((await read(undefined,actor)).status).toBe(status);
  });
  it('requires an actual active same-owner grant and activation before treating a card as current',async()=>{
    await f.db.delete(userLevel).where(eq(userLevel.uid,11));let result=await overview();expect(result).toMatchObject({level_active:true,preview_only:true,current_level_id:0,current_grade:null});
    await f.db.insert(userLevel).values([{uid:22,levelId:1,status:1,isDel:0},{uid:11,levelId:1,status:0,isDel:0}]);
    expect(await overview()).toMatchObject({preview_only:true,current_level_id:0});
    await f.db.update(userLevel).set({status:1,isDel:1}).where(eq(userLevel.uid,11));expect(await overview()).toMatchObject({preview_only:true,current_level_id:0});
    await f.db.update(userLevel).set({status:1,isDel:0}).where(eq(userLevel.uid,11));await f.db.update(user).set({levelStatus:0}).where(eq(user.uid,11));
    result=await overview();expect(result).toMatchObject({level_active:false,preview_only:true,current_level_id:0});
  });
  it('handles ordinary0, highest and hidden/deleted current definitions without awarding a preview',async()=>{
    await f.db.update(user).set({level:0}).where(eq(user.uid,11));expect(await overview()).toMatchObject({preview_only:true,current_level_id:0,current_grade:null});
    await f.db.update(user).set({level:3,exp:'201.25'}).where(eq(user.uid,11));await f.db.insert(userLevel).values({uid:11,levelId:3,status:1,isDel:0});
    let result=await overview();expect(result).toMatchObject({preview_only:false,current_level_id:3,current_grade:3});expect(result.levels.map(row=>row.lack_exp_num)).toEqual(['0','0','0']);
    await f.db.update(systemUserLevel).set({isShow:0}).where(eq(systemUserLevel.id,3));result=await overview();expect(result.levels.map(row=>row.id)).toEqual([1,2]);expect(result.current_level_id).toBe(0);
    await f.db.update(systemUserLevel).set({isShow:1,isDel:1}).where(eq(systemUserLevel.id,3));expect((await overview()).levels.map(row=>row.id)).toEqual([1,2]);
  });
  it.each([0,1,5,6])('returns the complete %s-definition catalogue without slicing or inventing a highest card',async count=>{
    await f.db.delete(systemUserLevel);if(count)await f.db.insert(systemUserLevel).values(Array.from({length:count},(_,i)=>({id:20+i,name:'等级'+i,grade:i,discount:'0.00',expNum:i*100,isShow:1})));
    const result=await overview();expect(result.levels).toHaveLength(count);expect(result.preview_only).toBe(count>0);expect(result.current_level_id).toBe(0);
    expect(result.levels.map(row=>row.id)).toEqual(Array.from({length:count},(_,i)=>20+i));expect(result.levels.every(row=>row.discount==='0.00')).toBe(true);
  });
  it('preserves exact signed experience and PHP fractional truncation with a zero threshold',async()=>{
    await f.db.update(user).set({exp:'-0.50',level:0}).where(eq(user.uid,11));let result=await overview();expect(result.exp).toBe('-0.50');expect(result.levels.map(row=>row.lack_exp_num)).toEqual(['0','100','200']);
    await f.db.update(user).set({exp:'100.00'}).where(eq(user.uid,11));result=await overview();expect(result.levels[1]!.lack_exp_num).toBe('0');
    await f.db.update(user).set({exp:'9999999999.99'}).where(eq(user.uid,11));expect((await overview()).exp).toBe('9999999999.99');
  });
  it('uses actual platform winners and raw0/decimal/missing task semantics, including primary-off sign precedence',async()=>{
    await config('sign_give_exp','"0"');await config('order_give_exp',undefined);await config('invite_user_exp','"0.1250"');
    await config('sign_status','0');await config('sign_in_switch','1');expect((await overview()).task).toEqual({sign_count:3,sign:'0',order:'',invite:'0.1250',sign_enabled:false});
    await config('sign_status',undefined);expect((await overview()).task.sign_enabled).toBe(true);
    await f.db.insert(systemConfig).values([{menuName:'invite_user_exp',value:'"9.25"',sort:5,isStore:0},
      {menuName:'invite_user_exp',value:'"999"',sort:99,isStore:1},{menuName:'invite_user_exp',value:'"8.25"',sort:5,isStore:0}]);
    expect((await overview()).task.invite).toBe('8.25');
    await config('member_func_status','0');const off=await overview();expect(off).toMatchObject({enabled:false,exp:'42.75',levels:[],preview_only:false,current_level_id:0,task:{sign_count:0,sign_enabled:false}});
    // Existing six fields deliberately keep their original low-sort alias flag;
    // the explicit overview follows the same latest platform winner as detection.
    await f.db.insert(systemConfig).values({menuName:'member_func_status',value:'1',sort:5,isStore:0});
    const data=(await read()).data;expect(data.level_info).toEqual([]);expect(data.overview!.enabled).toBe(true);
  });
  it('does not manufacture installed defaults when runtime config is absent or null and rejects malformed full data',async()=>{
    await config('sign_give_exp',undefined);await config('order_give_exp','null');await config('invite_user_exp','""');
    expect((await overview()).task).toMatchObject({sign:'',order:'',invite:''});
    for(const bad of ['"-1"','"NaN"','{}','"'+'1'.repeat(65)+'"']){
      await config('sign_give_exp',bad);expect((await read()).status).toBe(400);expect((await read('/api/user/level/info')).status).toBe(200);
    }
    for(const flag of [1,'1',null])await expect(service().userLevelInfo(11,flag as unknown as boolean)).rejects.toThrow('概览参数');
  });
  async function attachment(id:number,fields:Partial<typeof systemAttachment.$inferInsert>={}){await f.db.insert(systemAttachment).values({attId:id,type:1,relationId:0,moduleType:1,fileType:1,imageType:8,
    name:`attachments/admin/1/overview-${id}.png`,attDir:`/api/assets/${id}`,attType:'image/png',...fields});}
  function canonicalTicket(value:string,id:number){
    const url=new URL(value,'http://localhost');expect(url.pathname).toBe('/api/assets/'+id);expect([...url.searchParams.keys()].sort()).toEqual(['expires','signature']);
    const expires=url.searchParams.get('expires')!;expect(expires).toMatch(/^[1-9]\d*$/);expect(Number(expires)).toBeGreaterThan(Math.floor(Date.now()/1000));
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256',env.APP_KEY).update(`GET\n/api/assets/${id}\n${expires}`).digest('base64url'));
  }
  it('binds distinct canonical icon/header slots to real platform ownership and signs them after the read',async()=>{
    await attachment(101);await attachment(102);await f.db.update(systemUserLevel).set({icon:'/api/assets/101?expires=1&signature=old',image:'/api/assets/102'}).where(eq(systemUserLevel.id,1));
    const card=(await overview()).levels[0]!;canonicalTicket(card.icon,101);canonicalTicket(card.image,102);expect(card.icon).not.toBe(card.image);
    const legacy=(await read('/api/user/level/info')).data;expect((legacy.level_list as Row[])[0]!.icon).toContain('expires=1');
  });
  it('renews a real copied ticket without changing canonical database fields, rows, sequences or resources',async()=>{
    await attachment(101);await f.db.update(systemUserLevel).set({icon:'/api/assets/101?expires=1&signature=old'}).where(eq(systemUserLevel.id,1));
    const first=(await overview()).levels[0]!.icon,now=Date.now();
    try{vi.setSystemTime(new Date(now+2000));const second=(await overview()).levels[0]!.icon;canonicalTicket(second,101);
      expect(Number(new URL(second,'http://localhost').searchParams.get('expires'))).toBeGreaterThan(Number(new URL(first,'http://localhost').searchParams.get('expires')));
    }finally{vi.useRealTimers();}
  });
  it.each([
    ['supplier',{type:4,relationId:9,name:'attachments/supplier/9/a.png'}],['user',{type:3,relationId:11,moduleType:3,name:'attachments/user/11/a.png'}],
    ['kefu',{relationId:11,moduleType:2,name:'attachments/kefu/11/a.png'}],['wrong-file',{fileType:2}],['legacy-storage',{imageType:1}],
    ['wrong-namespace',{name:'attachments/admin/0/a.png'}],['traversal',{name:'attachments/admin/1/../a.png'}],['vector',{name:'attachments/admin/1/a.svg',attType:'image/svg+xml'}],
    ['mismatch-mime',{attType:'image/jpeg'}],['mismatch-path',{attDir:'/api/assets/999'}],
  ] as Array<[string,Partial<typeof systemAttachment.$inferInsert>]>)('does not authorize %s media even when a canonical ID is persisted',async(_label,fields)=>{
    await attachment(101,fields);await f.db.update(systemUserLevel).set({icon:'/api/assets/101'}).where(eq(systemUserLevel.id,1));expect((await overview()).levels[0]!.icon).toBe('');
  });
  it('retains safe static/HTTPS255-character fields, rejects unknown canonical and unsafe URLs, and fails full overflow atomically',async()=>{
    const exact='https://example.invalid/'+ 'a'.repeat(255-'https://example.invalid/'.length);
    await f.db.update(systemUserLevel).set({icon:exact,image:'/static/logo.png'}).where(eq(systemUserLevel.id,1));expect((await overview()).levels[0]).toMatchObject({icon:exact,image:'/static/logo.png'});
    for(const icon of ['/api/assets/999','javascript:alert(1)','http://example.invalid/a.png','//example.invalid/a.png']){await f.db.update(systemUserLevel).set({icon}).where(eq(systemUserLevel.id,1));expect((await overview()).levels[0]!.icon).toBe('');}
    await f.db.delete(systemUserLevel);await f.db.insert(systemUserLevel).values(Array.from({length:MAX_OVERVIEW_LEVELS+1},(_,i)=>({id:2000+i,name:'完整等级'+i,grade:i,isShow:1})));
    const result=await read();expect(result.status).toBe(400);expect(result.data).toBeNull();expect((await read('/api/user/level/grade')).data).toHaveLength(MAX_OVERVIEW_LEVELS+1);
  });

  const sequence=(s:Snapshot,name:string)=>s.__sequences!.find(row=>row.name===name)!;
  function onlyAllowedTables(before:Snapshot,after:Snapshot,allowed:string[]){for(const key of Object.keys(before))if(!allowed.includes(key))expect(after[key],key).toEqual(before[key]);}
  async function prepareDetection(){await f.db.execute(sql`TRUNCATE user_level RESTART IDENTITY`);await f.db.update(user).set({level:0,levelStatus:1,exp:'150.25'}).where(eq(user.uid,11));}
  it('measures eligible detection writes separately: exact two grants/sequence and ownlevel only, then an entirely read-only overview',async()=>{
    await prepareDetection();const before=await snapshot(),beforeResources=resources();expect((await request('/api/user/level/detection?uid=22')).status).toBe(200);const after=await snapshot();
    onlyAllowedTables(before,after,['user','user_level','__sequences']);expect(after.user_level!.map(row=>[row.uid,row.level_id,row.status,row.is_del])).toEqual([[11,1,1,0],[11,2,1,0]]);
    expect(after.user).toEqual(before.user!.map(row=>row.uid===11?{...row,level:2}:row));
    for(const name of sequences)expect(sequence(after,name)).toEqual(name==='user_level_id_seq'?{name,last:'2',called:true}:sequence(before,name));expect(resources()).toEqual(beforeResources);
    const data=await overview();expect(data).toMatchObject({current_level_id:2,current_grade:2,preview_only:false,exp:'150.25'});
    const stable=await snapshot();expect((await request('/api/user/level/detection')).status).toBe(200);expect(await snapshot()).toEqual(stable);expect(resources()).toEqual(beforeResources);
  });
  it('restores an existing disabled/deleted grant without allocating its ID again and never activates or rewards',async()=>{
    await prepareDetection();await f.db.insert(userLevel).values([{uid:11,levelId:1,status:1,isDel:0,grade:1},{uid:11,levelId:2,status:0,isDel:1,grade:2}]);
    const before=await snapshot();expect((await request('/api/user/level/detection')).status).toBe(200);const after=await snapshot();
    onlyAllowedTables(before,after,['user','user_level']);expect(after.__sequences).toEqual(before.__sequences);expect(after.user_level![0]).toEqual(before.user_level![0]);
    expect(after.user_level![1]).toMatchObject({id:before.user_level![1]!.id,uid:11,level_id:2,status:1,is_del:0});expect(after.user).toEqual(before.user!.map(row=>row.uid===11?{...row,level:2}:row));
  });
  it.each(['off','inactive','no-eligible'] as const)('keeps detection %s free of business deltas and sequence use',async mode=>{
    await prepareDetection();if(mode==='off')await config('member_func_status','0');if(mode==='inactive')await f.db.update(user).set({levelStatus:0}).where(eq(user.uid,11));
    if(mode==='no-eligible')await f.db.update(systemUserLevel).set({expNum:1000});const before=await snapshot(),resourceBefore=resources();
    expect((await request('/api/user/level/detection')).status).toBe(200);expect(await snapshot()).toEqual(before);expect(resources()).toEqual(resourceBefore);
  });
  it('rolls back a real late grant primary-key failure and reports its nontransactional sequence gap honestly',async()=>{
    await prepareDetection();await f.db.insert(userLevel).values({id:2,uid:22,levelId:3,status:1,isDel:0});const before=await snapshot();
    const response=await request('/api/user/level/detection');expect(response.status).toBe(500);const after=await snapshot();
    onlyAllowedTables(before,after,['__sequences']);for(const name of sequences)expect(sequence(after,name)).toEqual(name==='user_level_id_seq'?{name,last:'2',called:true}:sequence(before,name));
  });
  it('rejects negative experience for detection without clamping, activation, or leaking the account on overview read',async()=>{
    await f.db.update(user).set({exp:'-2.50'}).where(eq(user.uid,11));const before=await snapshot();expect((await request('/api/user/level/detection')).status).toBe(400);expect(await snapshot()).toEqual(before);expect((await overview()).exp).toBe('-2.50');
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('serializes actual simultaneous detection on the same account row lock without duplicate grants',async()=>{
    await prepareDetection();const before=await snapshot();await withFinancePeers(f.db,async([holder,first,second])=>{
      let release!:()=>void,locked!:()=>void;const gate=new Promise<void>(r=>{release=r;}),held=new Promise<void>(r=>{locked=r;});
      const holding=holder.db.transaction(async tx=>{await tx.execute(sql`SELECT uid FROM "user" WHERE uid=11 FOR UPDATE`);locked();await gate;});await held;
      const a=outcome(new UserLevelService(createContainerFromDb(first.db),env).detection(11));
      try {
        // The second waiter queues behind the first tuple lock, not directly
        // behind holder's transaction. Prove both exact native edges in order.
        await waitForFinanceBlock(f.db,first.pid,holder.pid);
        const b=outcome(new UserLevelService(createContainerFromDb(second.db),env).detection(11));
        await waitForFinanceBlock(f.db,second.pid,first.pid);
        release();await holding;
        expect(await a).toEqual({ok:true,value:true});expect(await b).toEqual({ok:true,value:true});
      } finally {release();await holding;await a;}
    });
    const after=await snapshot();onlyAllowedTables(before,after,['user','user_level','__sequences']);expect(after.user_level).toHaveLength(2);
    expect(after.user_level!.map(row=>row.level_id)).toEqual([1,2]);expect(sequence(after,'user_level_id_seq')).toEqual({name:'user_level_id_seq',last:'2',called:true});
  },30_000);
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('binds all six legacy fields and new cards/exp/config/count to one real RR snapshot across a concurrent commit',async()=>{
    await withFinancePeers(f.db,async([reader,editor])=>{
      const original=UserDao.prototype.findForAuth;let release!:()=>void,notify!:()=>void;
      const held=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{notify=r;});
      let gated=false;
      // Preserve the actual SQL result, pausing only after its real first read.
      const probe=vi.spyOn(UserDao.prototype,'findForAuth').mockImplementation(async function(this:UserDao,uid:number){
        const account=await original.call(this,uid);if(!gated){gated=true;notify();await held;}return account;
      });
      const work=outcome(new UserLevelService(createContainerFromDb(reader.db),env).userLevelInfo(11,true));
      try{await started;await editor.db.transaction(async tx=>{
        await tx.update(user).set({exp:'75.25'}).where(eq(user.uid,11));
        await tx.update(systemUserLevel).set({name:'并发提交等级',expNum:150}).where(eq(systemUserLevel.id,2));
        await tx.update(systemConfig).set({value:'"8.50"'}).where(eq(systemConfig.menuName,'order_give_exp'));
        await tx.insert(userSign).values({uid:11,addTime:1792900000});
      });release();const result=await work;expect(result.ok).toBe(true);if(!result.ok)throw result.error;
        expect(result.value).toMatchObject({currentExp:42.75,overview:{exp:'42.75',task:{order:'1.25',sign_count:3}}});
        expect(result.value.overview!.levels[1]).toMatchObject({name:'白银会员',exp_num:100,lack_exp_num:'57'});
        expect((result.value.level_list as Row[])[1]).toMatchObject({name:'白银会员',exp_num:100});
      }finally{release();await work;probe.mockRestore();}
      const fresh=await overview();expect(fresh).toMatchObject({exp:'75.25',task:{order:'8.50',sign_count:4}});expect(fresh.levels[1]).toMatchObject({name:'并发提交等级',exp_num:150});
    });
  },30_000);
});
