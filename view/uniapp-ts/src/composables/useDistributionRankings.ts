import {computed,onScopeDispose,ref,watch} from 'vue';
import {onHide,onReachBottom,onShow,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createRankingRequests,MAX_RANKING_PAGE,rankingAvatar,rankingBefore,rankingMediaDeadline,sameRankingRow,type RankingKind,type RankingPeriod,type RankingRequests,type RankingRow} from '@/api/distributionRankings';

/** A visible page owns its period, account, pagination and avatar callbacks. */
export function useDistributionRankings(kind:RankingKind='promoter'){
 const auth=useAuthStore(),type=ref<RankingPeriod>('week'),rows=ref<RankingRow[]>([]),self=ref<RankingRow|null>(null),page=ref(0),loading=ref(false),loaded=ref(false),hasMore=ref(false),error=ref(''),visible=ref(false),mediaExpired=ref(false),clock=ref(0),failed=ref<string[]>([]);
 let generation=0,imageRevision=0,leaseRevision=0,disposed=false,requests:RankingRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const loggedIn=computed(()=>auth.isLoggedIn&&auth.uid>0);
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
 function clear(){generation++;imageRevision++;leaseRevision++;requests?.abort();requests=undefined;if(timer)clearTimeout(timer);timer=undefined;rows.value=[];self.value=null;page.value=0;loading.value=false;loaded.value=false;hasMore.value=false;error.value='';failed.value=[];mediaExpired.value=false;clock.value++;}
 function media(){if(timer)clearTimeout(timer);timer=undefined;const ticket=++leaseRevision;clock.value++;const deadline=rankingMediaDeadline([...rows.value,...(self.value?[self.value]:[])]);mediaExpired.value=deadline!==null&&deadline<=Date.now();if(deadline===null||deadline<=Date.now())return;
  timer=setTimeout(()=>{if(ticket===leaseRevision&&current()){clock.value++;mediaExpired.value=true;}},Math.max(1,Math.min(2147483647,deadline-Date.now()+1)));
 }
 async function load(append=false){
  if(!current()||loading.value||append&&(!hasMore.value||page.value>=MAX_RANKING_PAGE))return;
  const ticket=++generation,next=append?page.value+1:1,period=type.value;requests?.abort();const scope=createRankingRequests(()=>current()&&ticket===generation&&type.value===period,kind,period);requests=scope;loading.value=true;error.value='';
  if(!append){imageRevision++;leaseRevision++;rows.value=[];self.value=null;page.value=0;loaded.value=false;hasMore.value=false;failed.value=[];if(timer)clearTimeout(timer);timer=undefined;mediaExpired.value=false;}
  try{const data=await scope.page(next);if(!scope.active())return;
   if(append&&(data.list.some(row=>rows.value.some(previous=>previous.uid===row.uid))||rows.value.length&&data.list.length&&!rankingBefore(rows.value.at(-1)!,data.list[0]!)||self.value&&!sameRankingRow(self.value,data.self)))throw Error('排行榜已变化，请刷新后查看');
   rows.value=append?[...rows.value,...data.list]:data.list;self.value=data.self;page.value=next;loaded.value=true;hasMore.value=data.list.length===20&&next<MAX_RANKING_PAGE;media();
  }catch(cause){if(scope.active()){error.value=cause instanceof Error?cause.message:'排行读取失败，请重试';media();}}
  finally{if(ticket===generation)loading.value=false;scope.abort();if(requests===scope)requests=undefined;}
 }
 function enter(){if(current()&&!page.value&&!loading.value)void load();}
 function switchPeriod(value:RankingPeriod){if(!current()||value===type.value)return;clear();type.value=value;void load();}
 function preview(row:RankingRow){void clock.value;const revision=imageRevision,owner=auth.uid,version=auth.sessionVersion,token=auth.token,key=row.uid+':'+row.avatar;
  return{src:current()&&!failed.value.includes(key)?rankingAvatar(row):'',key:revision+':'+key,error:()=>{if(revision===imageRevision&&current()&&auth.uid===owner&&auth.sessionVersion===version&&auth.token===token&&!failed.value.includes(key))failed.value.push(key);}};
 }
 const items=computed(()=>rows.value.map(row=>({...row,image:preview(row)}))),mine=computed(()=>self.value?{...self.value,image:preview(self.value)}:null);
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(enter);},{flush:'sync'});
 onShow(()=>{if(disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}if(token!==auth.token||uid!==auth.uid){if(token&&uid>0)auth.setLogin(token,uid);else auth.clear();}visible.value=true;clear();enter();});
 onHide(()=>{visible.value=false;clear();});onUnload(()=>{visible.value=false;disposed=true;clear();});onScopeDispose(()=>{visible.value=false;disposed=true;clear();});onReachBottom(()=>{if(!error.value)void load(true);});
 return{kind,type,rows,self,items,mine,page,loading,loaded,hasMore,error,loggedIn,mediaExpired,load,retry:()=>load(page.value>0),refresh:()=>load(),switchPeriod,login:()=>{if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}};
}
