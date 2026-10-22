<template>
  <view v-if="active && config.enabled" class="diy-media-carousel" :data-kind="config.kind" :data-component-key="config.identity" :data-index="current" :style="config.wrapperStyle">
    <view v-if="config.kind==='homeComb' && config.items[current]" class="combination-background-wrap"><image class="combination-background" :src="config.items[current]?.image" mode="aspectFill" /></view>
    <view v-else-if="config.kind==='swiperBg' && config.items.length" class="carousel-background" :style="config.backgroundStyle" />
    <template v-if="config.kind==='homeComb'">
      <view v-if="fixedSearch" :style="{height:statusHeight+43+'px'}" />
      <view class="combination-search-header" :class="{fixed:fixedSearch}" :style="{paddingTop:statusHeight+'px'}">
        <view class="combination-search-row"><image v-if="config.logo" class="combination-logo" :src="config.logo" mode="heightFix" />
          <view class="combination-search" :class="{scrolled:fixedSearch}" @tap="search">
            <swiper v-if="config.hotWords.length" class="combination-hotwords" vertical circular :autoplay="state.ready()" :interval="config.hotInterval" :duration="config.duration" :current="word" @change="wordChanged"><swiper-item v-for="(text,i) in config.hotWords" :key="i"><text>{{text}}</text></swiper-item></swiper>
            <text v-else class="combination-placeholder">{{config.placeholder}}</text><text>⌕</text>
          </view>
        </view>
      </view>
      <view v-if="config.showTabs" class="combination-tabs"><scroll-view scroll-x :show-scrollbar="false" :scroll-into-view="selectedTabId" scroll-with-animation><view class="combination-tab-row"><view v-for="tab in config.tabs" :id="tabId(tab.index)" :key="tab.index" class="combination-tab" :class="{selected:tab.index===selectedTab,invalid:!tab.valid}" :data-tab-index="tab.index" :style="config.tabStyle" @tap="choose(tab.index)">{{tab.title || '未命名'}}</view></view></scroll-view><button class="combination-expand" aria-label="展开全部分类" @tap="toggleCategory">☷</button></view>
      <view v-if="categoryOpen" class="combination-category-mask" @tap="closeCategory"><view class="combination-category" :style="config.categoryStyle" @tap.stop><view class="combination-category-heading">精选类目<button size="mini" @tap="closeCategory">关闭</button></view><view class="combination-category-grid"><view v-for="tab in config.tabs" :key="tab.index" class="combination-category-item" :class="{selected:tab.index===selectedTab}" :data-tab-index="tab.index" @tap="choose(tab.index)">{{tab.title || '未命名'}}</view></view></view></view>
    </template>
    <DiyCarouselCanvas v-if="config.items.length" :key="`${fingerprint}:${epoch}:${retryEpoch}`" :config="config" :allowed="state.lease()" @open="open" @change="changed" @retry="retry" />
  </view>
</template>
<script setup lang="ts">
import { computed, getCurrentInstance, ref } from 'vue';
import type { DiyComponent } from '@/api/diy';
import type { DiyCarouselTab } from '@/utils/diyCarouselConfig';
import { useDiyMediaCarousel } from '@/composables/useDiyMediaCarousel';
import DiyCarouselCanvas from './DiyCarouselCanvas.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean;scrollTop?:number;selectedTab?:number}>(),{active:true,scrollTop:0,selectedTab:0});
const emit=defineEmits<{select:[tab:DiyCarouselTab]}>();
const state=useDiyMediaCarousel(()=>props.block,()=>props.active,tab=>emit('select',tab));
const {config,fingerprint,epoch,current,word,categoryOpen,changed,wordChanged,open,search,toggleCategory,closeCategory,choose}=state;
const retryEpoch=ref(0);function retry(){if(state.ready())retryEpoch.value++;}
let statusHeight=0;try{const h=Number(uni.getSystemInfoSync().statusBarHeight);if(Number.isFinite(h)&&h>=0&&h<200)statusHeight=h;}catch{}
const fixedSearch=computed(()=>config.value.stickySearch && props.scrollTop>10);
const instanceIdentity=getCurrentInstance()?.uid??0;
const tabId=(index:number)=>`diy-tab-${instanceIdentity}-${index}`;
const selectedTabId=computed(()=>tabId(props.selectedTab));
</script>
<style scoped>
.diy-media-carousel{position:relative;width:100%;box-sizing:border-box;min-width:0;}.combination-background-wrap{position:absolute;inset:0;overflow:hidden;pointer-events:none;}.carousel-background,.combination-background{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}.combination-background{filter:blur(30rpx);opacity:.8;transform:scale(1.04);}.combination-search-header{position:relative;z-index:40;color:#fff;box-sizing:border-box;}.combination-search-header.fixed{position:fixed;top:0;left:0;right:0;background:#fff;}.combination-search-row{height:43px;padding:0 30rpx;display:flex;align-items:center;gap:20rpx;}.combination-logo{height:60rpx;width:138rpx;flex-shrink:0;}.combination-search{display:flex;flex:1;min-width:0;height:60rpx;border-radius:30rpx;background:rgba(255,255,255,.4);align-items:center;padding:0 25rpx;color:#fff;gap:12rpx;box-sizing:border-box;font-size:28rpx;}.combination-search.scrolled{background:#f5f5f5;color:#888;}.combination-hotwords{flex:1;min-width:0;height:60rpx;line-height:60rpx;}.combination-hotwords text,.combination-placeholder{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1;}.combination-tabs{position:relative;z-index:2;display:flex;align-items:center;color:#fff;padding:12rpx 24rpx;}.combination-tabs scroll-view{flex:1;min-width:0;}.combination-tab-row{display:flex;width:max-content;min-width:100%;}.combination-tab{white-space:nowrap;flex-shrink:0;padding:8rpx 0;font-size:28rpx;}.combination-tab.selected{font-weight:bold;border-bottom:4rpx solid currentColor;}.combination-tab.invalid{opacity:.5;}.combination-expand{background:transparent;border:0;color:inherit;padding:0 12rpx;font-size:32rpx;line-height:1.5;}.combination-category-mask{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.45);}.combination-category{padding:30rpx;color:#fff;max-height:70vh;overflow-y:auto;}.combination-category-heading{display:flex;justify-content:space-between;align-items:center;}.combination-category-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16rpx;margin-top:30rpx;}.combination-category-item{padding:16rpx 6rpx;text-align:center;background:rgba(255,255,255,.2);border-radius:8rpx;font-size:26rpx;overflow-wrap:anywhere;}.combination-category-item.selected{background:#fff;color:#333;}
/* #ifdef H5 */
.combination-search-header.fixed{top:var(--window-top,0px);}
.combination-category-mask{top:var(--window-top,0px);}
/* #endif */
/* #ifdef MP */
.combination-search-row{padding-right:220rpx;}
/* #endif */
</style>
