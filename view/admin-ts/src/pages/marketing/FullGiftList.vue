<template>
  <div class="full-gifts-list">
    <header class="heading"><div><h2>满送活动</h2><p class="hint">按活动名称、条件类型与启停状态查询；订单统计来自活动支付记录。</p></div><el-button v-if="canView" :loading="loading" :disabled="mutating || confirming" @click="load">刷新</el-button></header>
    <el-alert v-if="!canView" title="当前账号没有满送活动查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-card shadow="never">
        <div class="filters">
          <el-input v-model="filters.name" aria-label="活动名称" placeholder="活动名称" maxlength="200" clearable @keyup.enter="search" />
          <el-select v-model="filters.status" aria-label="是否开启" placeholder="全部状态"><el-option label="全部状态" value="" /><el-option label="开启" :value="1" /><el-option label="关闭" :value="0" /></el-select>
          <el-select v-model="filters.threshold_type" aria-label="条件类型" placeholder="全部条件"><el-option label="全部条件" value="" /><el-option label="满 N 元" :value="1" /><el-option label="满 N 件" :value="2" /></el-select>
          <el-button type="primary" :disabled="mutating || confirming" @click="search">查询</el-button><el-button :disabled="mutating || confirming" @click="reset">重置</el-button>
        </div>
      </el-card>
      <el-card shadow="never" class="results">
        <template #header><div class="heading"><strong>满送活动列表</strong><el-button v-if="canManage" type="primary" :disabled="mutating || confirming" @click="create">添加满送活动</el-button></div></template>
        <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon class="notice"><template #default><el-button link @click="acknowledge">已核对，继续操作</el-button></template></el-alert>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="notice"><template #default><el-button link @click="load">重新读取列表</el-button></template></el-alert>
        <div class="table-scroll"><el-table :data="rows" v-loading="loading" row-key="id" border :empty-text="loading ? '正在加载…' : '暂无满送活动'">
          <el-table-column prop="id" label="ID" width="75" /><el-table-column prop="name" label="活动名称" min-width="160" />
          <el-table-column prop="product_count" label="参与商品数" width="110" />
          <el-table-column label="活动条件" width="110"><template #default="{ row }">{{ row.threshold_type === 1 ? '满 N 元' : '满 N 件' }}</template></el-table-column>
          <el-table-column prop="desc" label="活动详情" min-width="210" show-overflow-tooltip />
          <el-table-column prop="sum_pay_price" label="订单实付金额（元）" min-width="145" />
          <el-table-column prop="sum_order" label="支付订单" width="95" />
          <el-table-column prop="sum_user" label="参与客户" width="95" />
          <el-table-column prop="old_user" label="老成交用户数" width="120" />
          <el-table-column prop="new_user" label="新成交用户数" width="120" />
          <el-table-column label="是否开启" width="115"><template #default="{ row }"><el-switch v-if="canManage" :model-value="row.status" :active-value="1" :inactive-value="0" inline-prompt active-text="开启" inactive-text="关闭" :disabled="loading || mutating || confirming || !!notice" :aria-label="`满送活动 ${row.id} 开启状态`" @change="toggle(row)" /><el-tag v-else :type="row.status ? 'success' : 'info'">{{ row.status ? '开启' : '关闭' }}</el-tag></template></el-table-column>
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
import { apiFullGiftList, apiFullGiftStatus, apiFullGiftDelete, type FullGiftRow, type FullGiftListQuery } from '@/api/fullGift';

const router = useRouter(), auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('full_gift.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('full_gift.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const filters = reactive<{ name: string; status: '' | 0 | 1; threshold_type: '' | 1 | 2 }>({ name: '', status: '', threshold_type: '' });
const applied = ref<FullGiftListQuery>({ page: 1, limit: 15 });
const rows = ref<FullGiftRow[]>([]), count = ref(0), loading = ref(false), mutating = ref(false), confirming = ref(false), error = ref(''), notice = ref('');
let alive = false, syncing = false, epoch = 0, confirmId = 0, mutationId = 0, listAbort: AbortController | null = null, mutationAbort: AbortController | null = null;
let storedSession = localStorage.getItem('admin_session');
type Stamp = { epoch: number; session: string; stored: string | null };
function stamp(): Stamp { return { epoch, session: sessionKey.value, stored: storedSession }; }
function current(value: Stamp) { return alive && canView.value && auth.token === getToken() && value.epoch === epoch && value.session === sessionKey.value && value.stored === storedSession && value.stored === localStorage.getItem('admin_session'); }
function clear() { epoch++; listAbort?.abort(); mutationAbort?.abort(); listAbort = mutationAbort = null; confirmId++; if (confirming.value) ElMessageBox.close(); rows.value = []; count.value = 0; loading.value = mutating.value = confirming.value = false; error.value = notice.value = ''; }
function currentRow(row: FullGiftRow) { return rows.value.some(item => item.id === row.id && item.revision === row.revision); }
function actionable(row: FullGiftRow) { return current(stamp()) && canManage.value && !loading.value && !mutating.value && !confirming.value && !notice.value && currentRow(row); }
async function load() {
  if (!alive || !canView.value || auth.token !== getToken() || storedSession !== localStorage.getItem('admin_session')) return;
  listAbort?.abort(); const value = stamp(), controller = new AbortController(); listAbort = controller; loading.value = true; error.value = ''; rows.value = []; count.value = 0;
  try { const result = await apiFullGiftList({ ...applied.value }, controller.signal); if (current(value) && listAbort === controller) { rows.value = result.list; count.value = result.count; } }
  catch (reason) { if (current(value) && listAbort === controller) error.value = reason instanceof Error ? reason.message : '满送活动列表读取失败'; }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search() {
  if (!current(stamp()) || loading.value || mutating.value || confirming.value) return;
  applied.value = { page: 1, limit: 15, name: filters.name.trim(), status: filters.status, threshold_type: filters.threshold_type }; void load();
}
function reset() { if (!current(stamp()) || mutating.value || confirming.value) return; filters.name = ''; filters.status = ''; filters.threshold_type = ''; applied.value = { page: 1, limit: 15 }; void load(); }
function pageChange(page: number) { if (!current(stamp()) || loading.value || mutating.value || confirming.value || !Number.isSafeInteger(page) || page < 1) return; applied.value = { ...applied.value, page }; void load(); }
function create() { if (current(stamp()) && canManage.value && !mutating.value && !confirming.value) void router.push('/marketing/full-gifts/create/0'); }
function edit(row: FullGiftRow) { if (actionable(row)) void router.push(`/marketing/full-gifts/create/${row.id}`); }
function acknowledge() { if (!loading.value && !mutating.value) notice.value = ''; }
async function mutate(row: FullGiftRow, kind: 'status' | 'delete', value: Stamp) {
  if (!current(value) || !canManage.value || !currentRow(row) || mutating.value) return;
  const id = ++mutationId, controller = new AbortController(); mutationAbort = controller; mutating.value = true;
  try {
    const body = { request_id: crypto.randomUUID(), revision: row.revision };
    if (kind === 'status') await apiFullGiftStatus(row.id, { ...body, status: row.status === 1 ? 0 : 1 }, controller.signal);
    else await apiFullGiftDelete(row.id, body, controller.signal);
    if (current(value) && id === mutationId) ElMessage.success(kind === 'status' ? '状态已更新' : '满送活动已删除');
  } catch (reason) {
    if (!current(value) || id !== mutationId) return;
    const rejected = reason instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(reason.status));
    notice.value = `${rejected ? '操作未完成' : '操作结果未确认'}：${reason instanceof Error ? reason.message : '请求失败'}。请重新读取核对后再操作。`;
  } finally { if (id === mutationId) { mutationAbort = null; mutating.value = false; } }
  if (current(value)) await load();
}
async function confirm(row: FullGiftRow, kind: 'status' | 'delete') {
  if (!actionable(row)) return;
  const value = stamp(), id = ++confirmId; confirming.value = true;
  try { await ElMessageBox.confirm(kind === 'delete' ? `确认删除满送活动“${row.name}”？` : `确认${row.status === 1 ? '关闭' : '开启'}满送活动“${row.name}”？`, kind === 'delete' ? '删除满送活动' : '更新满送活动状态', { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' }); }
  catch { return; } finally { if (id === confirmId) confirming.value = false; }
  if (id !== confirmId || !current(value) || !canManage.value || !currentRow(row)) return;
  await mutate(row, kind, value);
}
function toggle(row: FullGiftRow) { return confirm(row, 'status'); }
function remove(row: FullGiftRow) { return confirm(row, 'delete'); }
function syncSession() { syncing = true; clear(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); storedSession = localStorage.getItem('admin_session'); syncing = false; void load(); }
function storage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(sessionKey, () => { if (alive && !syncing) { clear(); void load(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', storage); window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); syncSession(); });
onBeforeUnmount(() => { alive = false; clear(); window.removeEventListener('storage', storage); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); });
</script>

<style scoped>
.full-gifts-list { min-width: 0; }.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }.heading h2 { font-size: 18px; margin: 0 0 7px; }.hint { color: #737985; font-size: 12px; line-height: 1.6; margin: 0; }.filters { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }.filters :deep(.el-input) { width: 190px; }.filters :deep(.el-select) { width: 145px; }.filters :deep(.el-date-editor) { width: 340px; }.results { margin-top: 16px; }.results .heading { margin-bottom: 0; }.notice { margin-bottom: 12px; }.table-scroll { overflow-x: auto; }.pagination { display: flex; justify-content: flex-end; margin-top: 16px; }
@media (max-width: 700px) { .filters :deep(.el-input), .filters :deep(.el-select), .filters :deep(.el-date-editor) { width: 100%; }.pagination { justify-content: center; } }
</style>

