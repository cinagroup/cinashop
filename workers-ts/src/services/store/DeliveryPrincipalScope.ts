import { asc,eq,inArray,sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { deliveryService,systemStore,user,storeOrder,storeOrderCartInfo } from '@/models/schema';
import { AuthException,NotFoundException,ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { themeHash } from '@/services/content/ThemeReadService';
import type { DeliveryContextIdentity,DeliveryContextSelection,DeliveryIdentityConflict } from '../../../../view/common/deliveryWorkbench';

export interface DeliveryActor { uid:number;authVersion:string;expiresAt:number }
export type DeliverySelection=DeliveryContextSelection;
export interface DeliveryPrincipal { actor_uid:number;contexts:DeliveryContextIdentity[];conflicts:DeliveryIdentityConflict[];scope_key:string;issues:string[] }
export interface DeliveryScope extends DeliveryPrincipal { kind:'platform'|'store';store_id:number;delivery_id:number }
export function deliveryId(value:unknown,label='配送'):number{
  if(typeof value!=='number'&&(typeof value!=='string'||!/^[1-9]\d{0,9}$/.test(value)))throw new ValidateException(`${label}标识无效`);
  const id=Number(value);if(!Number.isSafeInteger(id)||id<1||id>2147483647)throw new ValidateException(`${label}标识无效`);return id;
}
export function deliveryActor(value:DeliveryActor):DeliveryActor{
  const uid=deliveryId(value.uid,'用户');if(typeof value.authVersion!=='string'||!/^[a-f0-9]{32}$/.test(value.authVersion)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Math.floor(Date.now()/1000))throw new AuthException('配送会话已失效，请重新登录');
  return{uid,authVersion:value.authVersion,expiresAt:value.expiresAt};
}
async function requireReadCommitted(db:DbClient){const [row]=await db.execute<Record<string,unknown>>(sql`SELECT current_setting('transaction_isolation') AS isolation`);if(row?.isolation!=='read committed')throw new ValidateException('配送写操作必须使用 READ COMMITTED 重新核验权限');}
/** Owner-only recovery intentionally does not require a current delivery role. */
export async function requireFreshDeliveryActor(db:DbClient,value:DeliveryActor,lock=false):Promise<void>{
  const actor=deliveryActor(value);if(lock)await requireReadCommitted(db);
  const query=db.select({uid:user.uid,pwd:user.pwd,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime}).from(user).where(eq(user.uid,actor.uid)).limit(1);
  const [account]=await(lock?query.for('share',{noWait:true}):query);
  if(!account||account.status!==1||account.isDel!==0||account.deleteTime!==null||md5(account.pwd)!==actor.authVersion)throw new AuthException('配送会话已失效，请重新登录');
}
/** No manager, clerk or admin identity is an alternative delivery authority. */
export async function readDeliveryPrincipal(db:DbClient,uidValue:number):Promise<DeliveryPrincipal>{
  const uid=deliveryId(uidValue,'用户'),[account]=await db.select({uid:user.uid,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime}).from(user).where(eq(user.uid,uid)).limit(1);
  if(!account||account.status!==1||account.isDel!==0||account.deleteTime!==null)throw new AuthException('当前用户已失效，请重新登录');
  const rows=await db.select().from(deliveryService).where(eq(deliveryService.uid,uid)).orderBy(asc(deliveryService.id)).limit(1001);
  if(rows.length>1000)throw new ValidateException('配送历史身份超过安全读取容量');
  const ids=[...new Set(rows.filter(row=>row.type===1&&row.relationId>0).map(row=>row.relationId))],stores=ids.length?await db.select({id:systemStore.id,name:systemStore.name,isShow:systemStore.isShow,isStore:systemStore.isStore,isDel:systemStore.isDel}).from(systemStore).where(inArray(systemStore.id,ids)).orderBy(asc(systemStore.id)):[];
  const active=rows.filter(row=>row.status===1&&row.isDel===0),issues:string[]=[],eligible:typeof rows=[];
  for(const row of active){if(row.type===0&&row.relationId===0)eligible.push(row);else if(row.type===1&&row.relationId>0){const store=stores.find(store=>store.id===row.relationId);if(store?.isShow===1&&store.isStore===1&&store.isDel===0)eligible.push(row);else issues.push('delivery_store_unavailable');}else issues.push('delivery_identity_malformed');}
  const pairs=new Map<string,typeof rows>();for(const row of eligible){const key=`${row.type}:${row.relationId}`;pairs.set(key,[...(pairs.get(key)??[]),row]);}
  const contexts:DeliveryContextIdentity[]=[],conflicts:DeliveryIdentityConflict[]=[];
  for(const list of pairs.values()){const first=list[0],kind=first.type===0?'platform':'store',store_id=first.relationId;if(list.length!==1){conflicts.push({kind,store_id,delivery_ids:list.map(row=>row.id)});issues.push('delivery_identity_conflict');continue;}contexts.push({kind,store_id,delivery_id:first.id,name:kind==='platform'?'平台配送':stores.find(store=>store.id===store_id)!.name,nickname:first.nickname,phone:first.phone,avatar:first.avatar});}
  const scope_key=await themeHash({version:'delivery-principal-scope-v1',uid,account,roles:rows.map(row=>({id:row.id,type:row.type,relationId:row.relationId,status:row.status,isDel:row.isDel})),stores:stores.map(({name:_name,...facts})=>facts),conflicts});
  return{actor_uid:uid,contexts,conflicts,scope_key,issues:[...new Set(issues)]};
}
export async function requireDeliveryScope(db:DbClient,actorOrUid:DeliveryActor|number,selection:DeliverySelection,options:{lock?:boolean;expectedScopeKey?:string}={}):Promise<DeliveryScope>{
  const uid=typeof actorOrUid==='number'?deliveryId(actorOrUid,'用户'):deliveryActor(actorOrUid).uid;
  const id=deliveryId(selection.delivery_id),kind=selection.kind,store=selection.store_id;
  if(kind!=='platform'&&kind!=='store'||!Number.isSafeInteger(store)||kind==='platform'&&store!==0||kind==='store'&&(store<=0||store>2147483647))throw new ValidateException('配送上下文无效，请明确选择平台或门店');
  if(options.lock){
    if(typeof actorOrUid==='number')throw new AuthException('配送写操作需要完整当前会话');
    await requireFreshDeliveryActor(db,actorOrUid,true);
    // Existing app INSERT/UPDATE on delivery_service authorizes these locks.
    // SHARE fences duplicate identity INSERTs until commit, not merely rows.
    await db.execute(sql`LOCK TABLE public.delivery_service IN SHARE MODE NOWAIT`);
    const rows=await db.select({id:deliveryService.id,storeId:deliveryService.relationId,type:deliveryService.type}).from(deliveryService).where(eq(deliveryService.uid,uid)).orderBy(asc(deliveryService.id)).limit(1001).for('share',{noWait:true});
    if(rows.length>1000)throw new ValidateException('配送历史身份超过安全锁定容量');
    const ids=[...new Set(rows.filter(row=>row.type===1&&row.storeId>0).map(row=>row.storeId))];if(ids.length)await db.select({id:systemStore.id}).from(systemStore).where(inArray(systemStore.id,ids)).orderBy(asc(systemStore.id)).for('share',{noWait:true});
  }else if(typeof actorOrUid!=='number')await requireFreshDeliveryActor(db,actorOrUid);
  const principal=await readDeliveryPrincipal(db,uid);
  if(options.expectedScopeKey!==undefined&&(!/^[a-f0-9]{64}$/.test(options.expectedScopeKey)||options.expectedScopeKey!==principal.scope_key))throw new ValidateException('配送身份已变化，请重新读取后确认');
  if(principal.conflicts.some(item=>item.kind===kind&&item.store_id===store))throw new ValidateException('所选配送身份存在重复，请先核对历史数据');
  if(!principal.contexts.some(item=>item.kind===kind&&item.store_id===store&&item.delivery_id===id))throw new NotFoundException('当前账号无此配送上下文');
  return{...principal,kind,store_id:store,delivery_id:id};
}
/** Exact immutable review facts; signed URLs, clock and PostgreSQL xmin are absent. */
export function deliveryOrderRevision(order:typeof storeOrder.$inferSelect,carts:Array<typeof storeOrderCartInfo.$inferSelect>):Promise<string>{return themeHash({version:'delivery-order-revision-v1',order,carts:[...carts].sort((a,b)=>a.id-b.id)});}
