import { expect, it } from 'vitest';
import { buyerReviewDraft, validateBuyerReviewBody, type BuyerReviewBody } from '../../view/common/buyerReview';
import { createBuyerReviewFlow, initialBuyerReviewFlow } from '../../view/common/buyerReviewFlow';
import { parseBuyerReviewCommunityRetryAck, type BuyerReviewCommunityRetry } from '../../view/common/buyerReviewCommunitySync';
import { reviewSyncRequested } from '@/services/product/ReviewCommunitySyncIntent';

const revision='a'.repeat(64),syncRevision='b'.repeat(64);
const target:BuyerReviewCommunityRetry={version:1,orderId:91,orderNo:'sync_edge_order',cartInfoId:101,unique:'sync_edge_line',replyId:501,syncRevision};
const pendingState={status:'pending' as const,postId:null,revision:syncRevision};
const receipt=()=>({...target,uid:11,communitySync:{status:'awaiting_review',postId:701,revision:syncRevision}});
it.each([{uid:22},{orderId:92},{orderNo:'other'},{cartInfoId:102},{unique:'other'},{replyId:502},{syncRevision:'c'.repeat(64)},
  {communitySync:{status:'published',postId:701,revision:'c'.repeat(64)}}])('rejects a community receipt belonging to another full identity %j',change=>{
  expect(()=>parseBuyerReviewCommunityRetryAck({...receipt(),...change},target,11)).toThrow();
});
it('accepts a community receipt only for the complete original retry identity',()=>{
  expect(parseBuyerReviewCommunityRetryAck(receipt(),target,11)).toEqual(receipt().communitySync);
});
it.each([undefined,false,0,'0'])('keeps legacy sync opt-in disabled for %s',value=>expect(reviewSyncRequested(value)).toBe(false));
it.each([null,'false',2,{},[]])('does not coerce ambiguous legacy flags %j into opt-in',value=>expect(()=>reviewSyncRequested(value)).toThrow());
it('keeps old version-1 review bodies compatible while requiring a real boolean for an explicit new opt-in',()=>{
  const draft=buyerReviewDraft(),input={...draft,version:1,orderId:91,orderNo:target.orderNo,cartInfoId:101,unique:target.unique,revision,comment:'独立评价'};
  delete input.syncToCommunity;
  expect(validateBuyerReviewBody(input).syncToCommunity).toBeUndefined();
  expect(validateBuyerReviewBody({...input,syncToCommunity:false}).syncToCommunity).toBe(false);
  expect(validateBuyerReviewBody({...input,syncToCommunity:true}).syncToCommunity).toBe(true);
  for(const value of [0,1,'0','1',null])expect(()=>validateBuyerReviewBody({...input,syncToCommunity:value})).toThrow();
});

let instance=0;
function harness(){
  const state=initialBuyerReviewFlow(),reviewWrites:BuyerReviewBody[]=[],syncWrites:BuyerReviewCommunityRetry[]=[];
  let uid=11,token='independent-sync-edge-'+ ++instance,saved=false,synced=false,live=true;
  let syncRun:()=>Promise<unknown>=async()=>{synced=true;return receipt();};
  const page=()=>({version:1,uid:11,orderId:91,orderNo:target.orderNo,paid:true,status:saved?3:2,canReview:!saved,reason:saved?'订单已完成评价':'',lines:[{
    id:101,unique:target.unique,productId:70,name:'独立评价商品',sku:'红色',price:'10.00',image:'',isGift:false,revision,canReply:!saved,reason:saved?'该商品已提交评价':'',
    review:saved?{id:501,uid:11,orderId:91,cartInfoId:101,unique:target.unique,comment:'独立评价',replyScore:3,productScore:5,serviceScore:5,logisticsScore:5,pics:[],addTime:'2026-11-14 10:00:00',visible:true,
      communitySync:synced?receipt().communitySync:pendingState}:null}]});
  const dependencies={capture:()=>{const u=uid,t=token;return {uid,token,current:()=>live&&uid===u&&token===t};},read:async()=>page(),
    submit:async(body:BuyerReviewBody)=>{reviewWrites.push(body);saved=true;return {version:1,uid:11,orderId:91,orderNo:target.orderNo,cartInfoId:101,unique:target.unique,replyId:501,completed:true,toLottery:false,communitySync:pendingState};},
    retryCommunity:async(body:BuyerReviewCommunityRetry)=>{syncWrites.push(body);return syncRun();},upload:async()=>{throw Error('This text-only flow must not upload');}};
  const flow=createBuyerReviewFlow<number>(state,dependencies);flow.setOrder(target.orderNo);
  return {state,flow,dependencies,reviewWrites,syncWrites,run(fn:typeof syncRun){syncRun=fn;},sync(){synced=true;},
    async save(){await flow.load();state.drafts[101].body.comment='独立评价';state.drafts[101].body.syncToCommunity=true;await flow.submit();},
    changeAccount(){uid=22;token='another-account';flow.clear();},hide(){live=false;flow.suspend();}};
}
it('a lost community ACK requires an authoritative read and never submits the saved review again',async()=>{
  const f=harness();await f.save();expect(f.flow.canRetryCommunity()).toBe(true);
  f.run(async()=>{f.sync();throw Error('ACK lost after community commit');});await f.flow.retryCommunity();
  expect(f.state.uncertain).toBe(true);await f.flow.retryCommunity();await f.flow.submit();
  expect(f.reviewWrites).toHaveLength(1);expect(f.syncWrites).toEqual([target]);
  await f.flow.load();expect(f.state.uncertain).toBe(false);expect(f.flow.selected()?.review?.communitySync?.status).toBe('awaiting_review');
  expect(f.flow.canRetryCommunity()).toBe(false);expect(f.reviewWrites).toHaveLength(1);
});
it('reconstructing the page during a community retry retains the in-flight guard without creating a review',async()=>{
  const f=harness();await f.save();let resolve!:(value:unknown)=>void;f.run(()=>new Promise(done=>{resolve=done;}));
  const writing=f.flow.retryCommunity();f.flow.suspend();const nextState=initialBuyerReviewFlow(),next=createBuyerReviewFlow<number>(nextState,f.dependencies);
  next.setOrder(target.orderNo);await next.load();expect(nextState.uncertain).toBe(true);await next.retryCommunity();await next.submit();
  expect(f.syncWrites).toHaveLength(1);expect(f.reviewWrites).toHaveLength(1);f.sync();resolve(receipt());await writing;
  expect(f.state.page).toBeNull();await next.load();expect(nextState.uncertain).toBe(false);expect(next.canRetryCommunity()).toBe(false);
});
it.each(['hide','changeAccount'] as const)('a late community receipt cannot refill private state after %s',async ending=>{
  const f=harness();await f.save();let resolve!:(value:unknown)=>void;f.run(()=>new Promise(done=>{resolve=done;}));
  const writing=f.flow.retryCommunity();f[ending]();resolve(receipt());await writing;
  expect(f.state.page).toBeNull();expect(f.state.message).toBe('');expect(f.state.error).toBe('');expect(f.state.syncing).toBe(false);
  expect(f.reviewWrites).toHaveLength(1);expect(f.syncWrites).toEqual([target]);
});
it('a foreign community ACK freezes retries until readback and cannot acknowledge the saved line',async()=>{
  const f=harness();await f.save();f.run(async()=>({...receipt(),cartInfoId:102}));await f.flow.retryCommunity();
  expect(f.state.uncertain).toBe(true);expect(f.state.message).toContain('不会自动再次提交');expect(f.flow.canRetryCommunity()).toBe(false);
  await f.flow.load();expect(f.flow.canRetryCommunity()).toBe(true);expect(f.reviewWrites).toHaveLength(1);expect(f.syncWrites).toHaveLength(1);
});
