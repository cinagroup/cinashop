<template>
  <view class="carousel-canvas" :data-state="imageState" :data-index="index" :data-height="height" :style="{'--carousel-inactive-scale':config.inactiveScale}">
    <view v-if="imageState==='error'" class="carousel-status" role="alert">轮播图片读取失败<button size="mini" @tap="retry">重试图片</button></view>
    <template v-if="config.stacked">
      <view v-for="(item,i) in config.items" :key="item.index" class="carousel-slide stacked" :style="config.imageStyle" @tap="open(i)"><image :src="item.image" mode="widthFix" :style="config.imageStyle" @load="loaded($event,i)" @error="failed(i)" /><view v-if="errors.has(i)" class="carousel-image-error" role="alert">图片读取失败<button size="mini" @tap.stop="retry">重试图片</button></view></view>
    </template>
    <template v-else>
      <view v-if="imageState==='loading'" class="carousel-status" role="status">图片加载中…</view>
      <swiper class="carousel-swiper" :style="{height:height+'rpx'}" :current="index" :autoplay="allowed() && imageState==='ready'" circular :interval="config.interval" :duration="config.duration" :previous-margin="config.previousMargin" :next-margin="config.previousMargin" @change="changed">
        <swiper-item v-for="(item,i) in config.items" :key="item.index"><view class="carousel-slide" :class="{selected:i===index}" :style="config.slideStyle" @tap="open(i)"><image :src="item.image" :mode="config.kind==='swipers'?'widthFix':'aspectFill'" :style="config.imageStyle" @load="loaded($event,i)" @error="failed(i)" /><view v-if="errors.has(i)" class="carousel-image-error" role="alert">图片读取失败<button size="mini" @tap.stop="retry">重试图片</button></view></view></swiper-item>
      </swiper>
      <view class="carousel-dots" :class="`indicator-${config.indicator}`" :style="{justifyContent:['flex-start','center','flex-end'][config.dotPosition]}">
        <view v-if="config.indicator===2" class="carousel-progress" :style="{width:config.items.length*20+'rpx',background:config.dotBackground}"><view :style="{width:(index+1)/config.items.length*100+'%',background:config.dotColor}" /></view>
        <view v-for="(_,i) in config.indicator===2?[]:config.items" :key="i" class="carousel-dot" :class="{selected:i===index}" :style="{...config.dotShape,background:i===index?config.dotColor:config.dotBackground}" />
      </view>
    </template>
  </view>
</template>
<script setup lang="ts">
import { onScopeDispose, ref } from 'vue';
import type { DiyCarouselConfig } from '@/utils/diyCarouselConfig';
const props=defineProps<{config:DiyCarouselConfig;allowed:()=>boolean}>();
const emit=defineEmits<{open:[index:number];change:[index:number];retry:[]}>();
const imageState=ref<'loading'|'ready'|'error'>('loading'), index=ref(0), height=ref(props.config.kind==='homeComb'?320:375); let alive=true;
const images=ref(new Set<number>()),errors=ref(new Set<number>());
function loaded(event:unknown, item=0) {
  if(!alive||!props.allowed())return;
  const detail=(event as {detail?:{width?:unknown;height?:unknown}})?.detail, width=Number(detail?.width), naturalHeight=Number(detail?.height);
  if(!Number.isInteger(item)||!props.config.items[item])return;
  if(!Number.isFinite(width)||!Number.isFinite(naturalHeight)||width<=0||naturalHeight<=0){failed(item);return;}
  images.value.add(item);errors.value.delete(item);
  if(item!==0)return;
  const cfg=props.config;
  height.value=cfg.kind==='homeComb'?320:cfg.kind==='swipers'?naturalHeight+10:naturalHeight/width*Math.max(1,750-cfg.horizontalPadding*2);
  imageState.value='ready';
}
function failed(item=0){if(alive&&props.allowed()&&props.config.items[item]){images.value.delete(item);errors.value.add(item);if(item===0)imageState.value='error';}}
function retry(){if(alive&&props.allowed())emit('retry');}
function changed(event:unknown){if(!alive||!props.allowed())return;const value=Number((event as {detail?:{current?:unknown}})?.detail?.current);if(!Number.isInteger(value)||value<0||value>=props.config.items.length)return;index.value=value;emit('change',value);}
function open(value:number){if(alive&&props.allowed()&&images.value.has(value)&&props.config.items[value])emit('open',value);}
onScopeDispose(()=>{alive=false;imageState.value='loading';});
</script>
<style scoped>
.carousel-canvas{position:relative;width:100%;overflow:hidden;}.carousel-swiper{width:100%;}.carousel-slide,.carousel-slide image{width:100%;height:100%;display:block;}.carousel-slide{position:relative;transform:scale(var(--carousel-inactive-scale,.93));transition:transform .3s;overflow:hidden;}.carousel-slide.selected{transform:scale(1);}.stacked{transform:none;}.stacked image{height:auto;}.carousel-status,.carousel-image-error{padding:24rpx;text-align:center;color:#888;font-size:25rpx;background:#f5f5f5;}.carousel-image-error{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;}.carousel-dots{position:absolute;bottom:20rpx;left:20rpx;right:20rpx;display:flex;gap:16rpx;pointer-events:none;}.carousel-dot{width:12rpx;height:12rpx;border-radius:6rpx;}.indicator-1{gap:8rpx;}.indicator-1 .carousel-dot{width:10rpx;height:10rpx;}.indicator-1 .carousel-dot.selected{width:18rpx;}.indicator-3{gap:10rpx;}.indicator-3 .carousel-dot{width:20rpx;height:6rpx;border-radius:3rpx;}.carousel-progress,.carousel-progress>view{height:6rpx;border-radius:3rpx;}.carousel-progress>view{transition:width .3s;}
</style>
