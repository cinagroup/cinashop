import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemConfig,systemStore,systemSupplier } from '@/models/schema';
import { erpConnection,erpCredential,type ErpShopBinding } from '@/models/erp';
import { normalizeConfigScalar } from '@/utils/config';
import { ForbiddenException,HttpApiException,ServiceUnavailableException } from '@/utils/errors';
import { ErpSecretCodec,type ErpCipherEnv } from './ErpSecretCodec';
import { ERP_HASH,ERP_UUID,erpCanonical,erpEqualHash,erpSha256 } from './ErpProtocol';

export interface ErpEnv extends ErpCipherEnv {ERP_CALLBACK_ORIGIN?:string}
export const ERP_CONFIG_LOCK=731745;
export const ERP_CONFIG_KEYS=['erp_open','erp_type','jst_appkey','jst_appsecret','jst_default_shopid'] as const;
export type ErpConnectionRow=typeof erpConnection.$inferSelect;
export type ErpCredentialRow=typeof erpCredential.$inferSelect;
export interface ErpConfigSnapshot {appKey:string;appSecret:string;defaultShopId:number;fingerprint:string;revision:string}
const unavailable=()=>new ServiceUnavailableException('ERP 连接状态尚未就绪');
export const erpConflict=(message='ERP 状态已变化，请刷新后重试')=>new HttpApiException(message,409,409);
export async function erpDeadlines(tx:DbClient):Promise<void>{
  await tx.execute(sql`SET LOCAL statement_timeout='10s'`);await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='10s'`);
}
/** The corresponding candidate config-write trigger takes the exclusive side;
 * production admission requires reviewed commissioning of that handshake. */
export async function lockErpConfig(tx:DbClient):Promise<void>{await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${ERP_CONFIG_LOCK},0)`);}
export async function lockErpScope(tx:DbClient):Promise<void>{await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${ERP_CONFIG_LOCK},1)`);}
export async function assertErpStateReady(tx:DbClient):Promise<void>{
  const rows=await tx.execute<{ready:boolean}>(sql`
    SELECT bool_and(to_regclass(table_name) IS NOT NULL AND
      CASE WHEN to_regclass(table_name) IS NULL THEN false ELSE
        has_table_privilege(current_user,table_name,'SELECT') AND has_table_privilege(current_user,table_name,'INSERT') AND has_table_privilege(current_user,table_name,'UPDATE') END) AS ready
    FROM (VALUES ('erp_connection'),('erp_auth_state'),('erp_credential'),('erp_operation')) AS required(table_name)`);
  if(rows[0]?.ready!==true)throw unavailable();
  for(const [table,name,source] of [['system_config','erp_config_write_barrier',ERP_CONFIG_BARRIER_SOURCE],
    ['system_store','erp_store_scope_write_barrier',ERP_STORE_BARRIER_SOURCE],['system_supplier','erp_supplier_scope_write_barrier',ERP_SUPPLIER_BARRIER_SOURCE]]){
    const barriers=await tx.execute<{enabled:string;source:string}>(sql`
      SELECT t.tgenabled::text AS enabled,p.prosrc AS source FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid=to_regclass(${table}) AND t.tgname=${name} AND NOT t.tgisinternal AND t.tgtype=31`);
    if(barriers.length!==1||barriers[0].enabled!=='O'||barriers[0].source.trim()!==source.trim())throw unavailable();
  }
}
/** Exact candidate function body. Missing/disabled/replaced handshake never
 * permits a provider call or a business write with merely present tables. */
const ERP_CONFIG_BARRIER_SOURCE=`
BEGIN
 IF (TG_OP <> 'INSERT' AND OLD.is_store=0 AND lower(btrim(OLD.menu_name)) IN ('erp_open','erp_type','jst_appkey','jst_appsecret','jst_default_shopid'))
  OR (TG_OP <> 'DELETE' AND NEW.is_store=0 AND lower(btrim(NEW.menu_name)) IN ('erp_open','erp_type','jst_appkey','jst_appsecret','jst_default_shopid'))
 THEN PERFORM pg_advisory_xact_lock(731745,0); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END `;
const ERP_STORE_BARRIER_SOURCE=`
BEGIN
 IF TG_OP='INSERT' OR TG_OP='DELETE' OR ROW(NEW.id,NEW.erp_shop_id,NEW.is_show,NEW.is_del) IS DISTINCT FROM ROW(OLD.id,OLD.erp_shop_id,OLD.is_show,OLD.is_del)
 THEN PERFORM pg_advisory_xact_lock(731745,1); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END `;
const ERP_SUPPLIER_BARRIER_SOURCE=`
BEGIN
 IF TG_OP='INSERT' OR TG_OP='DELETE' OR ROW(NEW.id,NEW.is_show,NEW.is_del) IS DISTINCT FROM ROW(OLD.id,OLD.is_show,OLD.is_del)
 THEN PERFORM pg_advisory_xact_lock(731745,1); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END `;
export function erpCallbackOrigin(env:ErpEnv):string {
  let url:URL;try{url=new URL(env.ERP_CALLBACK_ORIGIN??'');}catch{throw unavailable();}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.hostname.includes('.')
    || url.port || /^(localhost|.*\.localhost)$/.test(url.hostname) || /^[\d.:\[\]]+$/.test(url.hostname))throw unavailable();
  return url.origin;
}
export async function readErpConfig(tx:DbClient,env:ErpEnv):Promise<ErpConfigSnapshot>{
  const codec=new ErpSecretCodec(env);
  const rows=await tx.select({id:systemConfig.id,name:systemConfig.menuName,value:systemConfig.value,sort:systemConfig.sort,xmin:sql<string>`xmin::text`})
    .from(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(sql<string>`lower(btrim(${systemConfig.menuName}))`,[...ERP_CONFIG_KEYS])))
    .orderBy(systemConfig.id).limit(101);
  if(rows.length>100)throw unavailable();
  const values=new Map<string,string>();
  for(const key of ERP_CONFIG_KEYS){const matches=rows.filter(row=>row.name.trim().toLowerCase()===key);
    if(matches.length!==1||matches[0].name!==key)throw unavailable();values.set(key,normalizeConfigScalar(matches[0].value));}
  if(values.get('erp_open')!=='1'||values.get('erp_type')!=='1')throw unavailable();
  const appKey=values.get('jst_appkey')!,appSecret=values.get('jst_appsecret')!,shop=values.get('jst_default_shopid')!;
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(appKey)||!appSecret||appSecret.length>512||/[\u0000-\u0020\u007f]/.test(appSecret)
    || !/^[1-9]\d{0,9}$/.test(shop)||!Number.isSafeInteger(Number(shop))||Number(shop)>2147483647)throw unavailable();
  return {appKey,appSecret,defaultShopId:Number(shop),fingerprint:await codec.digest(erpCanonical({appKey,appSecret})),revision:await codec.digest(erpCanonical(rows))};
}
export function validateErpConnection(row:ErpConnectionRow):void {
  if(!ERP_UUID.test(row.id)||row.provider!=='jushuitan'||!['enrolled','active','disabled','revoked'].includes(row.state)
    || !Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.capabilityVersion)||row.capabilityVersion<1
    || !Number.isSafeInteger(row.scopeRevision)||row.scopeRevision<1||!ERP_HASH.test(row.capabilityHash)||!ERP_HASH.test(row.credentialFingerprint)
    || !Array.isArray(row.bindings)||row.bindings.length>100||row.state==='active'&&(!row.bindings.length||!ERP_HASH.test(row.shopObservationHash??'')))throw unavailable();
}
export async function assertErpBindings(tx:DbClient,row:ErpConnectionRow,config:ErpConfigSnapshot):Promise<void>{
  validateErpConnection(row);const seen=new Set<string>();
  for(const binding of row.bindings){
    if(Object.keys(binding).sort().join(',')!=='providerShopId,storeId,supplierId'
      || !Number.isSafeInteger(binding.providerShopId)||binding.providerShopId<=0||binding.providerShopId>2147483647
      || !Number.isSafeInteger(binding.storeId)||binding.storeId<0||binding.storeId>2147483647
      || !Number.isSafeInteger(binding.supplierId)||binding.supplierId<0||binding.supplierId>2147483647)throw unavailable();
    const key=`${binding.providerShopId}:${binding.storeId}:${binding.supplierId}`;if(seen.has(key))throw unavailable();seen.add(key);
    if(binding.storeId===0){if(binding.providerShopId!==config.defaultShopId)throw new ForbiddenException('ERP 平台店铺绑定已变化');}
    else {const [store]=await tx.select().from(systemStore).where(eq(systemStore.id,binding.storeId)).limit(1);
      if(!store||store.isDel!==0||store.isShow!==1||store.erpShopId!==binding.providerShopId)throw new ForbiddenException('ERP 门店绑定已变化');}
    if(binding.supplierId>0){const [supplier]=await tx.select().from(systemSupplier).where(eq(systemSupplier.id,binding.supplierId)).limit(1);
      if(!supplier||supplier.isDel!==0||supplier.isShow!==1)throw new ForbiddenException('ERP 供应商绑定已变化');}
  }
}
export async function readErpConnection(tx:DbClient,id:string,config:ErpConfigSnapshot,active=true,exclusive=false):Promise<ErpConnectionRow>{
  const query=tx.select().from(erpConnection).where(eq(erpConnection.id,id)).limit(1);
  const [row]=exclusive?await query.for('update',{noWait:true}):await query.for('share',{noWait:true});
  if(!row)throw new ForbiddenException('ERP 连接不存在');validateErpConnection(row);
  if(row.state==='disabled'||row.state==='revoked'||active&&row.state!=='active')throw new ForbiddenException('ERP 连接已停用或未授权');
  if(row.appKey!==config.appKey||!erpEqualHash(row.credentialFingerprint,config.fingerprint))throw new ForbiddenException('ERP 连接凭据已变化');
  await assertErpBindings(tx,row,config);return row;
}
export function erpBinding(row:ErpConnectionRow,providerShopId:number,storeId:number,supplierId:number):ErpShopBinding{
  const matches=row.bindings.filter(binding=>binding.providerShopId===providerShopId&&binding.storeId===storeId&&binding.supplierId===supplierId);
  if(matches.length!==1)throw new ForbiddenException('ERP 无权操作该订单或店铺');return matches[0];
}
export function erpCredentialAad(connection:ErpConnectionRow,version:number,purpose:'access'|'refresh'):string{
  return `erp-credential:v1:${connection.id}:${connection.appKey}:${connection.credentialFingerprint}:${version}:${purpose}`;
}
export function erpPrivateCapabilityUrl(origin:string,id:string,capability:string,path:string):string{
  return `${origin}${path}?connection=${id}&cap=${capability}`;
}
export const erpSnapshotHash=(row:unknown)=>erpSha256(erpCanonical(row));
