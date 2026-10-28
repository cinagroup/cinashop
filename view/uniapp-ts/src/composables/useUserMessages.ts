import {computed,onScopeDispose,ref,watch} from 'vue';
import {onHide,onLoad,onPullDownRefresh,onReachBottom,onShow,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {conversationBefore,conversationImage,conversationMediaDeadline,createUserMessageRequests,MAX_MESSAGE_PAGE,messageBefore,type MessageConversation,type MessageQuery,type SystemMessageRow,type SystemMessageSummary,type UserMessageRequests} from '@/api/userMessages';

export function useUserMessages(initial:'center'|'messages'='center'){
 const auth=useAuthStore(),mode=ref<'center'|'messages'|'detail'>(initial),routeValid=ref(true),detailId=ref(0),visible=ref(false),summary=ref<SystemMessageSummary|null>(null),conversations=ref<MessageConversation[]>([]),messages=ref<SystemMessageRow[]>([]),detail=ref<SystemMessageRow|null>(null),count=ref(0),unread=ref(0),page=ref(0),pageCount=ref(0),loading=ref(false),loaded=ref(false),error=ref(''),mediaExpired=ref(false),failedImages=ref<string[]>([]),clock=ref(0);
 let generation=0,imageRevision=0,leaseRevision=0,disposed=false,request:UserMessageRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const loggedIn=computed(()=>auth.isLoggedIn&&auth.uid>0);
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const current=()=>visible.value&&!disposed&&routeValid.value&&loggedIn.value&&persisted();
 function clear(){generation++;imageRevision++;leaseRevision++;request?.abort();request=undefined;if(timer)clearTimeout(timer);timer=undefined;summary.value=null;conversations.value=[];messages.value=[];detail.value=null;count.value=0;unread.value=0;page.value=0;pageCount.value=0;loading.value=false;loaded.value=false;error.value='';mediaExpired.value=false;failedImages.value=[];clock.value++;}
 function media(){if(timer)clearTimeout(timer);timer=undefined;const revision=++leaseRevision;clock.value++;const deadline=conversationMediaDeadline(conversations.value);mediaExpired.value=deadline!==null&&deadline<=Date.now();if(deadline===null||deadline<=Date.now())return;timer=setTimeout(()=>{if(revision===leaseRevision&&current()){clock.value++;mediaExpired.value=true;}},Math.max(1,Math.min(2147483647,deadline-Date.now()+1)));}
 const hasMore=computed(()=>mode.value!=='detail'&&loaded.value&&page.value<pageCount.value&&page.value<MAX_MESSAGE_PAGE);
 async function load(append=false){
  if(!current()||loading.value||append&&!hasMore.value)return;
  if(!append)clear();const ticket=++generation,next=append?page.value+1:1,q:MessageQuery={page:next,limit:20},scope=createUserMessageRequests(()=>current()&&ticket===generation);request=scope;loading.value=true;error.value='';
  try{
   if(mode.value==='center'){
    const data=await scope.center(q);if(!scope.active())return;
    if(append&&(count.value!==data.service_count||data.service.some(r=>conversations.value.some(old=>old.id===r.id))||conversations.value.length&&data.service.length&&!conversationBefore(conversations.value.at(-1)!,data.service[0]!)))throw Error('会话列表已变化，请刷新后查看');
    conversations.value=append?[...conversations.value,...data.service]:data.service;summary.value=data.system;count.value=data.service_count;unread.value=data.system?.message_num??0;pageCount.value=data.page_count;media();
   }else if(mode.value==='messages'){
    const data=await scope.messages(q);if(!scope.active())return;
    if(append&&(count.value!==data.count||data.list.some(r=>messages.value.some(old=>old.id===r.id))||messages.value.length&&data.list.length&&!messageBefore(messages.value.at(-1)!,data.list[0]!)))throw Error('站内信列表已变化，请刷新后查看');
    messages.value=append?[...messages.value,...data.list]:data.list;count.value=data.count;unread.value=data.service_num;pageCount.value=data.page_count;
   }else{const data=await scope.detail(detailId.value);if(!scope.active())return;detail.value=data.message;unread.value=data.service_num;count.value=data.message?1:0;pageCount.value=data.message?1:0;}
   page.value=next;loaded.value=true;
  }catch(cause){if(scope.active())error.value=cause instanceof Error?cause.message:'消息读取失败，请重试';}
  finally{if(ticket===generation)loading.value=false;scope.abort();if(request===scope)request=undefined;}
 }
 function enter(){if(current()&&!loaded.value&&!loading.value)void load();}
 function openSystem(){if(current()&&summary.value)uni.navigateTo({url:'/pages/user/messageDetail'});}
 function openConversation(row:MessageConversation){if(current()&&conversations.value.some(r=>r.id===row.id&&r.to_uid===row.to_uid))uni.navigateTo({url:'/pages/user/kefu?to_uid='+row.to_uid});}
 function preview(row:MessageConversation){void clock.value;const owner={uid:auth.uid,token:auth.token,version:auth.sessionVersion},revision=imageRevision,key=row.id+':'+row.avatar;return{src:current()&&!failedImages.value.includes(key)&&(!mediaExpired.value||!row.avatar_source.startsWith('/api/assets/'))?conversationImage(row):'',key:revision+':'+key,error:()=>{if(current()&&revision===imageRevision&&owner.uid===auth.uid&&owner.token===auth.token&&owner.version===auth.sessionVersion&&!failedImages.value.includes(key))failedImages.value.push(key);}};}
 const items=computed(()=>conversations.value.map(row=>({...row,image:preview(row)})));
 onLoad(query=>{if(initial!=='messages')return;clear();if(query?.id===undefined)return;const value=query.id;if(typeof value!=='string'||! /^[1-9]\d{0,9}$/.test(value)||Number(value)>2147483647){routeValid.value=false;return;}mode.value='detail';detailId.value=Number(value);});
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(enter);},{flush:'sync'});
 onShow(()=>{if(disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}if(token!==auth.token||uid!==auth.uid){if(token&&uid>0)auth.setLogin(token,uid);else auth.clear();}visible.value=true;clear();enter();});
 onHide(()=>{visible.value=false;clear();});onUnload(()=>{visible.value=false;disposed=true;clear();});onScopeDispose(()=>{visible.value=false;disposed=true;clear();});
 onReachBottom(()=>{if(!error.value)void load(true);});onPullDownRefresh(()=>{void load().finally(()=>uni.stopPullDownRefresh());});
 return{mode,routeValid,detailId,summary,items,messages,detail,count,unread,page,pageCount,loading,loaded,error,loggedIn,hasMore,mediaExpired,load,retry:()=>load(page.value>0),refresh:()=>load(),openSystem,openConversation,login:()=>{if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}};
}
