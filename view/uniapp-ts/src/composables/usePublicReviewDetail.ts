import { reactive,computed,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createPublicReviewDetailFlow,initialPublicReviewDetail } from '../../../common/publicProductReviewFlow';
import { publicReviewParameters,publicReviewQuery,publicReviewDetailPath } from '../../../common/publicProductReviewRoute';
import { apiPublicReviewDetail,apiPublicReviewVisit,apiPublicReviewComments,apiPublicReviewComment,apiPublicReviewPraise } from '@/api/publicProductReview';
export function usePublicReviewDetail(){
 const auth=useAuthStore(),state=reactive(initialPublicReviewDetail());let disposed=false,shown=false,visible=true,lastHash='',routeId=0;
 function hash(){
  // #ifdef H5
  if(typeof window!=='undefined')return window.location.hash;
  // #endif
  return '';
 }
 const capture=()=>{const uid=auth.uid,token=auth.token,version=auth.sessionVersion,location=hash();return{uid,token,current:()=>shown&&visible&&!disposed&&auth.uid===uid&&auth.token===token&&auth.sessionVersion===version&&hash()===location};};
 const flow=createPublicReviewDetailFlow(state,{capture,read:apiPublicReviewDetail,visit:apiPublicReviewVisit,comments:apiPublicReviewComments,comment:apiPublicReviewComment,praise:apiPublicReviewPraise});
 function setRoute(input:Readonly<Record<string,unknown>>){routeId=0;try{routeId=publicReviewParameters(input,true);flow.setReview(routeId);}catch(e){flow.setReview(undefined);state.error=(e as Error).message;}}
 function readHash(){const current=hash();if(!current||current===lastHash)return;lastHash=current;const raw=current.replace(/^#/,''),split=raw.indexOf('?'),path=split<0?raw:raw.slice(0,split);
  if(path!==publicReviewDetailPath){routeId=0;flow.setReview(undefined);return;}
  try{const id=publicReviewQuery(split<0?'':raw.slice(split+1),true);setRoute({id:String(id)});}catch(e){routeId=0;flow.setReview(undefined);state.error=(e as Error).message;}
 }
 async function load(){if(shown&&visible&&!disposed)await flow.load();}
 function hashChanged(){if(shown&&!disposed){readHash();void load();}}
 function visibilityChanged(){
  // #ifdef H5
  if(typeof document!=='undefined'){visible=document.visibilityState!=='hidden';flow.suspend();if(shown&&visible&&!disposed){readHash();void load();}}
  // #endif
 }
 const stopAuth=watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{flow.suspend();state.error='登录状态已变化，请重新读取评价';},{flush:'sync'});
 onLoad(query=>setRoute(query??{}));onShow(()=>{if(!disposed){shown=true;readHash();void load();}});onHide(()=>{shown=false;flow.suspend();});
 // #ifdef H5
 if(typeof document!=='undefined')visible=document.visibilityState!=='hidden';
 if(typeof window!=='undefined')window.addEventListener('hashchange',hashChanged);
 if(typeof document!=='undefined')document.addEventListener('visibilitychange',visibilityChanged);
 // #endif
 onUnload(()=>{disposed=true;shown=false;flow.suspend();stopAuth();
  // #ifdef H5
  if(typeof window!=='undefined')window.removeEventListener('hashchange',hashChanged);
  if(typeof document!=='undefined')document.removeEventListener('visibilitychange',visibilityChanged);
  // #endif
 });
 function login(){if(shown&&visible&&!disposed&&routeId&&!auth.isLoggedIn)uni.navigateTo({url:'/pages/auth/login'});}
 return{auth,state,...flow,load,login,detail:computed(()=>state.page?.detail),canWrite:computed(flow.canWrite),canFinish:computed(flow.canFinishUncertain),hasMore:computed(flow.hasMore)};
}
