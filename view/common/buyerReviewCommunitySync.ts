export type BuyerReviewCommunityStatus='not_requested'|'pending'|'awaiting_review'|'published'|'unavailable';
export interface BuyerReviewCommunitySync { status:BuyerReviewCommunityStatus; postId:number|null; revision:string|null }
export interface BuyerReviewCommunityRetry { version:1; orderId:number; orderNo:string; cartInfoId:number; unique:string; replyId:number; syncRevision:string }
export function parseBuyerReviewCommunitySync(raw:unknown):BuyerReviewCommunitySync {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('社区同步状态无效，请刷新核对');
  const r=raw as Record<string,unknown>,status=r.status;
  if(typeof status!=='string'||!['not_requested','pending','awaiting_review','published','unavailable'].includes(status))throw Error('社区同步状态无效，请刷新核对');
  const postId=r.postId===null?null:typeof r.postId==='number'&&Number.isInteger(r.postId)&&r.postId>0&&r.postId<=2147483647?r.postId:undefined;
  const revision=r.revision===null?null:typeof r.revision==='string'&&/^[a-f0-9]{64}$/.test(r.revision)?r.revision:undefined;
  if(postId===undefined||revision===undefined||status==='not_requested'&&(postId!==null||revision!==null)
    ||status==='pending'&&(postId!==null||revision===null)||['awaiting_review','published'].includes(String(status))&&(postId===null||revision===null))throw Error('社区同步状态无效，请刷新核对');
  return {status:status as BuyerReviewCommunityStatus,postId,revision};
}
export function buyerReviewCommunityMessage(state:BuyerReviewCommunitySync|undefined):string {
  if(!state||state.status==='not_requested')return '';
  return state.status==='pending'?'评价已保存，社区同步暂未完成，可单独重试。':state.status==='awaiting_review'?'已同步到社区，等待审核。':state.status==='published'?'已同步到社区。':'社区内容当前不可用，请稍后刷新查看。';
}
export function validateBuyerReviewCommunityRetry(raw:unknown):BuyerReviewCommunityRetry {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('社区同步参数无效');
  const keys=['version','orderId','orderNo','cartInfoId','unique','replyId','syncRevision'];
  if(Object.keys(raw).length!==keys.length||Object.keys(raw).some(k=>!keys.includes(k)))throw Error('社区同步参数无效');
  const r=raw as Record<string,unknown>,id=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=2147483647;
  if(r.version!==1||![r.orderId,r.cartInfoId,r.replyId].every(id)||typeof r.orderNo!=='string'||!r.orderNo||r.orderNo.length>50
    ||/[\s\u0000-\u001f\u007f/?#\\]/.test(r.orderNo)||typeof r.unique!=='string'||!r.unique||r.unique.length>50||/[\u0000-\u001f\u007f]/.test(r.unique)
    ||typeof r.syncRevision!=='string'||!/^[a-f0-9]{64}$/.test(r.syncRevision))throw Error('社区同步参数无效');
  return {version:1,orderId:r.orderId as number,orderNo:r.orderNo,cartInfoId:r.cartInfoId as number,unique:r.unique,replyId:r.replyId as number,syncRevision:r.syncRevision};
}

export function parseBuyerReviewCommunityRetryAck(raw:unknown,body:BuyerReviewCommunityRetry,uid:number):BuyerReviewCommunitySync {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('社区同步回执无效，请刷新核对');
  const r=raw as Record<string,unknown>;
  if(r.uid!==uid||Object.entries(body).some(([key,value])=>r[key]!==value))throw Error('社区同步回执与当前账号或评价不一致，请刷新核对');
  const state=parseBuyerReviewCommunitySync(r.communitySync);
  if(state.status==='not_requested'||state.revision!==null&&state.revision!==body.syncRevision)throw Error('社区同步回执凭据不一致，请刷新核对');
  return state;
}
