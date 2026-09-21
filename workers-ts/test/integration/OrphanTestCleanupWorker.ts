import { timingSafeEqual } from 'node:crypto';
import type { OrphanCleanupEnv } from './orphan-cleanup-bindings';
import { createDbFromConnectionString } from '@/lib/di';
import { deleteOrphanTestOrders,inspectOrphanCleanupResult } from '@/migrations/orphanTestOrderCleanup';

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
/** Isolated maintenance entrypoint, never imported by the application Worker.
 * A deployment pins the exact verified backup digest. No SQL, IDs, schema or
 * role can be selected by an HTTP caller. Unknown write outcomes are not retried. */
export default {
  async fetch(request:Request,env:OrphanCleanupEnv):Promise<Response> {
    const token=request.headers.get('X-Audit-Token')??'',remaining=Number(env.AUDIT_EXPIRES_AT)-Date.now();
    if(!Number.isSafeInteger(Number(env.AUDIT_EXPIRES_AT)) || remaining<=0 || remaining>15*60_000
      || !/^[a-f0-9]{64}$/.test(env.AUDIT_TOKEN_SHA256) || !/^[a-f0-9]{64}$/.test(token)
      || !/^[a-f0-9]{64}$/.test(env.ORPHAN_BACKUP_SHA256))
      return Response.json({error:'forbidden'},{status:403,headers});
    const actual=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
    const expected=Uint8Array.from(env.AUDIT_TOKEN_SHA256.match(/../g)!,b=>parseInt(b,16));
    if(!timingSafeEqual(new Uint8Array(actual),expected)) return Response.json({error:'forbidden'},{status:403,headers});
    const url=new URL(request.url);
    if(!['/cleanup','/status'].includes(url.pathname) || url.search) return Response.json({error:'not found'},{status:404,headers});
    const method=url.pathname==='/cleanup'?'POST':'GET';
    if(request.method!==method) return Response.json({error:'method not allowed'},{status:405,headers:{...headers,Allow:method}});
    if(url.pathname==='/cleanup') {
      if(request.headers.get('X-Maintenance-Operation')!=='delete-backed-up-12-orphan-test-orders')
        return Response.json({error:'explicit empty-body operation required'},{status:400,headers});
      // Incoming HTTP POSTs can expose an empty stream instead of null. Inspect
      // only its first chunk, cancel it, and accept EOF; never buffer a body.
      if(request.body) {
        const reader=request.body.getReader(),first=await reader.read(); await reader.cancel();
        if(!first.done) return Response.json({error:'empty body required'},{status:400,headers});
      }
    }
    let db:ReturnType<typeof createDbFromConnectionString>|undefined;
    try {
      db=createDbFromConnectionString(env.HYPERDRIVE.connectionString,1,{searchPath:'public,pg_temp',applicationName:'cinashop_orphan_cleanup'});
      const result=url.pathname==='/cleanup' ? await deleteOrphanTestOrders(db,env.ORPHAN_BACKUP_SHA256) : await inspectOrphanCleanupResult(db);
      await db.$client.end({timeout:1}); db=undefined;
      return Response.json(result,{headers});
    } catch(error) {
      const sqlState=error && typeof error==='object' && 'code' in error && typeof error.code==='string'
        && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
      const known=['Unexpected cleanup target','Confirmed backup digest required','Cleanup lock scope','Backup snapshot changed; no deletion',
        'Unsafe cleanup dependencies','Unreviewed cleanup foreign keys','Orphan cleanup scope or ownership mismatch',
        'Cleanup fingerprint row budget','Cleanup deadline','Cleanup exact row mismatch','Cleanup changed retained rows','Cleanup postcondition'];
      const reason=error instanceof Error && known.includes(error.message) ? error.message : null;
      console.error(JSON.stringify({event:'orphan_cleanup_unconfirmed',sqlState,reason}));
      return Response.json({error:'maintenance outcome not confirmed; inspect status before any further action',sqlState,reason},{status:503,headers});
    } finally {
      if(db) try {await db.$client.end({timeout:1});}
      catch {console.error(JSON.stringify({event:'orphan_cleanup_close_failed'}));}
    }
  },
} satisfies ExportedHandler<OrphanCleanupEnv>;
