import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeProductReply, systemAttachment, user } from '@/models/schema';
import { AuthException, ApiErrorCode, NotFoundException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { checkoutFingerprint } from './CheckoutConfirmation';
import { lifecycleTime, withOrderLifecycleSnapshot } from './OrderLifecycleTimeline';
import { ReplyService } from '@/services/product/ReplyService';
import { ownedBuyerReplyImage, buyerReplyImageColumns } from '@/services/product/ProductReplyMediaPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { orderDetailId } from '../../../../view/common/orderDetailIdentity';
import { parseBuyerReviewPage, validateBuyerReviewBody, type BuyerReviewPage, type BuyerReviewLine, type BuyerReviewRecord, type BuyerReviewAck } from '../../../../view/common/buyerReview';
type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
export interface BuyerReviewActor { uid:number; authVersion:string; expiresAt:number }
const invalid = (message='评价资料已变化，请重新读取') => new ValidateException(message);
const orderColumns = { id:storeOrder.id,orderId:storeOrder.orderId,uid:storeOrder.uid,paid:storeOrder.paid,status:storeOrder.status,
  pid:storeOrder.pid,supplierId:storeOrder.supplierId,storeId:storeOrder.storeId,refundStatus:storeOrder.refundStatus,isDel:storeOrder.isDel,isSystemDel:storeOrder.isSystemDel,supplierAllocationStatus:storeOrder.supplierAllocationStatus,payType:storeOrder.payType };
const cartColumns = { id:storeOrderCartInfo.id,oid:storeOrderCartInfo.oid,uid:storeOrderCartInfo.uid,unique:storeOrderCartInfo.unique,
  productId:storeOrderCartInfo.productId,type:storeOrderCartInfo.type,relationId:storeOrderCartInfo.relationId,productType:storeOrderCartInfo.productType,
  skuUnique:storeOrderCartInfo.skuUnique,cartInfo:storeOrderCartInfo.cartInfo,isGift:storeOrderCartInfo.isGift,cartNum:storeOrderCartInfo.cartNum,refundNum:storeOrderCartInfo.refundNum };
type ReadOrder = Pick<Order,keyof typeof orderColumns>;
type ReadCart = Pick<Cart,keyof typeof cartColumns>;
export const buyerReviewLineRevision = (order:ReadOrder,cart:ReadCart) => checkoutFingerprint({ order:{id:order.id,orderNo:order.orderId,uid:order.uid,paid:order.paid,status:order.status,pid:order.pid,supplierId:order.supplierId,storeId:order.storeId,
  refundStatus:order.refundStatus,isDel:order.isDel,isSystemDel:order.isSystemDel,supplierAllocationStatus:order.supplierAllocationStatus,payType:order.payType},
  cart:{id:cart.id,oid:cart.oid,uid:cart.uid,unique:cart.unique,productId:cart.productId,type:cart.type,relationId:cart.relationId,productType:cart.productType,
    skuUnique:cart.skuUnique,cartInfo:cart.cartInfo,isGift:cart.isGift,cartNum:cart.cartNum,refundNum:cart.refundNum} });
async function actorInDatabase(db:DbClient,actor:BuyerReviewActor,lock=false) {
  if (!Number.isInteger(actor.uid)||actor.uid<=0||actor.uid>2147483647||!actor.authVersion||!Number.isInteger(actor.expiresAt)||actor.expiresAt<=Math.floor(Date.now()/1000))
    throw new AuthException('登录已过期，请重新登录',ApiErrorCode.ERR_EXPIRED);
  const query=db.select({pwd:user.pwd,status:user.status,isDel:user.isDel,deleteTime:user.deleteTime}).from(user).where(eq(user.uid,actor.uid)).limit(1);
  const [row]=await (lock?query.for('share',{noWait:true}):query);
  if (!row||row.status!==1||row.isDel||row.deleteTime!==null||![md5(row.pwd),row.pwd].includes(actor.authVersion))
    throw new AuthException('登录状态已变化，请重新登录',ApiErrorCode.ERR_EXPIRED);
}
function orderReason(order:ReadOrder) {
  if (order.pid===-1||order.supplierAllocationStatus===1) return '请评价拆分后的履约订单';
  if (order.paid!==1) return '请在支付并确认收货后评价';
  if (order.status!==2) return order.status===3?'订单已完成评价':'请在确认收货后评价';
  if (![0,3].includes(order.refundStatus)) return '售后处理中的订单不能评价';
  return '';
}
async function parent(db:DbClient,order:ReadOrder,lock=false) {
  if (order.pid<=0) return;
  const query=db.select(orderColumns).from(storeOrder).where(eq(storeOrder.id,order.pid)).limit(1);
  const [root]=await(lock?query.for('share',{noWait:true}):query);
  if (!root||root.pid!==-1||root.uid!==order.uid||root.isDel||root.isSystemDel||root.paid!==order.paid||root.payType!==order.payType
    ||root.supplierId!==order.supplierId&&!(root.supplierId===0&&root.supplierAllocationStatus===2)||root.storeId!==order.storeId&&root.supplierAllocationStatus!==2) throw invalid('原支付订单关联异常，请联系商家核对');
}
async function boundedCarts(db:DbClient,id:number) {
  const [size]=await db.execute(sql`SELECT count(*)::integer AS n,coalesce(sum(octet_length(cart_info)),0)::bigint AS bytes,
    coalesce(max(octet_length(cart_info)),0)::integer AS largest FROM public.store_order_cart_info WHERE oid=${id}`);
  if (!size||Number(size.n)>200||Number(size.bytes)>2097152||Number(size.largest)>65536) throw invalid('订单商品超过完整评价读取容量');
}
async function replies(db:DbClient,order:ReadOrder,carts:ReadCart[]) {
  if (!carts.length) return [];
  const rows=await db.select({id:storeProductReply.id,uid:storeProductReply.uid,oid:storeProductReply.oid,orderCartInfoId:storeProductReply.orderCartInfoId,unique:storeProductReply.unique,
    comment:sql<string|null>`CASE WHEN octet_length(${storeProductReply.comment})<=16384 THEN ${storeProductReply.comment} ELSE NULL END`,
    pics:sql<string|null>`CASE WHEN coalesce(octet_length(${storeProductReply.pics}),0)<=20000 THEN coalesce(${storeProductReply.pics},'[]') ELSE NULL END`,
    replyScore:storeProductReply.replyScore,productScore:storeProductReply.productScore,serviceScore:storeProductReply.serviceScore,logisticsScore:storeProductReply.logisticsScore,
    addTime:storeProductReply.addTime,status:storeProductReply.status}).from(storeProductReply).where(and(eq(storeProductReply.isDel,0),or(eq(storeProductReply.oid,order.id),inArray(storeProductReply.orderCartInfoId,carts.map(c=>c.id))))).limit(201);
  if (rows.length>200||rows.some(r=>r.uid!==order.uid||r.oid!==order.id||r.comment===null||r.pics===null)) throw invalid('订单评价关联或资料异常，请联系商家核对');
  return rows;
}
function object(v:unknown):Record<string,unknown> { return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}; }
function snapshot(cart:ReadCart) {
  let data:unknown; try{data=JSON.parse(cart.cartInfo??'{}');}catch{throw invalid('订单商品快照损坏，请联系商家核对');}
  const raw=object(data),product=object(raw.product??raw.productInfo??raw),sku=object(raw.sku??product.attrInfo);
  const text=(v:unknown,max:number)=>{if(v===undefined||v===null)return '';if(typeof v!=='string'||v.length>max)throw invalid('订单商品文字超过完整读取容量');return v;};
  const price=typeof sku.price==='string'&&/^\d{1,10}\.\d{2}$/.test(sku.price)?sku.price:null;
  return {name:text(product.storeName??product.store_name,200)||`商品 #${cart.productId}`,sku:text(sku.suk,512),price,image:text(product.image,2048)};
}
function pictures(value:string) {
  let raw:unknown;try{raw=JSON.parse(value);}catch{throw invalid('历史评价图片格式异常');}
  if (!Array.isArray(raw)) return [];
  if (raw.length>9||raw.some(v=>typeof v!=='string'||v.length>2048)) throw invalid('历史评价图片超过完整读取容量');
  return raw as string[];
}
export class BuyerReviewService {
  constructor(private readonly container:Container,private readonly env:Pick<Env,'APP_KEY'>,private readonly actor:BuyerReviewActor,private readonly authorize:()=>Promise<void>){}
  private async fresh(){await this.authorize();await actorInDatabase(this.container.db,this.actor);}
  async order(reference:string):Promise<BuyerReviewPage> {
    reference=orderDetailId(reference);if(reference.length>50)throw invalid();await this.fresh();
    const result=await withOrderLifecycleSnapshot(this.container,async db=>{
      const found=await db.select(orderColumns).from(storeOrder).where(and(eq(storeOrder.orderId,reference),eq(storeOrder.uid,this.actor.uid),eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0))).limit(2);
      if(found.length!==1)throw new NotFoundException('订单不存在或不属于当前用户');const order=found[0];await parent(db,order);await boundedCarts(db,order.id);
      const carts=await db.select(cartColumns).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(storeOrderCartInfo.id).limit(201);
      if(carts.length>200||carts.some(c=>c.uid!==this.actor.uid))throw invalid('订单商品关联异常');const records=await replies(db,order,carts),reason=orderReason(order);
      const knownIds=new Set(carts.map(c=>c.id)),byCart=new Map<number,typeof records>();
      for(const cart of carts){const matches=records.filter(r=>r.orderCartInfoId!==null&&knownIds.has(r.orderCartInfoId)?r.orderCartInfoId===cart.id:r.unique===cart.unique);
        if(matches.length>1||matches.some(r=>r.unique!==cart.unique))throw invalid('商品存在多个评价关联，请联系商家核对');byCart.set(cart.id,matches);}
      const selected=[...new Map([...byCart.values()].flat().map(r=>[r.id,r])).values()],sourcePictures=new Map(selected.map(r=>[r.id,pictures(r.pics!)]));
      const pictureRefs=[...new Set([...sourcePictures.values()].flat())],pictureIds=[...new Set(pictureRefs.map(parseCanonicalAttachmentId).filter((id):id is number=>id!==null))];
      if(pictureIds.some(id=>id>2147483647))throw invalid('历史评价图片标识异常');
      const assets=pictureIds.length?await db.select(buyerReplyImageColumns).from(systemAttachment).where(inArray(systemAttachment.attId,pictureIds)):[],byAsset=new Map(assets.map(a=>[a.attId,a]));
      const allowed=pictureRefs.map(ref=>{const id=parseCanonicalAttachmentId(ref);return id===null?ref:ownedBuyerReplyImage(byAsset.get(id),this.actor.uid)?ref:'';});
      const signed=this.env.APP_KEY?await signAttachmentReferences(this.env.APP_KEY,allowed):allowed.map(ref=>parseCanonicalAttachmentId(ref)===null?ref:'');
      const byPicture=new Map(pictureRefs.map((ref,index)=>[ref,signed[index]]));
      const drafts=carts.map(cart=>({cart,data:snapshot(cart)})),images=await publicProductPictures(db,drafts.map(({cart,data})=>({image:data.image,type:cart.type===1?0:cart.type,relationId:cart.type===1?0:cart.relationId})));
      const rendered=await renderProductPictures(this.env.APP_KEY,images),lines:BuyerReviewLine[]=[];
      for(let index=0;index<drafts.length;index++){
        const {cart,data}=drafts[index],matching=byCart.get(cart.id)??[];
        if(matching.length>1||matching.some(r=>r.unique!==cart.unique))throw invalid('商品存在多个评价关联，请联系商家核对');
        let review:BuyerReviewRecord|null=null;const saved=matching[0];
        if(saved){const pics=(sourcePictures.get(saved.id)??[]).map(ref=>byPicture.get(ref)??'');
          const score=(v:number|null,max:number)=>v===null||v===0?null:v>=1&&v<=max?v:(()=>{throw invalid('历史评价评分异常');})();
          review={id:saved.id,uid:this.actor.uid,orderId:order.id,cartInfoId:cart.id,unique:cart.unique,comment:saved.comment!,replyScore:score(saved.replyScore,3),productScore:score(saved.productScore,5),serviceScore:score(saved.serviceScore,5),logisticsScore:score(saved.logisticsScore,5),pics,addTime:saved.addTime?lifecycleTime(saved.addTime,false):'',visible:saved.status===1};
        }
        const lineReason=review?'该商品已提交评价':cart.isGift?'赠品无需评价':!cart.unique?'商品评价标识缺失':reason;
        lines.push({id:cart.id,unique:cart.unique,productId:cart.productId,name:data.name,sku:data.sku,price:data.price,image:rendered[index]??'',isGift:cart.isGift===1,
          revision:await buyerReviewLineRevision(order,cart),canReply:!lineReason,reason:lineReason,review});
      }
      return parseBuyerReviewPage({version:1,uid:this.actor.uid,orderId:order.id,orderNo:order.orderId,paid:order.paid===1,status:order.status,canReview:!reason,reason,lines},reference,this.actor.uid);
    });await this.fresh();return result;
  }
  async submit(raw:unknown):Promise<BuyerReviewAck> {
    const body=validateBuyerReviewBody(raw);await this.fresh();
    const result=await new ReplyService(this.container,this.env.APP_KEY).submitReply(this.actor.uid,body,{
      prepare:async(db,order,carts)=>{if(order.id!==body.orderId||order.orderId!==body.orderNo)throw invalid();await boundedCarts(db,order.id);await replies(db,order,carts);},
      check:async(db,order,cart)=>{await actorInDatabase(db,this.actor,true);await parent(db,order,true);
        if(cart.id!==body.cartInfoId||cart.unique!==body.unique||cart.isGift!==0||await buyerReviewLineRevision(order,cart)!==body.revision)throw invalid();},
      verify:async(db,order,cart,completed)=>{await actorInDatabase(db,this.actor,true);
        const [currentOrder]=await db.select(orderColumns).from(storeOrder).where(eq(storeOrder.id,order.id)).limit(1);
        const [currentCart]=await db.select(cartColumns).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,cart.id)).limit(1);
        if(!currentOrder||!currentCart||currentOrder.status!==(completed?3:2)||await buyerReviewLineRevision({...currentOrder,status:order.status},currentCart)!==body.revision)throw invalid('评价提交后的订单凭据已变化');
        await parent(db,currentOrder,true);
      },
    });await this.fresh();return {version:1,uid:this.actor.uid,orderId:body.orderId,orderNo:body.orderNo,cartInfoId:body.cartInfoId,unique:body.unique,replyId:result.id,completed:result.completed,toLottery:result.to_lottery};
  }
}
