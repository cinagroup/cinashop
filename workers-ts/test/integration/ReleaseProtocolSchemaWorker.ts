import { timingSafeEqual } from 'node:crypto';
import type { ReleaseProtocolSchemaEnv } from './release-protocol-schema-bindings';
import { createDbFromConnectionString } from '@/lib/di';
import { RELEASE_PROTOCOL_OPERATION, inspectReleaseProtocolSchema, runReleaseProtocolSchema } from '@/migrations/runReleaseProtocolSchema';

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const target={database:'postgres',maintenanceRole:'postgres',pricingOwner:'cinashop_pricing_owner_v1'};
/** Expiring, fixed production maintenance only. Never imported by main API. */
export default {
  async fetch(request:Request,env:ReleaseProtocolSchemaEnv):Promise<Response> {
    const token=request.headers.get('X-Audit-Token')??'',expiry=Number(env.AUDIT_EXPIRES_AT),remaining=expiry-Date.now();
    if(!Number.isSafeInteger(expiry)||remaining<=0||remaining>15*60000
      ||!/^[a-f0-9]{64}$/.test(token)||!/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256))
      return Response.json({error:'forbidden'},{status:403,headers});
    const actual=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
    const expected=Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!,byte=>parseInt(byte,16));
    if(!timingSafeEqual(actual,expected))return Response.json({error:'forbidden'},{status:403,headers});
    const url=new URL(request.url),inspecting=url.pathname==='/status';
    if(!['/status','/apply'].includes(url.pathname)||url.search)return Response.json({error:'not found'},{status:404,headers});
    const method=inspecting?'GET':'POST';
    if(request.method!==method)return Response.json({error:'method not allowed'},{status:405,headers:{...headers,Allow:method}});
    if(!inspecting) {
      if(request.headers.get('X-Migration-Operation')!==RELEASE_PROTOCOL_OPERATION)
        return Response.json({error:'explicit operation required'},{status:400,headers});
      if(request.body) {
        const reader=request.body.getReader();
        try {for(;;){const next=await reader.read();if(next.done)break;if(next.value.byteLength)
          return Response.json({error:'empty body required'},{status:400,headers});}}
        catch{return Response.json({error:'invalid body'},{status:400,headers});}
        finally{try{await reader.cancel();}catch{/* no payload logging */}reader.releaseLock();}
      }
    }
    let db:ReturnType<typeof createDbFromConnectionString>|undefined;
    try {
      db=createDbFromConnectionString(env.HYPERDRIVE.connectionString,1,{searchPath:'public,pg_temp',applicationName:'cinashop_release_protocol_schema'});
      const result=inspecting?await inspectReleaseProtocolSchema(db,target):await runReleaseProtocolSchema(db,target);
      await db.$client.end({timeout:1});db=undefined;
      return Response.json(result,{headers});
    } catch(error) {
      let cause:unknown=error,sqlState:string|null=null;
      for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
        if('code'in cause&&typeof cause.code==='string'&&/^[0-9A-Z]{5}$/.test(cause.code)){sqlState=cause.code;break;}
        if(!('cause'in cause)||cause.cause===cause)break;cause=cause.cause;
      }
      console.error(JSON.stringify({event:'release_protocol_schema_unconfirmed',sqlState}));
      return Response.json({error:'outcome unconfirmed; inspect catalog before further action',sqlState},{status:503,headers});
    } finally {if(db)try{await db.$client.end({timeout:1});}catch{console.error(JSON.stringify({event:'release_protocol_schema_close_failed'}));}}
  },
} satisfies ExportedHandler<ReleaseProtocolSchemaEnv>;
