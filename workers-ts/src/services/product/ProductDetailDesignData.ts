import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { community, communityRelevance, storeDiscounts, storeDiscountsProducts, storeProduct, storeProductDescription, storeProductEnsure, storeProductRelation, systemAttachment, systemConfig,user } from '@/models/schema';
import { readProductDetailDesignSnapshot, publicProductDetailDesign } from '@/services/content/ProductDetailDesignReadService';
import { integralDescriptionAssetReferences, integralDescriptionHtml } from '@/services/activity/IntegralCatalogReadability';
import { integralDetailIds, integralDetailMoney, integralDetailSpecs, integralDetailText, integralPublicH5Origin } from '@/services/activity/IntegralProductDetailData';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId,normalizeExternalVideoUrl } from '@/services/system/AttachmentService';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { pcBannerLink } from '@/services/admin/AdminPcBannerInput';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';
import { ReplyService } from './ReplyService';
import { publicOrdinaryProductIdentitySql } from './OrdinaryProductReadData';
import { NotFoundException, ValidateException } from '@/utils/errors';
import {decimalToCents,centsToDecimal} from '@/services/order/OrderBrokerageService';

type Product = {id:number;type:number;relationId:number;ensureId:string|null;specs:string|null;recommendList:string;isPresaleProduct:number};
const owner = (p:Pick<Product,'type'|'relationId'>) => p.type === 1 ? {type:0,relationId:0} : {type:p.type,relationId:p.relationId};
const text = (value:unknown,max=255) => integralDetailText(value,max);
const bodyText = (value:unknown,max:number) => typeof value==='string'?value.slice(0,max).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,''):'';
/** Rawtext is not visible product prose. Drop complete forbidden blocks before
 * the shared allowlist strips their tags; never publish a script/style body. */
export function productDetailDescriptionHtml(value:string){
  const cleaned=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'');
  return integralDescriptionHtml(cleaned.replace(/<\s*(script|style|template|noscript|iframe|object)(?=[\s/>])[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi,''));
}
const nonnegative = (value:unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Display policy is independent of every transactional SKU/member price. */
export function detailDisplayPrice(showPrice:readonly number[], normal:string, vip:string, discount:number, levelName:string, memberEnabled:boolean) {
  const percent=Number.isFinite(discount)?Math.max(0,Math.min(100,Math.trunc(discount))):100;
  // PHP bcdiv(scale2), then bcmul(scale2): truncate both operations. This is
  // the existing getMinPrice display rule, including legitimate zero offers;
  // checkout retains its separate minimum-one-cent transactional rule.
  const levelCents=Number(BigInt(decimalToCents(normal))*BigInt(percent)/100n);
  const levelPrice = centsToDecimal(levelCents), memberPrice = memberEnabled ? integralDetailMoney(vip) ?? '0.00' : '0.00';
  const hasLevel = showPrice.includes(0) && percent < 100;
  const hasMember = showPrice.includes(1) && memberEnabled && Number(memberPrice)>0;
  const useMember = hasMember && (!hasLevel || decimalToCents(memberPrice)<=levelCents);
  return { enabled:hasLevel||hasMember, price:useMember?memberPrice:hasLevel?levelPrice:normal,
    price_type:useMember?'member' as const:hasLevel?'level' as const:'' as const,
    level_name:hasLevel?text(levelName,100):'',vip_price:useMember?memberPrice:hasLevel?levelPrice:'0.00',level_price:hasLevel?levelPrice:normal };
}
export async function readDetailDescription(tx:DbClient,id:number,type:number,product:Pick<Product,'type'|'relationId'>) {
  const rows=await tx.select({description:sql<string|null>`left(${storeProductDescription.description},200001)`}).from(storeProductDescription)
    .where(and(eq(storeProductDescription.productId,id),eq(storeProductDescription.type,type))).limit(2);
  if(rows.length>1||(rows[0]?.description?.length??0)>200000)throw new ValidateException('商品详情正文重复或超过完整读取容量');
  let description=productDetailDescriptionHtml(rows[0]?.description??'');const refs=integralDescriptionAssetReferences(description);
  if(refs.length>1000)throw new ValidateException('商品详情素材超过完整读取容量');
  const checked=await publicProductPictures(tx,refs.map(image=>({...owner(product),image})));
  const allowed=new Map(refs.map((ref,index)=>[ref,checked[index]]));
  description=description.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g,(attribute,_key:string,ref:string)=>allowed.get(ref)?attribute:'');
  return description;
}
export async function readDetailVideo(tx:DbClient,product:{type:number;relationId:number;videoOpen:number;videoLink:string}){
  if(product.videoOpen!==1||!product.videoLink)return '';
  const ref=canonicalizePublishedAttachmentReference(product.videoLink),id=parseCanonicalAttachmentId(ref);
  if(id===null){try{const safe=pcBannerLink(ref);if(safe.startsWith('/')){
    let layer=safe;for(let depth=0;depth<3;depth++){const path=new URL(layer,'https://detail.invalid').pathname;if(path.startsWith('/api/assets/'))return '';try{layer=decodeURIComponent(layer);}catch{return '';}}
    return /\.mp4(?:[?#]|$)/i.test(safe)?safe:'';
  }return normalizeExternalVideoUrl(safe);}catch{return '';}}
  const [asset]=await tx.select({type:systemAttachment.type,relationId:systemAttachment.relationId,module:systemAttachment.moduleType,file:systemAttachment.fileType,imageType:systemAttachment.imageType,name:systemAttachment.name,dir:systemAttachment.attDir,mime:systemAttachment.attType}).from(systemAttachment).where(eq(systemAttachment.attId,id)).limit(1);
  const scope=owner(product),assetType=scope.type===2?4:1,relation=scope.type===2?scope.relationId:0,prefix=scope.type===2?`attachments/supplier/${relation}/`:'attachments/admin/1/';
  return asset&&asset.type===assetType&&asset.relationId===relation&&asset.module===1&&asset.file===2&&asset.imageType===8&&asset.dir===ref&&asset.mime.trim().toLowerCase()==='video/mp4'&&asset.name.startsWith(prefix)&&/\.mp4$/i.test(asset.name)&&!asset.name.split('/').some(part=>part==='.'||part==='..')&&!/[\\\u0000-\u001f\u007f]/u.test(asset.name)?ref:'';
}
export async function renderDetailDescription(appKey:string|undefined,description:string){
  const refs=integralDescriptionAssetReferences(description),signed=await renderProductPictures(appKey,refs),map=new Map(refs.map((ref,i)=>[ref,signed[i]]));
  return description.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g,(_attribute,key:string,ref:string)=>map.get(ref)?`${key}="${map.get(ref)!.replaceAll('&','&amp;')}"`:'');
}
export async function readDetailEnsures(tx:DbClient,product:Pick<Product,'id'|'type'|'relationId'|'ensureId'>){
  const issues:string[]=[],relations=await tx.select({id:storeProductRelation.relationId}).from(storeProductRelation)
    .where(and(eq(storeProductRelation.productId,product.id),eq(storeProductRelation.type,5),eq(storeProductRelation.status,1))).limit(1001);
  if(relations.length>1000)throw new ValidateException('商品保障关联超过完整读取容量');
  const ids=[...new Set([...integralDetailIds(product.ensureId,issues,'ensure_reference_invalid'),...relations.map(row=>row.id)])];
  if(!ids.length)return [];
  const rows=await tx.select({id:storeProductEnsure.id,name:storeProductEnsure.name,image:storeProductEnsure.image,desc:sql<string>`left(${storeProductEnsure.desc},10001)`})
    .from(storeProductEnsure).where(and(inArray(storeProductEnsure.id,ids),eq(storeProductEnsure.status,1),or(and(eq(storeProductEnsure.type,0),eq(storeProductEnsure.relationId,0)),
      product.type===2?and(eq(storeProductEnsure.type,2),eq(storeProductEnsure.relationId,product.relationId)):undefined))).orderBy(desc(storeProductEnsure.sort),asc(storeProductEnsure.id)).limit(1001);
  if(rows.length>1000||rows.some(row=>row.desc.length>10000))throw new ValidateException('商品保障超过完整读取容量');
  const pictures=await publicProductPictures(tx,rows.map(row=>({...owner(product),image:row.image})));
  return rows.map((row,i)=>({id:row.id,name:text(row.name),image:pictures[i],desc:row.desc.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'')}));
}
/** Published UGC images keep their actual user/module owner. A product asset
 * signature must never grant access to another customer's upload. */
async function userPictures(tx:DbClient,rows:{image:unknown;uid:number}[]){
  const refs=rows.map(row=>{try{return seckillTimePicture(row.image);}catch{return '';}}),ids=[...new Set(refs.map(parseCanonicalAttachmentId).filter((id):id is number=>id!==null))];
  const assets=ids.length?await tx.select({id:systemAttachment.attId,type:systemAttachment.type,relationId:systemAttachment.relationId,module:systemAttachment.moduleType,file:systemAttachment.fileType,imageType:systemAttachment.imageType,name:systemAttachment.name,dir:systemAttachment.attDir,mime:systemAttachment.attType}).from(systemAttachment).where(inArray(systemAttachment.attId,ids)):[];
  const byId=new Map(assets.map(row=>[row.id,row]));
  return refs.map((ref,index)=>{const id=parseCanonicalAttachmentId(ref);if(id===null)return ref;const a=byId.get(id),uid=rows[index].uid;
    if(!a||uid<=0||a.type!==3||a.relationId!==uid||a.module!==3||a.file!==1||a.imageType!==8||a.dir!==ref||!a.name.startsWith(`attachments/user/${uid}/`)
      ||a.name.split('/').some(part=>part==='.'||part==='..')||/[\\\u0000-\u001f\u007f]/u.test(a.name))return '';
    const ext=/\.(jpe?g|png|webp|gif)$/i.exec(a.name)?.[1]?.toLowerCase(),mime=a.mime.trim().toLowerCase().replace(/^image\/jpg$/,'image/jpeg');
    return ext&&(!mime||mime===`image/${ext==='jpg'?'jpeg':ext}`)?ref:'';});
}
export async function readProductCommunity(tx:DbClient,productId:number,page=1,limit=10){
  if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100||(page-1)*limit>10000)throw new ValidateException('商品晒单分页无效');
  const [visible]=await tx.select({id:storeProduct.id}).from(storeProduct).where(and(eq(storeProduct.id,productId),publicOrdinaryProductIdentitySql())).limit(1);
  if(!visible)throw new NotFoundException('商品不存在或已下架');
  const relation=sql`EXISTS(SELECT 1 FROM ${communityRelevance} cr WHERE cr.left_id=${community.id} AND cr.right_id=${productId} AND cr.type='community_product')`;
  const eligible=and(eq(community.status,1),eq(community.isVerify,1),eq(community.isDel,0),inArray(community.contentType,[1,2]),relation,
    sql`((${community.type}=0 AND ${community.relationId}=0) OR (${community.type}=1 AND EXISTS(SELECT 1 FROM system_store cs WHERE cs.id=${community.relationId} AND cs.is_show=1 AND cs.is_del=0 AND cs.is_store=1)) OR (${community.type}=2 AND EXISTS(SELECT 1 FROM "user" cu WHERE cu.uid=${community.relationId} AND cu.status=1 AND cu.is_del=0)))`);
  const [count]=await tx.select({count:sql<number>`COUNT(*)::int`}).from(community).where(eligible);
  const rows=await tx.select({id:community.id,title:community.title,image:community.image,content:sql<string|null>`left(${community.content},2001)`,content_type:community.contentType,like_num:community.likeNum,add_time:community.addTime,ownerType:community.type,ownerId:community.relationId})
    .from(community).where(eligible).orderBy(desc(community.star),desc(community.addTime),desc(community.id)).limit(limit).offset((page-1)*limit);
  const platform=await publicProductPictures(tx,rows.map(row=>({image:row.ownerType===2?'':row.image,type:0,relationId:0}))),users=await userPictures(tx,rows.map(row=>({image:row.ownerType===2?row.image:'',uid:row.ownerId})));
  return {list:rows.map((row,i)=>({id:row.id,title:text(row.title),image:row.ownerType===2?users[i]:platform[i],content:bodyText(row.content,2000),content_type:row.content_type,like_num:nonnegative(row.like_num),add_time:nonnegative(row.add_time)})),count:Number(count?.count??0)};
}
const cardColumns={id:storeProduct.id,store_name:storeProduct.storeName,image:storeProduct.image,price:storeProduct.price,vip_price:storeProduct.vipPrice,ot_price:storeProduct.otPrice,sales:sql<number>`${storeProduct.sales}+${storeProduct.ficti}`,product_type:storeProduct.productType,type:storeProduct.type,relationId:storeProduct.relationId};
async function checkedCards(tx:DbClient,rows:Awaited<ReturnType<typeof rawCards>>){
  const refs=await publicProductPictures(tx,rows.map(row=>({...owner(row),image:row.image})));
  return rows.map((row,i)=>({id:row.id,store_name:text(row.store_name,256),image:refs[i],price:integralDetailMoney(row.price)??'0.00',vip_price:integralDetailMoney(row.vip_price)??'0.00',ot_price:integralDetailMoney(row.ot_price)??'0.00',sales:nonnegative(row.sales),product_type:row.product_type,cart_button:0}));
}
function rawCards(tx:DbClient,ids:number[],limit:number,member:boolean){return tx.select(cardColumns).from(storeProduct).where(and(publicOrdinaryProductIdentitySql(),ids.length?inArray(storeProduct.id,ids):eq(storeProduct.isGood,1),member?undefined:eq(storeProduct.isVipProduct,0))).orderBy(desc(storeProduct.sort),desc(storeProduct.id)).limit(limit);}
export async function readDetailRecommendations(tx:DbClient,product:Pick<Product,'recommendList'>,limit:number,member:boolean){
  return checkedCards(tx,await rawCards(tx,integralDetailIds(product.recommendList,[],'recommend_reference_invalid'),limit,member));
}
export async function readDetailPackages(tx:DbClient,productId:number,limit:number,member:boolean){
  const now=Math.floor(Date.now()/1000),rows=await tx.selectDistinct({id:storeDiscounts.id,title:storeDiscounts.title,image:storeDiscounts.image,type:storeDiscounts.type,is_limit:storeDiscounts.isLimit,limit_num:storeDiscounts.limitNum,sort:storeDiscounts.sort})
    .from(storeDiscounts).innerJoin(storeDiscountsProducts,eq(storeDiscountsProducts.discountId,storeDiscounts.id)).where(and(eq(storeDiscountsProducts.productId,productId),eq(storeDiscounts.status,1),eq(storeDiscounts.isDel,0),or(eq(storeDiscounts.isTime,0),and(sql`${storeDiscounts.startTime}<=${now}`,sql`${storeDiscounts.stopTime}>=${now}`)))).orderBy(desc(storeDiscounts.sort),desc(storeDiscounts.id)).limit(limit);
  const pictures=await publicProductPictures(tx,rows.map(row=>({image:row.image,type:0,relationId:0}))),result=[];
  for(let index=0;index<rows.length;index++){
    const row=rows[index],links=await tx.select({id:storeDiscountsProducts.productId}).from(storeDiscountsProducts).where(eq(storeDiscountsProducts.discountId,row.id)).orderBy(storeDiscountsProducts.id).limit(101);
    if(links.length>100)throw new ValidateException('套餐商品超过完整读取容量');
    const ids=[...new Set(links.map(link=>link.id))],products=ids.length?await checkedCards(tx,await rawCards(tx,ids,100,member)):[];
    if(products.length!==ids.length)continue;
    result.push({id:row.id,title:text(row.title),image:pictures[index],type:row.type,is_limit:row.is_limit,limit_num:row.limit_num,products});
  }return result;
}
async function readRank(tx:DbClient,id:number,uid:number){
  // The rank link opens the existing rank list, whose catalogue admission is
  // the legacy is_money_level flag. Transactional paid eligibility is separate.
  const [visitor]=uid?await tx.select({member:user.isMoneyLevel}).from(user).where(eq(user.uid,uid)).limit(1):[];
  const member=Boolean(visitor?.member);
  let rank=0,rank_type=0;
  for(const [type,order] of [[1,sql`${storeProduct.sales}+${storeProduct.ficti}`],[2,storeProduct.star],[3,storeProduct.collect]] as const){
    const rows=await tx.select({id:storeProduct.id}).from(storeProduct).where(and(publicOrdinaryProductIdentitySql(),eq(storeProduct.pid,0),member?undefined:eq(storeProduct.isVipProduct,0))).orderBy(desc(order),desc(storeProduct.sort),desc(storeProduct.id)).limit(20);
    const index=rows.findIndex(row=>row.id===id);if(index>=0&&(!rank||index+1<rank)){rank=index+1;rank_type=type;}
  }return {rank,rank_type,rank_name:rank_type===1?'销量榜':rank_type===2?'评分榜':rank_type===3?'收藏榜':''};
}
export async function readProductDetailExtras(tx:DbClient,product:Product,uid:number,member:boolean){
  const snapshot=await readProductDetailDesignSnapshot(tx),design=publicProductDetailDesign(snapshot),value=design.value;
  const description=await readDetailDescription(tx,product.id,0,product),ensure=value.showService.includes(2)?await readDetailEnsures(tx,product):[];
  const replies=new ReplyService(createContainerFromDb(tx)),stats=value.showReply?await replies.replyConfig(product.id):null;
  const reply=value.showReply?await replies.replyList(product.id,1,value.replyNum,uid):[];
  const userRefs=reply.flatMap(row=>[{image:row.avatar,uid:row.uid},...row.pics.slice(0,9).map(image=>({image,uid:row.uid}))]),safe=await userPictures(tx,userRefs);let cursor=0;
  for(const row of reply){row.avatar=safe[cursor++];row.comment=bodyText(row.comment,512);row.sku=text(row.sku,512);row.suk=row.sku;row.merchant_reply_content=bodyText(row.merchant_reply_content,1000);row.pics=row.pics.slice(0,9).map(()=>safe[cursor++]).filter(Boolean);}
  const posts=value.showCommunity?await readProductCommunity(tx,product.id,1,value.communityNum):{list:[],count:0};
  const recommend=value.showRecommend?await readDetailRecommendations(tx,product,value.recommendNum,member):[];
  const discounts_products=value.showMatch&&!product.isPresaleProduct?await readDetailPackages(tx,product.id,value.matchNum,member):[];
  const configRows=await tx.select({key:systemConfig.menuName,value:systemConfig.value}).from(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,['site_name','share_qrcode','product_poster_title','routine_contact_type']))).orderBy(desc(systemConfig.sort),desc(systemConfig.id)).limit(1001);
  if(configRows.length>1000)throw new ValidateException('商品展示配置超过完整读取容量');
  const config=(key:string)=>{const raw=configRows.find(row=>row.key===key)?.value??'';try{const parsed:unknown=JSON.parse(raw);return typeof parsed==='string'||typeof parsed==='number'?String(parsed):'';}catch{return raw;}};
  const result={product_detail_design:design,description,ensure,specs:value.showService.includes(3)?integralDetailSpecs(product.specs,[] ):[],
    ...(value.showRank?await readRank(tx,product.id,uid):{rank:0,rank_type:0,rank_name:''}),reply,replyChance:stats?.reply_chance??0,replyCount:stats?.sum_count??0,
    elegant_list:posts.list,elegant_count:posts.count,recommend,discounts_products,site_name:text(config('site_name')),share_qrcode:config('share_qrcode')==='1'?1:0,product_poster_title:text(config('product_poster_title')),routine_contact_type:/^[0-3]$/.test(config('routine_contact_type'))?Number(config('routine_contact_type')):0};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>1048576)throw new ValidateException('商品详情展示数据超过完整读取容量');return result;
}
/** Activity pages really consumed only this subset. Their historical specs
 * condition is inverted relative to ordinary goods and remains intentional. */
export async function readActivityDetailDesign(tx:DbClient,activity:{id:number;productId:number;type?:number;relationId?:number;specs?:string|null;ensureId?:string|null;image?:string;images?:string|null},activityType:1|3|6|7,uid:number){
  const [base]=await tx.select({id:storeProduct.id,type:storeProduct.type,relationId:storeProduct.relationId,ensureId:sql<string|null>`left(${storeProduct.ensureId},2001)`,specs:sql<string|null>`left(${storeProduct.specs},100001)`}).from(storeProduct).where(and(eq(storeProduct.id,activity.productId),publicOrdinaryProductIdentitySql())).limit(1);
  if(!base||(activity.type!==undefined&&activity.type!==base.type)||(activity.relationId!==undefined&&activity.relationId!==base.relationId))throw new NotFoundException('活动原商品不存在或归属异常');
  const product_detail_design=publicProductDetailDesign(await readProductDetailDesignSnapshot(tx)),design=product_detail_design.value;
  const product={...base,ensureId:activity.ensureId??base.ensureId},ensure=design.showService.includes(2)?await readDetailEnsures(tx,product):[];
  const replyService=new ReplyService(createContainerFromDb(tx)),reply=design.showReply?await replyService.replyList(base.id,1,design.replyNum,uid):[],stats=design.showReply?await replyService.replyConfig(base.id):null;
  const refs=reply.flatMap(row=>[{image:row.avatar,uid:row.uid},...row.pics.slice(0,9).map(image=>({image,uid:row.uid}))]),safe=await userPictures(tx,refs);let cursor=0;
  for(const row of reply){row.avatar=safe[cursor++];row.comment=bodyText(row.comment,512);row.merchant_reply_content=bodyText(row.merchant_reply_content,1000);row.pics=row.pics.slice(0,9).map(()=>safe[cursor++]).filter(Boolean);}
  // Presale selection uses the base product (current checkout type 6). PHP's
  // presale productDetail retained the ordinary, positive specs condition.
  const baseDescription=activityType===6||activityType===7;
  const description=await readDetailDescription(tx,baseDescription?base.id:activity.id,baseDescription?0:activityType,base);
  let gallery:unknown=[];try{gallery=activity.images?JSON.parse(activity.images):[];}catch{throw new ValidateException('活动图片JSON损坏');}
  if(!Array.isArray(gallery)||gallery.length>20||gallery.some(value=>typeof value!=='string'))throw new ValidateException('活动图片超过完整读取容量');
  const pictures=await publicProductPictures(tx,[activity.image??'',...gallery as string[]].map(image=>({...owner(base),image})));
  return {product_detail_design,ensure,specs:(activityType===6?design.showService.includes(3):!design.showService.includes(3))?integralDetailSpecs(activity.specs??base.specs,[]):[],description,image:pictures[0],images:pictures.slice(1),reply,replyChance:stats?.reply_chance??0,replyCount:stats?.sum_count??0};
}
export async function renderActivityDetailDesign(appKey:string|undefined,result:Awaited<ReturnType<typeof readActivityDetailDesign>>){
  result.description=await renderDetailDescription(appKey,result.description);const refs=[result.image,...result.images,...result.ensure.map(row=>row.image),...result.reply.flatMap(row=>[row.avatar,...row.pics])],images=await renderProductPictures(appKey,refs);let cursor=0;
  result.image=images[cursor++];result.images=result.images.map(()=>images[cursor++]);
  for(const row of result.ensure)row.image=images[cursor++];for(const row of result.reply){row.avatar=images[cursor++];row.pics=row.pics.map(()=>images[cursor++]);}return result;
}
export async function renderProductDetailExtras(env:Pick<Env,'APP_KEY'|'PUBLIC_H5_ORIGIN'>,value:Awaited<ReturnType<typeof readProductDetailExtras>>){
  value.description=await renderDetailDescription(env?.APP_KEY,value.description);
  const refs=[...value.ensure.map(row=>row.image),...value.reply.flatMap(row=>[row.avatar,...row.pics]),...value.elegant_list.map(row=>row.image),...value.recommend.map(row=>row.image),...value.discounts_products.flatMap(row=>[row.image,...row.products.map(product=>product.image)])];
  const signed=await renderProductPictures(env?.APP_KEY,refs);let cursor=0;
  for(const row of value.ensure)row.image=signed[cursor++];for(const row of value.reply){row.avatar=signed[cursor++];row.pics=row.pics.map(()=>signed[cursor++]);}
  for(const row of value.elegant_list)row.image=signed[cursor++];for(const row of value.recommend)row.image=signed[cursor++];for(const row of value.discounts_products){row.image=signed[cursor++];for(const product of row.products)product.image=signed[cursor++];}
  return {...value,site_url:integralPublicH5Origin(env?.PUBLIC_H5_ORIGIN)};
}
