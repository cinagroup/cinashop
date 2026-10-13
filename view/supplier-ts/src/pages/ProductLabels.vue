<script setup lang="ts">
import { computed, onMounted, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { ApiError } from '@/api/http';
import { getSupplierProductLabelCatalog, getSupplierProductLabelForm, saveSupplierProductLabel, deleteSupplierProductLabel } from '@/api/productLabels';
import type { SupplierProductLabelCatalog, SupplierProductLabelForm, SupplierProductLabelPayload, SupplierProductLabelRow } from '@/types/productLabels';
import { supplierProductLabelDraft, supplierProductLabelMatches } from '@/utils/productLabels';
import { createSupplierSessionScope } from '@/utils/supplierSession';

const auth = useAuthStore(), canRead = computed(() => auth.can('supplier.product.view')), canManage = computed(() => auth.can('supplier.product.manage'));
const catalog = ref<SupplierProductLabelCatalog | null>(null), definition = ref<SupplierProductLabelForm | null>(null);
const busy = ref(false), loading = ref(false), editing = ref(false), keyword = ref(''), page = ref(1), error = ref(''), notice = ref('');
const editId = ref(0), editRevision = ref(''), draft = reactive({ group: undefined as number | undefined, name: '' });
type Attempt = { operation: 'save' | 'delete'; id: number; payload?: SupplierProductLabelPayload; previousIds: number[]; receiptRevision?: string };
const attempt = shallowRef<Attempt | null>(null), recoveryRead = ref(false);
let generation = 0, interactionGeneration = 0, disposed = false;
let readController: AbortController | undefined, writeController: AbortController | undefined;
function invalidate() {
  generation++; interactionGeneration++; readController?.abort(); writeController?.abort(); catalog.value = null;
  definition.value = null; editing.value = false; attempt.value = null; busy.value = false; loading.value = false;
  error.value = '登录会话或权限已改变，请重新打开商品标签'; notice.value = '';
}
const session = createSupplierSessionScope(invalidate, true);
function current() { return !disposed && session.isCurrent() && canRead.value; }
onScopeDispose(() => { disposed = true; readController?.abort(); writeController?.abort(); session.dispose(); });
watch([canRead, canManage], () => { if (!canRead.value || !canManage.value && (editing.value || busy.value)) invalidate(); });
watch(keyword, () => { page.value = 1; interactionGeneration++; });
const filtered = computed(() => (catalog.value?.list ?? []).filter(row => !keyword.value.trim() || `${row.label_name} ${row.group_name}`.includes(keyword.value.trim())));
const rows = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20));
const groupOptions = computed(() => editId.value ? (catalog.value?.groups ?? []).map(row => ({ label: row.name, value: row.id })) : definition.value?.rules[0].options ?? []);
const submitDisabled = computed(() => busy.value || loading.value || !!attempt.value || !canManage.value || !catalog.value || !draft.group || !draft.name.trim());
function message(value: unknown) { return value instanceof Error ? value.message : '请求失败，请刷新后重试'; }
function knownRejection(value: unknown) { return value instanceof ApiError && (value.status === 400 || value.status === 404 || value.status === 409 || value.status === 400011 || value.status >= 410000 && value.status <= 410002); }

async function load() {
  if (!current()) return null;
  const version = ++generation; readController?.abort(); readController = new AbortController(); loading.value = true; error.value = '';
  try {
    const result = await getSupplierProductLabelCatalog(readController.signal);
    if (!current() || version !== generation) return null; catalog.value = result; return result;
  } catch (value) { if (current() && version === generation) error.value = message(value); return null; }
  finally { if (version === generation) loading.value = false; }
}
async function openCreate() {
  if (!current() || !canManage.value || busy.value || attempt.value || !catalog.value) return;
  const version = ++interactionGeneration; busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await getSupplierProductLabelForm();
    if (!current() || !canManage.value || version !== interactionGeneration) return;
    definition.value = result; editId.value = 0; editRevision.value = ''; draft.group = undefined; draft.name = ''; editing.value = true;
  } catch (value) { if (current()) error.value = message(value); }
  finally { if (current()) busy.value = false; }
}
function openEdit(row: SupplierProductLabelRow) {
  if (!current() || !canManage.value || busy.value || attempt.value) return;
  interactionGeneration++; editId.value = row.id; editRevision.value = row.revision; draft.group = row.group_valid ? row.label_cate : undefined;
  draft.name = row.label_name; error.value = ''; notice.value = ''; editing.value = true;
}
function verify(result: SupplierProductLabelCatalog, pending: Attempt) {
  if (pending.operation === 'delete') return !result.list.some(row => row.id === pending.id);
  const candidates = pending.id ? result.list.filter(row => row.id === pending.id)
    : result.list.filter(row => !pending.previousIds.includes(row.id) && supplierProductLabelMatches(row, pending.payload!));
  return candidates.length === 1 && supplierProductLabelMatches(candidates[0], pending.payload!) &&
    (!pending.receiptRevision || candidates[0].revision === pending.receiptRevision);
}
async function recover() {
  const pending = attempt.value; if (!pending || !current() || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await load(); if (!result || !current() || attempt.value !== pending) return;
    recoveryRead.value = true;
    if (verify(result, pending)) { attempt.value = null; editing.value = false; notice.value = '已重新读取并核对标签结果'; ElMessage.success(notice.value); }
    else error.value = '当前标签事实无法确认本次操作结果。请核对列表后结束本次操作，不要重复提交。';
  } finally { if (current()) busy.value = false; }
}
async function save() {
  if (submitDisabled.value || !current()) return;
  let payload: SupplierProductLabelPayload;
  try { payload = supplierProductLabelDraft(draft.group, draft.name, editId.value ? editRevision.value : catalog.value!.revision); }
  catch (value) { error.value = message(value); return; }
  const pending: Attempt = { operation: 'save', id: editId.value, payload, previousIds: catalog.value!.list.map(row => row.id) };
  attempt.value = pending; recoveryRead.value = false; busy.value = true; error.value = ''; notice.value = ''; writeController = new AbortController();
  try {
    const receipt = await saveSupplierProductLabel(pending.id, payload, writeController.signal);
    if (!current() || attempt.value !== pending) return; pending.id = receipt.id; pending.receiptRevision = receipt.revision;
    const result = await load(); if (!result || !current() || attempt.value !== pending) return;
    recoveryRead.value = true;
    if (!verify(result, pending)) throw Error('保存后的标签事实已变化，请核对执行结果');
    attempt.value = null; editing.value = false; notice.value = '标签已保存并重新读取核对'; ElMessage.success(notice.value);
  } catch (value) {
    if (!current() || attempt.value !== pending) return;
    if (knownRejection(value)) attempt.value = null;
    error.value = message(value);
  } finally { if (current()) busy.value = false; }
}
async function remove(row: SupplierProductLabelRow) {
  if (!current() || !canManage.value || busy.value || attempt.value) return;
  const version = interactionGeneration, rowRevision = row.revision;
  try { await ElMessageBox.confirm(`删除“${row.label_name}”？被商品或历史记录引用的标签无法删除。`, '删除商品标签',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); } catch { return; }
  if (!current() || !canManage.value || version !== interactionGeneration || catalog.value?.list.find(item => item.id === row.id)?.revision !== rowRevision) return;
  const pending: Attempt = { operation: 'delete', id: row.id, previousIds: catalog.value.list.map(item => item.id) };
  attempt.value = pending; recoveryRead.value = false; busy.value = true; error.value = ''; notice.value = ''; writeController = new AbortController();
  try {
    await deleteSupplierProductLabel(row.id, rowRevision, writeController.signal);
    if (!current() || attempt.value !== pending) return;
    const result = await load(); if (!result || !current() || attempt.value !== pending) return;
    recoveryRead.value = true; if (!verify(result, pending)) throw Error('删除结果尚未核对，请重新读取标签');
    attempt.value = null; notice.value = '标签已删除并重新读取核对'; ElMessage.success(notice.value);
  } catch (value) { if (current() && attempt.value === pending) { if (knownRejection(value)) attempt.value = null; error.value = message(value); } }
  finally { if (current()) busy.value = false; }
}
function finishAttempt() { if (!busy.value && recoveryRead.value) { attempt.value = null; editing.value = false; error.value = ''; notice.value = '已结束本次操作，请按当前列表重新选择'; } }
function closeEditor(done?: () => void) { if (busy.value || attempt.value) return; editing.value = false; done?.(); }
onMounted(load);
</script>

<template>
  <div class="product-labels">
    <div class="page-heading"><div><h1>商品标签</h1><p>维护当前供应商的标签，平台标签可在商品编辑页选择</p></div>
      <div class="heading-actions"><el-button :disabled="busy || !!attempt" :loading="loading" @click="load">重新读取</el-button>
        <el-button v-if="canManage" type="primary" :disabled="busy || loading || !!attempt || !catalog" @click="openCreate">新增标签</el-button></div></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
    <div v-if="attempt" class="recovery" role="status"><p>操作结果待核对，当前标签不会重复提交。</p>
      <el-button type="primary" :loading="busy" :disabled="busy" @click="recover">核对执行结果</el-button>
      <el-button :disabled="busy || !recoveryRead" @click="finishAttempt">按当前列表结束本次操作</el-button></div>
    <section class="label-panel">
      <div class="toolbar"><el-input v-model="keyword" clearable placeholder="搜索标签名称或分组" aria-label="搜索商品标签" :disabled="busy || !!attempt" />
        <span>{{ filtered.length }} 个标签</span></div>
      <el-table :data="rows" v-loading="loading" empty-text="暂无当前供应商标签">
        <el-table-column prop="label_name" label="标签名称" min-width="190" />
        <el-table-column label="分组" min-width="165"><template #default="scope"><span>{{ scope.row.group_valid ? scope.row.group_name : '原分组不可用' }}</span></template></el-table-column>
        <el-table-column label="商品可选" width="110"><template #default="scope"><el-tag :type="scope.row.selectable ? 'success' : 'info'">{{ scope.row.selectable ? '可选择' : '未开放' }}</el-tag></template></el-table-column>
        <el-table-column v-if="canManage" label="操作" width="145" fixed="right"><template #default="scope">
          <el-button link type="primary" :disabled="busy || !!attempt" @click="openEdit(scope.row)">编辑</el-button>
          <el-button link type="danger" :disabled="busy || !!attempt" @click="remove(scope.row)">删除</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-if="filtered.length > 20" v-model:current-page="page" :page-size="20" :total="filtered.length" layout="prev, pager, next" :disabled="busy || !!attempt" />
    </section>
    <el-dialog v-model="editing" :title="editId ? '编辑商品标签' : definition?.title || '添加商品标签'" width="480px" :before-close="closeEditor" :close-on-click-modal="false" :close-on-press-escape="!busy && !attempt">
      <p class="editor-note">编辑仅修改标签名称与分组，已有展示样式和开放状态会保留。</p>
      <el-form label-position="top"><el-form-item label="标签分组" required><el-select v-model="draft.group" :disabled="busy || !!attempt" placeholder="请选择标签组" style="width:100%">
        <el-option v-for="option in groupOptions" :key="option.value" :value="option.value" :label="option.label" /></el-select></el-form-item>
        <el-form-item label="标签名称" required><el-input v-model="draft.name" :disabled="busy || !!attempt" :maxlength="20" show-word-limit /></el-form-item></el-form>
      <el-alert v-if="attempt" title="结果待核对，请在列表的恢复区核对执行结果" type="warning" :closable="false" />
      <template #footer><template v-if="attempt"><el-button :disabled="busy || !recoveryRead" @click="finishAttempt">结束本次操作</el-button>
        <el-button type="primary" :loading="busy" :disabled="busy" @click="recover">核对执行结果</el-button></template>
        <template v-else><el-button :disabled="busy" @click="closeEditor()">取消</el-button><el-button type="primary" :loading="busy" :disabled="submitDisabled" @click="save">保存标签</el-button></template></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.product-labels{grid-template-columns:minmax(0,1fr);min-width:0;max-width:100%}.label-panel{min-width:0}
.product-labels{display:grid;gap:16px}.page-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.page-heading h1{margin:0 0 8px;font-size:26px}.page-heading p,.editor-note{margin:0;color:var(--text-secondary,#64748b);line-height:1.6}.heading-actions{display:flex;gap:8px}.heading-actions :deep(.el-button+.el-button){margin-left:0}.label-panel{padding:20px;background:var(--surface,#fff);border:1px solid var(--border,#e2e8f0);border-radius:12px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.toolbar :deep(.el-input){max-width:360px}.toolbar>span{color:var(--text-secondary,#64748b);white-space:nowrap}.recovery{padding:16px;border:1px solid #fcd34d;border-radius:8px;background:#fffbeb}.recovery p{margin:0 0 12px;color:#92400e}.editor-note{margin-bottom:20px}.label-panel :deep(.el-pagination){justify-content:flex-end;margin-top:18px}
@media(max-width:600px){.page-heading{align-items:flex-start;flex-direction:column}.heading-actions{width:100%;flex-wrap:wrap}.label-panel{padding:12px}.toolbar{align-items:flex-start;flex-direction:column}.toolbar :deep(.el-input){max-width:none;width:100%}.product-labels :deep(.el-dialog){width:calc(100vw - 24px)!important;margin-top:10vh}.product-labels :deep(.el-dialog__body){max-height:60dvh;overflow:auto}.recovery :deep(.el-button){margin:4px 8px 4px 0;white-space:normal}}
</style>
