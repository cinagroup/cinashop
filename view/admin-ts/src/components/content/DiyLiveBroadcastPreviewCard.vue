<template>
  <div class="live-broadcast-card live-broadcast-preview-card" :data-live-id="room.id" :data-room-id="room.room_id" :data-live-compact="card.compact" :style="px(card.cardStyle)">
    <div v-if="card.showCover" class="live-broadcast-cover-frame" :style="px(card.frameStyle)">
      <template v-for="cover in [media.cover]" :key="cover.key"><img v-if="cover.src" :key="cover.key" class="live-broadcast-cover" :src="cover.src" :style="px(card.imageStyle)" @load="cover.loaded" @error="cover.failed" /><div v-else class="live-broadcast-empty-cover" :style="px(card.imageStyle)">暂无直播封面</div></template>
      <div class="live-broadcast-status" :style="px(card.badgeStyle)">
        <div v-if="card.showPreviewTime" :style="px(card.previewTagStyle)">预告</div>
        <template v-else><span v-if="card.liveIcon" class="live-broadcast-video-icon" :style="px(card.iconStyle)">&#xe6a4;</span><span>{{card.label}}</span></template>
        <span v-if="card.showPreviewTime">{{room.show_time}}</span>
      </div>
    </div>
    <div v-if="card.showInfo" class="live-broadcast-info" :style="px(card.infoStyle)">
      <div v-if="card.compact" class="live-broadcast-title-row" :style="px(card.titleRowStyle)">
        <div class="live-broadcast-status" :style="px(card.badgeStyle)"><span v-if="card.liveIcon" class="live-broadcast-video-icon" :style="px(card.iconStyle)">&#xe6a4;</span><span>{{card.label}}</span></div>
        <div v-if="view.showTitle" class="live-broadcast-title" :style="px(card.titleStyle)">{{room.name}}</div>
      </div>
      <div v-else-if="view.showTitle" class="live-broadcast-title" :style="px(card.titleStyle)">{{room.name}}</div>
      <div v-if="card.showGoods" class="live-broadcast-goods" :style="px(card.goodsStyle)">
        <div v-for="good in room.goods" :key="good.id" class="live-broadcast-good" :style="px(card.goodStyle)">
          <template v-for="image in [media.goods[good.id]]" :key="image.key"><img v-if="image.src" :key="image.key" class="live-broadcast-good-image" :src="image.src" :style="px(card.goodImageStyle)" @load="image.loaded" @error="image.failed" /></template>
          <div class="live-broadcast-good-price" :style="px(liveBroadcastGoodMoneyStyle(good.price,card.goodMoneyStyle))">¥{{good.price}}</div>
        </div>
      </div>
      <div v-else-if="card.showAnchor" class="live-broadcast-anchor" :style="px(card.anchorStyle)">
        <template v-for="image in [media.anchor]" :key="image.key"><img v-if="image.src" :key="image.key" class="live-broadcast-avatar" :src="image.src" :style="px(card.avatarStyle)" @load="image.loaded" @error="image.failed" /></template>
        <span>主播：{{room.anchor_name}}</span><span v-if="card.showTailTime" :style="px(card.tailTimeStyle)">{{room.show_time}}</span>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed,ref,watch,onBeforeUnmount } from 'vue';
import { liveBroadcastCardPresentation,liveBroadcastGoodMoneyStyle,type DiyLiveBroadcastPresentation } from '../../../../common/diyLiveBroadcast';
import type { DiyLiveBroadcastRoom } from '../../../../common/diyLiveBroadcastData';
import { liveBroadcastPreviewStyle as px } from '@/utils/diyLiveBroadcastProjection';
const props=defineProps<{room:DiyLiveBroadcastRoom;index:number;view:DiyLiveBroadcastPresentation}>();
const card=computed(()=>liveBroadcastCardPresentation(props.view,props.room,props.index));
const epoch=ref(0),failed=ref<Record<string,boolean>>({}),loaded=ref<Record<string,boolean>>({});let alive=true;
watch(()=>[props.room,props.room.cover_img,props.room.anchor_img,...props.room.goods.map(good=>`${good.id}:${good.cover_img}`)],()=>{epoch.value++;failed.value={};loaded.value={};},{immediate:true,flush:'sync'});
onBeforeUnmount(()=>{alive=false;epoch.value++;});
const media=computed(()=>{const version=epoch.value,room=props.room,current=()=>alive&&epoch.value===version&&props.room===room;
 const image=(key:string,src:string)=>({key:`${version}:${key}:${src}`,src:failed.value[key]?'':src,loaded:()=>{if(current())loaded.value={...loaded.value,[key]:true};},failed:()=>{if(current()){epoch.value++;failed.value={...failed.value,[key]:true};loaded.value={...loaded.value,[key]:false};}}});
 return{cover:image('cover',room.cover_img),anchor:image('anchor',room.anchor_img),goods:Object.fromEntries(room.goods.map(good=>[good.id,image(`goods:${good.id}`,good.cover_img)]))};
});
</script>
<style src="../../../../common/diyLiveBroadcastIcon.css"></style>
<style scoped>
.live-broadcast-empty-cover{display:flex!important;align-items:center;justify-content:center;background:#F3F9FF;color:#999;font-size:3.2cqw}.live-broadcast-video-icon{font-family:DIYBargainFire!important;font-style:normal;font-weight:normal}.live-broadcast-card{box-sizing:border-box}img{object-fit:cover}
</style>
