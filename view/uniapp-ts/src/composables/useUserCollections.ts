import { computed,onScopeDispose,ref,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload,onReachBottom } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createUserCenterRequests,type UserCenterRequests } from '@/api/userCenter';
import { collectionKind,parseCollectionProducts,parseCollectionVideos,userCenterMedia,userCenterDestination,openUserCenterDestination } from '@/utils/userCenter';
import { rankNavigation } from '@/api/productRank';
import { useMemberLevelRecommendations } from '@/composables/useMemberLevelRecommendations';
import type { CollectionProduct,CollectionVideo,CollectionKind } from '@/types/userCenter';

const LIMIT=20;
/** Match the existing collect/del service limit; selection contains product/video IDs, never relation rows. */
export const COLLECTION_SELECTION_LIMIT=100;
export function useUserCollections(){
  const auth=useAuthStore(),kind=ref<CollectionKind>('product'),products=ref<CollectionProduct[]>([]),videos=ref<CollectionVideo[]>([]),count=ref(0),page=ref(0),loading=ref(false),ready=ref(false),error=ref(''),mutationError=ref(''),removing=ref(0),playing=ref<CollectionVideo|null>(null),videoError=ref('');
  const managing=ref(false),selected=ref<number[]>([]),bulkDeleting=ref(false);
  let visible=false,disposed=false,generation=0,routeValid=true,requests:UserCenterRequests|null=null;
  function current(){return visible&&!disposed;}
  function ownsPage(){
    if(!current()||!auth.isLoggedIn||auth.uid<1)return false;
    try{return String(uni.getStorageSync('uni_token')||'')===auth.token&&(Number(uni.getStorageSync('uni_uid'))||0)===auth.uid;}catch{return false;}
  }
  function clear(){generation++;ready.value=false;requests?.abort();requests=null;products.value=[];videos.value=[];count.value=0;page.value=0;loading.value=false;error.value='';mutationError.value='';removing.value=0;playing.value=null;videoError.value='';managing.value=false;selected.value=[];bulkDeleting.value=false;}
  function ensure(){if(!requests){const epoch=generation;requests=createUserCenterRequests(()=>ownsPage()&&generation===epoch);}return requests;}
  const rows=computed(()=>kind.value==='product'?products.value:videos.value);
  const hasMore=computed(()=>ready.value&&page.value*LIMIT<count.value),busy=computed(()=>loading.value||removing.value>0||bulkDeleting.value);
  const selectionIds=computed(()=>rows.value.slice(0,COLLECTION_SELECTION_LIMIT).map(row=>row.id));
  const allSelected=computed(()=>selectionIds.value.length>0&&selectionIds.value.every(id=>selected.value.includes(id)));
  function canManage(){return ownsPage()&&!busy.value&&ready.value&&!error.value&&!mutationError.value;}
  async function load(reset=false){
    if(!current()||!routeValid||busy.value)return;if(reset)clear();
    if(!auth.isLoggedIn||auth.uid<1){error.value='请先登录后查看收藏';return;}
    if(!ownsPage())return;
    const scope=ensure(),next=page.value+1,category=kind.value;loading.value=true;error.value='';
    try{
      const response=await scope.request<unknown>('/collect/user','GET',{page:next,limit:LIMIT,category},true);
      const data=category==='product'?parseCollectionProducts(response):parseCollectionVideos(response,scope.owner.uid);
      if(!scope.active())return;
      if(category==='product'){
        const incoming=data.list as CollectionProduct[],ids=new Set(products.value.map(x=>x.id));if(incoming.some(x=>ids.has(x.id)))throw Error('商品收藏分页已变化，请刷新核对');products.value=[...products.value,...incoming];
      }else{
        const incoming=data.list as CollectionVideo[],ids=new Set(videos.value.map(x=>x.id));if(incoming.some(x=>ids.has(x.id)))throw Error('视频收藏分页已变化，请刷新核对');videos.value=[...videos.value,...incoming];
      }
      count.value=data.count;page.value=next;ready.value=true;
    }catch(e){if(scope.active())error.value=e instanceof Error?e.message:'收藏加载失败，请重试';}
    finally{if(scope.active())loading.value=false;}
  }
  function select(next:CollectionKind){if(!current()||busy.value||!['product','video'].includes(next)||next===kind.value)return;clear();kind.value=next;routeValid=true;void load();}
  function login(){if(current())uni.navigateTo({url:'/pages/auth/login'});}
  function toggleManage(){if(!canManage()||!rows.value.length)return;managing.value=!managing.value;selected.value=[];playing.value=null;videoError.value='';}
  function toggleSelection(id:number){
    if(!canManage()||!managing.value||!rows.value.some(row=>row.id===id))return;
    if(selected.value.includes(id))selected.value=selected.value.filter(value=>value!==id);
    else if(selected.value.length<COLLECTION_SELECTION_LIMIT)selected.value=[...selected.value,id];
    else uni.showToast({title:'一次最多选择100条收藏',icon:'none'});
  }
  function toggleAll(){
    if(!canManage()||!managing.value)return;
    selected.value=allSelected.value?[]:[...selectionIds.value];
    if(rows.value.length>COLLECTION_SELECTION_LIMIT&&selected.value.length)uni.showToast({title:'已选择前100条已加载收藏',icon:'none'});
  }
  async function cancelRows(ids:number[],bulk:boolean){
    if(!canManage()||bulk&&!managing.value)return;
    if(!ids.length){if(bulk)uni.showToast({title:'请选择要取消的收藏',icon:'none'});return;}
    if(ids.length>COLLECTION_SELECTION_LIMIT||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1||!rows.value.some(row=>row.id===id)))return;
    const scope=ensure(),category=kind.value;bulkDeleting.value=bulk;removing.value=bulk?0:ids[0]!;mutationError.value='';
    try{
      const result=await scope.request<unknown>('/collect/del','POST',{id:[...ids],category},true);
      if(result!==null)throw Error('取消收藏响应无效');if(!scope.active())return;
      // A confirmed mutation shifts offset pagination. Only a fresh read decides the remaining rows/count.
      playing.value=null;selected.value=[];managing.value=false;removing.value=0;bulkDeleting.value=false;
      uni.showToast({title:bulk?'已取消所选收藏':'已取消收藏',icon:'success'});await load(true);
    }catch(e){if(scope.active())mutationError.value=`取消结果未确认，请刷新核对。${e instanceof Error?e.message:''}`;}
    finally{if(scope.active()){removing.value=0;bulkDeleting.value=false;}}
  }
  async function remove(id:number){if(managing.value)return;await cancelRows([id],false);}
  async function removeSelected(){await cancelRows([...selected.value],true);}
  function openProduct(id:number){
    if(managing.value){toggleSelection(id);return;}
    if(!ownsPage()||busy.value||error.value||mutationError.value)return;const row=products.value.find(x=>x.id===id);if(!row||row.is_fail||row.available===false)return;
    const navigation=rankNavigation(row,id);if(!navigation.destination||navigation.navigationExpiresAt!==null&&navigation.navigationExpiresAt<=Date.now()){error.value='商品或活动链接已变化，请刷新收藏';return;}
    const target=userCenterDestination(navigation.destination);if(target)openUserCenterDestination(target,ownsPage);
  }
  function openVideo(id:number){if(managing.value){toggleSelection(id);return;}if(!ownsPage()||busy.value||error.value||mutationError.value)return;const row=videos.value.find(x=>x.id===id);if(!row||!row.available||row.is_fail||!userCenterMedia(row.video_url))return;videoError.value='';playing.value=row;}
  function closeVideo(){playing.value=null;videoError.value='';}
  function playbackFailed(){if(!current()||!playing.value)return;playing.value=null;videoError.value='视频暂时无法播放，请刷新收藏后重试';}
  const productCards=computed(()=>products.value.map(row=>({...row,...rankNavigation(row,row.id)})));
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(()=>{if(current())void load();});},{flush:'sync'});
  onLoad(options=>{clear();try{kind.value=collectionKind(options?.active);routeValid=true;}catch(e){routeValid=false;error.value=e instanceof Error?e.message:'收藏分类参数无效';}});
  onShow(()=>{
    if(disposed)return;
    let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}
    if(token!==auth.token||uid!==auth.uid){if(token&&uid>0)auth.setLogin(token,uid);else auth.clear();}
    visible=true;if(routeValid)void load(true);else error.value='收藏分类参数无效';
  });
  onHide(()=>{visible=false;clear();});onUnload(()=>{disposed=true;visible=false;clear();});onScopeDispose(()=>{disposed=true;visible=false;clear();});
  onReachBottom(()=>{if(hasMore.value&&!error.value&&!mutationError.value)void load();});
  // Reuse the existing owner-bound hot catalogue projection, metadata-authorized media,
  // exact activity targets and lifecycle fences. No level detection or mutation is called.
  const emptyForRecommendations=computed(()=>ready.value&&!loading.value&&!error.value&&!mutationError.value&&count.value===0&&!rows.value.length&&ownsPage());
  const recommendations=useMemberLevelRecommendations(()=>emptyForRecommendations.value&&ownsPage());
  return {auth,kind,products,productCards,videos,count,page,loading,ready,error,mutationError,removing,playing,videoError,hasMore,busy,load,select,login,remove,openProduct,openVideo,closeVideo,playbackFailed,
    managing,selected,allSelected,bulkDeleting,toggleManage,toggleSelection,toggleAll,removeSelected,emptyForRecommendations,recommendations};
}
