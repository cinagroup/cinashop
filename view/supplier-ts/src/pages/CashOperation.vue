<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { previewMode } from '@/api/supplier';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { getCashSeed, cashOperationStorageKey, parsePendingCashOperation, recoverCashOperation, saveCashOperation,
  type CashOperationKind, type CashSeed, type CashReceipt, type PendingCashOperation } from '@/api/cashOperations';
import { formatMoney } from '@/utils/format';

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const kind = computed<CashOperationKind>(() => route.path.startsWith('/orders/') ? 'payment' : 'refund');
const recoveryOnly = computed(() => route.path.endsWith('/cash-result'));
const backPath = computed(() => kind.value === 'payment' ? '/orders' : '/refunds');
const title = computed(() => kind.value === 'payment' ? '确认线下收款' : '确认现金退款');
const source = ref<CashSeed | null>(null), cashConfirmed = ref(false), pending = ref<PendingCashOperation | null>(null);
const loading = ref(false), saving = ref(false), recovering = ref(false), invalidated = ref(false);
const error = ref(''), storageError = ref(''), notice = ref('');
const actor = { id: Number(auth.user?.id), supplier: Number(auth.user?.supplier_id) };
let generation = 0, formVersion = 0, disposed = false, confirming = false, readController: AbortController | undefined;
watch(cashConfirmed, () => { formVersion++; }, { flush: 'sync' });
const session = createSupplierSessionScope(() => {
  invalidated.value = true; generation++; readController?.abort(); source.value = null; cashConfirmed.value = false;
  pending.value = null; notice.value = ''; error.value = '会话已变化，请重新进入'; if (confirming) ElMessageBox.close();
}, previewMode);
const active = () => !disposed && !invalidated.value && session.isCurrent();
const id = computed(() => typeof route.params.id === 'string' && /^[1-9]\d{0,9}$/.test(route.params.id)
  && Number(route.params.id) <= 2147483647 ? Number(route.params.id) : 0);
const canWrite = computed(() => active() && !previewMode && !recoveryOnly.value && auth.can(`supplier.${kind.value === 'payment' ? 'order' : 'refund'}.manage`)
  && !!source.value && !loading.value && !saving.value && !recovering.value && !pending.value && !storageError.value);
function readPending() {
  pending.value = null; storageError.value = '';
  try {
    if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !Number.isSafeInteger(actor.supplier) || actor.supplier <= 0) throw Error('供应商身份无效');
    const raw = sessionStorage.getItem(cashOperationStorageKey(kind.value, actor.id, actor.supplier));
    if (raw) pending.value = parsePendingCashOperation(JSON.parse(raw), kind.value, actor.id, actor.supplier);
  } catch (cause) { storageError.value = cause instanceof Error ? cause.message : '无法读取原收退款记录'; }
}
async function load() {
  const ticket = ++generation; readController?.abort(); readController = new AbortController();
  source.value = null; cashConfirmed.value = false; error.value = ''; loading.value = false;
  if (!active() || recoveryOnly.value || pending.value || storageError.value) return;
  if (previewMode || !id.value || Object.keys(route.query).length) { error.value = '请从已登录的真实订单或售后详情进入'; return; }
  loading.value = true;
  try { const result = await getCashSeed(kind.value, id.value, readController.signal); if (active() && ticket === generation) source.value = result; }
  catch (cause) { if (active() && ticket === generation) error.value = cause instanceof Error ? cause.message : '读取收退款资料失败'; }
  finally { if (ticket === generation) loading.value = false; }
}
async function accept(receipt: CashReceipt, operation: PendingCashOperation) {
  if (!active() || pending.value?.operation_id !== operation.operation_id || operation.kind !== kind.value) return;
  if (receipt.state === 'unknown') { notice.value = '原操作结果尚未确认，请稍后查询，或确认原事务结果。'; return; }
  sessionStorage.removeItem(cashOperationStorageKey(operation.kind, actor.id, actor.supplier)); pending.value = null;
  source.value = null; cashConfirmed.value = false;
  if (receipt.state === 'not_applied') { notice.value = '原操作已确认未提交，可重新载入后核对。'; return; }
  ElMessage.success(operation.kind === 'payment' ? '线下收款已确认' : '现金退款已确认'); await router.push(backPath.value);
}
async function save() {
  if (!canWrite.value || !source.value || confirming || source.value.cash_required && !cashConfirmed.value) return;
  const seed = source.value, ticket = generation, version = formVersion, confirmed = cashConfirmed.value;
  const operation = parsePendingCashOperation({ operation_id: crypto.randomUUID(), actor_id: actor.id, supplier_id: actor.supplier,
    subject_id: seed.subject_id, kind: seed.kind }, seed.kind, actor.id, actor.supplier);
  confirming = true;
  try { await ElMessageBox.confirm(`${title.value} ${formatMoney(seed.amount)}？请核对实际现金交接和原单号 ${seed.order_no}。`, title.value,
    { type: 'warning', confirmButtonText: '确认已核对', cancelButtonText: '取消' }); }
  catch { return; } finally { confirming = false; }
  if (!active() || ticket !== generation || version !== formVersion || !canWrite.value || source.value !== seed || confirmed !== cashConfirmed.value) return;
  const key = cashOperationStorageKey(operation.kind, actor.id, actor.supplier), serialized = JSON.stringify(operation);
  try {
    if (sessionStorage.getItem(key)) { readPending(); throw Error('存在原操作待确认，请先查询结果'); }
    sessionStorage.setItem(key, serialized);
    if (sessionStorage.getItem(key) !== serialized) throw Error('原操作未能保存，不能提交');
  } catch (cause) { storageError.value = cause instanceof Error ? cause.message : '无法保存原操作'; return; }
  pending.value = operation; saving.value = true; notice.value = '';
  try { const receipt = await saveCashOperation(seed, operation, confirmed); if (active() && ticket === generation) await accept(receipt, operation); }
  catch (cause) { if (active() && ticket === generation) notice.value = cause instanceof Error ? `${cause.message}。请先查询原操作结果。` : '提交结果未知，请查询原操作'; }
  finally { if (ticket === generation) saving.value = false; }
}
async function recover(resolve = false) {
  if (!active() || !pending.value || saving.value || recovering.value || confirming) return;
  const operation = pending.value, ticket = generation;
  if (resolve) {
    confirming = true;
    try { await ElMessageBox.confirm('将核对并封存这次原操作；若已完成，则读取原结果。', '确认原事务结果', { type: 'warning' }); }
    catch { return; } finally { confirming = false; }
  }
  if (!active() || ticket !== generation || pending.value?.operation_id !== operation.operation_id) return;
  recovering.value = true; notice.value = '';
  try { const result = await recoverCashOperation(operation, resolve); if (active() && ticket === generation) await accept(result, operation); }
  catch (cause) { if (active() && ticket === generation) notice.value = cause instanceof Error ? cause.message : '原结果尚未核对成功'; }
  finally { if (ticket === generation) recovering.value = false; }
}
watch(() => route.fullPath, () => {
  generation++; readController?.abort(); saving.value = recovering.value = false; notice.value = '';
  if (confirming) ElMessageBox.close(); readPending(); void load();
}, { flush: 'sync' });
onMounted(() => { readPending(); void load(); });
onBeforeUnmount(() => { disposed = true; generation++; readController?.abort(); session.dispose(); if (confirming) ElMessageBox.close(); });
</script>

<template>
  <section class="cash-operation-page">
    <header><div><h1>{{ recoveryOnly ? (kind === 'payment' ? '线下收款结果' : '现金退款结果') : title }}</h1>
      <p>{{ kind === 'payment' ? '核对实际收到的现金，并记录原订单付款。' : '核对实际退还给买家的现金，并完成售后结算。' }}</p></div>
      <el-button @click="router.push(backPath)">返回{{ kind === 'payment' ? '订单' : '售后' }}列表</el-button></header>
    <el-alert v-if="error || storageError" :title="error || storageError" type="error" :closable="false" show-icon />
    <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon />
    <article v-if="pending" class="surface" role="status">
      <h2>{{ kind === 'payment' ? '收款' : '退款' }}结果待确认</h2><p>原单 #{{ pending.subject_id }} · 操作 {{ pending.operation_id }}。请先查询原结果。</p>
      <div class="actions"><el-button :loading="recovering" :disabled="invalidated || saving || recovering" @click="recover(false)">查询原操作结果</el-button>
        <el-button :disabled="invalidated || saving || recovering" @click="recover(true)">确认原事务结果</el-button></div>
    </article>
    <p v-if="loading" role="status">正在读取当前金额…</p>
    <article v-if="source && !recoveryOnly" class="surface">
      <dl><div><dt>{{ kind === 'payment' ? '订单编号' : '售后单号' }}</dt><dd>{{ source.order_no }}</dd></div>
        <div><dt>{{ kind === 'payment' ? '实际收款金额' : '实际退款金额' }}</dt><dd class="amount">{{ formatMoney(source.amount) }}</dd></div>
        <div v-if="source.gain_integral !== undefined"><dt>订单赠送积分</dt><dd>{{ Number(source.gain_integral) }}</dd></div></dl>
      <el-checkbox v-if="source.cash_required" v-model="cashConfirmed" :disabled="!canWrite">{{ kind === 'payment' ? '我已实际收妥上述现金' : '我已实际退还上述现金给买家' }}</el-checkbox>
      <p v-else>本次金额为零，无需现金交接。</p>
      <div class="actions"><el-button type="primary" :loading="saving" :disabled="!canWrite || (source.cash_required && !cashConfirmed)" @click="save">{{ title }}</el-button></div>
    </article>
    <el-button v-if="!recoveryOnly && !pending && !storageError" :disabled="loading || saving || invalidated" @click="load">重新核对当前金额</el-button>
    <el-alert v-if="recoveryOnly && !pending && !storageError && !notice" title="本窗口没有待确认的原操作" type="info" :closable="false" />
  </section>
</template>

<style scoped>
.cash-operation-page { display: grid; gap: 20px; max-width: 960px; margin: 0 auto; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
h1 { margin: 0 0 8px; font-size: 24px; } h2 { margin: 0 0 10px; font-size: 18px; }
p, dd { overflow-wrap: anywhere; } p { margin: 0; line-height: 1.6; color: var(--el-text-color-secondary); }
article { padding: 24px; } dl { display: grid; gap: 20px; margin: 0 0 24px; } dt { color: var(--el-text-color-secondary); margin-bottom: 6px; } dd { margin: 0; } .amount { font-size: 26px; font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; } :deep(.el-checkbox) { max-width: 100%; height: auto; } :deep(.el-checkbox__label) { white-space: normal; }
@media (max-width: 600px) { .cash-operation-page { box-sizing: border-box; width: 100%; padding: 16px; } header { align-items: flex-start; flex-direction: column; } article { padding: 18px; } }
</style>
