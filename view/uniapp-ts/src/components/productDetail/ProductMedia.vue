<template>
  <view class="product-media">
    <swiper class="media-swiper" :style="{height:`${height}px`}" :indicator-dots="dots===1" :autoplay="!video" circular @change="change">
      <swiper-item v-if="video"><video :key="videoKey" id="ordinary-product-video" class="product-video" :src="video" :poster="images[0] || ''" controls :autoplay="false" @error="videoHandlers.error" /></swiper-item>
      <swiper-item v-for="entry in imageHandlers" :key="`${imageKey}-${entry.source}`"><image class="media-image" :src="entry.source" :mode="pictureConfig===1?'widthFix':'aspectFill'" @tap="preview(entry.source)" @error="entry.error" /></swiper-item>
    </swiper>
    <view v-if="videoError" class="media-error" role="alert">{{videoError}}<button size="mini" @tap="retryVideo">重试视频</button></view>
    <view v-if="imageError" class="media-error" role="alert">{{imageError}}<button size="mini" @tap="retryImage">重新读取商品图片</button></view>
  </view>
</template>
<script setup lang="ts">
import { getCurrentInstance, ref, computed, nextTick, watch, onUnmounted } from 'vue';
const props=defineProps<{images:string[];video:string;pictureConfig:0|1;dots:0|1;active:boolean}>();
const instance=getCurrentInstance(), height=ref(375), videoError=ref(''),imageError=ref(''),videoKey=ref(0),imageKey=ref(0);
let generation=0,disposed=false;
function stop(){if(typeof uni.createVideoContext==='function')uni.createVideoContext('ordinary-product-video',instance?.proxy??undefined).pause();}
const videoHandlers=computed(()=>{const key=videoKey.value,source=props.video;return{error:()=>{if(!disposed&&props.active&&key===videoKey.value&&source===props.video)videoError.value='商品视频暂不可播放，请重试';}};});
const imageHandlers=computed(()=>{const key=imageKey.value;return props.images.map(source=>({source,error:()=>{if(!disposed&&props.active&&key===imageKey.value&&props.images.includes(source))imageError.value='商品图片暂不可加载，请重新读取';}}));});
function measure(index=0){const epoch=++generation;const width=Math.min(960,uni.getSystemInfoSync?.().windowWidth||375);height.value=width;imageError.value='';const source=props.images[index];
  if(!props.active||props.pictureConfig!==1||!source||typeof uni.getImageInfo!=='function')return;
  uni.getImageInfo({src:source,success:info=>{if(!disposed&&epoch===generation&&props.active&&props.images[index]===source){if(info.width>0&&info.height>0)height.value=Math.min(1600,Math.max(160,width*info.height/info.width));else imageError.value='商品图片尺寸无效，暂按默认高度展示';}},fail:()=>{if(!disposed&&epoch===generation&&props.active&&props.images[index]===source)imageError.value='商品图片尺寸读取失败，暂按默认高度展示';}});
}
function change(event:{detail:{current:number}}){stop();measure(event.detail.current-(props.video?1:0));}
function preview(image:string){if(props.active&&props.images.includes(image))uni.previewImage({urls:[...props.images],current:image});}
function retryImage(){if(!props.active||disposed)return;imageKey.value++;measure();}
function retryVideo(){if(!props.active||!props.video||disposed)return;videoError.value='';const key=++videoKey.value;void nextTick(()=>{if(!disposed&&props.active&&key===videoKey.value&&typeof uni.createVideoContext==='function'){try{uni.createVideoContext('ordinary-product-video',instance?.proxy??undefined).play();}catch{videoHandlers.value.error();}}});}
watch(()=>[props.images,props.video,props.pictureConfig,props.active],()=>{generation++;videoKey.value++;imageKey.value++;stop();videoError.value='';measure();},{immediate:true,flush:'sync'});
onUnmounted(()=>{disposed=true;generation++;stop();});
</script>
<style scoped>.product-media{background:#fff}.media-swiper{width:100%;max-height:1600px}.media-image,.product-video{height:100%;width:100%}.media-error{padding:20rpx;color:#a72823}</style>
