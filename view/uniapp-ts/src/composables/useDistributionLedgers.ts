import {computed,onScopeDispose,ref,watch} from 'vue';
import {onLoad,onShow,onHide,onUnload,onReachBottom} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createDistributionLedgerRequests,ledgerAmount,ledgerReview,MAX_LEDGER_PAGE,type DistributionLedgerMode,type DistributionLedgerRow,type DistributionLedgerQuery,type DistributionLedgerRequests} from '@/api/distributionLedgers';
import {distributionDaySeconds,distributionKeyword,distributionRange,shanghaiDay,type DistributionReportPeriod} from '@/utils/distributionReportFilters';
export function useDistributionLedgers(){
 const auth=useAuthStore(),mode=ref<DistributionLedgerMode>('commission'),routeValid=ref(true),keyword=ref(''),appliedKeyword=ref(''),period=ref<DistributionReportPeriod>('all'),range=ref({start:0,stop:0}),customOpen=ref(false),startDay=ref(shanghaiDay()),stopDay=ref(shanghaiDay()),filterError=ref('');
 const rows=ref<DistributionLedgerRow[]>([]),count=ref(0),income=ref<string|null>(null),expend=ref<string|null>(null),page=ref(0),loaded=ref(false),loading=ref(false),error=ref(''),hasMore=ref(false),visible=ref(false);
 let generation=0,disposed=false,request:DistributionLedgerRequests|undefined;
 const loggedIn=computed(()=>auth.isLoggedIn&&auth.uid>0),title=computed(()=>mode.value==='commission'?'佣金记录':'提现记录');
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const current=()=>visible.value&&!disposed&&routeValid.value&&loggedIn.value&&persisted();
 function clear(){generation++;request?.abort();request=undefined;rows.value=[];count.value=0;income.value=null;expend.value=null;page.value=0;loaded.value=false;loading.value=false;error.value='';hasMore.value=false;}
 async function load(append=false){if(!current()||loading.value||append&&(!hasMore.value||page.value>=MAX_LEDGER_PAGE))return;const ticket=++generation,next=append?page.value+1:1,q:DistributionLedgerQuery={page:next,limit:20,...range.value,keyword:mode.value==='commission'?appliedKeyword.value:''};request?.abort();const scope=createDistributionLedgerRequests(()=>current()&&generation===ticket,mode.value,q);request=scope;loading.value=true;error.value='';
  if(!append){rows.value=[];count.value=0;income.value=null;expend.value=null;page.value=0;loaded.value=false;hasMore.value=false;}
  try{const data=await scope.page();if(!scope.active())return;if(append&&(data.count!==count.value||data.income!==income.value||data.expend!==expend.value||data.list.some(row=>rows.value.some(old=>old.id===row.id))||rows.value.length&&data.list.length&&data.list[0]!.id>=rows.value.at(-1)!.id))throw Error('记录已变化，请刷新后查看');
   rows.value=append?[...rows.value,...data.list]:data.list;count.value=data.count;income.value=data.income;expend.value=data.expend;page.value=next;loaded.value=true;hasMore.value=next*20<data.count&&next<MAX_LEDGER_PAGE;
  }catch(cause){if(scope.active())error.value=cause instanceof Error?cause.message:'记录读取失败，请重试';}finally{if(generation===ticket)loading.value=false;scope.abort();if(request===scope)request=undefined;}}
 function enter(){if(current()&&!page.value&&!loading.value)void load();}
 function resetFilters(){keyword.value='';appliedKeyword.value='';range.value={start:0,stop:0};period.value='all';customOpen.value=false;filterError.value='';}
 function apply(nextPeriod:DistributionReportPeriod,nextRange:{start:number;stop:number},queryKeyword=appliedKeyword.value){if(!current())return;clear();period.value=nextPeriod;range.value=nextRange;appliedKeyword.value=queryKeyword;filterError.value='';void load();}
 function search(){if(mode.value!=='commission')return;try{apply(period.value,{...range.value},distributionKeyword(keyword.value));}catch(cause){filterError.value=(cause as Error).message;}}
 function choosePeriod(value:Exclude<DistributionReportPeriod,'custom'>){if(!current())return;try{customOpen.value=false;apply(value,distributionRange(value));}catch(cause){filterError.value=(cause as Error).message;}}
 function applyCustom(){try{const start=distributionDaySeconds(startDay.value),stop=distributionDaySeconds(stopDay.value)+86399;if(start>stop)throw Error('开始日期不能晚于结束日期');customOpen.value=false;apply('custom',{start,stop});}catch(cause){filterError.value=(cause as Error).message;}}
 const appliedDates=computed(()=>({start:range.value.start?shanghaiDay(range.value.start*1000):'',stop:range.value.stop?shanghaiDay(range.value.stop*1000):''}));
 const items=computed(()=>rows.value.map(row=>({...row,amount:ledgerAmount(row),review:ledgerReview(row)})));
 onLoad((options)=>{const type=options?.type??'1';clear();resetFilters();routeValid.value=typeof type==='string'&&['1','2','4'].includes(type);mode.value=type==='4'?'withdrawal':'commission';if(routeValid.value)uni.setNavigationBarTitle({title:title.value});enter();});
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();resetFilters();void Promise.resolve().then(enter);},{flush:'sync'});
 onShow(()=>{if(disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}if(token!==auth.token||uid!==auth.uid){if(token&&uid>0)auth.setLogin(token,uid);else auth.clear();}visible.value=true;clear();enter();});
 onHide(()=>{visible.value=false;customOpen.value=false;clear();});onUnload(()=>{visible.value=false;disposed=true;clear();});onScopeDispose(()=>{visible.value=false;disposed=true;clear();});onReachBottom(()=>{if(!error.value)void load(true);});
 return{mode,routeValid,title,keyword,appliedKeyword,period,range,customOpen,startDay,stopDay,filterError,rows,items,count,income,expend,page,loaded,loading,error,hasMore,loggedIn,appliedDates,search,choosePeriod,applyCustom,load,retry:()=>load(page.value>0),refresh:()=>load(),login:()=>{if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}};
}
