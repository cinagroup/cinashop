import { sql } from 'drizzle-orm';
import { createContainerFromDb,withTx,type Container,type DbClient } from '@/lib/di';
import { themeDeadlines,themeHash } from '@/services/content/ThemeReadService';
import { orderReadStatusPredicate } from '@/services/order/OrderReadStatusPredicate';
import { normalizeConfigScalar } from '@/utils/config';
import { ValidateException } from '@/utils/errors';
import { businessMidnight,startOfBusinessDay,type MobileOrderDataQuery,type MobileOrderPeriod } from '@/services/admin/AdminStatisticService';
import { readStoreManagerIdentities,requireStoreManagerScope,merchantManagementConsistencyKey,type StoreManagerScope } from './StoreManagerScope';
import { parseManagerDailyQuery,parseManagerPeriodQuery,parseManagerStoreQuery,managerQueryKeys } from './StoreManagerOrderInput';
import { MERCHANT_MANAGEMENT_VERSION,type MerchantManagementEnvelope,type MerchantManagementContext,type MerchantCapabilities,type MerchantOrderStatistics,type MerchantOrderPeriod,type MerchantOrderChartPoint,type MerchantOrderDailyRow,type MerchantPaged } from '../../../../view/common/merchantManagement';

export const MANAGER_READ_ISSUES=['merchant_metrics_use_current_store_fulfillments_pid_gte_0','merchant_visits_use_current_store_product_events','merchant_electronic_waybill_store_actor_unavailable'];
export const MANAGER_UNAVAILABLE_CAPABILITIES:MerchantCapabilities={remark:false,change_price:false,confirm_offline:false,manual_delivery:false,split_delivery:false,electronic_waybill:false,refund_create:false,refund_decide:false,tracking:false,writeoff:false};
export function managerCount(value:unknown):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new ValidateException('管理统计计数异常');return n;}
export function managerMoney(value:unknown):string{const s=String(value??'0');if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(s))throw new ValidateException('管理统计金额异常');const[whole,frac='']=s.split('.');return `${whole}.${frac.padEnd(2,'0')}`;}
function dateKey(epoch:number){return new Date((epoch+28800)*1000).toISOString().slice(0,10);}
function cents(value:string):bigint{return BigInt(value.replace('.',''));}
function decimal(value:bigint):string{return`${value/100n}.${String(value%100n).padStart(2,'0')}`;}
export async function withManagerRead<T>(container:Container,uid:number,storeId:unknown,read:(db:DbClient,scope:StoreManagerScope)=>Promise<T>,issues:string[]=MANAGER_READ_ISSUES):Promise<MerchantManagementEnvelope<T>>{
  return withTx(container,async db=>{await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(db);
    const scope=await requireStoreManagerScope(db,uid,storeId),data=await read(db,scope),consistency_key=await merchantManagementConsistencyKey(db,scope);
    return{version:MERCHANT_MANAGEMENT_VERSION,actor_uid:uid,store_id:scope.store_id,scope_key:scope.scope_key,consistency_key,data,issues:[...issues]};});
}
export class StoreManagerOrderStatisticsService{
  constructor(private readonly container:Container,private readonly capabilities:MerchantCapabilities|((db:DbClient,scope:StoreManagerScope)=>Promise<MerchantCapabilities>)=MANAGER_UNAVAILABLE_CAPABILITIES){}
  async context(uid:number,query:Record<string,string>):Promise<MerchantManagementEnvelope<MerchantManagementContext>>{
    managerQueryKeys(query,['store_id']);return withTx(this.container,async db=>{await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await themeDeadlines(db);const identities=await readStoreManagerIdentities(db,uid);
      const selected=query.store_id?await requireStoreManagerScope(db,uid,query.store_id):identities.stores.length===1?await requireStoreManagerScope(db,uid,identities.stores[0].store_id):null;
      const data={stores:identities.stores,selected_store_id:selected?.store_id??null,capabilities:selected?(typeof this.capabilities==='function'?await this.capabilities(db,selected):this.capabilities):MANAGER_UNAVAILABLE_CAPABILITIES};
      return{version:MERCHANT_MANAGEMENT_VERSION,actor_uid:uid,store_id:data.selected_store_id,scope_key:identities.scope_key,consistency_key:selected?await merchantManagementConsistencyKey(db,selected):await themeHash({scope:identities.scope_key,stores:identities.stores}),data,issues:[...MANAGER_READ_ISSUES,...identities.conflicts.map(id=>`merchant_store_${id}_duplicate_identity`)]};});
  }
  async statistics(uid:number,query:Record<string,string>,now=Math.floor(Date.now()/1000)){
    return withManagerRead(this.container,uid,parseManagerStoreQuery(query),async(db,scope):Promise<MerchantOrderStatistics>=>{
      const today=startOfBusinessDay(now),date=new Date((now+28800)*1000),month=businessMidnight(date.getUTCFullYear(),date.getUTCMonth(),1),end=now+1;
      const [row]=await db.execute<Record<string,unknown>>(sql`SELECT count(*)::int AS order_count,COALESCE(sum(pay_price) FILTER(WHERE paid=1),0)::text AS sum_price,
        count(*) FILTER(WHERE ${orderReadStatusPredicate(0)})::int AS unpaid_count,count(*) FILTER(WHERE ${orderReadStatusPredicate(1)})::int AS unshipped_count,
        count(*) FILTER(WHERE ${orderReadStatusPredicate(2)})::int AS received_count,count(*) FILTER(WHERE ${orderReadStatusPredicate(3)})::int AS evaluated_count,
        count(*) FILTER(WHERE ${orderReadStatusPredicate(5)})::int AS unwritoff_count,count(*) FILTER(WHERE ${orderReadStatusPredicate(4)})::int AS complete_count,
        COALESCE(sum(pay_price) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${today} AND add_time<${end}),0)::text AS "todayPrice",
        count(*) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${today} AND add_time<${end})::int AS "todayCount",
        COALESCE(sum(pay_price) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${today-86400} AND add_time<${today}),0)::text AS "proPrice",
        count(*) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${today-86400} AND add_time<${today})::int AS "proCount",
        COALESCE(sum(pay_price) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${month} AND add_time<${end}),0)::text AS "monthPrice",
        count(*) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${month} AND add_time<${end})::int AS "monthCount"
        FROM store_order WHERE store_id=${scope.store_id} AND pid>=0 AND is_del=0 AND is_system_del=0`);
      const [refund]=await db.execute<Record<string,unknown>>(sql`SELECT count(*) FILTER(WHERE r.refund_type IN(0,1,2,4,5))::int AS refunding_count,count(*) FILTER(WHERE r.refund_type IN(3,6))::int AS refunded_count
        FROM store_order_refund r JOIN store_order o ON o.id=r.store_order_id AND o.uid=r.uid AND o.store_id=r.store_id AND o.supplier_id=r.supplier_id
        WHERE r.store_id=${scope.store_id} AND o.store_id=${scope.store_id} AND r.is_cancel=0 AND r.is_del=0 AND o.is_del=0 AND o.is_system_del=0`);
      const config=await createContainerFromDb(db).systemConfigDao.getValues(['balance_func_status','yue_pay_status','pay_weixin_open','ali_pay_status']),enabled=(key:string)=>['1','true'].includes(normalizeConfigScalar(config[key]));
      const result=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,['sum_price','todayPrice','proPrice','monthPrice'].includes(key)?managerMoney(value):managerCount(value)]));
      const refunding=managerCount(refund.refunding_count),refunded=managerCount(refund.refunded_count);
      return{...result,refunding_count:refunding,refunded_count:refunded,refund_count:refunding+refunded,yue_pay_status:enabled('balance_func_status')&&enabled('yue_pay_status')?1:2,pay_weixin_open:enabled('pay_weixin_open')?1:0,ali_pay_status:enabled('ali_pay_status'),metric_scope:'current_store_fulfillments_pid_gte_0'} as MerchantOrderStatistics;
    });
  }
  async time(uid:number,query:Record<string,string>,now=Math.floor(Date.now()/1000)){
    const period=parseManagerPeriodQuery(query,now);return withManagerRead(this.container,uid,period.storeId,async(db,scope)=>this.period(db,scope,period));
  }
  private async period(db:DbClient,scope:StoreManagerScope,p:MobileOrderPeriod):Promise<MerchantOrderPeriod>{
    const [row]=await db.execute<Record<string,unknown>>(sql`SELECT COALESCE(sum(pay_price) FILTER(WHERE add_time>=${p.currentStart}),0)::text AS current,
      COALESCE(sum(pay_price) FILTER(WHERE add_time<${p.currentStart}),0)::text AS previous,
      count(*) FILTER(WHERE add_time>=${p.currentStart})::int AS number,count(DISTINCT uid) FILTER(WHERE add_time>=${p.currentStart})::int AS people,
      (SELECT count(*)::int FROM store_product_log v JOIN store_product product ON product.id=v.product_id WHERE product.type=1 AND product.relation_id=${scope.store_id} AND v.type='visit' AND v.delete_time IS NULL AND v.add_time>=${p.currentStart} AND v.add_time<${p.currentEndExclusive}) AS visits
      FROM store_order WHERE store_id=${scope.store_id} AND pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${p.previousStart} AND add_time<${p.currentEndExclusive}`);
    const current=managerMoney(row.current),previous=managerMoney(row.previous),difference=cents(current)-cents(previous),absolute=difference<0n?-difference:difference,rate=absolute===0n?0n:absolute*100n/(cents(previous)===0n?100n:cents(previous));
    if(rate>BigInt(Number.MAX_SAFE_INTEGER))throw new ValidateException('统计增长率超出安全范围');
    return{type:p.type,start:p.currentStart,end_exclusive:p.currentEndExclusive,previous_start:p.previousStart,after_price:current,growth_rate:Number(rate),increase_time:decimal(absolute),increase_time_status:difference>=0n?1:2,after_number:managerCount(row.number),after_pay_number:managerCount(row.people),today_visits:managerCount(row.visits),visit_scope:'current_store_product_visit_events'};
  }
  async chart(uid:number,query:Record<string,string>,now=Math.floor(Date.now()/1000)){
    const p=parseManagerPeriodQuery(query,now);return withManagerRead(this.container,uid,p.storeId,async(db,scope):Promise<MerchantOrderChartPoint[]>=>{
      const rows=await db.execute<Record<string,unknown>>(sql`SELECT to_char(to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,count(*)::int AS num,COALESCE(sum(pay_price),0)::text AS price FROM store_order
        WHERE store_id=${scope.store_id} AND pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${p.chartStart} AND add_time<${p.currentEndExclusive} GROUP BY 1 ORDER BY 1`),map=new Map(rows.map(row=>[String(row.date),{num:managerCount(row.num),price:managerMoney(row.price)}]));
      const result:MerchantOrderChartPoint[]=[];for(let epoch=startOfBusinessDay(p.chartStart);epoch<p.currentEndExclusive;epoch+=86400){const date=dateKey(epoch);result.push({date,time:date.slice(5),...(map.get(date)??{num:0,price:'0.00'})});}return result;
    });
  }
  async daily(uid:number,query:Record<string,string>,now=Math.floor(Date.now()/1000)){
    const q=parseManagerDailyQuery(query,now);return withManagerRead(this.container,uid,q.storeId,async(db,scope)=>this.dailyRows(db,scope,q));
  }
  private async dailyRows(db:DbClient,scope:StoreManagerScope,q:MobileOrderDataQuery):Promise<MerchantPaged<MerchantOrderDailyRow>>{
    const rows=await db.execute<Record<string,unknown>>(sql`WITH daily AS (SELECT (to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai')::date AS date,count(*)::int AS count,COALESCE(sum(pay_price),0)::text AS price,max(add_time)::int AS add_time FROM store_order
      WHERE store_id=${scope.store_id} AND pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${q.start} AND add_time<${q.endExclusive} GROUP BY 1),page AS(SELECT * FROM daily ORDER BY date DESC LIMIT ${q.limit} OFFSET ${q.offset})
      SELECT to_char(page.date,'YYYY-MM-DD') AS date,page.count,page.price,page.add_time,(SELECT count(*)::int FROM store_product_log v JOIN store_product p ON p.id=v.product_id WHERE p.type=1 AND p.relation_id=${scope.store_id} AND v.type='visit' AND v.delete_time IS NULL AND v.add_time>=EXTRACT(EPOCH FROM page.date::timestamp AT TIME ZONE 'Asia/Shanghai') AND v.add_time<EXTRACT(EPOCH FROM (page.date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) AS visit,(SELECT count(*)::int FROM daily) AS total FROM page ORDER BY page.date DESC`);
    const [total]=await db.execute<Record<string,unknown>>(sql`SELECT count(DISTINCT (to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai')::date)::int AS value FROM store_order WHERE store_id=${scope.store_id} AND pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${q.start} AND add_time<${q.endExclusive}`),count=managerCount(total.value);
    return{list:rows.map(row=>({date:String(row.date),time:String(row.date).slice(5),price:managerMoney(row.price),count:managerCount(row.count),visit:managerCount(row.visit),add_time:managerCount(row.add_time)})),count,page:q.page,limit:q.limit,has_more:q.offset+rows.length<count};
  }
}
