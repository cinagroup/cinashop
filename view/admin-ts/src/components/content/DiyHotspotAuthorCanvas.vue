<template>
  <section class="hotspot-author-canvas" aria-label="750 像素热区画布">
    <p class="hint">在图片空白处拖画热区；拖动区域移动，拖右下角缩放。坐标按原版 750 像素宽度保存，Esc 取消本次拖动。</p>
    <div ref="host" class="canvas" tabindex="0" :style="{aspectRatio: height ? `750 / ${height}` : undefined}" @pointerdown="beginCreate" @pointermove="move" @pointerup="finish" @pointercancel="cancel" @lostpointercapture="cancel" @keydown.esc.stop.prevent="cancel">
      <img v-if="image" :key="loadSession.key" :src="image" alt="热区背景" draggable="false" @load="loadSession.load" @error="loadSession.error" />
      <p v-else class="empty">先选择热区背景图片</p>
      <template v-if="ready">
        <div v-for="area in visible" :key="area.index" class="area" :class="{selected:selection===area.index}" :style="area.style" :aria-label="`热区 ${area.index+1}`" @pointerdown.stop.prevent="begin($event,area.index,'move')">
          <span>{{area.index+1}}</span><button type="button" class="resize" :disabled="disabled" :aria-label="`缩放热区 ${area.index+1}`" @pointerdown.stop.prevent="begin($event,area.index,'resize')" />
        </div>
        <div v-if="drag?.mode==='create' && drag.rect" class="area draft" :style="style(drag.rect)" />
      </template>
    </div>
    <p v-if="image && !ready" class="hint" role="status">图片未就绪或预览已失效，暂不能绘制热区。</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { clampEditorialRect, editorialRect, type EditorialRect } from '@/utils/diyEditorialEditor';
const props=defineProps<{image:string;imageIdentity:string;areas:unknown[];editorKey:string;disabled:boolean;allowed:()=>boolean}>();
const emit=defineEmits<{create:[rect:EditorialRect];rect:[index:number,rect:EditorialRect];select:[index:number]}>();
const host=ref<HTMLElement|null>(null),height=ref(0),selection=ref(-1),loaded=ref('');let alive=true;
type Drag={pointer:number;mode:'create'|'move'|'resize';index:number;x:number;y:number;start:EditorialRect;rect:EditorialRect;key:string;raw:string;width:number;left:number;top:number};
const drag=ref<Drag|null>(null),key=computed(()=>`${props.editorKey}:${props.imageIdentity}:${props.image}`),ready=computed(()=>alive&&!props.disabled&&props.allowed()&&loaded.value===key.value&&height.value>0);
function cancel(){const pointer=drag.value?.pointer;drag.value=null;if(pointer!==undefined&&host.value?.hasPointerCapture?.(pointer))host.value.releasePointerCapture(pointer);}
watch(()=>[props.image,props.imageIdentity,props.editorKey,props.areas,props.disabled],()=>{cancel();loaded.value='';height.value=0;},{flush:'sync'});
const loadSession=computed(()=>{const issued=key.value;return{key:issued,load:(event:Event)=>{if(!alive||issued!==key.value||!props.allowed()||props.disabled||event.target!==host.value?.querySelector('img'))return;const image=event.target as HTMLImageElement;if(image.naturalWidth>0&&image.naturalHeight>0){height.value=750*image.naturalHeight/image.naturalWidth;loaded.value=issued;}},error:()=>{if(issued===key.value){cancel();loaded.value='';height.value=0;}}};});
function style(rect:EditorialRect){return{left:`${rect.starX/750*100}%`,top:`${rect.starY/height.value*100}%`,width:`${rect.areaWidth/750*100}%`,height:`${rect.areaHeight/height.value*100}%`};}
const visible=computed(()=>!ready.value?[]:props.areas.flatMap((raw,index)=>{const rect=drag.value?.index===index?drag.value.rect:editorialRect(raw);if(!rect)return[];const clipped=clampEditorialRect(rect,height.value);return clipped.areaWidth>0&&clipped.areaHeight>0?[{index,style:style(clipped)}]:[];}));
function beginCreate(event:PointerEvent){if(event.target!==host.value&&event.target!==(host.value?.querySelector('img')))return;begin(event,-1,'create');}
function begin(event:PointerEvent,index:number,mode:Drag['mode']){
  if(!ready.value||event.button!==0||drag.value||!host.value)return;
  const bounds=host.value.getBoundingClientRect();if(bounds.width<=0)return;
  const x=Math.max(0,Math.min(750,(event.clientX-bounds.left)*750/bounds.width)),y=Math.max(0,Math.min(height.value,(event.clientY-bounds.top)*750/bounds.width));
  const original=mode==='create'?{starX:x,starY:y,areaWidth:0,areaHeight:0}:editorialRect(props.areas[index]);if(!original)return;
  const start=clampEditorialRect(original,height.value);drag.value={pointer:event.pointerId,mode,index,x,y,start,rect:{...start},key:key.value,raw:JSON.stringify(props.areas),width:bounds.width,left:bounds.left,top:bounds.top};
  selection.value=index;emit('select',index);host.value.focus();host.value.setPointerCapture?.(event.pointerId);event.preventDefault();
}
function valid(d:Drag){const bounds=host.value?.getBoundingClientRect();return ready.value&&d.key===key.value&&d.raw===JSON.stringify(props.areas)&&!!bounds&&bounds.width===d.width&&bounds.left===d.left&&bounds.top===d.top;}
function move(event:PointerEvent){const d=drag.value;if(!d||event.pointerId!==d.pointer)return;if(!valid(d)){cancel();return;}const x=Math.max(0,Math.min(750,(event.clientX-d.left)*750/d.width)),y=Math.max(0,Math.min(height.value,(event.clientY-d.top)*750/d.width));
  if(d.mode==='create')d.rect={starX:Math.min(d.x,x),starY:Math.min(d.y,y),areaWidth:Math.abs(x-d.x),areaHeight:Math.abs(y-d.y)};
  else if(d.mode==='move')d.rect={...d.start,starX:Math.max(0,Math.min(750-d.start.areaWidth,d.start.starX+x-d.x)),starY:Math.max(0,Math.min(height.value-d.start.areaHeight,d.start.starY+y-d.y))};
  else d.rect={...d.start,areaWidth:Math.max(1,Math.min(750-d.start.starX,d.start.areaWidth+x-d.x)),areaHeight:Math.max(1,Math.min(height.value-d.start.starY,d.start.areaHeight+y-d.y))};
}
function finish(event:PointerEvent){const d=drag.value;if(!d||d.pointer!==event.pointerId)return;move(event);const accepted=valid(d),rect={...d.rect};cancel();if(!accepted)return;if(d.mode==='create'){if(rect.areaWidth>10&&rect.areaHeight>10)emit('create',rect);}else if(JSON.stringify(rect)!==JSON.stringify(d.start))emit('rect',d.index,rect);}
onBeforeUnmount(()=>{alive=false;cancel();});
</script>
<style scoped>
.canvas{position:relative;max-width:375px;width:100%;min-height:80px;background:#f5f5f5;touch-action:none;overflow:hidden;outline-offset:3px}.canvas>img{display:block;width:100%;height:auto;user-select:none;pointer-events:auto}.area{position:absolute;box-sizing:border-box;border:1px solid #2d8cf0;background:#2d8cf033;cursor:move;touch-action:none}.area.selected{border:2px solid #2d8cf0}.area>span{position:absolute;top:0;left:0;background:#2d8cf0;color:white;font-size:12px;line-height:18px;min-width:18px;text-align:center;pointer-events:none}.resize{position:absolute;right:-1px;bottom:-1px;width:14px;height:14px;background:#2d8cf0;border:2px solid white;cursor:nwse-resize;touch-action:none}.draft{pointer-events:none}.empty{padding:24px;color:#999;text-align:center}.hint{font-size:12px;color:#909399;line-height:1.6}
</style>
