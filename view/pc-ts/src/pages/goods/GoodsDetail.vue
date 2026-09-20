<template>
  <div class="goods-detail container">
    <el-skeleton v-if="loading" :rows="8" animated />
    <div v-else-if="loadError" role="alert">
      <p>{{ loadError }}</p>
      <el-button @click="load">重新加载商品</el-button>
    </div>
    <template v-else-if="detail">
      <div v-if="preparedCart || purchaseNeedsRefresh" class="purchase-recovery" role="status">
        <p>{{ preparedCart ? '购买记录已创建，继续结算不会重复加购。' : '本次操作结果未确认，请重新加载商品后再选择。' }}</p>
        <p v-if="checkoutError" role="alert">{{ checkoutError }}</p>
        <el-button v-if="preparedCart" type="primary" :loading="checkoutNavigating" :disabled="checkoutNavigating" @click="resumeCheckout">继续结算</el-button>
        <el-button :disabled="checkoutNavigating || purchaseSubmitting || packageBuying" @click="restartPurchase">{{ preparedCart ? '重新选择商品' : '重新加载商品' }}</el-button>
      </div>
      <div class="detail-main">
        <!-- 图片 -->
        <div class="gallery">
          <template v-if="detail.slider_image.length">
            <el-carousel height="100%" class="product-carousel">
              <el-carousel-item v-for="(img, i) in detail.slider_image" :key="i">
                <ProductImage :src="img" class="gallery-img" :alt="detail.store_name" />
              </el-carousel-item>
            </el-carousel>
          </template>
          <ProductImage v-else :src="detail.image" class="gallery-img" :alt="detail.store_name" />
        </div>

        <!-- 信息 -->
        <div class="info">
          <h1 class="name">{{ detail.store_name }}</h1>
          <p class="subtitle">{{ detail.store_info }}</p>

          <div class="price-box">
            <span class="price-label">{{ displayPriceLabel || '价格' }}</span>
            <span class="price">¥{{ displayPrice }}</span>
            <span v-if="displayOriginalPrice && Number(displayOriginalPrice) > Number(displayPrice)" class="ot-price">
              ¥{{ displayOriginalPrice }}
            </span>
            <span v-if="displayVipPrice" class="vip-tag">SVIP专享 ¥{{ displayVipPrice }}</span>
          </div>

          <div class="meta">
            <span>已售 {{ detail.fsales }}</span>
            <span>库存 {{ selectedStock }}</span>
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

          <fieldset class="sku-picker" :disabled="purchaseLocked">
            <legend>选择规格</legend>
            <label v-for="sku in detail.skus" :key="sku.unique" class="sku-choice">
              <input v-model="selectedUnique" type="radio" name="product-sku" :value="sku.unique" :disabled="sku.stock <= 0" />
              {{ sku.suk }} · ¥{{ skuDisplayPrice(sku) }}{{ skuPriceLabel(sku) ? `（${skuPriceLabel(sku)}）` : '' }}{{ sku.stock <= 0 ? '（无库存）' : '' }}
            </label>
            <p v-if="!detail.skus.length">暂无有效规格，暂不可购买</p>
          </fieldset>

          <div class="qty-row">
            <span class="qty-label">数量</span>
            <el-input-number :key="selectedUnique" v-model="qty" aria-label="购买数量" :disabled="purchaseLocked || !selectedSku" :min="1" :max="Math.max(selectedStock, 1)" />
          </div>

          <div class="actions">
            <template v-if="preparedCart">
              <el-button type="primary" size="large" :loading="checkoutNavigating" :disabled="checkoutNavigating" @click="resumeCheckout">继续结算</el-button>
              <el-button size="large" :disabled="checkoutNavigating || purchaseSubmitting || packageBuying" @click="restartPurchase">重新选择商品</el-button>
            </template>
            <el-button v-else-if="purchaseNeedsRefresh" type="primary" size="large" @click="restartPurchase">重新加载商品</el-button>
            <el-button
              v-if="!preparedCart && !purchaseNeedsRefresh"
              type="danger"
              size="large"
              :disabled="!canPurchase || purchaseLocked"
              @click="addToCart"
            >
              加入购物车
            </el-button>
            <el-button
              v-if="!preparedCart && !purchaseNeedsRefresh"
              type="primary"
              size="large"
              :disabled="!canPurchase || purchaseLocked"
              @click="buyNow"
            >
              立即购买
            </el-button>
            <el-button
              size="large"
              :type="collected ? 'warning' : 'default'"
              :loading="collectSubmitting"
              @click="toggleCollect"
            >
              {{ collected ? "已收藏" : "收藏" }}
            </el-button>
          </div>
        </div>
      </div>

      <el-dialog v-model="packageVisible" :title="selectedPackage?.title || '搭配购'" width="min(680px, calc(100vw - 32px))">
        <div v-if="selectedPackage" class="package-picker">
          <div
            v-for="entry in selectedPackage.products"
            :key="entry.id"
            class="package-product"
          >
            <el-checkbox
              :model-value="packageChoices[entry.id]?.selected"
              :disabled="purchaseLocked || isRequiredPackageEntry(entry)"
              @change="togglePackageProduct(entry.id, Boolean($event))"
            >
              {{ isRequiredPackageEntry(entry) ? "必选" : "可选" }}
            </el-checkbox>
            <ProductImage :src="entry.image" :alt="entry.title" class="package-product-image" />
            <div class="package-product-info">
              <strong>{{ entry.title }}</strong>
              <el-select
                v-model="packageChoices[entry.id].unique"
                :disabled="purchaseLocked"
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
          <el-button type="danger" :loading="packageBuying" :disabled="purchaseLocked" @click="buyPackage">立即结算套餐</el-button>
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
import ProductImage from "@/components/ProductImage.vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { isNavigationFailure, useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiGoodsDetail, apiReplyConfig, apiReplyList } from "@/api/product";
import { apiCartAdd, apiDiscountCartAdd } from "@/api/cart";
import { productCartInput } from "@/api/productPurchase";
import { apiCollectAdd, apiCollectDel } from "@/api/user";
import {
  apiDiscountPackages,
  type DiscountPackage,
  type DiscountPackageProduct,
} from "@/api/activity";
import type { GoodsDetail } from "@/types/product";
import { isLoggedIn, captureAuthSession, isCurrentAuthSession, onAuthChange } from "@/utils/auth";
import { skuDisplayPrice, skuPriceLabel, skuVipOffer } from "../../../../common/skuMembershipPrice";
import { productDetailId } from "../../../../common/productDetailRoute";
import { prepareProductCart, type PreparedProductCart } from '../../../../common/preparedProductCart';

const route = useRoute();
const router = useRouter();
const detail = ref<GoodsDetail | null>(null);
const loading = ref(true);
const loadError = ref('');
const qty = ref(1);
const selectedUnique = ref("");
const purchaseSubmitting = ref(false);
const selectedSku = computed(() => detail.value?.skus.find((sku) => sku.unique === selectedUnique.value));
const selectedStock = computed(() => Math.min(selectedSku.value?.stock ?? 0, detail.value?.stock ?? 0, 32767));
const displayPrice = computed(() => selectedSku.value ? skuDisplayPrice(selectedSku.value) : detail.value?.price);
const displayPriceLabel = computed(() => skuPriceLabel(selectedSku.value));
const displayOriginalPrice = computed(() => selectedSku.value?.ot_price);
const displayVipPrice = computed(() => skuVipOffer(selectedSku.value, detail.value?.is_vip === 1));
const canPurchase = computed(() => detail.value?.cart_button === 1 && !!selectedSku.value && selectedStock.value > 0
  && Number.isSafeInteger(qty.value) && qty.value > 0 && qty.value <= selectedStock.value);
watch(selectedUnique, () => { qty.value = Math.max(1, Math.min(qty.value, selectedStock.value)); });
const collected = ref(false);
const collectSubmitting = ref(false);
const replies = ref<unknown[]>([]);
const replyStats = ref({ total: 0, avgScore: "0.0", goodRate: 100 });
const discountPackages = ref<DiscountPackage[]>([]);
const selectedPackage = ref<DiscountPackage | null>(null);
const packageVisible = ref(false);
const packageBuying = ref(false);
const preparedCart = ref<PreparedProductCart | null>(null), checkoutNavigating = ref(false), checkoutError = ref(''), purchaseNeedsRefresh = ref(false);
const purchaseLocked = computed(() => purchaseSubmitting.value || packageBuying.value || checkoutNavigating.value || !!preparedCart.value || purchaseNeedsRefresh.value);
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

async function loadReplies(productId: number, current: () => boolean) {
  try {
    const stats = await apiReplyConfig(productId);
    if (!current()) return;
    replyStats.value = stats;
  } catch {
    // 静默
  }
  try {
    if (!current()) return;
    const rows = await apiReplyList(productId);
    if (current()) replies.value = rows;
  } catch {
    if (current()) replies.value = [];
  }
}

let loadGeneration = 0;
let disposed = false;
function currentView() {
  const generation = loadGeneration, owner = captureAuthSession(), path = route.fullPath;
  return () => !disposed && generation === loadGeneration && route.fullPath === path && isCurrentAuthSession(owner);
}
function clearView() {
  loadGeneration++;
  detail.value = null; selectedUnique.value = ''; qty.value = 1;
  discountPackages.value = []; selectedPackage.value = null; packageChoices.value = {}; packageVisible.value = false;
  collected.value = false; replies.value = []; replyStats.value = { total: 0, avgScore: '0.0', goodRate: 100 };
  purchaseSubmitting.value = false; packageBuying.value = false; collectSubmitting.value = false;
  preparedCart.value = null; checkoutNavigating.value = false; checkoutError.value = ''; purchaseNeedsRefresh.value = false;
  loading.value = false; loadError.value = '';
}
async function load() {
  clearView();
  if (disposed || route.name !== 'goods-detail') return;
  const current = currentView();
  loading.value = true;
  try {
    const id = productDetailId(route.params.id);
    const [goods, packages] = await Promise.all([
      apiGoodsDetail(id),
      apiDiscountPackages(id).catch(() => []),
    ]);
    if (!current()) return;
    if (goods.id !== id) throw new Error('商品详情标识不匹配，请重新加载');
    detail.value = goods;
    const requested = route.query.sku;
    selectedUnique.value = requested === undefined
      ? goods.skus.find((sku) => sku.stock > 0)?.unique ?? ""
      : goods.skus.find((sku) => sku.unique === requested && sku.stock > 0)?.unique ?? "";
    const requestedQuantity = Number(route.query.qty ?? 1);
    qty.value = Number.isSafeInteger(requestedQuantity) && requestedQuantity > 0
      ? Math.max(1, Math.min(requestedQuantity, selectedStock.value)) : 1;
    discountPackages.value = packages;
    collected.value = detail.value.userCollect;
    void loadReplies(id, current);
  } catch (e) {
    if (current()) loadError.value = e instanceof Error ? e.message : "商品详情加载失败";
  } finally {
    if (current()) loading.value = false;
  }
}

function isRequiredPackageEntry(entry: DiscountPackageProduct): boolean {
  return selectedPackage.value?.type === 0 || entry.type === 1;
}

function openPackage(item: DiscountPackage) {
  if (disposed || !detail.value || loading.value || purchaseLocked.value || !discountPackages.value.includes(item)) return;
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
  if (purchaseLocked.value) return;
  const choice = packageChoices.value[entryId];
  if (choice) choice.selected = selected;
}

async function buyPackage() {
  if (preparedCart.value?.type === 5) return resumeCheckout();
  const item = selectedPackage.value;
  if (disposed || !detail.value || !item || purchaseLocked.value || !discountPackages.value.includes(item)) return;
  if (!isLoggedIn()) return router.push({ path: '/login', query: { redirect: route.fullPath } });
  const current = currentView();
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
    if (!current()) return;
    preparedCart.value = prepareProductCart(result, 5, selected.length);
    packageVisible.value = false;
    await resumeCheckout();
  } catch (error) {
    if (current()) { purchaseNeedsRefresh.value = true; checkoutError.value = error instanceof Error ? error.message : '套餐购买记录未确认'; packageVisible.value = false; }
  } finally {
    if (current()) packageBuying.value = false;
  }
}

async function addToCart() {
  await purchase(false);
}

async function buyNow() {
  await purchase(true);
}

async function purchase(direct: boolean) {
  if (direct && preparedCart.value?.type === 0) return resumeCheckout();
  if (disposed || !detail.value || loading.value || purchaseLocked.value) return;
  const current = currentView();
  let sent = false;
  purchaseSubmitting.value = true;
  try {
    const input = productCartInput(detail.value, selectedUnique.value, qty.value, direct);
    if (!isLoggedIn()) {
      const redirect = router.resolve({ path: route.path, query: { ...route.query, sku: input.unique, qty: String(input.cartNum) }, hash: route.hash }).fullPath;
      await router.push({ path: "/login", query: { redirect } });
      return;
    }
    sent = true;
    const result = await apiCartAdd(input);
    if (!current()) return;
    const prepared = prepareProductCart(result, 0);
    if (direct) {
      preparedCart.value = prepared;
      await resumeCheckout();
    } else ElMessage.success("已加入购物车");
  } catch (e) {
    if (current()) {
      if (sent) { purchaseNeedsRefresh.value = true; checkoutError.value = e instanceof Error ? e.message : '购买记录未确认'; }
      else ElMessage.error(e instanceof Error ? e.message : '加入失败');
    }
  } finally {
    if (current()) purchaseSubmitting.value = false;
  }
}

async function resumeCheckout() {
  const prepared = preparedCart.value;
  if (disposed || !detail.value || !prepared || checkoutNavigating.value || !isLoggedIn()) return;
  const current = currentView(); checkoutNavigating.value = true; checkoutError.value = '';
  try {
    const failure = await router.push({ path: '/checkout', query: { mode: 'buy', cartIds: prepared.ids.join(','), ...(prepared.type === 5 ? { type: '5' } : {}) } });
    if (isNavigationFailure(failure)) throw Error('结算页面未打开，请点击继续结算');
  } catch {
    if (current() && preparedCart.value === prepared) checkoutError.value = '结算页面未打开，请点击继续结算';
  } finally { if (current() && preparedCart.value === prepared) checkoutNavigating.value = false; }
}
function restartPurchase() {
  if (disposed || checkoutNavigating.value || purchaseSubmitting.value || packageBuying.value) return;
  void load();
}

async function toggleCollect() {
  if (disposed || loading.value || !detail.value) return;
  if (!isLoggedIn()) return router.push({ path: "/login", query: { redirect: route.fullPath } });
  if (!detail.value || collectSubmitting.value) return;
  const nextCollected = !collected.value;
  const current = currentView();
  collectSubmitting.value = true;
  try {
    if (nextCollected) await apiCollectAdd([detail.value.id]);
    else await apiCollectDel([detail.value.id]);
    if (!current()) return;
    collected.value = nextCollected;
    ElMessage.success(nextCollected ? "收藏成功" : "已取消收藏");
  } catch (error) {
    if (current()) ElMessage.error(error instanceof Error ? error.message : "收藏操作失败");
  } finally {
    if (current()) collectSubmitting.value = false;
  }
}

watch(() => route.fullPath, load, { immediate: true, flush: 'sync' });
const unbindAuth = onAuthChange(() => { void load(); });
onBeforeUnmount(() => { disposed = true; unbindAuth(); clearView(); });
</script>

<style scoped>
.purchase-recovery { margin-bottom: 20px; padding: 16px; background: #fff6e9; border: 1px solid #efd6b3; border-radius: 8px; }
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
  width: 400px;
  height: 400px;
  align-self: flex-start;
  border-radius: 8px;
  overflow: hidden;
}

.product-carousel {
  height: 100%;
}

.gallery-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.info {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
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
  grid-template-columns: 70px 64px minmax(0, 1fr);
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
  min-width: 0;
  overflow-wrap: anywhere;
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

.sku-picker { border: 0; padding: 0; margin: 0 0 20px; min-width: 0; }
.sku-picker legend { margin-bottom: 8px; color: #666; }
.sku-choice { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; overflow-wrap: anywhere; }

/* Keep long content and actions in normal flow, not clipped off-screen. */
.price-box, .meta, .package-card, .actions, .reply-head, .reply-pics, .reply-meta {
  flex-wrap: wrap;
}

.reply-comment {
  overflow-wrap: anywhere;
}

.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

@media (max-width: 900px) {
  .detail-main {
    flex-direction: column;
    gap: 20px;
    padding: 16px;
  }

  .gallery {
    flex: none;
    width: 100%;
    max-width: 400px;
    height: auto;
    aspect-ratio: 1;
    align-self: center;
  }

  .info {
    width: 100%;
  }
}

@media (max-width: 600px) {
  .actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .actions :deep(.el-button) {
    width: 100%;
    min-width: 0;
    padding-inline: 8px;
  }

  .actions :deep(.el-button:last-child) {
    grid-column: 1 / -1;
  }

  .reply-section {
    padding: 16px;
  }

  .package-product {
    grid-template-columns: 60px 48px minmax(0, 1fr);
    gap: 8px;
  }
}
</style>
