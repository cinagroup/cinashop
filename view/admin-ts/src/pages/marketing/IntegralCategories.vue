<template>
  <div class="integral-categories">
    <div class="heading">
      <div><h2>积分分类</h2><p class="hint">按积分范围管理商城筛选分类，排序值较大的分类优先显示。</p></div>
      <div class="actions">
        <el-button v-if="canView" :loading="loading" :disabled="submitting || confirming" @click="load()">刷新</el-button>
        <el-button v-if="canManage" type="primary" :disabled="loading || submitting || confirming" @click="openForm(0)">添加积分分类</el-button>
      </div>
    </div>
    <el-alert v-if="!canView" title="当前账号没有积分分类查看权限" type="warning" :closable="false" show-icon />
    <el-card v-else shadow="never">
      <div class="filters">
        <label class="filter-field"><span>分类名称</span>
          <el-input v-model="draftName" aria-label="积分分类搜索" maxlength="100" clearable placeholder="分类名称 / ID" :disabled="submitting" @keyup.enter="search" />
        </label>
        <label class="filter-field status-field"><span>分类状态</span>
          <el-select v-model="draftShow" aria-label="积分分类状态" placeholder="全部状态" :disabled="submitting">
            <el-option label="全部状态" value="" /><el-option label="显示" :value="1" /><el-option label="隐藏" :value="0" />
          </el-select>
        </label>
        <div class="actions"><el-button type="primary" :disabled="submitting" @click="search">查询</el-button><el-button :disabled="submitting" @click="reset">重置</el-button></div>
      </div>
      <el-alert v-if="actionNotice" :title="actionNotice" type="warning" :closable="false" show-icon class="notice" />
      <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice">
        <template #default><el-button link type="primary" @click="load()">重新读取分类</el-button></template>
      </el-alert>
      <div v-else class="table-scroll">
        <p v-if="compactTable" class="hint">左右滑动表格可查看积分范围、状态和操作。</p>
        <el-table :data="list" v-loading="loading" border row-key="id" :empty-text="loading ? '加载中…' : '暂无积分分类'">
          <el-table-column prop="id" label="ID" width="75" />
          <el-table-column prop="name" label="分类名称" min-width="170" />
          <el-table-column label="积分范围" min-width="175"><template #default="{ row }">{{ row.integral_min }} – {{ row.integral_max }}</template></el-table-column>
          <el-table-column label="状态" min-width="130">
            <template #default="{ row }">
              <el-switch v-if="canManage" :model-value="row.is_show" :active-value="1" :inactive-value="0" inline-prompt active-text="显示" inactive-text="隐藏"
                :aria-label="`${row.name}显示状态`" :disabled="submitting || confirming" @change="toggleVisibility(row)" />
              <el-tag v-else :type="row.is_show === 1 ? 'success' : 'info'">{{ row.is_show === 1 ? '显示' : '隐藏' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="sort" label="排序" min-width="90" />
          <el-table-column v-if="canManage" label="操作" width="145" :fixed="compactTable ? false : 'right'">
            <template #default="{ row }"><el-button link type="primary" :disabled="submitting || confirming" @click="openForm(row.id)">编辑</el-button><el-button link type="danger" :disabled="submitting || confirming" @click="remove(row)">删除</el-button></template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination v-if="!loading && !listError" :current-page="page" :page-size="PAGE_SIZE" :total="count"
        :page-count="Math.min(Math.max(1, Math.ceil(count / PAGE_SIZE)), MAX_PAGE)" :pager-count="5" :disabled="submitting || confirming"
        layout="total, prev, pager, next" class="pager" @current-change="load" />
      <p v-if="count > MAX_PAGE * PAGE_SIZE" class="hint">可浏览前 {{ MAX_PAGE * PAGE_SIZE }} 项，请按名称或状态缩小范围。</p>
    </el-card>

    <el-dialog v-model="formVisible" :title="formId ? '编辑积分分类' : '添加积分分类'" width="min(500px, calc(100vw - 24px))"
      :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" @closed="onFormClosed">
      <div v-loading="formLoading">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon class="notice">
          <template v-if="!form" #default><el-button link type="primary" @click="openForm(formId)">重新读取表单</el-button></template>
        </el-alert>
        <el-form v-if="form" label-position="top" :disabled="submitting">
          <el-form-item label="分类名称" required><el-input v-model="form.name" aria-label="分类名称" maxlength="30" show-word-limit /></el-form-item>
          <div class="range-fields">
            <el-form-item label="最低积分" required><el-input-number v-model="form.integral_min" aria-label="最低积分" :min="0" :max="MAX_INT" :precision="0" :step="1" :controls="false" /></el-form-item>
            <el-form-item label="最高积分" required><el-input-number v-model="form.integral_max" aria-label="最高积分" :min="0" :max="MAX_INT" :precision="0" :step="1" :controls="false" /></el-form-item>
          </div>
          <p class="hint form-hint">最低积分必须小于最高积分；分类名称不能重复，积分范围不能与其他分类重叠。</p>
          <el-form-item label="状态"><el-radio-group v-model="form.is_show" aria-label="分类显示状态"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="form.sort" aria-label="分类排序" :min="0" :max="MAX_INT" :precision="0" :step="1" :controls="false" /></el-form-item>
        </el-form>
      </div>
      <template #footer><el-button :disabled="submitting" @click="formVisible = false">取消</el-button><el-button v-if="canManage" type="primary" :loading="submitting" :disabled="!form || formLoading" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiIntegralCategoryList, apiIntegralCategoryDetail, apiIntegralCategorySave, apiIntegralCategoryStatus, apiIntegralCategoryDelete,
  type IntegralCategory, type IntegralCategoryInput, type IntegralCategoryMutationKey, type IntegralCategorySave } from '@/api/integralCategory';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('integral_category.view')));
const canManage = computed(() => canView.value && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('integral_category.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const PAGE_SIZE = 15, MAX_PAGE = Math.floor(10_000 / PAGE_SIZE) + 1, MAX_INT = 2_147_483_647;
const compactTable = ref(window.innerWidth <= 768);
const updateTableWidth = () => { compactTable.value = window.innerWidth <= 768; };
const draftName = ref(''), name = ref('');
const draftShow = ref<'' | 0 | 1>(''), isShow = ref<'' | 0 | 1>('');
const list = ref<IntegralCategory[]>([]), count = ref(0), page = ref(1), loading = ref(false);
const listError = ref(''), actionNotice = ref('');
const submitting = ref(false), confirming = ref(false);
const formVisible = ref(false), formLoading = ref(false), formError = ref(''), formId = ref(0);
const form = ref<(IntegralCategoryInput & { revision: string }) | null>(null);
interface OperationScope { session: string; generation: number; storedSession: string | null }
type Mutation = { kind: 'save'; id: number; body: IntegralCategorySave }
  | { kind: 'status'; id: number; body: IntegralCategoryMutationKey & { is_show: 0 | 1 } }
  | { kind: 'delete'; id: number; body: IntegralCategoryMutationKey };
const uncertainOperation = ref<Mutation | null>(null);
let mounted = false, syncing = false, generation = 0, confirmationId = 0, mutationId = 0, formGeneration = 0;
let storedSession = localStorage.getItem('admin_session');
let listAbort: AbortController | null = null, formAbort: AbortController | null = null, mutationAbort: AbortController | null = null;
let formScope: OperationScope | null = null;

function scope(): OperationScope { return { session: sessionKey.value, generation, storedSession }; }
function current(stamp: OperationScope) {
  return mounted && canView.value && stamp.generation === generation && stamp.session === sessionKey.value &&
    auth.token === getToken() && stamp.storedSession === localStorage.getItem('admin_session');
}
function currentRow(row: IntegralCategory) { return list.value.some(item => item.id === row.id && item.revision === row.revision); }
function actionable() { return current(scope()) && canManage.value && !loading.value && !submitting.value && !confirming.value; }
function closeForm() {
  formGeneration++; formAbort?.abort(); formAbort = null;
  formVisible.value = false; formLoading.value = false; form.value = null; formScope = null; formError.value = '';
}
function onFormClosed() { if (!formVisible.value) closeForm(); }
function clearList() {
  generation++; listAbort?.abort(); listAbort = null;
  list.value = []; count.value = 0; listError.value = ''; loading.value = false;
  closeForm();
}
function invalidate() {
  clearList(); mutationId++; mutationAbort?.abort(); mutationAbort = null;
  confirmationId++; if (confirming.value) ElMessageBox.close();
  confirming.value = false; submitting.value = false; actionNotice.value = ''; uncertainOperation.value = null;
}
async function load(targetPage = page.value) {
  if (!mounted || !canView.value || auth.token !== getToken() || storedSession !== localStorage.getItem('admin_session')) return;
  if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > MAX_PAGE) return;
  clearList(); page.value = targetPage;
  const stamp = scope(), controller = new AbortController();
  listAbort = controller; loading.value = true;
  try {
    const result = await apiIntegralCategoryList({ page: targetPage, limit: PAGE_SIZE, name: name.value, is_show: isShow.value }, controller.signal);
    if (!current(stamp)) return;
    if (!result.list.length && targetPage > 1) {
      await load(Math.max(1, Math.min(targetPage - 1, Math.ceil(result.count / PAGE_SIZE))));
      return;
    }
    list.value = result.list; count.value = result.count;
  } catch (error) {
    if (current(stamp)) listError.value = error instanceof Error ? error.message : '积分分类加载失败';
  } finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search() {
  if (submitting.value) return;
  name.value = draftName.value.trim(); isShow.value = draftShow.value;
  actionNotice.value = ''; void load(1);
}
function reset() { if (!submitting.value) { draftName.value = ''; draftShow.value = ''; search(); } }

async function openForm(id: number) {
  if (!actionable() || (id !== 0 && !list.value.some(row => row.id === id))) return;
  closeForm();
  formId.value = id; formVisible.value = true; formLoading.value = true;
  const stamp = scope(), version = formGeneration, controller = new AbortController();
  formScope = stamp; formAbort = controller;
  try {
    const result = id === 0 ? { name: '', integral_min: 0, integral_max: 0, is_show: 1 as const, sort: 0, revision: '' }
      : await apiIntegralCategoryDetail(id, controller.signal);
    if (!current(stamp) || !canManage.value || version !== formGeneration || !formVisible.value) return;
    form.value = { name: result.name, integral_min: result.integral_min, integral_max: result.integral_max,
      is_show: result.is_show, sort: result.sort, revision: result.revision };
  } catch (error) {
    if (current(stamp) && version === formGeneration) formError.value = error instanceof Error ? error.message : '分类详情加载失败';
  } finally { if (formAbort === controller) { formAbort = null; formLoading.value = false; } }
}
async function mutate(operation: Mutation, stamp: OperationScope, editorVersion?: number) {
  const stillCurrent = () => current(stamp) && canManage.value && (editorVersion === undefined || editorVersion === formGeneration);
  if (!stillCurrent() || submitting.value) return;
  const requestId = ++mutationId, controller = new AbortController();
  mutationAbort = controller; submitting.value = true; actionNotice.value = '';
  try {
    if (operation.kind === 'save') await apiIntegralCategorySave(operation.id, operation.body, controller.signal);
    else if (operation.kind === 'status') await apiIntegralCategoryStatus(operation.id, operation.body, controller.signal);
    else await apiIntegralCategoryDelete(operation.id, operation.body, controller.signal);
    if (!stillCurrent() || requestId !== mutationId) return;
    uncertainOperation.value = null;
    ElMessage.success(operation.kind === 'delete' ? '积分分类已删除' : operation.kind === 'status' ? '显示状态已更新' : '积分分类已保存');
  } catch (error) {
    if (!stillCurrent() || requestId !== mutationId) return;
    const rejected = error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status));
    // Preserve the exact key and body for an ambiguous result; only issue reads to reconcile it.
    uncertainOperation.value = rejected ? null : operation;
    actionNotice.value = `${rejected ? '操作未完成' : '操作结果未确认'}：${error instanceof Error ? error.message : '请求失败'}。请核对重新读取的分类后再操作。`;
  } finally { if (requestId === mutationId) { submitting.value = false; mutationAbort = null; } }
  if (stillCurrent()) await load();
}
async function save() {
  if (!form.value || !formScope || !formVisible.value || !current(formScope) || !canManage.value || submitting.value || formLoading.value) return;
  const value = { ...form.value, name: form.value.name.trim() };
  if (!value.name || Array.from(value.name).length > 30 || /[\u0000-\u001f\u007f]/u.test(value.name)) { formError.value = '请填写 1–30 字的分类名称'; return; }
  if (![value.integral_min, value.integral_max, value.sort].every(item => Number.isSafeInteger(item) && item >= 0 && item <= MAX_INT) || ![0, 1].includes(value.is_show)) {
    formError.value = '积分和排序须为 0–2147483647 的整数，状态须为显示或隐藏'; return;
  }
  if (value.integral_min >= value.integral_max) { formError.value = '最低积分必须小于最高积分'; return; }
  formError.value = '';
  const body: IntegralCategorySave = { name: value.name, integral_min: value.integral_min, integral_max: value.integral_max,
    is_show: value.is_show, sort: value.sort, request_id: crypto.randomUUID(), ...(formId.value ? { revision: value.revision } : {}) };
  await mutate({ kind: 'save', id: formId.value, body }, formScope, formGeneration);
}
async function confirmAction(row: IntegralCategory, action: 'status' | 'delete') {
  if (!actionable() || !currentRow(row)) return;
  row = { ...row };
  const stamp = scope(), requestId = ++confirmationId;
  confirming.value = true;
  try {
    await ElMessageBox.confirm(action === 'delete' ? `确认删除积分分类「${row.name}」？删除仅移除该范围分类，不会删除积分商品。`
      : `确认${row.is_show === 1 ? '隐藏' : '显示'}积分分类「${row.name}」？`, action === 'delete' ? '删除积分分类' : '更新显示状态',
    { type: 'warning', confirmButtonText: action === 'delete' ? '确认删除' : '确认', cancelButtonText: '取消' });
  } catch { return; }
  finally { if (requestId === confirmationId) confirming.value = false; }
  if (requestId !== confirmationId || !current(stamp) || !canManage.value || !currentRow(row)) return;
  const body = { revision: row.revision, request_id: crypto.randomUUID() };
  await mutate(action === 'delete' ? { kind: 'delete', id: row.id, body }
    : { kind: 'status', id: row.id, body: { ...body, is_show: row.is_show === 1 ? 0 : 1 } }, stamp);
}
function remove(row: IntegralCategory) { return confirmAction(row, 'delete'); }
function toggleVisibility(row: IntegralCategory) { return confirmAction(row, 'status'); }
function syncSession() {
  syncing = true; invalidate();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  storedSession = localStorage.getItem('admin_session'); syncing = false;
  page.value = 1; draftName.value = ''; name.value = ''; draftShow.value = ''; isShow.value = '';
  void load(1);
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(sessionKey, () => { if (mounted && !syncing) { invalidate(); page.value = 1; void load(1); } }, { flush: 'sync' });
onMounted(() => {
  mounted = true;
  window.addEventListener('resize', updateTableWidth);
  window.addEventListener('admin-session-changed', syncSession);
  window.addEventListener('admin-auth-expired', syncSession);
  window.addEventListener('storage', syncStorage);
  syncSession();
});
onBeforeUnmount(() => {
  mounted = false; invalidate();
  window.removeEventListener('resize', updateTableWidth);
  window.removeEventListener('admin-session-changed', syncSession);
  window.removeEventListener('admin-auth-expired', syncSession);
  window.removeEventListener('storage', syncStorage);
});
</script>

<style scoped>
.integral-categories { min-width: 0; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.heading h2 { font-size: 18px; margin: 0 0 8px; }
.hint { color: #737985; font-size: 12px; margin: 5px 0; line-height: 1.6; }
.filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 18px; }
.filter-field { display: flex; flex: 1 1 240px; min-width: 0; flex-direction: column; gap: 6px; font-size: 13px; }
.status-field { flex: 0 1 160px; }
.filter-field :deep(.el-input), .filter-field :deep(.el-select) { width: 100%; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions :deep(.el-button + .el-button) { margin-left: 0; }
.notice { margin-bottom: 14px; }
.table-scroll { width: 100%; max-width: 100%; overflow-x: auto; }
.pager { margin-top: 18px; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.range-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.range-fields :deep(.el-input-number) { width: 100%; }
.form-hint { margin: 0 0 18px; }
@media (max-width: 600px) {
  .filters { display: grid; grid-template-columns: minmax(0, 1fr); }
  .pager { justify-content: center; }
  .pager :deep(.el-pagination__total) { width: 100%; text-align: center; margin-right: 0; }
}
</style>
