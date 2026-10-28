import {computed,onScopeDispose,ref,watch} from 'vue';
import {onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {useAuthStore} from '@/stores/auth';
import {createUserCenterRequests,type UserCenterRequests} from '@/api/userCenter';
import {parseDistributionSnapshot,parseDistributionTasks,distributionTaskAction,distributionColor,type DistributionSnapshot,type DistributionTasks,type DistributionTask} from '@/api/distributorLevels';
import {memberLevelImage} from '@/api/memberLevels';
import {memberRightResolvedMedia,memberRightMediaDeadline} from '../../../common/memberRightMedia';

/** The two PHP-compatible GETs may award levels. Media never renews them implicitly. */
export function useDistributorLevels(){
 const auth=useAuthStore(),snapshot=ref<DistributionSnapshot|null>(null),tasks=ref<DistributionTasks|null>(null),selectedId=ref(0);
 const loading=ref(false),taskLoading=ref(false),error=ref(''),taskError=ref(''),mediaExpired=ref(false),clock=ref(0),failed=ref<string[]>([]);
 let visible=false,disposed=false,epoch=0,taskEpoch=0,mediaRevision=0,leaseRevision=0;
 let scope:UserCenterRequests|undefined,taskScope:UserCenterRequests|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 function stored(){try{const token=uni.getStorageSync('uni_token')||'',uid=Number(uni.getStorageSync('uni_uid'))||0;
  return typeof token==='string'&&Number.isSafeInteger(uid)&&uid>=0&&!!token===(uid>0)?{token,uid}:null;}catch{return null;}}
 function persisted(){const value=stored();return !!value&&value.uid===auth.uid&&value.token===auth.token;}
 const current=()=>visible&&!disposed&&persisted()&&auth.isLoggedIn;
 const selectedLevel=computed(()=>snapshot.value?.level_list.find(level=>level.id===selectedId.value)??null);
 const selectedIndex=computed(()=>Math.max(0,snapshot.value?.level_list.findIndex(level=>level.id===selectedId.value)??0));
 const finishedCount=computed(()=>tasks.value?.list.filter(task=>task.finish===1).length??0);
 const theme=computed(()=>distributionColor(selectedLevel.value?.color||snapshot.value?.level_info?.color||'')||'#d97e1d');
 function rgba(alpha:number){const color=theme.value;let hex=color.slice(1);
  if(color.startsWith('#')){if(hex.length<=4)hex=[...hex].map(c=>c+c).join('');return `rgba(${[0,2,4].map(n=>parseInt(hex.slice(n,n+2),16)).join(',')},${alpha})`;}
  const rgb=/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(color);return rgb?`rgba(${rgb.slice(1,4).join(',')},${alpha})`:`rgba(217,126,29,${alpha})`;
 }
 function resetMedia(){mediaRevision++;leaseRevision++;clearTimeout(timer);timer=undefined;failed.value=[];mediaExpired.value=false;clock.value++;}
 function clear(){epoch++;taskEpoch++;scope?.abort();taskScope?.abort();scope=taskScope=undefined;resetMedia();snapshot.value=null;tasks.value=null;selectedId.value=0;loading.value=taskLoading.value=false;error.value=taskError.value='';}
 function sync(){const value=stored();if(!value){clear();return false;}if(value.uid!==auth.uid||value.token!==auth.token){clear();auth.$patch({...value,sessionVersion:auth.sessionVersion+1});}return true;}
 function schedule(){clearTimeout(timer);timer=undefined;clock.value++;const ticket=++leaseRevision;
  const s=snapshot.value,deadline=memberRightMediaDeadline(s?[s.user?.avatar??'',s.level_info?.image??'',...s.level_list.map(v=>v.image)]:[],[]);
  mediaExpired.value=deadline!==null&&deadline<=Date.now();if(deadline===null||deadline<=Date.now())return;
  timer=setTimeout(()=>{timer=undefined;if(current()&&ticket===leaseRevision){clock.value++;mediaExpired.value=true;}},Math.min(2147483647,Math.max(1,deadline-Date.now()+1)));
 }
 function image(raw:string){void clock.value;const ticket=mediaRevision,uid=auth.uid,token=auth.token,version=auth.sessionVersion;
  // Only the five exact bundled PHP installer paths are local aliases. Platform
  // image configuration and signed previews remain authoritative otherwise.
  const local=/^\/uploads\/system\/(agent_level_[1-5]\.png)$/u.exec(raw);
  const src=current()&&!failed.value.includes(raw)?local?`/static/php-distribution-level/${local[1]}`:memberLevelImage(memberRightResolvedMedia(raw)):'';
  return{src,key:`${ticket}:${raw}`,error:()=>{if(raw&&ticket===mediaRevision&&current()&&uid===auth.uid&&token===auth.token&&version===auth.sessionVersion&&!failed.value.includes(raw))failed.value.push(raw);}};
 }
 const avatar=computed(()=>image(snapshot.value?.user?.avatar??'')),badge=computed(()=>image(selectedLevel.value?.image??''));
 function safeError(reason:unknown){const text=reason instanceof Error?reason.message:'读取失败，请重试';return text.length<=1000&&!/[\u0000-\u001f\u007f]/u.test(text)?text:'读取失败，请重试';}
 async function load(){if(!visible||disposed||loading.value||!sync()||!current())return;
  const ticket=++epoch;taskEpoch++;scope?.abort();taskScope?.abort();taskScope=undefined;taskLoading.value=false;error.value='';loading.value=true;
  const r=createUserCenterRequests(()=>current()&&ticket===epoch);scope=r;
  try{const result=parseDistributionSnapshot(await r.request('v2/agent/level_list','GET',{},true),r.owner.uid);if(!r.active())return;
   snapshot.value=result;tasks.value=null;taskError.value='';resetMedia();
   const retained=result.level_list.some(level=>level.id===selectedId.value)?selectedId.value:0;
   selectedId.value=retained||result.next_level?.id||result.level_list.find(level=>level.id===result.user?.agent_level)?.id||result.level_list[0]?.id||0;schedule();
  }catch(reason){if(r.active())error.value=safeError(reason);}
  finally{if(ticket===epoch)loading.value=false;r.abort();if(scope===r)scope=undefined;if(visible&&!persisted())sync();}
  if(current()&&ticket===epoch&&!error.value&&selectedId.value)await refreshTasks();
 }
 async function refreshTasks(){if(!current()||!selectedLevel.value||loading.value||taskLoading.value)return;
  const ticket=++taskEpoch,parent=epoch,id=selectedId.value;taskScope?.abort();taskLoading.value=true;taskError.value='';
  const r=createUserCenterRequests(()=>current()&&ticket===taskEpoch&&parent===epoch&&id===selectedId.value);taskScope=r;
  try{const result=parseDistributionTasks(await r.request('v2/agent/level_task_list','GET',{id},true),id);if(r.active())tasks.value=result;}
  catch(reason){if(r.active())taskError.value=safeError(reason);}
  finally{if(ticket===taskEpoch)taskLoading.value=false;r.abort();if(taskScope===r)taskScope=undefined;if(visible&&!persisted())sync();}
 }
 function selectLevel(event:{detail:{value:string|number}}){if(!current()||loading.value||taskLoading.value||!snapshot.value)return;
  const index=Number(event.detail.value),level=Number.isInteger(index)?snapshot.value.level_list[index]:undefined;
  if(!level||level.id===selectedId.value)return;selectedId.value=level.id;tasks.value=null;taskError.value='';void refreshTasks();}
 function act(task:DistributionTask){if(!current()||loading.value||taskLoading.value||error.value||taskError.value||!tasks.value?.list.some(item=>item.id===task.id&&!item.finish))return;
  const action=distributionTaskAction(task.type);if(action)uni.navigateTo({url:action.url});}
 function changed(){if(!visible||disposed)return;if(sync()&&current()&&!snapshot.value&&!loading.value&&!error.value)void load();}
 watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{clear();void Promise.resolve().then(()=>{if(current())void load();});},{flush:'sync'});
 onShow(()=>{if(disposed)return;visible=true;clear();if(sync())void load();
  // #ifdef H5
  if(typeof window!=='undefined'){window.addEventListener('focus',changed);window.addEventListener('storage',changed);}
  // #endif
 });
 function leave(){visible=false;clear();
  // #ifdef H5
  if(typeof window!=='undefined'){window.removeEventListener('focus',changed);window.removeEventListener('storage',changed);}
  // #endif
 }
 onHide(leave);onUnload(()=>{leave();disposed=true;});onScopeDispose(()=>{leave();disposed=true;});
 return{auth,snapshot,tasks,selectedId,selectedLevel,selectedIndex,finishedCount,loading,taskLoading,error,taskError,theme,rgba,avatar,badge,mediaExpired,current,load,refreshTasks,selectLevel,act};
}
