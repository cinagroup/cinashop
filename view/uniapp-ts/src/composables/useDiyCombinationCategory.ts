import { computed, onScopeDispose, ref, watch } from 'vue';
import { apiCategoryTree } from '@/api/product';
import type { CategoryNode } from '@/types/product';
import { categoryPath, categoryScopeForPath } from '../../../common/categoryCatalog';
import { diyWaterfallColumns, readDiyListProducts, type DiyListProduct } from '@/utils/diyListData';
import { openDiyLink } from '@/utils/diy';
import { useAuthStore } from '@/stores/auth';

export function useDiyCombinationCategory(id:()=>number,active:()=>boolean) {
  const auth=useAuthStore(),owner=()=>`${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const path=ref<CategoryNode[]>([]),child=ref<number|null>(null),products=ref<DiyListProduct[]>([]),loading=ref(false),error=ref(''),loaded=ref(false),more=ref(true),notice=ref('');
  const children=computed(()=>path.value[path.value.length-1]?.children??[]);
  const heights=ref(new Map<number,number>()),columns=computed(()=>diyWaterfallColumns(products.value,heights.value));
  let generation=0,disposed=false,page=1;
  const ready=()=>!disposed&&active()&&Number.isSafeInteger(id())&&id()>0&&id()<=2147483647;
  function lease(){const epoch=generation,actor=owner(),key=id(),selected=child.value;return()=>ready()&&epoch===generation&&actor===owner()&&key===id()&&selected===child.value;}
  function clear(){path.value=[];child.value=null;products.value=[];heights.value=new Map();page=1;loading.value=false;error.value='';notice.value='';loaded.value=false;more.value=true;}
  async function loadMore(){
    if(!ready()||loading.value||!more.value||!path.value.length)return;
    const current=lease(),requested=page;
    const selected=children.value.find(item=>item.id===child.value),scope=categoryScopeForPath([...path.value,...(selected?[selected]:[])]);
    if(!scope.cid)return;
    loading.value=true;error.value='';
    try{
      const rows=await readDiyListProducts({...scope,page:requested,limit:10,news:0});if(!current())return;
      const seen=new Set(products.value.map(item=>item.id));if(rows.some(item=>seen.has(item.id)))throw Error('商品分页重复，请刷新当前分类');
      products.value=[...products.value,...rows];page=requested+1;more.value=rows.length===10;loaded.value=true;
    }catch(reason){if(current())error.value=reason instanceof Error?reason.message:'分类商品读取失败，请重试';}
    finally{if(current())loading.value=false;}
  }
  async function reload(){
    generation++;clear();if(!ready())return;const current=lease();loading.value=true;
    try{const tree=await apiCategoryTree();if(!current())return;const found=categoryPath(tree,id());if(!found.length)throw Error('当前分类未开放');path.value=found;child.value=children.value[0]?.id??null;loading.value=false;await loadMore();}
    catch(reason){if(current()){loading.value=false;error.value=reason instanceof Error?reason.message:'分类读取失败，请重试';}}
  }
  function choose(id:number){if(!ready()||!children.value.some(item=>item.id===id)||child.value===id)return;generation++;child.value=id;products.value=[];heights.value=new Map();page=1;loading.value=false;loaded.value=false;more.value=true;error.value='';notice.value='';void loadMore();}
  function adoptMeasurements(row:{id:number;height:number;current:()=>boolean}){if(!row.current()||!products.value.some(item=>item.id===row.id)||!Number.isFinite(row.height)||row.height<=0||row.height>10000)return;if(Math.abs((heights.value.get(row.id)??0)-row.height)>.5){const next=new Map(heights.value);next.set(row.id,row.height);heights.value=next;}}
  function open(id:number){if(!ready())return;const product=products.value.find(item=>item.id===id);if(!product)return;if(!product.destination||product.navigationExpiresAt!==null&&product.navigationExpiresAt<=Date.now()){notice.value='商品活动入口待核实，请刷新当前分类';return;}openDiyLink(product.activityKind==='bargain'&&!auth.isLoggedIn?'/pages/auth/login':product.destination+(product.activityKind==='bargain'&&auth.uid>0?`&spid=${auth.uid}`:''));}
  const stop=watch([id,active,owner],()=>{generation++;clear();if(ready())void reload();},{immediate:true,flush:'sync'});
  function dispose(){if(disposed)return;disposed=true;stop();generation++;clear();}
  onScopeDispose(dispose);
  return {children,child,products,columns,loading,error,notice,loaded,more,loadMore,reload,choose,open,lease,adoptMeasurements,dispose};
}
