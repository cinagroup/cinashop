<template>
  <view class="live-broadcast-card" :data-live-id="room.id" :data-room-id="room.room_id" :data-live-compact="card.compact" :style="card.cardStyle" @tap="tap">
    <view v-if="card.showCover" class="live-broadcast-cover-frame" :style="card.frameStyle">
      <template v-for="cover in [media.cover]" :key="cover.key"><image v-if="cover.src" :key="cover.key" class="live-broadcast-cover" :src="cover.src" :style="card.imageStyle" mode="aspectFill" @load="cover.loaded" @error="cover.failed" /><view v-else class="live-broadcast-empty-cover" :style="card.imageStyle">暂无直播封面</view></template>
      <view class="live-broadcast-status" :style="card.badgeStyle">
        <view v-if="card.showPreviewTime" :style="card.previewTagStyle">预告</view>
        <template v-else><text v-if="card.liveIcon" class="live-broadcast-video-icon" :style="card.iconStyle">&#xe6a4;</text><text>{{card.label}}</text></template>
        <text v-if="card.showPreviewTime">{{room.show_time}}</text>
      </view>
    </view>
    <view v-if="card.showInfo" class="live-broadcast-info" :style="card.infoStyle">
      <view v-if="card.compact" class="live-broadcast-title-row" :style="card.titleRowStyle">
        <view class="live-broadcast-status" :style="card.badgeStyle"><text v-if="card.liveIcon" class="live-broadcast-video-icon" :style="card.iconStyle">&#xe6a4;</text><text>{{card.label}}</text></view>
        <view v-if="view.showTitle" class="live-broadcast-title" :style="card.titleStyle">{{room.name}}</view>
      </view>
      <view v-else-if="view.showTitle" class="live-broadcast-title" :style="card.titleStyle">{{room.name}}</view>
      <view v-if="card.showGoods" class="live-broadcast-goods" :style="card.goodsStyle">
        <view v-for="good in room.goods" :key="good.id" class="live-broadcast-good" :style="card.goodStyle">
          <template v-for="image in [media.goods[good.id]]" :key="image.key"><image v-if="image.src" :key="image.key" class="live-broadcast-good-image" :src="image.src" :style="card.goodImageStyle" mode="aspectFill" @load="image.loaded" @error="image.failed" /></template>
          <view class="live-broadcast-good-price" :style="liveBroadcastGoodMoneyStyle(good.price,card.goodMoneyStyle)">¥{{good.price}}</view>
        </view>
      </view>
      <view v-else-if="card.showAnchor" class="live-broadcast-anchor" :style="card.anchorStyle">
        <template v-for="image in [media.anchor]" :key="image.key"><image v-if="image.src" :key="image.key" class="live-broadcast-avatar" :src="image.src" :style="card.avatarStyle" mode="aspectFill" @load="image.loaded" @error="image.failed" /></template>
        <text>主播：{{room.anchor_name}}</text><text v-if="card.showTailTime" :style="card.tailTimeStyle">{{room.show_time}}</text>
      </view>
    </view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { liveBroadcastCardPresentation, liveBroadcastGoodMoneyStyle, type DiyLiveBroadcastPresentation } from '../../../../common/diyLiveBroadcast';
import type { DiyLiveBroadcastRoom } from '../../../../common/diyLiveBroadcastData';
type ImageLease = { key: string; src: string; loaded: () => void; failed: () => void };
const props = defineProps<{room:DiyLiveBroadcastRoom;index:number;view:DiyLiveBroadcastPresentation;tap:()=>void;media:{cover:ImageLease;anchor:ImageLease;goods:Record<number,ImageLease>}}>();
const card = computed(() => liveBroadcastCardPresentation(props.view, props.room, props.index));
</script>
<style src="../../../../common/diyLiveBroadcastIcon.css"></style>
<style scoped>
.live-broadcast-empty-cover{display:flex!important;align-items:center;justify-content:center;background:#F3F9FF;color:#999;font-size:24rpx}.live-broadcast-video-icon{font-family:DIYBargainFire!important;font-style:normal;font-weight:normal}.live-broadcast-card{box-sizing:border-box}
</style>
