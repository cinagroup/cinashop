<template>
  <view class="diy-renderer">
    <template v-for="(block, index) in components" :key="blockKey(block, index)">
      <view v-if="block.name!=='pageFoot' && (block.name==='homeComb' || block.name==='headerSerch' || block.name==='tabNav' || !combinationSelection)" class="diy-theme-block" :style="blockThemeStyle(block)">
      <DiyNavigationWidget
        v-if="block.name === 'headerSerch' || block.name === 'tabNav' || block.name === 'menus' || block.name === 'pictureCube'"
        :block="block" :active="pageActive" :scroll-top="scrollTop" :selected-tab="combinationTabs.selected(block)" :header-top="headerOffset(index)"
        @select="combinationTabs.select(block,$event.index)" @layout="recordHeaderHeight(block,index,$event)"
      />

      <DiyMediaCarousel
        v-else-if="block.name === 'homeComb' || block.name === 'swipers' || block.name === 'swiperBg'"
        :block="block"
        :active="pageActive"
        :scroll-top="scrollTop"
        :selected-tab="combinationTabs.selected(block)"
        @select="combinationTabs.select(block, $event.index)"
      />

      <DiyPresentationWidget v-else-if="isPresentationWidget(block)" :block="block" :active="pageActive" :refreshing="pageRefreshing" />

      <DiyListWidget v-else-if="block.name === 'goodList' || block.name === 'articleList'" :block="block" :active="pageActive" />

      <DiyPromotionWidget v-else-if="block.name === 'promotionList'" :block="block" :active="pageActive" :header-top="headerOffset(index)" />

      <DiyCouponWidget v-else-if="block.name === 'coupon'" :block="block" :active="pageActive" />

      <DiyPointsWidget v-else-if="block.name === 'pointsMall'" :block="block" :active="pageActive" />
      <DiyLiveBroadcastWidget v-else-if="block.name === 'liveBroadcast'" :block="block" :active="pageActive" />
      <DiySeckillWidget v-else-if="block.name === 'seckill'" :block="block" :active="pageActive" />
      <DiyBargainWidget v-else-if="block.name === 'bargain'" :block="block" :active="pageActive" />
      <DiyCombinationWidget v-else-if="block.name === 'combination'" :block="block" :active="pageActive" />
      <DiyPresaleWidget v-else-if="block.name === 'presale'" :block="block" :active="pageActive" />

      <DiyStateWidget v-else-if="isStateWidget(block)" :block="block" :active="pageActive" @closed="emit('closed', $event)" />

      <DiyCommunityWidget v-else-if="block.name === 'community'" :block="block" :active="pageActive" />

      <DiyEditorialWidget
        v-else-if="isEditorialWidget(block)"
        :block="block"
        :active="pageActive"
      />

      <DiyCommerceWidget
        v-else-if="isCommerceWidget(block)"
        :block="block"
        :active="pageActive"
      />

      <DiyCustomerService v-else-if="block.name === 'customerService'" :block="block" :active="pageActive" />

      </view>
    </template>
    <template v-if="combinationSelection">
      <DiyCombinationCategory v-if="combinationSelection.kind==='category'" :key="`${combinationSelection.host}:${combinationSelection.id}`" :id="combinationSelection.id" :activity="categoryActivity" :load-more-signal="loadMoreSignal" />
      <template v-else>
        <view v-if="combinationLoading" class="diy-combination-status" role="status">正在读取微页面…</view>
        <view v-if="combinationError" class="diy-combination-status" role="alert">{{combinationError}}<button @tap="combinationTabs.micro.reload(true)">重试微页面</button></view>
        <DiyHomeRenderer v-else-if="combinationRenderable" :components="combinationComponents" :page-active="pageActive && combinationAvailable" :page-refreshing="pageRefreshing || combinationRefreshing" :scroll-top="scrollTop" :load-more-signal="loadMoreSignal" :micro-page="false" @closed="emit('closed', $event)" />
        <view v-else-if="!combinationLoading" class="diy-combination-status">微页面暂未开放</view>
      </template>
    </template>
    <DiyPageFooter v-if="microPage" :block="hostFooter" :active="pageActive || pageRefreshing" :ready="pageActive && !pageRefreshing" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DiyPageFooter from './DiyPageFooter.vue';
import type { DiyComponent } from '@/api/diy';
import { DIY_STATE_WIDGET_NAMES } from '@/utils/diyStateWidget';
import DiyStateWidget from './DiyStateWidget.vue';
import DiyCustomerService from './DiyCustomerService.vue';
import DiyPresentationWidget from './DiyPresentationWidget.vue';
import { DIY_PRESENTATION_NAMES } from '@/utils/diyPresentationConfig';
import {
  isDiyEnabled,
} from "@/utils/diy";
import DiyMediaCarousel from "./DiyMediaCarousel.vue";
import DiyNavigationWidget from './DiyNavigationWidget.vue';
import { normalizeDiyNavigation } from '@/utils/diyNavigationConfig';
import { diyAuthoredPageFingerprint } from '@/utils/diyEditorialMediaLease';
import DiyCombinationCategory from './DiyCombinationCategory.vue';
import { useDiyCombinationTabs } from '@/composables/useDiyCombinationTabs';
import type { DiyCombinationActivity } from '@/composables/useDiyCombinationCategory';
import DiyEditorialWidget from "./DiyEditorialWidget.vue";
import DiyListWidget from "./DiyListWidget.vue";
import DiyPromotionWidget from './DiyPromotionWidget.vue';
import DiyCouponWidget from './DiyCouponWidget.vue';
import DiyLiveBroadcastWidget from './DiyLiveBroadcastWidget.vue';
import DiySeckillWidget from './DiySeckillWidget.vue';
import DiyBargainWidget from './DiyBargainWidget.vue';
import DiyCombinationWidget from './DiyCombinationWidget.vue';
import DiyPresaleWidget from './DiyPresaleWidget.vue';
import DiyPointsWidget from './DiyPointsWidget.vue';
import DiyCommerceWidget from "./DiyCommerceWidget.vue";
import DiyCommunityWidget from "./DiyCommunityWidget.vue";
import { useThemeStore } from '@/stores/theme';
import { diyThemeVariables } from '@/utils/diyTheme';

const props = withDefaults(defineProps<{
  components: DiyComponent[];
  microPage?: boolean;
  pageActive?: boolean;
  pageRefreshing?: boolean;
  scrollTop?: number;
  loadMoreSignal?: number;
}>(), {
  microPage: false,
  pageActive: true,
  pageRefreshing: false,
  scrollTop: 0,
  loadMoreSignal: 0,
});
const emit = defineEmits<{ closed: [message: string] }>();
const combinationTabs=useDiyCombinationTabs(()=>props.components,()=>props.pageActive);
const {selection:combinationSelection,components:combinationComponents}=combinationTabs;
const {loading:combinationLoading,error:combinationError,available:combinationAvailable,refreshing:combinationRefreshing,page:combinationPage}=combinationTabs.micro;
const categoryActivity=computed<DiyCombinationActivity>(()=>props.pageRefreshing?'refreshing':props.pageActive?'ready':'inactive');
const combinationRenderable=computed(()=>(props.pageActive||props.pageRefreshing)&&!!combinationPage.value&&isDiyEnabled(combinationPage.value.is_show)&&!combinationError.value);
const hostFooter=computed(()=>props.microPage?[...props.components].reverse().find(block=>block.name==='pageFoot') ?? null:null);
watch(combinationTabs.micro.phase,phase=>{if(phase==='closed'&&props.pageActive)emit('closed',combinationError.value);});
function isStateWidget(block: DiyComponent) { return DIY_STATE_WIDGET_NAMES.some(name => name === block.name); }
const theme = useThemeStore();
function blockThemeStyle(block: DiyComponent) { return diyThemeVariables(block, theme.preset); }
const headerHeights=ref<Record<string,number>>({});
watch(()=>diyAuthoredPageFingerprint(props.components),()=>{headerHeights.value={};},{flush:'sync'});
function recordHeaderHeight(block:DiyComponent,index:number,height:number){if(props.components[index]===block&&block.name==='headerSerch'&&Number.isFinite(height)&&height>0&&height<2000)headerHeights.value[blockKey(block,index)]=height;}
function headerOffset(index:number){let width=375,status=0,native=false;try{const info=uni.getSystemInfoSync();if(Number.isFinite(info.windowWidth)&&info.windowWidth>0)width=info.windowWidth;
// #ifndef H5
native=true;
if(Number.isFinite(info.statusBarHeight)&&Number(info.statusBarHeight)>0)status=Number(info.statusBarHeight);
// #endif
}catch{}let total=0,hasHeader=false;const stackTabs=props.components[index]?.name==='tabNav';for(const [i,block] of props.components.slice(0,index).entries()){if(block.name!=='headerSerch'&&block.name!=='tabNav')continue;const config=normalizeDiyNavigation(block,theme.preset);if(!config.enabled)continue;if(block.name==='headerSerch'){hasHeader=true;total+=headerHeights.value[blockKey(block,i)]??config.headerLogicalHeight*width/750+status;}else if(stackTabs&&config.sticky&&(native||hasHeader&&props.scrollTop>50))total+=config.tabLogicalHeight*width/750;}return total;}

const EDITORIAL_WIDGET_NAMES = new Set(["news", "hotspot", "follow", "activeParty"]);
const COMMERCE_WIDGET_NAMES = new Set<string>();

function isEditorialWidget(block: DiyComponent): boolean {
  return EDITORIAL_WIDGET_NAMES.has(block.name);
}

function isCommerceWidget(block: DiyComponent): boolean {
  return COMMERCE_WIDGET_NAMES.has(block.name);
}

function blockKey(block: DiyComponent, index: number): string {
  return `${block.name}-${String(block.timestamp ?? index)}-${index}`;
}

function isPresentationWidget(block:DiyComponent){return DIY_PRESENTATION_NAMES.some(name=>name===block.name);}

</script>

<style scoped>
.diy-renderer { width: 100%; box-sizing: border-box; }
.diy-search { display: flex; align-items: center; gap: 18rpx; margin: 20rpx; padding: 18rpx 26rpx; border-radius: 40rpx; background: #fff; box-shadow: 0 6rpx 24rpx rgba(0, 0, 0, .05); }
.diy-search.compact { margin-bottom: 12rpx; }
.search-logo { width: 130rpx; height: 52rpx; }
.search-copy { flex: 1; color: #999; font-size: 26rpx; }
.diy-title, .diy-service { display: flex; align-items: center; justify-content: space-between; margin: 20rpx; padding: 24rpx; border-radius: 16rpx; background: #fff; font-size: 30rpx; font-weight: 600; }
.diy-more { color: #999; font-size: 24rpx; font-weight: 400; }
.diy-spacer { margin: 0 20rpx; border-radius: 12rpx; }
.diy-guide { margin: 24rpx 20rpx; border-top: 2rpx solid #e5e5e5; }
.diy-rich-text, .diy-video-card, .diy-section, .diy-user-card { margin: 20rpx; padding: 24rpx; border-radius: 18rpx; background: #fff; box-sizing: border-box; }
.diy-video { width: 100%; height: 380rpx; border-radius: 12rpx; overflow: hidden; }
.diy-menu-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20rpx 12rpx; margin: 20rpx; padding: 24rpx 16rpx; border-radius: 18rpx; background: #fff; }
.diy-menu-item { display: flex; flex-direction: column; align-items: center; min-width: 0; }
.diy-menu-image { width: 92rpx; height: 92rpx; border-radius: 20rpx; background: #f5f5f5; }
.diy-menu-label { width: 100%; margin-top: 10rpx; overflow: hidden; color: #555; font-size: 23rpx; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.diy-section-title { display: block; margin-bottom: 20rpx; font-size: 31rpx; font-weight: 600; color: #222; }
.diy-rank-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12rpx; }
.diy-rank-heading .diy-section-title { min-width: 0; }
.diy-rank-more { flex-shrink: 0; color: var(--view-theme, #e93323); font-size: 23rpx; padding: 6rpx 0; }
.diy-product-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx; }
.diy-product-card { min-width: 0; overflow: hidden; border: 1rpx solid #eee; border-radius: 14rpx; }
.diy-product-image { width: 100%; height: 280rpx; background: #f5f5f5; }
.diy-product-name { display: -webkit-box; height: 72rpx; margin: 14rpx 14rpx 4rpx; overflow: hidden; font-size: 25rpx; line-height: 36rpx; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.diy-price-row { display: flex; align-items: center; justify-content: space-between; padding: 8rpx 14rpx 16rpx; }
.diy-price { color: var(--view-priceColor, #e93323); font-size: 27rpx; font-weight: 600; }
.diy-sales, .diy-article-meta, .diy-user-meta, .diy-sign-copy { color: #999; font-size: 21rpx; }
.diy-article { display: flex; gap: 18rpx; padding: 18rpx 0; border-bottom: 1rpx solid #eee; }
.diy-article:last-child { border-bottom: 0; }
.diy-article-image { width: 180rpx; height: 126rpx; flex: none; border-radius: 10rpx; background: #f5f5f5; }
.diy-article-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; justify-content: space-between; }
.diy-article-title { display: -webkit-box; overflow: hidden; font-size: 27rpx; line-height: 38rpx; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.diy-rank-group + .diy-rank-group { margin-top: 22rpx; }
.diy-rank-label { display: block; margin-bottom: 12rpx; color: #666; font-size: 25rpx; }
.diy-horizontal-scroll { width: 100%; white-space: nowrap; }
.diy-rank-product, .diy-video-preview { position: relative; display: inline-flex; width: 210rpx; margin-right: 18rpx; vertical-align: top; flex-direction: column; }
.diy-rank-image, .diy-video-poster { width: 210rpx; height: 210rpx; border-radius: 12rpx; background: #f5f5f5; }
.diy-rank-name { margin: 10rpx 0 6rpx; overflow: hidden; font-size: 23rpx; text-overflow: ellipsis; white-space: nowrap; }
.diy-rank-number { position: absolute; z-index: 1; top: 8rpx; left: 8rpx; width: 40rpx; height: 40rpx; border-radius: 50%; color: #fff; background: var(--view-theme, #e93323); font-size: 22rpx; line-height: 40rpx; text-align: center; }
.diy-newcomer { background: linear-gradient(135deg, #fff7f1, #fff); }
.diy-newcomer-points, .diy-newcomer-coupon { display: block; margin-bottom: 18rpx; color: var(--view-priceColor, #e93323); font-size: 25rpx; }
.diy-sign { display: flex; flex-direction: column; gap: 18rpx; }
.diy-sign-days { display: flex; gap: 8rpx; }
.diy-sign-day { flex: 1; padding: 10rpx 0; border-radius: 10rpx; color: #888; background: #f5f5f5; font-size: 18rpx; text-align: center; }
.diy-sign-day.signed { color: #fff; background: var(--view-theme, #e93323); }
.diy-sign-day.today { box-shadow: inset 0 0 0 2rpx var(--view-theme, #e93323); }
.diy-user-card { display: flex; align-items: center; gap: 18rpx; }
.diy-avatar { display: flex; width: 92rpx; height: 92rpx; flex: none; align-items: center; justify-content: center; border-radius: 50%; background: #f2f2f2; }
.diy-avatar-placeholder { color: #aaa; font-size: 30rpx; }
.diy-user-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 8rpx; }
.diy-user-name { font-size: 28rpx; font-weight: 600; }
.diy-user-counts { display: flex; flex-direction: column; gap: 8rpx; color: #777; font-size: 21rpx; text-align: right; }
.diy-video-poster { height: 270rpx; }
</style>
