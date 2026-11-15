import { reactive,computed,watch,onBeforeUnmount,type Ref } from 'vue';
import { useRoute } from 'vue-router';
import { captureAuthSession,getUid,isCurrentAuthSession,onAuthChange } from '@/utils/auth';
import { apiBuyerReviews,apiBuyerReviewSubmit,apiBuyerReviewImage,apiBuyerReviewCommunityRetry } from '@/api/buyerReview';
import { createBuyerReviewFlow,initialBuyerReviewFlow } from '../../../common/buyerReviewFlow';
import type { BuyerReviewAck } from '../../../common/buyerReview';
export function useBuyerReviews(orderNo:Ref<string>,confirmed:(ack:BuyerReviewAck)=>void){
  const route=useRoute(),state=reactive(initialBuyerReviewFlow());let disposed=false,visible=document.visibilityState!=='hidden';
  const flow=createBuyerReviewFlow<File>(state,{capture:()=>{const session=captureAuthSession(),uid=getUid(),path=route.fullPath;return {uid,token:session.token??'',current:()=>!disposed&&visible&&route.fullPath===path&&getUid()===uid&&isCurrentAuthSession(session)};},read:apiBuyerReviews,submit:apiBuyerReviewSubmit,retryCommunity:apiBuyerReviewCommunityRetry,upload:apiBuyerReviewImage,confirmed});
  watch(()=>[orderNo.value,route.fullPath],()=>{flow.setOrder(orderNo.value);if(visible&&!disposed)void flow.load();},{immediate:true,flush:'sync'});
  const stopAuth=onAuthChange(()=>{flow.clear();state.error='登录状态已变化，请重新读取评价';});
  function visibilityChanged(){visible=document.visibilityState!=='hidden';flow.suspend();if(visible&&!disposed){flow.setOrder(orderNo.value);void flow.load();}}
  document.addEventListener('visibilitychange',visibilityChanged);
  onBeforeUnmount(()=>{disposed=true;visible=false;stopAuth();flow.clear();document.removeEventListener('visibilitychange',visibilityChanged);});
  return {state,...flow,line:computed(flow.selected),draft:computed(flow.currentDraft),canEdit:computed(flow.editable),canRetrySync:computed(flow.canRetryCommunity)};
}
