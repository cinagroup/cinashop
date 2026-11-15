import { reactive,computed,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createPublicReviewListFlow,initialPublicReviewList } from '../../../common/publicProductReviewFlow';
import { publicReviewParameters,publicReviewQuery,publicReviewListPath,publicReviewDetailPath } from '../../../common/publicProductReviewRoute';
import { apiPublicReviewList } from '@/api/publicProductReview';
export function usePublicReviewList(){
 const auth=useAuthStore(),state=reactive(initialPublicReviewList());let disposed=false,shown=false,visible=true,lastHash='',routeId=0;
 function hash(){
  // #ifdef H5
  if(typeof window!=='undefined')return window.location.hash;
  // #endif
  return '';
 }
 const capture=()=>{const uid=auth.uid,token=auth.token,version=auth.sessionVersion,location=hash();return{uid,token,current:()=>shown&&visible&&!disposed&&auth.uid===uid&&auth.token===token&&auth.sessionVersion===version&&hash()===location};};
 const flow=createPublicReviewListFlow(state,{capture,read:apiPublicReviewList});
 function setRoute(input:Readonly<Record<string,unknown>>){routeId=0;try{routeId=publicReviewParameters(input,false);flow.setProduct(routeId);}catch(e){flow.setProduct(undefined);state.error=(e as Error).message;}}
 function readHash(){const current=hash();if(!current||current===lastHash)return;lastHash=current;const raw=current.replace(/^#/,''),split=raw.indexOf('?'),path=split<0?raw:raw.slice(0,split);
  if(path!==publicReviewListPath){routeId=0;flow.setProduct(undefined);return;}
  try{const id=publicReviewQuery(split<0?'':raw.slice(split+1),false);setRoute({productId:String(id)});}catch(e){routeId=0;flow.setProduct(undefined);state.error=(e as Error).message;}
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
 function openDetail(id:number){if(shown&&visible&&!disposed&&state.items.some(item=>item.id===id))uni.navigateTo({url:publicReviewDetailPath+'?id='+id});}
 return{auth,state,...flow,load,openDetail,hasMore:computed(flow.hasMore)};
}
