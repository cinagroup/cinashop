<template>
  <rich-text v-if="!node.interactive" class="presentation-rich-passive" :nodes="[node]" @itemclick="passiveClick" />
  <DiyPresentationVideo v-else-if="node.type==='node' && node.name==='video' && node.attrs.src" :src="node.attrs.src" :ratio="9/16" natural :allowed="allowed" :start="positions[node.mediaIndex??0]??0" @tap.stop @position="emit('position',{index:node.type==='node'?node.mediaIndex??0:0,value:$event})" />
  <view v-else-if="node.type==='node' && node.name==='table'" class="presentation-html-table presentation-table-grid" :style="[table.style,node.attrs.style]" role="table" @tap.stop="tap">
    <view v-for="(cell,index) in table.cells" :key="index" :class="['presentation-table-cell','presentation-html-'+cell.node.name]" :data-column="cell.column" :data-row="cell.row" :data-colspan="cell.columnSpan" :data-rowspan="cell.rowSpan" :style="[semantic(cell.node),cell.sectionStyle,cell.rowStyle,cell.node.attrs.style,cell.style]" :role="cell.node.name==='th'?'columnheader':cell.node.name==='caption'?'caption':'cell'">
      <DiyPresentationRichNode v-for="(child,childIndex) in cell.node.children" :key="childIndex" :node="child" :allowed="allowed" :positions="positions" :link="nearestLink" @position="emit('position',$event)" @link="emit('link',$event)" />
    </view>
  </view>
  <view v-else-if="node.type==='node' && (node.name==='ol'||node.name==='ul')" :class="['presentation-html-'+node.name,'presentation-list']" :style="[semantic(node),node.attrs.style]" role="list" @tap.stop="tap">
    <view v-for="(item,index) in list" :key="index" class="presentation-list-item" :style="item.node.type==='node'?item.node.attrs.style:undefined" role="listitem">
      <text v-if="item.marker" class="presentation-list-marker">{{item.marker}}</text><view class="presentation-list-content"><DiyPresentationRichNode v-for="(child,childIndex) in item.children" :key="childIndex" :node="child" :allowed="allowed" :positions="positions" :link="nearestLink" @position="emit('position',$event)" @link="emit('link',$event)" /></view>
    </view>
  </view>
  <view v-else-if="node.type==='node'" :class="['presentation-html-'+node.name,{'presentation-html-link':node.name==='a'}]" :style="[semantic(node),node.attrs.style]" :role="node.name==='a'?'link':undefined" @tap.stop="tap">
    <DiyPresentationRichNode v-for="(child,index) in node.children" :key="index" :node="child" :allowed="allowed" :positions="positions" :link="nearestLink" @position="emit('position',$event)" @link="emit('link',$event)" />
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DiyPresentationHtmlNode } from '../../../../common/diyPresentationHtml';
import { presentationRichStyle as semantic,presentationListItems,presentationTableGrid } from '@/utils/diyPresentationRichLayout';
import DiyPresentationVideo from './DiyPresentationVideo.vue';
const props=defineProps<{node:DiyPresentationHtmlNode;allowed:()=>boolean;positions:Record<number,number>;link?:string}>();
const emit=defineEmits<{position:[event:{index:number;value:number}];link:[href:string]}>();
const nearestLink=computed(()=>props.node.type==='node'&&props.node.name==='a'&&props.node.attrs.href?props.node.attrs.href:props.link);
const table=computed(()=>presentationTableGrid(props.node)),list=computed(()=>presentationListItems(props.node));
function passiveClick(){if(nearestLink.value&&props.allowed())emit('link',nearestLink.value);}
function tap(event:unknown){if(!props.allowed()||!nearestLink.value)return;(event as {stopPropagation?:()=>void}).stopPropagation?.();emit('link',nearestLink.value);}
</script>
<style scoped>
.presentation-rich-passive{display:inline;}.presentation-html-link{color:#007aff;text-decoration:underline;}.presentation-html-q::before{content:open-quote;}.presentation-html-q::after{content:close-quote;}.presentation-list-item{display:flex;align-items:flex-start;min-width:0;}.presentation-list-marker{display:inline-block;flex-shrink:0;min-width:1.8em;text-align:right;margin-right:.4em;}.presentation-list-content{flex:1;min-width:0;}.presentation-html-th{font-weight:bold;text-align:center;}.presentation-table-cell{overflow-wrap:anywhere;}
/* #ifdef H5 */
.presentation-rich-passive :deep(> div){display:contents;}
/* #endif */
</style>
