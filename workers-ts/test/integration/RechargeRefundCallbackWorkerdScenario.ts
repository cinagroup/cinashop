/** Isolated local acceptance bridge. Ordinary callback traffic traverses the
 * actual production Worker/app/DI/route, with real App Hyperdrive and crypto.
 * Guarded controls instrument only transport and actual transaction ACK faults. */
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import worker from '../../src/index';
import { createDb,createContainerFromDb,type DbClient } from '../../src/lib/di';
import type { Env,OrderMessage,AppVariables } from '../../src/env';
import { rechargeRefundCallback } from '../../src/controllers/api/v1/RechargeRefundCallbackController';
type Bindings=Env&{TEST_SCENARIO_KEY:string;TEST_OWNED_DATABASE:string};
type Failure='none'|'before'|'after'|'hold';
let failure:Failure='none',messages:OrderMessage[]=[],pending:Promise<unknown>[]=[],release:(()=>void)|undefined;
let transactionTrace:Array<{mode:string;committed:boolean}> = [];
function transport(env:Bindings){return{...env,ORDER_QUEUE:{send:async(body:OrderMessage)=>{
 if(failure==='before')throw Error('Local enqueue failure');
 if(failure==='hold')await new Promise<void>(resolve=>{release=resolve;});
 messages.push(body);if(failure==='after')throw Error('Local enqueue ACK lost');
},sendBatch:async(batch:MessageSendRequest<OrderMessage>[])=>{for(const row of batch)await transport(env).ORDER_QUEUE.send(row.body);}}}as unknown as Bindings;}
function context(ctx:ExecutionContext){return{waitUntil:(p:Promise<unknown>)=>{pending.push(p);ctx.waitUntil(p);},passThroughOnException:()=>{},props:{}}as ExecutionContext;}
export default{
 async fetch(request:Request,env:Bindings,ctx:ExecutionContext):Promise<Response>{
  if(!/^finance_fixture_[a-f0-9]{32}$/u.test(env.HYPERDRIVE.database)||env.HYPERDRIVE.database!==env.TEST_OWNED_DATABASE)return new Response(null,{status:503});
  const url=new URL(request.url),bindings=transport(env);
  if(!url.pathname.startsWith('/test/'))return worker.fetch(request,bindings,context(ctx));
  const encoder=new TextEncoder(),[a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(request.headers.get('Authorization')??'')),
   crypto.subtle.digest('SHA-256',encoder.encode('Bearer '+env.TEST_SCENARIO_KEY))]);
  if(!env.TEST_SCENARIO_KEY||!crypto.subtle.timingSafeEqual(a,b))return new Response(null,{status:403});
  if(url.pathname==='/test/identity'){
   const db=createDb(env);try{const [r]=await db.execute(sql`SELECT current_database() AS database,current_user AS role,session_user=current_user AS login,pg_backend_pid() AS pid`);return Response.json(r);}
   finally{await db.$client.end({timeout:5});}
  }
  if(url.pathname==='/test/config'){
   const input=await request.json()as {failure:Failure};if(!['none','before','after','hold'].includes(input.failure)||release)return new Response(null,{status:409});
   failure=input.failure;return Response.json({ok:true});
  }
  if(url.pathname==='/test/drain'){
   release?.();release=undefined;const work=pending;pending=[];await Promise.allSettled(work);
   const result={messages,trace:transactionTrace};messages=[];transactionTrace=[];return Response.json(result);
  }
  if(url.pathname==='/test/queue'||url.pathname==='/test/scheduled'){
   const input=await request.json()as {messages:OrderMessage[];scheduledAt:number};
   if(url.pathname==='/test/queue')await worker.queue({queue:'recharge-refund-http-local',metadata:{metrics:{backlogCount:(input.messages??[]).length,backlogBytes:(input.messages??[]).reduce((n,m)=>n+new TextEncoder().encode(JSON.stringify(m)).byteLength,0)}},messages:(input.messages??[]).map((body,i)=>({id:'local-'+i,timestamp:new Date(),attempts:1,body,
    ack:()=>acks.push('local-'+i),retry:()=>retries.push('local-'+i)})),ackAll:()=>{throw Error('Batch ACK');},retryAll:()=>{throw Error('Batch retry');}}as MessageBatch<OrderMessage>,bindings);
   else await worker.scheduled({scheduledTime:input.scheduledAt,cron:'*/5 * * * *',noRetry:()=>{}}as ScheduledController,bindings,context(ctx));
   const work=pending;pending=[];await Promise.allSettled(work);const result={messages,acks,retries};messages=[];acks=[];retries=[];return Response.json(result);
  }
  const match=/^\/test\/fault\/(rollback-read|lost-read|rollback-write|lost-write)\/[a-f0-9-]+$/u.exec(url.pathname);
  if(match){
   const db=createDb(env),wrapped=Object.create(db),descriptor=Object.getOwnPropertyDescriptor(db,'$client');if(!descriptor||!('value'in descriptor))throw Error('Actual root required');
   Object.defineProperty(wrapped,'$client',{value:descriptor.value});let fault=match[1];
   Object.defineProperty(wrapped,'transaction',{value:async(work:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>{
    const phase=options?.accessMode==='read only'?'read':'write',row={mode:phase,committed:false};transactionTrace.push(row);
    const value=await db.transaction(async raw=>{const result=await work(raw as unknown as DbClient);if(fault==='rollback-'+phase){fault='none';throw Error('Local actual transaction rollback');}return result;},options);
    row.committed=true;if(fault==='lost-'+phase){fault='none';throw Error('Local actual COMMIT ACK lost');}return value;
   }});
   const app=new Hono<{Bindings:Bindings;Variables:AppVariables}>();app.use('*',async(c,next)=>{c.set('container',createContainerFromDb(wrapped as DbClient));await next();});
   app.all('/test/fault/:fault/:operationId',rechargeRefundCallback);
   try{return await app.fetch(request,bindings,context(ctx));}finally{await db.$client.end({timeout:5});}
  }
  return new Response(null,{status:404});
 }
}satisfies ExportedHandler<Bindings>;
let acks:string[]=[],retries:string[]=[];
