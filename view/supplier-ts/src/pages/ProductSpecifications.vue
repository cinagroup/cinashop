<script setup lang="ts">
import { computed, onMounted, onScopeDispose, reactive, ref, shallowRef, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { getSupplierProductRules, getSupplierProductRule, saveSupplierProductRule, deleteSupplierProductRule, supplierProductRuleKnownRejection } from '@/api/productRules';
import { supplierProductRuleDraft, supplierProductRuleMatches } from '@/utils/productRules';
import type { SupplierProductRuleCatalog, SupplierProductRulePayload, SupplierProductRuleRow, SupplierRuleDimension } from '@/types/productRules';
const auth = useAuthStore(), canRead = computed(() => auth.can('supplier.product.view')), canManage = computed(() => auth.can('supplier.product.manage'));
const catalog = shallowRef<SupplierProductRuleCatalog | null>(null), loading = ref(false), busy = ref(false), editing = ref(false), error = ref(''), notice = ref('');
const filter = reactive({ rule_name: '', page: 1, limit: 20 }), editId = ref(0), editRevision = ref(''), createRevision = ref(''), createIds = ref<number[]>([]);
const blankDimension = (): SupplierRuleDimension => ({ value: '', detail: [] }), form = reactive({ rule_name: '', spec: [blankDimension()] });
type Attempt = Readonly<{ operation: 'save' | 'delete'; id: number; payload?: SupplierProductRulePayload; previousIds: readonly number[] }>;
const attempt = shallowRef<Attempt | null>(null), receipt = shallowRef<{ id: number; revision: string } | null>(null), recoveryRead = ref(false);
let generation = 0, interactionGeneration = 0, disposed = false;
let readController: AbortController | undefined, writeController: AbortController | undefined;
function invalidate() { generation++; interactionGeneration++; readController?.abort(); writeController?.abort(); catalog.value = null; editing.value = false;
  attempt.value = null; receipt.value = null; loading.value = false; busy.value = false; error.value = '登录会话或权限已改变，请重新打开规格模板'; notice.value = ''; }
const session = createSupplierSessionScope(invalidate, true);
function current() { return !disposed && session.isCurrent() && canRead.value; }
onScopeDispose(() => { disposed = true; readController?.abort(); writeController?.abort(); session.dispose(); });
watch([canRead, canManage], () => { if (!canRead.value || !canManage.value && (editing.value || busy.value || attempt.value)) invalidate(); });
watch(() => [filter.rule_name, filter.page, filter.limit], () => { interactionGeneration++; generation++; readController?.abort(); }, { flush: 'sync' });
const submitDisabled = computed(() => busy.value || loading.value || !!attempt.value || !canManage.value || !catalog.value || !form.rule_name.trim());
function message(value: unknown) { return value instanceof Error ? value.message : '请求失败，请重新读取后确认'; }
async function load() {
  if (!current()) return null;
  const version = ++generation; readController?.abort(); readController = new AbortController(); loading.value = true; error.value = '';
  try { const result = await getSupplierProductRules({ ...filter }, readController.signal); if (!current() || version !== generation) return null; catalog.value = result; return result; }
  catch (value) { if (current() && version === generation) error.value = message(value); return null; }
  finally { if (version === generation) loading.value = false; }
}
function search() { if (busy.value || attempt.value) return; filter.page = 1; void load(); }
async function openCreate() {
  if (!current() || !canManage.value || busy.value || attempt.value || !catalog.value) return;
  const version = ++interactionGeneration; busy.value = true; error.value = ''; notice.value = '';
  try { const result = await getSupplierProductRules(); if (!current() || !canManage.value || version !== interactionGeneration) return;
    createRevision.value = result.revision; createIds.value = result.list.map(row => row.id); editId.value = 0; editRevision.value = ''; form.rule_name = ''; form.spec = [blankDimension()]; editing.value = true; }
  catch (value) { if (current()) error.value = message(value); } finally { if (current()) busy.value = false; }
}
async function openEdit(id: number) {
  if (!current() || !canManage.value || busy.value || attempt.value) return;
  const version = ++interactionGeneration; busy.value = true; error.value = ''; notice.value = '';
  try { const result = await getSupplierProductRule(id); if (!current() || !canManage.value || version !== interactionGeneration) return;
    editId.value = result.id; editRevision.value = result.revision; form.rule_name = result.rule_name;
    form.spec = result.spec.length ? result.spec.map(row => ({ value: row.value, detail: [...row.detail] })) : [blankDimension()]; editing.value = true; }
  catch (value) { if (current()) error.value = message(value); } finally { if (current()) busy.value = false; }
}
function addDimension() { if (!busy.value && !attempt.value && form.spec.length < 3) form.spec.push(blankDimension()); }
function removeDimension(index: number) { if (!busy.value && !attempt.value && form.spec.length > 1) form.spec.splice(index, 1); }
function immutableAttempt(value: Attempt): Attempt { if (value.payload) { value.payload.spec.forEach(row => { Object.freeze(row.detail); Object.freeze(row); }); Object.freeze(value.payload.spec); Object.freeze(value.payload); } Object.freeze(value.previousIds); return Object.freeze(value); }
function verify(result: SupplierProductRuleCatalog, pending: Attempt) {
  if (pending.operation === 'delete') return !result.list.some(row => row.id === pending.id);
  const id = receipt.value?.id ?? pending.id, candidates = id ? result.list.filter(row => row.id === id)
    : result.list.filter(row => !pending.previousIds.includes(row.id) && supplierProductRuleMatches(row, pending.payload!));
  return candidates.length === 1 && supplierProductRuleMatches(candidates[0], pending.payload!) && (!receipt.value || candidates[0].revision === receipt.value.revision);
}
async function reread(pending: Attempt) {
  const result = await getSupplierProductRules(); if (!current() || attempt.value !== pending) return false; recoveryRead.value = true;
  if (!verify(result, pending)) throw Error('当前模板事实无法确认本次操作结果，请核对后结束本次操作，不要重复提交');
  attempt.value = null; receipt.value = null; editing.value = false; notice.value = '已重新读取并核对规格模板结果'; ElMessage.success(notice.value); await load(); return true;
}
async function recover() { const pending = attempt.value; if (!pending || !current() || busy.value) return; busy.value = true; error.value = '';
  try { await reread(pending); } catch (value) { if (current() && attempt.value === pending) error.value = message(value); } finally { if (current()) busy.value = false; } }
async function submit() {
  if (submitDisabled.value || !current()) return; let payload: SupplierProductRulePayload;
  try { payload = supplierProductRuleDraft(form.rule_name, form.spec, editId.value ? editRevision.value : createRevision.value); } catch (value) { error.value = message(value); return; }
  const pending = immutableAttempt({ operation: 'save', id: editId.value, payload, previousIds: [...createIds.value] });
  attempt.value = pending; receipt.value = null; recoveryRead.value = false; busy.value = true; error.value = ''; notice.value = ''; writeController = new AbortController(); let acknowledged = false;
  try { const result = await saveSupplierProductRule(pending.id, payload, writeController.signal); if (!current() || attempt.value !== pending) return; receipt.value = result; acknowledged = true; await reread(pending); }
  catch (value) { if (!current() || attempt.value !== pending) return; if (!acknowledged && supplierProductRuleKnownRejection(value)) { attempt.value = null; receipt.value = null; } error.value = message(value); }
  finally { if (current()) busy.value = false; }
}
async function removeRule(row: SupplierProductRuleRow) {
  if (!current() || !canManage.value || busy.value || attempt.value) return; const version = interactionGeneration, rowRevision = row.revision;
  try { await ElMessageBox.confirm(`删除“${row.rule_name}”？已复制到商品的规格、价格和库存会保留。`, '删除规格模板', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }); } catch { return; }
  if (!current() || !canManage.value || version !== interactionGeneration || catalog.value?.list.find(item => item.id === row.id)?.revision !== rowRevision) return;
  const pending = immutableAttempt({ operation: 'delete', id: row.id, previousIds: [] }); attempt.value = pending; receipt.value = null; recoveryRead.value = false;
  busy.value = true; error.value = ''; notice.value = ''; writeController = new AbortController(); let acknowledged = false;
  try { await deleteSupplierProductRule(row.id, rowRevision, writeController.signal); if (!current() || attempt.value !== pending) return; acknowledged = true; await reread(pending); }
  catch (value) { if (current() && attempt.value === pending) { if (!acknowledged && supplierProductRuleKnownRejection(value)) attempt.value = null; error.value = message(value); } }
  finally { if (current()) busy.value = false; }
}
function finishAttempt() { if (!busy.value && recoveryRead.value) { attempt.value = null; receipt.value = null; editing.value = false; error.value = ''; notice.value = '已结束本次操作，请按当前列表重新选择'; void load(); } }
function closeEditor(done?: () => void) { if (busy.value || attempt.value) return; editing.value = false; done?.(); }
onMounted(load);
</script>
<template>
  <section class="page-section product-specifications-page">
    <header class="page-heading"><div><h1>规格模板</h1><p>复用当前供应商的规格维度与规格值，减少重复录入</p></div><div class="heading-actions"><el-button :disabled="busy || !!attempt" :loading="loading" @click="load">重新读取</el-button><el-button v-if="canManage" type="primary" :disabled="busy || loading || !!attempt || !catalog" @click="openCreate">新增模板</el-button></div></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon /><el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon />
    <article v-if="attempt" class="recovery" role="status"><p>操作结果待核对，当前模板不会重复提交。</p><el-button type="primary" :loading="busy" :disabled="busy" @click="recover">核对执行结果</el-button><el-button :disabled="busy || !recoveryRead" @click="finishAttempt">按当前列表结束本次操作</el-button></article>
    <article class="surface filter-bar"><el-input v-model="filter.rule_name" clearable maxlength="50" placeholder="搜索模板名称" :disabled="busy || !!attempt" @keyup.enter="search" /><el-button type="primary" :disabled="busy || !!attempt" @click="search">查询</el-button></article>
    <article v-loading="loading" class="surface table-card"><el-table :data="catalog?.list ?? []" empty-text="暂无规格模板"><el-table-column prop="id" label="ID" width="90" /><el-table-column prop="rule_name" label="模板名称" min-width="180" /><el-table-column label="规格内容" min-width="330"><template #default="scope"><div class="dimension-summary"><div v-for="dimension in scope.row.spec" :key="dimension.value"><strong>{{ dimension.value }}</strong><span><el-tag v-for="detail in dimension.detail" :key="detail" size="small" effect="plain">{{ detail }}</el-tag></span></div></div></template></el-table-column><el-table-column v-if="canManage" label="操作" width="140" fixed="right"><template #default="scope"><el-button link type="primary" :disabled="busy || !!attempt" @click="openEdit(scope.row.id)">编辑</el-button><el-button link type="danger" :disabled="busy || !!attempt" @click="removeRule(scope.row)">删除</el-button></template></el-table-column></el-table><div class="table-footer"><span>共 {{ catalog?.count ?? 0 }} 个模板</span><el-pagination v-model:current-page="filter.page" :page-size="filter.limit" :total="catalog?.count ?? 0" layout="prev, pager, next" :disabled="busy || !!attempt" @current-change="load" /></div></article>
    <el-dialog v-model="editing" :title="editId ? '编辑规格模板' : '新增规格模板'" width="min(760px, 94vw)" :before-close="closeEditor" :close-on-click-modal="false" :close-on-press-escape="!busy && !attempt">
      <el-form label-position="top" class="rule-form"><el-form-item label="模板名称" required><el-input v-model="form.rule_name" :disabled="busy || !!attempt" maxlength="32" show-word-limit placeholder="例如：服装颜色尺码" /></el-form-item><section class="dimension-editor"><div class="dimension-heading"><div><h3>规格维度</h3><p>每个模板支持1至3个维度，每个维度最多50个值</p></div><el-button :disabled="busy || !!attempt || form.spec.length >= 3" @click="addDimension">添加维度</el-button></div><div v-for="(dimension, index) in form.spec" :key="index" class="dimension-row"><el-input v-model="dimension.value" :disabled="busy || !!attempt" maxlength="32" placeholder="规格名称，如颜色" /><el-select v-model="dimension.detail" :disabled="busy || !!attempt" multiple filterable allow-create default-first-option placeholder="输入规格值后回车" /><el-button text type="danger" :disabled="busy || !!attempt || form.spec.length === 1" aria-label="删除规格维度" @click="removeDimension(index)">删除</el-button></div></section><el-alert title="模板只复制规格结构" type="info" :closable="false" show-icon description="模板不会改写已保存商品。套用时将生成新的规格行，请核对价格、库存与图片后保存商品。" /><el-alert v-if="attempt" title="结果待核对，请读取当前模板事实，不要重复保存" type="warning" :closable="false" /></el-form>
      <template #footer><template v-if="attempt"><el-button :disabled="busy || !recoveryRead" @click="finishAttempt">结束本次操作</el-button><el-button type="primary" :loading="busy" :disabled="busy" @click="recover">核对执行结果</el-button></template><template v-else><el-button :disabled="busy" @click="closeEditor()">取消</el-button><el-button type="primary" :loading="busy" :disabled="submitDisabled" @click="submit">保存模板</el-button></template></template>
    </el-dialog>
  </section>
</template>
<style scoped>
.product-specifications-page{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0;max-width:100%}.heading-actions{display:flex;gap:8px}.heading-actions :deep(.el-button+.el-button){margin-left:0}.filter-bar{display:flex;gap:12px;padding:18px}.filter-bar .el-input{max-width:360px}.table-card{overflow:hidden;min-width:0}.table-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 20px;color:var(--text-muted)}.dimension-summary{display:grid;gap:10px;padding:4px 0}.dimension-summary>div{display:grid;grid-template-columns:minmax(70px,110px) 1fr;align-items:start;gap:10px}.dimension-summary span{display:flex;flex-wrap:wrap;gap:6px}.rule-form{display:grid;gap:4px}.dimension-editor{padding:18px 0;border-top:1px solid var(--border)}.dimension-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px}.dimension-heading h3{margin:0 0 4px;font-size:16px}.dimension-heading p{margin:0;color:var(--text-muted);font-size:13px}.dimension-row{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(280px,1.6fr) 60px;align-items:start;gap:12px;margin-bottom:12px}.dimension-row .el-select{width:100%}.recovery{padding:16px;border:1px solid #fcd34d;border-radius:8px;background:#fffbeb}.recovery p{margin:0 0 12px;color:#92400e}
@media(max-width:720px){.page-heading,.filter-bar,.table-footer,.dimension-heading{align-items:stretch;flex-direction:column}.heading-actions{flex-wrap:wrap}.filter-bar .el-input{max-width:none}.dimension-row{grid-template-columns:1fr 60px}.dimension-row .el-select{grid-column:1/-1;grid-row:2}.product-specifications-page :deep(.el-dialog__body){max-height:64dvh;overflow:auto}.recovery :deep(.el-button){margin:4px 8px 4px 0;white-space:normal}}
</style>
