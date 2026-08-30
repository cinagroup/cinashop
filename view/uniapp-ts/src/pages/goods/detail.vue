<template>
  <view class="goods-detail">
    <view v-if="detail">
      <!-- 轮播图 -->
      <swiper class="swiper" indicator-dots autoplay circular>
        <swiper-item v-for="(img, i) in detail.slider_image" :key="i">
          <image class="swiper-img" :src="img" mode="aspectFill" />
        </swiper-item>
      </swiper>

      <!-- 价格区 -->
      <view class="price-section">
        <view class="price-row">
          <text class="price">¥{{ selectedSku?.price || detail.price }}</text>
          <text v-if="detail.ot_price" class="ot-price">¥{{ detail.ot_price }}</text>
          <text v-if="detail.is_vip" class="vip-tag">SVIP ¥{{ detail.vip_price }}</text>
        </view>
        <view class="meta-row">
          <text>已售 {{ detail.fsales }}</text>
          <text>库存 {{ selectedSku?.stock ?? detail.stock }}</text>
        </view>
      </view>

      <!-- 商品信息 -->
      <view class="info-section">
        <view class="goods-name">{{ detail.store_name }}</view>
        <view class="goods-subtitle">{{ detail.store_info }}</view>
        <!-- 规格入口 -->
        <view class="spec-entry" @tap="openSku('cart')">
          <text class="spec-label">已选</text>
          <text class="spec-value">{{ selectedSku?.suk || "请选择规格" }}</text>
          <text class="spec-arrow">›</text>
        </view>
      </view>

      <view v-if="discountPackages.length" class="package-section">
        <view class="package-heading">搭配购</view>
        <view
          v-for="item in discountPackages"
          :key="item.id"
          class="package-card"
          @tap="openPackage(item)"
        >
          <view>
            <view class="package-name">{{ item.title }}</view>
            <view class="package-meta">{{ item.type === 0 ? "固定套餐" : "任选套餐" }} · {{ item.products.length }}件可选</view>
          </view>
          <view class="package-price">¥{{ item.min_price }} 起 ›</view>
        </view>
      </view>

      <!-- 商品评价 -->
      <view class="reply-section">
        <view class="reply-head">
          <text class="reply-title">商品评价</text>
          <text class="reply-count" v-if="replyStats.total > 0">
            ({{ replyStats.total }}) · {{ replyStats.avgScore }}分 · 好评率{{ replyStats.goodRate }}%
          </text>
          <text class="reply-more" v-if="replyStats.total > 0" @tap="goAllComments">全部 ›</text>
        </view>
        <view v-if="replies.length" class="reply-list">
          <view v-for="r in replies" :key="r.id" class="reply-item" @tap="goCommentDetail(r.id)">
            <view class="reply-user">
              <text class="reply-avatar">{{ (r.nickname || "用")[0] }}</text>
              <text class="reply-name">{{ r.nickname || "用户" }}</text>
              <text class="reply-stars">{{ starText(r.product_score) }}</text>
            </view>
            <view class="reply-comment">{{ r.comment }}</view>
            <view v-if="r.pics.length" class="reply-pics">
              <image
                v-for="(p, i) in r.pics"
                :key="i"
                class="reply-pic"
                :src="p"
                mode="aspectFill"
              />
            </view>
            <view class="reply-meta">
              <text class="reply-sku">{{ r.sku || "默认规格" }}</text>
              <text class="reply-time">{{ r.add_time }}</text>
            </view>
          </view>
        </view>
        <view v-else class="reply-empty">暂无评价, 快来抢沙发</view>
      </view>

      <!-- 底部操作栏 -->
      <view class="action-bar">
        <view class="action-btn" @tap="goCart">
          <text class="action-icon">🛒</text>
          <text class="action-text">购物车</text>
        </view>
        <view class="add-btn" @tap="openSku('cart')">加入购物车</view>
        <view class="buy-btn" @tap="openSku('buy')">立即购买</view>
      </view>

      <!-- SKU 规格弹窗 -->
      <view v-if="skuVisible" class="mask" @tap="skuVisible = false">
        <view class="sheet" @tap.stop>
          <view class="sku-head">
            <image
              class="sku-img"
              :src="detail.image || placeholder"
              mode="aspectFill"
            />
            <view class="sku-info">
              <text class="sku-price">¥{{ selectedSku?.price || detail.price }}</text>
              <text class="sku-stock" v-if="selectedSku">库存 {{ selectedSku.stock }}</text>
              <text class="sku-name">{{ selectedSku?.suk || "请选择规格" }}</text>
            </view>
          </view>

          <view class="sku-options" v-if="skuList.length">
            <view class="sku-opt-title">规格</view>
            <view class="sku-opt-grid">
              <view
                v-for="sku in skuList"
                :key="sku.unique"
                class="sku-opt"
                :class="{ active: selectedSku?.unique === sku.unique, disabled: sku.stock <= 0 }"
                @tap="pickSku(sku)"
              >
                {{ sku.suk }}
              </view>
            </view>
          </view>

          <view class="sku-num-row">
            <text>购买数量</text>
            <view class="num-ctrl">
              <view class="num-btn" @tap="num > 1 && num--">−</view>
              <text class="num-val">{{ num }}</text>
              <view class="num-btn" @tap="num < maxNum && num++">＋</view>
            </view>
          </view>

          <view class="sheet-btn" @tap="confirmSku">
            {{ skuMode === "buy" ? "立即购买" : "加入购物车" }}
          </view>
        </view>
      </view>

      <view v-if="packageVisible" class="mask" @tap="packageVisible = false">
        <view class="sheet package-sheet" @tap.stop>
          <view class="package-sheet-title">{{ selectedPackage?.title }}</view>
          <scroll-view scroll-y class="package-scroll">
            <view
              v-for="entry in selectedPackage?.products || []"
              :key="entry.id"
              class="package-product"
            >
              <view class="package-select" @tap="togglePackageProduct(entry)">
                <text :class="{ active: packageChoices[entry.id]?.selected }">
                  {{ packageChoices[entry.id]?.selected ? "✓" : "○" }}
                </text>
                <text>{{ isRequiredPackageEntry(entry) ? "必选" : "可选" }}</text>
              </view>
              <image class="package-image" :src="entry.image || placeholder" mode="aspectFill" />
              <view class="package-product-info">
                <view class="package-product-name">{{ entry.title }}</view>
                <view class="package-skus">
                  <view
                    v-for="sku in entry.productValue.filter((item) => item.stock > 0)"
                    :key="sku.unique"
                    class="package-sku"
                    :class="{ active: packageChoices[entry.id]?.unique === sku.unique }"
                    @tap="pickPackageSku(entry.id, sku.unique)"
                  >
                    {{ sku.suk }} ¥{{ sku.price }}
                  </view>
                </view>
              </view>
            </view>
          </scroll-view>
          <view class="package-total">
            <text>已选 {{ selectedPackageCount }} 件</text>
            <text>套餐价 ¥{{ selectedPackageTotal }}</text>
          </view>
          <view class="sheet-btn" :class="{ disabled: packageBuying }" @tap="buyPackage">
            {{ packageBuying ? "处理中..." : "立即结算套餐" }}
          </view>
        </view>
      </view>
    </view>
    <view v-else class="empty">商品不存在或已下架</view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { onLoad } from "@dcloudio/uni-app";
import { apiGoodsDetail } from "@/api/product";
import {
  apiCartAdd,
  apiDiscountCartAdd,
  apiDiscountPackages,
} from "@/api/order";
import { apiReplyConfig, apiReplyList } from "@/api/reply";
import type { ProductReviewListItem } from "@/api/reply";
import { useAuthStore } from "@/stores/auth";
import type { GoodsDetail } from "@/types/product";
import type { DiscountPackage, DiscountPackageProduct } from "@/types/order";

interface SkuItem {
  id: number;
  unique: string;
  suk: string;
  price: string;
  ot_price: string;
  stock: number;
  sales: number;
}

const detail = ref<GoodsDetail | null>(null);
const authStore = useAuthStore();
const replies = ref<ProductReviewListItem[]>([]);
const replyStats = ref({ total: 0, avgScore: "0.0", goodRate: 100 });
const discountPackages = ref<DiscountPackage[]>([]);
const selectedPackage = ref<DiscountPackage | null>(null);
const packageVisible = ref(false);
const packageBuying = ref(false);
const packageChoices = ref<Record<number, { selected: boolean; unique: string }>>({});
const selectedPackageCount = computed(() =>
  Object.values(packageChoices.value).filter((choice) => choice.selected).length,
);
const selectedPackageTotal = computed(() => {
  if (!selectedPackage.value) return "0.00";
  const cents = selectedPackage.value.products.reduce((sum, entry) => {
    const choice = packageChoices.value[entry.id];
    if (!choice?.selected) return sum;
    const price = entry.productValue.find((sku) => sku.unique === choice.unique)?.price ?? "0";
    return sum + Math.round(Number(price) * 100);
  }, 0);
  return (cents / 100).toFixed(2);
});
const placeholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%23eee' width='100%25' height='100%25'/%3E%3C/svg%3E";

// ─── SKU 弹窗状态 ───
const skuVisible = ref(false);
const skuMode = ref<"cart" | "buy">("cart");
const skuList = ref<SkuItem[]>([]);
const selectedSku = ref<SkuItem | null>(null);
const num = ref(1);
const maxNum = computed(() => selectedSku.value?.stock ?? 99);

function openSku(mode: "cart" | "buy") {
  if (!authStore.isLoggedIn) return uni.navigateTo({ url: "/pages/auth/login" });
  skuMode.value = mode;
  num.value = 1;
  skuVisible.value = true;
}

function pickSku(sku: SkuItem) {
  if (sku.stock <= 0) return;
  selectedSku.value = sku;
}

async function confirmSku() {
  if (!detail.value) return;
  if (!selectedSku.value) return uni.showToast({ title: "请选择规格", icon: "none" });
  const sku = selectedSku.value;
  if (sku.stock < num.value) return uni.showToast({ title: "库存不足", icon: "none" });

  try {
    const cart = await apiCartAdd({
      productId: detail.value.id,
      unique: sku.unique,
      cartNum: num.value,
    });
    skuVisible.value = false;
    if (skuMode.value === "buy") {
      // 立即购买 → 确认订单页 (buy 模式, 仅结算当前加购的商品)
      uni.navigateTo({
        url: `/pages/order/confirm?mode=buy&cartId=${cart.id}&from=sku`,
      });
    } else {
      uni.showToast({ title: "已加入购物车", icon: "success" });
    }
  } catch (e) {
    uni.showToast({ title: e instanceof Error ? e.message : "操作失败", icon: "none" });
  }
}

function isRequiredPackageEntry(entry: DiscountPackageProduct): boolean {
  return selectedPackage.value?.type === 0 || entry.type === 1;
}

function openPackage(item: DiscountPackage) {
  if (!authStore.isLoggedIn) return uni.navigateTo({ url: "/pages/auth/login" });
  selectedPackage.value = item;
  packageChoices.value = Object.fromEntries(item.products.map((entry) => [
    entry.id,
    {
      selected: item.type === 0 || entry.type === 1,
      unique: entry.productValue.find((sku) => sku.stock > 0)?.unique ?? "",
    },
  ]));
  packageVisible.value = true;
}

function togglePackageProduct(entry: DiscountPackageProduct) {
  if (isRequiredPackageEntry(entry)) return;
  const choice = packageChoices.value[entry.id];
  if (choice) choice.selected = !choice.selected;
}

function pickPackageSku(entryId: number, unique: string) {
  const choice = packageChoices.value[entryId];
  if (choice) choice.unique = unique;
}

async function buyPackage() {
  const item = selectedPackage.value;
  if (!item || packageBuying.value) return;
  const selected = item.products.filter((entry) => packageChoices.value[entry.id]?.selected);
  if (selected.length < 2) return uni.showToast({ title: "套餐至少选择两件商品", icon: "none" });
  if (selected.some((entry) => !packageChoices.value[entry.id]?.unique)) {
    return uni.showToast({ title: "请选择全部已选商品的规格", icon: "none" });
  }
  packageBuying.value = true;
  try {
    const result = await apiDiscountCartAdd({
      discountId: item.id,
      discountInfos: selected.map((entry) => ({
        id: entry.id,
        product_id: entry.product_id,
        unique: packageChoices.value[entry.id].unique,
      })),
    });
    packageVisible.value = false;
    uni.navigateTo({
      url: `/pages/order/confirm?mode=buy&cartIds=${result.cartIds.join(",")}&type=5`,
    });
  } catch (error) {
    uni.showToast({ title: error instanceof Error ? error.message : "套餐加入结算失败", icon: "none" });
  } finally {
    packageBuying.value = false;
  }
}

function starText(score: number): string {
  const n = Math.min(5, Math.max(1, Number(score) || 5));
  return "★".repeat(n);
}

async function loadReplies(productId: number) {
  try {
    replyStats.value = await apiReplyConfig(productId);
  } catch {
    // 静默
  }
  try {
    replies.value = await apiReplyList(productId);
  } catch {
    replies.value = [];
  }
}

function goCart() {
  uni.switchTab({ url: "/pages/cart/index" });
}

function goAllComments() {
  if (!detail.value) return;
  uni.navigateTo({ url: `/pages/goods/commentList?productId=${detail.value.id}` });
}

function goCommentDetail(id: number) {
  uni.navigateTo({ url: `/pages/goods/commentDetail?id=${id}` });
}

onLoad(async (options) => {
  const id = Number(options?.id);
  if (!id) return;
  try {
    const [goods, packages] = await Promise.all([
      apiGoodsDetail(id),
      apiDiscountPackages(id).catch(() => []),
    ]);
    detail.value = goods;
    discountPackages.value = packages;
    loadReplies(id);
    // 初始化 SKU 列表: 优先 attr_value, 兜底单规格
    const attrValue = (detail.value as any).attr_value as SkuItem[] | undefined;
    if (attrValue?.length) {
      skuList.value = attrValue;
      const first = attrValue.find((s) => s.stock > 0) ?? attrValue[0];
      if (first) selectedSku.value = first;
    } else {
      skuList.value = [
        {
          id: 0,
          unique: `sku${String(id).padStart(5, "0")}`,
          suk: "默认",
          price: String((detail.value as any).price ?? 0),
          ot_price: String((detail.value as any).ot_price ?? 0),
          stock: Number((detail.value as any).stock ?? 0),
          sales: 0,
        },
      ];
      selectedSku.value = skuList.value[0];
    }
  } catch (e) {
    console.error("商品详情加载失败", e);
  }
});
</script>

<style scoped>
.goods-detail {
  padding-bottom: 140rpx;
}

.swiper {
  height: 750rpx;
}

.swiper-img {
  width: 100%;
  height: 100%;
}

.price-section {
  background: #fff;
  padding: 24rpx;
}

.price-row {
  display: flex;
  align-items: baseline;
  gap: 16rpx;
}

.price {
  color: #e93323;
  font-size: 44rpx;
  font-weight: 700;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 26rpx;
}

.vip-tag {
  background: linear-gradient(90deg, #d4a94e, #f5d97a);
  color: #fff;
  border-radius: 6rpx;
  padding: 4rpx 12rpx;
  font-size: 22rpx;
}

.meta-row {
  display: flex;
  gap: 40rpx;
  color: #999;
  font-size: 24rpx;
  margin-top: 12rpx;
}

.info-section {
  background: #fff;
  padding: 24rpx;
  margin-top: 20rpx;
}

.package-section {
  background: #fff;
  padding: 24rpx;
  margin-top: 20rpx;
}

.package-heading,
.package-sheet-title {
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 16rpx;
}

.package-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 2rpx solid #ffd8d5;
  background: #fff8f7;
  border-radius: 12rpx;
  padding: 18rpx;
  margin-top: 12rpx;
}

.package-name {
  font-size: 27rpx;
  font-weight: 600;
}

.package-meta {
  color: #999;
  font-size: 22rpx;
  margin-top: 6rpx;
}

.package-price {
  color: #e93323;
  font-size: 25rpx;
}

.package-sheet {
  max-height: 78vh;
}

.package-scroll {
  max-height: 760rpx;
}

.package-product {
  display: flex;
  gap: 16rpx;
  padding: 18rpx 0;
  border-bottom: 1rpx solid #f2f2f2;
}

.package-select {
  width: 76rpx;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #999;
  font-size: 22rpx;
}

.package-select .active {
  color: #e93323;
  font-size: 30rpx;
}

.package-image {
  width: 100rpx;
  height: 100rpx;
  border-radius: 10rpx;
  flex-shrink: 0;
}

.package-product-info {
  flex: 1;
  min-width: 0;
}

.package-product-name {
  font-size: 26rpx;
  margin-bottom: 12rpx;
}

.package-skus {
  display: flex;
  flex-wrap: wrap;
  gap: 10rpx;
}

.package-sku {
  border: 2rpx solid #eee;
  border-radius: 8rpx;
  padding: 8rpx 12rpx;
  color: #666;
  font-size: 22rpx;
}

.package-sku.active {
  border-color: #e93323;
  color: #e93323;
  background: #fff5f4;
}

.package-total {
  display: flex;
  justify-content: space-between;
  color: #e93323;
  font-size: 28rpx;
  padding-top: 20rpx;
}

.sheet-btn.disabled {
  opacity: 0.6;
}

.spec-entry {
  display: flex;
  align-items: center;
  margin-top: 16rpx;
  padding-top: 16rpx;
  border-top: 1rpx solid #f5f5f5;
}

.spec-label {
  font-size: 26rpx;
  color: #999;
  margin-right: 16rpx;
}

.spec-value {
  flex: 1;
  font-size: 26rpx;
  color: #333;
}

.spec-arrow {
  color: #bbb;
  font-size: 32rpx;
}

.reply-section {
  background: #fff;
  padding: 24rpx;
  margin-top: 20rpx;
}

.reply-head {
  display: flex;
  align-items: baseline;
  margin-bottom: 16rpx;
}

.reply-title {
  font-size: 30rpx;
  font-weight: 600;
}

.reply-count {
  font-size: 22rpx;
  color: #999;
  margin-left: 12rpx;
}

.reply-more {
  font-size: 22rpx;
  color: #e93323;
  margin-left: auto;
}

.reply-item {
  border-top: 1rpx solid #f7f7f7;
  padding: 20rpx 0;
}

.reply-user {
  display: flex;
  align-items: center;
  margin-bottom: 10rpx;
}

.reply-avatar {
  width: 44rpx;
  height: 44rpx;
  background: #e93323;
  color: #fff;
  border-radius: 50%;
  font-size: 24rpx;
  text-align: center;
  line-height: 44rpx;
  margin-right: 12rpx;
}

.reply-name {
  font-size: 24rpx;
  color: #333;
  flex: 1;
}

.reply-stars {
  font-size: 20rpx;
  color: #ff9900;
}

.reply-comment {
  font-size: 26rpx;
  color: #444;
  line-height: 1.6;
}

.reply-pics {
  display: flex;
  gap: 12rpx;
  margin-top: 12rpx;
}

.reply-pic {
  width: 140rpx;
  height: 140rpx;
  border-radius: 8rpx;
}

.reply-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 12rpx;
}

.reply-sku,
.reply-time {
  font-size: 22rpx;
  color: #bbb;
}

.reply-empty {
  text-align: center;
  color: #999;
  font-size: 24rpx;
  padding: 40rpx 0;
}

.goods-name {
  font-size: 32rpx;
  font-weight: 600;
}

.goods-subtitle {
  font-size: 26rpx;
  color: #999;
  margin-top: 8rpx;
}

.action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: #fff;
  display: flex;
  align-items: center;
  padding: 16rpx 20rpx;
  padding-bottom: calc(16rpx + env(safe-area-inset-bottom));
  box-shadow: 0 -2rpx 10rpx rgba(0, 0, 0, 0.05);
}

.action-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-right: 20rpx;
}

.action-icon {
  font-size: 40rpx;
}

.action-text {
  font-size: 20rpx;
  color: #555;
}

.add-btn {
  flex: 1;
  background: #ff9a45;
  color: #fff;
  text-align: center;
  padding: 20rpx;
  border-radius: 40rpx 0 0 40rpx;
  font-size: 28rpx;
}

.buy-btn {
  flex: 1;
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 20rpx;
  border-radius: 0 40rpx 40rpx 0;
  font-size: 28rpx;
}

/* ─── SKU 弹窗 ─── */
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
  display: flex;
  align-items: flex-end;
}

.sheet {
  background: #fff;
  width: 100%;
  border-radius: 24rpx 24rpx 0 0;
  padding: 30rpx;
}

.sku-head {
  display: flex;
  gap: 20rpx;
  margin-bottom: 24rpx;
}

.sku-img {
  width: 140rpx;
  height: 140rpx;
  border-radius: 12rpx;
  flex-shrink: 0;
}

.sku-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.sku-price {
  color: #e93323;
  font-size: 36rpx;
  font-weight: 700;
}

.sku-stock {
  color: #999;
  font-size: 24rpx;
  margin-top: 6rpx;
}

.sku-name {
  color: #333;
  font-size: 26rpx;
  margin-top: 6rpx;
}

.sku-opt-title {
  font-size: 26rpx;
  color: #999;
  margin-bottom: 16rpx;
}

.sku-opt-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16rpx;
  margin-bottom: 24rpx;
}

.sku-opt {
  border: 2rpx solid #e5e5e5;
  border-radius: 10rpx;
  padding: 12rpx 30rpx;
  font-size: 26rpx;
  color: #333;
  background: #fff;
}

.sku-opt.active {
  border-color: #e93323;
  color: #e93323;
  background: #fff5f4;
}

.sku-opt.disabled {
  color: #ccc;
  border-color: #eee;
  background: #fafafa;
}

.sku-num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24rpx;
  font-size: 26rpx;
  color: #333;
}

.num-ctrl {
  display: flex;
  align-items: center;
  gap: 24rpx;
}

.num-btn {
  width: 52rpx;
  height: 52rpx;
  border: 2rpx solid #ddd;
  border-radius: 8rpx;
  text-align: center;
  line-height: 48rpx;
  font-size: 30rpx;
  color: #555;
}

.num-val {
  font-size: 30rpx;
  min-width: 40rpx;
  text-align: center;
}

.sheet-btn {
  background: #e93323;
  color: #fff;
  text-align: center;
  padding: 22rpx;
  border-radius: 44rpx;
  font-size: 30rpx;
}
</style>
