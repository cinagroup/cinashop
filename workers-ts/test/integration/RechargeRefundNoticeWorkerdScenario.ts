/** Isolated native acceptance bridge only. Not a production route or config.
 * The actual Worker scheduled and Queue handlers run inside workerd, with an
 * actual commissioned App Hyperdrive and strict local outbound gateway. */
import worker from '../../src/index';
import { createDb,createContainerFromDb } from '../../src/lib/di';
import {prepareRoutineSubscriptionDeliveryNotice}from '../../src/services/wechat/RoutineSubscriptionDeliveryNotice';
import {getRoutineSubscriptionAccessToken}from '../../src/services/wechat/RoutineSubscriptionAccessToken';
import type { Env,OrderMessage } from '../../src/env';
import { sql } from 'drizzle-orm';
type Bindings=Env&{TEST_SCENARIO_KEY:string;TEST_OWNED_DATABASE:string;TEST_APP_LOGIN:string};
export default{
 async fetch(request:Request,env:Bindings):Promise<Response>{
  const encoder=new TextEncoder();
  const [provided,expected]=await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(request.headers.get('Authorization')??'')),
   crypto.subtle.digest('SHA-256',encoder.encode('Bearer '+env.TEST_SCENARIO_KEY))]);
  if(!env.TEST_SCENARIO_KEY||!crypto.subtle.timingSafeEqual(provided,expected))return new Response(null,{status:403});
  if(!/^finance_fixture_[a-f0-9]{32}$/u.test(env.HYPERDRIVE.database)||env.HYPERDRIVE.database!==env.TEST_OWNED_DATABASE
   ||env.HYPERDRIVE.user!==env.TEST_APP_LOGIN)return new Response(null,{status:503});
  const path=new URL(request.url).pathname;
  if(path==='/identity'){
   const db=createDb(env);
   try{const [r]=await db.execute(sql`SELECT current_database() AS database,current_user AS role,session_user=current_user AS login,pg_backend_pid() AS pid`);return Response.json(r);}
   finally{await db.$client.end({timeout:5});}
  }
  if(path==='/probe'&&request.method==='POST'){
   const input=await request.json()as {deliveryId:number;eventKey:string},db=createDb(env);let stage='fresh-source';
   try{const c=createContainerFromDb(db),s=await prepareRoutineSubscriptionDeliveryNotice(c,env,input);stage='token';await getRoutineSubscriptionAccessToken(c,env,s.account);return Response.json({freshSource:true,tokenRetrieved:true});}
   catch{return Response.json({failedAt:stage},{status:503});}
   finally{await db.$client.end({timeout:5});}
  }
  if(request.method!=='POST'||!['/scheduled','/queue'].includes(path))return new Response(null,{status:404});
  const input=await request.json() as {scheduledAt?:number;cron?:string;messages?:OrderMessage[];attempts?:number;failure?:'before'|'after'};
  const messages:OrderMessage[]=[],acks:string[]=[],retries:Array<{id:string;delaySeconds:number|undefined}>=[];
  const queue={send:async(body:OrderMessage)=>{if(input.failure==='before')throw Error('Local enqueue failure');messages.push(body);if(input.failure==='after')throw Error('Local enqueue acknowledgement lost');},
   sendBatch:async(batch:MessageSendRequest<OrderMessage>[])=>{if(input.failure==='before')throw Error('Local enqueue failure');messages.push(...batch.map(x=>x.body));if(input.failure==='after')throw Error('Local enqueue acknowledgement lost');}};
  const bindings={...env,ORDER_QUEUE:queue} as unknown as Env;
  if(path==='/scheduled'){
   const pending:Promise<unknown>[]=[],ctx={waitUntil:(p:Promise<unknown>)=>pending.push(p),passThroughOnException:()=>{},props:{}} as unknown as ExecutionContext;
   await worker.scheduled({scheduledTime:input.scheduledAt!,cron:input.cron??'*/5 * * * *',noRetry:()=>{}} as ScheduledController,bindings,ctx);await Promise.all(pending);
  }else{
   const batch={queue:'cinashop-recharge-refund-local',metadata:{metrics:{backlogCount:(input.messages??[]).length,backlogBytes:(input.messages??[]).reduce((n,m)=>n+new TextEncoder().encode(JSON.stringify(m)).byteLength,0)}},messages:(input.messages??[]).map((body,index)=>({id:'local-'+index,timestamp:new Date(),attempts:input.attempts??1,body,
    ack:()=>acks.push('local-'+index),retry:(options?:{delaySeconds?:number})=>retries.push({id:'local-'+index,delaySeconds:options?.delaySeconds})})),
    ackAll:()=>{throw Error('Unexpected batch-wide acknowledgement');},retryAll:()=>{throw Error('Unexpected batch-wide retry');}} as unknown as MessageBatch<OrderMessage>;
   await worker.queue(batch,bindings);
  }
  return Response.json({messages,acks,retries});
 }
}satisfies ExportedHandler<Bindings>;
