import {computed,onScopeDispose,ref,watch} from 'vue';
import {onHide,onReachBottom,onShow,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createLevelRecommendationRequests,levelRecommendationImage,levelRecommendationMediaDeadline,
 MEMBER_LEVEL_RECOMMENDATION_SIZE,type LevelRecommendation,type LevelRecommendationMedia,type LevelRecommendationRequests} from '@/api/memberLevelRecommendations';

/** Independent read pagination: never invokes level detection or a cart write. */
export function useMemberLevelRecommendations(enabled:()=>boolean=()=>true){
 const auth=useAuthStore(),products=ref<LevelRecommendation[]>([]),page=ref(0),hasMore=ref(false),loading=ref(false),error=ref(''),navigating=ref(false),mediaExpired=ref(false),clock=ref(0);
 const visible=ref(false),failedMedia=ref<string[]>([]);let generation=0,navigationRevision=0,imageRevision=0,leaseRevision=0,disposed=false,scope:LevelRecommendationRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const current=()=>visible.value&&!disposed&&enabled()&&auth.isLoggedIn&&auth.uid>0;
 function clear(){generation++;navigationRevision++;imageRevision++;leaseRevision++;scope?.abort();scope=undefined;if(timer)clearTimeout(timer);timer=undefined;
  products.value=[];page.value=0;hasMore.value=false;loading.value=false;error.value='';navigating.value=false;failedMedia.value=[];mediaExpired.value=false;clock.value++;
 }
 function scheduleMedia(){if(timer)clearTimeout(timer);timer=undefined;const ticket=++leaseRevision;clock.value++;
  const deadline=levelRecommendationMediaDeadline(products.value);mediaExpired.value=deadline!==null&&deadline<=Date.now();
  if(deadline===null||deadline<=Date.now())return;
  timer=setTimeout(()=>{timer=undefined;if(current()&&ticket===leaseRevision){clock.value++;mediaExpired.value=true;}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));
 }
 async function load(append=false){
  if(!current()||loading.value||navigating.value||append&&(!hasMore.value||page.value>=10000))return;
  const ticket=++generation,nextPage=append?page.value+1:1;
  scope?.abort();const r=createLevelRecommendationRequests(()=>current()&&ticket===generation);scope=r;
  loading.value=true;error.value='';
  if(!append){imageRevision++;leaseRevision++;products.value=[];page.value=0;hasMore.value=false;failedMedia.value=[];mediaExpired.value=false;if(timer)clearTimeout(timer);timer=undefined;}
  try{const result=await r.page(nextPage);if(!r.active())return;
   if(append&&result.list.some(row=>products.value.some(previous=>previous.id===row.id)))throw Error('商品推荐分页已变化，请刷新商品推荐');
   products.value=append?[...products.value,...result.list]:result.list;page.value=nextPage;
   hasMore.value=result.list.length===MEMBER_LEVEL_RECOMMENDATION_SIZE&&nextPage<10000;scheduleMedia();
  }catch(cause){if(r.active()){error.value=cause instanceof Error?cause.message:'商品推荐加载失败';scheduleMedia();}}
  finally{if(ticket===generation)loading.value=false;r.abort();if(scope===r)scope=undefined;}
 }
 function enter(){if(current()&&!page.value&&!loading.value)void load();}
 function preview(value:LevelRecommendationMedia){void clock.value;const ticket=imageRevision,uid=auth.uid,token=auth.token,version=auth.sessionVersion,raw=value.preview;
  const src=current()&&!failedMedia.value.includes(raw)?levelRecommendationImage(value):'';
  return{src,key:`${ticket}:${raw}`,error:()=>{if(raw&&ticket===imageRevision&&current()&&uid===auth.uid&&token===auth.token&&version===auth.sessionVersion&&!failedMedia.value.includes(raw))failedMedia.value.push(raw);}};
 }
 const items=computed(()=>products.value.map(row=>({...row,image:preview(row.media),frameImage:preview(row.frame),labels:row.labels.map(label=>({...label,image:preview(label.media)}))})));
 function openProduct(id:number){if(!current()||navigating.value)return;const row=products.value.find(value=>value.id===id);if(!row)return;
  if(row.navigationExpiresAt!==null&&Date.now()>=row.navigationExpiresAt){uni.showToast({title:'活动已结束，请刷新商品推荐',icon:'none'});return;}
  if(!row.destination){uni.showToast({title:row.navigationHint,icon:'none'});return;}
  const ticket=++navigationRevision,owner=auth.sessionVersion;navigating.value=true;
  const fail=()=>{if(ticket!==navigationRevision||!current()||owner!==auth.sessionVersion)return;navigating.value=false;uni.showToast({title:'商品详情打开失败，请重试',icon:'none'});};
  try{uni.navigateTo({url:row.destination,fail});}catch{fail();}
 }
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(enter);},{flush:'sync'});
 watch(enabled,value=>{if(!value)clear();else enter();},{flush:'sync'});
 onShow(()=>{if(disposed)return;visible.value=true;clear();enter();});
 onHide(()=>{visible.value=false;clear();});
 onUnload(()=>{visible.value=false;disposed=true;clear();});
 onScopeDispose(()=>{visible.value=false;disposed=true;clear();});
 onReachBottom(()=>{if(!error.value)void load(true);});
 return{products,items,page,hasMore,loading,error,navigating,mediaExpired,visible,load,retry:()=>load(page.value>0),refresh:()=>load(),openProduct};
}
