import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { diyStationClosure } from '@/utils/diy';
import { diyAuthoredPageFingerprint, diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import { normalizeDiyPresentation } from '@/utils/diyPresentationConfig';
import { openFabLink } from '@/utils/fab';
/** A capability rotation preserves only the seek position of identical authored
 * media. It always pauses; a fresh user gesture is required to play again. */
export function useDiyPresentation(block:()=>unknown,active:()=>boolean,refreshing:()=>boolean){
  const auth=useAuthStore(),epoch=ref(0),expired=ref(false),deadline=ref(Infinity),positions=ref<Record<number,number>>({});
  const config=computed(()=>{try{return {value:normalizeDiyPresentation(block()),error:''};}catch(e){return {value:null,error:e instanceof Error?e.message:'内容配置无效'};}});
  const actor=()=>`${auth.uid}:${auth.token}:${auth.sessionVersion}`,payload=()=>JSON.stringify(block());
  const authored=()=>{try{return diyAuthoredPageFingerprint([block()]);}catch{return payload();}};
  let disposed=false,admittedAt=Date.now(),priorActor='',priorAuthored='',timer:ReturnType<typeof setTimeout>|undefined;
  const ready=()=>!disposed&&active()&&!expired.value&&!diyStationClosure.value&&!!config.value.value?.enabled&&deadline.value>Date.now();
  function lease(){const revision=epoch.value,owner=actor();return ()=>ready()&&revision===epoch.value&&owner===actor();}
  function reset(){
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    const currentActor=actor(),intent=authored();
    if(currentActor!==priorActor||intent!==priorAuthored||diyStationClosure.value)positions.value={};
    priorActor=currentActor;priorAuthored=intent;epoch.value++;expired.value=false;admittedAt=Date.now();
    const revisionForHide=epoch.value;
    if(!active())void nextTick(()=>{if(!disposed&&revisionForHide===epoch.value&&!active()&&!refreshing())positions.value={};});
    deadline.value=diyEditorialMediaDeadline({value:[block()]},admittedAt);const revision=epoch.value;
    if(active()&&Number.isFinite(deadline.value))timer=setTimeout(()=>{if(!disposed&&revision===epoch.value){expired.value=true;epoch.value++;}},Math.max(0,deadline.value-Date.now()));
  }
  function position(index:number,value:number){if(ready()&&Number.isFinite(value)&&value>=0&&value<=86400*365)positions.value[index]=value;}
  function open(value:string){if(!ready())return;if(/^tel:\+?[0-9][0-9 -]{2,30}$/u.test(value)){try{uni.makePhoneCall({phoneNumber:value.slice(4),fail:()=>{}});}catch{}return;}openFabLink(value);}
  const stop=watch([payload,actor,active,refreshing,()=>diyStationClosure.value],reset,{immediate:true,flush:'sync'});
  onScopeDispose(()=>{disposed=true;stop();if(timer!==undefined)clearTimeout(timer);positions.value={};epoch.value++;});
  return {config,epoch,expired,positions,ready,lease,position,open};
}
