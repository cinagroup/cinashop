import { and,eq,inArray,sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { shippingTemplates,cityArea } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import type { ShippingTemplateInput,ShippingRegionInput,ShippingFreeRuleInput,ShippingNoDeliveryRuleInput } from './ShippingCalculator';

type Template = ShippingTemplateInput & { ownerType:number; relationId:number; status:number; isDel:number };
export interface ShippingTemplateSnapshot {
  templates:Template[]; regions:ShippingRegionInput[]; free:ShippingFreeRuleInput[];
  noDelivery:ShippingNoDeliveryRuleInput[]; cityPath:string|null;
}
export interface ShippingTemplateBinding { tempId:number; freight:number; ownerType:number; relationId:number }
export function shippingTemplateIds(bindings:readonly ShippingTemplateBinding[]) {
  return [...new Set(bindings.map(b=>b.tempId>0?b.tempId:![1,2].includes(b.freight)?1:0).filter(Boolean))].sort((a,b)=>a-b);
}

/** One SQL statement supplies one MVCC snapshot, including inside an existing
 * transaction. Do not change the caller's isolation level or cache this result.
 * Each child set has a sentinel row cap: overflow fails, never truncates a rate.
 */
export async function readShippingTemplateSnapshot(db:DbClient, ids:readonly number[], cityId=0):Promise<ShippingTemplateSnapshot> {
  if(!ids.length || ids.length>200 || ids.some(id=>!Number.isSafeInteger(id)||id<=0)||!Number.isSafeInteger(cityId)||cityId<0) {
    throw new ValidateException('配送模板或城市参数无效');
  }
  const idList=sql.join(ids.map(id=>sql`${id}::int`),sql`, `);
  const [row]=await db.select({
    templates:sql<Template[]>`(SELECT COALESCE(json_agg(r ORDER BY r.id),'[]'::json) FROM
      (SELECT id,owner_type AS "ownerType",relation_id AS "relationId",type,appoint,no_delivery AS "noDelivery",status,is_del AS "isDel"
       FROM shipping_templates WHERE id IN (${idList}) ORDER BY id LIMIT 201) r)`,
    regions:sql<ShippingRegionInput[]>`(SELECT COALESCE(json_agg(r ORDER BY r.id),'[]'::json) FROM
      (SELECT id,template_id AS "templateId",region_id AS "regionId",region_name AS "regionName",first::text,first_price::text AS "firstPrice",continue::text,continue_price::text AS "continuePrice"
       FROM shipping_templates_region WHERE template_id IN (${idList}) ORDER BY id LIMIT 10001) r)`,
    free:sql<ShippingFreeRuleInput[]>`(SELECT COALESCE(json_agg(r ORDER BY r.id),'[]'::json) FROM
      (SELECT id,temp_id AS "tempId",province_id AS "provinceId",city_id AS "cityId",number::text,price::text,value
       FROM shipping_templates_free WHERE temp_id IN (${idList}) ORDER BY id LIMIT 10001) r)`,
    noDelivery:sql<ShippingNoDeliveryRuleInput[]>`(SELECT COALESCE(json_agg(r ORDER BY r.id),'[]'::json) FROM
      (SELECT id,temp_id AS "tempId",province_id AS "provinceId",city_id AS "cityId",value
       FROM shipping_templates_no_delivery WHERE temp_id IN (${idList}) ORDER BY id LIMIT 10001) r)`,
    cityPath:sql<string|null>`(SELECT path FROM city_area WHERE id=${cityId}::int LIMIT 1)`,
  }).from(sql`(VALUES(1)) shipping_snapshot(n)`);
  if(!row || row.regions.length>10000 || row.free.length>10000 || row.noDelivery.length>10000) throw new ValidateException('配送模板规则过多，请先整理');
  if(cityId>0 && row.cityPath===null) throw new ValidateException('配送城市不存在，请重新选择地址');
  return row;
}

export function assertShippingTemplateBindings(snapshot:ShippingTemplateSnapshot,bindings:readonly ShippingTemplateBinding[]) {
  for(const binding of bindings) {
    const id=shippingTemplateIds([binding])[0];if(!id)continue;
    const row=snapshot.templates.find(t=>t.id===id);
    if(!row || row.status!==1 || row.isDel!==0) throw new ValidateException('配送模板不存在或已停用，请刷新后重试');
    if(![0,1,2].includes(binding.ownerType) || !Number.isSafeInteger(binding.relationId) ||
      (binding.ownerType===0?binding.relationId!==0:binding.relationId<=0) ||
      row.ownerType!==binding.ownerType || row.relationId!==binding.relationId) throw new ValidateException('配送模板不属于商品所属方');
  }
}

export async function boundShippingTemplateTransaction(tx:DbClient) {
  const [isolation]=await tx.select({value:sql<string>`current_setting('transaction_isolation')`}).from(sql`(VALUES(1)) isolation(n)`);
  if(isolation?.value!=='read committed') throw new ValidateException('配送建单必须使用READ COMMITTED事务，请重试');
  await tx.execute(sql.raw(`SELECT
    set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
}

/** Call inside the real write transaction. Known admin/supplier writers hold
 * the same parent to commit; NOWAIT avoids introducing a reverse-order wait.
 * These locks last to commit. Direct child SQL must also follow this protocol.
 */
export async function assertShippingTemplateSnapshot(tx:DbClient,expected:ShippingTemplateSnapshot,ids:readonly number[],cityId=0) {
  // Unbound fixed/free freight still uses the caller's atomic cart/product/SKU
  // guards, but has no template or city hierarchy to lock/re-read.
  if(!ids.length) return;
  try {
    const parents=await tx.select({id:shippingTemplates.id}).from(shippingTemplates)
      .where(and(inArray(shippingTemplates.id,[...ids]),eq(shippingTemplates.status,1),eq(shippingTemplates.isDel,0)))
      .orderBy(shippingTemplates.id).for('share',{noWait:true});
    if(parents.length!==ids.length) throw new ValidateException('配送模板已变化，请刷新后重试');
    if(cityId>0) {
      const cities=await tx.select({id:cityArea.id}).from(cityArea).where(eq(cityArea.id,cityId)).limit(1).for('share',{noWait:true});
      if(!cities.length) throw new ValidateException('配送城市已变化，请刷新后重试');
    }
    const current=await readShippingTemplateSnapshot(tx,ids,cityId);
    if(JSON.stringify(current)!==JSON.stringify(expected)) throw new ValidateException('配送模板或城市规则已变化，请刷新后重试');
  } catch(error) {
    let cause:unknown=error;
    for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++) {
      if('code' in cause && cause.code==='55P03') throw new ValidateException('配送模板或城市正在更新，请稍后重试');
      if(!('cause' in cause)||cause.cause===cause)break;cause=cause.cause;
    }
    throw error;
  }
}
