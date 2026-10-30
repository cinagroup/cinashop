import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { safeDiyColor, safeDiyImageUrl } from '@/utils/diy';
import { diyAuthoredPageFingerprint, diyEditorialMediaCacheUsable, diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import { apiDiySeckillIndex, apiDiySeckillProducts } from '@/api/diySeckillAuthor';
import { openDiyLink } from '@/utils/diy';
import type { DiySeckillRow, DiySeckillSlot } from '../../../common/diySeckillData';
import { seckillCountdown } from '../../../common/diySeckill';
import { seckillPresentation } from '../../../common/diySeckill';
export const SECKILL_NATIVE_SLOTS=['imgBgConfig','imgConfig','imgColorConfig'] as const;
/** The independent read-only controller keeps the server-selected slot and canonical migrated purchase route.
 * Its identity is the complete authored intent with only media tickets removed;
 * renewal changes native leases, never the feed query or owner generation. */
export function useDiySeckill(block:()=>unknown,active:()=>boolean){
 const auth=useAuthStore(),theme=useThemeStore(),config=computed(()=>seckillPresentation(block(),theme.preset,safeDiyImageUrl,safeDiyColor));
 const fingerprint=computed(()=>diyAuthoredPageFingerprint([block()])),nativeEpoch=ref(0),mediaDeadline=ref(0),clock=ref(Date.now()),imageFailures=ref<Record<string,boolean>>({});
 let alive=true,admittedAt=Date.now(),timer:ReturnType<typeof setTimeout>|undefined;
 const owner=()=>`${auth.uid}:${auth.token}:${auth.sessionVersion}`;
 const ready=()=>alive&&active()&&config.value.enabled&&mediaDeadline.value>clock.value&&diyEditorialMediaCacheUsable({value:[block()]},admittedAt);
 // Admission survives ticket expiry only within the same live owner/intent.
 const admitted=ref('');
 const identity=()=>`${owner()}:${fingerprint.value}`;
 const stopAdmission=watch([fingerprint,owner,active],()=>{admitted.value='';if(ready())admitted.value=identity();},{flush:'sync'});
 const controllerActive=()=>alive&&active()&&config.value.enabled&&admitted.value===identity();
 const state=useDiySeckillFeed(()=>config.value.limit,()=>fingerprint.value,owner,controllerActive);
 const businessLoaded=ref<Record<string,boolean>>({}),businessFailed=ref<Record<string,boolean>>({});
 const stopContext=watch([fingerprint,owner,active,()=>state.loading.value,()=>state.loaded.value,()=>state.error.value,()=>state.cards.value],()=>{nativeEpoch.value++;businessLoaded.value={};businessFailed.value={};},{flush:'sync'});
 function issued(source?:()=>string){const epoch=nativeEpoch.value,actor=owner(),key=fingerprint.value,original=source?.();return()=>ready()&&nativeEpoch.value===epoch&&owner()===actor&&fingerprint.value===key&&(!source||source()===original);}
 const images=computed(()=>Object.fromEntries(SECKILL_NATIVE_SLOTS.map(slot=>{const src=config.value.images[slot],current=issued(()=>config.value.images[slot]);return[slot,{src,key:`${nativeEpoch.value}:${slot}:${src}`,current,loaded:()=>{if(current())imageFailures.value={...imageFailures.value,[slot]:false};},failed:()=>{if(current()){nativeEpoch.value++;imageFailures.value={...imageFailures.value,[slot]:true};}}}];})) as Record<typeof SECKILL_NATIVE_SLOTS[number],{src:string;key:string;current:()=>boolean;loaded:()=>void;failed:()=>void}>);
 const entries=computed(()=>{const current=issued();return state.cards.value.map(product=>{
  const valid=()=>current()&&state.loaded.value&&!state.loading.value&&!state.error.value&&state.cards.value.includes(product),baseKey=`${product.id}:base`,overlayKey=`${product.id}:overlay`;
  return{product,tap:()=>{if(valid())state.openCard(product.id);},media:{
   base:{key:`${nativeEpoch.value}:${baseKey}:${product.image}`,src:businessFailed.value[baseKey]?'':product.image,loaded:()=>{if(valid())businessLoaded.value={...businessLoaded.value,[baseKey]:true};},failed:()=>{if(valid()){nativeEpoch.value++;businessLoaded.value={...businessLoaded.value,[baseKey]:false};businessFailed.value={...businessFailed.value,[baseKey]:true};}}},
   overlay:{key:`${nativeEpoch.value}:${overlayKey}:${product.activityImage}`,src:businessLoaded.value[baseKey]&&!businessFailed.value[baseKey]&&!businessFailed.value[overlayKey]?product.activityImage:'',loaded:()=>{},failed:()=>{if(valid()){nativeEpoch.value++;businessFailed.value={...businessFailed.value,[overlayKey]:true};}}}
  }};
 });});
 const actions=computed(()=>{const current=issued();return{key:nativeEpoch.value,refresh:()=>{if(current()&&!state.loading.value)void state.load();},more:()=>{if(current())state.more();}};});
 function expire(){if(!alive)return;clock.value=Date.now();if(mediaDeadline.value>clock.value)timer=setTimeout(expire,Math.max(1,mediaDeadline.value-clock.value));else nativeEpoch.value++;}
 function renew(){nativeEpoch.value++;imageFailures.value={};businessLoaded.value={};businessFailed.value={};if(timer!==undefined)clearTimeout(timer);timer=undefined;admittedAt=Date.now();clock.value=admittedAt;mediaDeadline.value=diyEditorialMediaDeadline({value:[block()]},admittedAt);if(ready())admitted.value=identity();if(Number.isFinite(mediaDeadline.value)&&mediaDeadline.value>clock.value)timer=setTimeout(expire,mediaDeadline.value-clock.value);}
 const stopMedia=watch(block,renew,{deep:true,immediate:true,flush:'sync'});
 function dispose(){if(!alive)return;alive=false;stopContext();stopAdmission();stopMedia();if(timer!==undefined)clearTimeout(timer);nativeEpoch.value++;state.dispose();}
 onScopeDispose(dispose);
 return{config,state,fingerprint,nativeEpoch,mediaDeadline,imageFailures,images,entries,actions,ready,issued,dispose};
}

/** Read-only feed; no alternate-slot UI, login gate, subscription or purchase operation.
 * Check context after index BEFORE issuing list, and again before committing rows. */
function useDiySeckillFeed(limit:()=>number,key:()=>string,owner:()=>string,active:()=>boolean){
 const cards=ref<DiySeckillRow[]>([]),slots=ref<DiySeckillSlot[]>([]),selectedSlot=ref(0),selectedStop=ref(0),loading=ref(false),loaded=ref(false),error=ref(''),now=ref(Date.now());
 let generation=0,disposed=false,interval:ReturnType<typeof setInterval>|undefined;
 const ready=()=>!disposed&&active(),current=(n:number,actor:string,intent:string)=>ready()&&generation===n&&owner()===actor&&key()===intent;
 function clear(){if(interval!==undefined)clearInterval(interval);interval=undefined;cards.value=[];slots.value=[];selectedSlot.value=0;selectedStop.value=0;loading.value=false;loaded.value=false;error.value='';}
 async function load(){if(!ready()||loading.value)return;const n=++generation,actor=owner(),intent=key(),count=limit();clear();loading.value=true;
  try{const schedule=await apiDiySeckillIndex();if(!current(n,actor,intent))return;
   const slot=schedule.index<0?undefined:schedule.slots[schedule.index],rows=slot&&count>0?await apiDiySeckillProducts(slot.id,count):[];
   if(!current(n,actor,intent))return;slots.value=schedule.slots;selectedSlot.value=slot?.id??0;selectedStop.value=slot?.stop??0;cards.value=rows;now.value=Date.now();loaded.value=true;
   if(selectedStop.value*1000>now.value)interval=setInterval(()=>{if(!current(n,actor,intent))return;now.value=Date.now();if(now.value>=selectedStop.value*1000&&interval!==undefined){clearInterval(interval);interval=undefined;}},1000);
  }catch(reason){if(current(n,actor,intent)){clear();error.value=reason instanceof Error?reason.message:'秒杀商品读取失败，请重试';}}
  finally{if(current(n,actor,intent))loading.value=false;}
 }
 const navigable=()=>ready()&&loaded.value&&!loading.value&&!error.value;
 function openCard(id:number){if(navigable()&&cards.value.some(row=>row.id===id))openDiyLink(`/pages/activity/seckillDetail?id=${id}`);}
 function more(){if(navigable())openDiyLink('/pages/activity/index?type=seckill');}
 const countdown=computed(()=>seckillCountdown(selectedStop.value,now.value));
 const stop=watch([key,owner,active],()=>{generation++;clear();const n=generation;if(ready())void Promise.resolve().then(()=>{if(ready()&&n===generation)void load();});},{immediate:true,flush:'sync'});
 function dispose(){if(disposed)return;disposed=true;stop();generation++;clear();}
 onScopeDispose(dispose);return{cards,slots,selectedSlot,selectedStop,loading,loaded,error,countdown,load,openCard,more,dispose};
}
