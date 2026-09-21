import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { legacyCache, systemConfig, user } from '@/models/schema';
import { DatabaseCacheService } from '@/services/system/DatabaseCacheService';
import { admitOfflineOrder } from '@/services/order/OfflineOrderAdmissionService';
import { payOfflineOrderBalance } from '@/services/order/OfflineOrderBalanceService';
import { readOfflinePaymentPolicy } from '@/services/order/OfflineOrderPaymentPolicy';
import { saveAdminShippingTemplate } from '@/services/admin/AdminShippingTemplateService';
import { acquireCheckoutPricingLock } from '@/migrations/checkoutPricingLock';

export const RUNTIME_PROBE_OPERATION='isolated-runtime-rollback-exercise-v1';
function insist(value:unknown){if(!value)throw Error('Runtime business exercise assertion failed');}
async function denied(work:()=>Promise<unknown>){
  let error:unknown;
  try{await work();}catch(caught){error=caught;}
  for(let depth=0;depth<8&&error&&typeof error==='object';depth++){
    if('code' in error&&error.code==='42501')return;
    if(!('cause' in error)||error.cause===error)break;error=error.cause;
  }
  throw Error('Expected runtime authority refusal not observed');
}
/** Fixed synthetic service exercise on a REAL runtime LOGIN. Every write is
 * nested under an unconditional outer ROLLBACK; never touches an existing
 * account/order/config row and never calls payment, messaging, KV or providers.
 * PostgreSQL sequence gaps are the only intentionally nontransactional effect.
 * No request-selected IDs, SQL, data or identity. Not part of the main API. */
export async function exerciseRuntimeBusiness(db:DbClient,kind:'app'|'admin',expectedRole:string){
  const nonce=crypto.randomUUID().replaceAll('-',''),key=nonce;
  const uid=2_000_000_000+(parseInt(nonce.slice(0,7),16)%100_000_000);
  const orderNo='xx'+nonce.slice(0,30),requestKey=crypto.randomUUID(),configKey='runtime_probe_'+nonce;
  const rollback=new Error('owned-runtime-probe-rollback');
  const checks:string[]=[];
  let templateId:number|undefined,wallet:'passed'|'disabled'='disabled';
  try{
    await db.transaction(async transaction=>{
      const tx=transaction as unknown as DbClient;
      await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
        set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
      const [identity]=await tx.execute(sql`SELECT current_user=${expectedRole} AND session_user=current_user
        AND current_setting('transaction_isolation')='read committed' AS ready`);
      insist(identity.ready);
      const container=createContainerFromDb(tx),cache=new DatabaseCacheService(container);
      insist((await tx.select({key:legacyCache.key}).from(legacyCache).where(eq(legacyCache.key,key))).length===0);
      await cache.set(key,{version:1});await cache.set(key,{version:2});
      insist((await cache.get<{version:number}|null>(key,null))?.version===2);checks.push('cache_insert_upsert_read');
      if(kind==='app'){
        // Explicit random UID avoids advancing the user identity sequence.
        await tx.insert(user).values({uid,account:'runtime-probe-'+nonce.slice(0,12),nowMoney:'1.00',integral:0,isPromoter:1});
        await acquireCheckoutPricingLock(tx);checks.push('checkout_pricing_lock');
        const input={uid,requestKey,orderNo,money:'0.01',expectedPayPrice:'0.01',from:'h5'};
        const first=await admitOfflineOrder(container,input),replay=await admitOfflineOrder(container,input);
        insist(!first.replayed&&replay.replayed&&first.id===replay.id);checks.push('offline_admission_replay');
        let zeroRejected=false;
        try{await admitOfflineOrder(container,{...input,expectedPayPrice:'0.00'});}catch(error){
          zeroRejected=error instanceof Error&&error.message.includes('至少为0.01');
        }
        insist(zeroRejected);checks.push('offline_zero_rejected');
        // Honor real production policy; do not enable a disabled payment rail.
        const policy=await tx.execute(sql`SELECT DISTINCT ON(menu_name) menu_name,value FROM public.system_config
          WHERE is_store=0 AND menu_name IN('balance_func_status','yue_pay_status') ORDER BY menu_name,sort DESC,id DESC`);
        if(policy.length===2&&policy.every(r=>String(r.value).replace(/^"|"$/g,'')==='1')){
          await readOfflinePaymentPolicy(tx,uid,1n,1,true);
          const paid=await payOfflineOrderBalance(container,{uid,orderNo}),again=await payOfflineOrderBalance(container,{uid,orderNo});
          insist(paid.paid&&!paid.replayed&&again.replayed&&paid.balance_after==='0.99');
          wallet='passed';checks.push('offline_wallet_replay');
        }
        await denied(()=>tx.transaction(inner=>inner.execute(sql`UPDATE public.system_config SET value=value WHERE false`)));
        await denied(()=>tx.transaction(inner=>inner.execute(sql`SELECT 1 FROM public.admin_refund_operation LIMIT 0`)));
        checks.push('app_config_and_admin_receipt_denied');
      }else{
        await tx.insert(systemConfig).values({menuName:configKey,value:'before'});
        await tx.update(systemConfig).set({value:'after'}).where(eq(systemConfig.menuName,configKey));
        insist(await container.systemConfigDao.getValue(configKey)==='after');checks.push('admin_config_insert_update_read');
        const input={name:'Runtime rollback probe '+nonce,type:1,status:0,regions:[]},context={actorId:uid,requestKey};
        const first=await saveAdminShippingTemplate(container,input,context),again=await saveAdminShippingTemplate(container,input,context);
        insist(first.created&&!again.created&&first.id===again.id);templateId=first.id;checks.push('admin_shipping_create_replay');
        await denied(()=>tx.transaction(inner=>inner.execute(sql`SELECT public.checkout_lock_pricing_v1()`)));
        checks.push('admin_pricing_capability_denied');
      }
      throw rollback;
    },{isolationLevel:'read committed',accessMode:'read write'});
    throw Error('Runtime exercise unexpectedly committed');
  }catch(error){if(error!==rollback)throw error;}
  const [clean]=await db.execute(sql`SELECT
    NOT EXISTS(SELECT 1 FROM public.cache WHERE key=${key})
    AND NOT EXISTS(SELECT 1 FROM public."user" WHERE uid=${uid})
    AND NOT EXISTS(SELECT 1 FROM public.other_order WHERE order_id=${orderNo})
    AND NOT EXISTS(SELECT 1 FROM public.offline_order_admission WHERE order_no=${orderNo})
    AND NOT EXISTS(SELECT 1 FROM public.offline_order_balance WHERE order_no=${orderNo})
    AND NOT EXISTS(SELECT 1 FROM public.user_money WHERE uid=${uid} AND link_id=${orderNo})
    AND NOT EXISTS(SELECT 1 FROM public.user_bill WHERE uid=${uid} AND link_id=${orderNo})
    AND NOT EXISTS(SELECT 1 FROM public.system_config WHERE menu_name=${configKey})
    AND NOT EXISTS(SELECT 1 FROM public.shipping_template_create_replay WHERE actor_id=${uid} AND request_key=${requestKey}::uuid)
    AND NOT EXISTS(SELECT 1 FROM public.shipping_templates WHERE id=${templateId??-1}) AS ready`);
  insist(clean.ready);
  return {kind,passed:true as const,rolledBack:true as const,remainingSyntheticRows:0,checks,wallet,
    sequenceGapsPossible:true as const,externalIo:false as const};
}
