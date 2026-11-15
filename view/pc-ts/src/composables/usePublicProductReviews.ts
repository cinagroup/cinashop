import { reactive,ref,computed,watch,onBeforeUnmount,type Ref } from 'vue';
import { useRoute } from 'vue-router';
import { captureAuthSession,getUid,isCurrentAuthSession,onAuthChange } from '@/utils/auth';
import { createPublicReviewListFlow,initialPublicReviewList,createPublicReviewDetailFlow,initialPublicReviewDetail } from '../../../common/publicProductReviewFlow';
import { apiPublicReviewList,apiPublicReviewDetail,apiPublicReviewVisit,apiPublicReviewComments,apiPublicReviewComment,apiPublicReviewPraise } from '@/api/publicProductReview';
function lifecycle(){
 const route=useRoute(),authenticated=ref(getUid()>0);let disposed=false,visible=typeof document==='undefined'||document.visibilityState!=='hidden';
 const capture=()=>{const session=captureAuthSession(),uid=getUid(),path=route.fullPath;return{uid,token:session.token??'',current:()=>!disposed&&visible&&route.fullPath===path&&getUid()===uid&&isCurrentAuthSession(session)};};
 function bind(clear:()=>void,load:()=>Promise<void>){
  const stop=onAuthChange(()=>{authenticated.value=getUid()>0;clear();});
  function changed(){visible=document.visibilityState!=='hidden';clear();if(visible&&!disposed)void load();}
  if(typeof document!=='undefined')document.addEventListener('visibilitychange',changed);
  onBeforeUnmount(()=>{disposed=true;visible=false;stop();clear();if(typeof document!=='undefined')document.removeEventListener('visibilitychange',changed);});
 }
 return{route,capture,authenticated,bind,active:()=>!disposed&&visible};
}
export function usePublicReviewList(productId:Ref<unknown>){
 const life=lifecycle(),state=reactive(initialPublicReviewList()),flow=createPublicReviewListFlow(state,{capture:life.capture,read:apiPublicReviewList});
 watch(()=>[productId.value,life.route.fullPath],()=>{flow.setProduct(productId.value);if(life.active())void flow.load();},{immediate:true,flush:'sync'});
 life.bind(flow.suspend,flow.load);return{state,...flow,hasMore:computed(flow.hasMore)};
}
export function usePublicReviewDetail(){
 const life=lifecycle(),state=reactive(initialPublicReviewDetail()),flow=createPublicReviewDetailFlow(state,{capture:life.capture,read:apiPublicReviewDetail,visit:apiPublicReviewVisit,comments:apiPublicReviewComments,comment:apiPublicReviewComment,praise:apiPublicReviewPraise});
 watch(()=>life.route.fullPath,()=>{const valid=/^\/reviews\/[1-9]\d*$/.test(life.route.path)&&Object.keys(life.route.query).length===0&&!life.route.hash;flow.setReview(valid?life.route.params.id:undefined);if(life.active())void flow.load();},{immediate:true,flush:'sync'});
 life.bind(flow.suspend,flow.load);return{state,...flow,authenticated:life.authenticated,detail:computed(()=>state.page?.detail),canWrite:computed(flow.canWrite),canFinish:computed(flow.canFinishUncertain),hasMore:computed(flow.hasMore),loginPath:computed(()=>'/login?redirect='+encodeURIComponent(life.route.fullPath))};
}
