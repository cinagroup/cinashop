import bcrypt from 'bcryptjs';
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../../src/env';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { kefuVisitorSession, legacyCategory, storeOrder, storeOrderCartInfo, storeProduct, storeProductRelation, storeService, storeServiceLog, storeServiceRecord, storeServiceTransfer, storeVisit, systemAttachment, systemConfig, systemUserLevel, user, userGroup, userLabel, userLabelRelation } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { kefuapiRoutes } from '../../src/routes/kefuapi';
import { KefuRealtimeService, type ChatSocketSession } from '../../src/services/kefu/KefuRealtimeService';
import { sha256Hex, signVisitorToken } from '../../src/services/kefu/KefuVisitorSessionService';
import { ApiException } from '../../src/utils/errors';
import { md5, verifyToken } from '../../src/utils/jwt';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const kefuMobileTables = [user, storeService, storeServiceRecord, storeServiceLog, storeServiceTransfer, kefuVisitorSession, systemAttachment, systemConfig, userGroup, userLabel, userLabelRelation, legacyCategory, systemUserLevel, storeOrder, storeOrderCartInfo, storeProduct, storeProductRelation, storeVisit];
export const collisionUid = 1_000_000_001;
const ident=(value:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(value))throw Error('Invalid owned kefu fixture identifier');return `"${value}"`;};
type Runtime = SequenceRunnerPeer & { role:string; connectionString:string };

/** Fresh native PG16 database and real independent LOGIN using only the actual
 * app privilege plan. Redis/rate-limit/network transports are separate fixtures;
 * no application query, authority check or SQL result is substituted here. */
export async function kefuMobileWorkbenchFixture() {
  const f=await sequenceRunnerDatabase();
  if(f.format!=='pg16'||!f.withRuntimeRole){await f.close();throw Error('Kefu mobile acceptance requires native PG16 independent LOGIN');}
  try {
    await f.exec('CREATE SEQUENCE public.kefu_visitor_uid_seq START 1000000100 MINVALUE 1 MAXVALUE 2147483647');
    const dialect=new PgDialect();
    for(const table of kefuMobileTables){
      const definition=getTableConfig(table);
      const columns=definition.columns.map(column=>{
        const initial=column.default, value=initial===undefined?'':` DEFAULT ${initial instanceof SQL?dialect.sqlToQuery(initial).sql:dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${ident(column.name)} ${column.getSQLType()}${value}${column.notNull?' NOT NULL':''}${column.primary?' PRIMARY KEY':''}${column.isUnique?' UNIQUE':''}`;
      });
      await f.exec(`CREATE TABLE public.${ident(definition.name)} (${columns.join(',')})`);
    }
    const password='Kefu-Mobile-Owned-2026',passwordHash=await bcrypt.hash(password,4);
    const env={APP_KEY:'owned-kefu-mobile-acceptance-key',NODE_ENV:'production',UPSTASH_REDIS_URL:'https://owned-kefu-redis.invalid',UPSTASH_REDIS_TOKEN:'owned-infrastructure-only',
      CONFIG_KV:{get:async()=>null,put:async()=>{},delete:async()=>{}},TOKEN_BUCKET:{getByName:()=>({consumeRateLimit:async()=>({allowed:true,auditEvent:false,limit:10,remaining:9,resetAt:Date.now()+60000})})},
      CHAT_ROOM:{getByName:()=>({deliverTransfer:async()=>0,disconnectToken:async()=>0})}} as unknown as Env;
    let visitorToken='',visitorHash='',expiresAt=0;
    const reset=async()=>{
      for(const table of [...kefuMobileTables].reverse())await f.db.delete(table);
      const now=Math.floor(Date.now()/1000);expiresAt=now+1800;
      await f.db.insert(user).values([
        {uid:101,account:'agent-one-user',pwd:'agent-user-password',nickname:'客服一',status:1},
        {uid:102,account:'agent-two-user',pwd:'agent-user-password',nickname:'客服二',status:1},
        {uid:103,account:'disabled-agent-user',status:0},
        {uid:104,account:'deleted-agent-user',deleteTime:new Date()},
        {uid:201,account:'actual-customer',pwd:'owned-customer-password',nickname:'唯一客户搜索',phone:'13900000201',avatar:'/registered.png'},
        {uid:202,account:'other-owner-customer',nickname:'PRIVATE OTHER CUSTOMER'},
        {uid:collisionUid,account:'collision-user',pwd:'collision-password',nickname:'PRIVATE COLLISION REGISTERED',phone:'13999999999',avatar:'/PRIVATE-COLLISION.png'},
        ...Array.from({length:70},(_,i)=>({uid:300+i,account:`page-customer-${i}`,nickname:`分页客户${i}`,status:1})),
      ]);
      await f.db.insert(storeService).values([
        {id:1,uid:101,account:'actual-kefu-one',password:passwordHash,nickname:'客服一',online:1},
        {id:2,uid:102,account:'actual-kefu-two',password:passwordHash,nickname:'客服二',online:1},
        {id:3,uid:103,account:'disabled-bound-user',password:passwordHash,nickname:'停用用户客服',online:1},
        {id:4,uid:104,account:'deleted-bound-user',password:passwordHash,nickname:'软删用户客服',online:1},
        {id:5,uid:105,account:'missing-bound-user',password:passwordHash,nickname:'无用户客服',online:1},
      ]);
      await f.db.insert(userGroup).values({ id: 1, groupName: '实际客服分组' });
      await f.db.insert(legacyCategory).values({ id: 1, name: '实际客服标签类别', ownerId: 0, type: 0, relationId: 0, group: 0, isShow: 1 });
      await f.db.insert(userLabel).values({ id: 1, name: '实际客服标签', labelCate: 1, type: 0, relationId: 0, status: 1 });
      const sessionId=crypto.randomUUID();visitorToken=await signVisitorToken(env.APP_KEY,sessionId,collisionUid,expiresAt);visitorHash=await sha256Hex(visitorToken);
      await f.db.insert(kefuVisitorSession).values({sessionId,visitorUid:collisionUid,serviceId:1,kefuUid:101,tokenHash:visitorHash,nickname:'实际游客昵称',avatar:'/visitor.png',createdAt:now,expiresAt,lastSeenAt:now});
      await f.db.insert(storeServiceRecord).values([
        {id:1,userId:101,toUid:201,nickname:'旧客户名称',isTourist:0,updateTime:1700000000,messageNum:5,message:'客户未读'},
        {id:2,userId:101,toUid:collisionUid,nickname:'实际游客昵称',avatar:'/visitor.png',isTourist:1,updateTime:1700000000,messageNum:4,message:'游客未读'},
        {id:3,userId:101,toUid:collisionUid,nickname:'注册撞号记录',isTourist:0,updateTime:1700000000,messageNum:1,message:'注册撞号'},
        {id:4,userId:102,toUid:202,nickname:'PRIVATE OTHER CUSTOMER',isTourist:0,updateTime:1800000000,messageNum:1,message:'PRIVATE OTHER OWNER'},
        ...Array.from({length:70},(_,i)=>({id:30+i,userId:101,toUid:300+i,nickname:`分页客户${i}`,isTourist:0,updateTime:1700000000,message:`分页消息${i}`})),
      ]);
      await f.db.insert(storeServiceLog).values([
        ...Array.from({length:5},(_,i)=>({id:50+i,uid:i===1?101:201,toUid:i===1?201:101,isTourist:0,msn:`实际历史${i}`,addTime:1700000000+i})),
        ...Array.from({length:4},(_,i)=>({id:90+i,uid:collisionUid,toUid:101,isTourist:1,msn:`游客历史${i}`,addTime:1700000000+i})),
        {id:95,uid:collisionUid,toUid:101,isTourist:0,msn:'PRIVATE REGISTERED BODY'},
        {id:99,uid:202,toUid:102,isTourist:0,msn:'PRIVATE OTHER OWNER BODY'},
      ]);
      await f.exec("SELECT setval('public.store_service_record_id_seq',2000,true),setval('public.store_service_log_id_seq',2000,true)");
    };
    await reset();
    const installPlan=async(peer:Runtime)=>{
      const plan=runtimeBusinessPrivilegePlan('app');
      for(const table of kefuMobileTables){const definition=getTableConfig(table),privileges=plan.tables[definition.name];if(!privileges?.includes('SELECT'))throw Error('Actual app cannot read kefu fixture table');
        await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(definition.name)} TO ${ident(peer.role)}`);
        const columns=plan.updateColumns[definition.name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(definition.name)} TO ${ident(peer.role)}`);
        if(privileges.includes('INSERT'))for(const column of definition.columns)if(column.getSQLType()==='serial')await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(`${definition.name}_${column.name}_seq`)} TO ${ident(peer.role)}`);
      }
      if(!plan.standaloneSequences.includes('kefu_visitor_uid_seq'))throw Error('Actual app cannot allocate visitor identities');
      await f.exec(`GRANT USAGE ON SEQUENCE public.kefu_visitor_uid_seq TO ${ident(peer.role)}`);
      const [identity]=await peer.exec("SELECT current_user AS role,session_user AS session,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated");
      if(identity?.role!==peer.role||identity.session!==peer.role||identity.elevated!==false)throw Error('Kefu SQL acceptance must run under a normal independent LOGIN');
    };
    const appFor=(db:DbClient)=>{const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
      app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));await next();});app.route('/kefuapi',kefuapiRoutes);
      app.onError((error,c)=>c.json({status:error instanceof ApiException?error.code:500,msg:error.message,data:null}));return app;};
    const sessionFor=async(token:string):Promise<ChatSocketSession>=>{const payload=await verifyToken(token,env.APP_KEY);return{principalUid:payload.id===1?101:102,role:2,isTourist:0,toUid:201,authId:payload.id,tokenKey:md5(token),expiresAt:payload.exp,authVersion:payload.auth??'',connectedAt:Math.floor(Date.now()/1000)};};
    const visitorSession=():ChatSocketSession=>({principalUid:collisionUid,role:3,isTourist:1,toUid:101,authId:collisionUid,tokenKey:md5(visitorToken),expiresAt,authVersion:visitorHash,connectedAt:Math.floor(Date.now()/1000)});
    return{...f,reset,env,password,passwordHash,installPlan,appFor,sessionFor,visitorSession,visitorToken:()=>visitorToken,realtimeFor:(db:DbClient)=>new KefuRealtimeService(createContainerFromDb(db),env),withRuntimeRole:f.withRuntimeRole};
  }catch(error){await f.close();throw error;}
}
