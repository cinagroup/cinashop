<template>
  <view class="hotspot-card" :data-image-state="imageState">
    <image class="hotspot-image" :src="image" mode="widthFix" :style="radiusStyle" @load="loaded" @error="failed" />
    <view v-if="imageState==='error'" class="hotspot-error" role="alert">热区图片读取失败<button size="mini" @tap="retry">重试图片</button></view>
    <view v-for="area in visibleAreas" :key="area.index" class="hotspot-area" :data-area-index="area.index" :style="area.style" :aria-label="`热区 ${area.index+1}`" @tap.stop="openArea(area.index)" />
  </view>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue';
import { projectDiyHotspots, type DiyHotspotArea } from '@/utils/diyEditorialConfig';
const props = defineProps<{image:string;areas:DiyHotspotArea[];radiusStyle:Record<string,string>;allowed:()=>boolean}>();
const emit = defineEmits<{open:[link:string];retry:[]}>();
const size=ref<{width:number;height:number}|null>(null), imageState=ref<'loading'|'ready'|'error'>('loading');let alive=true;
const visibleAreas=computed(()=>alive && props.allowed() && size.value ? projectDiyHotspots(props.areas,size.value.width,size.value.height):[]);
function loaded(event: unknown){if(!alive||!props.allowed())return;const detail=(event as {detail?:{width?:number;height?:number}})?.detail;const width=Number(detail?.width),height=Number(detail?.height);if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0){failed();return;}size.value={width,height};imageState.value='ready';}
function failed(){if(!alive||!props.allowed())return;size.value=null;imageState.value='error';}
function retry(){if(alive&&props.allowed())emit('retry');}
function openArea(index:number){if(!alive||!props.allowed())return;const area=visibleAreas.value.find(row=>row.index===index);if(area)emit('open',area.link);}
onScopeDispose(()=>{alive=false;size.value=null;});
</script>
<style scoped>
.hotspot-card{position:relative;width:100%;overflow:hidden;}.hotspot-image{display:block;width:100%;height:auto;}.hotspot-area{position:absolute;z-index:2;}.hotspot-error{padding:20rpx;font-size:24rpx;color:#a32920;}
</style>
