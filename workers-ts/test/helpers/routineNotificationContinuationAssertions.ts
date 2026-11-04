/** Assertions over production-authored rows from the three existing five-LOGIN
 * suites. Only the temporary LOGIN disable below is a catalog negative. */
import { createHmac } from 'node:crypto';
import type postgres from 'postgres';
import { expect } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { collectRoutineNotificationContinuationDraft } from '../../scripts/routine-ownership-inventory';

const KEY='4f'.repeat(32);
type Fixture={maintenanceDb:DbClient;target:{database:string;maintenance:string};env:{APP_KEY:string};appRuntime:{role:string}};
const tables=['store_order_outbox','order_notification_delivery','routine_subscribe_attempt','routine_subscribe_result',
  'routine_subscription_account_policy','routine_original_payment_evidence'];
const quote=(name:string)=>{if(!/^[a-z_][a-z0-9_]{0,62}$/u.test(name))throw Error('Unexpected owned identifier');return'"'+name+'"';};
async function physical(f:Fixture){
  const result:Record<string,string>={};
  for(const name of [...tables,'store_order','user','wechat_user','routine_identity_witness','routine_identity_ownership']){
    const [relation]=await f.maintenanceDb.execute<{oid:string;type_oid:string;schema:string;name:string;kind:string;am:string}>(sql`
      SELECT c.oid::text AS oid,c.reltype::text AS type_oid,n.nspname AS schema,c.relname AS name,c.relkind AS kind,a.amname AS am
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_am a ON a.oid=c.relam WHERE c.oid=${'public.'+name}::regclass`);
    const rows=await f.maintenanceDb.execute<{value:string}>(sql.raw(`SELECT xmin::text||':'||ctid::text||':'||pg_catalog.textin(pg_catalog.jsonb_out(to_jsonb(t))) AS value
      FROM ONLY public.${quote(name)} t ORDER BY t.ctid`));
    const mac=createHmac('sha256',KEY).update('cinashop.routine-ownership-inventory.v1\0relation\0');
    const frame=(v:string)=>{mac.update(Buffer.byteLength(v,'utf8')+':');mac.update(v,'utf8');};
    frame(JSON.stringify(relation));for(const row of rows)frame(row.value);result[name]=mac.digest('hex');
  }return result;
}
export async function assertRoutineNotificationContinuation(f:Fixture,format:2|3|4|5,sideEffects:()=>number[],secrets:readonly string[],disableActor=false){
  const before=await physical(f),calls=sideEffects();
  const collect=()=>collectRoutineNotificationContinuationDraft(f.maintenanceDb.$client as unknown as postgres.Sql,f.target,KEY,{APP_KEY:f.env.APP_KEY});
  const report=await collect(),n=report.notifications;
  expect(report).toMatchObject({activationAllowed:false,permitIssued:false,switchCommissioned:false});
  expect(n).toMatchObject({missingSources:[],activationAllowed:false,permitIssued:false,switchCommissioned:false,subscriptionSendAuthorized:false,
    currentBusinessEligibility:'not_evaluated',credentials:'not_evaluated',catalogCommissioning:'not_evaluated',externalQueueAndProviderState:'not_evaluated'});
  for(const component of [report.identity,report.payments,n])expect(component.inventorySourceDigest).toBe(report.inventory.sourceDigest);
  for(const name of tables){const relation=report.inventory.relations.find(r=>r.schema==='public'&&r.name===name);expect(relation?.digest).toBe(before[name]);}
  const matchingOutboxes=n.outboxes.filter(r=>r.format===format&&r.state==='authenticated_source_match');
  expect(matchingOutboxes.length).toBeGreaterThan(0);
  const outboxDigests=new Set(matchingOutboxes.map(r=>r.outboxDigest));
  const acceptedDeliveries=n.deliveries.filter(r=>outboxDigests.has(r.outboxDigest)&&r.staging==='authenticated_source_match'
    &&r.dispatch==='accepted'&&r.policy==='matched'&&r.original==='matched'&&r.intentMatches===true&&r.currentProjection==='matched');
  expect(acceptedDeliveries.length).toBeGreaterThan(0);
  for(const delivery of acceptedDeliveries){
    const acceptedAttempts=n.attempts.filter(a=>a.deliveryDigest===delivery.deliveryDigest&&a.authenticity==='authenticated'
      &&a.policy==='matched'&&a.original==='matched'&&a.result==='verified_accepted');
    expect(acceptedAttempts.length).toBeGreaterThan(0);
    for(const attempt of acceptedAttempts)
      expect(n.results.some(r=>r.attemptDigest===attempt.attemptDigest&&r.state==='verified_accepted')).toBe(true);
  }
  expect(n.attempts.some(a=>a.authenticity==='authenticated'&&a.result==='unknown')).toBe(true);
  for(const a of n.attempts.filter(a=>a.authenticity==='authenticated'&&a.original==='matched'))
    expect(report.payments.originals.some(o=>o.recordDigest===a.originalRecordDigest&&o.authenticity==='verified_success')).toBe(true);
  for(const a of n.attempts.filter(a=>a.authenticity==='authenticated'&&a.policy==='matched'))
    expect(report.payments.policies.some(p=>p.recordDigest===a.policyRecordDigest&&p.authenticity==='authenticated')).toBe(true);
  for(const r of n.results)if(r.state==='verified_accepted'||r.state==='verified_rejected')
    expect(n.attempts.some(a=>a.attemptDigest===r.attemptDigest&&a.authenticity==='authenticated')).toBe(true);
  expect(n.results.filter(r=>r.state==='verified_accepted'||r.state==='verified_rejected')).toHaveLength(n.counts.authenticatedResults);
  expect(n.unclassifiedRelationCount).toBe(report.inventory.relations.length-6);
  expect(n.unclassifiedRelationCount).toBeGreaterThan(200);
  const text=JSON.stringify(report);
  for(const secret of [KEY,f.env.APP_KEY,...secrets])if(secret)expect(text).not.toContain(secret);
  for(const field of ['"buyerUid":','"openid":','"signature":','"target":','"requestSignature":','"providerBody":'])expect(text).not.toContain(field);
  expect(await physical(f)).toEqual(before);expect(sideEffects()).toEqual(calls);
  // At least one genuine immutable/staged payload is compressed by ordinary
  // PostgreSQL storage; no SET STORAGE, evidence rewrite or synthetic positive.
  let compressed=0,stagedCompressed=0;
  for(const table of tables.slice(0,4)){
    const rows=await f.maintenanceDb.execute<{method:string|null;physical:number;raw:number}>(sql.raw(`SELECT pg_column_compression(payload) AS method,
      pg_column_size(payload) AS physical,pg_column_size(pg_catalog.jsonb_set_lax(payload,'{}'::text[],NULL::jsonb,false,'return_target')) AS raw FROM public.${quote(table)}`));
    for(const row of rows)if(row.method==='pglz'){
      compressed++;if(tables.indexOf(table)<2)stagedCompressed++;
      expect(row.physical).toBeLessThanOrEqual(32768);expect(row.raw).toBeGreaterThan(row.physical);
    }
  }
  expect(compressed).toBeGreaterThan(0);
  expect(stagedCompressed).toBeGreaterThan(0);
  console.info('ROUTINE_NOTIFICATION_COMPRESSED '+JSON.stringify({format,compressed,stagedCompressed}));
  if(disableActor){
    await f.maintenanceDb.execute(sql.raw('ALTER ROLE '+quote(f.appRuntime.role)+' NOLOGIN'));
    try{
      const historical=await collect();expect(historical.notifications.counts.authenticatedAttempts).toBe(n.counts.authenticatedAttempts);
      expect(historical.notifications.counts.authenticatedResults).toBe(n.counts.authenticatedResults);
      expect(historical.notifications.attempts.some(a=>a.authenticity==='authenticated'&&a.currentRole==='login_disabled')).toBe(true);
      expect(historical.notifications.deliveries.filter(d=>d.dispatch==='accepted')).toHaveLength(n.deliveries.filter(d=>d.dispatch==='accepted').length);
      expect(sideEffects()).toEqual(calls);
    }finally{await f.maintenanceDb.execute(sql.raw('ALTER ROLE '+quote(f.appRuntime.role)+' LOGIN'));}
    expect(await physical(f)).toEqual(before);
  }
  if(format===4){
    const digest=(id:number)=>createHmac('sha256',KEY).update('cinashop.routine-notification-continuation-draft.v1\0delivery-id\0').update(JSON.stringify(id)).digest('hex');
    const candidate=n.deliveries.find(d=>d.staging==='authenticated_source_match'&&d.attempts===0);
    expect(candidate).toBeDefined();
    const rows=await f.maintenanceDb.execute<{id:number;payload:Record<string,unknown>;add_time:number}>(sql`SELECT id,payload,add_time
      FROM public.order_notification_delivery WHERE channel='wechat_routine'`);
    const row=rows.find(r=>digest(r.id)===candidate!.deliveryDigest);if(!row)throw Error('Actual staged no-attempt source absent');
    const changedUrl={...row.payload,url:String(row.payload.url)+'&owned_drift=1'};
    const data=row.payload.data as Record<string,string>,field=Object.keys(data)[0];
    const changedData={...row.payload,data:{...data,[field]:'owned_mutable_projection_drift'}};
    for(const patch of [{payload:changedUrl,time:row.add_time},{payload:changedData,time:row.add_time},{payload:row.payload,time:row.add_time+1}]){
      // Explicit mutable-row corruption specimens. No signed intent/attempt/
      // result or business positive is authored or changed by these updates.
      await f.maintenanceDb.execute(sql`UPDATE public.order_notification_delivery SET payload=${JSON.stringify(patch.payload)}::jsonb,add_time=${patch.time} WHERE id=${row.id}`);
      try{
        const changed=await collect(),d=changed.notifications.deliveries.find(d=>d.deliveryDigest===candidate!.deliveryDigest);
        expect(d).toMatchObject({staging:'authenticated_source_mismatch',dispatch:'not_attempted',intentMatches:null});
        expect(changed.notifications.counts.authenticatedAttempts).toBe(n.counts.authenticatedAttempts);
        expect(changed.notifications.counts.authenticatedResults).toBe(n.counts.authenticatedResults);
        expect(sideEffects()).toEqual(calls);
      }finally{
        await f.maintenanceDb.execute(sql`UPDATE public.order_notification_delivery SET payload=${JSON.stringify(row.payload)}::jsonb,add_time=${row.add_time} WHERE id=${row.id}`);
      }
    }
    const after=await physical(f);for(const name of Object.keys(before))if(name!=='order_notification_delivery')expect(after[name]).toBe(before[name]);
    const [restored]=await f.maintenanceDb.execute<{payload:unknown;add_time:number}>(sql`SELECT payload,add_time FROM public.order_notification_delivery WHERE id=${row.id}`);
    expect(restored).toEqual({payload:row.payload,add_time:row.add_time});
  }
  return report;
}
