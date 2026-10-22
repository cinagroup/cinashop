<template>
  <view v-if="active && config.enabled" class="diy-navigation-widget" :data-kind="config.kind" :data-component-key="config.identity">
    <template v-if="config.kind==='headerSerch'">
      <view :style="{height:headerHeight+'px'}" />
      <view class="navigation-header" :style="{...config.wrapperStyle,top:headerTop+'px'}">
        <view v-if="statusHeight" :style="{height:statusHeight+'px'}" />
        <view class="navigation-header-row" :style="config.panelStyle">
          <image v-if="config.style===0 && config.logo" class="navigation-logo" :src="config.logo" mode="heightFix" />
          <text v-else-if="config.style===1 && config.title" class="navigation-title" @tap="title">{{config.title}}</text>
          <view class="navigation-search-wrap" :class="{button:config.style===2 && config.searchVariant===1}" @tap="search">
            <view class="navigation-search" :class="{center:config.style===2 && config.searchVariant===0}" :style="config.searchStyle">
              <text class="navigation-search-icon">⌕</text>
              <swiper v-if="config.hotWords.length" class="navigation-hotwords" vertical circular :autoplay="state.ready()" :interval="config.hotInterval" :duration="config.hotDuration" :style="config.hotStyle"><swiper-item v-for="(word,index) in config.hotWords" :key="index"><text>{{word}}</text></swiper-item></swiper>
              <text v-else class="navigation-search-placeholder">{{config.placeholder}}</text>
            </view>
            <view v-if="config.style===2 && config.searchVariant===1" class="navigation-search-button" :style="config.searchButtonStyle">搜索</view>
            <view v-else-if="config.style===2 && config.searchVariant===2" class="navigation-search-text" :style="config.searchTextStyle">搜索</view>
          </view>
          <view v-if="capsuleWidth" class="navigation-capsule" :style="{width:capsuleWidth+'px'}" />
        </view>
      </view>
    </template>
    <template v-else-if="config.kind==='tabNav'">
      <view v-if="fixedTabs" :style="{height:config.tabLogicalHeight+'rpx'}" />
      <view class="navigation-tab-shell" :class="{fixed:fixedTabs}" :style="{...config.wrapperStyle,...(fixedTabs?{top:headerTop+'px'}:{})}">
        <view class="navigation-tab-panel" :style="config.panelStyle">
          <scroll-view scroll-x :show-scrollbar="false" :scroll-into-view="selectedTabId" scroll-with-animation>
            <view class="navigation-tab-row" :class="`style-${config.style}`"><view v-for="tab in config.tabs" :id="tabId(tab.index)" :key="tab.index" class="navigation-tab" :class="{selected:tab.index===selectedTab,invalid:!tab.valid}" :data-tab-index="tab.index" :style="tab.index===selectedTab?config.selectedStyle:{}" @tap="choose(tab.index)">{{tab.title || '未命名'}}<text v-if="config.style!==2 && tab.index===selectedTab" class="navigation-tab-decoration" :style="config.decorationStyle" /></view></view>
          </scroll-view>
        </view>
      </view>
    </template>
    <DiyNavigationCanvas v-else-if="config.kind==='menus' || config.kind==='pictureCube'" :key="`${fingerprint}:${epoch}:${retryEpoch}`" :config="config" :initial-page="currentPage" :allowed="state.lease()" @open="open" @page="pageChanged" @retry="retry" />
  </view>
</template>
<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, onMounted, ref, watch } from 'vue';
import type { DiyComponent } from '@/api/diy';
import type { DiyCarouselTab } from '@/utils/diyCarouselConfig';
import { useDiyNavigation } from '@/composables/useDiyNavigation';
import DiyNavigationCanvas from './DiyNavigationCanvas.vue';
const props=withDefaults(defineProps<{block:DiyComponent;active?:boolean;scrollTop?:number;selectedTab?:number;headerTop?:number}>(),{active:true,scrollTop:0,selectedTab:0,headerTop:0});
const emit=defineEmits<{select:[tab:DiyCarouselTab];layout:[height:number]}>();
const state=useDiyNavigation(()=>props.block,()=>props.active,tab=>emit('select',tab));
const {config,fingerprint,epoch,currentPage,open,title,search,choose,pageChanged}=state;
const instance=getCurrentInstance(),tabId=(index:number)=>`diy-nav-tab-${instance?.uid??0}-${index}`,selectedTabId=computed(()=>tabId(props.selectedTab));
let statusHeight=0,windowWidth=375,capsuleWidth=0,native=false;
try{const info=uni.getSystemInfoSync();if(Number.isFinite(info.windowWidth)&&info.windowWidth>0)windowWidth=info.windowWidth;
// #ifndef H5
native=true;if(Number.isFinite(info.statusBarHeight)&&Number(info.statusBarHeight)>0)statusHeight=Number(info.statusBarHeight);
// #endif
}catch{}
// #ifdef MP-WEIXIN
try{const wxApi=(globalThis as unknown as {wx?:{getMenuButtonBoundingClientRect():{width:number}}}).wx;const width=wxApi?.getMenuButtonBoundingClientRect().width;if(Number.isFinite(width)&&Number(width)>0&&Number(width)<windowWidth)capsuleWidth=Number(width);}catch{}
// #endif
const measuredHeight=ref(0),headerHeight=computed(()=>measuredHeight.value||config.value.headerLogicalHeight*windowWidth/750+statusHeight);
const fixedTabs=computed(()=>config.value.sticky&&(native||props.headerTop>0&&props.scrollTop>50));
function measure(){if(config.value.kind!=='headerSerch'||!state.ready())return;const current=state.lease();measuredHeight.value=0;emit('layout',headerHeight.value);void nextTick(()=>{if(!current()||!instance?.proxy||typeof uni.createSelectorQuery!=='function')return;uni.createSelectorQuery().in(instance.proxy).select('.navigation-header').boundingClientRect(raw=>{const value=Array.isArray(raw)?raw[0]:raw,height=value?.height;if(current()&&typeof height==='number'&&Number.isFinite(height)&&height>0&&height<2000){measuredHeight.value=height;emit('layout',height);}}).exec();});}
watch([fingerprint,epoch],measure,{flush:'post'});onMounted(measure);
const retryEpoch=ref(0);function retry(){if(state.ready())retryEpoch.value++;}
</script>
<style scoped>
.diy-navigation-widget{width:100%;min-width:0;box-sizing:border-box;}.navigation-header{position:fixed;left:0;width:100%;z-index:40;box-sizing:border-box;}.navigation-header-row{height:96rpx;padding:18rpx 30rpx;display:flex;align-items:center;box-sizing:border-box;overflow:hidden;}.navigation-logo{height:60rpx;max-width:200rpx;margin-right:20rpx;flex-shrink:0;}.navigation-title{margin-right:30rpx;font-size:30rpx;font-weight:500;color:#333;max-width:200rpx;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;}.navigation-search-wrap{display:flex;align-items:center;position:relative;flex:1;min-width:0;}.navigation-search{height:60rpx;padding:0 32rpx;border-radius:30rpx;display:flex;align-items:center;font-size:28rpx;line-height:32rpx;box-sizing:border-box;flex:1;min-width:0;}.navigation-search.center{justify-content:center;}.navigation-search-icon{margin-right:16rpx;font-size:32rpx;flex-shrink:0;}.navigation-hotwords{height:32rpx;flex:1;min-width:0;}.navigation-hotwords text,.navigation-search-placeholder{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.navigation-search.center .navigation-hotwords{text-align:center;}.navigation-search-button{position:absolute;top:4rpx;right:4rpx;height:52rpx;padding:0 24rpx;border-radius:26rpx;line-height:52rpx;font-size:22rpx;font-weight:500;}.navigation-search-wrap.button .navigation-search{padding-right:110rpx;}.navigation-search-text{margin-left:20rpx;font-size:30rpx;flex-shrink:0;}.navigation-capsule{flex-shrink:0;}.navigation-tab-shell{box-sizing:border-box;width:100%;}.navigation-tab-shell.fixed{position:fixed;left:0;z-index:39;}.navigation-tab-panel{overflow:hidden;}.navigation-tab-row{display:flex;align-items:center;width:max-content;min-width:100%;height:80rpx;padding-left:24rpx;box-sizing:border-box;}.navigation-tab{position:relative;flex-shrink:0;height:80rpx;margin-right:55rpx;line-height:80rpx;font-size:28rpx;color:#333;white-space:nowrap;}.navigation-tab:last-child{margin-right:24rpx;}.navigation-tab.selected{font-weight:bold;font-size:32rpx;}.navigation-tab.invalid{opacity:.5;}.navigation-tab-decoration{position:absolute;bottom:22rpx;left:50%;width:100%;height:8rpx;border-radius:4rpx;transform:translateX(-50%);z-index:-1;}.style-1 .navigation-tab-decoration{bottom:8rpx;width:64rpx;height:64rpx;border:4rpx solid transparent;border-radius:50%;background:transparent;box-sizing:border-box;}.style-2{padding-left:15rpx;}.style-2 .navigation-tab{padding:0 20rpx;margin-right:15rpx;}.style-2 .navigation-tab.selected{height:48rpx;border-radius:24rpx;font-size:26rpx;line-height:48rpx;text-align:center;}.navigation-tab.selected{z-index:1;}

/* #ifdef H5 */
.navigation-header,.navigation-tab-shell.fixed{transform:translateY(var(--window-top,0px));}
/* #endif */
</style>
