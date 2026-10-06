<template>
  <div class="recharge-options">
    <div class="heading">
      <div><h2>充值金额档位</h2><p class="hint">调整或删除档位只影响后续新充值订单，既有订单仍按原金额及赠送快照结算。</p></div>
      <el-button v-if="canView" :loading="loading" :disabled="submitting || confirming" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="!canView" title="当前账号没有充值档位查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="actionNotice" :title="actionNotice" type="warning" :closable="false" show-icon class="notice" />
      <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice">
        <template #default><el-button link type="primary" @click="load">重新读取档位</el-button></template>
      </el-alert>
      <div class="content-grid">
        <el-card shadow="never" class="preview-card">
          <template #header><strong>启用档位预览</strong></template>
          <p class="hint">显示全部已保存、启用且金额有效的档位，仅供核对，不会发起充值。</p>
          <div v-if="loading" class="preview-placeholder">正在读取档位…</div>
          <div v-else-if="listError" class="preview-placeholder">读取失败，暂不可预览</div>
          <template v-else>
            <div v-if="previewRows.length" class="preview-options">
              <div v-for="item in previewRows" :key="item.id" class="preview-option">
                <div class="preview-price">{{ item.price }}<span> 元</span></div>
                <div class="preview-gift">赠送 {{ item.give_money }} 元</div>
              </div>
            </div>
            <el-empty v-else description="暂无启用的有效档位" :image-size="64" />
            <p class="hint preview-note">自定义金额、充值须知及支付方式以商城实际充值设置为准。</p>
          </template>
        </el-card>
        <el-card shadow="never" class="list-card">
          <template #header><div class="card-heading"><strong>充值金额设置</strong><el-button v-if="canManage" type="primary" :disabled="!loaded || count >= MAX_OPTIONS || submitting || confirming" @click="openForm(0)">添加档位</el-button></div></template>
          <p class="hint">{{ loading ? '正在读取档位' : listError ? '档位数量未确认' : `共 ${count} 个档位` }} · 最多 {{ MAX_OPTIONS }} 个，包含隐藏档位。排序值越大越靠前。</p>
          <el-alert v-if="loaded && count >= MAX_OPTIONS" :title="count > MAX_OPTIONS ? '历史档位已超过上限，可继续编辑、隐藏或删除；减少到 20 条以下后可新增。' : '已达到 20 个档位上限，可继续编辑、隐藏或删除。'" type="info" :closable="false" class="notice limit-note" />
          <el-alert v-if="invalidCount" :title="`有 ${invalidCount} 个档位金额无效，请编辑修复；无效档位不会进入预览且不可直接启用。`" type="warning" :closable="false" class="notice" />
          <div v-if="!listError" class="table-scroll">
            <p v-if="compactTable" class="hint">左右滑动表格可查看金额、状态和操作。</p>
            <el-table :data="list" v-loading="loading" border row-key="id" :empty-text="loading ? '加载中…' : '暂无充值档位'">
              <el-table-column prop="id" label="编号" width="64" />
              <el-table-column label="充值金额（元）" min-width="135"><template #default="{ row }"><span v-if="row.valid">{{ row.price }}</span><el-tag v-else type="danger">金额无效</el-tag></template></el-table-column>
              <el-table-column label="赠送金额（元）" min-width="135"><template #default="{ row }">{{ row.valid ? row.give_money : '待修复' }}</template></el-table-column>
              <el-table-column label="状态" min-width="100"><template #default="{ row }">
                <el-switch v-if="canManage" :model-value="row.status" :active-value="1" :inactive-value="0" inline-prompt active-text="显示" inactive-text="隐藏"
                  :aria-label="`档位${row.id}显示状态`" :disabled="submitting || confirming || (!row.valid && row.status === 0)" @change="toggleVisibility(row)" />
                <el-tag v-else :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '显示' : '隐藏' }}</el-tag>
              </template></el-table-column>
              <el-table-column prop="sort" label="排序" min-width="70" />
              <el-table-column v-if="canManage" label="操作" width="145" :fixed="compactTable ? false : 'right'"><template #default="{ row }">
                <el-button link type="primary" :disabled="submitting || confirming" @click="openForm(row.id)">编辑</el-button><el-button link type="danger" :disabled="submitting || confirming" @click="remove(row)">删除</el-button>
              </template></el-table-column>
            </el-table>
          </div>
        </el-card>
      </div>
    </template>

    <el-dialog v-model="formVisible" :title="formId ? '编辑充值档位' : '添加充值档位'" width="min(480px, calc(100vw - 24px))"
      :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" @closed="onFormClosed">
      <div v-loading="formLoading">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon class="notice">
          <template v-if="!form" #default><el-button link type="primary" @click="openForm(formId)">重新读取档位</el-button></template>
        </el-alert>
        <el-form v-if="form" label-position="top" :disabled="submitting">
          <el-form-item label="充值金额（元）" required><el-input v-model="form.price" aria-label="充值金额" inputmode="decimal" maxlength="11" placeholder="0.01–100000.00，最多两位小数" /></el-form-item>
          <el-form-item label="赠送金额（元）"><el-input v-model="form.give_money" aria-label="赠送金额" inputmode="decimal" maxlength="11" placeholder="默认 0.00，最多两位小数" /></el-form-item>
          <el-form-item label="排序"><el-input-number v-model="form.sort" aria-label="档位排序" :min="0" :max="MAX_INT" :precision="0" :step="1" :controls="false" /></el-form-item>
          <el-form-item label="状态"><el-radio-group v-model="form.status" aria-label="档位显示状态"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></el-form-item>
          <p class="hint">赠送金额可以为零。保存只改变后续新订单的档位，既有充值订单金额不变。</p>
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
import { apiRechargeQuotaList, apiRechargeQuotaDetail, apiRechargeQuotaSave, apiRechargeQuotaStatus, apiRechargeQuotaDelete, normalizeRechargeMoney,
  type RechargeQuota, type RechargeQuotaInput, type RechargeQuotaMutationKey, type RechargeQuotaSave } from '@/api/rechargeQuota';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('recharge_quota.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('recharge_quota.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const MAX_OPTIONS = 20, MAX_INT = 2_147_483_647;
const compactTable = ref(window.innerWidth <= 768);
const updateTableWidth = () => { compactTable.value = window.innerWidth <= 768; };
const list = ref<RechargeQuota[]>([]), count = ref(0), loading = ref(false), loaded = ref(false);
const previewRows = computed(() => list.value.filter(row => row.status === 1 && row.valid));
const invalidCount = computed(() => list.value.filter(row => !row.valid).length);
const listError = ref(''), actionNotice = ref(''), submitting = ref(false), confirming = ref(false);
const formVisible = ref(false), formLoading = ref(false), formError = ref(''), formId = ref(0);
const form = ref<(RechargeQuotaInput & { revision: string }) | null>(null);
interface OperationScope { session: string; generation: number; storedSession: string | null }
type Mutation = { kind: 'save'; id: number; body: RechargeQuotaSave }
  | { kind: 'status'; id: number; body: RechargeQuotaMutationKey & { status: 0 | 1 } }
  | { kind: 'delete'; id: number; body: RechargeQuotaMutationKey };
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
function currentRow(row: RechargeQuota) { return list.value.some(item => item.id === row.id && item.revision === row.revision); }
function actionable() { return current(scope()) && canManage.value && loaded.value && !loading.value && !submitting.value && !confirming.value; }
function closeForm() {
  formGeneration++; formAbort?.abort(); formAbort = null;
  formVisible.value = false; formLoading.value = false; form.value = null; formScope = null; formError.value = '';
}
function onFormClosed() { if (!formVisible.value) closeForm(); }
function clearList() {
  generation++; listAbort?.abort(); listAbort = null;
  list.value = []; count.value = 0; listError.value = ''; loading.value = false; loaded.value = false; closeForm();
}
function invalidate() {
  clearList(); mutationId++; mutationAbort?.abort(); mutationAbort = null;
  confirmationId++; if (confirming.value) ElMessageBox.close();
  confirming.value = false; submitting.value = false; actionNotice.value = ''; uncertainOperation.value = null;
}
async function load() {
  if (!mounted || !canView.value || auth.token !== getToken() || storedSession !== localStorage.getItem('admin_session')) return;
  clearList();
  const stamp = scope(), controller = new AbortController(); listAbort = controller; loading.value = true;
  try {
    const result = await apiRechargeQuotaList(controller.signal);
    if (!current(stamp)) return;
    list.value = result.list; count.value = result.count; loaded.value = true;
  } catch (error) { if (current(stamp)) listError.value = error instanceof Error ? error.message : '充值档位加载失败'; }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
async function openForm(id: number) {
  if (!actionable() || (id === 0 ? count.value >= MAX_OPTIONS : !list.value.some(row => row.id === id))) return;
  closeForm(); formId.value = id; formVisible.value = true; formLoading.value = true;
  const stamp = scope(), version = formGeneration, controller = new AbortController(); formScope = stamp; formAbort = controller;
  try {
    const result = id === 0 ? { price: '', give_money: '0.00', sort: 1, status: 1 as const, revision: '' } : await apiRechargeQuotaDetail(id, controller.signal);
    if (!current(stamp) || !canManage.value || version !== formGeneration || !formVisible.value) return;
    form.value = { price: result.price, give_money: result.give_money || '0.00', sort: result.sort, status: result.status, revision: result.revision };
  } catch (error) { if (current(stamp) && version === formGeneration) formError.value = error instanceof Error ? error.message : '充值档位详情加载失败'; }
  finally { if (formAbort === controller) { formAbort = null; formLoading.value = false; } }
}
async function mutate(operation: Mutation, stamp: OperationScope, editorVersion?: number) {
  const stillCurrent = () => current(stamp) && canManage.value && (editorVersion === undefined || editorVersion === formGeneration);
  if (!stillCurrent() || submitting.value) return;
  const requestId = ++mutationId, controller = new AbortController(); mutationAbort = controller; submitting.value = true; actionNotice.value = '';
  try {
    if (operation.kind === 'save') await apiRechargeQuotaSave(operation.id, operation.body, controller.signal);
    else if (operation.kind === 'status') await apiRechargeQuotaStatus(operation.id, operation.body, controller.signal);
    else await apiRechargeQuotaDelete(operation.id, operation.body, controller.signal);
    if (!stillCurrent() || requestId !== mutationId) return;
    uncertainOperation.value = null;
    ElMessage.success(operation.kind === 'delete' ? '充值档位已删除' : operation.kind === 'status' ? '显示状态已更新' : '充值档位已保存');
  } catch (error) {
    if (!stillCurrent() || requestId !== mutationId) return;
    const rejected = error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status));
    uncertainOperation.value = rejected ? null : operation;
    actionNotice.value = `${rejected ? '操作未完成' : '操作结果未确认'}：${error instanceof Error ? error.message : '请求失败'}。请核对重新读取的档位后再操作。`;
  } finally { if (requestId === mutationId) { submitting.value = false; mutationAbort = null; } }
  if (stillCurrent()) await load();
}
async function save() {
  if (!form.value || !formScope || !formVisible.value || !current(formScope) || !canManage.value || submitting.value || formLoading.value) return;
  if (formId.value === 0 && count.value >= MAX_OPTIONS) { formError.value = '最多可配置 20 个充值档位'; return; }
  const value = form.value;
  if (!Number.isSafeInteger(value.sort) || value.sort < 0 || value.sort > MAX_INT || ![0, 1].includes(value.status)) { formError.value = '排序须为非负整数，状态须为显示或隐藏'; return; }
  let body: RechargeQuotaSave;
  try {
    body = { price: normalizeRechargeMoney(value.price, 'price'), give_money: normalizeRechargeMoney(value.give_money, 'give_money'),
      sort: value.sort, status: value.status, request_id: crypto.randomUUID(), ...(formId.value ? { revision: value.revision } : {}) };
  } catch (error) { formError.value = error instanceof Error ? error.message : '请检查档位金额'; return; }
  formError.value = ''; await mutate({ kind: 'save', id: formId.value, body }, formScope, formGeneration);
}
async function confirmAction(row: RechargeQuota, action: 'status' | 'delete') {
  if (!actionable() || !currentRow(row)) return;
  if (action === 'status' && row.status === 0 && !row.valid) { actionNotice.value = '档位金额无效，请先编辑修复后再启用。'; return; }
  row = { ...row };
  const stamp = scope(), requestId = ++confirmationId; confirming.value = true;
  try {
    await ElMessageBox.confirm(action === 'delete' ? `确认删除编号 ${row.id} 的充值档位？删除只影响后续新订单，既有充值订单仍按原金额和赠送快照结算。`
      : `确认${row.status === 1 ? '隐藏' : '显示'}编号 ${row.id} 的充值档位？此操作只影响后续新充值订单。`, action === 'delete' ? '删除充值档位' : '更新显示状态',
      { type: 'warning', confirmButtonText: action === 'delete' ? '确认删除' : '确认', cancelButtonText: '取消' });
  } catch { return; } finally { if (requestId === confirmationId) confirming.value = false; }
  if (requestId !== confirmationId || !current(stamp) || !canManage.value || !currentRow(row)) return;
  const body = { revision: row.revision, request_id: crypto.randomUUID() };
  await mutate(action === 'delete' ? { kind: 'delete', id: row.id, body }
    : { kind: 'status', id: row.id, body: { ...body, status: row.status === 1 ? 0 : 1 } }, stamp);
}
function remove(row: RechargeQuota) { return confirmAction(row, 'delete'); }
function toggleVisibility(row: RechargeQuota) { return confirmAction(row, 'status'); }
function syncSession() {
  syncing = true; invalidate(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  storedSession = localStorage.getItem('admin_session'); syncing = false; void load();
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(sessionKey, () => { if (mounted && !syncing) { invalidate(); void load(); } }, { flush: 'sync' });
onMounted(() => {
  mounted = true; window.addEventListener('resize', updateTableWidth); window.addEventListener('admin-session-changed', syncSession);
  window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession();
});
onBeforeUnmount(() => {
  mounted = false; invalidate(); window.removeEventListener('resize', updateTableWidth); window.removeEventListener('admin-session-changed', syncSession);
  window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage);
});
</script>

<style scoped>
.recharge-options { min-width: 0; }
.heading, .card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.heading { margin-bottom: 16px; }
.heading h2 { font-size: 18px; margin: 0 0 8px; }
.hint { color: #737985; font-size: 12px; margin: 5px 0; line-height: 1.6; }
.content-grid { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 18px; align-items: start; }
.preview-card, .list-card { min-width: 0; }
.preview-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
.preview-option { border: 1px solid var(--el-color-primary-light-7); border-radius: 7px; padding: 16px 7px; text-align: center; background: var(--el-color-primary-light-9); overflow-wrap: anywhere; }
.preview-price { color: var(--el-color-primary); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.preview-price span, .preview-gift { font-size: 12px; font-weight: 400; }
.preview-gift { margin-top: 7px; color: #606266; }
.preview-note { margin-top: 18px; }
.preview-placeholder { text-align: center; padding: 40px 0; color: #909399; }
.notice { margin-bottom: 14px; }
.limit-note { margin-top: 12px; }
.table-scroll { width: 100%; max-width: 100%; overflow-x: auto; margin-top: 16px; }
@media (max-width: 1100px) { .content-grid { grid-template-columns: minmax(0, 1fr); } .preview-options { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); } }
@media (max-width: 600px) { .preview-options { grid-template-columns: repeat(2, minmax(0, 1fr)); } .preview-price { font-size: 19px; } }
</style>
