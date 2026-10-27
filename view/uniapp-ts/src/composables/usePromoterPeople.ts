import {computed,onScopeDispose,ref,watch} from 'vue';
import {onHide,onReachBottom,onShow,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createPromoterPeopleRequests,MAX_PEOPLE_PAGE,peopleMediaDeadline,personAvatar,personBefore,type PromoterPerson,type PromoterPeopleQuery,type PromoterPeopleRequests} from '@/api/promoterPeople';
import {distributionDaySeconds,distributionKeyword,distributionRange,shanghaiDay,type DistributionReportPeriod} from '@/utils/distributionReportFilters';
export function usePromoterPeople(){
 const auth=useAuthStore(),grade=ref<0|1>(0),keyword=ref(''),period=ref<DistributionReportPeriod>('all'),range=ref({start:0,stop:0}),appliedKeyword=ref(''),customOpen=ref(false),startDay=ref(shanghaiDay()),stopDay=ref(shanghaiDay()),filterError=ref('');
 const rows=ref<PromoterPerson[]>([]),total=ref(0),totalLevel=ref(0),count=ref(0),commission=ref('0.00'),brokerageLevel=ref<number|null>(null),divisionMode=ref(false),page=ref(0),loading=ref(false),loaded=ref(false),hasMore=ref(false),error=ref(''),visible=ref(false),mediaExpired=ref(false),clock=ref(0),failed=ref<string[]>([]);
 let generation=0,imageRevision=0,leaseRevision=0,disposed=false,requests:PromoterPeopleRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const loggedIn=computed(()=>auth.isLoggedIn&&auth.uid>0),showGrades=computed(()=>loggedIn.value&&(divisionMode.value||brokerageLevel.value===2));
 function persisted(){try{return uni.getStorageSync('uni_token')===auth.token&&Number(uni.getStorageSync('uni_uid'))===auth.uid;}catch{return false;}}
 const current=()=>visible.value&&!disposed&&loggedIn.value&&persisted();
 function clear(identity=false){generation++;imageRevision++;leaseRevision++;requests?.abort();requests=undefined;if(timer)clearTimeout(timer);timer=undefined;rows.value=[];count.value=0;commission.value='0.00';page.value=0;loading.value=false;loaded.value=false;hasMore.value=false;error.value='';failed.value=[];mediaExpired.value=false;clock.value++;if(identity){total.value=0;totalLevel.value=0;brokerageLevel.value=null;divisionMode.value=false;}}
 function media(){if(timer)clearTimeout(timer);timer=undefined;const ticket=++leaseRevision;clock.value++;const deadline=peopleMediaDeadline(rows.value);mediaExpired.value=deadline!==null&&deadline<=Date.now();if(deadline===null||deadline<=Date.now())return;timer=setTimeout(()=>{if(ticket===leaseRevision&&current()){clock.value++;mediaExpired.value=true;}},Math.max(1,Math.min(2147483647,deadline-Date.now()+1)));}
 async function load(append=false){
  if(!current()||loading.value||append&&(!hasMore.value||page.value>=MAX_PEOPLE_PAGE))return;
  const ticket=++generation,next=append?page.value+1:1,query:PromoterPeopleQuery={page:next,limit:20,grade:grade.value,...range.value,keyword:appliedKeyword.value};requests?.abort();const scope=createPromoterPeopleRequests(()=>current()&&ticket===generation,query);requests=scope;loading.value=true;error.value='';
  if(!append){imageRevision++;leaseRevision++;rows.value=[];count.value=0;commission.value='0.00';page.value=0;loaded.value=false;hasMore.value=false;failed.value=[];if(timer)clearTimeout(timer);timer=undefined;mediaExpired.value=false;}
  try{const data=await scope.page();if(!scope.active())return;
   if(!data.division_mode&&data.brokerage_level!==2&&grade.value===1){clear(true);grade.value=0;void load();return;}
   if(append&&(data.total!==total.value||data.total_level!==totalLevel.value||data.filtered_count!==count.value||data.commission!==commission.value||data.brokerage_level!==brokerageLevel.value||data.division_mode!==divisionMode.value||data.list.some(row=>rows.value.some(old=>old.uid===row.uid))||rows.value.length&&data.list.length&&!personBefore(rows.value.at(-1)!,data.list[0]!)))throw Error('推广团队已变化，请刷新后查看');
   rows.value=append?[...rows.value,...data.list]:data.list;total.value=data.total;totalLevel.value=data.total_level;count.value=data.filtered_count;commission.value=data.commission;brokerageLevel.value=data.brokerage_level;divisionMode.value=data.division_mode;page.value=next;loaded.value=true;hasMore.value=next*20<data.filtered_count&&next<MAX_PEOPLE_PAGE;media();
  }catch(cause){if(scope.active()){error.value=cause instanceof Error?cause.message:'推广人读取失败，请重试';media();}}
  finally{if(ticket===generation)loading.value=false;scope.abort();if(requests===scope)requests=undefined;}
 }
 function enter(){if(current()&&!page.value&&!loading.value)void load();}
 function apply(nextPeriod:DistributionReportPeriod,nextRange:{start:number;stop:number},nextKeyword=appliedKeyword.value){if(!current())return;clear();period.value=nextPeriod;range.value=nextRange;appliedKeyword.value=nextKeyword;filterError.value='';void load();}
 function search(){try{apply(period.value,{...range.value},distributionKeyword(keyword.value));}catch(cause){filterError.value=(cause as Error).message;}}
 function choosePeriod(value:Exclude<DistributionReportPeriod,'custom'>){if(!current())return;try{customOpen.value=false;apply(value,distributionRange(value));}catch(cause){filterError.value=(cause as Error).message;}}
 function applyCustom(){try{const start=distributionDaySeconds(startDay.value),stop=distributionDaySeconds(stopDay.value)+86399;if(start>stop)throw Error('开始日期不能晚于结束日期');customOpen.value=false;apply('custom',{start,stop});}catch(cause){filterError.value=(cause as Error).message;}}
 function chooseGrade(value:0|1){if(!current()||value===grade.value||!showGrades.value)return;clear();grade.value=value;keyword.value='';appliedKeyword.value='';filterError.value='';customOpen.value=false;void load();}
 const appliedDates=computed(()=>({start:range.value.start?shanghaiDay(range.value.start*1000):'',stop:range.value.stop?shanghaiDay(range.value.stop*1000):''}));
 function preview(row:PromoterPerson){void clock.value;const revision=imageRevision,owner=auth.uid,version=auth.sessionVersion,token=auth.token,key=row.uid+':'+row.avatar;return{src:current()&&!failed.value.includes(key)&&(!mediaExpired.value||!row.avatar_source.startsWith('/api/assets/'))?personAvatar(row):'',key:revision+':'+key,error:()=>{if(revision===imageRevision&&current()&&auth.uid===owner&&auth.sessionVersion===version&&auth.token===token&&!failed.value.includes(key))failed.value.push(key);}};}
 const items=computed(()=>rows.value.map(row=>({...row,image:preview(row)})));
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear(true);grade.value=0;keyword.value='';appliedKeyword.value='';period.value='all';range.value={start:0,stop:0};customOpen.value=false;filterError.value='';void Promise.resolve().then(enter);},{flush:'sync'});
 onShow(()=>{if(disposed)return;let token='',uid=0;try{token=String(uni.getStorageSync('uni_token')||'');uid=Number(uni.getStorageSync('uni_uid'))||0;}catch{}if(token!==auth.token||uid!==auth.uid){if(token&&uid>0)auth.setLogin(token,uid);else auth.clear();}visible.value=true;clear(true);enter();});
 onHide(()=>{visible.value=false;customOpen.value=false;clear(true);});onUnload(()=>{visible.value=false;disposed=true;clear(true);});onScopeDispose(()=>{visible.value=false;disposed=true;clear(true);});onReachBottom(()=>{if(!error.value)void load(true);});
 return{grade,keyword,appliedKeyword,appliedDates,period,range,customOpen,startDay,stopDay,filterError,rows,items,total,totalLevel,count,commission,brokerageLevel,divisionMode,showGrades,page,loading,loaded,hasMore,error,loggedIn,mediaExpired,load,search,choosePeriod,applyCustom,chooseGrade,retry:()=>load(page.value>0),refresh:()=>load(),login:()=>{if(visible.value&&!disposed&&!loggedIn.value)uni.navigateTo({url:'/pages/auth/login'});}};
}
