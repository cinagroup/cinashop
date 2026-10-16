<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { previewMode } from '@/api/supplier';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { getOrderEditSeed, orderEditPayload, orderEditStorageKey, parsePendingOrderEdit, recoverOrderEdit, saveOrderEdit,
  type OrderEditReceipt, type OrderEditSeed, type PendingOrderEdit } from '@/api/orderEdit';

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const source = ref<OrderEditSeed | null>(null), payPrice = ref(''), gainIntegral = ref('');
const loading = ref(false), saving = ref(false), recovering = ref(false), invalidated = ref(false);
const pending = ref<PendingOrderEdit | null>(null), error = ref(''), storageError = ref(''), notice = ref('');
let generation = 0, formVersion = 0, disposed = false, confirming = false;
let readController: AbortController | undefined;
const actor = { id: Number(auth.user?.id), supplier: Number(auth.user?.supplier_id) };
const recoveryOnly = computed(() => route.path === '/orders/edit-result');
const id = computed(() => {
  const value = route.params.id;
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : 0;
});
const session = createSupplierSessionScope(() => {
  invalidated.value = true; generation++; readController?.abort(); source.value = null; payPrice.value = gainIntegral.value = '';
  pending.value = null; error.value = '会话已变化，请重新进入订单页'; notice.value = ''; if (confirming) ElMessageBox.close();
}, previewMode);
const active = () => !disposed && !invalidated.value && session.isCurrent();
const canSave = computed(() => active() && !previewMode && !recoveryOnly.value && auth.can('supplier.order.manage')
  && !!source.value && !loading.value && !saving.value && !recovering.value && !pending.value && !storageError.value);
watch([payPrice, gainIntegral], () => { formVersion++; }, { flush: 'sync' });
function readPending() {
  pending.value = null; storageError.value = '';
  try {
    if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !Number.isSafeInteger(actor.supplier) || actor.supplier <= 0) throw Error('供应商身份无效');
    const raw = sessionStorage.getItem(orderEditStorageKey(actor.id, actor.supplier));
    if (raw) pending.value = parsePendingOrderEdit(JSON.parse(raw), actor.id, actor.supplier);
  } catch (cause) { storageError.value = cause instanceof Error ? cause.message : '无法读取原订单编辑记录'; }
}
async function load() {
  const ticket = ++generation; readController?.abort(); readController = new AbortController();
  source.value = null; payPrice.value = gainIntegral.value = ''; error.value = ''; loading.value = false;
  if (!active() || recoveryOnly.value || pending.value || storageError.value) return;
  if (previewMode) { error.value = '示例订单不支持修改金额，请使用已登录的供应商订单'; return; }
  if (!id.value || Object.keys(route.query).length) { error.value = '编辑入口无效，请从订单详情重新进入'; return; }
  loading.value = true; const target = id.value;
  try {
    const result = await getOrderEditSeed(target, readController.signal);
    if (!active() || ticket !== generation || target !== id.value) return;
    source.value = result; payPrice.value = result.values.pay_price; gainIntegral.value = result.values.gain_integral;
  } catch (cause) { if (active() && ticket === generation) error.value = cause instanceof Error ? cause.message : '读取订单编辑资料失败'; }
  finally { if (ticket === generation) loading.value = false; }
}
async function accept(receipt: OrderEditReceipt, operation: PendingOrderEdit) {
  if (!active() || pending.value?.operation_id !== operation.operation_id) return;
  if (receipt.state === 'unknown') { notice.value = '原操作仍待确认，请稍后查询，或确认原事务结果。'; return; }
  sessionStorage.removeItem(orderEditStorageKey(actor.id, actor.supplier)); pending.value = null;
  if (receipt.state === 'not_applied') { notice.value = '原操作已确认未提交，可重新载入订单后编辑。'; source.value = null; return; }
  source.value = null; payPrice.value = gainIntegral.value = '';
  ElMessage.success(receipt.result?.changed ? '订单金额与赠送积分已修改' : '订单信息已核对，无需修改');
  await router.push('/orders');
}
async function save() {
  if (!canSave.value || !source.value || confirming) return;
  const seed = source.value, ticket = generation, version = formVersion, target = id.value;
  let operation: PendingOrderEdit, body: ReturnType<typeof orderEditPayload>;
  try {
    operation = parsePendingOrderEdit({ operation_id: crypto.randomUUID(), actor_id: actor.id, supplier_id: actor.supplier, order_id: target }, actor.id, actor.supplier);
    body = orderEditPayload(seed, operation, payPrice.value, gainIntegral.value);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '编辑内容无效'; return; }
  confirming = true;
  try { await ElMessageBox.confirm(`订单 ${seed.values.order_id}：实际支付金额 ${body.pay_price}，赠送积分 ${body.gain_integral}。确认保存？`, '修改未付款订单', { type: 'warning', confirmButtonText: '确认保存' }); }
  catch { return; } finally { confirming = false; }
  if (!canSave.value || !active() || generation !== ticket || version !== formVersion || target !== id.value || source.value !== seed) return;
  saving.value = true; error.value = ''; notice.value = '';
  try {
    const key = orderEditStorageKey(actor.id, actor.supplier);
    sessionStorage.setItem(key, JSON.stringify(operation));
    const stored = parsePendingOrderEdit(JSON.parse(sessionStorage.getItem(key) ?? 'null'), actor.id, actor.supplier);
    if (JSON.stringify(stored) !== JSON.stringify(operation)) throw Error('无法确认原操作记录已保存');
    pending.value = operation;
    const receipt = await saveOrderEdit(operation, body);
    if (active() && ticket === generation) await accept(receipt, operation);
  } catch (cause) {
    if (active() && ticket === generation) {
      if (!pending.value) storageError.value = cause instanceof Error ? cause.message : '无法保存原操作记录，尚未提交';
      else notice.value = '编辑请求结果待确认，请核对原操作后继续。';
    }
  } finally { if (ticket === generation) saving.value = false; }
}
async function recover(resolve = false) {
  if (!active() || !pending.value || saving.value || recovering.value) return;
  const operation = pending.value, ticket = generation; recovering.value = true; notice.value = '';
  try { const result = await recoverOrderEdit(operation, resolve); if (active() && ticket === generation) await accept(result, operation); }
  catch (cause) { if (active() && ticket === generation) notice.value = cause instanceof Error ? cause.message : '原编辑结果尚未核对成功'; }
  finally { if (ticket === generation) recovering.value = false; }
}
async function reload() {
  if (!active() || pending.value || storageError.value || saving.value || loading.value || recoveryOnly.value) return;
  const ticket = generation;
  if (source.value) {
    confirming = true;
    try { await ElMessageBox.confirm('重新载入会替换当前金额与积分草稿。', '重新载入订单', { type: 'warning' }); }
    catch { return; } finally { confirming = false; }
  }
  if (active() && ticket === generation && !pending.value) await load();
}
watch(() => route.fullPath, () => {
  generation++; readController?.abort(); saving.value = recovering.value = false; notice.value = '';
  if (confirming) ElMessageBox.close(); readPending(); void load();
}, { flush: 'sync' });
onMounted(() => { readPending(); void load(); });
onBeforeUnmount(() => { disposed = true; generation++; readController?.abort(); session.dispose(); if (confirming) ElMessageBox.close(); });
</script>

<template>
  <section class="order-edit-page">
    <header><div><h1>{{ recoveryOnly ? '订单编辑结果' : '修改未付款订单' }}</h1><p>核对订单金额与赠送积分，保存后等待买家付款。</p></div><el-button @click="router.push('/orders')">返回订单列表</el-button></header>
    <el-alert v-if="error || storageError" :title="error || storageError" type="error" :closable="false" show-icon />
    <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon />
    <article v-if="pending" class="surface" role="status">
      <h2>订单编辑结果待确认</h2><p>订单 #{{ pending.order_id }} · 操作 {{ pending.operation_id }}。请先核对原请求，当前窗口已暂停保存。</p>
      <div class="actions"><el-button :loading="recovering" :disabled="invalidated || saving || recovering" @click="recover(false)">查询编辑结果</el-button><el-button :disabled="invalidated || saving || recovering" @click="recover(true)">确认原事务结果</el-button></div>
    </article>
    <p v-if="loading" role="status">正在读取订单…</p>
    <article v-if="source && !recoveryOnly" class="surface">
      <el-form label-position="top" :disabled="!canSave">
        <div class="readonly-grid">
          <el-form-item label="订单编号"><el-input :model-value="source.values.order_id" readonly /></el-form-item>
          <el-form-item label="商品总价"><el-input :model-value="source.values.total_price" readonly /></el-form-item>
          <el-form-item label="原始邮费"><el-input :model-value="source.values.total_postage" readonly /></el-form-item>
          <el-form-item label="实际支付邮费"><el-input :model-value="source.values.pay_postage" readonly /></el-form-item>
        </div>
        <el-form-item label="实际支付金额"><el-input v-model="payPrice" inputmode="decimal" maxlength="13" /></el-form-item>
        <el-form-item label="赠送积分"><el-input v-model="gainIntegral" inputmode="numeric" maxlength="10" /></el-form-item>
      </el-form>
      <p class="hint">仅未付款且未发起支付的订单可修改；订单编号、商品总价与邮费保持原值。</p>
      <el-button type="primary" :disabled="!canSave" :loading="saving" @click="save">保存修改</el-button>
    </article>
    <el-button v-if="!recoveryOnly && !pending && !storageError" :disabled="loading || saving || invalidated" @click="reload">重新载入订单</el-button>
    <el-alert v-if="recoveryOnly && !pending && !storageError && !notice" title="本窗口没有待确认的订单编辑操作" type="info" :closable="false" />
  </section>
</template>

<style scoped>
.order-edit-page { display: grid; gap: 20px; max-width: 960px; margin: 0 auto; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
h1 { margin: 0 0 8px; font-size: 24px; } h2 { margin: 0 0 10px; font-size: 18px; }
p { margin: 0; line-height: 1.6; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
article { padding: 24px; } .readonly-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 20px; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; } .hint { margin: 0 0 20px; font-size: 13px; }
@media (max-width: 600px) { header { align-items: flex-start; flex-direction: column; } article { padding: 18px; } .readonly-grid { grid-template-columns: 1fr; } }
</style>
