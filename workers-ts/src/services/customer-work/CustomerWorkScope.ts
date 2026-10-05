import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeService, user } from '@/models/schema';
import { themeHash } from '@/services/content/ThemeReadService';
import { AuthException, ValidateException,ServiceUnavailableException } from '@/utils/errors';
import { assertCustomerCityDeliveryReady } from '@/migrations/customerCityDelivery';

export const CUSTOMER_WORK_VERSION = 'customer-work-read-v1' as const;
export interface CustomerWorkActor { uid: number; auth_version: string; expires_at: number }
export interface CustomerWorkScope { actor_uid: number; service_id: number; scope_key: string }
export interface CustomerWorkEnvelope<T> {
  version: typeof CUSTOMER_WORK_VERSION;
  actor_uid: number;
  principal: { kind: 'customer-order-manager'; service_id: number; scope: 'global' };
  scope_key: string;
  consistency_key: string;
  data: T;
}
export function customerWorkId(value: unknown, label = '用户'): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value))) throw new ValidateException(`${label}标识无效`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new ValidateException(`${label}标识无效`);
  return id;
}
/** PHP CustomerMiddleware's customer is a global mobile-management grant.
 * status is the independent chat switch; neither mer_id, staff nor a manager
 * identity narrows or grants this role. Safe in the caller's READ ONLY snapshot. */
export async function readCustomerWorkScope(db: DbClient, uid: number, required = true): Promise<CustomerWorkScope | null> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) {
    if (required) throw new AuthException('请登录手机订单工作台');
    return null;
  }
  const rows = await db.select({ service_id: storeService.id, uid: storeService.uid, mer_id: storeService.merId })
    .from(storeService).innerJoin(user, eq(user.uid, storeService.uid))
    .where(and(eq(storeService.uid, uid), eq(storeService.accountStatus, 1), eq(storeService.customer, 1), eq(storeService.isDel, 0),
      eq(user.status, 1), eq(user.isDel, 0), isNull(user.deleteTime)))
    .orderBy(asc(storeService.id)).limit(2);
  if (rows.length !== 1) {
    if (required) throw new AuthException(rows.length ? '手机订单管理身份重复，请先核对' : '当前用户没有手机订单管理权限');
    return null;
  }
  return { actor_uid: uid, service_id: rows[0].service_id, scope_key: await themeHash({ version: 'customer-work-scope-v1', uid, service_id: rows[0].service_id, mer_id: rows[0].mer_id, scope: 'global' }) };
}
export async function authorizeCustomerWorkActor(db: DbClient, actor: CustomerWorkActor): Promise<CustomerWorkScope> {
  customerWorkId(actor?.uid);
  if (!/^[a-f0-9]{32}$/.test(actor?.auth_version ?? '') || !Number.isSafeInteger(actor.expires_at) || actor.expires_at <= Math.floor(Date.now() / 1000)) throw new AuthException('手机订单管理会话已失效');
  const [account] = await db.select({ auth: sql<string>`md5(${user.pwd})` }).from(user).where(eq(user.uid, actor.uid)).limit(1);
  if (!account || account.auth !== actor.auth_version) throw new AuthException('手机订单管理会话已失效');
  return (await readCustomerWorkScope(db, actor.uid))!;
}
/** Fixed-size fingerprints of the exact business tables used by this reader.
 * Amounts, signed URL expiry and user auth bookkeeping never become scopes. */
async function consistency(db: DbClient, scope: CustomerWorkScope): Promise<string> {
  let cityReady=true;try{await assertCustomerCityDeliveryReady(db,false);}catch(error){if(!(error instanceof ServiceUnavailableException))throw error;cityReady=false;}
  const cityFacts=cityReady?sql.raw(`
      UNION ALL SELECT 'city_jobs',md5(jsonb_build_array(j.id,j.root_order_id,j.order_id,j.customer_uid,j.store_id,j.supplier_id,j.actor_uid,j.service_id,j.request_key,j.request_hash,j.status,j.xmin::text)::text) FROM customer_city_delivery_job j
      UNION ALL SELECT 'city_attempts',md5(jsonb_build_array(a.id,a.job_id,a.phase,a.xmin::text)::text) FROM customer_city_delivery_attempt a
      UNION ALL SELECT 'city_bindings',md5(to_jsonb(b)::text) FROM customer_city_delivery_binding b`):sql`UNION ALL SELECT 'city_catalog',md5('unreviewed')`;
  const [row] = await db.execute<{ value: unknown }>(sql`
    WITH facts AS (
      SELECT 'orders' AS kind, md5(to_jsonb(o)::text) AS h FROM store_order o
      UNION ALL SELECT 'carts',md5(to_jsonb(c)::text) FROM store_order_cart_info c
      UNION ALL SELECT 'refunds',md5(to_jsonb(r)::text) FROM store_order_refund r
      UNION ALL SELECT 'refund_partitions',md5(to_jsonb(r)::text) FROM store_order_refund_split r
      UNION ALL SELECT 'fulfillment_branches',md5(to_jsonb(b)::text) FROM store_order_fulfillment_branch b
      UNION ALL SELECT 'waybills',md5(jsonb_build_array(w.id,w.root_order_id,w.order_id,w.store_id,w.supplier_id,w.actor_type,w.actor_id,w.actor_service_id,w.status,w.request_key,w.request_hash,w.xmin::text)::text) FROM order_waybill_job w
      UNION ALL SELECT 'waybill_actions',md5(to_jsonb(a)::text) FROM order_waybill_job_action a
      ${cityFacts}
      UNION ALL SELECT 'delivery_orders',md5(jsonb_build_array(d.id,d.oid,d.uid,d.type,d.relation_id,d.station_type,d.order_id,d.delivery_no,d.status,d.xmin::text)::text) FROM store_delivery_order d
      UNION ALL SELECT 'carriers',md5(jsonb_build_array(e.id,e.name,e.code,e.status,e.is_show,e.sort,e.xmin::text)::text) FROM express_company e
      UNION ALL SELECT 'couriers',md5(to_jsonb(d)::text) FROM delivery_service d
      UNION ALL SELECT 'courier_accounts',md5(jsonb_build_array(u.uid,u.nickname,u.phone,u.status,u.is_del,u.delete_time)::text) FROM "user" u WHERE EXISTS(SELECT 1 FROM delivery_service d WHERE d.uid=u.uid)
      UNION ALL SELECT 'pink',md5(to_jsonb(p)::text) FROM store_pink p
      UNION ALL SELECT 'store_config',md5(jsonb_build_array(c.id,c.type,c.relation_id,c.key_name,c.xmin::text)::text) FROM store_config c
      UNION ALL SELECT 'store_stations',md5(jsonb_build_array(s.id,s.xmin::text)::text) FROM system_store s
      UNION ALL SELECT 'products',md5(jsonb_build_array(p.id,p.type,p.relation_id,p.pid,p.store_name,p.keyword,p.stock,p.is_sold,p.is_police,p.is_verify,p.is_show,p.is_del)::text) FROM store_product p
      UNION ALL SELECT 'visits',md5(jsonb_build_array(v.id,v.product_id,v.type,v.add_time,v.delete_time)::text) FROM store_product_log v
      UNION ALL SELECT 'customers',md5(jsonb_build_array(u.uid,u.nickname,u.avatar,u.phone,u.status,u.is_del,u.delete_time)::text) FROM "user" u WHERE u.uid=${scope.actor_uid} OR EXISTS(SELECT 1 FROM store_order o WHERE o.uid=u.uid)
      UNION ALL SELECT 'config',md5(jsonb_build_array(c.id,c.menu_name,c.xmin::text,c.sort)::text) FROM system_config c WHERE c.menu_name IN('balance_func_status','yue_pay_status','pay_weixin_open','ali_pay_status','logistics_type','system_express_app_code','config_export_open','config_export_id','config_export_temp_id','config_export_to_name','config_export_to_tel','config_export_to_address','config_export_siid','city_delivery_status','self_delivery_status','dada_delivery_status','uu_delivery_status','dada_app_key','dada_app_sercret','dada_source_id','uupt_appkey','uupt_app_id','uupt_open_id','refund_address','refund_name','refund_phone')
      UNION ALL SELECT 'assets',md5(to_jsonb(a)::text) FROM system_attachment a
      UNION ALL SELECT 'suppliers',md5(jsonb_build_array(s.id,s.is_show,s.is_del)::text) FROM system_supplier s
    ), digests AS (SELECT kind,count(*)::text AS n, COALESCE(sum(('x'||substr(h,1,15))::bit(60)::bigint),0)::text AS a,
      COALESCE(sum(('x'||substr(h,17,15))::bit(60)::bigint),0)::text AS b,COALESCE(bit_xor(('x'||substr(h,1,16))::bit(64)::bigint),0)::text AS x FROM facts GROUP BY kind)
    SELECT COALESCE(jsonb_agg(jsonb_build_array(kind,n,a,b,x) ORDER BY kind),'[]'::jsonb) AS value FROM digests`);
  return themeHash({ version: CUSTOMER_WORK_VERSION, scope_key: scope.scope_key, authorities: row?.value });
}
/** Finance uses this same snapshot basis after its own current actor authorization.
 * The alias keeps every existing reader's calculation and call path unchanged. */
export const customerWorkConsistency = consistency;
/** Every multi-query reader uses one RR/READ ONLY snapshot and then a fresh
 * current-role check on the ordinary connection. No FOR SHARE in READ ONLY,
 * Admin connection, DML, cached capability or pseudo manager principal. */
export async function withCustomerWorkRead<T>(container: Container, actorValue: CustomerWorkActor, expectedScope: string | undefined,
  read: (db: DbClient, scope: CustomerWorkScope) => Promise<T>): Promise<CustomerWorkEnvelope<T>> {
  const actor = Object.freeze({ ...actorValue });
  const result = await withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await db.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
    const scope = await authorizeCustomerWorkActor(db, actor);
    if (expectedScope !== undefined && expectedScope !== scope.scope_key) throw new AuthException('手机订单管理身份已变化，请重新读取');
    const data = await read(db, scope), consistency_key = await consistency(db, scope);
    return { version: CUSTOMER_WORK_VERSION, actor_uid: actor.uid, principal: { kind: 'customer-order-manager' as const, service_id: scope.service_id, scope: 'global' as const }, scope_key: scope.scope_key, consistency_key, data };
  });
  const fresh = await authorizeCustomerWorkActor(container.db, actor);
  if (fresh.scope_key !== result.scope_key) throw new AuthException('手机订单管理身份已变化，请重新读取');
  return result;
}
