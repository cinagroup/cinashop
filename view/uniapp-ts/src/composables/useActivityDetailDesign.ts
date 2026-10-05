import { ref, watch } from 'vue';
import { onShow,onHide,onUnload,onShareAppMessage } from '@dcloudio/uni-app';
import { http } from '@/utils/request';
import { useAuthStore } from '@/stores/auth';
import { cloneProductDetailDesign,isProductDetailDesignValue } from '../../../common/productDetailDesign';
/** Old activity pages consume only media geometry/dots and footer choices. */
export function useActivityDetailDesign(readPublic=true){
  const auth=useAuthStore(),activityDesign=ref(cloneProductDetailDesign()),activityDesignError=ref(''),activityVisible=ref(false);
  let generation=0,disposed=false,queued=false;
  async function reloadActivityDesign(){if(!readPublic||!activityVisible.value||disposed)return;const epoch=++generation,owner={version:auth.sessionVersion,token:auth.token,uid:auth.uid};
    const current=()=>!disposed&&activityVisible.value&&epoch===generation&&owner.version===auth.sessionVersion&&owner.token===auth.token&&owner.uid===auth.uid;
    activityDesignError.value='';try{const value=await http.get<unknown>('/v2/diy/product_detail');if(!current())return;
      if(!value||typeof value!=='object'||Array.isArray(value)||!isProductDetailDesignValue((value as Record<string,unknown>).product_detail))throw Error('活动详情展示设置无效');
      activityDesign.value=cloneProductDetailDesign((value as {product_detail:ReturnType<typeof cloneProductDetailDesign>}).product_detail);
      const state=(value as Record<string,unknown>).product_detail_design_state;
      if(!state||typeof state!=='object'||(state as {configured:unknown}).configured!==true)activityDesignError.value='当前使用默认活动详情布局';
    }catch{if(current())activityDesignError.value='展示设置读取失败，当前使用默认活动详情布局，可重试';}
  }
  function clear(){generation++;activityDesign.value=cloneProductDetailDesign();activityDesignError.value='';}
  onShow(()=>{activityVisible.value=true;void reloadActivityDesign();});onHide(()=>{activityVisible.value=false;clear();});onUnload(()=>{disposed=true;activityVisible.value=false;clear();});
  watch(()=>[auth.sessionVersion,auth.token,auth.uid],()=>{clear();if(!queued){queued=true;Promise.resolve().then(()=>{queued=false;void reloadActivityDesign();});}},{flush:'sync'});
  return{activityDesign,activityDesignError,activityVisible,reloadActivityDesign};
}
/** Page-level native share hooks retain the actual activity ID and current referrer. */
export function useActivityDetailShare(read:()=>{title:string;path:string;image:string}|null,active:()=>boolean){
  const auth=useAuthStore();onShareAppMessage(()=>{
    const data=active()?read():null;
    if(!data||!/^\/pages\/activity\/(?:seckillDetail|detail|bargainDetail|presaleDetail|newcomerDetail)\?(?:id|bargain_id)=[1-9]\d*$/u.test(data.path))return{title:'商城',path:'/pages/index/index',imageUrl:''};
    return{title:data.title,path:`${data.path}${auth.isLoggedIn&&auth.uid>0?`&spid=${auth.uid}`:''}`,imageUrl:data.image};
  });
}
