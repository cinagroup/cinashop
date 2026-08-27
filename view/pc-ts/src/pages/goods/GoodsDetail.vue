<template>
  <div class="goods-detail container">
    <el-skeleton v-if="loading" :rows="8" animated />
    <template v-else-if="detail">
      <div class="detail-main">
        <!-- 图片 -->
        <div class="gallery">
          <el-carousel height="400px">
            <el-carousel-item v-for="(img, i) in detail.slider_image" :key="i">
              <img :src="img" class="gallery-img" :alt="detail.store_name" />
            </el-carousel-item>
          </el-carousel>
        </div>

        <!-- 信息 -->
        <div class="info">
          <h1 class="name">{{ detail.store_name }}</h1>
          <p class="subtitle">{{ detail.store_info }}</p>

          <div class="price-box">
            <span class="price-label">价格</span>
            <span class="price">¥{{ detail.price }}</span>
            <span v-if="detail.ot_price && Number(detail.ot_price) > Number(detail.price)" class="ot-price">
              ¥{{ detail.ot_price }}
            </span>
            <span v-if="detail.is_vip" class="vip-tag">SVIP ¥{{ detail.vip_price }}</span>
          </div>

          <div class="meta">
            <span>已售 {{ detail.fsales }}</span>
            <span>库存 {{ detail.stock }}</span>
            <span>评分 {{ detail.star }}</span>
          </div>

          <div v-if="discountPackages.length" class="package-list">
            <div class="package-title">搭配购</div>
            <button
              v-for="item in discountPackages"
              :key="item.id"
              type="button"
              class="package-card"
              @click="openPackage(item)"
            >
              <span>
                <strong>{{ item.title }}</strong>
                <small>{{ item.type === 0 ? "固定套餐" : "任选套餐" }} · {{ item.products.length }}件可选</small>
              </span>
              <span class="package-price">¥{{ item.min_price }} 起，立省 ¥{{ item.max_discounts_price }} ›</span>
            </button>
          </div>

          <div class="qty-row">
            <span class="qty-label">数量</span>
            <el-input-number v-model="qty" :min="1" :max="Math.max(detail.stock, 1)" />
          </div>

          <div class="actions">
            <el-button
              type="danger"
              size="large"
              :disabled="detail.cart_button === 0"
              @click="addToCart"
            >
              加入购物车
            </el-button>
            <el-button
              type="primary"
              size="large"
              :disabled="detail.cart_button === 0"
              @click="buyNow"
            >
              立即购买
            </el-button>
            <el-button size="large" :type="collected ? 'warning' : 'default'" @click="toggleCollect">
              {{ collected ? "已收藏" : "收藏" }}
            </el-button>
          </div>
        </div>
      </div>

      <el-dialog v-model="packageVisible" :title="selectedPackage?.title || '搭配购'" width="680px">
        <div v-if="selectedPackage" class="package-picker">
          <div
            v-for="entry in selectedPackage.products"
            :key="entry.id"
            class="package-product"
          >
            <el-checkbox
              :model-value="packageChoices[entry.id]?.selected"
              :disabled="isRequiredPackageEntry(entry)"
              @change="togglePackageProduct(entry.id, Boolean($event))"
            >
              {{ isRequiredPackageEntry(entry) ? "必选" : "可选" }}
            </el-checkbox>
            <img :src="entry.image" class="package-product-image" />
            <div class="package-product-info">
              <strong>{{ entry.title }}</strong>
              <el-select
                v-model="packageChoices[entry.id].unique"
                placeholder="选择规格"
                style="width: 100%"
              >
                <el-option
                  v-for="sku in entry.productValue.filter((item) => item.stock > 0)"
                  :key="sku.unique"
                  :label="`${sku.suk} · ¥${sku.price}`"
                  :value="sku.unique"
                />
              </el-select>
            </div>
          </div>
          <div class="package-summary">
            <span>已选 {{ selectedPackageCount }} 件</span>
            <strong>套餐价 ¥{{ selectedPackageTotal }}</strong>
          </div>
        </div>
        <template #footer>
          <el-button @click="packageVisible = false">取消</el-button>
          <el-button type="danger" :loading="packageBuying" @click="buyPackage">立即结算套餐</el-button>
        </template>
      </el-dialog>

      <!-- 商品评价 -->
      <div class="reply-section">
        <div class="reply-head">
          <h3 class="reply-title">商品评价</h3>
          <span v-if="replyStats.total > 0" class="reply-count">
            ({{ replyStats.total }}) · {{ replyStats.avgScore }}分 · 好评率{{ replyStats.goodRate }}%
          </span>
        </div>
        <div v-if="replies.length" class="reply-list">
          <div v-for="r in replies" :key="(r as any).id" class="reply-item">
            <div class="reply-user">
              <span class="reply-avatar">{{ ((r as any).nickname || "用")[0] }}</span>
              <span class="reply-name">{{ (r as any).nickname || "用户" }}</span>
              <span class="reply-stars">{{ starText((r as any).productScore) }}</span>
            </div>
            <div class="reply-comment">{{ (r as any).comment }}</div>
            <div v-if="(r as any).pics && (r as any).pics.length" class="reply-pics">
              <el-image
                v-for="(p, i) in (r as any).pics"
                :key="i"
                :src="p"
                class="reply-pic"
                fit="cover"
                :preview-src-list="(r as any).pics"
              />
            </div>
            <div class="reply-meta">
              <span>{{ (r as any).sku || "默认规格" }}</span>
              <span>{{ formatTime((r as any).addTime) }}</span>
            </div>
          </div>
        </div>
        <el-empty v-else :image-size="60" description="暂无评价, 快来抢沙发" />
      </div>
    </template>
    <el-empty v-else description="商品不存在或已下架" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiGoodsDetail, apiReplyConfig, apiReplyList } from "@/api/product";
import { apiCartAdd, apiDiscountCartAdd } from "@/api/cart";
import {
  apiDiscountPackages,
  type DiscountPackage,
  type DiscountPackageProduct,
} from "@/api/activity";
import type { GoodsDetail } from "@/types/product";
import { isLoggedIn } from "@/utils/auth";

const route = useRoute();
const router = useRouter();
const detail = ref<GoodsDetail | null>(null);
const loading = ref(true);
const qty = ref(1);
const collected = ref(false);
const replies = ref<unknown[]>([]);
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

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

async function load() {
  loading.value = true;
  try {
    const id = Number(route.params.id);
    const [goods, packages] = await Promise.all([
      apiGoodsDetail(id),
      apiDiscountPackages(id).catch(() => []),
    ]);
    detail.value = goods;
    discountPackages.value = packages;
    collected.value = detail.value.userCollect;
    loadReplies(id);
  } catch (e) {
    console.error("商品详情加载失败", e);
  } finally {
    loading.value = false;
  }
}

function isRequiredPackageEntry(entry: DiscountPackageProduct): boolean {
  return selectedPackage.value?.type === 0 || entry.type === 1;
}

function openPackage(item: DiscountPackage) {
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
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

function togglePackageProduct(entryId: number, selected: boolean) {
  const choice = packageChoices.value[entryId];
  if (choice) choice.selected = selected;
}

async function buyPackage() {
  const item = selectedPackage.value;
  if (!item || packageBuying.value) return;
  const selected = item.products.filter((entry) => packageChoices.value[entry.id]?.selected);
  if (selected.length < 2) return ElMessage.error("套餐至少选择两件商品");
  if (selected.some((entry) => !packageChoices.value[entry.id]?.unique)) {
    return ElMessage.error("请选择全部已选商品的规格");
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
    await router.push({
      path: "/checkout",
      query: { mode: "buy", cartIds: result.cartIds.join(","), type: "5" },
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "套餐加入结算失败");
  } finally {
    packageBuying.value = false;
  }
}

async function addToCart() {
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
  if (!detail.value) return;
  try {
    await apiCartAdd({
      productId: detail.value.id,
      unique: `sku${String(detail.value.id).padStart(5, "0")}`,
      cartNum: qty.value,
    });
    ElMessage.success("已加入购物车");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : "加入失败");
  }
}

function buyNow() {
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
  ElMessage.info("立即购买接入中, 请先在购物车结算");
  addToCart();
}

function toggleCollect() {
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
  collected.value = !collected.value;
  ElMessage.success(collected.value ? "收藏成功" : "已取消收藏");
}

onMounted(load);
</script>

<style scoped>
.goods-detail {
  padding-top: 20px;
}

.detail-main {
  display: flex;
  gap: 32px;
  background: #fff;
  border-radius: 8px;
  padding: 24px;
}

.gallery {
  flex: 0 0 400px;
  border-radius: 8px;
  overflow: hidden;
}

.gallery-img {
  width: 100%;
  height: 400px;
  object-fit: cover;
}

.info {
  flex: 1;
}

.name {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 8px;
}

.subtitle {
  color: #999;
  font-size: 14px;
  margin-bottom: 16px;
}

.price-box {
  background: #f8f8f8;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.price-label {
  color: #999;
  font-size: 13px;
}

.price {
  color: #e64340;
  font-size: 28px;
  font-weight: 700;
}

.ot-price {
  color: #999;
  text-decoration: line-through;
  font-size: 14px;
}

.vip-tag {
  background: linear-gradient(90deg, #d4a94e, #f5d97a);
  color: #fff;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
}

.meta {
  display: flex;
  gap: 24px;
  color: #666;
  font-size: 13px;
  margin-bottom: 16px;
}

.package-list {
  margin-bottom: 18px;
}

.package-title {
  color: #666;
  margin-bottom: 8px;
}

.package-card {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 1px solid #ffd8d5;
  border-radius: 8px;
  background: #fff8f7;
  padding: 12px;
  margin-bottom: 8px;
  text-align: left;
  cursor: pointer;
}

.package-card span:first-child {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.package-card small {
  color: #999;
}

.package-price {
  color: #e64340;
}

.package-product {
  display: grid;
  grid-template-columns: 70px 64px 1fr;
  gap: 12px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #f2f2f2;
}

.package-product-image {
  width: 64px;
  height: 64px;
  border-radius: 6px;
  object-fit: cover;
}

.package-product-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.package-summary {
  display: flex;
  justify-content: space-between;
  margin-top: 16px;
}

.package-summary strong {
  color: #e64340;
}

.qty-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.qty-label {
  color: #666;
}

.actions {
  display: flex;
  gap: 12px;
}

.reply-section {
  background: #fff;
  border-radius: 8px;
  padding: 24px;
  margin-top: 20px;
}

.reply-head {
  display: flex;
  align-items: baseline;
  margin-bottom: 16px;
}

.reply-title {
  font-size: 16px;
  margin: 0;
}

.reply-count {
  font-size: 13px;
  color: #999;
  margin-left: 12px;
}

.reply-item {
  border-top: 1px solid #f5f5f5;
  padding: 16px 0;
}

.reply-user {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.reply-avatar {
  width: 32px;
  height: 32px;
  background: #e64340;
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.reply-name {
  font-size: 14px;
  color: #333;
}

.reply-stars {
  color: #ff9900;
  font-size: 13px;
}

.reply-comment {
  font-size: 14px;
  color: #444;
  line-height: 1.6;
}

.reply-pics {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.reply-pic {
  width: 80px;
  height: 80px;
  border-radius: 6px;
}

.reply-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 12px;
  color: #bbb;
}
</style>
