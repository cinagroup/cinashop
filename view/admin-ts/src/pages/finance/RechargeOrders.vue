<template>
  <div class="recharge-orders">
    <div class="heading"><div><h2>充值订单</h2><p class="hint">按充值订单读取支付与退款记录；统计金额仅计算已支付订单。</p></div>
      <el-button v-if="canView" :loading="loading || statsLoading" @click="load(page)">刷新</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有充值订单查看权限" type="warning" show-icon :closable="false" />
    <template v-else>
      <el-card shadow="never" class="section">
        <div class="filters">
          <label class="field date-field"><span>创建时间（上海时间，结束分钟包含）</span><el-date-picker v-model="draftDates" type="datetimerange" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" start-placeholder="开始" end-placeholder="结束" range-separator="至" /></label>
          <label class="field paid-field"><span>支付状态</span><el-select v-model="draftPaid"><el-option label="全部" value="all" /><el-option label="已支付" :value="1" /><el-option label="未支付" :value="0" /></el-select></label>
          <label class="field keyword-field"><span>用户或订单</span><el-input v-model="draftKeyword" clearable maxlength="80" placeholder="昵称 / 手机 / UID / 订单号" @keyup.enter="search" /></label>
          <div class="actions"><el-button type="primary" @click="search">查询</el-button><el-button @click="reset">重置</el-button></div>
        </div>
        <el-alert v-if="filterError" :title="filterError" type="error" :closable="false" show-icon />
        <div class="stat-heading"><strong>已支付充值统计</strong><span class="hint">按当前时间和关键词范围统计；不随“支付状态”筛选切换为未支付口径。</span></div>
        <el-alert v-if="statsError" :title="statsError" type="error" :closable="false" show-icon><el-button link type="primary" @click="load(page)">重新读取</el-button></el-alert>
        <div v-else class="stats-grid" v-loading="statsLoading">
          <el-card shadow="never"><span>已支付本金</span><strong>{{ stats ? `¥${stats.sum_price}` : '—' }}</strong></el-card>
          <el-card shadow="never"><span>已记录退款</span><strong>{{ stats ? `¥${stats.sum_refund_price}` : '—' }}</strong></el-card>
          <el-card shadow="never"><span>小程序充值</span><strong>{{ stats ? `¥${stats.sum_routine_price}` : '—' }}</strong></el-card>
          <el-card shadow="never"><span>微信充值</span><strong>{{ stats ? `¥${stats.sum_weixin_price}` : '—' }}</strong></el-card>
        </div>
      </el-card>
      <el-card shadow="never" class="section">
        <div class="stat-heading"><strong>充值订单</strong><span class="hint">匹配 {{ count }} 条；每页 20 条。异常记录保留在列表供核对。</span></div>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon><el-button link type="primary" @click="load(page)">重新读取</el-button></el-alert>
        <div v-else class="table-scroll"><el-table :data="list" v-loading="loading" border row-key="id" :empty-text="loading ? '读取中…' : '暂无充值订单'">
          <el-table-column prop="id" label="ID" width="85" />
          <el-table-column label="用户" min-width="170"><template #default="{ row }"><div class="user-cell"><el-avatar v-if="row.avatar" :src="row.avatar" :size="32" /><div>{{ row.nickname || `UID ${row.uid}` }}<div v-if="row.user_deleted || row.user_missing" class="hint">{{ row.user_missing ? '用户缺失' : '用户已注销' }}</div></div></div></template></el-table-column>
          <el-table-column prop="order_id" label="订单号" min-width="185" />
          <el-table-column label="支付金额" width="115"><template #default="{ row }">¥{{ row.price }}</template></el-table-column>
          <el-table-column label="赠送金额" width="115"><template #default="{ row }">¥{{ row.give_price }}</template></el-table-column>
          <el-table-column label="支付状态" width="105"><template #default="{ row }"><el-tag :type="row.paid === 1 ? 'success' : row.paid === 0 ? 'warning' : 'danger'">{{ row.paid_type }}</el-tag></template></el-table-column>
          <el-table-column prop="recharge_type_label" label="充值类型" width="130" />
          <el-table-column label="支付时间" width="170"><template #default="{ row }">{{ rechargeOrderTime(row.pay_time) }}</template></el-table-column>
          <el-table-column label="操作" width="140" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openDetail(row)">查看详情</el-button><el-tag v-if="row.issues.length" size="small" type="warning">需核对</el-tag></template></el-table-column>
        </el-table></div>
        <el-pagination v-if="!loading && !listError" class="pager" :current-page="page" :page-size="20" :total="count" layout="total, prev, pager, next" @current-change="load" />
      </el-card>
      <el-dialog v-model="detailVisible" title="充值订单详情" width="min(760px, calc(100vw - 24px))" @closed="closeDetail">
        <div v-loading="detailLoading">
          <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon><el-button link type="primary" @click="reloadDetail">重新读取</el-button></el-alert>
          <template v-else-if="detail">
            <el-descriptions :column="descriptionColumns" border>
              <el-descriptions-item label="订单 ID">{{ detail.id }}</el-descriptions-item>
              <el-descriptions-item label="公开订单号">{{ detail.order_id }}</el-descriptions-item>
              <el-descriptions-item label="UID">{{ detail.uid }}</el-descriptions-item>
              <el-descriptions-item label="昵称">{{ detail.nickname || '—' }}</el-descriptions-item>
              <el-descriptions-item label="姓名">{{ detail.real_name || '—' }}</el-descriptions-item>
              <el-descriptions-item label="电话">{{ detail.phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="支付状态">{{ detail.paid_type }}</el-descriptions-item>
              <el-descriptions-item label="充值类型">{{ detail.recharge_type_label }}</el-descriptions-item>
              <el-descriptions-item label="支付金额">¥{{ detail.price }}</el-descriptions-item>
              <el-descriptions-item label="赠送金额">¥{{ detail.give_price }}</el-descriptions-item>
              <el-descriptions-item label="已记录退款">¥{{ detail.refund_price }}</el-descriptions-item>
              <el-descriptions-item label="创建时间">{{ rechargeOrderTime(detail.add_time) }}</el-descriptions-item>
              <el-descriptions-item label="支付时间">{{ rechargeOrderTime(detail.pay_time) }}</el-descriptions-item>
              <el-descriptions-item label="渠道">{{ detail.channel_type || '—' }}</el-descriptions-item>
              <el-descriptions-item label="交易号">{{ detail.trade_no || '—' }}</el-descriptions-item>
              <el-descriptions-item label="门店 ID">{{ detail.store_id || '—' }}</el-descriptions-item>
              <el-descriptions-item label="员工 ID">{{ detail.staff_id || '—' }}</el-descriptions-item>
              <el-descriptions-item label="备注">{{ detail.remarks || '—' }}</el-descriptions-item>
            </el-descriptions>
            <el-alert v-if="detail.issues.length" class="section" title="历史记录需核对" type="warning" :closable="false"><ul><li v-for="(issue, index) in detail.issues" :key="index">{{ issue }}</li></ul></el-alert>
          </template>
        </div>
        <template #footer><el-button @click="detailVisible = false">关闭</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiRechargeOrderDetail, apiRechargeOrderList, apiRechargeOrderStats, normalizeRechargeOrderQuery, rechargeOrderTime,
  type RechargeOrderDetail, type RechargeOrderQuery, type RechargeOrderRow, type RechargeOrderStats, type RechargePaidFilter } from '@/api/rechargeOrders';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('recharge_order.view')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const descriptionColumns = computed(() => window.innerWidth <= 680 ? 1 : 2);
const draftDates = ref<[string, string] | null>(null), draftPaid = ref<RechargePaidFilter>('all'), draftKeyword = ref('');
const applied = ref<Pick<RechargeOrderQuery, 'paid' | 'start_time' | 'end_time' | 'keyword'>>({ paid: 'all', start_time: '', end_time: '', keyword: '' });
const page = ref(1), list = ref<RechargeOrderRow[]>([]), count = ref(0), loading = ref(false), listError = ref('');
const stats = ref<RechargeOrderStats | null>(null), statsLoading = ref(false), statsError = ref(''), filterError = ref('');
const detailVisible = ref(false), detail = ref<RechargeOrderDetail | null>(null), detailId = ref(0), detailLoading = ref(false), detailError = ref('');
let alive = false, syncing = false, generation = 0, detailVersion = 0, stored = localStorage.getItem('admin_session');
let listAbort: AbortController | null = null, statsAbort: AbortController | null = null, detailAbort: AbortController | null = null;
type Scope = { identity: string; generation: number; stored: string | null };
function scope(): Scope { return { identity: identity.value, generation, stored }; }
function current(value: Scope) { return alive && canView.value && value.identity === identity.value && value.generation === generation &&
  auth.token === getToken() && value.stored === localStorage.getItem('admin_session'); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '请求失败'; }
function resetDetail() { detailVersion++; detailAbort?.abort(); detailAbort = null; detail.value = null; detailId.value = 0;
  detailVisible.value = false; detailLoading.value = false; detailError.value = ''; }
function closeDetail() { if (!detailVisible.value) resetDetail(); }
function clear() { generation++; listAbort?.abort(); statsAbort?.abort(); listAbort = statsAbort = null; list.value = []; count.value = 0;
  stats.value = null; listError.value = statsError.value = ''; loading.value = statsLoading.value = false; resetDetail(); }
async function load(target = page.value) {
  if (!alive || !canView.value || auth.token !== getToken() || stored !== localStorage.getItem('admin_session') ||
    !Number.isSafeInteger(target) || target < 1 || target > 501) return;
  clear(); page.value = target;
  const stamp = scope(), listController = new AbortController(), statsController = new AbortController();
  listAbort = listController; statsAbort = statsController; loading.value = statsLoading.value = true;
  const query: RechargeOrderQuery = { page: target, limit: 20, ...applied.value };
  await Promise.all([
    (async () => { try { const result = await apiRechargeOrderList(query, listController.signal);
      if (!current(stamp) || listAbort !== listController) return;
      if (!result.list.length && target > 1 && result.count > 0) { await load(Math.min(target - 1, Math.ceil(result.count / 20))); return; }
      list.value = result.list; count.value = result.count;
    } catch (error) { if (current(stamp) && listAbort === listController) listError.value = errorMessage(error); }
    finally { if (listAbort === listController) { listAbort = null; loading.value = false; } } })(),
    (async () => { try { const result = await apiRechargeOrderStats(query, statsController.signal);
      if (current(stamp) && statsAbort === statsController) stats.value = result;
    } catch (error) { if (current(stamp) && statsAbort === statsController) statsError.value = errorMessage(error); }
    finally { if (statsAbort === statsController) { statsAbort = null; statsLoading.value = false; } } })(),
  ]);
}
function search() {
  if (!current(scope())) return;
  try { const query = normalizeRechargeOrderQuery({ page: 1, limit: 20, paid: draftPaid.value,
    start_time: draftDates.value?.[0] ?? '', end_time: draftDates.value?.[1] ?? '', keyword: draftKeyword.value });
    applied.value = { paid: query.paid, start_time: query.start_time, end_time: query.end_time, keyword: query.keyword };
    filterError.value = ''; void load(1);
  } catch (error) { filterError.value = errorMessage(error); }
}
function reset() { draftDates.value = null; draftPaid.value = 'all'; draftKeyword.value = ''; search(); }
async function openDetail(row: RechargeOrderRow) {
  if (!current(scope()) || !list.value.some(item => item.id === row.id)) return;
  resetDetail(); detailId.value = row.id; detailVisible.value = true; await reloadDetail();
}
async function reloadDetail() {
  const id = detailId.value;
  if (!id || !detailVisible.value || !current(scope())) return;
  detailVersion++; detailAbort?.abort(); const version = detailVersion, stamp = scope(), controller = new AbortController();
  detailAbort = controller; detailLoading.value = true; detailError.value = ''; detail.value = null;
  try { const result = await apiRechargeOrderDetail(id, controller.signal);
    if (current(stamp) && version === detailVersion && detailAbort === controller && detailVisible.value) detail.value = result;
  } catch (error) { if (current(stamp) && version === detailVersion && detailAbort === controller) detailError.value = errorMessage(error); }
  finally { if (detailAbort === controller) { detailAbort = null; detailLoading.value = false; } }
}
function syncSession() {
  syncing = true; clear(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem('admin_session'); syncing = false; page.value = 1; void load(1);
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(identity, () => { if (alive && !syncing) { clear(); page.value = 1; void load(1); } }, { flush: 'sync' });
watch(detailVisible, visible => { if (!visible) { detailVersion++; detailAbort?.abort(); detailAbort = null; detail.value = null; detailLoading.value = false; } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession);
  window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener('admin-session-changed', syncSession);
  window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.recharge-orders { min-width: 0; }.heading, .stat-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.heading h2 { font-size: 20px; margin: 0 0 6px; }.hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.section { margin-top: 16px; }.filters { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }.date-field { flex: 1 1 300px; }.paid-field { width: 145px; }
.keyword-field { flex: 1 1 220px; }.field :deep(.el-date-editor), .field :deep(.el-select), .field :deep(.el-input) { width: 100%; }
.actions { display: flex; gap: 8px; }.actions :deep(.el-button + .el-button) { margin-left: 0; }
.stats-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.stats-grid :deep(.el-card__body) { display: flex; flex-direction: column; gap: 8px; }.stats-grid strong { font-size: 19px; }
.stat-heading { margin-bottom: 14px; }.table-scroll { overflow-x: auto; width: 100%; }.user-cell { display: flex; align-items: center; gap: 8px; }
.pager { margin-top: 16px; justify-content: flex-end; }
@media(max-width: 850px) { .stats-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media(max-width: 560px) { .field, .paid-field { flex: 1 1 100%; width: 100%; }.stats-grid { grid-template-columns: 1fr; } }
</style>
