<template>
  <div class="order-list container">
    <h2 class="title">我的订单</h2>
    <router-link to="/user/refunds">查看售后退款记录</router-link>
    <el-tabs :model-value="activeTab" @tab-change="switchTab">
      <el-tab-pane label="全部" name="all" />
      <el-tab-pane label="待支付" name="unpaid" />
      <el-tab-pane label="待发货" name="pending" />
      <el-tab-pane label="待收货/核销" name="shipping" />
      <el-tab-pane label="待评价" name="review" />
      <el-tab-pane label="已完成" name="complete" />
    </el-tabs>
    <div class="list-tools">
      <span v-if="list.ready">已加载 {{ orders.length }} 笔订单</span>
      <el-button :disabled="busy" @click="reload">刷新列表</el-button>
    </div>
    <el-skeleton v-if="list.loading && !orders.length" :rows="5" animated />

    <div v-if="orders.length" class="order-cards">
      <div v-for="order in orders" :key="order.order_id" class="order-card">
        <div class="order-header">
          <span class="order-id">订单号: {{ order.order_id }}</span>
          <span class="order-status">{{ statusText(order) }}</span>
        </div>
        <button type="button" class="order-body" :disabled="busy" :aria-label="`查看订单 ${order.order_id}`" @click="goDetail(order)">
          <template v-if="order.cart_info?.length">
            <div v-for="ci in order.cart_info" :key="ci.id" class="cart-line">
              <ProductImage v-if="ci.cart_info?.product" :src="ci.cart_info.product.image" :alt="ci.cart_info.product.storeName" class="thumb" />
              <span class="cart-name">{{ ci.cart_info?.product?.storeName }}</span>
              <span class="cart-num">x{{ ci.cart_num }}</span>
            </div>
          </template>
          <span v-if="!order.cart_info?.length">查看订单详情</span>
        </button>
        <div class="order-footer">
          <span class="total">¥{{ order.pay_price }}</span>
          <template v-if="order.paid === 0">
            <el-button type="primary" size="small" :disabled="busy || order.status !== 0" @click="pay(order)">去支付</el-button>
          </template>
          <template v-else-if="canReceiveOrder(order)">
            <el-button size="small" :disabled="busy || !!list.error || !!actionError" @click="take(order)">确认收货</el-button>
          </template>
          <template v-if="canTrackOrder(order)">
            <el-button size="small" :disabled="busy" @click="goExpress(order)">
              查看物流
            </el-button>
          </template>
          <template v-if="canReviewOrder(order)">
            <el-button size="small" type="success" :disabled="busy" @click="goDetail(order)">
              评价
            </el-button>
          </template>
          <el-button v-if="canDeleteOrder(order)" size="small" :disabled="busy || !!list.error || !!actionError" @click="remove(order)">删除订单</el-button>
        </div>
      </div>
    </div>
    <div v-if="list.error || actionError" class="list-error" role="alert">
      <p>{{ list.error || actionError }}</p>
      <el-button v-if="list.error && !list.refreshRequired" :disabled="busy" @click="loadMore">重试当前页</el-button>
      <el-button v-else :disabled="busy" @click="reload">刷新列表核对</el-button>
    </div>
    <el-empty v-else-if="!list.loading && list.ready && !orders.length" description="暂无订单" />
    <div v-if="orders.length && !list.error" class="list-more">
      <el-button v-if="list.hasMore" :loading="list.loading" :disabled="taking || deleting || navigating" @click="loadMore">加载更多订单</el-button>
      <span v-else>没有更多订单了</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import ProductImage from "@/components/ProductImage.vue";
import { ref, reactive, computed, watch, onBeforeUnmount } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiOrderList, apiOrderTake, apiOrderDelete } from "@/api/order";
import { useRouter, useRoute, isNavigationFailure } from "vue-router";
import type { OrderInfo } from "@/types/order";
import { captureAuthSession, isCurrentAuthSession, getUid, onAuthChange } from "@/utils/auth";
import { createOrderList, initialOrderList, orderListQuery, customerOrderStatus as statusText, canReceiveOrder, canReviewOrder, canTrackOrder } from "../../../../common/orderListState";
import { canDeleteOrder, orderDeleteConfirmation } from '../../../../common/orderDeletion';

const router = useRouter(), route = useRoute();
const list = reactive(initialOrderList<OrderInfo>());
const orders = computed(() => list.rows);
const taking = ref(false), deleting = ref(false), navigating = ref(false), actionError = ref('');
const busy = computed(() => list.loading || taking.value || deleting.value || navigating.value);
const names = ['unpaid','pending','shipping','review','complete'];
const activeTab = computed(() => list.status === undefined ? 'all' : names[list.status]);
let disposed = false, confirming = false, navigationVersion = 0;
function capture() {
  const session = captureAuthSession(), uid = getUid(), path = route.fullPath, revision = list.revision;
  return { uid, current: () => !disposed && route.path === '/order' && route.fullPath === path && list.revision === revision
    && !!session.token && uid > 0 && uid === getUid() && isCurrentAuthSession(session) };
}
const controller = createOrderList(list, { capture, read: apiOrderList }, 20);
function clearView() {
  controller.clear(); navigationVersion++; navigating.value = false; taking.value = false; deleting.value = false; actionError.value = '';
  if (confirming) { confirming = false; ElMessageBox.close(); }
}
async function reload() {
  if (disposed) return;
  clearView();
  try { await controller.refresh(orderListQuery(route.query)); }
  catch (error) { list.error = error instanceof Error ? error.message : '订单筛选无效'; list.refreshRequired = true; }
}
async function loadMore() { if (!taking.value && !deleting.value && !navigating.value && !actionError.value) await controller.more(); }
async function switchTab(name: string | number) {
  if (disposed) return;
  const status = name === 'all' ? undefined : names.indexOf(String(name));
  if (status === -1) return;
  const owner = capture();
  try {
    const result = await router.replace({ path: '/order', query: { ...route.query, type: undefined, status: status === undefined ? undefined : String(status) } });
    if (isNavigationFailure(result) && owner.current()) actionError.value = '筛选未切换，请重试';
  } catch { if (owner.current()) actionError.value = '筛选未切换，请重试'; }
}
async function navigate(order: OrderInfo, path: string) {
  if (busy.value || !controller.owns(order)) return;
  const owner = capture(), version = ++navigationVersion; navigating.value = true;
  try { const result = await router.push(path); if (owner.current() && isNavigationFailure(result)) actionError.value = '订单页面未打开，请重试查看'; }
  catch { if (owner.current()) actionError.value = '订单页面未打开，请重试查看'; }
  finally { if (owner.current() && version === navigationVersion) navigating.value = false; }
}
function goDetail(order: OrderInfo) { return navigate(order, `/order/${order.order_id}`); }
function goExpress(order: OrderInfo) { if (canTrackOrder(order)) return navigate(order, `/express?orderId=${order.order_id}`); }
function pay(order: OrderInfo) { if (order.paid === 0 && order.status === 0) return goDetail(order); }
async function take(order: OrderInfo) {
  if (busy.value || list.error || actionError.value || !controller.owns(order) || !canReceiveOrder(order)) return;
  const owner = capture(), id = order.order_id;
  taking.value = true; confirming = true;
  try { await ElMessageBox.confirm(`确认已收到订单 ${id} 的全部商品？`, '确认收货'); }
  catch { if (owner.current()) { taking.value = false; confirming = false; } return; }
  if (!owner.current()) return;
  confirming = false;
  try {
    await apiOrderTake(id);
    if (!owner.current()) return;
    ElMessage.success("已确认收货");
    await reload();
  } catch (e) {
    if (owner.current()) actionError.value = `收货结果尚未确认，请刷新列表核对。${e instanceof Error ? e.message : ''}`;
  } finally { if (owner.current()) taking.value = false; }
}
const stopAuth = onAuthChange(() => { clearView(); list.error = '登录状态已变化，请重新加载订单'; });
async function remove(order: OrderInfo) {
  if (busy.value || list.error || actionError.value || !controller.owns(order) || !canDeleteOrder(order)) return;
  const owner = capture(), id = order.order_id, confirmation = orderDeleteConfirmation(order);
  deleting.value = true; confirming = true;
  try {
    await ElMessageBox.confirm(confirmation, '删除订单', {
      confirmButtonText: '确认删除', cancelButtonText: '保留订单', type: 'warning',
      closeOnClickModal: false, distinguishCancelAndClose: true,
    });
  } catch { if (owner.current()) { deleting.value = false; confirming = false; } return; }
  if (!owner.current()) return;
  confirming = false;
  try {
    if (!controller.owns(order) || !canDeleteOrder(order) || orderDeleteConfirmation(order) !== confirmation) {
      actionError.value = '订单状态已变化，请刷新列表核对'; return;
    }
    await apiOrderDelete(id);
    if (!owner.current()) return;
    ElMessage.success('订单已删除');
    // Re-read from page one: removing a row locally would shift offset pagination.
    await reload();
  } catch (error) {
    if (owner.current()) actionError.value = `删除结果尚未确认，请刷新列表核对，勿重复提交。${error instanceof Error ? error.message : ''}`;
  } finally { if (owner.current()) deleting.value = false; }
}
watch(() => route.fullPath, () => { if (route.path === '/order') void reload(); else clearView(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { disposed = true; stopAuth(); clearView(); });
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.order-card {
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  margin-bottom: 16px;
}

.order-header {
  display: flex;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.order-id {
  color: #999;
  font-size: 13px;
}

.order-status {
  color: #e64340;
  font-size: 14px;
}

.order-body {
  display: block;
  width: 100%;
  background: transparent;
  border: 0;
  color: inherit;
  text-align: left;
  padding: 12px 0;
  cursor: pointer;
}

.list-tools, .list-more { display: flex; align-items: center; justify-content: center; gap: 16px; margin: 20px 0; }
.list-error { padding: 20px; margin: 16px 0; background: #fff7eb; border-radius: 8px; }
.order-header { gap: 12px; flex-wrap: wrap; }
.order-footer { flex-wrap: wrap; }
.order-id, .cart-name { overflow-wrap: anywhere; min-width: 0; }

.cart-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
}

.cart-name {
  flex: 1;
  font-size: 14px;
}

.cart-num {
  color: #999;
}

.order-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 16px;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.total {
  color: #e64340;
  font-size: 18px;
  font-weight: 600;
}
</style>
