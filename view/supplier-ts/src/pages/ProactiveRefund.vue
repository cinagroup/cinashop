<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { previewMode } from '@/api/supplier';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { formatMoney, payType } from '@/utils/format';
import { getProactiveRefundSeed, parsePendingProactiveRefund, proactiveRefundPayload, proactiveRefundStorageKey,
  recoverProactiveRefund, saveProactiveRefund, type PendingProactiveRefund, type ProactiveRefundReceipt,
  type ProactiveRefundSeed } from '@/api/proactiveRefund';

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const actor = { id: Number(auth.user?.id), supplier: Number(auth.user?.supplier_id) };
const source = ref<ProactiveRefundSeed | null>(null), amount = ref(''), action = ref<1 | 2>(1), cashConfirmed = ref(false);
const pending = ref<PendingProactiveRefund | null>(null), receipt = ref<ProactiveRefundReceipt | null>(null);
const error = ref(''), storageError = ref(''), notice = ref('');
const loading = ref(false), saving = ref(false), recovering = ref(false), invalidated = ref(false);
let generation = 0, formVersion = 0, disposed = false, confirming = false, readController: AbortController | undefined;
const recoveryOnly = computed(() => route.path === '/orders/refund-result');
const id = computed(() => typeof route.params.id === 'string' && /^[1-9]\d{0,9}$/.test(route.params.id)
  && Number(route.params.id) <= 2147483647 ? Number(route.params.id) : 0);
const session = createSupplierSessionScope(() => {
  invalidated.value = true; generation++; readController?.abort(); source.value = null; amount.value = ''; cashConfirmed.value = false;
  pending.value = null; receipt.value = null; notice.value = ''; error.value = '会话已变化，请重新进入订单页';
  if (confirming) ElMessageBox.close();
}, previewMode);
const active = () => !disposed && !invalidated.value && session.isCurrent();
const canWrite = computed(() => active() && !previewMode && !recoveryOnly.value && auth.can('supplier.order.manage')
  && !!source.value && source.value.order_id === id.value && !loading.value && !saving.value && !recovering.value && !pending.value && !storageError.value);
const cashRequired = computed(() => action.value === 1 && source.value?.settlement === 'cash');
const title = computed(() => recoveryOnly.value ? '主动退款结果' : source.value?.kind === 'money' ? '补退货款' : '主动退款');
watch([amount, action, cashConfirmed], () => { formVersion++; }, { flush: 'sync' });
watch([amount, action], () => { cashConfirmed.value = false; }, { flush: 'sync' });
function readPending() {
  pending.value = null; storageError.value = '';
  try {
    const raw = sessionStorage.getItem(proactiveRefundStorageKey(actor.id, actor.supplier));
    if (raw) pending.value = parsePendingProactiveRefund(JSON.parse(raw), actor.id, actor.supplier);
    else if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !Number.isSafeInteger(actor.supplier) || actor.supplier <= 0) throw Error('供应商身份无效');
  } catch (cause) { storageError.value = cause instanceof Error ? cause.message : '无法读取原退款记录'; }
}
async function load(fromRoute = false) {
  if (!active() || loading.value || saving.value || recovering.value || confirming && !fromRoute) return;
  const ticket = ++generation; readController?.abort(); readController = new AbortController();
  source.value = null; amount.value = ''; cashConfirmed.value = false; action.value = 1; error.value = '';
  if (recoveryOnly.value || pending.value || storageError.value) return;
  if (previewMode || !id.value || Object.keys(route.query).length) { error.value = '请从已登录的真实订单进入主动退款'; return; }
  loading.value = true;
  try {
    const seed = await getProactiveRefundSeed(id.value, readController.signal);
    if (active() && ticket === generation && seed.order_id === id.value) { source.value = seed; amount.value = seed.amount; receipt.value = null; notice.value = ''; }
  } catch (cause) { if (active() && ticket === generation) error.value = cause instanceof Error ? cause.message : '读取可退金额失败'; }
  finally { if (ticket === generation) loading.value = false; }
}
async function accept(result: ProactiveRefundReceipt, operation: PendingProactiveRefund) {
  if (!active() || pending.value?.operation_id !== operation.operation_id) return;
  if (result.state === 'unknown') { notice.value = '原退款结果尚未确认。请稍后查询，或核对原事务结果。'; return; }
  const key = proactiveRefundStorageKey(actor.id, actor.supplier);
  if (sessionStorage.getItem(key) !== JSON.stringify(operation)) throw Error('原操作记录已变化，请保留记录并核对');
  sessionStorage.removeItem(key);
  if (sessionStorage.getItem(key) !== null) throw Error('原结果已核对，但本窗口记录未能清除，请保留原操作继续查询');
  pending.value = null; source.value = null; amount.value = ''; cashConfirmed.value = false; receipt.value = result;
  if (result.state === 'not_applied') { notice.value = '原操作已确认未提交。重新核对当前订单后可再次处理。'; return; }
  notice.value = ''; ElMessage.success(result.result!.kind === 'refuse' ? '已拒绝本次退款' : result.result!.kind === 'money' ? '货款补退已完成' : '整单退款已完成');
}
async function save() {
  if (!canWrite.value || !source.value || confirming) return;
  const seed = source.value, ticket = generation, version = formVersion;
  let operation: PendingProactiveRefund, body: ReturnType<typeof proactiveRefundPayload>;
  try {
    operation = parsePendingProactiveRefund({ operation_id: crypto.randomUUID(), actor_id: actor.id, supplier_id: actor.supplier, order_id: seed.order_id }, actor.id, actor.supplier);
    body = proactiveRefundPayload(seed, operation, amount.value, action.value, cashConfirmed.value);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '退款内容无效'; return; }
  confirming = true;
  const message = body.type === 2 ? seed.kind === 'money'
    ? `订单 ${seed.order_no}：确认拒绝本次补退 ${formatMoney(body.refund_price)}？本次不退还货款，累计已退 ${formatMoney(seed.refunded)} 和已完成商品处理保持不变。`
    : `订单 ${seed.order_no}：确认拒绝本次退款？不会退还货款。`
    : `订单 ${seed.order_no}：本次${seed.kind === 'money' ? '补退货款' : '整单退款'} ${formatMoney(body.refund_price)}。${seed.kind === 'goods' ? `将退回全部 ${seed.quantity} 件商品。` : '商品退货已完成，本次只退货款。'}`;
  try { await ElMessageBox.confirm(message, body.type === 2 ? '拒绝退款' : title.value, { type: 'warning', confirmButtonText: '确认已核对', cancelButtonText: '取消' }); }
  catch { return; } finally { confirming = false; }
  if (!active() || !canWrite.value || ticket !== generation || version !== formVersion || source.value !== seed) return;
  const key = proactiveRefundStorageKey(actor.id, actor.supplier), serialized = JSON.stringify(operation);
  try {
    if (sessionStorage.getItem(key)) { readPending(); notice.value = '存在原操作待确认，请先查询结果'; return; }
    sessionStorage.setItem(key, serialized);
    if (sessionStorage.getItem(key) !== serialized) throw Error('原退款记录未能保存，不能提交');
  } catch (cause) { storageError.value = cause instanceof Error ? cause.message : '无法保存原操作'; return; }
  pending.value = operation; saving.value = true; error.value = ''; notice.value = ''; receipt.value = null;
  try { const result = await saveProactiveRefund(seed, operation, body); if (active() && ticket === generation) await accept(result, operation); }
  catch (cause) { if (active() && ticket === generation) notice.value = `${cause instanceof Error ? cause.message : '退款请求结果未知'}。请先查询原操作结果。`; }
  finally { if (ticket === generation) saving.value = false; }
}
async function recover(resolve = false) {
  if (!active() || !pending.value || saving.value || recovering.value || confirming) return;
  const operation = pending.value, ticket = generation;
  if (resolve) {
    confirming = true;
    try { await ElMessageBox.confirm('核对这次原退款事务。已完成则读取原结果；确认未提交后，才可重新核对当前订单。', '核对原事务结果', { type: 'warning', confirmButtonText: '确认核对', cancelButtonText: '取消' }); }
    catch { return; } finally { confirming = false; }
  }
  if (!active() || ticket !== generation || pending.value?.operation_id !== operation.operation_id) return;
  recovering.value = true; notice.value = '';
  try { const result = await recoverProactiveRefund(operation, resolve); if (active() && ticket === generation) await accept(result, operation); }
  catch (cause) { if (active() && ticket === generation) notice.value = cause instanceof Error ? cause.message : '原结果尚未核对成功'; }
  finally { if (ticket === generation) recovering.value = false; }
}
watch(() => route.fullPath, () => {
  generation++; readController?.abort(); loading.value = saving.value = recovering.value = false; notice.value = ''; receipt.value = null;
  source.value = null; amount.value = ''; cashConfirmed.value = false; error.value = '';
  if (confirming) ElMessageBox.close(); readPending(); void load(true);
}, { flush: 'sync' });
onMounted(() => { readPending(); void load(); });
onBeforeUnmount(() => { disposed = true; generation++; readController?.abort(); session.dispose(); if (confirming) ElMessageBox.close(); });
</script>

<template>
  <section class="proactive-refund-page">
    <header><div><h1>{{ title }}</h1><p>按当前订单核对实际退款金额，并保留每次处理结果。</p></div><el-button @click="router.push('/orders')">返回订单列表</el-button></header>
    <el-alert v-if="error || storageError" :title="error || storageError" type="error" :closable="false" show-icon />
    <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon />
    <article v-if="pending" class="surface" role="status">
      <h2>退款结果待确认</h2><p>订单 #{{ pending.order_id }} · 原操作 {{ pending.operation_id }}</p>
      <p>先核对这次结果，再处理其他退款。</p>
      <div class="actions"><el-button :loading="recovering" :disabled="invalidated || saving || recovering" @click="recover(false)">查询原操作结果</el-button>
        <el-button :disabled="invalidated || saving || recovering" @click="recover(true)">核对原事务结果</el-button></div>
    </article>
    <p v-if="loading" role="status">正在核对当前可退金额…</p>
    <article v-if="source && !recoveryOnly && !pending" class="surface">
      <h2>{{ source.kind === 'money' ? '补退剩余货款' : '整单退款' }}</h2>
      <dl><div><dt>订单编号</dt><dd>{{ source.order_no }}</dd></div><div><dt>原支付方式</dt><dd>{{ payType(source.pay_type) }}</dd></div>
        <div><dt>实付金额</dt><dd>{{ formatMoney(source.paid) }}</dd></div><div><dt>累计已退货款</dt><dd>{{ formatMoney(source.refunded) }}</dd></div>
        <div><dt>当前可退货款</dt><dd class="amount">{{ formatMoney(source.amount) }}</dd></div></dl>
      <p>{{ source.kind === 'money' ? action === 2 ? '本次只拒绝补退货款，累计已退金额和已完成商品处理保持不变；需要继续补退时，请重新核对当前可退金额。' : '商品退货已完成。本次只补退货款，不重复退回商品或积分。' : `本次将退回全部 ${source.quantity} 件商品；货款可在可退金额内填写。` }}</p>
      <el-alert v-if="source.settlement === 'provider'" title="此订单暂不支持原渠道退款，可处理拒绝退款。" type="info" :closable="false" />
      <div class="form-fields">
        <label for="proactive-refund-action">处理方式
          <el-select id="proactive-refund-action" v-model="action" :disabled="!canWrite"><el-option :value="1" :label="source.kind === 'money' ? '补退货款' : '退款'" /><el-option :value="2" :label="source.kind === 'money' ? '拒绝本次补退' : '拒绝退款'" /></el-select></label>
        <label for="proactive-refund-amount">{{ action === 2 ? '本次核对金额' : '本次实际退款金额' }}
          <el-input id="proactive-refund-amount" v-model="amount" inputmode="decimal" :disabled="!canWrite" maxlength="13" /></label>
        <el-checkbox v-if="cashRequired" v-model="cashConfirmed" :disabled="!canWrite">我已向买家实际退还本次填写的现金</el-checkbox>
        <p v-else-if="action === 1 && source.settlement === 'balance'">本次款项将退回买家的账户余额。</p>
        <p v-else-if="action === 1 && source.settlement === 'zero'">本单实付为零，无需资金交接。</p>
      </div>
      <div class="actions"><el-button type="primary" :loading="saving" :disabled="!canWrite || (cashRequired && !cashConfirmed) || (action === 1 && source.settlement === 'provider')" @click="save">{{ action === 2 ? source.kind === 'money' ? '确认拒绝本次补退' : '确认拒绝退款' : source.kind === 'money' ? '确认补退货款' : '确认整单退款' }}</el-button></div>
    </article>
    <article v-if="receipt?.state === 'committed' && receipt.result" class="surface" role="status">
      <h2>{{ receipt.result.kind === 'refuse' ? '本次退款已拒绝' : receipt.result.kind === 'money' ? '货款补退已完成' : '整单退款已完成' }}</h2>
      <p>订单 #{{ receipt.order_id }} · {{ receipt.result.kind === 'refuse' ? '核对金额' : '本次已退' }} {{ formatMoney(receipt.result.amount) }}</p>
      <p v-if="receipt.result.kind === 'refuse'">本次未新增退款；此前已退货款和已完成的商品处理保持不变。继续处理前请重新核对当前可退金额。</p>
      <p>原操作 {{ receipt.operation_id }}</p>
      <el-button v-if="recoveryOnly && auth.can('supplier.order.manage')" class="result-link" @click="router.push(`/orders/${receipt.order_id}/refund`)">核对订单可退金额</el-button>
    </article>
    <el-button v-if="!recoveryOnly && !pending && !storageError" :disabled="loading || saving || recovering || invalidated" @click="load()">重新核对可退金额</el-button>
    <el-alert v-if="recoveryOnly && !pending && !storageError && !notice && !receipt" title="本窗口没有待确认的主动退款" type="info" :closable="false" />
  </section>
</template>

<style scoped>
.proactive-refund-page { display: grid; gap: 20px; max-width: 960px; margin: 0 auto; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
h1 { margin: 0 0 8px; font-size: 24px; } h2 { margin: 0 0 16px; font-size: 18px; }
p, dd { overflow-wrap: anywhere; } p { margin: 0 0 10px; color: var(--el-text-color-secondary); line-height: 1.7; }
article { padding: 24px; } dl { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 0 0 24px; }
dt { color: var(--el-text-color-secondary); margin-bottom: 6px; } dd { margin: 0; } .amount { font-size: 24px; font-weight: 600; }
.form-fields { display: grid; gap: 18px; max-width: 440px; margin-top: 24px; } label { display: grid; gap: 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; } .result-link { margin-top: 16px; }
:deep(.el-checkbox) { max-width: 100%; height: auto; } :deep(.el-checkbox__label) { white-space: normal; }
@media (max-width: 600px) { header { align-items: flex-start; flex-direction: column; } article { padding: 18px; } dl { grid-template-columns: 1fr; } }
</style>
