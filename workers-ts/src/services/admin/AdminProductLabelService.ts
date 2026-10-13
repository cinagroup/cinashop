import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { legacyCategory, storeProductLabel, storeProductLabelAuxiliary, storeProductRelation,
  storeProduct, systemAdmin, systemAttachment, systemLog } from '@/models/schema';
import { ApiErrorCode, AuthException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { AdminPermissionService, hasAdminPermission, PRODUCT_LABEL_SELECTION_PERMISSION } from './AdminPermissionService';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import {resolveProductLabelIcons} from '@/services/product/ProductLabelAssetPolicy';
import {acquireAdminAuthorityWriteBarrier} from './AdminAuthorityWriteService';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { labelId, labelFlag, parseLabelBatch, parseLabelCategoryInput, parseProductLabelInput, parseProductLabelQuery,
  type ProductLabelInput } from './AdminProductLabelInput';

export interface AdminProductLabelActor { id: number; authVersion: string; expiresAt: number }
export type LabelRow = typeof storeProductLabel.$inferSelect;
type CategoryRow = typeof legacyCategory.$inferSelect;
export interface ProductLabelDto { id: number; type: number; relation_id: number; label_cate: number; label_name: string;
  style_type: number; color: string; bg_color: string; border_color: string; icon: string; icon_preview: string;
  is_show: number; status: number; sort: number; add_time: string }
const LABEL_CATALOG_LOCK = 731734;
const MAX_CATALOG_ROWS = 2000;
const scope = sql`type=0 AND relation_id=0`;
const categoryScope = sql`type=0 AND relation_id=0 AND owner_id=0 AND "group"=2`;
const clock = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function date(seconds: number): string {
  if (!seconds) return '';
  const p = Object.fromEntries(clock.formatToParts(new Date(seconds * 1000)).map(part => [part.type,part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function claims(actor: AdminProductLabelActor): void {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || actor.id > 2147483647 || !/^[a-f0-9]{32}$/.test(actor.authVersion)
    || !Number.isSafeInteger(actor.expiresAt)) throw new AuthException('请重新登录', ApiErrorCode.ERR_LOGIN);
  if (actor.expiresAt <= Math.floor(Date.now()/1000)) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
}
function noQuery(query: URLSearchParams) { if (query.size) throw new ValidateException('此标签操作不接受查询参数'); }
function bound<T>(rows: T[]): T[] { if (rows.length > MAX_CATALOG_ROWS) throw new ServiceUnavailableException('标签目录超过2000项，请缩小范围'); return rows; }
function categoryDto(row: CategoryRow) {
  return { id: row.id, pid: row.pid, type: row.type, relation_id: row.relationId, owner_id: row.ownerId,
    name: row.name, sort: row.sort, group: row.group, other:row.other,is_show: row.isShow, add_time: date(row.addTime),
    integral_min:row.integralMin,integral_max:row.integralMax };
}

export class AdminProductLabelService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}
  private async transaction<T>(actor: AdminProductLabelActor, write: boolean, selection: boolean,
    work: (tx: DbClient) => Promise<T>): Promise<T> {
    claims(actor);
    return withTx(this.container, async tx => {
      if (!write) await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      if (write) {
        await acquireAdminAuthorityWriteBarrier(tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${LABEL_CATALOG_LOCK},0)`);
      }
      const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
      if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0
        || !Number.isInteger(live.level) || live.level < 0 || live.level > 9) throw new AuthException('管理员身份已变化',ApiErrorCode.ERR_BANNED);
      const encoder = new TextEncoder();
      if (!timingSafeEqual(encoder.encode(md5(live.pwd)),encoder.encode(actor.authVersion))) throw new AuthException('登录凭据已变化',ApiErrorCode.ERR_EXPIRED);
      if (live.level !== 0) {
        const { keys } = await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles,write);
        const permitted = hasAdminPermission(keys,write ? 'label.manage' : selection ? PRODUCT_LABEL_SELECTION_PERMISSION : 'label.view');
        if (!permitted) throw new AuthException('商品标签权限已变化',ApiErrorCode.ERR_AUTH);
      }
      claims(actor);
      const result = await work(tx);
      claims(actor);
      return result;
    });
  }
  private async dto(tx: DbClient, rows: LabelRow[]): Promise<ProductLabelDto[]> {
    const previews = await resolveProductLabelIcons(tx,this.appKey,rows);
    return rows.map((row,index) => ({ id: row.id,type: row.type,relation_id: row.relationId,label_cate: row.labelCate,
      label_name: row.labelName,style_type: row.styleType,color: row.color,bg_color: row.bgColor,border_color: row.borderColor,
      icon: row.icon,icon_preview: previews[index],is_show: row.isShow,status: row.status,sort: row.sort,add_time: date(row.addTime) }));
  }
  private async categories(tx: DbClient): Promise<CategoryRow[]> {
    return bound(await tx.select().from(legacyCategory).where(categoryScope).orderBy(sql`sort DESC,id DESC`).limit(MAX_CATALOG_ROWS+1));
  }
  private async category(tx: DbClient,id: number,lock = false): Promise<CategoryRow> {
    const query = tx.select().from(legacyCategory).where(and(categoryScope,eq(legacyCategory.id,id))).limit(1);
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new NotFoundException('平台商品标签分组不存在');
    return row;
  }
  private async label(tx: DbClient,id: number,lock = false): Promise<LabelRow> {
    const query = tx.select().from(storeProductLabel).where(and(scope,eq(storeProductLabel.id,id))).limit(1);
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new NotFoundException('平台商品标签不存在');
    return row;
  }
  private async audit(tx: DbClient,actor: AdminProductLabelActor,operation: string,ids: number[],method:'POST'|'PUT'|'DELETE'='POST') {
    const action=JSON.stringify({operation,ids});
    const rows=await tx.insert(systemLog).values({ adminId: actor.id, path: `product/label/${operation}`, page: '商品标签管理',
      method,type: 'product_label_catalog',action,addTime: Math.floor(Date.now()/1000) })
      .returning({id:systemLog.id,adminId:systemLog.adminId,type:systemLog.type,action:systemLog.action,method:systemLog.method});
    if(rows.length!==1||rows[0].id<=0||rows[0].adminId!==actor.id||rows[0].type!=='product_label_catalog'||rows[0].action!==action||rows[0].method!==method) throw new Error('标签审计回执不完整');
  }
  async categoryList(query: URLSearchParams,actor: AdminProductLabelActor) {
    const filter = parseProductLabelQuery(query,true);
    return this.transaction(actor,false,false,async tx => {
      const where = filter.pattern ? sql`${categoryScope} AND (name LIKE ${filter.pattern} OR id::text LIKE ${filter.pattern}
        OR EXISTS(SELECT 1 FROM ${storeProductLabel} l WHERE l.label_cate=${legacyCategory}.id AND l.type=0 AND l.relation_id=0
          AND (l.label_name LIKE ${filter.pattern} OR l.id::text LIKE ${filter.pattern})))` : categoryScope;
      const [total] = await tx.execute(sql`SELECT count(*)::integer AS count FROM ${legacyCategory} WHERE ${where}`) as unknown as Array<{count:number}>;
      const rows = await tx.select().from(legacyCategory).where(where).orderBy(sql`sort DESC,id DESC`).limit(filter.limit).offset(filter.offset);
      const labels = rows.length ? bound(await tx.select().from(storeProductLabel).where(and(scope,inArray(storeProductLabel.labelCate,rows.map(row=>row.id))))
        .orderBy(sql`sort DESC,id DESC`).limit(MAX_CATALOG_ROWS+1)) : [];
      const formatted = await this.dto(tx,labels);
      return { count: total.count,list: rows.map(row=>({ ...categoryDto(row),product_label: formatted.filter(label=>label.label_cate===row.id) })) };
    });
  }
  async list(query: URLSearchParams,actor: AdminProductLabelActor) {
    const filter = parseProductLabelQuery(query);
    return this.transaction(actor,false,false,async tx => {
      if (filter.category) await this.category(tx,filter.category);
      const where = filter.category ? and(scope,eq(storeProductLabel.labelCate,filter.category))! : scope;
      const [total] = await tx.execute(sql`SELECT count(*)::integer AS count FROM ${storeProductLabel} WHERE ${where}`) as unknown as Array<{count:number}>;
      const rows = await tx.select().from(storeProductLabel).where(where).orderBy(sql`sort DESC,id DESC`).limit(filter.limit).offset(filter.offset);
      return { count: total.count,list: await this.dto(tx,rows) };
    });
  }
  async tree(query: URLSearchParams,actor: AdminProductLabelActor) {
    noQuery(query);
    return this.transaction(actor,false,true,async tx => {
      const categories = await this.categories(tx), rows = categories.length ? bound(await tx.select().from(storeProductLabel)
        .where(and(scope,inArray(storeProductLabel.labelCate,categories.map(row=>row.id)))).orderBy(sql`sort DESC,id DESC`).limit(MAX_CATALOG_ROWS+1)) : [];
      const labels = await this.dto(tx,rows);
      return categories.map(row=>({ id:row.id,value:row.id,label_cate:0,label_name:row.name,label:row.name,type:0,relation_id:0,
        children: labels.filter(label=>label.label_cate===row.id).map(label=>({ ...label,value:label.id,label:label.label_name })) }));
    });
  }
  async all(query: URLSearchParams,actor: AdminProductLabelActor) {
    noQuery(query);
    return this.transaction(actor,false,true,async tx => bound(await tx.select({id:storeProductLabel.id,label_name:storeProductLabel.labelName})
      .from(storeProductLabel).where(scope).orderBy(sql`sort DESC,id DESC`).limit(MAX_CATALOG_ROWS+1)));
  }
  async categoryForm(id: number,query: URLSearchParams,actor: AdminProductLabelActor) {
    noQuery(query); id=labelId(id,true);
    return this.transaction(actor,false,false,async tx => {
      const row = id ? await this.category(tx,id) : undefined;
      return { title:id?'编辑标签组':'添加标签组',method:id?'PUT':'POST',action:`product/label_cate${id?`/${id}`:''}`,
        rules:[{type:'input',field:'name',title:'标签组名称',value:row?.name??'',props:{maxlength:30},validate:[{required:true}]},
          {type:'inputNumber',field:'sort',title:'排序',value:row?.sort??0,props:{min:0}}] };
    });
  }
  async form(query: URLSearchParams,actor: AdminProductLabelActor) {
    noQuery(query);
    return this.transaction(actor,false,false,async tx => ({title:'添加商品标签',method:'POST',action:'product/label/0',rules:[
      {type:'select',field:'label_cate',title:'标签分组',value:'',options:(await this.categories(tx)).map(row=>({label:row.name,value:row.id}))},
      {type:'input',field:'label_name',title:'标签名称',value:'',props:{maxlength:20}}]}));
  }
  async saveCategory(id: number,body: unknown,actor: AdminProductLabelActor) {
    id=labelId(id,true); const input=parseLabelCategoryInput(body);
    return this.transaction(actor,true,false,async tx => {
      if(id) await this.category(tx,id,true);
      const duplicate=await tx.select({id:legacyCategory.id}).from(legacyCategory).where(and(categoryScope,eq(legacyCategory.name,input.name)));
      if(duplicate.some(row=>row.id!==id)) throw new ValidateException('标签组已存在');
      const [row]=id ? await tx.update(legacyCategory).set(input).where(and(categoryScope,eq(legacyCategory.id,id))).returning()
        : await tx.insert(legacyCategory).values({...input,type:0,relationId:0,ownerId:0,group:2,addTime:Math.floor(Date.now()/1000)}).returning();
      if(!row || row.type!==0 || row.relationId!==0 || row.ownerId!==0 || row.group!==2 || row.name!==input.name || row.sort!==input.sort || id&&row.id!==id) throw new Error('标签组保存回执不完整');
      await this.audit(tx,actor,'category-save',[row.id],id?'PUT':'POST'); return {id:row.id};
    });
  }
  async deleteCategory(id: number,actor: AdminProductLabelActor) {
    id=labelId(id);
    return this.transaction(actor,true,false,async tx => {
      await this.category(tx,id,true);
      if(id===1) throw new ValidateException('系统默认标签组不能删除');
      const linked=await tx.select({id:storeProductLabel.id}).from(storeProductLabel).where(eq(storeProductLabel.labelCate,id)).limit(1);
      if(linked.length) throw new ValidateException('标签组下有标签不能删除');
      const rows=await tx.delete(legacyCategory).where(and(categoryScope,eq(legacyCategory.id,id))).returning({id:legacyCategory.id});
      if(rows.length!==1||rows[0].id!==id) throw new Error('标签组删除回执不完整');
      await this.audit(tx,actor,'category-delete',[id],'DELETE'); return null;
    });
  }
  private async saveInTx(tx:DbClient,id:number,input:ProductLabelInput,actor:AdminProductLabelActor) {
    await this.category(tx,input.labelCate,true);
    if(id) await this.label(tx,id,true);
    const duplicate=await tx.select({id:storeProductLabel.id}).from(storeProductLabel).where(and(scope,
      eq(storeProductLabel.labelCate,input.labelCate),eq(storeProductLabel.labelName,input.labelName)));
    if(duplicate.some(row=>row.id!==id)) throw new ValidateException('标签已经存在');
    if(input.icon) {
      const attachmentId=parseCanonicalAttachmentId(input.icon);
      if(attachmentId) await tx.select().from(systemAttachment).where(eq(systemAttachment.attId,attachmentId)).for('share');
      const [allowed]=await publicProductPictures(tx,[{image:input.icon,type:0,relationId:0}]);
      if(allowed!==input.icon) throw new ValidateException('图标不属于平台可公开商品图片');
    }
    const [row]=id ? await tx.update(storeProductLabel).set(input).where(and(scope,eq(storeProductLabel.id,id))).returning()
      : await tx.insert(storeProductLabel).values({...input,type:0,relationId:0,addTime:Math.floor(Date.now()/1000)}).returning();
    if(!row || row.type!==0 || row.relationId!==0 || id&&row.id!==id || Object.entries(input).some(([key,value])=>row[key as keyof LabelRow]!==value)) throw new Error('标签保存回执不完整');
    await this.audit(tx,actor,'save',[row.id]); return {id:row.id};
  }
  async save(id:number,body:unknown,actor:AdminProductLabelActor) {
    id=labelId(id,true); const input=parseProductLabelInput(body);
    return this.transaction(actor,true,false,tx=>this.saveInTx(tx,id,input,actor));
  }
  async setFlag(id:number,value:unknown,field:'status'|'isShow',actor:AdminProductLabelActor) {
    id=labelId(id); const flag=labelFlag(value);
    return this.transaction(actor,true,false,async tx=>{
      await this.label(tx,id,true);
      const [row]=await tx.update(storeProductLabel).set({[field]:flag}).where(and(scope,eq(storeProductLabel.id,id))).returning();
      if(!row||row.id!==id||row[field]!==flag) throw new Error('标签状态回执不完整');
      await this.audit(tx,actor,field,[id],'PUT'); return {id,[field==='isShow'?'is_show':'status']:flag};
    });
  }
  private async remove(tx:DbClient,ids:number[],actor:AdminProductLabelActor,skipDefaults:boolean) {
    const rows=ids.length ? await tx.select().from(storeProductLabel).where(and(scope,inArray(storeProductLabel.id,ids))).orderBy(storeProductLabel.id).for('update') : [];
    if(rows.length!==ids.length) throw new NotFoundException('标签不存在或不属于平台');
    const protectedIds=rows.filter(row=>skipDefaults ? row.id<=5 : row.id<=5&&row.labelCate===1).map(row=>row.id);
    if(!skipDefaults&&protectedIds.length) throw new ValidateException('默认标签不允许删除');
    const deleting=ids.filter(id=>!protectedIds.includes(id));
    if(deleting.length) {
      const predicates:SQL[]=[sql`EXISTS(SELECT 1 FROM ${storeProductRelation} WHERE type=3 AND relation_id IN (${sql.join(deleting.map(id=>sql`${id}`),sql`,`)}))`,
        sql`EXISTS(SELECT 1 FROM ${storeProductLabelAuxiliary} WHERE label_id IN (${sql.join(deleting.map(id=>sql`${id}`),sql`,`)}))`,
        sql`EXISTS(SELECT 1 FROM ${storeProduct} p WHERE p.is_del=0 AND btrim(coalesce(p.store_label_id,''))<>''
          AND EXISTS(SELECT 1 FROM unnest(string_to_array(coalesce(p.store_label_id,''),',')) AS token(value)
          WHERE btrim(token.value)<>'' AND CASE WHEN btrim(token.value) ~ '^[+-]?[0-9]+$' THEN
            ltrim(btrim(token.value),'+0') = ANY(ARRAY[${sql.join(deleting.map(id=>sql`${String(id)}`),sql`,`)}]::text[])
            ELSE true END))`];
      const [reference]=await tx.execute(sql`SELECT (${sql.join(predicates,sql` OR `)}) AS linked`) as unknown as Array<{linked:boolean}>;
      if(reference.linked) throw new ValidateException('标签仍被商品或历史辅助引用使用，不能删除');
      const removed=await tx.delete(storeProductLabel).where(and(scope,inArray(storeProductLabel.id,deleting))).returning({id:storeProductLabel.id});
      if(removed.length!==deleting.length||removed.some(row=>!deleting.includes(row.id))) throw new Error('标签删除回执不完整');
      await this.audit(tx,actor,'delete',deleting,skipDefaults?'PUT':'DELETE');
    }
    return {ids:deleting,protected_ids:protectedIds,count:deleting.length};
  }
  async deleteLabel(id:number,actor:AdminProductLabelActor) {
    id=labelId(id); await this.transaction(actor,true,false,tx=>this.remove(tx,[id],actor,false)); return null;
  }
  async batchDelete(body:unknown,actor:AdminProductLabelActor) {
    const input=parseLabelBatch(body);
    return this.transaction(actor,true,false,async tx=>{
      if(input.category) await this.category(tx,input.category,true);
      const ids=input.all ? (await tx.select({id:storeProductLabel.id}).from(storeProductLabel).where(input.category
        ? and(scope,eq(storeProductLabel.labelCate,input.category))! : scope).orderBy(storeProductLabel.id).limit(51)).map(row=>row.id) : input.ids;
      if(ids.length>50) throw new ValidateException('批量删除最多50个标签，请缩小范围');
      return this.remove(tx,ids,actor,true);
    });
  }
  async modernList(query:URLSearchParams,actor:AdminProductLabelActor) {
    noQuery(query);
    return this.transaction(actor,false,false,async tx=>bound(await tx.select().from(storeProductLabel).where(scope)
      .orderBy(sql`sort DESC,id DESC`).limit(MAX_CATALOG_ROWS+1)));
  }
  async modernSave(body:unknown,actor:AdminProductLabelActor) {
    if(!body||typeof body!=='object'||Array.isArray(body)) throw new ValidateException('标签提交格式错误');
    const row=body as Record<string,unknown>;
    if(Object.keys(row).some(key=>!['id','labelName','color','bgColor','borderColor','icon','styleType','labelCate','sort','status','isShow'].includes(key))) throw new ValidateException('标签提交包含未知字段');
    const id=row.id===undefined?0:labelId(row.id,true);
    return this.transaction(actor,true,false,async tx=>{
      const existing=id?await this.label(tx,id,true):undefined;
      const input=parseProductLabelInput({label_cate:row.labelCate??existing?.labelCate??1,label_name:row.labelName,
        color:row.color??existing?.color??'',bg_color:row.bgColor??existing?.bgColor??'',border_color:row.borderColor??existing?.borderColor??'',
        icon:row.icon??existing?.icon??'',style_type:row.styleType??existing?.styleType??1,is_show:row.isShow??existing?.isShow??1,
        status:row.status??existing?.status??1,sort:row.sort??existing?.sort??0});
      return this.saveInTx(tx,id,input,actor);
    });
  }
}
