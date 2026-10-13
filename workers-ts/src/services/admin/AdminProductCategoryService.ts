import {and,asc,eq,inArray,like,or,sql,type SQL} from 'drizzle-orm';
import {createHash,timingSafeEqual} from 'node:crypto';
import {createContainerFromDb,withTx,type Container,type DbClient} from '@/lib/di';
import {storeProductCategory,storeProduct,storeProductRelation,storeProductCate,storeProductCategoryBrand,storeCouponIssue,storeCouponTemplate,systemAdmin,systemAttachment,systemLog} from '@/models/schema';
import {ApiErrorCode,AuthException,HttpApiException,NotFoundException,ServiceUnavailableException,ValidateException} from '@/utils/errors';
import {md5} from '@/utils/jwt';
import {AdminPermissionService,hasAdminPermission,PRODUCT_CATEGORY_SELECTION_PERMISSION} from './AdminPermissionService';
import {acquireAdminAuthorityWriteBarrier} from './AdminAuthorityWriteService';
import {tryLockProductWrite} from '@/services/product/ProductAssociationService';
import {parseCanonicalAttachmentId} from '@/services/system/AttachmentService';
import {publicProductCategoryPictures,renderProductCategoryPictures} from '@/services/product/ProductCategoryAssetPolicy';
import {categoryId,categoryFlag,categoryObject,parseProductCategoryInput,parseProductCategoryQuery,productCategoryCatalogType,type ProductCategoryInput} from './AdminProductCategoryInput';
export interface AdminProductCategoryActor {id:number;authVersion:string;expiresAt:number}
type Category=typeof storeProductCategory.$inferSelect;
const owner=and(eq(storeProductCategory.type,0),eq(storeProductCategory.relationId,0)),CATEGORY_SCOPE=731703,MAX_CATEGORIES=1000,MAX_PRODUCTS=500;
const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function date(value:number){const p=Object.fromEntries(dateFormatter.formatToParts(new Date(value*1000)).map(part=>[part.type,part.value]));return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;}
function claims(actor:AdminProductCategoryActor){
  if(!Number.isSafeInteger(actor.id)||actor.id<=0||actor.id>2147483647||!/^[a-f0-9]{32}$/.test(actor.authVersion)||!Number.isSafeInteger(actor.expiresAt))throw new AuthException('请重新登录',ApiErrorCode.ERR_LOGIN);
  if(actor.expiresAt<=Math.floor(Date.now()/1000))throw new AuthException('登录已过期',ApiErrorCode.ERR_EXPIRED);
}
function noQuery(query:URLSearchParams){if(query.size)throw new ValidateException('此分类操作不接受查询参数');}
function same(left:unknown,right:unknown){return JSON.stringify(left)===JSON.stringify(right);}
function changedOutside(before:object,after:object,allowed:readonly string[]){const row=after as Record<string,unknown>;return Object.entries(before).some(([key,value])=>!allowed.includes(key)&&!same(value,row[key]));}
function revision(rows:readonly Category[]){return createHash('sha256').update(JSON.stringify([...rows].sort((a,b)=>a.id-b.id))).digest('hex');}
function chain(rows:readonly Category[],id:number):number[]{
  const byId=new Map(rows.map(row=>[row.id,row])),path:number[]=[];let cursor=id;
  while(cursor){if(path.includes(cursor)||path.length>=3)throw new ServiceUnavailableException('分类父链存在循环或超过三级，请先整理');const row=byId.get(cursor);if(!row)throw new ServiceUnavailableException('分类父级不存在或不属于平台，请先整理');path.unshift(cursor);cursor=row.pid;}
  return path;
}
function graph(rows:readonly Category[]){for(const row of rows)chain(rows,row.id);return new Map(rows.map(row=>[row.id,chain(rows,row.id)]));}
function csvReference(column:SQL,ids:readonly number[]){return sql`EXISTS(SELECT 1 FROM unnest(string_to_array(coalesce(${column},''),',')) AS token(value)
  WHERE btrim(token.value)<>'' AND CASE WHEN btrim(token.value) ~ '^[+-]?[0-9]+$'
  THEN ltrim(btrim(token.value),'+0')=ANY(ARRAY[${sql.join(ids.map(id=>sql`${String(id)}`),sql`,`)}]::text[]) ELSE true END)`;}
function selection(value:string){
  const tokens=value.trim()?value.split(',').map(value=>value.trim()).filter(Boolean):[];
  if(tokens.length>20||tokens.some(value=>!/^\+?\d+$/.test(value)))throw new HttpApiException('商品分类选集异常，请先整理',409,409);
  const ids=tokens.map(Number).filter(value=>value!==0);if(ids.some(value=>!Number.isSafeInteger(value)||value<=0||value>2147483647)||new Set(ids).size!==ids.length)throw new HttpApiException('商品分类选集异常，请先整理',409,409);return ids;
}
export class AdminProductCategoryService {
  constructor(private readonly container:Container,private readonly appKey?:string){}
  private async transaction<T>(actor:AdminProductCategoryActor,write:boolean,selected:boolean,work:(tx:DbClient)=>Promise<T>):Promise<T>{
    claims(actor);try{return await withTx(this.container,async tx=>{
      if(!write)await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql`SET LOCAL lock_timeout='2s'`);await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      if(write){await acquireAdminAuthorityWriteBarrier(tx);await tx.execute(sql`SELECT pg_advisory_xact_lock(${CATEGORY_SCOPE},0)`);}
      const adminQuery=tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1);
      const [live]=await(write?adminQuery.for('share',{noWait:true}):adminQuery);
      if(!live||live.adminType!==1||live.relationId!==0||live.status!==1||live.isDel!==0||!Number.isInteger(live.level)||live.level<0||live.level>9)throw new AuthException('管理员身份已变化',ApiErrorCode.ERR_BANNED);
      const encoder=new TextEncoder();if(!timingSafeEqual(encoder.encode(md5(live.pwd)),encoder.encode(actor.authVersion)))throw new AuthException('登录凭据已变化',ApiErrorCode.ERR_EXPIRED);
      if(live.level!==0){const {keys}=await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(live.roles,write);if(!hasAdminPermission(keys,write?'category.manage':selected?PRODUCT_CATEGORY_SELECTION_PERMISSION:'category.view'))throw new AuthException('商品分类权限已变化',ApiErrorCode.ERR_AUTH);}
      claims(actor);const result=await work(tx);claims(actor);
      if(write){const [fresh]=await tx.select().from(systemAdmin).where(eq(systemAdmin.id,actor.id)).limit(1).for('share',{noWait:true});
        if(!fresh||!same(fresh,live))throw new AuthException('管理员身份已变化',ApiErrorCode.ERR_AUTH);
        if(fresh.level!==0){const {keys}=await new AdminPermissionService(createContainerFromDb(tx)).resolveRoleAssignment(fresh.roles,true);if(!hasAdminPermission(keys,'category.manage'))throw new AuthException('商品分类权限已变化',ApiErrorCode.ERR_AUTH);}}
      return result;
    });}catch(error){let cause:unknown=error;for(let depth=0;depth<6&&cause&&typeof cause==='object';depth++){if('code'in cause){if(['55P03','40P01','40001'].includes(String(cause.code)))throw Object.assign(new HttpApiException('分类或关联商品正在更新，请刷新后重试',409,409),{cause:error});if(['42501','57014'].includes(String(cause.code)))throw Object.assign(new ServiceUnavailableException('分类操作权限配置未就绪或操作超时'),{cause:error});}cause='cause'in cause?cause.cause:null;}throw error;}
  }
  private async catalog(tx:DbClient,locked=false){
    const query=tx.select().from(storeProductCategory).where(owner).orderBy(asc(storeProductCategory.id)).limit(MAX_CATEGORIES+1),rows=await(locked?query.for('update',{noWait:true}):query);
    if(rows.length>MAX_CATEGORIES)throw new ServiceUnavailableException('平台分类超过1000项，请先整理');graph(rows);return rows;
  }
  private row(rows:readonly Category[],id:number){const row=rows.find(row=>row.id===id);if(!row)throw new NotFoundException('平台分类不存在');return row;}
  private ordered(rows:readonly Category[]){return [...rows].sort((a,b)=>b.sort-a.sort||b.id-a.id);}
  private dto(row:Category,rows:readonly Category[],stamp:string){return {id:row.id,pid:row.pid,type:row.type,relation_id:row.relationId,cate_name:row.cateName,path:row.path,level:row.level,depth:chain(rows,row.id).length-1,pic:row.pic,big_pic:row.bigPic,adv_pic:row.advPic,adv_link:row.advLink,sort:row.sort,is_show:row.isShow,add_time:date(row.addTime),revision:stamp,...(rows.some(child=>child.pid===row.id)?{children:[],loading:false,_loading:false}:{})};}
  private async previews<T extends {pic:string;big_pic:string}>(tx:DbClient,rows:T[]){return {rows,references:await publicProductCategoryPictures(tx,rows.flatMap(row=>[{image:row.pic,type:0,relationId:0},{image:row.big_pic,type:0,relationId:0}]))};}
  private async render<T extends {pic:string;big_pic:string}>(snapshot:{rows:T[];references:string[]}){const images=await renderProductCategoryPictures(this.appKey,snapshot.references);return snapshot.rows.map((row,index)=>({...row,pic_preview:images[index*2],big_pic_preview:images[index*2+1]}));}
  async list(query:URLSearchParams,actor:AdminProductCategoryActor){
    const filter=parseProductCategoryQuery(query),snapshot=await this.transaction(actor,false,false,async tx=>{const rows=await this.catalog(tx),stamp=revision(rows);if(filter.pid)this.row(rows,filter.pid);
      const matches=filter.keyword?new Set((await tx.select({id:storeProductCategory.id}).from(storeProductCategory).where(and(owner,like(storeProductCategory.cateName,`%${filter.keyword}%`)))).map(row=>row.id)):undefined;
      const selected=this.ordered(rows.filter(row=>row.pid===filter.pid&&(!filter.id||row.id===filter.id)&&(filter.show===undefined||row.isShow===filter.show)&&(!matches||matches.has(row.id)))).map(row=>this.dto(row,rows,stamp));return {...await this.previews(tx,selected),count:selected.length,revision:stamp};});
    return {list:await this.render(snapshot),count:snapshot.count,revision:snapshot.revision};
  }
  private nodes(rows:readonly Category[],pid=0,limit=2,excluded=new Set<number>()):Array<{value:number;label:string;pid:number;children?:unknown[]}>{
    return this.ordered(rows.filter(row=>row.pid===pid&&row.isShow===1&&!excluded.has(row.id)&&chain(rows,row.id).length-1<=limit)).map(row=>{const children=this.nodes(rows,row.id,limit,excluded);return {value:row.id,label:row.cateName,pid:row.pid,...(children.length?{children}:{})};});
  }
  async tree(rawType:unknown,query:URLSearchParams,actor:AdminProductCategoryActor){
    noQuery(query);const expanded=productCategoryCatalogType(rawType)>0;const snapshot=await this.transaction(actor,false,true,async tx=>{const rows=await this.catalog(tx),stamp=revision(rows),visible=rows.filter(row=>chain(rows,row.id).every(id=>this.row(rows,id).isShow===1));
      const ordered:Category[]=[];const walk=(pid:number)=>{for(const row of this.ordered(visible.filter(item=>item.pid===pid))){ordered.push(row);if(expanded)walk(row.id);}};walk(0);return this.previews(tx,ordered.map(row=>this.dto(row,rows,stamp)));});return this.render(snapshot);
  }
  async cascader(rawType:unknown,query:URLSearchParams,actor:AdminProductCategoryActor){noQuery(query);productCategoryCatalogType(rawType);return this.transaction(actor,false,true,async tx=>this.nodes(await this.catalog(tx)));}
  async form(id:number,query:URLSearchParams,actor:AdminProductCategoryActor){
    noQuery(query);id=categoryId(id,true);return this.transaction(actor,false,false,async tx=>{const rows=await this.catalog(tx),row=id?this.row(rows,id):undefined,stamp=revision(rows),excluded=new Set(rows.filter(item=>chain(rows,item.id).includes(id)).map(item=>item.id));
      const values=row?chain(rows,row.id).slice(0,-1):[],frame=(field:string,title:string,value:string)=>({type:'frame',field,title,value,props:{type:'image',maxLength:1,src:`/admin/widget.images/index?fodder=${field}`,icon:'ios-add',width:'960px',height:'505px',modal:{'footer-hide':true}}});
      const preview=await publicProductCategoryPictures(tx,[{image:row?.pic??'',type:0,relationId:0},{image:row?.bigPic??'',type:0,relationId:0}]);
      return {title:id?'编辑分类':'添加分类',action:`product/category${id?`/${id}`:''}`,method:id?'PUT':'POST',status:true,revision:stamp,preview_references:preview,rules:[
        {type:'cascader',field:'pid',title:'父级',value:values.length?values:[0],props:{type:'other',data:[{value:0,label:'顶级分类'},...this.nodes(rows,0,1,excluded)],changeOnSelect:true,filterable:true}},
        {type:'input',field:'cate_name',title:'分类名称',value:row?.cateName??'',props:{maxlength:30},validate:[{required:true,message:'请输入分类名称',trigger:'blur'}]},
        frame('pic','移动端图(180*180)',row?.pic??''),frame('big_pic','PC端大图(468*340)',row?.bigPic??''),
        {type:'inputNumber',field:'sort',title:'排序',value:row?.sort??0,props:{min:0}},
        {type:'radio',field:'is_show',title:'状态',value:row?.isShow??1,options:[{label:'显示',value:1},{label:'隐藏',value:0}]},
        ...(id?[{type:'hidden',field:'expected_revision',value:stamp}]:[]),]};
    }).then(async snapshot=>{const {preview_references,...form}=snapshot;const [pic_preview,big_pic_preview]=await renderProductCategoryPictures(this.appKey,preview_references);return {...form,pic_preview,big_pic_preview};});
  }
  private async audit(tx:DbClient,actor:AdminProductCategoryActor,operation:string,ids:number[],method:'POST'|'PUT'|'DELETE'){
    const action=JSON.stringify({operation,ids}),rows=await tx.insert(systemLog).values({adminId:actor.id,path:`product/category/${operation}`,page:'商品分类管理',method,action,type:'product_category_catalog',addTime:Math.floor(Date.now()/1000)}).returning({id:systemLog.id,adminId:systemLog.adminId,method:systemLog.method,type:systemLog.type,action:systemLog.action});
    if(rows.length!==1||rows[0].id<=0||rows[0].adminId!==actor.id||rows[0].method!==method||rows[0].type!=='product_category_catalog'||rows[0].action!==action)throw Error('分类审计回执不完整');
  }
  private async verify(tx:DbClient,expected:readonly Category[]){const rows=await this.catalog(tx);if(rows.length!==expected.length||rows.some(row=>!same(row,expected.find(item=>item.id===row.id))))throw Error('分类事务最终资料与完整回执不一致');return revision(rows);}
  private async images(tx:DbClient,input:ProductCategoryInput){const ids=[input.pic,input.bigPic].map(parseCanonicalAttachmentId).filter((id):id is number=>id!==null);if(ids.length)await tx.select().from(systemAttachment).where(inArray(systemAttachment.attId,[...new Set(ids)].sort((a,b)=>a-b))).orderBy(asc(systemAttachment.attId)).for('share',{noWait:true});
    const refs=await publicProductCategoryPictures(tx,[{image:input.pic,type:0,relationId:0},{image:input.bigPic,type:0,relationId:0}]);if(refs[0]!==input.pic||refs[1]!==input.bigPic)throw new ValidateException('分类图片不属于平台可公开素材');}
  private async moveRelations(tx:DbClient,before:readonly Category[],after:readonly Category[],affected:readonly number[]){
    const candidates=await tx.select().from(storeProduct).where(or(csvReference(sql`${storeProduct.cateId}`,affected),inArray(storeProduct.id,tx.select({id:storeProductRelation.productId}).from(storeProductRelation).where(and(eq(storeProductRelation.type,1),inArray(storeProductRelation.relationId,[...affected])))))).orderBy(asc(storeProduct.id)).limit(MAX_PRODUCTS+1);
    if(candidates.length>MAX_PRODUCTS)throw new ServiceUnavailableException('分类移动关联商品超过500项，请分批整理');
    for(const product of candidates)if(!await tryLockProductWrite(tx,product.id))throw new HttpApiException('关联商品正在更新，请刷新后重试',409,409);
    const products=candidates.length?await tx.select().from(storeProduct).where(inArray(storeProduct.id,candidates.map(row=>row.id))).orderBy(asc(storeProduct.id)).for('update',{noWait:true}):[];
    if(!same(products,candidates))throw new HttpApiException('分类关联商品已变化，请刷新后重试',409,409);
    const allIds=[...new Set(products.flatMap(row=>selection(row.cateId)))],categories=allIds.length?await tx.select().from(storeProductCategory).where(inArray(storeProductCategory.id,allIds)).orderBy(asc(storeProductCategory.id)).for('share',{noWait:true}):[];
    const relations=products.length?await tx.select().from(storeProductRelation).where(inArray(storeProductRelation.productId,products.map(row=>row.id))).orderBy(asc(storeProductRelation.id)).limit(10001).for('update',{noWait:true}):[];
    if(relations.length>10000)throw new ServiceUnavailableException('分类移动商品关系超过10000项，请先整理');
    for(const product of products){const ids=selection(product.cateId),selected=categories.filter(row=>ids.includes(row.id));if(selected.length!==ids.length||selected.some(row=>!(row.type===0&&row.relationId===0)&&!(row.type===product.type&&row.relationId===product.relationId)))throw new HttpApiException('商品分类归属异常，请先整理',409,409);
      const related=relations.filter(row=>row.type===1&&row.productId===product.id),relationIds=related.map(row=>row.relationId);if(related.length&&(new Set(relationIds).size!==relationIds.length||!same([...relationIds].sort((a,b)=>a-b),[...ids].sort((a,b)=>a-b))))throw new HttpApiException('商品分类关系与选集不一致，请先整理',409,409);
    }
    for(const relation of relations){if(relation.type!==1||!affected.includes(relation.relationId))continue;const category=this.row(after,relation.relationId);if(relation.relationPid===category.pid)continue;const [fresh]=await tx.update(storeProductRelation).set({relationPid:category.pid}).where(and(eq(storeProductRelation.id,relation.id),eq(storeProductRelation.type,1))).returning();if(!fresh||fresh.relationPid!==category.pid||changedOutside(relation,fresh,['relationPid']))throw Error('分类派生关系回执不完整');}
    const baseline={products,relations,expected:relations.map(row=>row.type===1&&affected.includes(row.relationId)?{...row,relationPid:this.row(after,row.relationId).pid}:row)};
    // before carries persisted facts; only the explicit subtree's derived parent
    // projection changes, including old PHP moves which left relationPid stale.
    if(affected.some(id=>!before.some(row=>row.id===id)))throw Error('分类移动范围回执不完整');return baseline;
  }
  private async verifyProducts(tx:DbClient,baseline:Awaited<ReturnType<AdminProductCategoryService['moveRelations']>>){
    const ids=baseline.products.map(row=>row.id);if(!ids.length)return;
    const products=await tx.select().from(storeProduct).where(inArray(storeProduct.id,ids)).orderBy(asc(storeProduct.id));
    const relations=await tx.select().from(storeProductRelation).where(inArray(storeProductRelation.productId,ids)).orderBy(asc(storeProductRelation.id)).limit(10001);
    if(!same(products,baseline.products)||!same(relations,baseline.expected))throw Error('分类移动改变了商品或关系的未授权事实');
  }
  private async saveInTx(tx:DbClient,id:number,input:ProductCategoryInput,actor:AdminProductCategoryActor,method:'POST'|'PUT'){
    const rows=await this.catalog(tx,true),current=id?this.row(rows,id):undefined;if(input.expectedRevision!==undefined&&input.expectedRevision!==revision(rows))throw new HttpApiException('分类已变化，请刷新后重试',409,409);
    if(!id&&rows.length>=MAX_CATEGORIES)throw new ServiceUnavailableException('平台分类超过完整目录容量');
    const parentId=input.pid.filter(value=>value>0).at(-1)??0,parent=parentId?this.row(rows,parentId):undefined,parentChain=parent?chain(rows,parent.id):[];
    if(input.pid.some(value=>value>0)&&!same(input.pid,parentChain))throw new ValidateException('分类父级路径与真实层级不一致');
    if(parentChain.includes(id)&&id)throw new ValidateException('不能移动到自身或下级分类');
    if(parentChain.some(id=>{const row=this.row(rows,id);return row.path!==chain(rows,id).slice(0,-1).join(',')||row.level!==chain(rows,id).length-1;}))throw new ValidateException('父级分类派生字段异常，请先编辑父级整理');
    if(rows.some(row=>row.id!==id&&row.pid===parentId&&row.cateName===input.cateName))throw new ValidateException('同一父级下分类已经存在');
    if(parentChain.length>2)throw new ValidateException('商品分类最多三级');await this.images(tx,input);
    const values={pid:parentId,cateName:input.cateName,pic:input.pic,bigPic:input.bigPic,sort:input.sort,isShow:input.isShow,level:parentChain.length,path:parentChain.join(',')};
    let saved:Category;const expected=[...rows],affected=rows.filter(row=>id&&chain(rows,row.id).includes(id));
    if(current){const [row]=await tx.update(storeProductCategory).set(values).where(and(owner,eq(storeProductCategory.id,id))).returning();if(!row||Object.entries(values).some(([key,value])=>row[key as keyof Category]!==value)||changedOutside(current,row,Object.keys(values)))throw Error('分类修改回执不完整');saved=row;expected[expected.findIndex(row=>row.id===id)]=row;
      for(const child of affected.filter(row=>row.id!==id)){const tail=chain(rows,child.id).slice(chain(rows,id).length-1),full=[...parentChain,...tail],update={level:full.length-1,path:full.slice(0,-1).join(',')};if(update.level>2)throw new ValidateException('移动后分类超过三级');const [fresh]=await tx.update(storeProductCategory).set(update).where(and(owner,eq(storeProductCategory.id,child.id))).returning();if(!fresh||fresh.level!==update.level||fresh.path!==update.path||changedOutside(child,fresh,['level','path']))throw Error('分类后代回执不完整');expected[expected.findIndex(row=>row.id===child.id)]=fresh;}
    }else{const now=Math.floor(Date.now()/1000),[row]=await tx.insert(storeProductCategory).values({...values,type:0,relationId:0,addTime:now}).returning();if(!row||row.id<=0||row.type!==0||row.relationId!==0||row.addTime!==now||row.advPic!==''||row.advLink!==''||Object.entries(values).some(([key,value])=>row[key as keyof Category]!==value))throw Error('分类新增回执不完整');saved=row;expected.push(row);}
    const baseline=current?await this.moveRelations(tx,rows,expected,affected.map(row=>row.id)):null;
    await this.audit(tx,actor,current?'update':'create',[saved.id,...affected.filter(row=>row.id!==id).map(row=>row.id)],method);const stamp=await this.verify(tx,expected);if(baseline)await this.verifyProducts(tx,baseline);return {id:saved.id,revision:stamp};
  }
  async save(id:number,body:unknown,actor:AdminProductCategoryActor){id=categoryId(id,true);const input=parseProductCategoryInput(body);return this.transaction(actor,true,false,tx=>this.saveInTx(tx,id,input,actor,id?'PUT':'POST'));}
  async modernSave(body:unknown,actor:AdminProductCategoryActor){
    const raw=categoryObject(body,['id','pid','cate_name','pic','big_pic','sort','is_show','expected_revision']),id=raw.id===undefined?0:categoryId(raw.id,true);
    return this.transaction(actor,true,false,async tx=>{const rows=await this.catalog(tx,true),current=id?this.row(rows,id):undefined,pid=raw.pid===undefined?(current?chain(rows,current.id).slice(0,-1):[]):Array.isArray(raw.pid)?raw.pid:categoryId(raw.pid,true)===0?[0]:chain(rows,categoryId(raw.pid));
      return this.saveInTx(tx,id,parseProductCategoryInput({pid,cate_name:raw.cate_name??current?.cateName,pic:raw.pic??current?.pic??'',big_pic:raw.big_pic??current?.bigPic??'',sort:raw.sort??current?.sort??0,is_show:raw.is_show??current?.isShow??1,expected_revision:raw.expected_revision}),actor,'POST');});
  }
  async modernList(query:URLSearchParams,actor:AdminProductCategoryActor){noQuery(query);return this.transaction(actor,false,false,async tx=>{const rows=await this.catalog(tx),stamp=revision(rows);return this.ordered(rows).map(row=>({...row,depth:chain(rows,row.id).length-1,revision:stamp}));});}
  async setShow(id:number,value:unknown,actor:AdminProductCategoryActor,expectedRevision?:string){
    id=categoryId(id);const show=categoryFlag(value);return this.transaction(actor,true,false,async tx=>{const rows=await this.catalog(tx,true);this.row(rows,id);if(expectedRevision!==undefined&&expectedRevision!==revision(rows))throw new HttpApiException('分类已变化，请刷新后重试',409,409);
      const ids=rows.filter(row=>row.id===id||row.pid===id).map(row=>row.id),fresh=await tx.update(storeProductCategory).set({isShow:show}).where(and(owner,inArray(storeProductCategory.id,ids))).returning();if(fresh.length!==ids.length||fresh.some(row=>row.isShow!==show||changedOutside(this.row(rows,row.id),row,['isShow'])))throw Error('分类状态回执不完整');
      await this.audit(tx,actor,'show',ids,'PUT');return {id,is_show:show,updated:ids.length,revision:await this.verify(tx,rows.map(row=>ids.includes(row.id)?{...row,isShow:show}:row))};});
  }
  async remove(id:number,actor:AdminProductCategoryActor,expectedRevision?:string){
    id=categoryId(id);return this.transaction(actor,true,false,async tx=>{const rows=await this.catalog(tx,true),current=this.row(rows,id);if(expectedRevision!==undefined&&expectedRevision!==revision(rows))throw new HttpApiException('分类已变化，请刷新后重试',409,409);
      const [child]=await tx.select({id:storeProductCategory.id}).from(storeProductCategory).where(eq(storeProductCategory.pid,id)).limit(1);if(child)throw new ValidateException('请先删除子分类');
      const checks=await Promise.all([
        tx.select({id:storeProduct.id}).from(storeProduct).where(and(eq(storeProduct.isDel,0),csvReference(sql`${storeProduct.cateId}`,[id]))).limit(1),
        tx.select({id:storeProductRelation.id}).from(storeProductRelation).where(and(eq(storeProductRelation.type,1),or(eq(storeProductRelation.relationId,id),eq(storeProductRelation.relationPid,id)))).limit(1),
        tx.select({id:storeProductCate.id}).from(storeProductCate).where(or(eq(storeProductCate.cateId,id),eq(storeProductCate.catePid,id))).limit(1),
        tx.select({id:storeProductCategoryBrand.id}).from(storeProductCategoryBrand).where(eq(storeProductCategoryBrand.cateId,id)).limit(1),
        tx.select({id:storeCouponIssue.id}).from(storeCouponIssue).where(and(eq(storeCouponIssue.couponType,1),or(eq(storeCouponIssue.legacyCategoryId,id),csvReference(sql`${storeCouponIssue.category_id}`,[id])))).limit(1),
        tx.select({id:storeCouponTemplate.id}).from(storeCouponTemplate).where(and(eq(storeCouponTemplate.scopeType,1),eq(storeCouponTemplate.categoryId,id))).limit(1),
      ]);if(checks.some(rows=>rows.length))throw new ValidateException('分类仍有商品、历史关联或优惠券引用，不能删除');
      const deleted=await tx.delete(storeProductCategory).where(and(owner,eq(storeProductCategory.id,id))).returning();if(deleted.length!==1||!same(deleted[0],current))throw Error('分类删除回执不完整');await this.audit(tx,actor,'delete',[id],'DELETE');await this.verify(tx,rows.filter(row=>row.id!==id));return null;});
  }
}
