import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { kefuVisitorSession, storeOrder, storeOrderCartInfo, storeProduct, storeProductRelation, storeService, storeServiceLog, storeServiceRecord, storeServiceTransfer, storeVisit, user, userLabelRelation } from '../src/models/schema';
import { KefuCoreService } from '../src/services/kefu/KefuCoreService';
import { KefuProductService } from '../src/services/kefu/KefuProductService';
import { KefuTransferService } from '../src/services/kefu/KefuTransferService';
import { KefuVisitorSessionService } from '../src/services/kefu/KefuVisitorSessionService';
import { createToken, md5 } from '../src/utils/jwt';
import { collisionUid, kefuMobileWorkbenchFixture } from './helpers/kefuMobileWorkbenchFixture';

// Only the external Redis transport is substituted. Real cache key, token,
// expiry, issuer, role, password and SQL authority checks execute unchanged.
const redis=vi.hoisted(()=>new Map<string,{value:unknown;until:number}>());
vi.mock('@upstash/redis/cloudflare',()=>({Redis:class {
  async set(key:string,value:unknown,options:{ex?:number}={}){redis.set(key,{value:structuredClone(value),until:Date.now()+(options.ex??3600)*1000});return 'OK';}
  async get(key:string){const row=redis.get(key);return row&&row.until>Date.now()?structuredClone(row.value):null;}
  async del(key:string){return Number(redis.delete(key));}
}}));

// Observes a fulfilled real Drizzle query and pauses the caller; it never
// replaces SQL, query results, transactions, locks or authority decisions.
function observeGrantRead(db:DbClient, afterGrant:()=>Promise<void>):DbClient {
  let observed=false;
  const query=(builder:any):any=>new Proxy(builder,{get(target,key){
    if(key==='then')return(resolve:any,reject:any)=>target.then(async(rows:any)=>{
      if(!observed&&target.toSQL().sql.includes('from "store_service_record"')){observed=true;await afterGrant();}return rows;
    }).then(resolve,reject);
    const value=Reflect.get(target,key,target);return typeof value==='function'?(...args:any[])=>{const next=value.apply(target,args);return next&&typeof next==='object'&&typeof next.toSQL==='function'?query(next):next;}:value;
  }});
  const database=(client:any):DbClient=>new Proxy(client,{get(target,key){
    if(key==='select')return(...args:any[])=>query(target.select(...args));
    if(key==='transaction')return(work:any,...args:any[])=>target.transaction((tx:any)=>work(database(tx)),...args);
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }}) as DbClient;
  return database(db);
}
function signal(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('kefu mobile ordinary LOGIN PG16 and actual Hono routes',()=>{
  let f:Awaited<ReturnType<typeof kefuMobileWorkbenchFixture>>;
  beforeAll(async()=>{f=await kefuMobileWorkbenchFixture();},30000);
  beforeEach(async()=>{redis.clear();await f.reset();});
  afterAll(async()=>{await f?.close();},30000);
  const run=async(work:(context:{peer:Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0];request:(path:string,body?:unknown,token?:string)=>Promise<{status:number;msg:string;data:any}>;token:string})=>Promise<void>)=>f.withRuntimeRole(async peer=>{
    await f.installPlan(peer);
    const [identity]=await peer.db.execute(sql`SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version`);
    console.info('KEFU_MOBILE_SQL_CONTEXT',JSON.stringify(identity));
    const app=f.appFor(peer.db);
    const request=async(path:string,body?:unknown,token?:string)=>{
      const response=await app.request(`https://owned-kefu.local/kefuapi${path}`,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
      expect(response.status).toBe(200);return await response.json() as {status:number;msg:string;data:any};
    };
    const login=await request('/login',{account:'actual-kefu-one',password:f.password});expect(login.status).toBe(200);expect(login.data.kefuInfo.uid).toBe(101);expect(login.data.kefuInfo).not.toHaveProperty('password');
    await work({peer,request,token:login.data.token});
  });

  it('pages all 72 owned registered sessions beyond the old first 60 with tied timestamps and no overlap',async()=>run(async({request,token})=>{
    let cursor:string|null=null;const ids:number[]=[];let pages=0;
    do{const result=await request(`/user/record?is_tourist=0&limit=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,undefined,token);expect(result.status).toBe(200);ids.push(...result.data.list.map((row:{id:number})=>row.id));expect(result.data.list.every((row:{user_id:number;is_tourist:number})=>row.user_id===101&&row.is_tourist===0)).toBe(true);cursor=result.data.next_cursor;pages++;}while(cursor);
    expect(pages).toBe(3);expect(ids).toHaveLength(72);expect(new Set(ids).size).toBe(72);expect(ids).toEqual([...ids].sort((a,b)=>b-a));expect(ids).not.toContain(4);
  }));
  it('searches the full registered database by current nickname and phone while keeping owner scope',async()=>run(async({request,token})=>{
    for(const keyword of ['唯一客户搜索','13900000201']){const result=await request(`/user/record?nickname=${encodeURIComponent(keyword)}&limit=1`,undefined,token);expect(result.status).toBe(200);expect(result.data.list.map((row:{to_uid:number})=>row.to_uid)).toEqual([201]);}
    const privateResult=await request('/user/record?nickname=PRIVATE%20OTHER',undefined,token);expect(privateResult.data.list).toEqual([]);
  }));
  it('keeps same-number tourists free of registered nickname, avatar, phone and search matches',async()=>run(async({request,token})=>{
    const result=await request('/user/record?is_tourist=1',undefined,token);expect(result.status).toBe(200);expect(result.data.list).toHaveLength(1);expect(result.data.list[0]).toMatchObject({to_uid:collisionUid,nickname:'实际游客昵称',avatar:'/visitor.png',phone:'',is_tourist:1});expect(JSON.stringify(result)).not.toContain('PRIVATE COLLISION');
    for(const keyword of ['PRIVATE COLLISION','13999999999'])expect((await request(`/user/record?is_tourist=1&nickname=${encodeURIComponent(keyword)}`,undefined,token)).data.list).toEqual([]);
    expect((await request(`/user/record?is_tourist=1&nickname=${encodeURIComponent('实际游客')}`,undefined,token)).data.list).toHaveLength(1);
  }));
  it('keeps exact history pages chronological, unique and bounded by current owner and visitor domain',async()=>run(async({request,token})=>{
    const first=await request('/service/list?uid=201&limit=2',undefined,token);expect(first.status).toBe(200);expect(first.data.map((row:{id:number})=>row.id)).toEqual([53,54]);
    const second=await request('/service/list?uid=201&limit=2&upperId=53',undefined,token);expect(second.data.map((row:{id:number})=>row.id)).toEqual([51,52]);
    const third=await request('/service/list?uid=201&limit=2&upper_id=51',undefined,token);expect(third.data.map((row:{id:number})=>row.id)).toEqual([50]);
    expect((await request('/service/list?uid=202',undefined,token)).status).toBe(404);
    const tourist=await request(`/service/list?uid=${collisionUid}&is_tourist=1&limit=20`,undefined,token);expect(tourist.data.map((row:{id:number})=>row.id)).toEqual([90,91,92,93]);expect(JSON.stringify(tourist)).not.toContain('PRIVATE REGISTERED BODY');
  }));
  it('rejects invalid cursors, page bounds, visitor flags and duplicate conversation grants',async()=>run(async({request,token})=>{
    for(const query of ['cursor=bad','limit=101','is_tourist=2'])expect((await request(`/user/record?${query}`,undefined,token)).status).toBe(400);
    await f.db.insert(storeServiceRecord).values({userId:101,toUid:201,isTourist:0});
    expect((await request('/user/record',undefined,token)).status).toBe(400);expect((await request('/service/list?uid=201',undefined,token)).status).toBe(400);
  }));
  it('hides expired and revoked visitor assignments and denies their history without touching registered peers',async()=>run(async({request,token})=>{
    await f.db.update(kefuVisitorSession).set({expiresAt:Math.floor(Date.now()/1000)-1}).where(eq(kefuVisitorSession.visitorUid,collisionUid));
    expect((await request('/user/record?is_tourist=1',undefined,token)).data.list).toEqual([]);expect((await request(`/service/list?uid=${collisionUid}&is_tourist=1`,undefined,token)).status).toBe(404);
    await f.db.update(kefuVisitorSession).set({expiresAt:Math.floor(Date.now()/1000)+600,revokedAt:Math.floor(Date.now()/1000)}).where(eq(kefuVisitorSession.visitorUid,collisionUid));
    expect((await request('/user/record?is_tourist=1',undefined,token)).data.list).toEqual([]);expect((await request(`/service/list?uid=${collisionUid}&is_tourist=1`,undefined,token)).status).toBe(404);
    expect((await request(`/service/list?uid=${collisionUid}&is_tourist=0`,undefined,token)).data.map((row:{id:number})=>row.id)).toEqual([95]);
  }));
  it('persists real replies and only clears unread for the selected composite conversation',async()=>run(async({peer,token})=>{
    const service=f.realtimeFor(peer.db),session={...await f.sessionFor(token),toUid:collisionUid,isTourist:0 as const};
    await service.switchConversation(session,collisionUid);
    const records=await f.db.select().from(storeServiceRecord).where(and(eq(storeServiceRecord.userId,101),eq(storeServiceRecord.toUid,collisionUid)));
    expect(records.find(row=>row.isTourist===0)?.messageNum).toBe(0);expect(records.find(row=>row.isTourist===1)?.messageNum).toBe(4);
    const persisted=await service.persistMessage(session,{toUid:collisionUid,message:'实际客服回复',messageType:1});expect(persisted.sender_role).toBe(2);
    const [saved]=await f.db.select().from(storeServiceLog).where(eq(storeServiceLog.id,persisted.id));expect(saved).toMatchObject({uid:101,toUid:collisionUid,isTourist:0,msn:'实际客服回复',type:0});
    await service.markMessageRead(persisted);expect((await f.db.select().from(storeServiceLog).where(eq(storeServiceLog.id,persisted.id)))[0].type).toBe(1);
    const next=await service.persistMessage(session,{toUid:collisionUid,message:'实际后续回复',messageType:1});expect(next.id).toBeGreaterThan(persisted.id);
    expect((await f.db.select().from(storeServiceLog).where(eq(storeServiceLog.id,next.id)))[0]).toMatchObject({id:next.id,uid:101,toUid:collisionUid,isTourist:0,msn:'实际后续回复'});
  }));
  it('cancels staff viewing with id zero without changing unread, peer presence or message state',async()=>run(async({peer,token})=>{
    const before=await f.db.select().from(storeServiceRecord),logs=await f.db.select().from(storeServiceLog),service=f.realtimeFor(peer.db),session=await f.sessionFor(token);
    expect(await service.switchConversation(session,0)).toBe(0);expect(await f.db.select().from(storeServiceRecord)).toEqual(before);expect(await f.db.select().from(storeServiceLog)).toEqual(logs);
    await expect(service.switchConversation(f.visitorSession(),0)).rejects.toThrow('会话用户无效');
  }));
  it('changes availability under the actual agent identity and rejects online writes after user soft deletion',async()=>run(async({peer,request,token})=>{
    const service=f.realtimeFor(peer.db),session=await f.sessionFor(token);
    await service.setOnline(session,false);expect((await f.db.select().from(storeService).where(eq(storeService.id,1)))[0].online).toBe(0);await service.setOnline(session,true);
    await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,101));
    await expect(service.assertSession(session)).rejects.toThrow('客服登录状态已失效');await expect(service.setOnline(session,false)).rejects.toThrow('客服登录状态已失效');expect((await f.db.select().from(storeService).where(eq(storeService.id,1)))[0].online).toBe(1);
    expect((await request('/user/record',undefined,token)).status).toBe(410002);
  }));
  it('excludes invalid bound users from assignment and transfer lists and refuses those transfer targets',async()=>run(async({peer,request,token})=>{
    expect((await request('/service/transfer_list',undefined,token)).data.list.map((row:{uid:number})=>row.uid)).toEqual([102]);
    expect((await f.realtimeFor(peer.db).serviceList(true)).map(row=>row.uid)).toEqual([101,102]);
    for(const uid of [103,104,105]){const rejected=await request('/service/transfer',{uid:201,kefuToUid:uid,is_tourist:0,request_key:crypto.randomUUID()},token);expect(rejected.status).toBe(404);}
    const visitor=new KefuVisitorSessionService(createContainerFromDb(peer.db),f.env);const bound=await visitor.authenticate(f.visitorToken());expect(bound.kefuUid).toBe(101);
    await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,101));await expect(visitor.authenticate(f.visitorToken())).rejects.toThrow('分配客服已失效');
  }));
  it('moves registered ownership once, replays the receipt and closes source history and stale realtime writes',async()=>run(async({peer,request,token})=>{
    const key=crypto.randomUUID(),input={uid:201,kefuToUid:102,is_tourist:0,request_key:key};
    const result=await request('/service/transfer',input,token);expect(result.status).toBe(200);expect(result.data).toMatchObject({from_uid:101,to_uid:102,idempotent:false,copied_message_count:5});
    const replay=await request('/service/transfer',input,token);expect(replay.data.idempotent).toBe(true);expect(await f.db.select().from(storeServiceTransfer)).toHaveLength(1);
    expect((await request('/service/list?uid=201',undefined,token)).status).toBe(404);await expect(f.realtimeFor(peer.db).persistMessage(await f.sessionFor(token),{toUid:201,message:'STALE SOURCE',messageType:1})).rejects.toThrow('当前客服与该用户没有会话');
    const targetLogin=await request('/login',{account:'actual-kefu-two',password:f.password});const target=await request('/service/list?uid=201&limit=20',undefined,targetLogin.data.token);expect(target.status).toBe(200);expect(target.data).toHaveLength(5);expect(target.data.every((row:{uid:number;to_uid:number})=>row.uid===102||row.to_uid===102)).toBe(true);
  }));
  it('moves only visitor ownership and keeps a same-number registered conversation assigned to the source',async()=>run(async({peer,request,token})=>{
    const result=await request('/service/transfer',{uid:collisionUid,kefuToUid:102,is_tourist:1,request_key:crypto.randomUUID()},token);expect(result.status).toBe(200);expect(result.data.copied_message_count).toBe(4);
    const [assignment]=await f.db.select().from(kefuVisitorSession).where(eq(kefuVisitorSession.visitorUid,collisionUid));expect(assignment).toMatchObject({kefuUid:102,serviceId:2});
    expect((await request(`/service/list?uid=${collisionUid}&is_tourist=1`,undefined,token)).status).toBe(404);expect((await request(`/service/list?uid=${collisionUid}&is_tourist=0`,undefined,token)).data[0].msn).toBe('PRIVATE REGISTERED BODY');
    await expect(f.realtimeFor(peer.db).persistMessage({...await f.sessionFor(token),toUid:collisionUid,isTourist:1},{toUid:collisionUid,message:'STALE VISITOR OWNER',messageType:1})).rejects.toThrow('游客会话不存在');
  }));
  it('rejects User/Admin tokens, mismatched/revoked buckets and changed passwords instead of substituting staff identity',async()=>run(async({peer,request,token})=>{
    for(const role of ['api','admin','supplier'] as const){const wrong=await createToken(1,role,md5(f.passwordHash),f.env.APP_KEY);redis.set(`tb_${md5(wrong.token)}`,{value:{uid:1,type:role,token:wrong.token},until:Date.now()+60000});expect((await request('/user/record',undefined,wrong.token)).status).not.toBe(200);}
    const key=`tb_${md5(token)}`,saved=redis.get(key)!;redis.set(key,{...saved,value:{uid:2,type:'kefu',token}});expect((await request('/user/record',undefined,token)).status).toBe(410002);redis.set(key,saved);
    await f.db.update(storeService).set({password:'changed-password-version'}).where(eq(storeService.id,1));await expect(f.realtimeFor(peer.db).assertSession(await f.sessionFor(token))).rejects.toThrow('客服登录状态已失效');expect((await request('/user/record',undefined,token)).status).toBe(410001);
    redis.delete(key);expect((await request('/user/record',undefined,token)).status).toBe(410000);
  }));
  it('revalidates registered customer soft deletion against the same realtime Auth contract',async()=>run(async({peer})=>{
    const token=await createToken(201,'api',md5('owned-customer-password'),f.env.APP_KEY);redis.set(`tb_${md5(token.token)}`,{value:{uid:201,type:'api',token:token.token},until:Date.now()+60000});
    const session={principalUid:201,role:1 as const,isTourist:0 as const,toUid:101,authId:201,tokenKey:md5(token.token),expiresAt:token.exp,authVersion:md5('owned-customer-password'),connectedAt:Math.floor(Date.now()/1000)};
    await f.realtimeFor(peer.db).assertSession(session);await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,201));await expect(f.realtimeFor(peer.db).assertSession(session)).rejects.toThrow('用户登录状态已失效');
    await expect(new KefuCoreService(createContainerFromDb(peer.db),f.env).userInfo(101,201)).rejects.toThrow('用户不存在');
  }));
  it('revalidates current account status, deletion and bound-user status for HTTP and realtime writes',async()=>run(async({peer,request,token})=>{
    let current=token;const service=f.realtimeFor(peer.db);
    for(const patch of [{status:0},{accountStatus:0},{isDel:1}] as const){
      const session=await f.sessionFor(current),before=await f.db.select().from(storeServiceLog);
      await f.db.update(storeService).set(patch).where(eq(storeService.id,1));
      await expect(service.assertSession(session)).rejects.toThrow('客服登录状态已失效');await expect(service.persistMessage(session,{toUid:201,message:'DENIED ACCOUNT MESSAGE',messageType:1})).rejects.toThrow('客服登录状态已失效');
      expect(await f.db.select().from(storeServiceLog)).toEqual(before);expect((await request('/user/record',undefined,current)).status).toBe(410002);
      await f.db.update(storeService).set({status:1,accountStatus:1,isDel:0}).where(eq(storeService.id,1));const login=await request('/login',{account:'actual-kefu-one',password:f.password});expect(login.status).toBe(200);current=login.data.token;
    }
    for(const patch of [{status:0},{isDel:1}] as const){
      const session=await f.sessionFor(current);await f.db.update(user).set(patch).where(eq(user.uid,101));await expect(service.assertSession(session)).rejects.toThrow('客服登录状态已失效');expect((await request('/user/record',undefined,current)).status).toBe(410002);
      await f.db.update(user).set({status:1,isDel:0}).where(eq(user.uid,101));const login=await request('/login',{account:'actual-kefu-one',password:f.password});expect(login.status).toBe(200);current=login.data.token;
    }
  }));
  it('bootstraps visitors only to a currently active bound user and rejects an empty valid candidate set',async()=>run(async({peer})=>{
    await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,101));
    const service=new KefuVisitorSessionService(createContainerFromDb(peer.db),f.env);const result=await service.bootstrap(null,'198.51.100.61');expect(result.uid).toBe(102);expect(result.tourist_uid).toBeGreaterThan(1_000_000_001);
    await f.db.update(user).set({status:0}).where(eq(user.uid,102));await expect(service.bootstrap(null,'198.51.100.62')).rejects.toThrow('暂无客服人员在线');
  }));
  it('projects global staff availability for both buyer domains without interpreting historical form-type as a role',async()=>run(async({peer,token})=>{
    await f.db.insert(storeServiceRecord).values([
      {userId:201,toUid:101,isTourist:0,type:2,online:1,nickname:'历史小程序客户摘要'},
      {userId:collisionUid,toUid:101,isTourist:1,type:3,online:1,nickname:'历史H5游客摘要'},
      {userId:102,toUid:101,isTourist:0,type:2,online:1,nickname:'同号普通用户历史摘要'},
    ]);
    const before=await f.db.select().from(storeServiceRecord),service=f.realtimeFor(peer.db),session=await f.sessionFor(token),visitor=new KefuVisitorSessionService(createContainerFromDb(peer.db),f.env);
    await service.setOnline(session,false);expect((await service.userConversationList(201,{}))[0].online).toBe(0);expect((await visitor.authenticate(f.visitorToken())).serviceOnline).toBe(0);expect(await f.db.select().from(storeServiceRecord)).toEqual(before);
    await service.setOnline({...session,isTourist:1},true);expect((await service.userConversationList(201,{}))[0].online).toBe(1);expect((await visitor.authenticate(f.visitorToken())).serviceOnline).toBe(1);expect(await f.db.select().from(storeServiceRecord)).toEqual(before);
    await service.setDisconnected(session);expect((await service.userConversationList(201,{}))[0].online).toBe(0);expect((await visitor.authenticate(f.visitorToken())).serviceOnline).toBe(0);expect(await f.db.select().from(storeServiceRecord)).toEqual(before);
  }));
  it('authorizes delivery by the payload domain and exact current record rather than the active socket conversation',async()=>run(async({peer,request,token})=>{
    const service=f.realtimeFor(peer.db),session={...await f.sessionFor(token),toUid:0,isTourist:0 as const};
    expect(await service.canDeliverConversation(session,collisionUid,1,2)).toBe(true);
    expect(await service.canDeliverConversation(session,collisionUid,0,3)).toBe(true);
    expect(await service.canDeliverConversation(session,collisionUid,1,3)).toBe(false);
    const targetLogin=await request('/login',{account:'actual-kefu-two',password:f.password});expect(targetLogin.status).toBe(200);
    const first=await request('/service/transfer',{uid:collisionUid,kefuToUid:102,is_tourist:1,request_key:crypto.randomUUID()},token);expect(first.status).toBe(200);
    expect(await service.canDeliverConversation(session,collisionUid,1,2)).toBe(false);
    expect(await service.canDeliverConversation(session,collisionUid,0,3)).toBe(true);
    await service.assertSession(session);
    const target=await f.sessionFor(targetLogin.data.token);
    expect(await service.canDeliverConversation(target,collisionUid,1,first.data.recored.id)).toBe(true);
    const back=await request('/service/transfer',{uid:collisionUid,kefuToUid:101,is_tourist:1,request_key:crypto.randomUUID()},targetLogin.data.token);expect(back.status).toBe(200);
    expect(await service.canDeliverConversation(target,collisionUid,1,first.data.recored.id)).toBe(false);
    expect(await service.canDeliverConversation(session,collisionUid,1,2)).toBe(false);
    expect(await service.canDeliverConversation(session,collisionUid,1,back.data.recored.id)).toBe(true);
    expect(await service.canDeliverConversation(session,collisionUid,1)).toBe(true);
    await f.db.update(kefuVisitorSession).set({revokedAt:Math.floor(Date.now()/1000)}).where(eq(kefuVisitorSession.visitorUid,collisionUid));
    expect(await service.canDeliverConversation(session,collisionUid,1,back.data.recored.id)).toBe(false);
    await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,collisionUid));
    expect(await service.canDeliverConversation(session,collisionUid,0,3)).toBe(false);
  }));
  it('holds the shared ownership locks through complete context reads and nested group or label writes while real transfer waits',async()=>run(async({peer})=>{
    for(const operation of ['info','labels','group','set-labels'] as const){
      await f.reset();
      await f.withRuntimeRole(async other=>{
        await f.installPlan(other);console.info('KEFU_MOBILE_CONCURRENCY_SQL_CONTEXT',JSON.stringify({role:other.role,pid:other.pid,blocker:peer.pid,operation}));
        const entered=signal(),release=signal(),observed=observeGrantRead(peer.db,async()=>{entered.resolve();await release.promise;});
        const core=new KefuCoreService(createContainerFromDb(observed),f.env);
        const work=operation==='info'?core.userInfo(101,201):operation==='labels'?core.userLabels(101,201):operation==='group'?core.setUserGroup(101,201,1):core.setUserLabels(101,201,{label_ids:[1]});
        await entered.promise;
        const transfer=new KefuTransferService(createContainerFromDb(other.db)).transfer(1,101,{uid:201,kefuToUid:102,is_tourist:0,request_key:crypto.randomUUID()});
        let blocked=false;
        try{for(let attempt=0;attempt<30;attempt++){
          const [state]=await f.db.execute(sql`SELECT ${peer.pid} = ANY(pg_blocking_pids(${other.pid})) AS blocked`);
          if(state.blocked===true){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
        }expect(blocked).toBe(true);}finally{release.resolve();}
        const result=await work;expect((await transfer).to_uid).toBe(102);
        if(operation==='info')expect(result).toMatchObject({uid:201,phone:'13900000201'});
        if(operation==='labels')expect(result).toEqual([expect.objectContaining({name:'实际客服标签类别'})]);
        if(operation==='group')expect((await f.db.select().from(user).where(eq(user.uid,201)))[0].groupId).toBe(1);
        if(operation==='set-labels')expect(await f.db.select().from(userLabelRelation).where(eq(userLabelRelation.uid,201))).toHaveLength(1);
        const stale=new KefuCoreService(createContainerFromDb(peer.db),f.env);
        await expect(stale.userInfo(101,201)).rejects.toThrow('不存在');await expect(stale.userLabels(101,201)).rejects.toThrow('不存在');
        await expect(stale.setUserGroup(101,201,1)).rejects.toThrow('不存在');await expect(stale.setUserLabels(101,201,{un_label_ids:[1]})).rejects.toThrow('不存在');
      });
    }
  }),30000);
  it('filters deleted customer context and referral names without using referral identity as a conversation grant',async()=>run(async({peer})=>{
    await f.db.update(user).set({spreadUid:202}).where(eq(user.uid,201));
    const core=new KefuCoreService(createContainerFromDb(peer.db),f.env);expect((await core.userInfo(101,201)).spread_name).toBe('PRIVATE OTHER CUSTOMER');
    await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,202));expect((await core.userInfo(101,201)).spread_name).toBe('');
    await f.db.update(user).set({deleteTime:new Date()}).where(eq(user.uid,201));
    await expect(core.userLabels(101,201)).rejects.toThrow('用户不存在');await expect(core.setUserGroup(101,201,1)).rejects.toThrow('用户不存在');await expect(core.setUserLabels(101,201,{label_ids:[1]})).rejects.toThrow('用户不存在');
    expect((await f.db.select().from(user).where(eq(user.uid,201)))[0].groupId).toBe(0);expect(await f.db.select().from(userLabelRelation)).toEqual([]);
  }));
  it('rechecks the ownership grant inside purchased, visited and recommended-product reads after an actual intervening transfer',async()=>run(async({peer})=>{
    for(const kind of ['purchased','visited','hot','public-search'] as const){
      await f.reset();await f.db.insert(storeProduct).values({id:1,storeName:'PRIVATE CUSTOMER PRODUCT',isShow:1,isDel:0,pid:0});
      await f.db.insert(storeOrder).values({id:1,uid:201,orderId:'actual-kefu-product-order'});await f.db.insert(storeOrderCartInfo).values({oid:1,productId:1,unique:'owned-product-snapshot'});
      await f.db.insert(storeVisit).values({uid:201,productId:1});await f.db.insert(storeProductRelation).values({productId:1,type:1,relationId:1});
      await f.withRuntimeRole(async other=>{
        await f.installPlan(other);const observed=observeGrantRead(peer.db,async()=>{const moved=await new KefuTransferService(createContainerFromDb(other.db)).transfer(1,101,{uid:201,kefuToUid:102,is_tourist:0,request_key:crypto.randomUUID()});expect(moved.to_uid).toBe(102);});
        const service=new KefuProductService(createContainerFromDb(observed));
        const result=kind==='visited'?await service.visitedProducts(101,201,{}):kind==='hot'?await service.hotProducts(101,201,{}):await service.purchasedProducts(101,201,kind==='public-search'?{store_name:'PRIVATE CUSTOMER PRODUCT'}:{});
        expect(result).toEqual(kind==='public-search'?[expect.objectContaining({id:1,store_name:'PRIVATE CUSTOMER PRODUCT'})]:[]);
      });
    }
  }));
  it('returns no historical body when ownership transfers after the initial real grant read and before the history SQL executes',async()=>run(async({peer})=>{
    await f.withRuntimeRole(async other=>{
      await f.installPlan(other);const observed=observeGrantRead(peer.db,async()=>{await new KefuTransferService(createContainerFromDb(other.db)).transfer(1,101,{uid:201,kefuToUid:102,is_tourist:0,request_key:crypto.randomUUID()});});
      expect(await new KefuCoreService(createContainerFromDb(observed),f.env).chatHistory(101,201,0,0,20)).toEqual([]);
    });
  }));
  it('hides deleted-customer purchasing, browsing and recommendation context while preserving the public catalog search',async()=>run(async({peer})=>{
    await f.db.insert(storeProduct).values({id:1,storeName:'公开商品',isShow:1,isDel:0,pid:0});
    await f.db.insert(storeOrder).values({id:1,uid:201,orderId:'actual-deleted-customer-order'});await f.db.insert(storeOrderCartInfo).values({oid:1,productId:1,unique:'deleted-context-snapshot'});
    await f.db.insert(storeVisit).values({uid:201,productId:1});await f.db.insert(storeProductRelation).values({productId:1,type:1,relationId:1});
    const service=new KefuProductService(createContainerFromDb(peer.db));
    for(const patch of [{isDel:1,deleteTime:null},{isDel:0,deleteTime:new Date()}]){
      await f.db.update(user).set(patch).where(eq(user.uid,201));
      expect(await service.purchasedProducts(101,201,{})).toEqual([]);expect(await service.visitedProducts(101,201,{})).toEqual([]);expect(await service.hotProducts(101,201,{})).toEqual([]);
      expect(await service.purchasedProducts(101,201,{store_name:'公开商品'})).toEqual([expect.objectContaining({id:1,store_name:'公开商品'})]);
    }
  }));
});
