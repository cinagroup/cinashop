<template>
  <view class="diy-renderer">
    <template v-for="(block, index) in components" :key="blockKey(block, index)">
      <view v-if="block.name!=='pageFoot' && (block.name==='homeComb' || !combinationSelection)" class="diy-theme-block" :style="blockThemeStyle(block)">
      <view
        v-if="block.name === 'headerSerch'"
        class="diy-search"
        @tap="open('/pages/goods/search')"
      >
        <image v-if="componentImage(block, 'logoConfig')" class="search-logo" :src="componentImage(block, 'logoConfig')" mode="heightFix" />
        <text class="search-copy">⌕ {{ componentText(block, 'tipConfig', '搜索商品') }}</text>
      </view>

      <DiyMediaCarousel
        v-else-if="block.name === 'homeComb' || block.name === 'swipers' || block.name === 'swiperBg'"
        :block="block"
        :active="pageActive"
        :scroll-top="scrollTop"
        :selected-tab="combinationTabs.selected(block)"
        @select="combinationTabs.select(block, $event.index)"
      />

      <view v-else-if="block.name === 'titles'" class="diy-title" @tap="open(componentLink(block, 'linkConfig'))">
        <text>{{ componentText(block, 'titleConfig', '精选内容') }}</text>
        <text v-if="componentText(block, 'titleConfigRight')" class="diy-more">
          {{ componentText(block, 'titleConfigRight') }} ›
        </text>
      </view>

      <view
        v-else-if="block.name === 'blankPage'"
        class="diy-spacer"
        :style="spacerStyle(block)"
      />

      <view v-else-if="block.name === 'guide'" class="diy-guide" :style="guideStyle(block)" />

      <view v-else-if="block.name === 'richText' && sanitizedRichText(block)" class="diy-rich-text">
        <rich-text :nodes="sanitizedRichText(block)" />
      </view>

      <view v-else-if="block.name === 'videos' && configuredVideo(block)" class="diy-video-card">
        <video
          class="diy-video"
          :src="configuredVideo(block)"
          :poster="componentImage(block, 'imgConfig')"
          controls
          object-fit="cover"
        />
      </view>

      <view
        v-else-if="block.name === 'menus' || block.name === 'pictureCube' || block.name === 'tabNav'"
        class="diy-menu-grid"
      >
        <view
          v-for="(item, itemIndex) in menuItems(block)"
          :key="`${index}-${itemIndex}`"
          class="diy-menu-item"
          @tap="open(item.link)"
        >
          <image v-if="item.image" class="diy-menu-image" :src="item.image" mode="aspectFill" />
          <text v-if="item.label" class="diy-menu-label">{{ item.label }}</text>
        </view>
      </view>

      <DiyListWidget v-else-if="block.name === 'goodList' || block.name === 'articleList'" :block="block" :active="pageActive" />

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

      <view v-else-if="block.name === 'customerService'" class="diy-service" @tap="open('/pages/user/kefu')">
        <text>在线客服</text>
        <text class="diy-more">咨询 ›</text>
      </view>

      </view>
    </template>
    <template v-if="combinationSelection">
      <DiyCombinationCategory v-if="combinationSelection.kind==='category'" :key="`${combinationSelection.host}:${combinationSelection.id}`" :id="combinationSelection.id" :active="pageActive" :load-more-signal="loadMoreSignal" />
      <template v-else>
        <view v-if="combinationLoading" class="diy-combination-status" role="status">正在读取微页面…</view>
        <view v-else-if="combinationError" class="diy-combination-status" role="alert">{{combinationError}}<button @tap="combinationTabs.micro.reload(true)">重试微页面</button></view>
        <DiyHomeRenderer v-else-if="combinationAvailable" :components="combinationComponents" :page-active="pageActive && combinationAvailable" :scroll-top="scrollTop" :load-more-signal="loadMoreSignal" :micro-page="false" @closed="emit('closed', $event)" />
        <view v-else class="diy-combination-status">微页面暂未开放</view>
      </template>
    </template>
    <view v-for="(block, index) in hostFooters" :key="blockKey(block, index)" class="diy-theme-block" :style="blockThemeStyle(block)">
      <view class="diy-page-foot">
        <view v-for="(item, itemIndex) in footerItems(block)" :key="`${index}-foot-${itemIndex}`" class="diy-foot-item" @tap="open(item.link)">
          <image v-if="item.image" class="diy-foot-image" :src="item.image" mode="aspectFit" />
          <text>{{ item.label }}</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import type { DiyComponent } from '@/api/diy';
import { DIY_STATE_WIDGET_NAMES } from '@/utils/diyStateWidget';
import DiyStateWidget from './DiyStateWidget.vue';
import { sanitizeArticleRichText } from "@/utils/articleRichText";
import {
  asDiyRecord,
  diyItemLink,
  diyList,
  diyNestedValue,
  diyNumber,
  diyText,
  openDiyLink,
  safeDiyColor,
  safeDiyImageUrl,
} from "@/utils/diy";
import DiyMediaCarousel from "./DiyMediaCarousel.vue";
import DiyCombinationCategory from './DiyCombinationCategory.vue';
import { useDiyCombinationTabs } from '@/composables/useDiyCombinationTabs';
import DiyEditorialWidget from "./DiyEditorialWidget.vue";
import DiyListWidget from "./DiyListWidget.vue";
import DiyCommerceWidget from "./DiyCommerceWidget.vue";
import DiyCommunityWidget from "./DiyCommunityWidget.vue";
import { useThemeStore } from '@/stores/theme';
import { diyThemeVariables } from '@/utils/diyTheme';

interface MenuItem {
  image: string;
  label: string;
  link: string;
}

const props = withDefaults(defineProps<{
  components: DiyComponent[];
  microPage?: boolean;
  pageActive?: boolean;
  scrollTop?: number;
  loadMoreSignal?: number;
}>(), {
  microPage: false,
  pageActive: true,
  scrollTop: 0,
  loadMoreSignal: 0,
});
const emit = defineEmits<{ closed: [message: string] }>();
const combinationTabs=useDiyCombinationTabs(()=>props.components,()=>props.pageActive);
const {selection:combinationSelection,components:combinationComponents}=combinationTabs;
const {loading:combinationLoading,error:combinationError,available:combinationAvailable}=combinationTabs.micro;
const hostFooters=computed(()=>props.microPage?props.components.filter(block=>block.name==='pageFoot'):[]);
watch(combinationTabs.micro.phase,phase=>{if(phase==='closed'&&props.pageActive)emit('closed',combinationError.value);});
function isStateWidget(block: DiyComponent) { return DIY_STATE_WIDGET_NAMES.some(name => name === block.name); }
const theme = useThemeStore();
function blockThemeStyle(block: DiyComponent) { return diyThemeVariables(block, theme.preset); }

const EDITORIAL_WIDGET_NAMES = new Set(["news", "hotspot", "follow", "activeParty"]);
const COMMERCE_WIDGET_NAMES = new Set([
  "bargain",
  "combination",
  "coupon",
  "liveBroadcast",
  "promotionList",
  "seckill",
  "presale",
  "pointsMall",
]);

function isEditorialWidget(block: DiyComponent): boolean {
  return EDITORIAL_WIDGET_NAMES.has(block.name);
}

function isCommerceWidget(block: DiyComponent): boolean {
  return COMMERCE_WIDGET_NAMES.has(block.name);
}

function blockKey(block: DiyComponent, index: number): string {
  return `${block.name}-${String(block.timestamp ?? index)}-${index}`;
}

function tabValue(source: unknown, key: string, fallback = 0): number {
  const record = asDiyRecord(asDiyRecord(source)?.[key]);
  const value = Number(record?.tabVal ?? record?.activeValue ?? record?.value ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function componentText(block: DiyComponent, key: string, fallback = ""): string {
  return diyText(block, key, fallback);
}

function componentImage(block: DiyComponent, key: string): string {
  const config = asDiyRecord(block[key]);
  return safeDiyImageUrl(config?.url ?? config?.img ?? config?.value);
}

function componentLink(block: DiyComponent, key: string): string {
  return String(diyNestedValue(block, key) ?? "");
}

function infoLabel(item: Record<string, unknown>): string {
  const info = Array.isArray(item.info) ? item.info : [];
  const first = asDiyRecord(info[0]);
  const value = first?.value ?? first?.title ?? item.name ?? item.title ?? "";
  return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 80) : "";
}

function menuItems(block: DiyComponent): MenuItem[] {
  let raw: unknown[] = [];
  if (block.name === "menus") raw = diyList(block, "menuConfig", "list");
  if (block.name === "pictureCube") {
    raw = diyList(block, "picStyle", "picList");
    if (!raw.length) raw = diyList(block, "picStyle", "docPicList");
  }
  if (block.name === "tabNav") {
    raw = diyList(block, "tabConfig", "list");
    if (!raw.length) raw = diyList(block, "menuConfig", "list");
  }
  return raw.slice(0, 30).flatMap((value) => {
    const item = asDiyRecord(value);
    if (!item || item.show === 0 || item.show === "0") return [];
    const image = safeDiyImageUrl(item.img ?? item.image);
    const label = infoLabel(item);
    if (!image && !label) return [];
    return [{ image, label, link: diyItemLink(item) }];
  });
}

function footerItems(block: DiyComponent): MenuItem[] {
  return diyList(block, "menuList").slice(0, 8).flatMap((value) => {
    const item = asDiyRecord(value);
    if (!item) return [];
    const images = Array.isArray(item.imgList) ? item.imgList : [];
    const label = typeof item.name === "string" ? item.name.slice(0, 40) : "";
    const link = typeof item.link === "string" ? item.link : "";
    if (!label && !link) return [];
    return [{ image: safeDiyImageUrl(images[0]), label, link }];
  });
}

function safeImage(value: unknown): string {
  return safeDiyImageUrl(value);
}

function open(value: unknown): void {
  openDiyLink(value);
}

function sanitizedRichText(block: DiyComponent): string {
  const value = diyNestedValue(block, "richText");
  return typeof value === "string"
    ? sanitizeArticleRichText(value.slice(0, 2_097_152))
    : "";
}

function configuredVideo(block: DiyComponent): string {
  return safeDiyImageUrl(asDiyRecord(block.videoConfig)?.url);
}

function spacerStyle(block: DiyComponent): Record<string, string> {
  const height = Math.min(300, Math.max(0, diyNumber(block, "heightConfig", 12)));
  const colorConfig = asDiyRecord(block.bgColor);
  const colors = Array.isArray(colorConfig?.color) ? colorConfig.color : [];
  const color = safeDiyColor(asDiyRecord(colors[0])?.item, "transparent");
  return { height: `${height * 2}rpx`, backgroundColor: color };
}

function guideStyle(block: DiyComponent): Record<string, string> {
  const colorConfig = asDiyRecord(block.lineColor);
  const colors = Array.isArray(colorConfig?.color) ? colorConfig.color : [];
  return { borderTopColor: safeDiyColor(asDiyRecord(colors[0])?.item, "#e5e5e5") };
}

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
.diy-page-foot { position: sticky; z-index: 20; bottom: 0; display: flex; padding: 10rpx 12rpx calc(10rpx + env(safe-area-inset-bottom)); border-top: 1rpx solid #eee; background: rgba(255,255,255,.96); }
.diy-foot-item { display: flex; flex: 1; min-width: 0; align-items: center; flex-direction: column; color: #555; font-size: 21rpx; }
.diy-foot-image { width: 44rpx; height: 44rpx; margin-bottom: 4rpx; }
</style>
