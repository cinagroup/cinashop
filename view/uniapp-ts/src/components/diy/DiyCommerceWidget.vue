<template>
  <view v-if="visible" class="commerce-wrap" :style="outerStyle">
    <view v-if="block.name === 'promotionList'" class="commerce-panel" :style="panelStyle">
      <scroll-view scroll-x class="promotion-tabs">
        <view
          v-for="(tab, index) in promotionTabs"
          :key="`${index}-${tab.label}`"
          class="promotion-tab"
          :class="{ active: index === activePromotionIndex }"
          :style="index === activePromotionIndex ? accentStyle : undefined"
          @tap="selectPromotion(index)"
        >
          <image v-if="tab.image" class="promotion-tab-image" :src="tab.image" mode="aspectFill" />
          <text class="promotion-tab-label">{{ tab.label }}</text>
          <text v-if="tab.description" class="promotion-tab-description">{{ tab.description }}</text>
        </view>
      </scroll-view>
      <view v-if="promotionProducts.length" class="commerce-grid">
        <view
          v-for="product in promotionProducts"
          :key="product.id"
          class="commerce-card"
          @tap="open(`/pages/goods/detail?id=${product.id}`)"
        >
          <image v-if="safeImage(product.image)" class="commerce-image" :src="safeImage(product.image)" mode="aspectFill" />
          <view class="commerce-copy">
            <text class="commerce-title">{{ product.store_name }}</text>
            <view class="commerce-price-row">
              <text class="commerce-price" :style="accentTextStyle">¥{{ product.price }}</text>
              <text class="commerce-meta">已售 {{ product.sales ?? 0 }}</text>
            </view>
          </view>
        </view>
      </view>
    </view>

    <view v-else-if="block.name === 'coupon' && coupons.length" class="coupon-strip">
      <view
        v-for="coupon in coupons"
        :key="coupon.id"
        class="coupon-card"
        :style="couponStyle"
      >
        <view class="coupon-value">
          <text v-if="coupon.coupon_type === 2" class="coupon-number">
            {{ discountValue(coupon.coupon_price) }}折
          </text>
          <text v-else class="coupon-number">¥{{ coupon.coupon_price }}</text>
          <text class="coupon-condition">满{{ coupon.use_min_price }}可用</text>
        </view>
        <view class="coupon-copy">
          <text class="coupon-title">{{ coupon.coupon_title || couponScope(coupon.type) }}</text>
          <text class="coupon-scope">{{ couponScope(coupon.type) }}</text>
        </view>
        <button
          class="coupon-button"
          size="mini"
          :disabled="coupon.is_use !== false || receivingCouponId === coupon.id"
          @tap="receiveCoupon(coupon)"
        >
          {{ coupon.is_use === true ? '已领取' : coupon.is_use === 2 ? '已过期' : '领取' }}
        </button>
      </view>
    </view>

    <view v-else-if="block.name === 'liveBroadcast' && miniProgram && liveRooms.length" class="commerce-panel" :style="panelStyle">
      <view class="commerce-heading">
        <text>{{ sectionTitle }}</text>
        <text class="commerce-more">微信直播</text>
      </view>
      <view class="live-grid">
        <view v-for="room in liveRooms" :key="room.id" class="live-card" @tap="openLive(room.room_id)">
          <image v-if="safeImage(room.cover_img)" class="live-image" :src="safeImage(room.cover_img)" mode="aspectFill" />
          <text class="live-status">{{ liveStatus(room.live_status) }}</text>
          <text class="commerce-title">{{ room.name }}</text>
          <view class="live-anchor">
            <image v-if="safeImage(room.anchor_img)" class="live-avatar" :src="safeImage(room.anchor_img)" mode="aspectFill" />
            <text>{{ room.anchor_name || room.show_time }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-else-if="cards.length" class="commerce-panel" :style="panelStyle">
      <view class="commerce-heading">
        <text>{{ sectionTitle }}</text>
        <text class="commerce-more" @tap="open(moreTarget)">{{ moreLabel }} ›</text>
      </view>
      <scroll-view v-if="block.name === 'seckill' && seckillTimes.length" scroll-x class="seckill-times">
        <view
          v-for="time in seckillTimes"
          :key="time.id"
          class="seckill-time"
          :class="{ active: time.id === activeSeckillId }"
          :style="time.id === activeSeckillId ? accentStyle : undefined"
          @tap="loadSeckillForTime(time.id)"
        >
          <text>{{ time.start_time }}</text>
          <text>{{ time.state }}</text>
        </view>
      </scroll-view>
      <view class="commerce-grid">
        <view v-for="card in cards" :key="`${card.kind}-${card.id}`" class="commerce-card" @tap="open(card.target)">
          <view class="commerce-image-wrap">
            <image v-if="card.image" class="commerce-image" :src="card.image" mode="aspectFill" />
            <text v-if="card.badge" class="commerce-badge" :style="accentStyle">{{ card.badge }}</text>
          </view>
          <view class="commerce-copy">
            <text class="commerce-title">{{ card.title }}</text>
            <text v-if="card.meta" class="commerce-meta">{{ card.meta }}</text>
            <view class="commerce-price-row">
              <text class="commerce-price" :style="accentTextStyle">{{ card.price }}</text>
              <text v-if="card.oldPrice" class="commerce-old-price">{{ card.oldPrice }}</text>
            </view>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  apiBargainList,
  apiCombinationList,
  apiCouponList,
  apiCouponReceive,
  apiIntegralList,
  apiLiveRooms,
  apiPresaleList,
  apiSeckillIndex,
  apiSeckillList,
  type BargainListItem,
  type CombinationListItem,
  type CouponListItem,
  type IntegralListItem,
  type LiveRoomListItem,
  type PresaleListItem,
  type SeckillListItem,
  type SeckillTimeItem,
} from "@/api/activity";
import type { DiyComponent } from "@/api/diy";
import { apiGoodsList } from "@/api/product";
import type { GoodsItem } from "@/types/product";
import { useAuthStore } from "@/stores/auth";
import {
  asDiyRecord,
  diyList,
  diyNumber,
  diyText,
  openDiyLink,
  safeDiyColor,
  safeDiyImageUrl,
} from "@/utils/diy";

interface CommerceCard {
  id: number;
  kind: string;
  title: string;
  image: string;
  price: string;
  oldPrice: string;
  badge: string;
  meta: string;
  target: string;
}

interface PromotionTab {
  label: string;
  description: string;
  image: string;
  source: Record<string, unknown>;
}

const props = defineProps<{ block: DiyComponent }>();
const auth = useAuthStore();
const loading = ref(false);
const seckillTimes = ref<SeckillTimeItem[]>([]);
const activeSeckillId = ref(0);
const seckillItems = ref<SeckillListItem[]>([]);
const combinationItems = ref<CombinationListItem[]>([]);
const bargainItems = ref<BargainListItem[]>([]);
const integralItems = ref<IntegralListItem[]>([]);
const presaleItems = ref<PresaleListItem[]>([]);
const coupons = ref<CouponListItem[]>([]);
const liveRooms = ref<LiveRoomListItem[]>([]);
const promotionProducts = ref<GoodsItem[]>([]);
const activePromotionIndex = ref(0);
const receivingCouponId = ref(0);
let hydration = 0;
let promotionHydration = 0;
let seckillHydration = 0;
let miniProgram = false;
// #ifdef MP-WEIXIN
miniProgram = true;
// #endif

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function configRecord(key: string): Record<string, unknown> | null {
  return asDiyRecord(props.block[key]);
}

function configColor(key: string, fallback: string): string {
  const colors = configRecord(key)?.color;
  const value = Array.isArray(colors) ? asDiyRecord(colors[0])?.item : undefined;
  return safeDiyColor(value, fallback);
}

function safeImage(value: unknown): string {
  return safeDiyImageUrl(value);
}

function open(target: unknown): void {
  openDiyLink(target);
}

const limit = computed(() => bounded(diyNumber(props.block, "numberConfig", 6), 6, 1, 20));
const outerStyle = computed<Record<string, string>>(() => ({
  padding: `${bounded(diyNumber(props.block, "topConfig"), 0, 0, 100) * 2}rpx ${bounded(diyNumber(props.block, "prConfig"), 0, 0, 80) * 2}rpx ${bounded(diyNumber(props.block, "bottomConfig"), 0, 0, 100) * 2}rpx`,
  marginTop: `${bounded(diyNumber(props.block, "mbConfig"), 0, 0, 100) * 2}rpx`,
  backgroundColor: configColor("bottomBgColor", "transparent"),
}));
const panelStyle = computed(() => ({
  borderRadius: `${bounded(configRecord("fillet")?.val, 12, 0, 60) * 2}rpx`,
}));
const accent = computed(() => configColor("themeColor", configColor("priceColor", "#e93323")));
const accentStyle = computed(() => ({ backgroundColor: accent.value, color: "#ffffff" }));
const accentTextStyle = computed(() => ({ color: accent.value }));
const couponStyle = computed(() => ({
  borderColor: configColor("couponBgColor", accent.value),
  backgroundColor: configColor("moduleColor", "#ffffff"),
}));

const fallbackTitles: Record<string, string> = {
  seckill: "限时秒杀",
  combination: "拼团精选",
  bargain: "全民砍价",
  presale: "预售专区",
  pointsMall: "积分商城",
  liveBroadcast: "直播间",
};
const moreTargets: Record<string, string> = {
  seckill: "/pages/activity/index",
  combination: "/pages/activity/index",
  bargain: "/pages/activity/index",
  presale: "/pages/goods/list",
  pointsMall: "/pages/user/integral",
};
const sectionTitle = computed(() => (
  diyText(props.block, "titleTxtConfig", fallbackTitles[props.block.name] ?? "精选活动").slice(0, 30)
));
const moreTarget = computed(() => moreTargets[props.block.name] ?? "/pages/activity/index");
const moreLabel = computed(() => props.block.name === "pointsMall" ? "去兑换" : "更多");

function textChild(item: Record<string, unknown>, index: number, fallback: string): string {
  const children = Array.isArray(item.chiild) ? item.chiild : [];
  const value = asDiyRecord(children[index])?.val;
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim().slice(0, 30)
    : fallback;
}

const promotionTabs = computed<PromotionTab[]>(() => (
  diyList(props.block, "tabConfig", "list").slice(0, 12).flatMap((value, index) => {
    const item = asDiyRecord(value);
    if (!item) return [];
    return [{
      label: textChild(item, 0, `分组 ${index + 1}`),
      description: textChild(item, 1, ""),
      image: safeImage(item.image),
      source: item,
    }];
  })
));

function idList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const item = asDiyRecord(entry);
    return Number(item?.id ?? item?.value ?? entry);
  }).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 50);
}

function nestedIds(source: Record<string, unknown>, key: string, child: string): number[] {
  return idList(asDiyRecord(source[key])?.[child]);
}

async function loadPromotion(index: number): Promise<void> {
  const generation = ++promotionHydration;
  const tab = promotionTabs.value[index];
  promotionProducts.value = [];
  if (!tab) return;
  const source = tab.source;
  const rawType = Number(source.tabVal ?? 0);
  const type = rawType === 0 ? 3 : rawType;
  const goods = asDiyRecord(source.goodsList);
  const ids = idList(Array.isArray(goods?.ids) ? goods.ids : goods?.list);
  const brands = nestedIds(source, "brandConfig", "brandVal");
  const categories = nestedIds(source, "selectConfig", "activeValue");
  const labels = nestedIds(source, "goodsLabel", "activeValue");
  if ((type === 1 && !ids.length) || (type === 2 && !brands.length)
    || (type === 3 && !categories.length) || (type === 4 && !labels.length)) return;
  const sort = Number(source.goodsSort ?? 0);
  const tabLimit = bounded(asDiyRecord(source.numConfig)?.val, limit.value, 1, 20);
  try {
    const result = await apiGoodsList({
      page: 1,
      limit: tabLimit,
      ...(type === 1 ? { ids: ids.join(",") } : {}),
      ...(type === 2 ? { brand_id: brands.join(",") } : {}),
      ...(type === 3 ? { cate_id: categories.join(",") } : {}),
      ...(type === 4 ? { store_label_id: labels.join(",") } : {}),
      ...(sort === 1 ? { salesOrder: "desc" as const } : {}),
      ...(sort === 2 ? { priceOrder: "desc" as const } : {}),
    });
    if (generation === promotionHydration) promotionProducts.value = result.list ?? [];
  } catch {
    if (generation === promotionHydration) promotionProducts.value = [];
  }
}

function selectPromotion(index: number): void {
  if (index < 0 || index >= promotionTabs.value.length) return;
  activePromotionIndex.value = index;
  void loadPromotion(index);
}

async function loadSeckillForTime(id: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const generation = ++seckillHydration;
  activeSeckillId.value = id;
  try {
    const value = await apiSeckillList(id, { page: 1, limit: limit.value });
    if (generation === seckillHydration) seckillItems.value = value;
  } catch {
    if (generation === seckillHydration) seckillItems.value = [];
  }
}

function resetData(): void {
  seckillTimes.value = [];
  activeSeckillId.value = 0;
  seckillItems.value = [];
  combinationItems.value = [];
  bargainItems.value = [];
  integralItems.value = [];
  presaleItems.value = [];
  coupons.value = [];
  liveRooms.value = [];
  promotionProducts.value = [];
}

async function hydrate(): Promise<void> {
  const generation = ++hydration;
  resetData();
  activePromotionIndex.value = 0;
  loading.value = true;
  try {
    if (props.block.name === "promotionList") {
      await loadPromotion(0);
    } else if (props.block.name === "seckill") {
      const index = await apiSeckillIndex();
      if (generation !== hydration) return;
      seckillTimes.value = index.seckillTime.slice(0, 12);
      const active = index.seckillTime[index.seckillTimeIndex] ?? index.seckillTime[0];
      if (active) await loadSeckillForTime(active.id);
    } else if (props.block.name === "combination") {
      combinationItems.value = await apiCombinationList({ page: 1, limit: limit.value });
    } else if (props.block.name === "bargain") {
      bargainItems.value = await apiBargainList({ page: 1, limit: limit.value });
    } else if (props.block.name === "pointsMall") {
      integralItems.value = await apiIntegralList({ page: 1, limit: limit.value });
    } else if (props.block.name === "presale") {
      presaleItems.value = (await apiPresaleList({ page: 1, limit: limit.value, time_type: 0 })).list ?? [];
    } else if (props.block.name === "coupon") {
      coupons.value = (await apiCouponList({ page: 1, limit: limit.value })).list ?? [];
    } else if (props.block.name === "liveBroadcast" && miniProgram) {
      liveRooms.value = await apiLiveRooms({ page: 1, limit: limit.value });
    }
  } catch {
    if (generation === hydration) resetData();
  } finally {
    if (generation === hydration) loading.value = false;
  }
}

function money(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

const cards = computed<CommerceCard[]>(() => {
  if (props.block.name === "seckill") return seckillItems.value.slice(0, limit.value).map((item) => ({
    id: item.id, kind: "seckill", title: item.title.slice(0, 100), image: safeImage(item.image),
    price: `¥${money(item.price)}`, oldPrice: `¥${money(item.ot_price)}`, badge: `${item.percent}%`,
    meta: `剩余 ${Math.max(0, item.stock)}`, target: `/pages/activity/seckillDetail?id=${item.id}`,
  }));
  if (props.block.name === "combination") return combinationItems.value.slice(0, limit.value).map((item) => ({
    id: item.id, kind: "combination", title: item.title.slice(0, 100), image: safeImage(item.image),
    price: `¥${money(item.price)}`, oldPrice: `¥${money(item.ot_price)}`, badge: `${item.people}人团`,
    meta: `已拼 ${Math.max(0, item.pink_count)} 份`, target: `/pages/activity/detail?id=${item.id}`,
  }));
  if (props.block.name === "bargain") return bargainItems.value.slice(0, limit.value).map((item) => ({
    id: item.id, kind: "bargain", title: item.title.slice(0, 100), image: safeImage(item.image),
    price: `砍至 ¥${money(item.min_price)}`, oldPrice: `¥${money(item.ot_price)}`, badge: "砍价",
    meta: `${Math.max(0, item.people)} 人参与`, target: `/pages/activity/bargainDetail?id=${item.id}`,
  }));
  if (props.block.name === "pointsMall") return integralItems.value.slice(0, limit.value).map((item) => ({
    id: item.id, kind: "points", title: item.title.slice(0, 100), image: safeImage(item.image),
    price: `${Math.max(0, item.integral)}积分`, oldPrice: Number(item.price) > 0 ? `+ ¥${money(item.price)}` : "",
    badge: "积分兑", meta: `库存 ${Math.max(0, item.stock)}`, target: "/pages/user/integral",
  }));
  if (props.block.name === "presale") return presaleItems.value.slice(0, limit.value).map((item) => ({
    id: item.id, kind: "presale", title: item.store_name.slice(0, 100), image: safeImage(item.image),
    price: `¥${money(item.price)}`, oldPrice: `¥${money(item.ot_price)}`,
    badge: ["预售", "即将开始", "预售中", "已结束"][item.presale_pay_status] ?? "预售",
    meta: `已售 ${Math.max(0, item.sales)}`, target: `/pages/goods/detail?id=${item.id}`,
  }));
  return [];
});

const visible = computed(() => loading.value
  || cards.value.length > 0
  || promotionProducts.value.length > 0
  || coupons.value.length > 0
  || (miniProgram && liveRooms.value.length > 0));

function discountValue(value: unknown): string {
  const number = Number(value) / 10;
  return Number.isFinite(number) ? String(number) : "0";
}

function couponScope(type: number): string {
  return ["通用券", "品类券", "商品券", "品牌券"][type] ?? "优惠券";
}

async function receiveCoupon(coupon: CouponListItem): Promise<void> {
  if (coupon.is_use !== false || receivingCouponId.value) return;
  if (!auth.isLoggedIn) {
    uni.navigateTo({ url: "/pages/auth/login" });
    return;
  }
  receivingCouponId.value = coupon.id;
  try {
    await apiCouponReceive(coupon.id);
    coupons.value = coupons.value.map((item) => item.id === coupon.id ? { ...item, is_use: true } : item);
    uni.showToast({ title: "领取成功", icon: "success" });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "领取失败", icon: "none" });
  } finally {
    receivingCouponId.value = 0;
  }
}

function liveStatus(status: number): string {
  return status === 101 ? "直播中" : status === 102 ? "即将开始" : "已结束";
}

function openLive(roomId: number): void {
  if (!Number.isSafeInteger(roomId) || roomId <= 0 || !miniProgram) return;
  // #ifdef MP-WEIXIN
  uni.navigateTo({
    url: `plugin-private://wx2b03c6e691cd7370/pages/live-player-plugin?room_id=${roomId}`,
  });
  // #endif
}

watch(() => props.block, () => { void hydrate(); }, { immediate: true });
</script>

<style scoped>
.commerce-wrap { width: 100%; box-sizing: border-box; }
.commerce-panel { margin: 0 20rpx; padding: 24rpx; overflow: hidden; background: #fff; box-sizing: border-box; }
.commerce-heading { display: flex; margin-bottom: 20rpx; align-items: center; justify-content: space-between; color: #222; font-size: 31rpx; font-weight: 700; }
.commerce-more { color: #999; font-size: 22rpx; font-weight: 400; }
.commerce-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx; }
.commerce-card { min-width: 0; overflow: hidden; border: 1rpx solid #eee; border-radius: 14rpx; background: #fff; }
.commerce-image-wrap { position: relative; }
.commerce-image { display: block; width: 100%; height: 260rpx; background: #f5f5f5; }
.commerce-badge { position: absolute; top: 10rpx; left: 10rpx; padding: 5rpx 10rpx; border-radius: 18rpx; font-size: 18rpx; }
.commerce-copy { padding: 14rpx; }
.commerce-title { display: -webkit-box; min-height: 66rpx; overflow: hidden; color: #333; font-size: 25rpx; line-height: 33rpx; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.commerce-meta { display: block; margin-top: 7rpx; overflow: hidden; color: #999; font-size: 20rpx; text-overflow: ellipsis; white-space: nowrap; }
.commerce-price-row { display: flex; min-width: 0; margin-top: 9rpx; align-items: baseline; gap: 8rpx; }
.commerce-price { font-size: 25rpx; font-weight: 700; }
.commerce-old-price { overflow: hidden; color: #aaa; font-size: 18rpx; text-decoration: line-through; text-overflow: ellipsis; white-space: nowrap; }
.promotion-tabs, .seckill-times { width: 100%; margin-bottom: 22rpx; white-space: nowrap; }
.promotion-tab { display: inline-flex; min-width: 110rpx; max-width: 190rpx; margin-right: 12rpx; padding: 12rpx 18rpx; align-items: center; border-radius: 28rpx; color: #666; background: #f5f5f5; vertical-align: top; flex-direction: column; box-sizing: border-box; }
.promotion-tab.active { color: #fff; }
.promotion-tab-image { width: 42rpx; height: 42rpx; margin-bottom: 5rpx; border-radius: 50%; }
.promotion-tab-label, .promotion-tab-description { max-width: 100%; overflow: hidden; font-size: 22rpx; text-overflow: ellipsis; white-space: nowrap; }
.promotion-tab-description { margin-top: 2rpx; font-size: 17rpx; opacity: .8; }
.seckill-time { display: inline-flex; min-width: 120rpx; margin-right: 12rpx; padding: 10rpx 14rpx; align-items: center; border-radius: 12rpx; color: #666; background: #f5f5f5; font-size: 20rpx; vertical-align: top; flex-direction: column; }
.coupon-strip { display: flex; margin: 0 20rpx; gap: 14rpx; overflow-x: auto; }
.coupon-card { display: flex; min-width: 610rpx; padding: 20rpx; align-items: center; border: 2rpx solid; border-radius: 18rpx; box-sizing: border-box; }
.coupon-value { display: flex; width: 180rpx; align-items: center; color: #e93323; flex-direction: column; }
.coupon-number { font-size: 38rpx; font-weight: 700; }
.coupon-condition, .coupon-scope { margin-top: 4rpx; color: #888; font-size: 19rpx; }
.coupon-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.coupon-title { overflow: hidden; color: #333; font-size: 25rpx; text-overflow: ellipsis; white-space: nowrap; }
.coupon-button { width: 100rpx; margin: 0; padding: 0; border: 0; border-radius: 28rpx; color: #fff; background: #e93323; font-size: 21rpx; line-height: 50rpx; }
.coupon-button::after { border: 0; }
.coupon-button[disabled] { color: #999; background: #eee; }
.live-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx; }
.live-card { position: relative; min-width: 0; }
.live-image { width: 100%; height: 320rpx; border-radius: 14rpx; background: #f5f5f5; }
.live-status { position: absolute; top: 10rpx; left: 10rpx; padding: 5rpx 11rpx; border-radius: 16rpx; color: #fff; background: #e93323; font-size: 18rpx; }
.live-anchor { display: flex; margin-top: 8rpx; align-items: center; color: #888; font-size: 20rpx; }
.live-avatar { width: 36rpx; height: 36rpx; margin-right: 8rpx; border-radius: 50%; }
</style>
