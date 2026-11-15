<template><ThemePage><view class="handoff"><text>{{ error || '正在打开商品评价…' }}</text></view></ThemePage></template>
<script setup lang="ts">
import { ref } from 'vue';
import { onLoad,onUnload } from '@dcloudio/uni-app';
import ThemePage from '@/components/ThemePage.vue';
import { publicReviewPageRoute,publicReviewQuery } from '../../../../../common/publicProductReviewRoute';
const error=ref('');let disposed=false;
onUnload(()=>{disposed=true;});
onLoad(query=>{try{let input=query??{};
 // #ifdef H5
 if(typeof window!=='undefined'){const hash=window.location.hash,split=hash.indexOf('?');if(split>=0){const id=publicReviewQuery(hash.slice(split+1),false);input={productId:String(id)};}}
 // #endif
 const url=publicReviewPageRoute(input,false);if(!disposed)uni.redirectTo({url,fail:()=>{if(!disposed)error.value='评价页面未打开，请从商品重新进入';}});
}catch(e){error.value=(e as Error).message;}});
</script>
<style scoped>.handoff{padding:40rpx;font-size:28rpx;line-height:1.8}</style>
