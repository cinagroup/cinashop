<template>
  <view class="presentation-video-box" :style="{height:height+'px'}" :data-ratio="ratio" :data-state="error?'error':playing?'playing':'paused'">
    <video v-if="allowed() && !error" :key="attempt" :id="videoId" class="presentation-video" :src="src" :poster="poster" :initial-time="start" controls object-fit="cover" :autoplay="false" @loadedmetadata="events.metadata" @timeupdate="events.time" @play="events.play" @pause="events.pause" @ended="events.pause" @error="events.failed" />
    <view v-if="error" class="presentation-video-error" role="alert">视频读取失败<button size="mini" @tap="retry">重试视频</button></view>
  </view>
</template>
<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, onScopeDispose, ref } from 'vue';
const props=withDefaults(defineProps<{src:string;poster?:string;ratio:number;natural?:boolean;allowed:()=>boolean;start?:number}>(),{poster:'',start:0,natural:false});
const emit=defineEmits<{position:[value:number]}>();
const instance=getCurrentInstance(),attempt=ref(0),videoId=computed(()=>`diy-presentation-video-${instance?.uid??0}-${attempt.value}`),width=ref(0),naturalRatio=ref(0),playing=ref(false),error=ref(false);let alive=true,measurement=0;
const height=computed(()=>width.value*(props.natural&&naturalRatio.value?naturalRatio.value:props.ratio));
function pause(){playing.value=false;try{uni.createVideoContext(videoId.value,instance?.proxy??undefined).pause();}catch{}}
function measure(){const revision=++measurement;void nextTick(()=>{if(!alive||!props.allowed())return;uni.createSelectorQuery().in(instance?.proxy).select('.presentation-video-box').boundingClientRect(value=>{const row=Array.isArray(value)?value[0]:value;if(alive&&props.allowed()&&revision===measurement&&row&&typeof row.width==='number'&&Number.isFinite(row.width)&&row.width>0)width.value=row.width;}).exec();});}
function metadata(event:unknown,ticket=attempt.value){if(!alive||ticket!==attempt.value||!props.allowed())return;const d=(event as {detail?:{width?:unknown;height?:unknown}})?.detail;if(d&&typeof d.width==='number'&&typeof d.height==='number'&&Number.isFinite(d.width)&&Number.isFinite(d.height)&&d.width>0&&d.height>0)naturalRatio.value=d.height/d.width;}
function time(event:unknown,ticket=attempt.value){if(!alive||ticket!==attempt.value||!props.allowed())return;const value=(event as {detail?:{currentTime?:unknown}})?.detail?.currentTime;if(typeof value==='number'&&Number.isFinite(value)&&value>=0)emit('position',value);}
function play(ticket=attempt.value){if(!alive||ticket!==attempt.value)return;if(!props.allowed()){pause();return;}playing.value=true;}
function failed(ticket=attempt.value){if(alive&&ticket===attempt.value&&props.allowed()){pause();error.value=true;}}
function retry(){if(alive&&props.allowed()){attempt.value++;error.value=false;}}
const events=computed(()=>{const ticket=attempt.value;return {metadata:(e:unknown)=>metadata(e,ticket),time:(e:unknown)=>time(e,ticket),play:()=>play(ticket),pause:()=>{if(alive&&ticket===attempt.value&&props.allowed())playing.value=false;},failed:()=>failed(ticket)};});
onMounted(()=>{measure();uni.onWindowResize?.(measure);});
onScopeDispose(()=>{alive=false;measurement++;uni.offWindowResize?.(measure);pause();});
</script>
<style scoped>
.presentation-video-box{width:100%;position:relative;min-width:0;overflow:hidden;}.presentation-video{display:block;width:100%;height:100%;}.presentation-video-error{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:80rpx;background:#f5f5f5;color:#777;font-size:26rpx;}
</style>
