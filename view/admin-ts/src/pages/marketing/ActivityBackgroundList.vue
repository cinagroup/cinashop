<template>
  <div class="activity-background-list">
    <header class="heading"><div><h2>活动背景</h2><p class="hint">管理商城商品卡片与详情使用的活动背景，列表按活动阶段及上海时间查询。</p></div><el-button v-if="canView" :loading="loading" :disabled="mutating || confirming" @click="load">刷新</el-button></header>
    <el-alert v-if="!canView" title="当前账号没有活动背景查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-card shadow="never">
        <div class="filters">
          <el-input v-model="filters.name" aria-label="活动名称或 ID" placeholder="活动名称或 ID" maxlength="200" clearable @keyup.enter="search" />
          <el-select v-model="filters.status" aria-label="活动阶段" placeholder="全部阶段"><el-option label="全部阶段" value="" /><el-option label="未开始" :value="0" /><el-option label="进行中" :value="1" /><el-option label="已结束" :value="-1" /></el-select>
          <el-date-picker v-model="activityTime" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" start-placeholder="活动开始" end-placeholder="活动结束" range-separator="至" :clearable="true" aria-label="活动时间范围" />
          <el-date-picker v-model="createdTime" type="datetimerange" value-format="YYYY-MM-DD HH:mm:ss" format="YYYY-MM-DD HH:mm:ss" start-placeholder="创建起始" end-placeholder="创建结束" range-separator="至" :clearable="true" aria-label="创建时间范围" />
          <el-button type="primary" :disabled="mutating || confirming" @click="search">查询</el-button><el-button :disabled="mutating || confirming" @click="reset">重置</el-button>
        </div>
      </el-card>
      <el-card shadow="never" class="results">
        <template #header><div class="heading"><strong>活动背景列表</strong><el-button v-if="canManage" type="primary" :disabled="mutating || confirming" @click="create">添加活动背景</el-button></div></template>
        <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon class="notice"><template #default><el-button link @click="acknowledge">已核对，继续操作</el-button></template></el-alert>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="load">重新读取列表</el-button></template></el-alert>
        <div class="table-scroll"><el-table :data="rows" v-loading="loading" row-key="id" border :empty-text="loading ? '正在加载…' : '暂无活动背景'">
          <el-table-column prop="id" label="ID" width="75" /><el-table-column prop="name" label="活动名称" min-width="160" />
          <el-table-column label="活动时间" min-width="260"><template #default="{ row }">{{ row.start_time }}<br />至 {{ row.stop_time }}</template></el-table-column>
          <el-table-column prop="product_count" label="参与商品数" width="110" />
          <el-table-column label="活动阶段" width="100"><template #default="{ row }"><el-tag :type="phaseTag(row.start_status)">{{ phaseName(row.start_status) }}</el-tag></template></el-table-column>
          <el-table-column label="是否开启" width="115"><template #default="{ row }"><el-switch v-if="canManage" :model-value="row.status" :active-value="1" :inactive-value="0" inline-prompt active-text="开启" inactive-text="关闭" :disabled="loading || mutating || confirming || !!notice" :aria-label="`活动背景 ${row.id} 开启状态`" @change="toggle(row)" /><el-tag v-else :type="row.status ? 'success' : 'info'">{{ row.status ? '开启' : '关闭' }}</el-tag></template></el-table-column>
          <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ displayTime(row.add_time) }}</template></el-table-column>
          <el-table-column v-if="canManage" label="操作" width="145" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="loading || mutating || confirming || !!notice" @click="edit(row)">编辑</el-button><el-button link type="danger" :disabled="loading || mutating || confirming || !!notice" @click="remove(row)">删除</el-button></template></el-table-column>
        </el-table></div>
        <el-pagination :current-page="applied.page" :page-size="applied.limit" :total="count" layout="total, prev, pager, next, jumper" :disabled="loading || mutating || confirming" @current-change="pageChange" class="pagination" />
      </el-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiActivityBackgroundList, apiActivityBackgroundStatus, apiActivityBackgroundDelete, activityBackgroundRangeQuery, type ActivityBackgroundRow, type ActivityBackgroundListQuery, type ActivityBackgroundPhase } from '@/api/activityBackground';

const router = useRouter(), auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('activity_background.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('activity_background.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const filters = reactive<{ name: string; status: '' | ActivityBackgroundPhase }>({ name: '', status: '' });
const activityTime = ref<string[] | null>(null), createdTime = ref<string[] | null>(null);
const applied = ref<ActivityBackgroundListQuery>({ page: 1, limit: 15 });
const rows = ref<ActivityBackgroundRow[]>([]), count = ref(0), loading = ref(false), mutating = ref(false), confirming = ref(false), error = ref(''), notice = ref('');
let alive = false, syncing = false, epoch = 0, confirmId = 0, mutationId = 0, listAbort: AbortController | null = null, mutationAbort: AbortController | null = null;
let storedSession = localStorage.getItem('admin_session');
type Stamp = { epoch: number; session: string; stored: string | null };
function stamp(): Stamp { return { epoch, session: sessionKey.value, stored: storedSession }; }
function current(value: Stamp) { return alive && canView.value && auth.token === getToken() && value.epoch === epoch && value.session === sessionKey.value && value.stored === storedSession && value.stored === localStorage.getItem('admin_session'); }
function clear() { epoch++; listAbort?.abort(); mutationAbort?.abort(); listAbort = mutationAbort = null; confirmId++; if (confirming.value) ElMessageBox.close(); rows.value = []; count.value = 0; loading.value = mutating.value = confirming.value = false; error.value = notice.value = ''; }
function phaseName(value: ActivityBackgroundPhase) { return value === 0 ? '未开始' : value === 1 ? '进行中' : '已结束'; }
function phaseTag(value: ActivityBackgroundPhase): 'danger' | 'success' | 'info' { return value === 0 ? 'danger' : value === 1 ? 'success' : 'info'; }
function displayTime(value: string | number) { if (typeof value === 'string') return value; return new Date(value * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }
function currentRow(row: ActivityBackgroundRow) { return rows.value.some(item => item.id === row.id && item.revision === row.revision); }
function actionable(row: ActivityBackgroundRow) { return current(stamp()) && canManage.value && !loading.value && !mutating.value && !confirming.value && !notice.value && currentRow(row); }
async function load() {
  if (!alive || !canView.value || auth.token !== getToken() || storedSession !== localStorage.getItem('admin_session')) return;
  listAbort?.abort(); const value = stamp(), controller = new AbortController(); listAbort = controller; loading.value = true; error.value = ''; rows.value = []; count.value = 0;
  try { const result = await apiActivityBackgroundList({ ...applied.value }, controller.signal); if (current(value) && listAbort === controller) { rows.value = result.list; count.value = result.count; } }
  catch (reason) { if (current(value) && listAbort === controller) error.value = reason instanceof Error ? reason.message : '活动背景列表读取失败'; }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search() {
  if (!current(stamp()) || loading.value || mutating.value || confirming.value) return;
  try { applied.value = { page: 1, limit: 15, name: filters.name.trim(), status: filters.status, time: activityBackgroundRangeQuery(activityTime.value), create_time: activityBackgroundRangeQuery(createdTime.value) }; void load(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '时间范围无效'; }
}
function reset() { if (!current(stamp()) || mutating.value || confirming.value) return; filters.name = ''; filters.status = ''; activityTime.value = createdTime.value = null; applied.value = { page: 1, limit: 15 }; void load(); }
function pageChange(page: number) { if (!current(stamp()) || loading.value || mutating.value || confirming.value || !Number.isSafeInteger(page) || page < 1) return; applied.value = { ...applied.value, page }; void load(); }
function create() { if (current(stamp()) && canManage.value && !mutating.value && !confirming.value) void router.push('/marketing/activity-background/create/0'); }
function edit(row: ActivityBackgroundRow) { if (actionable(row)) void router.push(`/marketing/activity-background/create/${row.id}`); }
function acknowledge() { if (!loading.value && !mutating.value) notice.value = ''; }
async function mutate(row: ActivityBackgroundRow, kind: 'status' | 'delete', value: Stamp) {
  if (!current(value) || !canManage.value || !currentRow(row) || mutating.value) return;
  const id = ++mutationId, controller = new AbortController(); mutationAbort = controller; mutating.value = true;
  try {
    const body = { request_id: crypto.randomUUID(), revision: row.revision };
    if (kind === 'status') await apiActivityBackgroundStatus(row.id, { ...body, status: row.status === 1 ? 0 : 1 }, controller.signal);
    else await apiActivityBackgroundDelete(row.id, body, controller.signal);
    if (current(value) && id === mutationId) ElMessage.success(kind === 'status' ? '状态已更新' : '活动背景已删除');
  } catch (reason) {
    if (!current(value) || id !== mutationId) return;
    const rejected = reason instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(reason.status));
    notice.value = `${rejected ? '操作未完成' : '操作结果未确认'}：${reason instanceof Error ? reason.message : '请求失败'}。请重新读取核对后再操作。`;
  } finally { if (id === mutationId) { mutationAbort = null; mutating.value = false; } }
  if (current(value)) await load();
}
async function confirm(row: ActivityBackgroundRow, kind: 'status' | 'delete') {
  if (!actionable(row)) return;
  const value = stamp(), id = ++confirmId; confirming.value = true;
  try { await ElMessageBox.confirm(kind === 'delete' ? `确认删除活动背景“${row.name}”？` : `确认${row.status === 1 ? '关闭' : '开启'}活动背景“${row.name}”？`, kind === 'delete' ? '删除活动背景' : '更新活动背景状态', { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' }); }
  catch { return; } finally { if (id === confirmId) confirming.value = false; }
  if (id !== confirmId || !current(value) || !canManage.value || !currentRow(row)) return;
  await mutate(row, kind, value);
}
function toggle(row: ActivityBackgroundRow) { return confirm(row, 'status'); }
function remove(row: ActivityBackgroundRow) { return confirm(row, 'delete'); }
function syncSession() { syncing = true; clear(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); storedSession = localStorage.getItem('admin_session'); syncing = false; void load(); }
function storage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(sessionKey, () => { if (alive && !syncing) { clear(); void load(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', storage); window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener('storage', storage); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); });
</script>

<style scoped>
.activity-background-list { min-width: 0; }.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }.heading h2 { font-size: 18px; margin: 0 0 7px; }.hint { color: #737985; font-size: 12px; line-height: 1.6; margin: 0; }.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }.filters :deep(.el-input) { width: 190px; }.filters :deep(.el-select) { width: 145px; }.filters :deep(.el-date-editor) { width: 340px; }.results { margin-top: 16px; }.results .heading { margin-bottom: 0; }.notice { margin-bottom: 12px; }.table-scroll { overflow-x: auto; }.pagination { display: flex; justify-content: flex-end; margin-top: 16px; }
@media (max-width: 700px) { .filters :deep(.el-input), .filters :deep(.el-select), .filters :deep(.el-date-editor) { width: 100%; }.pagination { justify-content: center; } }
</style>
