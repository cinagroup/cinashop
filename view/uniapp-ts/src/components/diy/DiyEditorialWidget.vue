<template>
  <view v-if="active && config.enabled && config.kind==='news' && config.newsItems.length" class="editorial-wrap diy-editorial" data-kind="news" :data-component-key="config.identity" :style="config.outerStyle">
    <view v-if="config.newsListStyle" class="news-card" :style="config.cardStyle">
      <view class="news-heading"><image v-if="config.titleImage" class="news-logo" :src="config.titleImage" mode="aspectFit" /><text v-else class="news-title" :style="config.titleStyle">{{config.titleText}}</text><button v-if="config.showMore" class="editorial-more" :style="config.buttonStyle" :disabled="!config.moreLink" @tap="open(config.moreLink)">{{config.moreText}} ›</button></view>
      <view v-for="(item,index) in config.newsItems" :key="index" class="news-list-item" :data-news-index="index" :style="config.newsTextStyle" @tap="open(item.link)"><text class="news-number" :class="`rank-${index+1}`">{{index+1}}</text><text class="news-copy">{{item.title}}</text></view>
    </view>
    <view v-else class="news-ticker" :style="config.cardStyle">
      <image v-if="config.titleImage" class="news-ticker-logo" :src="config.titleImage" mode="aspectFit" /><text v-else class="news-ticker-title" :style="config.tickerTitleStyle">{{config.titleText}}</text>
      <view v-if="config.horizontalNews" class="news-horizontal" :style="config.newsTextStyle" @tap="open(config.newsItems[0]?.link || '')"><text class="news-marquee" :style="horizontalStyle">{{config.newsItems[0]?.title}}</text></view>
      <swiper v-else class="news-swiper" :autoplay="active" circular vertical :interval="2500"><swiper-item v-for="(item,index) in config.newsItems" :key="index"><view class="news-swiper-item" :data-news-index="index" :style="config.newsTextStyle" @tap="open(item.link)">{{item.title}}</view></swiper-item></swiper>
      <button v-if="config.showMore" class="editorial-more" :style="config.buttonStyle" :disabled="!config.moreLink" @tap="open(config.moreLink)">›</button>
    </view>
  </view>
  <view v-else-if="active && config.enabled && config.kind==='hotspot' && config.hotspotImage" class="editorial-wrap diy-editorial" data-kind="hotspot" :data-component-key="config.identity" :style="config.outerStyle">
    <DiyHotspotCanvas :key="epoch" :image="config.hotspotImage" :areas="config.hotspotAreas" :radius-style="config.radiusStyle" :allowed="state.lease()" @open="open" @retry="retryHotspot" />
  </view>
  <view v-else-if="active && config.enabled && config.kind==='activeParty' && config.partyItems.length" class="editorial-wrap diy-editorial" data-kind="activeParty" :data-component-key="config.identity" :style="config.outerStyle">
    <view class="party-card" :style="config.partyStyle"><view class="party-heading"><text class="party-title" :style="config.partyTitleStyle">{{config.partyTitle}}</text><text v-if="config.partyBadge" class="party-badge" :style="config.partyBadgeStyle">{{config.partyBadge}}</text></view><view class="party-grid"><view v-for="(item,index) in config.partyItems" :key="index" class="party-item" :data-party-index="index" @tap="open(item.link)"><view class="party-copy"><text class="party-item-title">{{item.title}}</text><text v-if="item.description" class="party-item-description">{{item.description}}</text><text class="party-go" :style="config.partyTitleStyle">GO！</text></view><image v-if="item.image" class="party-image" :src="item.image" mode="aspectFill" /></view></view></view>
  </view>
  <view v-else-if="active && config.enabled && config.kind==='follow' && !followDismissed" class="editorial-wrap diy-editorial" data-kind="follow" :data-component-key="config.identity" :style="config.followWrapStyle">
    <view class="follow-card" :style="config.followCardStyle"><view class="follow-profile"><image v-if="config.followImage" class="follow-avatar" :src="config.followImage" mode="aspectFill" /><view v-else class="follow-avatar follow-placeholder">微</view><text class="follow-title">{{config.followTitle}}</text></view><button class="follow-button" size="mini" :style="config.followButtonStyle" @tap="showFollowCode">关注</button><text class="follow-close" @tap.stop="dismissFollow">×</text></view>
    <!-- #ifdef MP-WEIXIN -->
    <official-account class="follow-official" />
    <!-- #endif -->
    <view v-if="followCodeOpen" class="follow-modal" @tap="closeFollow"><view class="follow-dialog" @tap.stop><text class="follow-dialog-title">关注公众号</text><text class="follow-dialog-copy">当前组件二维码</text><image class="follow-code" :src="config.followCode" mode="aspectFit" show-menu-by-longpress /><text class="follow-dialog-tip">长按二维码保存或识别</text><button class="follow-save" size="mini" :loading="followPosterLoading" :disabled="followPosterLoading" @tap="saveFollowCode">预览或保存当前二维码</button><button class="follow-poster" size="mini" :loading="followPosterLoading" :disabled="followPosterLoading" @tap="previewFollowPoster">生成并预览站点关注海报</button><text class="follow-dialog-tip">海报使用站点的公众号配置</text><text v-if="followPosterError" class="follow-dialog-tip" role="alert">{{followPosterError}}</text><button class="follow-dialog-close" size="mini" @tap="closeFollow">关闭</button></view></view>
  </view>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DiyComponent } from '@/api/diy';
import { useDiyEditorialWidget } from '@/composables/useDiyEditorialWidget';
import DiyHotspotCanvas from './DiyHotspotCanvas.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean}>(),{active:true});
const state=useDiyEditorialWidget(()=>props.block,()=>props.active);
const {config,epoch,followCodeOpen,followDismissed,followPosterLoading,followPosterError,open,showFollowCode,closeFollow,dismissFollow,previewFollowPoster,saveFollowCode}=state;
const horizontalStyle=computed(()=>({animationDuration:`${Math.max(4,(config.value.newsItems[0]?.title.length || 0)*0.28)}s`}));
function retryHotspot(){if(state.ready() && config.value.kind==='hotspot')epoch.value++;}
</script>
<style scoped>
.editorial-wrap { width: 100%; box-sizing: border-box; }
.news-card { margin: 0; padding: 28rpx 24rpx; overflow: hidden; }
.news-heading { display: flex; align-items: center; margin-bottom: 24rpx; }
.news-logo { width: 140rpx; height: 40rpx; }
.news-title { flex: 1; font-size: 31rpx; font-weight: 600; }
.editorial-more { margin-left: auto; padding-left: 18rpx; font-size: 23rpx; }
.news-list-item { display: flex; align-items: center; min-height: 48rpx; font-size: 26rpx; }
.news-list-item + .news-list-item { margin-top: 12rpx; }
.news-number { width: 38rpx; color: #999; font-weight: 700; }
.news-number.rank-1 { color: #e93323; }
.news-number.rank-2 { color: #ff7300; }
.news-number.rank-3 { color: #ffc300; }
.news-copy { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.news-ticker { display: flex; height: 88rpx; margin: 0; padding: 0 20rpx; align-items: center; overflow: hidden; box-sizing: border-box; }
.news-ticker-logo { width: 52rpx; height: 52rpx; margin-right: 16rpx; }
.news-ticker-title { margin-right: 16rpx; padding: 6rpx 12rpx; border-radius: 8rpx; font-size: 24rpx; white-space: nowrap; }
.news-swiper { height: 42rpx; flex: 1; min-width: 0; }
.news-swiper-item { overflow: hidden; font-size: 25rpx; line-height: 42rpx; text-overflow: ellipsis; white-space: nowrap; }
.hotspot-card { position: relative; width: 100%; overflow: hidden; }
.hotspot-image { display: block; width: 100%; }
.hotspot-area { position: absolute; z-index: 2; }
.party-card { margin: 0; padding: 26rpx; border-radius: 20rpx; }
.party-heading { display: flex; margin-bottom: 22rpx; align-items: flex-start; justify-content: space-between; }
.party-title { display: block; font-size: 32rpx; font-weight: 700; }
.party-description { display: block; margin-top: 6rpx; color: #888; font-size: 22rpx; }
.party-badge { padding: 7rpx 15rpx; border-radius: 22rpx; color: #fff; font-size: 20rpx; }
.party-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14rpx; }
.party-item { display: flex; min-width: 0; min-height: 150rpx; padding: 18rpx; align-items: center; overflow: hidden; border-radius: 14rpx; background: rgba(255, 255, 255, .86); box-sizing: border-box; }
.party-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.party-item-title { overflow: hidden; color: #333; font-size: 25rpx; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.party-item-description { display: -webkit-box; margin-top: 5rpx; overflow: hidden; color: #999; font-size: 19rpx; line-height: 28rpx; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.party-go { margin-top: 9rpx; font-size: 20rpx; font-weight: 700; }
.party-image { width: 94rpx; height: 94rpx; margin-left: 10rpx; flex: none; border-radius: 12rpx; background: #f5f5f5; }
.follow-card { display: flex; min-height: 120rpx; padding: 14rpx 24rpx; align-items: center; box-shadow: 0 5rpx 22rpx rgba(0, 0, 0, .05); box-sizing: border-box; }
.follow-profile { display: flex; flex: 1; min-width: 0; align-items: center; }
.follow-avatar { display: flex; width: 92rpx; height: 92rpx; flex: none; align-items: center; justify-content: center; border-radius: 50%; background: #f1f1f1; }
.follow-placeholder { color: #aaa; font-size: 28rpx; }
.follow-title { margin-left: 20rpx; overflow: hidden; color: #333; font-size: 28rpx; text-overflow: ellipsis; white-space: nowrap; }
.follow-button { width: 112rpx; margin: 0 0 0 12rpx; padding: 0; border: 1px solid; border-radius: 30rpx; background: transparent; font-size: 23rpx; line-height: 54rpx; }
.follow-button::after, .follow-dialog-close::after { border: 0; }
.follow-close { margin-left: 18rpx; padding: 12rpx 0 12rpx 12rpx; color: #999; font-size: 34rpx; }
.follow-modal { position: fixed; z-index: 1000; inset: 0; display: flex; padding: 40rpx; align-items: center; justify-content: center; background: rgba(0, 0, 0, .55); box-sizing: border-box; }
.follow-dialog { display: flex; width: 548rpx; max-width: 100%; padding: 42rpx; align-items: center; border-radius: 32rpx; background: #fff; box-sizing: border-box; flex-direction: column; }
.follow-dialog-title { font-size: 34rpx; font-weight: 700; }
.follow-dialog-copy, .follow-dialog-tip { margin-top: 12rpx; color: #888; font-size: 23rpx; }
.follow-code { width: 360rpx; height: 360rpx; max-width: 100%; margin-top: 30rpx; }
.follow-dialog-close { margin-top: 30rpx; color: #fff; border: 0; background: var(--view-theme, #e93323); }
.editorial-more{font-size:23rpx;line-height:1.6;padding:0 0 0 16rpx;background:transparent;margin:0 0 0 auto;flex-shrink:0;}.editorial-more::after{border:0;}.news-horizontal{flex:1;min-width:0;overflow:hidden;white-space:nowrap;font-size:25rpx;}.news-marquee{display:inline-block;min-width:100%;animation:news-ticker-scroll linear infinite;}@keyframes news-ticker-scroll{0%,10%{transform:translateX(0)}90%,100%{transform:translateX(-100%)}}.party-heading{gap:12rpx;}.party-title{min-width:0;overflow-wrap:anywhere;}.party-badge{max-width:50%;overflow-wrap:anywhere;}.follow-dialog{max-height:90vh;overflow-y:auto;}.follow-dialog button{margin-top:16rpx;white-space:normal;font-size:24rpx;}.follow-official{display:block;}
</style>
