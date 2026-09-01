<template>
  <view class="diy-renderer">
    <template v-for="(block, index) in components" :key="blockKey(block, index)">
      <view
        v-if="block.name === 'headerSerch'"
        class="diy-search"
        @tap="open('/pages/goods/search')"
      >
        <image v-if="componentImage(block, 'logoConfig')" class="search-logo" :src="componentImage(block, 'logoConfig')" mode="heightFix" />
        <text class="search-copy">⌕ {{ componentText(block, 'tipConfig', '搜索商品') }}</text>
      </view>

      <view v-else-if="block.name === 'homeComb'" class="diy-combination-header">
        <view class="diy-search compact" @tap="open('/pages/goods/search')">
          <image v-if="componentImage(block, 'logoConfig')" class="search-logo" :src="componentImage(block, 'logoConfig')" mode="heightFix" />
          <text class="search-copy">⌕ {{ componentText(block, 'inputConfig', '搜索商品') }}</text>
        </view>
        <DiyMediaCarousel :items="mediaItems(block)" @open="open" />
      </view>

      <DiyMediaCarousel
        v-else-if="block.name === 'swipers' || block.name === 'swiperBg'"
        :items="mediaItems(block)"
        @open="open"
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

      <view v-else-if="block.name === 'goodList' && productLists[index]?.length" class="diy-section">
        <view class="diy-section-title">{{ componentText(block, 'titleTxtConfig', '推荐商品') }}</view>
        <view class="diy-product-grid">
          <view
            v-for="product in productLists[index]"
            :key="product.id"
            class="diy-product-card"
            @tap="goProduct(product.id)"
          >
            <image class="diy-product-image" :src="safeImage(product.image)" mode="aspectFill" />
            <text class="diy-product-name">{{ product.store_name }}</text>
            <view class="diy-price-row">
              <text class="diy-price">¥{{ product.price }}</text>
              <text class="diy-sales">已售 {{ product.sales ?? 0 }}</text>
            </view>
          </view>
        </view>
      </view>

      <view v-else-if="block.name === 'articleList' && articles.length" class="diy-section">
        <view class="diy-section-title">{{ componentText(block, 'nameConfig', '品牌资讯') }}</view>
        <view
          v-for="article in articles"
          :key="article.id"
          class="diy-article"
          @tap="open(`/pages/article/detail?id=${article.id}`)"
        >
          <image v-if="article.image_input[0]" class="diy-article-image" :src="safeImage(article.image_input[0])" mode="aspectFill" />
          <view class="diy-article-copy">
            <text class="diy-article-title">{{ article.title }}</text>
            <text class="diy-article-meta">{{ article.add_time }} · {{ article.visit }} 次浏览</text>
          </view>
        </view>
      </view>

      <view v-else-if="block.name === 'ranking' && hasRanks" class="diy-section">
        <view class="diy-section-title">{{ componentText(block, 'titleTxtConfig', '商品排行榜') }}</view>
        <view v-for="group in rankGroups" :key="group.key" v-show="group.items.length" class="diy-rank-group">
          <text class="diy-rank-label">{{ group.label }}</text>
          <scroll-view scroll-x class="diy-horizontal-scroll">
            <view
              v-for="(product, productIndex) in group.items"
              :key="product.id"
              class="diy-rank-product"
              @tap="goProduct(product.id)"
            >
              <text class="diy-rank-number">{{ productIndex + 1 }}</text>
              <image class="diy-rank-image" :src="safeImage(product.image)" mode="aspectFill" />
              <text class="diy-rank-name">{{ product.store_name }}</text>
              <text class="diy-price">¥{{ product.price }}</text>
            </view>
          </scroll-view>
        </view>
      </view>

      <view
        v-else-if="block.name === 'newVip' && hasNewcomer"
        class="diy-section diy-newcomer"
        @tap="open('/pages/activity/index')"
      >
        <view class="diy-section-title">新人专享福利</view>
        <text v-if="newcomerPoints > 0" class="diy-newcomer-points">注册即得 {{ newcomerPoints }} 积分</text>
        <scroll-view v-if="newcomer.newcomer_products.length" scroll-x class="diy-horizontal-scroll">
          <view
            v-for="product in newcomer.newcomer_products"
            :key="product.id"
            class="diy-rank-product"
            @tap.stop="goProduct(product.product_id ?? product.id)"
          >
            <image class="diy-rank-image" :src="safeImage(product.image)" mode="aspectFill" />
            <text class="diy-rank-name">{{ product.store_name }}</text>
            <text class="diy-price">¥{{ product.price }}</text>
          </view>
        </scroll-view>
        <text v-if="newcomer.newcomer_coupon.length" class="diy-newcomer-coupon">
          另有 {{ newcomer.newcomer_coupon.length }} 张新人优惠券
        </text>
      </view>

      <view v-else-if="block.name === 'signIn' && sign" class="diy-section diy-sign" @tap="open('/pages/user/sign')">
        <view>
          <text class="diy-section-title">每日签到</text>
          <text class="diy-sign-copy">签到可得 {{ sign.sign_give_point }} 积分</text>
        </view>
        <view class="diy-sign-days">
          <text
            v-for="day in sign.signList[0] ?? []"
            :key="day.day"
            class="diy-sign-day"
            :class="{ signed: day.is_sign, today: day.sign_day }"
          >{{ day.day }}</text>
        </view>
      </view>

      <view v-else-if="block.name === 'userInfor'" class="diy-user-card" @tap="open('/pages/user/index')">
        <template v-if="userInfo">
          <image class="diy-avatar" :src="safeImage(userInfo.avatar)" mode="aspectFill" />
          <view class="diy-user-copy">
            <text class="diy-user-name">{{ userInfo.nickname || 'CinaShop 用户' }}</text>
            <text class="diy-user-meta">{{ userInfo.vip_name || '普通会员' }} · {{ userInfo.integral }} 积分</text>
          </view>
          <view class="diy-user-counts">
            <text>{{ userInfo.coupon_num }} 券</text>
            <text>{{ userInfo.collectCount }} 收藏</text>
          </view>
        </template>
        <template v-else>
          <view class="diy-avatar diy-avatar-placeholder">人</view>
          <text class="diy-user-name">登录查看会员权益</text>
          <text class="diy-more">去登录 ›</text>
        </template>
      </view>

      <view v-else-if="block.name === 'community' && videos.length" class="diy-section">
        <view class="diy-section-title">{{ componentText(block, 'titleTxtConfig', '精选视频') }}</view>
        <scroll-view scroll-x class="diy-horizontal-scroll">
          <view v-for="video in videos" :key="video.id" class="diy-video-preview">
            <image class="diy-video-poster" :src="safeImage(video.image)" mode="aspectFill" />
            <text class="diy-rank-name">{{ video.desc }}</text>
          </view>
        </scroll-view>
      </view>

      <DiyEditorialWidget
        v-else-if="isEditorialWidget(block)"
        :block="block"
      />

      <DiyCommerceWidget
        v-else-if="isCommerceWidget(block)"
        :block="block"
      />

      <view v-else-if="block.name === 'customerService'" class="diy-service" @tap="open('/pages/user/kefu')">
        <text>在线客服</text>
        <text class="diy-more">咨询 ›</text>
      </view>

      <view v-else-if="microPage && block.name === 'pageFoot'" class="diy-page-foot">
        <view
          v-for="(item, itemIndex) in footerItems(block)"
          :key="`${index}-foot-${itemIndex}`"
          class="diy-foot-item"
          @tap="open(item.link)"
        >
          <image v-if="item.image" class="diy-foot-image" :src="item.image" mode="aspectFit" />
          <text>{{ item.label }}</text>
        </view>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  apiDiyNewcomerList,
  apiDiyProductRank,
  apiDiySign,
  apiDiyUserInfo,
  apiDiyVideoList,
  type DiyComponent,
  type DiyNewcomerData,
  type DiyProductRanks,
  type DiySignData,
  type DiyUserInfo,
  type DiyVideoItem,
} from "@/api/diy";
import { apiArticleList, type ArticleListItem } from "@/api/article";
import { apiGoodsList } from "@/api/product";
import type { GoodsItem } from "@/types/product";
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
import DiyEditorialWidget from "./DiyEditorialWidget.vue";
import DiyCommerceWidget from "./DiyCommerceWidget.vue";

interface MenuItem {
  image: string;
  label: string;
  link: string;
}

const props = withDefaults(defineProps<{
  components: DiyComponent[];
  microPage?: boolean;
}>(), {
  microPage: false,
});

const productLists = ref<Record<number, GoodsItem[]>>({});
const articles = ref<ArticleListItem[]>([]);
const ranks = ref<DiyProductRanks>({ sales: [], star: [], collect: [] });
const newcomer = ref<DiyNewcomerData>({
  newcomer_products: [],
  newcomer_integral: [],
  newcomer_coupon: [],
});
const sign = ref<DiySignData | null>(null);
const userInfo = ref<DiyUserInfo | null>(null);
const videos = ref<DiyVideoItem[]>([]);
let hydration = 0;
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

function mediaItems(block: DiyComponent): MenuItem[] {
  return diyList(block, "swiperConfig", "list").slice(0, 20).flatMap((raw) => {
    const item = asDiyRecord(raw);
    const image = safeDiyImageUrl(item?.img ?? item?.image);
    if (!item || !image) return [];
    return [{ image, label: "", link: diyItemLink(item) }];
  });
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

function goProduct(id: number): void {
  if (Number.isSafeInteger(id) && id > 0) open(`/pages/goods/detail?id=${id}`);
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

function boundedLimit(value: number, fallback: number, cap: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), cap) : fallback;
}

async function loadProducts(block: DiyComponent): Promise<GoodsItem[]> {
  const type = tabValue(block, "typeConfig");
  const ids = diyList(block, "goodsList", "ids")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 50);
  const categories = diyList(block, "classList", "classVal")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 50);
  const brands = diyList(block, "brandList", "brandVal")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 50);
  const labels = diyList(block, "goodsLabel", "activeValue")
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .slice(0, 50);
  if ((type === 1 && !ids.length) || (type === 2 && !brands.length)
    || (type === 3 && !categories.length) || (type === 4 && !labels.length)) return [];
  const sort = tabValue(block, "goodsSort");
  const result = await apiGoodsList({
    page: 1,
    limit: boundedLimit(diyNumber(block, "numberConfig", 8), 8, 20),
    ...(type === 1 && ids.length ? { ids: ids.join(",") } : {}),
    ...(type === 2 && brands.length ? { brand_id: brands.join(",") } : {}),
    ...(type === 3 && categories.length ? { cate_id: categories.join(",") } : {}),
    ...(type === 4 && labels.length ? { store_label_id: labels.join(",") } : {}),
    ...(sort === 1 ? { salesOrder: "desc" as const } : {}),
    ...(sort === 2 ? { priceOrder: "desc" as const } : {}),
  });
  return result.list ?? [];
}

async function hydrate(): Promise<void> {
  const generation = ++hydration;
  const names = new Set(props.components.map((item) => item.name));
  const nextProductLists: Record<number, GoodsItem[]> = {};
  await Promise.all([
    ...props.components.map(async (block, index) => {
      if (block.name !== "goodList") return;
      try {
        nextProductLists[index] = await loadProducts(block);
      } catch {
        nextProductLists[index] = [];
      }
    }),
    names.has("articleList")
      ? (async () => {
        const block = props.components.find((item) => item.name === "articleList");
        const category = Math.max(0, Number(asDiyRecord(block?.selectConfig)?.activeValue) || 0);
        const limit = boundedLimit(block ? diyNumber(block, "numConfig", 6) : 6, 6, 20);
        articles.value = await apiArticleList(category, { page: 1, limit }).catch(() => []);
      })()
      : Promise.resolve(),
    names.has("ranking")
      ? apiDiyProductRank(3).then((value) => { ranks.value = value; }).catch(() => undefined)
      : Promise.resolve(),
    names.has("newVip")
      ? apiDiyNewcomerList(1, 10).then((value) => { newcomer.value = value; }).catch(() => undefined)
      : Promise.resolve(),
    names.has("signIn")
      ? apiDiySign().then((value) => { sign.value = value; }).catch(() => undefined)
      : Promise.resolve(),
    names.has("userInfor")
      ? apiDiyUserInfo().then((value) => { userInfo.value = Array.isArray(value) ? null : value; }).catch(() => undefined)
      : Promise.resolve(),
    names.has("community")
      ? apiDiyVideoList(1, 10).then((value) => { videos.value = value; }).catch(() => undefined)
      : Promise.resolve(),
  ]);
  if (generation === hydration) productLists.value = nextProductLists;
}

const hasRanks = computed(() => ranks.value.sales.length + ranks.value.star.length + ranks.value.collect.length > 0);
const rankGroups = computed(() => [
  { key: "sales", label: "热销榜", items: ranks.value.sales },
  { key: "star", label: "好评榜", items: ranks.value.star },
  { key: "collect", label: "收藏榜", items: ranks.value.collect },
]);
const newcomerPoints = computed(() => Number(newcomer.value.newcomer_integral) || 0);
const hasNewcomer = computed(() => (
  newcomerPoints.value > 0
  || newcomer.value.newcomer_products.length > 0
  || newcomer.value.newcomer_coupon.length > 0
));

watch(() => props.components, () => { void hydrate(); }, { immediate: true });
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
.diy-product-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18rpx; }
.diy-product-card { min-width: 0; overflow: hidden; border: 1rpx solid #eee; border-radius: 14rpx; }
.diy-product-image { width: 100%; height: 280rpx; background: #f5f5f5; }
.diy-product-name { display: -webkit-box; height: 72rpx; margin: 14rpx 14rpx 4rpx; overflow: hidden; font-size: 25rpx; line-height: 36rpx; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.diy-price-row { display: flex; align-items: center; justify-content: space-between; padding: 8rpx 14rpx 16rpx; }
.diy-price { color: #e93323; font-size: 27rpx; font-weight: 600; }
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
.diy-rank-number { position: absolute; z-index: 1; top: 8rpx; left: 8rpx; width: 40rpx; height: 40rpx; border-radius: 50%; color: #fff; background: #e93323; font-size: 22rpx; line-height: 40rpx; text-align: center; }
.diy-newcomer { background: linear-gradient(135deg, #fff7f1, #fff); }
.diy-newcomer-points, .diy-newcomer-coupon { display: block; margin-bottom: 18rpx; color: #e05b2a; font-size: 25rpx; }
.diy-sign { display: flex; flex-direction: column; gap: 18rpx; }
.diy-sign-days { display: flex; gap: 8rpx; }
.diy-sign-day { flex: 1; padding: 10rpx 0; border-radius: 10rpx; color: #888; background: #f5f5f5; font-size: 18rpx; text-align: center; }
.diy-sign-day.signed { color: #fff; background: #ef8a65; }
.diy-sign-day.today { box-shadow: inset 0 0 0 2rpx #e93323; }
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
