<template>
  <el-card shadow="never" class="order-history" aria-label="订单操作记录">
    <template #header>
      <div class="history-heading"><strong>订单操作记录</strong><el-button :disabled="loading || !scope.isCurrent()" @click="reload">刷新记录</el-button></div>
    </template>
    <p class="history-tip">按操作时间排列，仅显示本订单记录；拆单前后的其他订单需分别查看。时间为上海时间。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-table v-else :data="rows" v-loading="loading" border empty-text="暂无操作记录">
      <el-table-column label="操作记录" min-width="180"><template #default="{ row }"><span class="history-message">{{ row.change_message }}</span></template></el-table-column>
      <el-table-column label="操作类型" min-width="150"><template #default="{ row }"><span class="history-message">{{ row.change_type }}</span></template></el-table-column>
      <el-table-column prop="change_time" label="操作时间" width="180" />
    </el-table>
    <el-pagination v-if="!error && count > 0" :current-page="page" :page-size="limit" :total="count" :pager-count="5"
      :disabled="loading" layout="total, prev, pager, next" class="history-pagination" @current-change="loadPage" />
  </el-card>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import axios from 'axios';
import { apiAdminOrderHistory } from '@/api/order';
import type { AdminOrderHistoryRow } from '@/utils/orderHistory';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
const props = defineProps<{ id: number; orderNo: string }>();
const rows = ref<AdminOrderHistoryRow[]>([]), count = ref(0), page = ref(1), loading = ref(false), error = ref('');
const limit = 20; let revision: string | undefined, epoch = 0, controller: AbortController | undefined;
const scope = createAdminSessionScope(() => { reset(); error.value = '登录状态已变化，请重新打开页面'; });
function reset() { epoch++; controller?.abort(); rows.value = []; count.value = 0; page.value = 1; revision = undefined; loading.value = false; error.value = ''; }
async function loadPage(target: number) {
  if (!scope.isCurrent() || loading.value || (target > 1 && !revision)) return;
  const generation = ++epoch, id = props.id, orderNo = props.orderNo, expected = revision;
  controller?.abort(); controller = new AbortController(); loading.value = true; error.value = ''; rows.value = [];
  const current = () => scope.isCurrent() && generation === epoch && props.id === id && props.orderNo === orderNo;
  try {
    const result = await apiAdminOrderHistory(id, orderNo, { page: target, limit, ...(expected ? { revision: expected } : {}) }, controller.signal);
    if (current()) { rows.value = result.list; count.value = result.count; page.value = result.page; revision = result.revision; }
  } catch (cause) {
    if (current()) { rows.value = []; count.value = 0; page.value = 1; revision = undefined;
      error.value = axios.isAxiosError(cause)
        ? cause.response?.status === 409 ? '订单记录已变化，请刷新记录后重新查看。' : '订单记录暂时无法读取，请刷新记录后重试。'
        : cause instanceof Error ? cause.message : '订单记录读取失败，请刷新记录后重试。'; }
  } finally { if (current()) loading.value = false; }
}
function reload() { if (!scope.isCurrent() || loading.value) return; reset(); void loadPage(1); }
watch(() => [props.id, props.orderNo] as const, () => { reset(); void loadPage(1); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { reset(); scope.dispose(); });
</script>

<style scoped>
.history-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.history-tip { color: #606266; line-height: 1.6; margin: 0 0 12px; }
.history-message { white-space: pre-wrap; overflow-wrap: anywhere; }
.history-pagination { display: flex; justify-content: flex-end; margin-top: 16px; }
</style>
