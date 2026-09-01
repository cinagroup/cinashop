<template>
  <view v-if="block.name === 'news' && newsItems.length" class="editorial-wrap" :style="outerStyle">
    <view v-if="newsListStyle" class="news-card" :style="cardStyle">
      <view class="news-heading">
        <image v-if="titleImage" class="news-logo" :src="titleImage" mode="aspectFit" />
        <text v-else class="news-title" :style="titleStyle">{{ titleText }}</text>
        <text v-if="showMore" class="editorial-more" :style="buttonStyle" @tap="open(moreLink)">
          {{ moreText }} ›
        </text>
      </view>
      <view
        v-for="(item, index) in newsItems"
        :key="`${index}-${item.title}`"
        class="news-list-item"
        :style="newsTextStyle"
        @tap="open(item.link)"
      >
        <text class="news-number" :class="`rank-${index + 1}`">{{ index + 1 }}</text>
        <text class="news-copy">{{ item.title }}</text>
      </view>
    </view>
    <view v-else class="news-ticker" :style="cardStyle">
      <image v-if="titleImage" class="news-ticker-logo" :src="titleImage" mode="aspectFit" />
      <text v-else class="news-ticker-title" :style="tickerTitleStyle">{{ titleText }}</text>
      <swiper class="news-swiper" autoplay circular vertical :interval="2500">
        <swiper-item v-for="(item, index) in newsItems" :key="`${index}-${item.title}`">
          <view class="news-swiper-item" :style="newsTextStyle" @tap="open(item.link)">
            {{ item.title }}
          </view>
        </swiper-item>
      </swiper>
      <text v-if="showMore" class="editorial-more" :style="buttonStyle" @tap="open(moreLink)">›</text>
    </view>
  </view>

  <view v-else-if="block.name === 'hotspot' && hotspotImage" class="editorial-wrap" :style="outerStyle">
    <view class="hotspot-card">
      <image class="hotspot-image" :src="hotspotImage" mode="widthFix" :style="radiusStyle" />
      <view
        v-for="(area, index) in hotspotAreas"
        :key="`${index}-${area.link}`"
        class="hotspot-area"
        :style="area.style"
        :aria-label="`热区 ${index + 1}`"
        @tap.stop="open(area.link)"
      />
    </view>
  </view>

  <view v-else-if="block.name === 'activeParty' && partyItems.length" class="editorial-wrap">
    <view class="party-card" :style="partyStyle">
      <view class="party-heading">
        <view>
          <text class="party-title" :style="partyTitleStyle">{{ partyTitle }}</text>
          <text v-if="partyDescription" class="party-description">{{ partyDescription }}</text>
        </view>
        <text class="party-badge" :style="partyBadgeStyle">活动精选</text>
      </view>
      <view class="party-grid">
        <view
          v-for="(item, index) in partyItems"
          :key="`${index}-${item.title}`"
          class="party-item"
          @tap="open(item.link)"
        >
          <view class="party-copy">
            <text class="party-item-title">{{ item.title }}</text>
            <text v-if="item.description" class="party-item-description">{{ item.description }}</text>
            <text class="party-go" :style="partyTitleStyle">GO！</text>
          </view>
          <image v-if="item.image" class="party-image" :src="item.image" mode="aspectFill" />
        </view>
      </view>
    </view>
  </view>

  <view v-else-if="block.name === 'follow' && !followDismissed && followVisible" class="editorial-wrap" :style="followWrapStyle">
    <view class="follow-card" :style="followCardStyle">
      <view class="follow-profile">
        <image v-if="followImage" class="follow-avatar" :src="followImage" mode="aspectFill" />
        <view v-else class="follow-avatar follow-placeholder">微</view>
        <text class="follow-title">{{ followTitle }}</text>
      </view>
      <button class="follow-button" size="mini" :style="followButtonStyle" @tap="showFollowCode">
        关注
      </button>
      <text class="follow-close" @tap.stop="followDismissed = true">×</text>
    </view>
    <view v-if="followCodeOpen" class="follow-modal" @tap="followCodeOpen = false">
      <view class="follow-dialog" @tap.stop>
        <text class="follow-dialog-title">关注公众号</text>
        <text class="follow-dialog-copy">活动福利，第一时间了解</text>
        <image class="follow-code" :src="followCode" mode="aspectFit" show-menu-by-longpress />
        <text class="follow-dialog-tip">长按二维码保存或识别</text>
        <button class="follow-dialog-close" size="mini" @tap="followCodeOpen = false">关闭</button>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DiyComponent } from "@/api/diy";
import {
  asDiyRecord,
  diyList,
  diyNumber,
  diyText,
  isDiyEnabled,
  normalizeDiyLink,
  openDiyLink,
  safeDiyColor,
  safeDiyImageUrl,
} from "@/utils/diy";

interface NewsItem {
  title: string;
  link: string;
}

interface PartyItem {
  title: string;
  description: string;
  image: string;
  link: string;
}

interface HotspotArea {
  link: string;
  style: Record<string, string>;
}

const props = defineProps<{ block: DiyComponent }>();
const followCodeOpen = ref(false);
const followDismissed = ref(false);

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function configValue(key: string): Record<string, unknown> | null {
  return asDiyRecord(props.block[key]);
}

function configColor(key: string, index: number, fallback: string): string {
  const colors = configValue(key)?.color;
  const item = Array.isArray(colors) ? asDiyRecord(colors[index])?.item : undefined;
  return safeDiyColor(item, fallback);
}

function textFromInfo(value: unknown, index: number, max: number): string {
  const info = Array.isArray(asDiyRecord(value)?.info) ? asDiyRecord(value)?.info as unknown[] : [];
  const entry = asDiyRecord(info[index]);
  const text = entry?.value ?? entry?.val ?? "";
  return typeof text === "string" || typeof text === "number" ? String(text).trim().slice(0, max) : "";
}

function imageFrom(value: unknown): string {
  const item = asDiyRecord(value);
  return safeDiyImageUrl(item?.img ?? item?.image ?? item?.url);
}

function radius(): string {
  const config = configValue("fillet");
  if (!config) return "0";
  if (Number(config.type) === 1 && Array.isArray(config.valList)) {
    const values = config.valList.slice(0, 4).map((value) => (
      `${bounded(asDiyRecord(value)?.val, 0, 0, 80) * 2}rpx`
    ));
    while (values.length < 4) values.push("0rpx");
    return `${values[0]} ${values[1]} ${values[3]} ${values[2]}`;
  }
  return `${bounded(config.val, 0, 0, 80) * 2}rpx`;
}

function open(value: unknown): void {
  openDiyLink(value);
}

const outerStyle = computed<Record<string, string>>(() => ({
  padding: `${bounded(diyNumber(props.block, "topConfig"), 0, 0, 100) * 2}rpx ${bounded(diyNumber(props.block, "prConfig"), 0, 0, 80) * 2}rpx ${bounded(diyNumber(props.block, "bottomConfig"), 0, 0, 100) * 2}rpx`,
  marginTop: `${bounded(diyNumber(props.block, "mbConfig"), 0, 0, 100) * 2}rpx`,
  backgroundColor: configColor("bottomBgColor", 0, "transparent"),
}));
const radiusStyle = computed(() => ({ borderRadius: radius() }));

const newsItems = computed<NewsItem[]>(() => (
  diyList(props.block, "listConfig", "list").slice(0, 10).flatMap((value) => {
    const item = asDiyRecord(value);
    if (!item || !isDiyEnabled(item.show)) return [];
    const child = Array.isArray(item.chiild) ? item.chiild : [];
    const titleValue = asDiyRecord(child[0])?.val;
    const title = typeof titleValue === "string" || typeof titleValue === "number"
      ? String(titleValue).trim().slice(0, 100)
      : "";
    if (!title) return [];
    return [{ title, link: normalizeDiyLink(asDiyRecord(child[1])?.val) }];
  })
));
const newsListStyle = computed(() => Number(configValue("styleConfig")?.tabVal) === 1);
const titleImage = computed(() => (
  Number(configValue("titleConfig")?.tabVal) === 0 ? imageFrom(configValue("imgConfig")) : ""
));
const titleText = computed(() => diyText(props.block, "titleTxtConfig", "商城头条").slice(0, 20));
const showMore = computed(() => Number(configValue("buttonConfig")?.tabVal) === 0);
const moreText = computed(() => diyText(props.block, "textConfig", "更多").slice(0, 10));
const moreLink = computed(() => normalizeDiyLink(diyText(props.block, "linkConfig", "/pages/article/list")) || "/pages/article/list");
const cardStyle = computed(() => ({
  borderRadius: radius(),
  background: `linear-gradient(90deg, ${configColor("moduleColor", 0, "#ffffff")}, ${configColor("moduleColor", 1, "#ffffff")})`,
}));
const titleStyle = computed(() => ({ color: configColor("titleColor", 0, "#333333") }));
const tickerTitleStyle = computed(() => ({
  color: configColor("titleColor", 0, "#ffffff"),
  background: `linear-gradient(90deg, ${configColor("titleBgColor", 0, "#e93323")}, ${configColor("titleBgColor", 1, "#e93323")})`,
}));
const newsTextStyle = computed(() => ({ color: configColor("newsColor", 0, "#333333") }));
const buttonStyle = computed(() => ({ color: configColor("bntColor", 0, "#999999") }));

const hotspotImage = computed(() => safeDiyImageUrl(configValue("picStyle")?.url));
const hotspotAreas = computed<HotspotArea[]>(() => (
  diyList(props.block, "picStyle", "list").slice(0, 30).flatMap((value) => {
    const item = asDiyRecord(value);
    const link = normalizeDiyLink(item?.link);
    if (!item || !link) return [];
    const left = bounded(item.starX, 0, 0, 750);
    const top = bounded(item.starY, 0, 0, 2_000);
    const width = bounded(item.areaWidth, 0, 1, 750 - left);
    const height = bounded(item.areaHeight, 0, 1, 2_000 - top);
    return [{ link, style: { left: `${left}rpx`, top: `${top}rpx`, width: `${width}rpx`, height: `${height}rpx` } }];
  })
));

const partyTitle = computed(() => diyText(props.block, "titleConfig", "超值爆款").slice(0, 30));
const partyDescription = computed(() => diyText(props.block, "desConfig", "").slice(0, 80));
const partyItems = computed<PartyItem[]>(() => (
  diyList(props.block, "menuConfig", "list").slice(0, 4).flatMap((value) => {
    const item = asDiyRecord(value);
    if (!item) return [];
    const title = textFromInfo(item, 0, 40);
    const description = textFromInfo(item, 1, 100);
    const link = normalizeDiyLink(textFromInfo(item, 2, 2_048));
    const image = imageFrom(item);
    if (!title && !description && !image) return [];
    return [{ title: title || "精选活动", description, link, image }];
  })
));
const partyStyle = computed(() => ({ backgroundColor: configColor("boxColor", 0, "#fff4f2") }));
const partyTitleStyle = computed(() => ({ color: configColor("themeColor", 0, "#e93323") }));
const partyBadgeStyle = computed(() => ({
  background: `linear-gradient(90deg, ${configColor("bgColor", 0, "#f62c2c")}, ${configColor("bgColor", 1, "#f96e29")})`,
}));

const followImage = computed(() => imageFrom(configValue("imgConfig")));
const followCode = computed(() => imageFrom(configValue("codeConfig")));
const followTitle = computed(() => diyText(props.block, "titleConfig", "关注公众号").slice(0, 40));
const followVisible = computed(() => Boolean(followTitle.value || followImage.value || followCode.value));
const followWrapStyle = computed(() => ({
  padding: `0 ${bounded(diyNumber(props.block, "prConfig"), 0, 0, 80) * 2}rpx`,
  marginTop: `${bounded(diyNumber(props.block, "mbConfig"), 0, 0, 100) * 2}rpx`,
}));
const followCardStyle = computed(() => ({
  borderRadius: radius(),
  background: `linear-gradient(90deg, ${configColor("bgColor", 0, "#ffffff")}, ${configColor("bgColor", 1, "#ffffff")})`,
}));
const followButtonStyle = computed(() => {
  const color = configColor("themeColor", 0, "#e93323");
  return { color, borderColor: color };
});

function showFollowCode(): void {
  if (!followCode.value) {
    uni.showToast({ title: "暂未配置公众号二维码", icon: "none" });
    return;
  }
  followCodeOpen.value = true;
}
</script>

<style scoped>
.editorial-wrap { width: 100%; box-sizing: border-box; }
.news-card { margin: 0 20rpx; padding: 28rpx 24rpx; overflow: hidden; }
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
.news-ticker { display: flex; height: 88rpx; margin: 0 20rpx; padding: 0 20rpx; align-items: center; overflow: hidden; box-sizing: border-box; }
.news-ticker-logo { width: 52rpx; height: 52rpx; margin-right: 16rpx; }
.news-ticker-title { margin-right: 16rpx; padding: 6rpx 12rpx; border-radius: 8rpx; font-size: 24rpx; white-space: nowrap; }
.news-swiper { height: 42rpx; flex: 1; min-width: 0; }
.news-swiper-item { overflow: hidden; font-size: 25rpx; line-height: 42rpx; text-overflow: ellipsis; white-space: nowrap; }
.hotspot-card { position: relative; width: 100%; overflow: hidden; }
.hotspot-image { display: block; width: 100%; }
.hotspot-area { position: absolute; z-index: 2; }
.party-card { margin: 20rpx; padding: 26rpx; border-radius: 20rpx; }
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
.follow-dialog-close { margin-top: 30rpx; color: #fff; border: 0; background: #e93323; }
</style>
