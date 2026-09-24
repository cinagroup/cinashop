<template>
  <view class="work-page">
    <!-- #ifdef H5 -->
    <view class="tabs"><button :class="{ selected: active === 0 }" @tap="changeTab(0)">购买记录</button><button :class="{ selected: active === 1 }" @tap="changeTab(1)">浏览记录</button></view>
    <view class="search"><input v-model="searchInput" maxlength="100" placeholder="搜索商品" @confirm="search" /><button @tap="search">搜索</button></view>
    <text v-if="active === 0 && searchTerm" class="hint">搜索结果来自可见商品目录，不限于该客户已购买商品。</text>
    <view v-if="access.error.value || error" class="notice error" role="alert">{{ access.error.value || error }}<button @tap="refresh">重试</button></view>
    <view v-if="!items.length && loading" class="notice">正在读取商品记录…</view>
    <view v-else-if="!items.length && !access.error.value && !error" class="notice">暂无{{ active === 0 ? "购买" : "浏览" }}记录</view>
    <view v-for="item in items" :key="item.id" class="product card">
      <image v-if="item.image" :src="item.image" class="photo" mode="aspectFill" />
      <view class="info"><text class="name">{{ item.store_name }}</text><text class="muted">库存 {{ item.stock }} · 销量 {{ item.sales }}</text><text v-if="active === 1 && item.visit_time" class="muted">最近浏览 {{ item.visit_time }}</text><text class="price">¥{{ item.price }}</text></view>
      <button class="push" @tap="push(item)">推送</button>
    </view>
    <button v-if="hasMore && !loading" class="more" @tap="loadMore">加载更多</button>
    <view v-else-if="loading && items.length" class="end">正在加载…</view>
    <view v-else-if="items.length" class="end">已显示全部记录</view>
    <WorkNav active="record" :ready="!!access.token.value" :target-hint="access.token.value ? hint : undefined" />
    <!-- #endif -->
    <!-- #ifndef H5 --><view class="notice">企业微信工作台仅支持 H5 侧边栏。</view><!-- #endif -->
  </view>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { onLoad, onReachBottom, onUnload } from "@dcloudio/uni-app";
import { getWorkPurchasedProducts, getWorkVisitedProducts, type WorkProductSummary } from "@/api/work";
import { useWorkAccess } from "@/composables/useWorkAccess";
import { sendWorkProduct } from "@/composables/workContext";
import WorkNav from "@/components/work/WorkNav.vue";

const access = useWorkAccess("client");
const active = ref<0 | 1>(0);
const searchInput = ref("");
const searchTerm = ref("");
const items = ref<WorkProductSummary[]>([]);
const error = ref("");
const loading = ref(false);
const hasMore = ref(false);
watch(access.token, (value) => { if (!value) { items.value = []; hasMore.value = false; } }, { flush: "sync" });
let page = 1;
let epoch = 0;
let hint: string | undefined;

onLoad((query) => { hint = typeof query?.userid === "string" ? query.userid : undefined; void refresh(); });
onReachBottom(() => { void loadMore(); });
onUnload(() => { epoch++; items.value = []; access.dispose(); });

async function list(token: string, currentPage: number) {
  const query = { page: currentPage, limit: 10, store_name: searchTerm.value };
  return active.value === 0 ? getWorkPurchasedProducts(token, query) : getWorkVisitedProducts(token, query);
}

async function refresh() {
  const current = ++epoch;
  items.value = [];
  hasMore.value = false;
  page = 1;
  error.value = "";
  loading.value = true;
  try {
    const route = `/pages/work/record/index${hint ? `?userid=${encodeURIComponent(hint)}` : ""}`;
    const token = await access.connect(route, hint);
    if (!token || current !== epoch) return;
    const result = await list(token, page);
    if (current !== epoch || !await access.verifiedToken(hint, token)) return;
    items.value = result;
    hasMore.value = result.length === 10;
    page++;
  } catch (cause) {
    if (current === epoch) { items.value = []; access.readFailure(cause); }
  } finally { if (current === epoch) loading.value = false; }
}

async function loadMore() {
  if (loading.value || !hasMore.value) return;
  const current = epoch;
  loading.value = true;
  error.value = "";
  try {
    const token = await access.verifiedToken(hint);
    if (!token) { items.value = []; hasMore.value = false; return; }
    if (current !== epoch) return;
    const result = await list(token, page);
    if (current !== epoch || !await access.verifiedToken(hint, token)) return;
    items.value = [...items.value, ...result];
    hasMore.value = result.length === 10;
    page++;
  } catch (cause) {
    if (current === epoch) { access.readFailure(cause); error.value = access.error.value; }
  } finally { if (current === epoch) loading.value = false; }
}

function changeTab(value: 0 | 1) { if (active.value === value) return; active.value = value; void refresh(); }
function search() { searchTerm.value = searchInput.value.trim().slice(0, 100); void refresh(); }
async function push(item: WorkProductSummary) {
  const token = access.readyToken();
  if (!token) { items.value = []; return; }
  error.value = "";
  try { await sendWorkProduct(item, token); uni.showToast({ title: "已发送到当前会话", icon: "success" }); }
  catch (cause) {
    if (!access.readyToken()) items.value = [];
    error.value = cause instanceof Error ? cause.message : "推送失败，请重试";
  }
}
</script>

<style scoped>
.work-page { min-height: 100vh; background: #f3f6f9; padding: 16rpx 20rpx 130rpx; box-sizing: border-box; }
.tabs { display: flex; background: #fff; border-radius: 12rpx; }.tabs button { flex: 1; margin: 0; background: #fff; color: #546173; font-size: 27rpx; }.tabs button::after { border: 0; }.tabs button.selected { color: #1768c8; border-bottom: 4rpx solid #1768c8; }
.search { display: flex; gap: 12rpx; margin: 16rpx 0; }.search input { flex: 1; min-width: 0; padding: 10rpx 18rpx; border-radius: 9rpx; background: #fff; }.search button { margin: 0; font-size: 25rpx; }.hint { display: block; color: #6c7787; font-size: 23rpx; margin-bottom: 15rpx; }
.card, .notice { background: #fff; border-radius: 15rpx; padding: 22rpx; margin-bottom: 16rpx; }.notice { overflow-wrap: anywhere; }.notice button { margin-top: 16rpx; }.error { color: #a72d2d; }
.product { display: flex; align-items: center; gap: 16rpx; }.photo { width: 100rpx; height: 100rpx; border-radius: 10rpx; flex-shrink: 0; }.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7rpx; }.name { font-size: 27rpx; overflow-wrap: anywhere; }.muted { font-size: 22rpx; color: #718094; }.price { color: #bd3025; font-weight: 700; }.push { margin: 0; font-size: 24rpx; color: #1768c8; background: #edf5ff; }
.more, .end { display: block; text-align: center; margin: 22rpx auto; color: #526071; font-size: 25rpx; }
</style>
