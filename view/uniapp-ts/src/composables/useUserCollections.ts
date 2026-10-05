import { computed,ref,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload,onReachBottom } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createUserCenterRequests,type UserCenterRequests } from '@/api/userCenter';
import { collectionKind,parseCollectionProducts,parseCollectionVideos,userCenterMedia,userCenterDestination,openUserCenterDestination } from '@/utils/userCenter';
import { rankNavigation } from '@/api/productRank';
import type { CollectionProduct,CollectionVideo,CollectionKind } from '@/types/userCenter';

const LIMIT=20;
export function useUserCollections(){
  const auth=useAuthStore(),kind=ref<CollectionKind>('product'),products=ref<CollectionProduct[]>([]),videos=ref<CollectionVideo[]>([]),count=ref(0),page=ref(0),loading=ref(false),ready=ref(false),error=ref(''),mutationError=ref(''),removing=ref(0),playing=ref<CollectionVideo|null>(null),videoError=ref('');
  let visible=false,disposed=false,generation=0,routeValid=true,requests:UserCenterRequests|null=null;
  function current(){return visible&&!disposed;}
  function clear(){generation++;requests?.abort();requests=null;products.value=[];videos.value=[];count.value=0;page.value=0;ready.value=false;loading.value=false;error.value='';mutationError.value='';removing.value=0;playing.value=null;videoError.value='';}
  function ensure(){if(!requests) {const epoch=generation;requests=createUserCenterRequests(()=>current()&&generation===epoch);}return requests;}
  const hasMore=computed(()=>ready.value&&page.value*LIMIT<count.value),busy=computed(()=>loading.value||removing.value>0);
  async function load(reset=false){
    if(!current()||!routeValid||busy.value)return;if(reset)clear();
    if(!auth.isLoggedIn||auth.uid<1){error.value='请先登录后查看收藏';return;}
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
  async function remove(id:number){
    if(!current()||busy.value||!ready.value||error.value||mutationError.value)return;
    if(!(kind.value==='product'?products.value:videos.value).some(x=>x.id===id))return;
    const scope=ensure(),category=kind.value;removing.value=id;mutationError.value='';
    try{const result=await scope.request<unknown>('/collect/del','POST',{id:[id],category},true);if(result!==null)throw Error('取消收藏响应无效');if(!scope.active())return;
      if(category==='product')products.value=products.value.filter(x=>x.id!==id);else videos.value=videos.value.filter(x=>x.id!==id);
      if(playing.value?.id===id)playing.value=null;count.value=Math.max(0,count.value-1);uni.showToast({title:'已取消收藏',icon:'success'});
      // Removing a relation shifts later offsets. Re-read a fresh first page.
      removing.value=0;await load(true);
    }catch(e){if(scope.active())mutationError.value=`取消结果未确认，请刷新核对。${e instanceof Error?e.message:''}`;}
    finally{if(scope.active())removing.value=0;}
  }
  function openProduct(id:number){
    if(!current()||busy.value||error.value||mutationError.value)return;const row=products.value.find(x=>x.id===id);if(!row||row.is_fail||row.available===false)return;
    const navigation=rankNavigation(row,id);if(!navigation.destination||navigation.navigationExpiresAt!==null&&navigation.navigationExpiresAt<=Date.now()){error.value='商品或活动链接已变化，请刷新收藏';return;}
    const target=userCenterDestination(navigation.destination);if(target)openUserCenterDestination(target,current);
  }
  function openVideo(id:number){if(!current()||busy.value||error.value||mutationError.value)return;const row=videos.value.find(x=>x.id===id);if(!row||!row.available||row.is_fail||!userCenterMedia(row.video_url))return;videoError.value='';playing.value=row;}
  function closeVideo(){playing.value=null;videoError.value='';}
  function playbackFailed(){if(!current()||!playing.value)return;playing.value=null;videoError.value='视频暂时无法播放，请刷新收藏后重试';}
  const productCards=computed(()=>products.value.map(row=>({...row,...rankNavigation(row,row.id)})));
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();if(current())void load();},{flush:'sync'});
  onLoad(options=>{clear();try{kind.value=collectionKind(options?.active);routeValid=true;}catch(e){routeValid=false;error.value=e instanceof Error?e.message:'收藏分类参数无效';}});
  onShow(()=>{visible=true;if(routeValid)void load(true);else error.value='收藏分类参数无效';});onHide(()=>{visible=false;clear();});onUnload(()=>{disposed=true;visible=false;clear();});onReachBottom(()=>{if(hasMore.value)void load();});
  return {auth,kind,products,productCards,videos,count,page,loading,ready,error,mutationError,removing,playing,videoError,hasMore,busy,load,select,login,remove,openProduct,openVideo,closeVideo,playbackFailed};
}
