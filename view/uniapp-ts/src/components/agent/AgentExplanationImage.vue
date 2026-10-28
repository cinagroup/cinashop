<template>
  <view v-if="failed" class="unavailable" role="status"><text>图片暂不可用</text><button @tap.stop="image.retry">重新读取说明</button></view>
  <image v-else :key="src" :src="src" mode="widthFix" :style="[{width:width?width+'px':'100%',maxWidth:'100%'},imageStyle]" @load="image.loaded" @error="image.failed" />
</template>
<script setup lang="ts">
import {computed,ref,watch} from 'vue';
const props=defineProps<{src:string;imageStyle?:string;allowed:()=>boolean}>(),emit=defineEmits<{reload:[]}>();
const failed=ref(false),width=ref(0);
watch(()=>props.src,()=>{failed.value=false;width.value=0;});
const image=computed(()=>{const src=props.src;const current=()=>props.allowed()&&src===props.src;return{
  failed(){if(current())failed.value=true;},
  loaded(event:unknown){
    const detail=event&&typeof event==='object'&&'detail'in event?event.detail:undefined;
    const n=detail&&typeof detail==='object'&&'width'in detail?detail.width:undefined;
    if(current()&&typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=100000)width.value=n;
  },
  retry(){if(current())emit('reload');},
};});
</script>
<style scoped>
image{vertical-align:middle}.unavailable{padding:24rpx;background:#f7f7f7;color:#999;font-size:24rpx;line-height:1.8}.unavailable button{display:inline-block;margin:12rpx 0 0;padding:0 20rpx;background:#fff;border:1rpx solid #ddd;border-radius:6rpx;font-size:24rpx;line-height:52rpx;color:#555}.unavailable button::after{border:0}
</style>
