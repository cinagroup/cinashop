import { computed, onScopeDispose, ref, watch } from 'vue';
import { apiCategoryTree } from '@/api/product';
import type { CategoryNode } from '@/types/product';
import { categoryPath, categoryScopeForPath } from '../../../common/categoryCatalog';
import { diyWaterfallColumns, readDiyListProducts, type DiyListProduct } from '@/utils/diyListData';
import { openDiyLink } from '@/utils/diy';
import { useAuthStore } from '@/stores/auth';

export type DiyCombinationActivity = 'ready' | 'refreshing' | 'inactive';

export function useDiyCombinationCategory(id:()=>number,active:()=>boolean | DiyCombinationActivity) {
  const auth=useAuthStore(),owner=()=>`${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const path=ref<CategoryNode[]>([]),child=ref<number|null>(null),products=ref<DiyListProduct[]>([]),loading=ref(false),error=ref(''),loaded=ref(false),more=ref(true),notice=ref('');
  const children=computed(()=>path.value[path.value.length-1]?.children??[]);
  const heights=ref(new Map<number,number>()),columns=computed(()=>diyWaterfallColumns(products.value,heights.value));
  let generation=0,disposed=false,page=1,resumePending=false,requestingPage=false,refreshRequired=false,usable=false;
  const activity=():DiyCombinationActivity=>{const value=active();return typeof value==='boolean'?(value?'ready':'inactive'):value;};
  const ready=()=>!disposed&&activity()==='ready'&&Number.isSafeInteger(id())&&id()>0&&id()<=2147483647;
  function contextLease(){const epoch=generation,actor=owner(),key=id(),selected=child.value;return()=>ready()&&epoch===generation&&actor===owner()&&key===id()&&selected===child.value;}
  function lease(){const current=contextLease();return()=>usable&&current();}
  function clear(){resumePending=false;requestingPage=false;refreshRequired=false;usable=false;path.value=[];child.value=null;products.value=[];heights.value=new Map();page=1;loading.value=false;error.value='';notice.value='';loaded.value=false;more.value=true;}
  function scope(){const selected=children.value.find(item=>item.id===child.value);return categoryScopeForPath([...path.value,...(selected?[selected]:[])]);}
  async function refreshPages(){
    if(!ready()||loading.value||!path.value.length)return;
    generation++;refreshRequired=true;usable=false;loading.value=true;error.value='';
    const current=contextLease(),query=scope(),target=Math.max(1,page-1),interrupted=resumePending? page:null;
    if(!query.cid){loading.value=false;return;}
    try{
      const refreshed:DiyListProduct[]=[],seen=new Set<number>();let last=0,hasMore=true;
      for(let requested=1;requested<=target;requested++){
        if(!current())return;
        const rows=await readDiyListProducts({...query,page:requested,limit:10,news:0});if(!current())return;
        if(rows.some(row=>seen.has(row.id)))throw Error('商品分页重复，请重试当前分类');
        for(const row of rows){seen.add(row.id);refreshed.push(row);}
        last=requested;hasMore=rows.length===10;if(!hasMore)break;
      }
      if(!current())return;
      // Commit one coherent refreshed prefix, never a mixture of old and new
      // pages. Removed products lose both their media and measured geometry.
      generation++;products.value=refreshed;heights.value=new Map([...heights.value].filter(([id])=>seen.has(id)));
      page=last+1;more.value=hasMore;loaded.value=true;usable=true;refreshRequired=false;resumePending=false;loading.value=false;
      if(interrupted===page&&hasMore)void loadMore();
    }catch(reason){if(current()){error.value=reason instanceof Error?`分类商品刷新失败：${reason.message}`:'分类商品刷新失败，请重试';loading.value=false;}}
  }
  async function loadMore(){
    if(!ready()||loading.value||!path.value.length)return;
    if(refreshRequired){await refreshPages();return;}
    if(!more.value)return;
    const current=contextLease(),requested=page,query=scope();
    if(!query.cid)return;
    requestingPage=true;loading.value=true;error.value='';
    try{
      const rows=await readDiyListProducts({...query,page:requested,limit:10,news:0});if(!current())return;
      const seen=new Set(products.value.map(item=>item.id));if(rows.some(item=>seen.has(item.id)))throw Error('商品分页重复，请刷新当前分类');
      products.value=[...products.value,...rows];page=requested+1;more.value=rows.length===10;loaded.value=true;usable=true;
    }catch(reason){if(current())error.value=reason instanceof Error?reason.message:'分类商品读取失败，请重试';}
    finally{if(current()){loading.value=false;requestingPage=false;}}
  }
  async function reload(){
    generation++;clear();if(!ready())return;const current=contextLease();loading.value=true;
    try{const tree=await apiCategoryTree();if(!current())return;const found=categoryPath(tree,id());if(!found.length)throw Error('当前分类未开放');path.value=found;child.value=children.value[0]?.id??null;loading.value=false;await loadMore();}
    catch(reason){if(current()){loading.value=false;error.value=reason instanceof Error?reason.message:'分类读取失败，请重试';}}
  }
  function choose(id:number){if(!ready()||!children.value.some(item=>item.id===id)||child.value===id)return;generation++;resumePending=false;requestingPage=false;refreshRequired=false;usable=false;child.value=id;products.value=[];heights.value=new Map();page=1;loading.value=false;loaded.value=false;more.value=true;error.value='';notice.value='';void loadMore();}
  function adoptMeasurements(row:{id:number;height:number;current:()=>boolean}){if(!row.current()||!products.value.some(item=>item.id===row.id)||!Number.isFinite(row.height)||row.height<=0||row.height>10000)return;if(Math.abs((heights.value.get(row.id)??0)-row.height)>.5){const next=new Map(heights.value);next.set(row.id,row.height);heights.value=next;}}
  function open(id:number){if(!ready()||!usable)return;const product=products.value.find(item=>item.id===id);if(!product)return;if(!product.destination||product.navigationExpiresAt!==null&&product.navigationExpiresAt<=Date.now()){notice.value='商品活动入口待核实，请刷新当前分类';return;}openDiyLink(product.activityKind==='bargain'&&!auth.isLoggedIn?'/pages/auth/login':product.destination+(product.activityKind==='bargain'&&auth.uid>0?`&spid=${auth.uid}`:''));}
  const stop=watch([id,activity,owner],(next,previous)=>{
    generation++;
    const sameContext=!!previous&&next[0]===previous[0]&&next[2]===previous[2];
    if(sameContext&&next[1]==='refreshing'){
      // Refreshing withdraws all action/adoption leases without losing the
      // accepted same-owner category position. Actual hide still clears it.
      resumePending=resumePending||requestingPage;requestingPage=false;usable=false;loading.value=false;return;
    }
    if(sameContext&&previous[1]==='refreshing'&&next[1]==='ready'){
      if(!path.value.length)void reload();else void refreshPages();
      return;
    }
    clear();if(ready())void reload();
  },{immediate:true,flush:'sync'});
  function dispose(){if(disposed)return;disposed=true;stop();generation++;clear();}
  onScopeDispose(dispose);
  return {children,child,products,columns,loading,error,notice,loaded,more,loadMore,reload,choose,open,lease,adoptMeasurements,dispose};
}
