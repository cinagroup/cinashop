import {and,asc,eq,getTableColumns,inArray,sql,type SQL} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {legacyCategory,storeProductLabel,storeProductLabelAuxiliary,storeProductRelation,storeProduct,systemLog} from '@/models/schema';
import type {Env} from '@/env';
import {HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {acquireAdminAuthorityWriteBarrier,loadAdminAuthorityLiveActor,type AdminAuthorityActor} from './AdminAuthorityWriteService';
import {authorizeAdminLegacyProductRead,assertAdminLegacyProductReadDeadline} from './AdminLegacyProductReadAuthority';
import {loadAdminProfileActor} from './AdminProfileService';
import {assertAdminProductLabelOperationReady} from '@/migrations/adminProductLabelOperation';
import {publicProductLabelAuthorImages,renderProductLabelAuthorImages,assertProductLabelAuthorIconChange} from '@/services/product/ProductLabelAuthorAssetPolicy';
import {normalizeLabelIcon} from './AdminProductLabelInput';
import {productLabelNormalized,productLabelCategoryNormalized,productLabelProjection,productLabelReceipt,productLabelUuid,productLabelHash,productLabelInteger,productLabelOperation,productLabelObject,productLabelOnly,type ProductLabelAction,type ProductLabelOperation,type ProductLabelReceipt,type ProductLabelRow,type ProductLabelCategoryRow} from '../../../../view/common/productLabelAuthor';
import {productLabelInput,productLabelQuery,productLabelRequest} from './AdminProductLabelAuthorInput';

type Label=typeof storeProductLabel.$inferSelect;
type Group=typeof legacyCategory.$inferSelect;
type StoredLabel=Label&{rowVersion:string};
type StoredGroup=Group&{rowVersion:string};
const labelColumns=getTableColumns(storeProductLabel),groupColumns=getTableColumns(legacyCategory);
const visible=(r:Label)=>r.type===0&&r.relationId===0;
const visibleGroup=(r:Group)=>r.type===0&&r.relationId===0&&r.ownerId===0&&r.group===2;
const ownedLabel=(id:number)=>and(eq(storeProductLabel.id,id),eq(storeProductLabel.type,0),eq(storeProductLabel.relationId,0));
const ownedGroup=(id:number)=>and(eq(legacyCategory.id,id),eq(legacyCategory.type,0),eq(legacyCategory.relationId,0),eq(legacyCategory.ownerId,0),eq(legacyCategory.group,2));
const labelData=({rowVersion:_,...row}:StoredLabel)=>row;
const groupData=({rowVersion:_,...row}:StoredGroup)=>row;
const labelDto=(r:Label)=>({id:r.id,type:r.type,relation_id:r.relationId,label_cate:r.labelCate,label_name:r.labelName,style_type:r.styleType,color:r.color,bg_color:r.bgColor,border_color:r.borderColor,icon:r.icon,is_show:r.isShow,status:r.status,sort:r.sort,add_time:r.addTime});
const groupDto=(r:Group):ProductLabelCategoryRow=>({id:r.id,pid:r.pid,type:r.type,relation_id:r.relationId,owner_id:r.ownerId,name:r.name,sort:r.sort,group:r.group,other:r.other,is_show:r.isShow,add_time:r.addTime,integral_min:r.integralMin,integral_max:r.integralMax});
function stable(value:unknown):unknown {if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,stable(v)]));return value;}
const same=(a:unknown,b:unknown)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const conflict=(message:string)=>new HttpApiException(message,409,409);
function databaseError(error:unknown):never {let cause=error;for(let i=0;i<8&&cause&&typeof cause==='object';i++){const code='code'in cause?String(cause.code):'';if(['55P03','40P01','40001','23505'].includes(code))throw conflict('标签、分组、图库或权限正在变化，请先读取原回执');if(['42501','42P01','42883','57014'].includes(code))throw Object.assign(new ServiceUnavailableException('标签作者能力未就绪或操作超时'),{cause:error});cause='cause'in cause?cause.cause:undefined;}throw error;}

/** Complete author protocol alongside the frozen mature label CRUD and consumers. */
export class AdminProductLabelAuthorService {
 constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>){}
 private transaction<T>(actor:AdminAuthorityActor,write:boolean,owner:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{return withTx(this.container,async tx=>{
  if(write){
   await acquireAdminAuthorityWriteBarrier(tx);
   if(owner)await loadAdminProfileActor(tx,actor);else await loadAdminAuthorityLiveActor(tx,actor,'label.manage');
   await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
   await tx.execute(sql`SELECT pg_advisory_xact_lock(731734,0)`);
   await tx.execute(sql`LOCK TABLE ONLY public.category, ONLY public.store_product_label IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
   await assertAdminProductLabelOperationReady(tx);await tx.execute(sql`SELECT pg_advisory_xact_lock(731654,-1)`);
  }else{
   await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
   await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
   if(owner)await loadAdminProfileActor(tx,actor);else await authorizeAdminLegacyProductRead(tx,actor,'label.view');
  }
  const result=await work(tx);await assertAdminLegacyProductReadDeadline(tx,actor);
  if(write&&!owner)await loadAdminAuthorityLiveActor(tx,actor,'label.manage');return result;
 }).catch(databaseError);}
 private async source(tx:DbClient){
  for(const [table,columns] of [['store_product_label',labelColumns],['category',groupColumns]] as const){
   const [shape]=await tx.execute(sql`SELECT ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid=${`public.${table}`}::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum) AS names`);
   const known=Object.values(columns).map(column=>column.name),names=shape?.names;
   if(!Array.isArray(names)||names.length!==known.length||names.some(name=>typeof name!=='string'||!known.includes(name)))throw new ServiceUnavailableException('标签或分组表结构无法完整核验');
  }
  const labels=await tx.select({...labelColumns,rowVersion:sql<string>`xmin::text`}).from(storeProductLabel).orderBy(asc(storeProductLabel.id)).limit(20001);
  const groups=await tx.select({...groupColumns,rowVersion:sql<string>`xmin::text`}).from(legacyCategory).orderBy(asc(legacyCategory.id)).limit(20001);
  const source={labels,groups};
  if(labels.length>20000||groups.length>20000||new TextEncoder().encode(JSON.stringify(source)).length>16*1024*1024)throw new ServiceUnavailableException('完整标签或分组来源超过20000项或合计16MiB，不能截断');
  return {...source,revision:createHash('sha256').update(JSON.stringify({domain:'product-label-author-catalog-v1',...source})).digest('hex')};
 }
 private async project(tx:DbClient,rows:StoredLabel[]):Promise<ProductLabelRow[]>{
  const icons=await renderProductLabelAuthorImages(this.env.APP_KEY,await publicProductLabelAuthorImages(tx,rows.map(row=>row.icon)));
  return rows.map((row,i)=>({...labelDto(row),preview:{...productLabelProjection({color:row.color,bg_color:row.bgColor,border_color:row.borderColor,icon:''}),icon:icons[i]!}}));
 }
 catalog(query:URLSearchParams,actor:AdminAuthorityActor){productLabelQuery(query);return this.transaction(actor,false,false,async tx=>{
  const source=await this.source(tx),rows=source.labels.filter(visible).sort((a,b)=>b.sort-a.sort||b.id-a.id),groups=source.groups.filter(visibleGroup).sort((a,b)=>b.sort-a.sort||b.id-a.id);
  return {list:await this.project(tx,rows),groups:groups.map(groupDto),count:rows.length,group_count:groups.length,revision:source.revision,can_create:source.labels.length<20000,can_create_group:source.groups.length<20000,write_ready:await assertAdminProductLabelOperationReady(tx).then(()=>true).catch(()=>false)};
 });}
 private receiptRow(row:Record<string,unknown>,action?:ProductLabelAction):ProductLabelReceipt {
  const value={operation_id:row.operation_id,actor_id:row.actor_id,operation:row.operation,target_id:row.target_id,revision:row.revision,payload_hash:row.payload_hash,state:row.state,result:row.result};
  if(action)return productLabelInput(()=>productLabelReceipt(value,action));
  // A GET has only the immutable nine receipt columns. It must not invent the
  // original payload; the owner validates this response with its real journal.
  return productLabelInput(()=>{
   const operation=productLabelOperation(value.operation),target_id=productLabelInteger(value.target_id),state=value.state;
   if(state!=='committed'&&state!=='not_applied')throw Error('原标签结果仍未知');
   const raw=productLabelObject(value.result);productLabelOnly(raw,['id','created','updated','deleted','protected_ids','count','revision']);
   if(!Array.isArray(raw.protected_ids)||raw.protected_ids.length>5)throw Error('标签保护结果无效');
   const protected_ids=raw.protected_ids.map(id=>productLabelInteger(id,1,5));if(protected_ids.some((id,i)=>i>0&&id<=protected_ids[i-1]!))throw Error('标签保护结果重复');
   const result={id:productLabelInteger(raw.id),created:productLabelInteger(raw.created,0,1),updated:productLabelInteger(raw.updated,0,1),deleted:productLabelInteger(raw.deleted,0,50),protected_ids,count:productLabelInteger(raw.count,0,20000),revision:productLabelHash(raw.revision)};
   const receipt:ProductLabelReceipt={operation_id:productLabelUuid(value.operation_id),actor_id:productLabelInteger(value.actor_id,1),operation,target_id,revision:productLabelHash(value.revision),payload_hash:productLabelHash(value.payload_hash),state,result};
   if(state==='not_applied'&&(result.id!==target_id||result.created||result.updated||result.deleted||result.protected_ids.length||result.count||result.revision!==receipt.revision))throw Error('未应用标签回执矛盾');
   if(state==='committed'&&operation!=='label-batch-delete')productLabelReceipt(receipt,{...receipt,payload:{}});
   if(state==='committed'&&operation==='label-batch-delete'&&(target_id!==0||result.id!==0||result.created||result.updated||result.deleted+protected_ids.length>50))throw Error('标签批量回执矛盾');
   return receipt;
  });
 }
 private async prior(tx:DbClient,a:ProductLabelAction){const rows=await tx.execute(sql`SELECT * FROM public.admin_product_label_operation WHERE operation_id=${a.operation_id}::uuid`);if(!rows.length)return null;const row=rows[0]!;if(row.actor_id!==a.actor_id||row.operation!==a.operation||row.target_id!==a.target_id||row.payload_hash!==a.payload_hash||row.revision!==a.revision)throw conflict('原标签请求标识已用于不同操作');return this.receiptRow(row,a);}
 private async insertReceipt(tx:DbClient,a:ProductLabelAction,state:ProductLabelReceipt['state'],result:ProductLabelReceipt['result']){
  const rows=await tx.execute(sql`INSERT INTO public.admin_product_label_operation(operation_id,actor_id,operation,target_id,payload_hash,revision,state,result,created_at) VALUES (${a.operation_id}::uuid,${a.actor_id},${a.operation},${a.target_id},${a.payload_hash},${a.revision},${state},${JSON.stringify(result)}::jsonb,${Math.floor(Date.now()/1000)}) RETURNING *`);
  if(rows.length!==1)throw Error('标签操作回执缺失');return this.receiptRow(rows[0]!,a);
 }
 receipt(id:unknown,query:URLSearchParams,actor:AdminAuthorityActor){productLabelQuery(query);const uuid=productLabelInput(()=>productLabelUuid(id));return this.transaction(actor,false,true,async tx=>{const rows=await tx.execute(sql`SELECT * FROM public.admin_product_label_operation WHERE operation_id=${uuid}::uuid AND actor_id=${actor.id}`);if(rows.length!==1)throw new NotFoundException('尚未找到原标签回执，结果仍未知');return this.receiptRow(rows[0]!);});}
 resolve(value:unknown,actor:AdminAuthorityActor){const a=productLabelRequest(value,actor.id);return this.transaction(actor,true,true,async tx=>await this.prior(tx,a)??await this.insertReceipt(tx,a,'not_applied',{id:a.target_id,created:0,updated:0,deleted:0,protected_ids:[],count:0,revision:a.revision}));}
 private async audit(tx:DbClient,actor:AdminAuthorityActor,op:ProductLabelOperation,ids:number[]){
  const operation=op==='category-delete'?'category-delete':op.startsWith('category-')?'category-save':op==='label-show'?'isShow':op==='label-status'?'status':op.endsWith('-delete')?'delete':'save';
  const expected={storeId:0,merchantId:0,adminId:actor.id,adminName:'',ip:'',path:`product/label/${operation}`,page:'商品标签管理',method:op==='label-batch-delete'||op==='label-status'||op==='label-show'||op==='category-update'?'PUT':op.endsWith('-delete')?'DELETE':'POST',action:JSON.stringify({operation,ids}),type:'product_label_catalog',addTime:Math.floor(Date.now()/1000)};
  const rows=await tx.insert(systemLog).values(expected).returning(),row=rows[0];
  const matches=(value:typeof row|undefined)=>value&&Number.isSafeInteger(value.id)&&value.id>0&&Object.entries(expected).every(([key,v])=>value[key as keyof typeof value]===v);
  if(rows.length!==1||!matches(row))throw Error('标签审计完整回执不一致');
  const [readBack]=await tx.select().from(systemLog).where(eq(systemLog.id,row.id)).limit(1);if(!matches(readBack))throw Error('标签审计完整回读不一致');return {id:row.id,expected};
 }
 private async references(tx:DbClient,ids:number[]){
  if(!ids.length)return;
  const numbers=sql.join(ids.map(id=>sql`${id}`),sql`,`),strings=sql.join(ids.map(id=>sql`${String(id)}`),sql`,`);
  const predicates:SQL[]=[sql`EXISTS(SELECT 1 FROM ${storeProductRelation} WHERE type=3 AND relation_id IN (${numbers}))`,sql`EXISTS(SELECT 1 FROM ${storeProductLabelAuxiliary} WHERE label_id IN (${numbers}))`,sql`EXISTS(SELECT 1 FROM ${storeProduct} p WHERE p.is_del=0 AND btrim(coalesce(p.store_label_id,''))<>'' AND EXISTS(SELECT 1 FROM unnest(string_to_array(coalesce(p.store_label_id,''),',')) AS token(value) WHERE btrim(token.value)<>'' AND CASE WHEN btrim(token.value) ~ '^[+-]?[0-9]+$' THEN ltrim(btrim(token.value),'+0') = ANY(ARRAY[${strings}]::text[]) ELSE true END))`];
  const [reference]=await tx.execute(sql`SELECT (${sql.join(predicates,sql` OR `)}) AS linked`);if(reference?.linked!==false)throw new ValidateException('标签仍被商品或历史辅助引用使用，不能删除');
 }
 mutate(value:unknown,actor:AdminAuthorityActor){const a=productLabelRequest(value,actor.id);return this.transaction(actor,true,false,async tx=>{
  const prior=await this.prior(tx,a);if(prior){if(prior.state!=='committed')throw conflict('原标签操作已封存，不能再提交');return prior;}
  const before=await this.source(tx);if(a.revision!==before.revision)throw conflict('标签或分组目录已变化，请先核对原回执');
  const isGroup=a.operation.startsWith('category-'),oldLabel=!isGroup&&a.target_id?before.labels.find(r=>r.id===a.target_id&&visible(r)):undefined,oldGroup=isGroup&&a.target_id?before.groups.find(r=>r.id===a.target_id&&visibleGroup(r)):undefined;
  if(a.target_id&&!(oldLabel||oldGroup))throw new NotFoundException('平台标签或分组不存在');
  if(oldGroup)await tx.select({id:legacyCategory.id}).from(legacyCategory).where(ownedGroup(oldGroup.id)).for('update',{noWait:true});
  if(oldLabel)await tx.select({id:storeProductLabel.id}).from(storeProductLabel).where(ownedLabel(oldLabel.id)).for('update',{noWait:true});
  const labels=new Map(before.labels.map(row=>[row.id,labelData(row)])),groups=new Map(before.groups.map(row=>[row.id,groupData(row)]));
  let id=a.target_id,created=0,updated=0,deleted=0,protected_ids:number[]=[],changedIcon:string|undefined,auditIds:number[]=[],deletedIds:number[]=[];
  if(a.operation==='category-create'||a.operation==='category-update'){
   const values=productLabelInput(()=>productLabelCategoryNormalized(a.payload,oldGroup?groupDto(oldGroup):undefined));
   if(!oldGroup||values.name!==oldGroup.name)if(before.groups.some(r=>visibleGroup(r)&&r.id!==id&&r.name===values.name))throw new ValidateException('标签组已存在');
   if(!oldGroup){if(before.groups.length>=20000)throw conflict('完整标签分组已达20000项');const expected={pid:0,type:0,relationId:0,ownerId:0,name:values.name,sort:values.sort,group:2,other:null,isShow:1,addTime:Math.floor(Date.now()/1000),integralMin:0,integralMax:0};const rows=await tx.insert(legacyCategory).values(expected).returning(),saved=rows[0];if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||groups.has(saved.id)||!same(saved,{id:saved.id,...expected}))throw Error('标签组新增完整回读不一致');id=saved.id;groups.set(id,saved);created=1;}
   else {if(values.name!==oldGroup.name||values.sort!==oldGroup.sort)await tx.update(legacyCategory).set(values).where(ownedGroup(id));groups.set(id,{...groupData(oldGroup),...values});updated=1;}
   auditIds=[id];
  }else if(a.operation==='category-delete'){
   if(id===1)throw new ValidateException('系统默认标签组不能删除');
   if(before.labels.some(row=>row.labelCate===id))throw new ValidateException('标签组下有标签不能删除');
   await tx.delete(legacyCategory).where(ownedGroup(id));groups.delete(id);deleted=1;auditIds=[id];
  }else if(a.operation==='label-delete'||a.operation==='label-batch-delete'){
   const ids=a.operation==='label-delete'?[id]:a.payload.ids as number[],rows=ids.map(target=>before.labels.find(r=>r.id===target&&visible(r)));
   if(rows.some(row=>!row))throw new NotFoundException('标签不存在或不属于平台');
   protected_ids=rows.filter(row=>a.operation==='label-batch-delete'?row!.id<=5:row!.id<=5&&row!.labelCate===1).map(row=>row!.id);
   if(a.operation==='label-delete'&&protected_ids.length)throw new ValidateException('默认标签不允许删除');
   const deleting=ids.filter(target=>!protected_ids.includes(target));
   if(deleting.length){await tx.select({id:storeProductLabel.id}).from(storeProductLabel).where(inArray(storeProductLabel.id,deleting)).orderBy(asc(storeProductLabel.id)).for('update',{noWait:true});await this.references(tx,deleting);await tx.delete(storeProductLabel).where(inArray(storeProductLabel.id,deleting));deleting.forEach(target=>labels.delete(target));}
   deleted=deleting.length;auditIds=deleting;deletedIds=deleting;
  }else if(a.operation==='label-status'||a.operation==='label-show'){
   const field=a.operation==='label-status'?'status':'isShow',flag=a.payload[a.operation==='label-status'?'status':'is_show'] as number;
   if(oldLabel![field]!==flag)await tx.update(storeProductLabel).set({[field]:flag}).where(ownedLabel(id));labels.set(id,{...labelData(oldLabel!),[field]:flag});updated=1;auditIds=[id];
  }else{
   const original=oldLabel?{...labelDto(oldLabel),preview:{color:'',bg_color:'',border_color:'',icon:''}}:undefined,values=productLabelInput(()=>productLabelNormalized(a.payload,original));
   if(!oldLabel||values.label_cate!==oldLabel.labelCate){const category=before.groups.find(row=>row.id===values.label_cate&&visibleGroup(row));if(!category)throw new ValidateException('请选择真实平台标签分组');await tx.select({id:legacyCategory.id}).from(legacyCategory).where(ownedGroup(category.id)).for('share',{noWait:true});}
   if(!oldLabel||values.label_cate!==oldLabel.labelCate||values.label_name!==oldLabel.labelName)if(before.labels.some(r=>visible(r)&&r.id!==id&&r.labelCate===values.label_cate&&r.labelName===values.label_name))throw new ValidateException('标签已经存在');
   if(!oldLabel||values.icon!==oldLabel.icon||values.style_type===2&&oldLabel.styleType!==2){if(normalizeLabelIcon(values.icon)!==values.icon)throw new ValidateException('标签图标须使用规范长期引用');await assertProductLabelAuthorIconChange(tx,null,values.icon);changedIcon=values.icon;}
   const delta={labelCate:values.label_cate,labelName:values.label_name,styleType:values.style_type,color:values.color,bgColor:values.bg_color,borderColor:values.border_color,icon:values.icon,isShow:values.is_show,status:values.status,sort:values.sort};
   if(!oldLabel){if(before.labels.length>=20000)throw conflict('完整标签目录已达20000项');const expected={type:0,relationId:0,...delta,addTime:Math.floor(Date.now()/1000)};const rows=await tx.insert(storeProductLabel).values(expected).returning(),saved=rows[0];if(rows.length!==1||!saved||!Number.isSafeInteger(saved.id)||saved.id<1||labels.has(saved.id)||!same(saved,{id:saved.id,...expected}))throw Error('标签新增完整回读不一致');id=saved.id;labels.set(id,saved);created=1;}
   else{if(Object.entries(delta).some(([key,v])=>oldLabel[key as keyof Label]!==v))await tx.update(storeProductLabel).set(delta).where(ownedLabel(id));labels.set(id,{...labelData(oldLabel),...delta});updated=1;}
   auditIds=[id];
  }
  const audit=await this.audit(tx,actor,a.operation,auditIds);await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
  const [finalAudit]=await tx.select().from(systemLog).where(eq(systemLog.id,audit.id)).limit(1);if(!finalAudit||Object.entries(audit.expected).some(([key,v])=>finalAudit[key as keyof typeof finalAudit]!==v))throw Error('标签延迟约束后的审计完整回读不一致');
  if(changedIcon!==undefined)await assertProductLabelAuthorIconChange(tx,null,changedIcon);
  await this.references(tx,deletedIds);
  const after=await this.source(tx);if(!same(after.labels.map(labelData),[...labels.values()].sort((a,b)=>a.id-b.id))||!same(after.groups.map(groupData),[...groups.values()].sort((a,b)=>a.id-b.id)))throw Error('标签或分组完整写后回读不一致');
  return this.insertReceipt(tx,a,'committed',{id,created,updated,deleted,protected_ids,count:after.labels.filter(visible).length,revision:after.revision});
 });}
}
