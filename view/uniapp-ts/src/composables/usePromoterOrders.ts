import {computed,onScopeDispose,ref,watch} from 'vue';
import {onHide,onReachBottom,onShow,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createPromoterOrdersRequests,MAX_PROMOTER_ORDER_PAGE,orderAvatar,orderBefore,orderDaySeconds,orderKeyword,orderMediaDeadline,orderRange,shanghaiDay,type OrderPeriod,type PromoterOrder,type PromoterOrderMonth,type PromoterOrderQuery,type PromoterOrdersRequests} from '@/api/promoterOrders';
export function usePromoterOrders(){
 const auth=useAuthStore(),keyword=ref(''),period=ref<OrderPeriod>('all'),range=ref({start:0,stop:0}),appliedKeyword=ref(''),customOpen=ref(false),startDay=ref(shanghaiDay()),stopDay=ref(shanghaiDay()),filterError=ref('');
 const rows=ref<PromoterOrder[]>([]),months=ref<PromoterOrderMonth[]>([]),count=ref(0),sum=ref('0.00'),page=ref(0),loading=ref(false),loaded=ref(false),hasMore=ref(false),error=ref(''),visible=ref(false),mediaExpired=ref(false),clock=ref(0),failed=ref<string[]>([]);
 let generation=0,imageRevision=0,leaseRevision=0,disposed=false,requests:PromoterOrdersRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const loggedIn=computed(()=>auth.isLoggedIn&&auth.uid>0);
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
 function clear(){generation++;imageRevision++;leaseRevision++;requests?.abort();requests=undefined;if(timer)clearTimeout(timer);timer=undefined;rows.value=[];months.value=[];count.value=0;sum.value='0.00';page.value=0;loading.value=false;loaded.value=false;hasMore.value=false;error.value='';failed.value=[];mediaExpired.value=false;clock.value++;}
 function media(){if(timer)clearTimeout(timer);timer=undefined;const ticket=++leaseRevision;clock.value++;const deadline=orderMediaDeadline(rows.value);mediaExpired.value=deadline!==null&&deadline<=Date.now();if(deadline===null||deadline<=Date.now())return;timer=setTimeout(()=>{if(ticket===leaseRevision&&current()){clock.value++;mediaExpired.value=true;}},Math.max(1,Math.min(2147483647,deadline-Date.now()+1)));}
 async function load(append=false){
  if(!current()||loading.value||append&&(!hasMore.value||page.value>=MAX_PROMOTER_ORDER_PAGE))return;
  const ticket=++generation,next=append?page.value+1:1,query:PromoterOrderQuery={page:next,limit:10,...range.value,keyword:appliedKeyword.value};requests?.abort();const scope=createPromoterOrdersRequests(()=>current()&&ticket===generation,query);requests=scope;loading.value=true;error.value='';
  if(!append){imageRevision++;leaseRevision++;rows.value=[];months.value=[];count.value=0;sum.value='0.00';page.value=0;loaded.value=false;hasMore.value=false;failed.value=[];if(timer)clearTimeout(timer);timer=undefined;mediaExpired.value=false;}
  try{const data=await scope.page();if(!scope.active())return;
   if(append&&(data.count!==count.value||data.sum_brokerage!==sum.value||data.list.some(row=>rows.value.some(previous=>previous.id===row.id))||rows.value.length&&data.list.length&&!orderBefore(rows.value.at(-1)!,data.list[0]!)||data.months.some(month=>{const old=months.value.find(m=>m.month===month.month);return old&&(old.count!==month.count||old.pay_price!==month.pay_price);})))throw Error('订单已变化，请刷新后查看');
   rows.value=append?[...rows.value,...data.list]:data.list;months.value=append?[...months.value,...data.months.filter(m=>!months.value.some(old=>old.month===m.month))]:data.months;count.value=data.count;sum.value=data.sum_brokerage;page.value=next;loaded.value=true;hasMore.value=next*10<data.count&&next<MAX_PROMOTER_ORDER_PAGE;media();
  }catch(cause){if(scope.active()){error.value=cause instanceof Error?cause.message:'分销订单读取失败，请重试';media();}}
  finally{if(ticket===generation)loading.value=false;scope.abort();if(requests===scope)requests=undefined;}
 }
 function enter(){if(current()&&!page.value&&!loading.value)void load();}
 function apply(nextPeriod:OrderPeriod,nextRange:{start:number;stop:number},nextKeyword=appliedKeyword.value){if(!current())return;clear();period.value=nextPeriod;range.value=nextRange;appliedKeyword.value=nextKeyword;filterError.value='';void load();}
 function search(){try{const value=orderKeyword(keyword.value);apply(period.value,{...range.value},value);}catch(cause){filterError.value=(cause as Error).message;}}
 function choosePeriod(value:Exclude<OrderPeriod,'custom'>){if(!current())return;try{customOpen.value=false;apply(value,orderRange(value));}catch(cause){filterError.value=(cause as Error).message;}}
 function applyCustom(){try{const start=orderDaySeconds(startDay.value),stop=orderDaySeconds(stopDay.value)+86399;if(start>stop)throw Error('开始日期不能晚于结束日期');customOpen.value=false;apply('custom',{start,stop});}catch(cause){filterError.value=(cause as Error).message;}}
 function preview(row:PromoterOrder){void clock.value;const revision=imageRevision,owner=auth.uid,version=auth.sessionVersion,token=auth.token,key=row.id+':'+row.avatar;return{src:current()&&!failed.value.includes(key)&&(!mediaExpired.value||!row.avatar_source.startsWith('/api/assets/'))?orderAvatar(row):'',key:revision+':'+key,error:()=>{if(revision===imageRevision&&current()&&auth.uid===owner&&auth.sessionVersion===version&&auth.token===token&&!failed.value.includes(key))failed.value.push(key);}};}
 const appliedDates=computed(()=>({start:range.value.start?shanghaiDay(range.value.start*1000):'',stop:range.value.stop?shanghaiDay(range.value.stop*1000):''}));
 const items=computed(()=>rows.value.map(row=>({...row,image:preview(row)}))),groups=computed(()=>months.value.map(month=>({...month,rows:items.value.filter(row=>row.time_key===month.month)})));
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();keyword.value='';appliedKeyword.value='';period.value='all';range.value={start:0,stop:0};customOpen.value=false;filterError.value='';void Promise.resolve().then(enter);},{flush:'sync'});
 onShow(()=>{if(disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}if(token!==auth.token||uid!==auth.uid){if(token&&uid>0)auth.setLogin(token,uid);else auth.clear();}visible.value=true;clear();enter();});
 onHide(()=>{visible.value=false;customOpen.value=false;clear();});onUnload(()=>{visible.value=false;disposed=true;clear();});onScopeDispose(()=>{visible.value=false;disposed=true;clear();});onReachBottom(()=>{if(!error.value)void load(true);});
 return{keyword,appliedKeyword,appliedDates,period,range,customOpen,startDay,stopDay,filterError,rows,months,items,groups,count,sum,page,loading,loaded,hasMore,error,loggedIn,mediaExpired,load,search,choosePeriod,applyCustom,retry:()=>load(page.value>0),refresh:()=>load(),login:()=>{if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}};
}
