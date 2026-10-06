import { and, asc, eq, inArray,sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemStore, systemStoreStaff, user, storeOrder } from '@/models/schema';
import { ValidateException, NotFoundException } from '@/utils/errors';
import { themeHash } from '@/services/content/ThemeReadService';
import { acquireManagerScopeLock } from '@/migrations/runManagerScopeLock';
import type { MerchantStoreIdentity } from '../../../../view/common/merchantManagement';

export interface StoreManagerIdentities { actor_uid: number; stores: MerchantStoreIdentity[]; conflicts: number[]; scope_key: string }
export interface StoreManagerScope extends StoreManagerIdentities { store_id: number; staff_id: number }
export function managerId(value: unknown, label='门店'): number {
  if (typeof value!=='number' && (typeof value!=='string' || !/^[1-9]\d{0,9}$/.test(value))) throw new ValidateException(`${label}标识无效`);
  const id=Number(value); if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw new ValidateException(`${label}标识无效`); return id;
}
export async function readStoreManagerIdentities(db: DbClient, uidValue: number, lock=false,storeIdValue?:unknown): Promise<StoreManagerIdentities> {
  const uid=managerId(uidValue,'用户');
  // Writers call this after the shared order resource locks. NOWAIT keeps role
  // changes from creating a reverse waiting lock order. The table lock fences
  // duplicate identity INSERTs for this transaction; its scale cost is explicit.
  if(lock){
    const [isolation]=await db.execute<Record<string,unknown>>(sql`SELECT current_setting('transaction_isolation') AS isolation`);
    if(isolation?.isolation!=='read committed')throw new ValidateException('管理写操作必须使用 READ COMMITTED 重新核验权限');
  }
  const accountQuery=db.select({uid:user.uid,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime}).from(user).where(eq(user.uid,uid)).limit(1);
  const [account]=await(lock?accountQuery.for('share',{noWait:true}):accountQuery);
  if(!account||account.status!==1||account.isDel!==0||account.deleteTime!==null)throw new ValidateException('当前用户已失效，请重新登录');
  if(lock){
    const selected=managerId(storeIdValue);await acquireManagerScopeLock(db,uid,selected);
    const staff=await db.select({storeId:systemStoreStaff.storeId}).from(systemStoreStaff).where(eq(systemStoreStaff.uid,uid)).orderBy(asc(systemStoreStaff.id)).limit(1001);
    if(staff.length>1000)throw new ValidateException('商家历史身份超过安全锁定容量');
    const ids=[...new Set([selected,...staff.map(row=>row.storeId).filter(id=>id>0)])];
    // The existing application profile already carries system_store UPDATE(id)
    // for row locks. No new caller grant or definer authority is introduced.
    await db.select({id:systemStore.id}).from(systemStore).where(inArray(systemStore.id,ids)).orderBy(asc(systemStore.id)).for('share',{noWait:true});
  }
  const query=db.select({store_id:systemStoreStaff.storeId,staff_id:systemStoreStaff.id,name:systemStore.name,is_manager:systemStoreStaff.isManager,is_admin:systemStoreStaff.isAdmin})
    .from(systemStoreStaff).innerJoin(systemStore,eq(systemStore.id,systemStoreStaff.storeId))
    .where(and(eq(systemStoreStaff.uid,uid),eq(systemStoreStaff.status,1),eq(systemStoreStaff.isDel,0),eq(systemStoreStaff.orderStatus,1),
      sql`(${systemStoreStaff.isManager}=1 OR ${systemStoreStaff.isAdmin}=1)`,eq(systemStore.isStore,1),eq(systemStore.isShow,1),eq(systemStore.isDel,0)))
    .orderBy(asc(systemStoreStaff.storeId),asc(systemStoreStaff.id)).limit(101);
  const rows=await query;
  if(rows.length>100)throw new ValidateException('商家管理身份超过安全读取容量');
  const counts=new Map<number,number>();for(const row of rows)counts.set(row.store_id,(counts.get(row.store_id)??0)+1);
  const conflicts=[...counts].filter(([,count])=>count!==1).map(([id])=>id);
  const stores=rows.filter(row=>counts.get(row.store_id)===1).map(({store_id,staff_id,name})=>({store_id,staff_id,name}));
  const scope_key=await themeHash({version:'store-manager-scope-v1',uid,account:{status:account.status,isDel:account.isDel,deleted:account.deleteTime!==null},roles:rows.map(({name:_name,...authority})=>authority),conflicts});
  return{actor_uid:uid,stores,conflicts,scope_key};
}
export async function requireStoreManagerScope(db: DbClient, uid:number, storeIdValue:unknown, options:{lock?:boolean;expectedScopeKey?:string}={}):Promise<StoreManagerScope>{
  const storeId=managerId(storeIdValue),identities=await readStoreManagerIdentities(db,uid,options.lock,storeId);
  if(options.expectedScopeKey!==undefined&&(!/^[a-f0-9]{64}$/.test(options.expectedScopeKey)||options.expectedScopeKey!==identities.scope_key))throw new ValidateException('管理身份已变化，请重新读取后确认');
  if(identities.conflicts.includes(storeId))throw new ValidateException('门店管理身份存在重复，请先完成数据核对');
  const selected=identities.stores.find(row=>row.store_id===storeId);if(!selected)throw new NotFoundException('当前账号无此门店的订单管理权限');
  return{...identities,store_id:storeId,staff_id:selected.staff_id};
}
/** Strong order facts reviewed by the operator; no signed media, clock or xmin. */
export function merchantOrderRevision(order: typeof storeOrder.$inferSelect): Promise<string> {
  const keys=['id','pid','uid','storeId','supplierId','orderId','paid','status','shippingType','payType','payPrice','changePrice','refundStatus','refundType','totalNum','isDel','isSystemDel','supplierAllocationStatus','deliveryType','deliveryId','deliveryCode','deliveryName','remark','productType','type','pinkId','tradeNo','payTime','cartId','virtualInfo','fictitiousContent'] as const;
  return themeHash({version:'store-manager-order-revision-v1',...Object.fromEntries(keys.map(key=>[key,order[key]]))});
}

/** One common pre-signing store authority fingerprint for separate readers.
 * SQL aggregates return fixed-size digests; no whole-shop order data crosses
 * the wire. These are snapshot fences; the write CAS remains the SHA order
 * revision and the financial protocol's exact locked review, not this digest. */
export async function merchantManagementConsistencyKey(db:DbClient,scope:StoreManagerScope):Promise<string>{
  const [row]=await db.execute<Record<string,unknown>>(sql`
    WITH owned_orders AS (SELECT * FROM store_order WHERE store_id=${scope.store_id}),
    authorities AS (
      SELECT 'orders' AS kind,md5(to_jsonb(o)::text) AS h FROM owned_orders o
      UNION ALL SELECT 'carts',md5(to_jsonb(c)::text) FROM store_order_cart_info c JOIN owned_orders o ON o.id=c.oid
      UNION ALL SELECT 'refunds',md5(to_jsonb(r)::text) FROM store_order_refund r JOIN owned_orders o ON o.id=r.store_order_id
      UNION ALL SELECT 'customers',md5(jsonb_build_array(u.uid,u.nickname,u.avatar,u.level,u.is_ever_level,u.is_money_level,u.overdue_time,u.status,u.is_del,u.delete_time)::text) FROM "user" u WHERE EXISTS(SELECT 1 FROM owned_orders o WHERE o.uid=u.uid)
      UNION ALL SELECT 'search_addresses',md5(jsonb_build_array(a.id,a.uid,a.real_name,a.phone)::text) FROM user_address a WHERE EXISTS(SELECT 1 FROM owned_orders o WHERE o.uid=a.uid)
      UNION ALL SELECT 'search_seckill',md5(jsonb_build_array(a.id,a.store_name,a.info)::text) FROM store_seckill a WHERE EXISTS(SELECT 1 FROM owned_orders o WHERE o.type=1 AND o.activity_id=a.id)
      UNION ALL SELECT 'search_bargain',md5(jsonb_build_array(a.id,a.title,a.info)::text) FROM store_bargain a WHERE EXISTS(SELECT 1 FROM owned_orders o WHERE o.type=2 AND o.activity_id=a.id)
      UNION ALL SELECT 'search_combination',md5(jsonb_build_array(a.id,a.store_name,a.info)::text) FROM store_combination a WHERE EXISTS(SELECT 1 FROM owned_orders o WHERE o.type=3 AND o.activity_id=a.id)
      UNION ALL SELECT 'levels',md5(jsonb_build_array(l.id,l.name,l.discount,l.is_show,l.is_del)::text) FROM system_user_level l WHERE EXISTS(SELECT 1 FROM "user" u JOIN owned_orders o ON o.uid=u.uid WHERE u.level=l.id)
      UNION ALL SELECT 'products',md5(jsonb_build_array(p.id,p.type,p.relation_id,p.store_name,p.keyword,p.is_del,p.is_show,p.stock,p.is_police,p.is_verify)::text) FROM store_product p WHERE p.type=1 AND p.relation_id=${scope.store_id}
      UNION ALL SELECT 'visits',md5(jsonb_build_array(v.id,v.product_id,v.type,v.add_time,v.delete_time)::text) FROM store_product_log v JOIN store_product p ON p.id=v.product_id WHERE p.type=1 AND p.relation_id=${scope.store_id} AND v.type='visit'
      UNION ALL SELECT 'config',md5(jsonb_build_array(c.id,c.menu_name,c.value,c.sort)::text) FROM system_config c WHERE c.menu_name IN('balance_func_status','yue_pay_status','pay_weixin_open','ali_pay_status','offline_pay_status','city_delivery_status','self_delivery_status','dada_delivery_status','uu_delivery_status','order_cancel_time','order_activity_time','order_seckill_time','order_bargain_time','order_pink_time')
      UNION ALL SELECT 'store_config',md5(to_jsonb(c)::text) FROM store_config c WHERE c.type=1 AND c.relation_id=${scope.store_id}
      UNION ALL SELECT 'assets',md5(to_jsonb(a)::text) FROM system_attachment a WHERE (a.type=1 AND a.relation_id=0 AND a.module_type=1) OR (a.type=3 AND a.module_type=3 AND EXISTS(SELECT 1 FROM owned_orders o WHERE o.uid=a.relation_id)) OR (a.type=4 AND a.module_type=1 AND EXISTS(SELECT 1 FROM owned_orders o WHERE o.supplier_id=a.relation_id))
      UNION ALL SELECT 'promotions',md5(to_jsonb(p)::text) FROM store_order_promotions p JOIN owned_orders o ON o.id=p.oid
      UNION ALL SELECT 'promotion_titles',md5(jsonb_build_array(p.id,p.title,p.store_id)::text) FROM store_promotions p WHERE (p.store_id=0 OR p.store_id=${scope.store_id}) AND EXISTS(SELECT 1 FROM store_order_promotions op JOIN owned_orders o ON o.id=op.oid WHERE op.promotions_id=p.id)
      UNION ALL SELECT 'invoices',md5(to_jsonb(i)::text) FROM store_order_invoice i JOIN owned_orders o ON o.id=i.order_id
      UNION ALL SELECT 'pink',md5(to_jsonb(p)::text) FROM store_pink p WHERE EXISTS(SELECT 1 FROM owned_orders o WHERE o.pink_id=p.id)
      UNION ALL SELECT 'waybills',md5(jsonb_build_array(w.id,w.root_order_id,w.status,w.update_time)::text) FROM order_waybill_job w WHERE EXISTS(SELECT 1 FROM owned_orders o WHERE w.root_order_id=CASE WHEN o.pid>0 THEN o.pid ELSE o.id END)
      UNION ALL SELECT 'carriers',md5(jsonb_build_array(e.id,e.name,e.code,e.sort,e.status,e.is_show)::text) FROM express_company e
      UNION ALL SELECT 'agents',md5(jsonb_build_array(a.id,a.uid,a.nickname,a.phone,a.status,a.is_del,u.status,u.is_del,u.delete_time)::text) FROM delivery_service a LEFT JOIN "user" u ON u.uid=a.uid WHERE a.type=1 AND a.relation_id=${scope.store_id}
      UNION ALL SELECT 'store',md5(jsonb_build_array(s.id,s.name,s.phone,s.address,s.detailed_address,s.is_show,s.is_store,s.is_del)::text) FROM system_store s WHERE s.id=${scope.store_id}
    ), fingerprints AS (SELECT kind,count(*)::text AS n,
      COALESCE(sum(('x'||substr(h,1,15))::bit(60)::bigint),0)::text AS a,
      COALESCE(sum(('x'||substr(h,17,15))::bit(60)::bigint),0)::text AS b,
      COALESCE(bit_xor(('x'||substr(h,1,16))::bit(64)::bigint),0)::text AS x
      FROM authorities GROUP BY kind)
    SELECT COALESCE(jsonb_agg(jsonb_build_array(kind,n,a,b,x) ORDER BY kind),'[]'::jsonb) AS value FROM fingerprints`);
  const marked=await db.execute(sql`SELECT 1 FROM store_order_cart_info c JOIN store_order o ON o.id=c.oid WHERE o.store_id=${scope.store_id} AND (c.cart_info LIKE '%refund_order_generation%' OR c.cart_info LIKE '%refund-order-line-finance-v1%') LIMIT 1`);
  // Unmarked deployed orders do not acquire a candidate-ledger prerequisite.
  // Marked orders must bind real immutable generation evidence or fail closed.
  const generation=marked.length?await db.execute(sql`SELECT kind,count(*)::text AS n,md5(COALESCE(string_agg(h,',' ORDER BY h),'')) AS h FROM (
    SELECT 'refund_split' AS kind,md5(jsonb_build_array(r.refund_id,r.fingerprint,r.uid,r.store_id,r.supplier_id,r.source_order_id,r.payment_order_id,r.selected_order_id,r.remaining_order_id,r.disposition,r.previous_refund_id,r.base_branch_id,r.returned_point_bill_ids,r.earned_income_scope,r.invoice_allocation,r.partitions)::text) AS h FROM store_order_refund_split r WHERE r.store_id=${scope.store_id}
    UNION ALL SELECT 'refund_branch',md5(to_jsonb(b)::text) FROM store_order_fulfillment_branch b WHERE b.store_id=${scope.store_id}
  ) facts GROUP BY kind ORDER BY kind`):[];
  return themeHash({version:'merchant-management-snapshot-v1',scope:scope.scope_key,store_id:scope.store_id,authorities:row?.value,generation});
}
