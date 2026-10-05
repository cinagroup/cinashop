import { ref, watch, type Ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { http } from '@/utils/request';
import type { GoodsDetail } from '@/types/product';
export function useOrdinaryCollection(detail:Ref<GoodsDetail|null>,visible:Ref<boolean>){
  const auth=useAuthStore(),collected=ref<boolean|null>(null),collectionSaving=ref(false),collectionError=ref('');let generation=0;
  watch(()=>[detail.value,visible.value,auth.sessionVersion,auth.token,auth.uid],()=>{generation++;collectionSaving.value=false;collectionError.value='';collected.value=visible.value&&detail.value?detail.value.userCollect:null;},{flush:'sync'});
  async function toggleCollection(){const product=detail.value;if(!visible.value||!product||collectionSaving.value)return;
    if(!auth.isLoggedIn){uni.navigateTo({url:'/pages/auth/login',fail:()=>uni.showToast({title:'登录页面未打开',icon:'none'})});return;}
    if(collected.value===null){collectionError.value='收藏结果未确认，请重新加载商品读取状态';return;}
    const previous=collected.value,epoch=generation,owner={version:auth.sessionVersion,token:auth.token,uid:auth.uid};
    const current=()=>visible.value&&detail.value===product&&epoch===generation&&owner.version===auth.sessionVersion&&owner.token===auth.token&&owner.uid===auth.uid;
    collectionSaving.value=true;collectionError.value='';
    try{if(previous)await http.post('/collect/del',{id:[product.id],category:'product'});else await http.post('/collect/add',{id:product.id,category:'product'});
      if(current())collected.value=!previous;
    }catch(e){if(current()){collected.value=null;collectionError.value=e instanceof Error?e.message:'收藏结果未确认，请重新读取';}}
    finally{if(current())collectionSaving.value=false;}
  }
  return{collected,collectionSaving,collectionError,toggleCollection};
}
