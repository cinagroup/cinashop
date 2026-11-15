import { reactive,computed,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiBuyerReviews,apiBuyerReviewSubmit,apiBuyerReviewImage,apiBuyerReviewCommunityRetry } from '@/api/buyerReview';
import { createBuyerReviewFlow,initialBuyerReviewFlow } from '../../../common/buyerReviewFlow';
import { buyerReviewParameters,buyerReviewQuery } from '../../../common/buyerReviewRoute';
export function useBuyerReviews(){
  const auth=useAuthStore(),state=reactive(initialBuyerReviewFlow());let disposed=false,shown=false,documentVisible=true,lastHash='',initialUnique:string|undefined,picking=false,pickerEpoch=0;
  const lottery=reactive({allowed:false});
  function hash(){
    // #ifdef H5
    if(typeof window!=='undefined')return window.location.hash;
    // #endif
    return '';
  }
  const flow=createBuyerReviewFlow<string>(state,{capture:()=>{const uid=auth.uid,token=auth.token,version=auth.sessionVersion,location=hash();return {uid,token,current:()=>shown&&documentVisible&&!disposed&&auth.uid===uid&&auth.token===token&&auth.sessionVersion===version&&hash()===location};},read:apiBuyerReviews,submit:apiBuyerReviewSubmit,retryCommunity:apiBuyerReviewCommunityRetry,upload:apiBuyerReviewImage,confirmed:ack=>{lottery.allowed=ack.toLottery;}});
  function setRoute(input:Readonly<Record<string,unknown>>){lottery.allowed=false;try{const q=buyerReviewParameters(input);flow.setOrder(q.orderId);initialUnique=q.unique;}catch(e){flow.setOrder(undefined);state.error=(e as Error).message;}}
  function readHash(){const current=hash();if(!current||current===lastHash)return;lastHash=current;const raw=current.replace(/^#/,''),split=raw.indexOf('?');if((split<0?raw:raw.slice(0,split))!=='/pages/order/reply'){shown=false;flow.setOrder(undefined);return;}try{setRoute(buyerReviewQuery(split<0?'':raw.slice(split+1)));}catch(e){flow.setOrder(undefined);state.error=(e as Error).message;}}
  async function load(){if(!shown||!documentVisible||disposed)return;await flow.load();if(initialUnique&&state.page){const line=state.page.lines.find(line=>line.unique===initialUnique);if(!line){flow.clear();state.error='评价商品与当前订单不匹配，请从订单重新进入';return;}flow.select(line.id);initialUnique=undefined;}}
  function hashChanged(){if(shown&&!disposed){readHash();void load();}}
  function clear(){pickerEpoch++;picking=false;lottery.allowed=false;flow.suspend();}
  function visibilityChanged(){
    // #ifdef H5
    if(typeof document!=='undefined'){documentVisible=document.visibilityState!=='hidden';clear();if(shown&&documentVisible&&!disposed){readHash();void load();}}
    // #endif
  }
  const stopAuth=watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();state.error='登录状态已变化，请重新读取评价';},{flush:'sync'});
  onLoad(query=>setRoute(query??{}));onShow(()=>{if(!disposed){shown=true;readHash();void load();}});onHide(()=>{shown=false;clear();});
  // #ifdef H5
  if(typeof window!=='undefined')window.addEventListener('hashchange',hashChanged);
  if(typeof document!=='undefined')document.addEventListener('visibilitychange',visibilityChanged);
  // #endif
  onUnload(()=>{disposed=true;shown=false;clear();stopAuth();
    // #ifdef H5
    if(typeof window!=='undefined')window.removeEventListener('hashchange',hashChanged);
    if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visibilityChanged);
    // #endif
  });
  function chooseImages(){if(picking||!flow.editable())return;const uid=auth.uid,token=auth.token,version=auth.sessionVersion,location=hash(),draft=flow.currentDraft(),remaining=8-(draft?.images.length??0);if(remaining<=0)return;const ticket=++pickerEpoch;picking=true;
    const current=()=>pickerEpoch===ticket&&shown&&documentVisible&&!disposed&&auth.uid===uid&&auth.token===token&&auth.sessionVersion===version&&hash()===location&&flow.currentDraft()===draft&&flow.editable();
    let terminal=false;
    try { uni.chooseImage({count:remaining,sizeType:['original','compressed'],sourceType:['album','camera'],
      success:result=>{if(terminal)return;terminal=true;if(current())void flow.upload(Array.isArray(result.tempFilePaths)?result.tempFilePaths:[result.tempFilePaths]);},
      fail:()=>{if(terminal)return;terminal=true;if(current()&&draft)draft.uploadError='未选择图片，可重新选择或继续文字评价';},
      complete:()=>{terminal=true;if(pickerEpoch===ticket)picking=false;},
    }); } catch { terminal=true;if(pickerEpoch===ticket)picking=false;if(current()&&draft)draft.uploadError='无法打开相册，可重试或继续文字评价'; }
  }
  function openLottery(){if(shown&&documentVisible&&!disposed&&lottery.allowed)uni.navigateTo({url:'/pages/activity/lottery'});}
  return {auth,state,...flow,load,line:computed(flow.selected),draft:computed(flow.currentDraft),canEdit:computed(flow.editable),canRetrySync:computed(flow.canRetryCommunity),chooseImages,lottery,openLottery};
}
