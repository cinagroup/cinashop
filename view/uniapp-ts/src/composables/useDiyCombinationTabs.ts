import { computed, onScopeDispose, ref, watch } from 'vue';
import type { DiyComponent } from '@/api/diy';
import { useAuthStore } from '@/stores/auth';
import { diyCarouselTabs, type DiyCarouselTab } from '@/utils/diyCarouselConfig';
import { useDiyPageHost } from './useDiyPageHost';
import { diyAuthoredPageFingerprint } from '@/utils/diyEditorialMediaLease';

export function useDiyCombinationTabs(blocks: () => DiyComponent[], active: () => boolean) {
  const auth=useAuthStore(), selection=ref<(DiyCarouselTab & {host:string})|null>(null);
  const fingerprint=computed(()=>diyAuthoredPageFingerprint(blocks())),owner=()=>`${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  let disposed=false;
  const hostKey=(block:DiyComponent)=>`${block.name}:${String(block.timestamp??'')}:${blocks().indexOf(block)}`;
  const micro=useDiyPageHost(()=>selection.value?.kind==='micro'?selection.value.id:null,()=>!disposed&&active(),{adoptTitle:false});
  const components=computed(()=>micro.page.value?.value.filter(block=>block.name!=='homeComb'&&block.name!=='headerSerch'&&block.name!=='tabNav'&&block.name!=='pageFoot')??[]);
  function select(block:DiyComponent,index:number){
    if(disposed||!active()||(block.name!=='homeComb'&&block.name!=='tabNav'))return;
    const host=blocks().find(item=>item===block);if(!host)return;
    const tab=diyCarouselTabs(host,host.name==='tabNav'?6:4).find(item=>item.index===index);if(!tab?.valid||!tab.title)return;
    if(selection.value?.host===hostKey(host)&&selection.value.index===index)return;
    selection.value={...tab,host:hostKey(host)};
  }
  const selected=(block:DiyComponent)=>selection.value?.host===hostKey(block)?selection.value.index:0;
  const stop=watch([fingerprint,owner],()=>{selection.value=null;},{flush:'sync'});
  function dispose(){if(disposed)return;disposed=true;stop();selection.value=null;micro.dispose();}
  onScopeDispose(dispose);
  return {selection,micro,components,select,selected,dispose};
}
