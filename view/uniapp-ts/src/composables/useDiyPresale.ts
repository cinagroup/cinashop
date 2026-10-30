import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { safeDiyColor, safeDiyImageUrl } from '@/utils/diy';
import { diyAuthoredPageFingerprint, diyEditorialMediaCacheUsable, diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import { useDiyCommerceWidget } from './useDiyCommerceWidget';
import { presalePresentation } from '../../../common/diyPresale';
export const PRESALE_NATIVE_SLOTS=['imgBgConfig','imgConfig','imgColorConfig'] as const;
/** The existing controller retains the real presale list and product-ID routes.
 * Its identity is the complete authored intent with only media tickets removed;
 * renewal changes native leases, never the feed query or owner generation. */
export function useDiyPresale(block:()=>unknown,active:()=>boolean){
 const auth=useAuthStore(),theme=useThemeStore(),config=computed(()=>presalePresentation(block(),theme.preset,safeDiyImageUrl,safeDiyColor));
 const fingerprint=computed(()=>diyAuthoredPageFingerprint([block()])),nativeEpoch=ref(0),mediaDeadline=ref(0),clock=ref(Date.now()),imageFailures=ref<Record<string,boolean>>({});
 let alive=true,admittedAt=Date.now(),timer:ReturnType<typeof setTimeout>|undefined;
 const owner=()=>`${auth.uid}:${auth.token}:${auth.sessionVersion}`;
 const ready=()=>alive&&active()&&config.value.enabled&&mediaDeadline.value>clock.value&&diyEditorialMediaCacheUsable({value:[block()]},admittedAt);
 // Admission survives ticket expiry only within the same live owner/intent.
 const admitted=ref('');
 const identity=()=>`${owner()}:${fingerprint.value}`;
 const stopAdmission=watch([fingerprint,owner,active],()=>{admitted.value='';if(ready())admitted.value=identity();},{flush:'sync'});
 const controllerActive=()=>alive&&active()&&config.value.enabled&&admitted.value===identity();
 const commerceBlock=computed(()=>({name:'presale',timestamp:fingerprint.value,numberConfig:{val:config.value.limit},isShow:true}));
 const state=useDiyCommerceWidget(()=>commerceBlock.value,controllerActive);
 const stopContext=watch([fingerprint,owner,active,()=>state.loading.value,()=>state.loaded.value,()=>state.error.value,()=>state.cards.value],()=>{nativeEpoch.value++;},{flush:'sync'});
 function issued(source?:()=>string){const epoch=nativeEpoch.value,actor=owner(),key=fingerprint.value,original=source?.();return()=>ready()&&nativeEpoch.value===epoch&&owner()===actor&&fingerprint.value===key&&(!source||source()===original);}
 const images=computed(()=>Object.fromEntries(PRESALE_NATIVE_SLOTS.map(slot=>{const src=config.value.images[slot],current=issued(()=>config.value.images[slot]);return[slot,{src,key:`${nativeEpoch.value}:${slot}:${src}`,current,loaded:()=>{if(current())imageFailures.value={...imageFailures.value,[slot]:false};},failed:()=>{if(current()){nativeEpoch.value++;imageFailures.value={...imageFailures.value,[slot]:true};}}}];})) as Record<typeof PRESALE_NATIVE_SLOTS[number],{src:string;key:string;current:()=>boolean;loaded:()=>void;failed:()=>void}>);
 const entries=computed(()=>{const current=issued();return state.cards.value.map(product=>({product,tap:()=>{if(current()&&state.loaded.value&&!state.loading.value&&!state.error.value&&state.cards.value.includes(product))state.openCard(product.id);}}));});
 const actions=computed(()=>{const current=issued();return{refresh:()=>{if(current()&&!state.loading.value)void state.load();},more:()=>{if(current())state.more();}};});
 function expire(){if(!alive)return;clock.value=Date.now();if(mediaDeadline.value>clock.value)timer=setTimeout(expire,Math.max(1,mediaDeadline.value-clock.value));else nativeEpoch.value++;}
 function renew(){nativeEpoch.value++;imageFailures.value={};if(timer!==undefined)clearTimeout(timer);timer=undefined;admittedAt=Date.now();clock.value=admittedAt;mediaDeadline.value=diyEditorialMediaDeadline({value:[block()]},admittedAt);if(ready())admitted.value=identity();if(Number.isFinite(mediaDeadline.value)&&mediaDeadline.value>clock.value)timer=setTimeout(expire,mediaDeadline.value-clock.value);}
 const stopMedia=watch(block,renew,{deep:true,immediate:true,flush:'sync'});
 function dispose(){if(!alive)return;alive=false;stopContext();stopAdmission();stopMedia();if(timer!==undefined)clearTimeout(timer);nativeEpoch.value++;state.dispose();}
 onScopeDispose(dispose);
 return{config,state,fingerprint,commerceBlock,nativeEpoch,mediaDeadline,imageFailures,images,entries,actions,ready,issued,dispose};
}
