import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Container, DbClient } from '@/lib/di';
import { community, communityRelevance, communityUser, storeOrder, storeOrderCartInfo, storeProduct, storeProductReply, systemConfig } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { AdminCommunityService } from '@/services/community/AdminCommunityService';
import { actorInDatabase, type BuyerReviewActor } from '@/services/order/BuyerReviewSession';
import { validateBuyerReplyMedia, verifyBuyerReplyMedia } from './ProductReplyMediaPolicy';
import { reviewSyncDigest, reviewSyncPictures } from './ReviewCommunitySyncIntent';

import type { BuyerReviewCommunitySync } from '../../../../view/common/buyerReviewCommunitySync';
export type ReviewCommunitySyncState=BuyerReviewCommunitySync;
export interface ReviewCommunitySyncTarget { replyId:number; orderId:number; orderNo:string; cartInfoId:number; unique:string; syncRevision:string }
type Reply=typeof storeProductReply.$inferSelect;
type Post=Pick<typeof community.$inferSelect,'id'|'type'|'relationId'|'status'|'isVerify'|'isDel'>;
export const reviewCommunitySyncColumns={id:community.id,type:community.type,relationId:community.relationId,status:community.status,isVerify:community.isVerify,isDel:community.isDel};
const pending=(revision:string):ReviewCommunitySyncState=>({status:'pending',postId:null,revision});
const invalid=()=>new ValidateException('评价同步资料已变化，请刷新核对');
export function reviewCommunitySyncState(row:Pick<Reply,'uid'|'communitySyncRequested'|'communitySyncDigest'|'communitySyncPostId'>,post?:Post):ReviewCommunitySyncState {
  if(row.communitySyncRequested===0&&row.communitySyncPostId===0&&row.communitySyncDigest==='')return {status:'not_requested',postId:null,revision:null};
  if(row.communitySyncRequested!==1||!/^[a-f0-9]{64}$/.test(row.communitySyncDigest))return {status:'unavailable',postId:null,revision:null};
  if(row.communitySyncPostId===0)return pending(row.communitySyncDigest);
  if(!post||post.id!==row.communitySyncPostId||post.type!==2||post.relationId!==row.uid)return {status:'unavailable',postId:null,revision:null};
  return {status:post.isDel||post.status!==1||post.isVerify<0?'unavailable':post.isVerify===1?'published':'awaiting_review',postId:post.id,revision:row.communitySyncDigest};
}
function equal(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
/** The original review is already committed. Only this separate transaction can
 * publish or assign its one-post receipt. Every conflicting lock is NOWAIT. */
export class ReviewCommunitySyncService {
  constructor(private readonly container:Container,private readonly actor:BuyerReviewActor,private readonly authorize:()=>Promise<void>){}
  private async fresh(){await this.authorize();await actorInDatabase(this.container.db,this.actor);}
  async attempt(target:ReviewCommunitySyncTarget):Promise<ReviewCommunitySyncState> {
    await this.fresh();
    const [initial]=await this.container.db.select({id:storeProductReply.id}).from(storeProductReply)
      .innerJoin(storeOrder,eq(storeOrder.id,storeProductReply.oid)).where(and(eq(storeProductReply.id,target.replyId),eq(storeProductReply.uid,this.actor.uid),
        eq(storeProductReply.oid,target.orderId),eq(storeOrder.orderId,target.orderNo),eq(storeOrder.uid,this.actor.uid),
        eq(storeProductReply.orderCartInfoId,target.cartInfoId),eq(storeProductReply.unique,target.unique),eq(storeProductReply.communitySyncDigest,target.syncRevision))).limit(1);
    if(!initial)throw new NotFoundException('评价不存在或不属于当前用户');
    let result:ReviewCommunitySyncState;
    try {result=await this.container.db.transaction(async raw=>{
      const tx=raw as unknown as DbClient;
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql`SET LOCAL lock_timeout='250ms'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='5s'`);
      for(const key of [`post:create:${this.actor.uid}`,`profile:2:${this.actor.uid}`]) {
        const [lock]=await tx.execute(sql`SELECT pg_try_advisory_xact_lock(17349,hashtext(${key})) AS locked`);
        if(lock?.locked!==true)throw invalid();
      }
      const [row]=await tx.select().from(storeProductReply).where(and(eq(storeProductReply.id,target.replyId),eq(storeProductReply.uid,this.actor.uid))).limit(1).for('update',{noWait:true});
      if(!row||row.communitySyncDigest!==target.syncRevision||row.oid!==target.orderId||row.orderCartInfoId!==target.cartInfoId||row.unique!==target.unique)throw invalid();
      await actorInDatabase(tx,this.actor,true);
      if(row.communitySyncPostId>0){const [post]=await tx.select(reviewCommunitySyncColumns).from(community).where(eq(community.id,row.communitySyncPostId)).limit(1);return reviewCommunitySyncState(row,post);}
      if(row.communitySyncRequested!==1)return reviewCommunitySyncState(row);
      if(row.status!==1||row.isDel!==0||row.replyType!=='product'||await reviewSyncDigest(row)!==row.communitySyncDigest)throw invalid();
      const [order]=await tx.select({id:storeOrder.id,orderId:storeOrder.orderId,uid:storeOrder.uid,paid:storeOrder.paid,status:storeOrder.status,isDel:storeOrder.isDel,isSystemDel:storeOrder.isSystemDel})
        .from(storeOrder).where(eq(storeOrder.id,target.orderId)).limit(1).for('share',{noWait:true});
      const [cart]=await tx.select({id:storeOrderCartInfo.id,oid:storeOrderCartInfo.oid,uid:storeOrderCartInfo.uid,unique:storeOrderCartInfo.unique,productId:storeOrderCartInfo.productId,isGift:storeOrderCartInfo.isGift})
        .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,target.cartInfoId)).limit(1).for('share',{noWait:true});
      if(!order||order.uid!==this.actor.uid||order.orderId!==target.orderNo||order.paid!==1||![2,3].includes(order.status)||order.isDel||order.isSystemDel
        ||!cart||cart.oid!==order.id||cart.uid!==this.actor.uid||cart.unique!==row.unique||cart.productId!==row.productId||cart.isGift!==0)throw invalid();
      const [product]=await tx.select({id:storeProduct.id}).from(storeProduct).where(and(eq(storeProduct.id,row.productId),eq(storeProduct.isDel,0),eq(storeProduct.isShow,1),eq(storeProduct.isVerify,1))).limit(1).for('share',{noWait:true});
      if(!product)throw invalid();
      const pictures=reviewSyncPictures(row.pics),proof=await validateBuyerReplyMedia(tx,this.actor.uid,pictures);
      const profiles=await tx.select().from(communityUser).where(and(eq(communityUser.type,2),eq(communityUser.relationId,this.actor.uid),eq(communityUser.isDel,0))).limit(2).for('update',{noWait:true});
      if(profiles.length>1||profiles[0]&&profiles[0].status!==1)throw invalid();
      const config=await tx.select({id:systemConfig.id,value:systemConfig.value}).from(systemConfig).where(eq(systemConfig.menuName,'community_verify')).limit(2);
      if(config.length>1)throw invalid();
      let value:unknown=1;try{if(config[0])value=JSON.parse(config[0].value);}catch{/* Unknown config requires moderation. */}
      const isVerify=value===0||value==='0'||value===false?1:0;
      const created=await new AdminCommunityService({...this.container,db:tx}).saveUserPost(this.actor.uid,0,
        {contentType:1,title:'',content:row.comment,image:pictures[0]??'',sliderImage:pictures,topicIds:[],productIds:[row.productId]},isVerify);
      const [post]=await tx.select().from(community).where(eq(community.id,created.id)).limit(1);
      if(!post||post.type!==2||post.relationId!==this.actor.uid||post.contentType!==1||post.title!==''||post.content!==row.comment
        ||post.image!==(pictures[0]??'')||post.sliderImage!==JSON.stringify(pictures)||post.videoUrl!==''||post.topicId!=='[]'||post.productId!==JSON.stringify([row.productId])
        ||post.status!==1||post.isVerify!==isVerify||post.isDel!==0||post.isRecommend!==0||post.star!==1||post.sort!==0||post.refusal!==''||post.addTime<=0||post.verifyTime!==(isVerify===1?post.addTime:0)
        ||[post.likeNum,post.collectNum,post.playNum,post.commentNum,post.shareNum].some(v=>v!==0))throw invalid();
      const relations=await tx.select({leftId:communityRelevance.leftId,rightId:communityRelevance.rightId,type:communityRelevance.type}).from(communityRelevance).where(and(eq(communityRelevance.leftId,post.id),inArray(communityRelevance.type,['community_product','community_topic']))).limit(2);
      if(!equal(relations,[{leftId:post.id,rightId:row.productId,type:'community_product'}]))throw invalid();
      const updated=await tx.update(storeProductReply).set({communitySyncPostId:post.id}).where(and(eq(storeProductReply.id,row.id),eq(storeProductReply.communitySyncPostId,0))).returning();
      if(updated.length!==1||!equal({...updated[0],communitySyncPostId:0},row))throw invalid();
      const [finalReply]=await tx.select().from(storeProductReply).where(eq(storeProductReply.id,row.id)).limit(1);
      const finalRelations=await tx.select({leftId:communityRelevance.leftId,rightId:communityRelevance.rightId,type:communityRelevance.type}).from(communityRelevance).where(and(eq(communityRelevance.leftId,post.id),inArray(communityRelevance.type,['community_product','community_topic']))).limit(2);
      const [finalProduct]=await tx.select({id:storeProduct.id}).from(storeProduct).where(and(eq(storeProduct.id,row.productId),eq(storeProduct.isDel,0),eq(storeProduct.isShow,1),eq(storeProduct.isVerify,1))).limit(1);
      const [finalPost]=await tx.select().from(community).where(eq(community.id,post.id)).limit(1);
      const [finalOrder]=await tx.select({id:storeOrder.id,orderId:storeOrder.orderId,uid:storeOrder.uid,paid:storeOrder.paid,status:storeOrder.status,isDel:storeOrder.isDel,isSystemDel:storeOrder.isSystemDel}).from(storeOrder).where(eq(storeOrder.id,order.id)).limit(1);
      const [finalCart]=await tx.select({id:storeOrderCartInfo.id,oid:storeOrderCartInfo.oid,uid:storeOrderCartInfo.uid,unique:storeOrderCartInfo.unique,productId:storeOrderCartInfo.productId,isGift:storeOrderCartInfo.isGift}).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id,cart.id)).limit(1);
      const finalProfiles=await tx.select().from(communityUser).where(and(eq(communityUser.type,2),eq(communityUser.relationId,this.actor.uid),eq(communityUser.isDel,0))).limit(2);
      const [count]=await tx.select({n:sql<number>`count(*)::integer`}).from(community).where(and(eq(community.type,2),eq(community.relationId,this.actor.uid),eq(community.status,1),eq(community.isVerify,1),eq(community.isDel,0)));
      if(!equal(finalReply,{...row,communitySyncPostId:post.id})||!equal(finalRelations,relations)||!finalProduct||!equal(finalPost,post)||!equal(finalOrder,order)||!equal(finalCart,cart)||finalProfiles.length!==1||finalProfiles[0].status!==1||finalProfiles[0].communityNum!==count.n
        ||profiles[0]&&!equal({...finalProfiles[0],communityNum:profiles[0].communityNum},profiles[0]))throw invalid();
      await verifyBuyerReplyMedia(tx,proof);await actorInDatabase(tx,this.actor,true);
      const afterConfig=await tx.select({id:systemConfig.id,value:systemConfig.value}).from(systemConfig).where(eq(systemConfig.menuName,'community_verify')).limit(2);
      if(!equal(config,afterConfig))throw invalid();
      return reviewCommunitySyncState(updated[0],post);
    });}catch(e){
      const cause=e&&typeof e==='object'?'cause' in e?e.cause:e:null;
      const code=cause&&typeof cause==='object'&&'code' in cause&&typeof cause.code==='string'&&/^[A-Z0-9]{5}$/.test(cause.code)?cause.code:'SYNC_UNCONFIRMED';
      console.warn('review_community_sync_pending',{replyId:target.replyId,code});result=pending(target.syncRevision);
    }
    await this.fresh();return result;
  }
}
