import {and,asc,eq,inArray,sql,type SQL} from 'drizzle-orm';
import {timingSafeEqual} from 'node:crypto';
import {createContainerFromDb,withTx,type Container,type DbClient} from '@/lib/di';
import {storeBrand,storeProduct,storeProductRelation,storeProductCategoryBrand,storePromotionsAuxiliary,storeCouponIssue,systemAdmin,systemLog} from '@/models/schema';
import {ApiErrorCode,AuthException,HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {md5} from '@/utils/jwt';
import {AdminPermissionService,hasAdminPermission,PRODUCT_BRAND_SELECTION_PERMISSION} from './AdminPermissionService';
import {acquireAdminAuthorityWriteBarrier} from './AdminAuthorityWriteService';
import {brandFlag,brandId,brandObject,parseProductBrandInput,parseProductBrandQuery,productBrandCatalogType,type ProductBrandInput} from './AdminProductBrandInput';
import {tryLockProductWrite} from '@/services/product/ProductAssociationService';
export interface AdminProductBrandActor {id:number;authVersion:string;expiresAt:number}
type Brand=typeof storeBrand.$inferSelect;
const BRAND_SCOPE_LOCK=731_735,MAX_BRANDS=1000,MAX_MOVE_PRODUCTS=500;
const owner=and(eq(storeBrand.storeId,0),eq(storeBrand.isDel,0));
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function date(seconds:number){const p=Object.fromEntries(formatter.formatToParts(new Date(seconds*1000)).map(part=>[part.type,part.value]));return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;}
function claims(actor:AdminProductBrandActor){
  if(!Number.isSafeInteger(actor.id)||actor.id<=0||actor.id>2147483647||!/^[a-f0-9]{32}$/.test(actor.authVersion)||!Number.isSafeInteger(actor.expiresAt))throw new AuthException('请重新登录',ApiErrorCode.ERR_LOGIN);
  if(actor.expiresAt<=Math.floor(Date.now()/1000))throw new AuthException('登录已过期',ApiErrorCode.ERR_EXPIRED);
}
function noQuery(query:URLSearchParams){if(query.size)throw new ValidateException('此品牌操作不接受查询参数');}
function changedOutside(before:object,after:object,allowed:readonly string[]){const row=after as Record<string,unknown>;return Object.entries(before).some(([key,value])=>!allowed.includes(key)&&JSON.stringify(row[key])!==JSON.stringify(value));}
function repair():never{throw new HttpApiException('商品品牌选择或关系异常，请先整理后再移动',409,409);}
function selectedIds(value:string){
  const parts=value.trim()?value.split(',').map(item=>item.trim()).filter(Boolean):[];
  if(parts.length>20||parts.some(part=>!/^\+?\d+$/.test(part)))return repair();
  const ids=parts.map(Number).filter(id=>id!==0);
  if(ids.some(id=>!Number.isSafeInteger(id)||id<=0||id>2147483647)||new Set(ids).size!==ids.length)return repair();return ids;
}
function chain(rows:readonly Brand[],id:number):number[]{
  const map=new Map(rows.map(row=>[row.id,row])),result:number[]=[];let cursor=id;
  while(cursor){if(result.includes(cursor)||result.length>=3)throw new ServiceUnavailableException('品牌层级存在循环或超过三级，请先整理');
    const row=map.get(cursor);if(!row)throw new ServiceUnavailableException('品牌父级不存在或不属于平台，请先整理');result.unshift(cursor);cursor=row.pid;}
  return result;
}
function csvReference(column:SQL,ids:number[]):SQL{
  return sql`EXISTS(SELECT 1 FROM unnest(string_to_array(coalesce(${column},''),',')) AS token(value)
    WHERE btrim(token.value)<>'' AND CASE WHEN btrim(token.value) ~ '^[+-]?[0-9]+$'
    THEN ltrim(btrim(token.value),'+0')=ANY(ARRAY[${sql.join(ids.map(id=>sql`${String(id)}`),sql`,`)}]::text[]) ELSE true END)`;
}
export class AdminProductBrandService {
  constructor(private readonly container:Container){}
  private async transaction<T>(actor:AdminProductBrandActor,write:boolean,selection:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    claims(actor);try{return await withTx(this.container,async tx=>{
      if(!write)await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      if(write){await acquireAdminAuthorityWriteBarrier(tx);await tx.execute(sql`SELECT pg_advisory_xact_lock(${BRAND_SCOPE_LOCK},0)`);}
      const [live]=await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
      if(!live||live.adminType!==1||live.relationId!==0||live.status!==1||live.isDel!==0||!Number.isInteger(live.level)||live.level<0||live.level>9)throw new AuthException('管理员身份已变化',ApiErrorCode.ERR_BANNED);
      const encoder=new TextEncoder();if(!timingSafeEqual(encoder.encode(md5(live.pwd)),encoder.encode(actor.authVersion)))throw new AuthException('登录凭据已变化',ApiErrorCode.ERR_EXPIRED);
      if(live.level!==0){const {keys}=await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles,write);
        if(!hasAdminPermission(keys,write?'brand.manage':selection?PRODUCT_BRAND_SELECTION_PERMISSION:'brand.view'))throw new AuthException('商品品牌权限已变化',ApiErrorCode.ERR_AUTH);}
      claims(actor);const result=await work(tx);claims(actor);return result;
    });}catch(error){let cause:unknown=error;for(let i=0;i<6&&cause&&typeof cause==='object';i++){
      if('code'in cause&&['55P03','40P01','40001'].includes(String(cause.code)))throw Object.assign(new HttpApiException('品牌或关联商品正在更新，请刷新后重试',409,409),{cause:error});
      cause='cause'in cause?cause.cause:null;
    }throw error;}
  }
  private async catalog(tx:DbClient){
    const rows=await tx.select().from(storeBrand).where(owner).orderBy(sql`sort DESC,id DESC`).limit(MAX_BRANDS+1);
    if(rows.length>MAX_BRANDS)throw new ServiceUnavailableException('平台品牌超过1000项，请先整理');return rows;
  }
  private async row(tx:DbClient,id:number,lock=false){
    const query=tx.select().from(storeBrand).where(and(owner,eq(storeBrand.id,id))).limit(1);
    const [row]=lock?await query.for('update'):await query;if(!row)throw new NotFoundException('平台品牌不存在');return row;
  }
  private async audit(tx:DbClient,actor:AdminProductBrandActor,operation:string,ids:number[],method:'POST'|'PUT'|'DELETE'){
    const action=JSON.stringify({operation,ids});const rows=await tx.insert(systemLog).values({adminId:actor.id,path:`product/brand/${operation}`,page:'商品品牌管理',method,type:'product_brand_catalog',action,addTime:Math.floor(Date.now()/1000)})
      .returning({id:systemLog.id,adminId:systemLog.adminId,method:systemLog.method,type:systemLog.type,action:systemLog.action});
    if(rows.length!==1||rows[0].id<=0||rows[0].adminId!==actor.id||rows[0].method!==method||rows[0].type!=='product_brand_catalog'||rows[0].action!==action)throw Error('品牌审计回执不完整');
  }
  private dto(row:Brand,rows:readonly Brand[],count:number){
    const fid=chain(rows,row.id).slice(0,-1),type=fid.length<2?1:0;
    return {id:row.id,brand_name:row.brandName,pid:row.pid,fid,store_id:row.storeId,sort:row.sort,is_show:row.isShow,add_time:date(row.addTime),is_del:row.isDel,brand_num:count,type,
      ...(type?{fid_son:[...fid,row.id]}:{}),...(rows.some(child=>child.pid===row.id)?{children:[],loading:false,_loading:false}:{})};
  }
  async list(query:URLSearchParams,actor:AdminProductBrandActor){
    const filter=parseProductBrandQuery(query);return this.transaction(actor,false,false,async tx=>{
      const rows=await this.catalog(tx);if(filter.pid&&!rows.some(row=>row.id===filter.pid))throw new NotFoundException('平台父品牌不存在');
      const selected=rows.filter(row=>row.pid===filter.pid&&row.brandName.includes(filter.keyword));
      const counts=selected.length?await tx.select({id:storeProduct.brandId,count:sql<number>`count(*)::integer`}).from(storeProduct)
        .where(and(inArray(storeProduct.brandId,selected.map(row=>row.id)),eq(storeProduct.pid,0),eq(storeProduct.isDel,0))).groupBy(storeProduct.brandId):[];
      const map=new Map(counts.map(row=>[row.id,row.count]));return {list:selected.map(row=>this.dto(row,rows,map.get(row.id)??0)),count:selected.length};
    });
  }
  async cascader(type:unknown,query:URLSearchParams,actor:AdminProductBrandActor){
    type=productBrandCatalogType(type);noQuery(query);return this.transaction(actor,false,true,async tx=>{
      const rows=await this.catalog(tx),visible=rows.filter(row=>row.isShow===1),byParent=new Map<number,Brand[]>();
      for(const row of visible){const children=byParent.get(row.pid)??[];children.push(row);byParent.set(row.pid,children);}
      const tree=(pid:number,depth:number):Array<{value:number;label:string;pid:number;children?:unknown[]}>=>{
        if(depth>3)throw new ServiceUnavailableException('品牌层级超过三级，请先整理');
        return (byParent.get(pid)??[]).map(row=>{chain(rows,row.id);const children=type===1&&depth===2?[]:(byParent.get(row.id)?.length?tree(row.id,depth+1):[]);
          return {value:row.id,label:row.brandName,pid:row.pid,...(children.length?{children}:{})};});
      };
      const nodes=tree(0,1);return type===1?[{value:0,label:'顶级品牌'},...nodes]:nodes;
    });
  }
  private async references(tx:DbClient,ids:number[]){
    if(!ids.length)return;
    const values=sql.join(ids.map(id=>sql`${id}`),sql`,`);
    const [reference]=await tx.execute(sql`SELECT (
      EXISTS(SELECT 1 FROM ${storeProductRelation} WHERE type=2 AND relation_id IN (${values})) OR
      EXISTS(SELECT 1 FROM ${storeProduct} p WHERE p.is_del=0 AND (p.brand_id IN (${values}) OR ${csvReference(sql`p.brand_com`,ids)})) OR
      EXISTS(SELECT 1 FROM ${storeProductCategoryBrand} WHERE brand_id IN (${values})) OR
      EXISTS(SELECT 1 FROM ${storePromotionsAuxiliary} WHERE brand_id IN (${values})) OR
      EXISTS(SELECT 1 FROM ${storeCouponIssue} c WHERE c.coupon_type=3 AND (c.legacy_brand_id IN (${values}) OR ${csvReference(sql`c.brand_id`,ids)}))
    ) AS linked`) as unknown as Array<{linked:boolean}>;
    if(reference.linked)throw new ValidateException('品牌仍被商品、历史辅助、活动或优惠券引用，不能删除');
  }
  private async moveProducts(tx:DbClient,rows:Brand[],subtree:Brand[],newAncestors:number[],movedId:number){
    const ids=subtree.map(row=>row.id),values=sql.join(ids.map(id=>sql`${id}`),sql`,`);
    const related=await tx.select({id:storeProduct.id}).from(storeProduct).where(sql`${storeProduct.isDel}=0 AND (
      ${storeProduct.brandId} IN (${values}) OR ${csvReference(sql`${storeProduct.brandCom}`,ids)} OR
      EXISTS(SELECT 1 FROM ${storeProductRelation} r WHERE r.product_id=${storeProduct.id} AND r.type=2 AND r.relation_id IN (${values})))`)
      .orderBy(asc(storeProduct.id)).limit(MAX_MOVE_PRODUCTS+1);
    if(related.length>MAX_MOVE_PRODUCTS)throw new ServiceUnavailableException('品牌移动关联商品超过500项，请先分批整理');
    const byId=new Map(rows.map(row=>[row.id,row])),oldMovedPath=chain(rows,movedId),maintained:number[]=[];
    for(const item of related){
      if(!await tryLockProductWrite(tx,item.id))throw new HttpApiException('关联商品正在更新，请刷新后重试',409,409);
      const [product]=await tx.select().from(storeProduct).where(eq(storeProduct.id,item.id)).for('update',{noWait:true});
      if(!product||product.isDel!==0)return repair();
      let selected=selectedIds(product.brandCom??'');
      if(!selected.length&&product.brandId>0)selected=[product.brandId];
      if(!byId.has(product.brandId)||selected.at(-1)!==product.brandId||selected.some(id=>!byId.has(id)))return repair();
      const relations=await tx.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId,product.id),eq(storeProductRelation.type,2))).orderBy(asc(storeProductRelation.id)).for('update',{noWait:true});
      const relationIds=relations.map(row=>row.relationId),set=[...selected].sort((a,b)=>a-b);
      if(relations.length&&(new Set(relationIds).size!==relationIds.length||JSON.stringify([...relationIds].sort((a,b)=>a-b))!==JSON.stringify(set)))return repair();
      const oldPath=chain(rows,product.brandId),derived=selected.length>1&&JSON.stringify(selected)===JSON.stringify(oldPath)&&oldPath.includes(movedId);
      if(!derived)continue; // Explicit selections and primary-only historical rows retain their facts.
      const next=[...newAncestors,...oldPath.slice(oldMovedPath.length-1)],expected=next.join(',');
      const [saved]=await tx.update(storeProduct).set({brandCom:expected}).where(eq(storeProduct.id,product.id)).returning();
      if(!saved||saved.brandCom!==expected||changedOutside(product,saved,['brandCom']))throw Error('品牌商品父链维护回执不完整');
      if(relations.length){
        const deleting=relations.filter(row=>!next.includes(row.relationId));
        if(deleting.length){const removed=await tx.delete(storeProductRelation).where(inArray(storeProductRelation.id,deleting.map(row=>row.id))).returning({id:storeProductRelation.id});
          if(removed.length!==deleting.length||removed.some(row=>!deleting.some(before=>before.id===row.id)))throw Error('品牌关联差量删除回执不完整');}
        const adding=next.filter(id=>!relationIds.includes(id));
        if(adding.length){const inserted=await tx.insert(storeProductRelation).values(adding.map(relationId=>({productId:product.id,type:2,relationId,relationPid:0,status:1,addTime:Math.floor(Date.now()/1000)}))).returning();
          if(inserted.length!==adding.length||inserted.some(row=>row.productId!==product.id||row.type!==2||!adding.includes(row.relationId)||row.status!==1||row.relationPid!==0))throw Error('品牌关联差量新增回执不完整');}
        const after=await tx.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId,product.id),eq(storeProductRelation.type,2))).orderBy(asc(storeProductRelation.id));
        if(after.length!==next.length||JSON.stringify(after.map(row=>row.relationId).sort((a,b)=>a-b))!==JSON.stringify([...next].sort((a,b)=>a-b)))throw Error('品牌关联维护回读不完整');
        for(const before of relations.filter(row=>next.includes(row.relationId)))if(JSON.stringify(after.find(row=>row.id===before.id))!==JSON.stringify(before))throw Error('品牌共同关联历史被改写');
      }
      maintained.push(product.id);
    }
    return maintained;
  }
  private async saveInTx(tx:DbClient,id:number,input:ProductBrandInput,actor:AdminProductBrandActor,method:'POST'|'PUT'=id?'PUT':'POST'){
    const rows=await this.catalog(tx),target=id?await this.row(tx,id):undefined,fid=input.fid.filter(value=>value!==0),pid=fid.at(-1)??0;
    if(pid){await this.row(tx,pid);const expected=chain(rows,pid);if(JSON.stringify(expected)!==JSON.stringify(fid))throw new ValidateException('品牌父级路径与真实层级不一致');}
    if(!pid&&fid.length)throw new ValidateException('品牌父级路径错误');
    if(id&&fid.includes(id))throw new ValidateException('品牌不能移动到自己或后代之下');
    if(fid.length>=3)throw new ValidateException('品牌最多三级');
    if(rows.some(row=>row.pid===pid&&row.brandName===input.brandName&&row.id!==id))throw new ValidateException('同父级品牌已经存在');
    const subtree=target?rows.filter(row=>chain(rows,row.id).includes(id)):[];
    const oldPath=target?chain(rows,id):[];
    if(subtree.some(row=>fid.length+1+chain(rows,row.id).length-oldPath.length>3))throw new ValidateException('移动后品牌超过三级');
    if(subtree.length)await tx.select({id:storeBrand.id}).from(storeBrand).where(and(owner,inArray(storeBrand.id,subtree.map(row=>row.id)))).orderBy(asc(storeBrand.id)).for('update',{noWait:true});
    if(pid)await tx.select({id:storeBrand.id}).from(storeBrand).where(and(owner,eq(storeBrand.id,pid))).for('share',{noWait:true});
    const products=target&&target.pid!==pid?await this.moveProducts(tx,rows,subtree,fid,id):[];
    const values={brandName:input.brandName,pid,fid:fid.join(','),sort:input.sort,isShow:input.isShow};
    const [saved]=id?await tx.update(storeBrand).set(values).where(and(owner,eq(storeBrand.id,id))).returning():await tx.insert(storeBrand).values({...values,storeId:0,isDel:0,addTime:Math.floor(Date.now()/1000)}).returning();
    if(!saved||saved.storeId!==0||saved.isDel!==0||id&&saved.id!==id||Object.entries(values).some(([key,value])=>saved[key as keyof Brand]!==value)||target&&changedOutside(target,saved,Object.keys(values)))throw Error('品牌保存回执不完整');
    if(target&&target.pid!==pid)for(const descendant of subtree.filter(row=>row.id!==id)){
      const path=chain(rows,descendant.id),expected=[...fid,id,...path.slice(oldPath.length,-1)].join(',');
      const [row]=await tx.update(storeBrand).set({fid:expected}).where(and(owner,eq(storeBrand.id,descendant.id))).returning();
      if(!row||row.fid!==expected||changedOutside(descendant,row,['fid']))throw Error('品牌子树更新回执不完整');
    }
    await this.audit(tx,actor,id?'update':'create',[saved.id,...(target&&target.pid!==pid?subtree.filter(row=>row.id!==id).map(row=>row.id):[])],method);
    if(products.length)await this.audit(tx,actor,'move-products',products,'PUT');return {id:saved.id};
  }
  async save(id:number,body:unknown,actor:AdminProductBrandActor){id=brandId(id,true);const input=parseProductBrandInput(body);return this.transaction(actor,true,false,tx=>this.saveInTx(tx,id,input,actor));}
  async setShow(id:number,value:unknown,actor:AdminProductBrandActor){
    id=brandId(id);const flag=brandFlag(value);return this.transaction(actor,true,false,async tx=>{
      await this.row(tx,id,true);const [saved]=await tx.update(storeBrand).set({isShow:flag}).where(and(owner,eq(storeBrand.id,id))).returning();
      if(!saved||saved.id!==id||saved.isShow!==flag||saved.storeId!==0||saved.isDel!==0)throw Error('品牌显示状态回执不完整');
      await this.audit(tx,actor,'show',[id],'PUT');return {id,is_show:flag};
    });
  }
  async remove(id:number,actor:AdminProductBrandActor){
    id=brandId(id);return this.transaction(actor,true,false,async tx=>{
      await this.row(tx,id,true);const children=await tx.select({id:storeBrand.id}).from(storeBrand).where(and(eq(storeBrand.pid,id),eq(storeBrand.isDel,0))).limit(1);
      if(children.length)throw new ValidateException('请先删除子品牌');await this.references(tx,[id]);
      const [saved]=await tx.update(storeBrand).set({isDel:1,isShow:0}).where(and(owner,eq(storeBrand.id,id))).returning();
      if(!saved||saved.id!==id||saved.storeId!==0||saved.isDel!==1||saved.isShow!==0)throw Error('品牌删除回执不完整');
      await this.audit(tx,actor,'delete',[id],'DELETE');return null;
    });
  }
  async modernList(query:URLSearchParams,actor:AdminProductBrandActor){noQuery(query);return this.transaction(actor,false,false,tx=>this.catalog(tx));}
  async modernSave(body:unknown,actor:AdminProductBrandActor){
    const raw=brandObject(body,['id','brand_name','fid','sort','is_show']),id=raw.id===undefined?0:brandId(raw.id,true);
    return this.transaction(actor,true,false,async tx=>{
      const existing=id?await this.row(tx,id):undefined,rows=existing?await this.catalog(tx):[];
      const input=parseProductBrandInput({fid:raw.fid??(existing?chain(rows,id).slice(0,-1):[]),brand_name:raw.brand_name,sort:raw.sort??existing?.sort??0,is_show:raw.is_show??existing?.isShow??1});
      return this.saveInTx(tx,id,input,actor,'POST');
    });
  }
}
