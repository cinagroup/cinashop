import { timingSafeEqual } from 'node:crypto';
import { createDbFromConnectionString } from '@/lib/di';
import { inspectRuntimeBusinessCommissioning, runRuntimeBusinessCommissioning, runRuntimeShippingPrerequisite,
  RUNTIME_COMMISSION_OPERATION, RUNTIME_SHIPPING_OPERATION } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import type { RuntimeBusinessCommissionBindings } from './runtime-business-commission-bindings';
import { exerciseRuntimeBusiness, RUNTIME_PROBE_OPERATION } from './RuntimeBusinessProbe';

export type RuntimeBusinessCommissionEnv = RuntimeBusinessCommissionBindings;
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const target={database:'postgres',maintenance:'postgres',app:'cinashop_app_v1',admin:'cinashop_admin_v1',pricingOwner:'cinashop_pricing_owner_v1'};
/** Temporary fixed-operation maintenance only; not imported into the main API.
 * No arbitrary SQL, target, role, plan, payload, credentials or provider I/O. */
export default {
  async fetch(request:Request,env:RuntimeBusinessCommissionEnv):Promise<Response>{
    const token=request.headers.get('X-Audit-Token')??'',expiry=Number(env.AUDIT_EXPIRES_AT),remaining=expiry-Date.now();
    if(!Number.isSafeInteger(expiry) || remaining<=0 || remaining>15*60000 || !/^[a-f0-9]{64}$/.test(token)
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256))return Response.json({error:'forbidden'},{status:403,headers});
    const actual=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
    const expected=Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!,b=>parseInt(b,16));
    if(!timingSafeEqual(actual,expected))return Response.json({error:'forbidden'},{status:403,headers});
    const url=new URL(request.url);
    if(!['/status','/verify','/apply','/shipping-schema','/exercise'].includes(url.pathname) || url.search)return Response.json({error:'not found'},{status:404,headers});
    const method=['/apply','/shipping-schema','/exercise'].includes(url.pathname)?'POST':'GET';
    if(request.method!==method)return Response.json({error:'method not allowed'},{status:405,headers:{...headers,Allow:method}});
    if(method==='POST'){
      if(request.headers.get('X-Migration-Operation')!==(url.pathname==='/shipping-schema'?RUNTIME_SHIPPING_OPERATION:
        url.pathname==='/exercise'?RUNTIME_PROBE_OPERATION:RUNTIME_COMMISSION_OPERATION))
        return Response.json({error:'explicit operation required'},{status:400,headers});
      if(request.body){const reader=request.body.getReader();try{for(;;){const item=await reader.read();if(item.done)break;
        if(item.value.byteLength)return Response.json({error:'empty body required'},{status:400,headers});}}
        catch{return Response.json({error:'invalid body'},{status:400,headers});}
        finally{try{await reader.cancel();}catch{/* no request logging */}reader.releaseLock();}}
    }
    let db:ReturnType<typeof createDbFromConnectionString>|undefined;
    let stage='connection';
    try{
      if(url.pathname==='/verify'||url.pathname==='/exercise'){
        const results=[];
        for(const kind of ['app','admin'] as const){
          const binding=kind==='app'?env.HYPERDRIVE:env.HYPERDRIVE_ADMIN;
          stage=kind+':connection';
          db=createDbFromConnectionString(binding.connectionString,1,{searchPath:'public,pg_temp',applicationName:'cinashop_runtime_verify_'+kind});
          const result=await auditRuntimeBusinessPrivileges(db,kind,target,step=>{stage=kind+':'+step;});
          if(url.pathname==='/exercise'){
            if(!result.ready)throw Error('Runtime profile must verify before business exercise');
            stage=kind+':exercise';
            results.push(await exerciseRuntimeBusiness(db,kind,target[kind]));
          }else
          results.push({...result,failureCount:result.failures.length,failures:result.failures.slice(0,40)});
          stage=kind+':close';
          await db.$client.end({timeout:1});db=undefined;
        }
        return url.pathname==='/exercise'?Response.json({operation:RUNTIME_PROBE_OPERATION,passed:true,profiles:results},{headers})
          :Response.json({operation:RUNTIME_COMMISSION_OPERATION,ready:results.every(r=>'ready' in r&&r.ready),profiles:results},{headers});
      }
      db=createDbFromConnectionString(env.HYPERDRIVE_MAINTENANCE.connectionString,1,{searchPath:'public,pg_temp',applicationName:'cinashop_runtime_commission'});
      stage=url.pathname==='/status'?'preflight':url.pathname==='/shipping-schema'?'shipping_schema':'commission';
      const result=url.pathname==='/status'?await inspectRuntimeBusinessCommissioning(db,target)
        :url.pathname==='/shipping-schema'?await runRuntimeShippingPrerequisite(db,target):await runRuntimeBusinessCommissioning(db,target);
      await db.$client.end({timeout:1});db=undefined;
      return Response.json(result,{headers});
    }catch(error){
      let cause:unknown=error,sqlState:string|null=null;
      for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
        if('code'in cause&&typeof cause.code==='string'&&/^[0-9A-Z]{5}$/.test(cause.code)){sqlState=cause.code;break;}
        if(!('cause'in cause)||cause.cause===cause)break;cause=cause.cause;
      }
      console.error(JSON.stringify({event:'runtime_commission_unconfirmed',stage,sqlState}));
      return Response.json({error:'outcome unconfirmed; inspect authority before further action',stage,sqlState},{status:503,headers});
    }finally{if(db)try{await db.$client.end({timeout:1});}catch{console.error(JSON.stringify({event:'runtime_commission_close_failed'}));}}
  },
} satisfies ExportedHandler<RuntimeBusinessCommissionEnv>;
