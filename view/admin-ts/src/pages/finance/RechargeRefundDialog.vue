<template>
  <el-dialog :model-value="true" title="充值原路退款" width="min(700px, calc(100vw - 24px))" :close-on-click-modal="false" @close="close">
    <p class="hint">{{ orderNo }} · 全额本金退回原支付渠道</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="space" />
    <el-alert v-if="invalidated" title="操作身份已变化，请关闭后重新进入" type="warning" :closable="false" show-icon />
    <div v-loading="busy">
      <template v-if="intent && !restarting">
        <el-alert :title="statusText" :type="confirmed && intent.view?.execution.phase === 'succeeded' ? 'success' : 'warning'" :closable="false" show-icon class="space" />
        <el-descriptions :column="1" border class="space">
          <el-descriptions-item label="申请编号"><span class="request-key">{{ intent.key }}</span></el-descriptions-item>
          <el-descriptions-item v-if="intent.view?.receipt.principal || intent.review" label="退款本金">¥{{ intent.view?.receipt.principal ?? intent.review?.principal }}</el-descriptions-item>
          <el-descriptions-item v-if="intent.view?.receipt.recoverGift !== null && (intent.view || intent.review)" label="赠送额处理">{{ (intent.view?.receipt.recoverGift ?? intent.review?.recoverGift) ? '收回原赠送余额' : '保留原赠送余额' }}</el-descriptions-item>
          <el-descriptions-item v-if="intent.view?.receipt.balanceBefore || intent.review" label="受理前余额">¥{{ intent.view?.receipt.balanceBefore ?? intent.review?.availableBalance }}</el-descriptions-item>
          <el-descriptions-item v-if="intent.view?.receipt.postBalance || intent.review" label="受理后余额">¥{{ intent.view?.receipt.postBalance ?? intent.review?.postBalance }}</el-descriptions-item>
        </el-descriptions>
        <p v-if="!intent.body" class="hint">已通过原申请编号恢复。原方案不在本机，不会重建或重新提交。</p>
        <p v-if="intent.view?.execution.nextQueryAt" class="hint">下一次渠道核对时间：{{ rechargeOrderTime(intent.view.execution.nextQueryAt) }}</p>
        <p class="hint">关闭、刷新或断网后，可继续读取这份申请。待核对期间请勿改用新申请。</p>
        <div class="controls space">
          <el-button :disabled="unavailable" @click="lookup">读取原申请状态</el-button>
          <el-button v-if="canQuery" :disabled="unavailable || !queryDue" @click="action('query')">查询并完成退款</el-button>
          <el-button v-if="intent.body && intent.view?.execution.phase === 'not_requested'" type="primary" :disabled="unavailable" @click="openConfirmation('execute')">继续原退款申请</el-button>
          <el-button v-if="intent.view?.execution.phase === 'not_requested'" :disabled="unavailable" @click="openConfirmation('cancel')">撤销未派发申请</el-button>
          <el-button v-if="intent.body && !intent.view" :disabled="unavailable || !lookedUp" @click="openConfirmation('abandon')">封存未受理申请</el-button>
          <el-button v-if="rechargeRefundRetryable(intent.view)" type="primary" :disabled="unavailable" @click="restart">重新申请退款</el-button>
        </div>
      </template>
      <template v-else-if="!localBroken && !invalidated">
        <template v-if="quote">
          <el-descriptions :column="1" border class="space">
            <el-descriptions-item label="退款本金">¥{{ quote.options[0].principal }}</el-descriptions-item>
            <el-descriptions-item label="原赠送额">¥{{ quote.options[0].gift }}</el-descriptions-item>
            <el-descriptions-item label="当前钱包余额">¥{{ quote.options[0].availableBalance }}</el-descriptions-item>
          </el-descriptions>
          <fieldset :disabled="unavailable" class="choice space"><legend>赠送额处理</legend>
            <label><input v-model="recoverGift" type="radio" :value="true" name="recharge-refund-gift" /> 退本金并收回原赠送余额</label>
            <label><input v-model="recoverGift" type="radio" :value="false" name="recharge-refund-gift" /> 仅退本金，保留原赠送余额</label>
          </fieldset>
          <p v-if="selected" class="amount">钱包需扣除 ¥{{ debitText }}，退款后余额 ¥{{ selected.postBalance }}</p>
          <el-alert v-if="selected && !selected.sufficient" title="当前方案余额不足，不能发起退款；请人工处理或选择可用方案" type="warning" :closable="false" show-icon />
          <div class="controls space"><el-button :disabled="unavailable" @click="loadQuote">刷新方案</el-button>
            <el-button type="primary" :disabled="unavailable || !selected?.sufficient" @click="openConfirmation('new')">核对全额退款</el-button>
            <el-button v-if="restarting" :disabled="unavailable" @click="restarting = false; quote = null">返回原申请</el-button>
          </div>
        </template>
        <el-button v-else :disabled="unavailable" @click="loadQuote">重新读取退款方案</el-button>
        <details v-if="!intent" class="space"><summary>已有申请编号？恢复原申请</summary>
          <label class="recovery">原申请编号<el-input v-model="recoveryKey" :disabled="unavailable" maxlength="36" placeholder="输入原申请编号" /></label>
          <el-button :disabled="unavailable || !recoveryKey.trim()" @click="recover">读取原申请</el-button>
        </details>
      </template>
      <el-button v-if="externalChange && !busy" class="space" @click="initialize">重新读取本机申请</el-button>
      <div v-if="confirm" class="confirmation space" role="alertdialog" aria-label="确认充值退款操作">
        <h3>{{ confirm.mode === 'new' || confirm.mode === 'execute' ? '确认原路退回全部本金' : confirm.mode === 'cancel' ? '确认撤销尚未派发的申请' : '确认封存尚未受理的申请' }}</h3>
        <p v-if="confirm.mode === 'new'">本金 ¥{{ selected?.principal }}；{{ recoverGift ? `收回赠送额 ¥${selected?.gift}` : '保留赠送额' }}。请确认此充值订单。</p>
        <p v-else-if="confirm.mode === 'execute'">继续同一份申请，不创建新的退款申请。</p>
        <p v-else-if="confirm.mode === 'cancel'">仅在渠道尚未派发时撤销，并退回预留余额；服务端会重新核对。</p>
        <p v-else>封存原申请编号。若服务端已受理，将继续保留已有退款，不能用封存替代撤销。</p>
        <div class="controls"><el-button :disabled="busy" @click="confirm.cancel">返回核对</el-button><el-button type="danger" :disabled="unavailable" @click="confirm.submit">确认提交</el-button></div>
      </div>
    </div>
    <template #footer><el-button @click="close">关闭</el-button></template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { getAdminSession } from '@/utils/auth';
import { rechargeOrderTime } from '@/api/rechargeOrders';
import { apiRechargeRefundAction, apiRechargeRefundQuote, type RechargeRefundAction } from '@/api/rechargeRefund';
import { makeRechargeRefundIntent, readRechargeRefundIntent, rechargeRefundRetryable, rechargeRefundStatus, rechargeRefundStorageKey,
  recoverRechargeRefundIntent, withRechargeRefundLock, writeRechargeRefundIntent, type RechargeRefundIntent, type RechargeRefundQuote } from '@/utils/rechargeRefund';

const props = defineProps<{ actorId: number; rechargeId: number; orderNo: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const actorId = props.actorId, rechargeId = props.rechargeId;
const intent = ref<RechargeRefundIntent | null>(null), quote = ref<RechargeRefundQuote | null>(null), recoverGift = ref(true), error = ref('');
const busy = ref(false), invalidated = ref(false), externalChange = ref(false), localBroken = ref(false), restarting = ref(false), lookedUp = ref(false), recoveryKey = ref('');
const confirmed = ref(false);
type Confirmation = { mode: 'new' | 'execute' | 'cancel' | 'abandon'; raw: string | null; generation: number; quote: RechargeRefundQuote | null; gift: boolean; submit: () => Promise<void>; cancel: () => void };
const confirm = ref<Confirmation | null>(null), now = ref(Math.floor(Date.now() / 1000));
let raw: string | null = null, alive = true, changed = false, generation = 0, timer: ReturnType<typeof setInterval> | undefined;
const session = createAdminSessionScope(() => { invalidated.value = true; generation++; intent.value = null; quote.value = null; confirm.value = null; });
const owns = () => alive && session.isCurrent() && !invalidated.value && props.actorId === actorId && props.rechargeId === rechargeId && getAdminSession()?.userInfo.id === actorId;
const current = (version: number) => owns() && generation === version && !externalChange.value;
const unavailable = computed(() => busy.value || invalidated.value || localBroken.value || externalChange.value);
const statusText = computed(() => intent.value?.view && !confirmed.value ? `上次记录：${rechargeRefundStatus(intent.value.view)}（待服务端核对）` : rechargeRefundStatus(intent.value?.view ?? null));
const selected = computed(() => quote.value?.options.find(o => o.recoverGift === recoverGift.value) ?? null);
const debitText = computed(() => { const n = BigInt(selected.value?.walletDebitCents ?? 0); return n / 100n + '.' + (n % 100n).toString().padStart(2, '0'); });
const canQuery = computed(() => !!intent.value && ['awaiting_provider', 'awaiting_local'].includes(intent.value.view?.execution.phase ?? ''));
const queryDue = computed(() => !intent.value?.view?.execution.nextQueryAt || now.value >= intent.value.view.execution.nextQueryAt);
watch(recoverGift, () => { confirm.value = null; }, { flush: 'sync' });
watch(() => [props.actorId, props.rechargeId, props.orderNo], () => { invalidated.value = true; generation++; session.dispose(); intent.value = null; quote.value = null; confirm.value = null; }, { flush: 'sync' });
function close() { emit('close'); }
function message(e: unknown) { return e instanceof Error ? e.message : '请求未完成，请保留原申请'; }
async function run(work: (version: number) => Promise<void>) {
  if (busy.value || !owns() || externalChange.value || localBroken.value) return;
  busy.value = true; error.value = ''; const version = generation;
  try { await withRechargeRefundLock(rechargeId, async () => { if (current(version)) await work(version); }); }
  catch (e) { if (current(version)) error.value = message(e); }
  finally { if (alive) busy.value = false; }
}
async function checked(version: number) {
  const saved = await readRechargeRefundIntent(actorId, rechargeId);
  if (!current(version)) throw Error('操作已失效');
  if (saved.raw !== raw) { externalChange.value = true; confirm.value = null; throw Error('另一标签页已更新原申请，请重新读取'); }
  return saved.intent;
}
function persist(value: RechargeRefundIntent, version: number) {
  if (!current(version)) throw Error('操作已失效'); raw = writeRechargeRefundIntent(value, raw); intent.value = value;
}
async function refreshIntent(value: RechargeRefundIntent, mode: RechargeRefundAction, version: number) {
  confirmed.value = false; lookedUp.value = false;
  const result = await apiRechargeRefundAction(value, mode, session.signal);
  if (!current(version)) return; persist(result, version); confirmed.value = !!result.view; lookedUp.value = mode === 'lookup';
  if (result.view && result.view.execution.phase !== 'not_requested') { changed = true; emit('changed'); }
  if (!result.view) error.value = mode === 'abandon' ? '服务端可能已有受理记录，请继续读取原申请状态' : '暂未查到完整回执，请保留原申请；不会自动重发';
}
async function initialize() {
  if (busy.value || !owns()) return; generation++; externalChange.value = localBroken.value = confirmed.value = false; confirm.value = null; error.value = ''; restarting.value = false;
  busy.value = true; const version = generation;
  try { await withRechargeRefundLock(rechargeId, async () => {
    const saved = await readRechargeRefundIntent(actorId, rechargeId); if (!current(version)) return; raw = saved.raw; intent.value = saved.intent; quote.value = null;
    if (saved.intent) await refreshIntent(saved.intent, 'lookup', version);
    else { const q = await apiRechargeRefundQuote(actorId, rechargeId, session.signal); if (q.orderNo !== props.orderNo) throw Error('充值记录已变化，请关闭并刷新列表'); if (current(version)) quote.value = q; }
  }); } catch (e) {
    if (current(version)) { error.value = message(e); if (!intent.value && localStorage.getItem(rechargeRefundStorageKey(actorId, rechargeId)) !== null) localBroken.value = true; }
  } finally { if (alive) busy.value = false; }
}
async function loadQuote() { await run(async version => {
  const saved = await checked(version); if (saved && !restarting.value) return;
  const q = await apiRechargeRefundQuote(actorId, rechargeId, session.signal); if (q.orderNo !== props.orderNo) throw Error('充值记录已变化，请关闭并刷新列表'); if (current(version)) { quote.value = q; confirm.value = null; }
}); }
async function lookup() { await run(async version => { const saved = await checked(version); if (saved) await refreshIntent(saved, 'lookup', version); }); }
async function action(mode: RechargeRefundAction) { await run(async version => {
  const saved = await checked(version); if (!saved) return;
  if (mode === 'query' && (!canQuery.value || !queryDue.value)) return;
  await refreshIntent(saved, mode, version);
}); }
async function recover() { await run(async version => {
  if (await checked(version)) return;
  const saved = recoverRechargeRefundIntent(actorId, rechargeId, recoveryKey.value); persist(saved, version); quote.value = null;
  await refreshIntent(saved, 'lookup', version);
}); }
async function restart() { await run(async version => {
  const saved = await checked(version); if (!saved) return;
  const fresh = await apiRechargeRefundAction(saved, 'lookup', session.signal); if (!current(version)) return; persist(fresh, version);
  if (!rechargeRefundRetryable(fresh.view)) return;
  const q = await apiRechargeRefundQuote(actorId, rechargeId, session.signal); if (q.orderNo !== props.orderNo) throw Error('充值记录已变化，请关闭并刷新列表'); if (current(version)) { quote.value = q; recoverGift.value = true; restarting.value = true; }
}); }
function openConfirmation(mode: Confirmation['mode']) {
  if (unavailable.value || !owns()) return;
  const c: Confirmation = { mode, raw, generation, quote: quote.value, gift: recoverGift.value,
    submit: () => commit(c), cancel: () => { if (confirm.value?.submit === c.submit) confirm.value = null; } };
  confirm.value = c;
}
async function commit(c: Confirmation) {
  if (confirm.value?.submit !== c.submit || c.generation !== generation || c.raw !== raw) return;
  const operation = c.mode;
  // Disable/capture synchronously so retained callbacks and double clicks do
  // not mint another key while the first request is in flight.
  confirm.value = null;
  await run(async version => {
    const saved = await checked(version);
    if (operation === 'new') {
      if (!c.quote || !c.quote.options.find(o => o.recoverGift === c.gift)?.sufficient || saved && (!restarting.value || !rechargeRefundRetryable(saved.view))) return;
      const next = await makeRechargeRefundIntent(actorId, c.quote, c.gift); if (!current(version)) return;
      persist(next, version); quote.value = null; restarting.value = false; lookedUp.value = false;
      await refreshIntent(next, 'execute', version);
    } else if (saved) {
      if (operation === 'execute' && saved.view?.execution.phase !== 'not_requested' || operation === 'cancel' && saved.view?.execution.phase !== 'not_requested'
        || operation === 'abandon' && (!lookedUp.value || saved.view !== null)) return;
      await refreshIntent(saved, operation, version);
    }
  });
}
function storage(event: StorageEvent) {
  if (event.storageArea === localStorage && (event.key === null || event.key === rechargeRefundStorageKey(actorId, rechargeId))) {
    externalChange.value = true; confirmed.value = false; generation++; confirm.value = null; quote.value = null; error.value = '另一标签页已更新申请，请重新读取本机申请';
  }
}
onMounted(() => { window.addEventListener('storage', storage); timer = setInterval(() => { now.value = Math.floor(Date.now() / 1000); }, 1000); void initialize(); });
onBeforeUnmount(() => { alive = false; generation++; session.dispose(); if (timer) clearInterval(timer); window.removeEventListener('storage', storage); if (changed) changed = false; });
</script>

<style scoped>
.hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }.space { margin-top: 16px; }.controls { display: flex; gap: 10px; flex-wrap: wrap; }.controls :deep(.el-button + .el-button) { margin-left: 0; }
.choice { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 12px; display: grid; gap: 12px; }.choice label { display: flex; gap: 8px; align-items: center; }.amount { font-weight: 600; line-height: 1.7; }.request-key { overflow-wrap: anywhere; }
.recovery { display: grid; gap: 8px; margin: 12px 0; }.confirmation { border: 1px solid var(--el-color-warning-light-5); background: var(--el-color-warning-light-9); padding: 16px; border-radius: 6px; }.confirmation h3 { margin-top: 0; }.confirmation p { line-height: 1.7; }
@media (max-width: 560px) { .controls .el-button { width: 100%; }.choice label { align-items: flex-start; } }
</style>
