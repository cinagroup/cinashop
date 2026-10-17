<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { previewMode } from '@/api/supplier';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { supplierBillMoney } from '@/api/supplierBills';
import { getExtractApplicationSeed, makeExtractApplicationIntent, normalizeExtractApplicationMoney, parsePendingExtractApplication, extractApplicationRequestHash,
  extractApplicationStorageKey, reserveExtractApplication, clearExtractApplication, submitExtractApplication, recoverExtractApplication,
  type ExtractApplicationType, type ExtractApplicationSeed, type PendingExtractApplication,
  type ExtractApplicationReceipt } from '@/api/supplierExtractApplication';
import { extractHistoricalPrivateMediaId } from '@/api/supplierExtractMedia';
import { ExtractSeedMediaChanged, extractSeedQrImage, extractReceiptQrImage, readExtractSeedMedia, readExtractReceiptMedia,
  type ExtractSeedMedia, type ExtractReceiptMedia } from '@/api/supplierExtractApplicationMedia';

const auth = useAuthStore(), route = useRoute(), router = useRouter();
const actor = Object.freeze({ id: Number(auth.user?.id), supplier: Number(auth.user?.supplier_id) });
const recoveryOnly = computed(() => route.path.endsWith('/application-result'));
const routeValid = computed(() => ['/finance/apply', '/finance/application-result'].includes(route.path) && !Object.keys(route.query).length);
const source = ref<ExtractApplicationSeed | null>(null), pending = ref<PendingExtractApplication | null>(null);
const receipt = ref<ExtractApplicationReceipt | null>(null), loading = ref(false), saving = ref(false), recovering = ref(false);
const error = ref(''), storageError = ref(''), notice = ref(''), invalidated = ref(false), confirmed = ref(false), closeConfirmed = ref(false);
const extractType = ref<ExtractApplicationType>('bank'), money = ref(''), mark = ref(''), brokenImages = ref(new Set<string>());
const seedMedia = shallowRef<ExtractSeedMedia>(), receiptMedia = shallowRef<ExtractReceiptMedia>();
const mediaLoading = ref(false), mediaError = ref(''), mediaTime = ref(Math.floor(Date.now() / 1000));
let mediaGeneration = 0, mediaController: AbortController | undefined, mediaTimer: ReturnType<typeof setInterval> | undefined;
let alive = true, generation = 0, formVersion = 0, readController: AbortController | undefined, postController: AbortController | undefined;
let session: ReturnType<typeof createSupplierSessionScope> | undefined;
try { session = createSupplierSessionScope(invalidate); } catch { storageError.value = '本机存储不可读，不能申请或核对提现，请保留原申请记录'; }
const active = () => {
  if (previewMode || !alive || invalidated.value || !routeValid.value) return false;
  try { return !!session?.isCurrent() && !!auth.token && Number(auth.user?.id) === actor.id && Number(auth.user?.supplier_id) === actor.supplier; }
  catch { storageError.value = '本机存储不可读，不能申请或核对提现，请保留原申请记录'; invalidate(); return false; }
};
const canManage = computed(() => active() && auth.can('supplier.finance.view') && auth.can('supplier.finance.manage'));
const canSubmit = computed(() => canManage.value && !recoveryOnly.value && !!source.value?.can_apply && source.value.accounts[extractType.value].ready
  && !pending.value && !storageError.value && !loading.value && !saving.value && !recovering.value && confirmed.value);
const account = computed(() => source.value?.accounts[extractType.value]);
const typeName = (type: string) => type === 'bank' ? '银行卡' : type === 'alipay' ? '支付宝' : '微信';
const displayMoney = (value: string) => supplierBillMoney(value, 1);
const message = (cause: unknown) => cause instanceof Error ? cause.message : '请重新核对提现申请';
function clearMedia() { mediaGeneration++; mediaController?.abort(); seedMedia.value = undefined; receiptMedia.value = undefined; mediaLoading.value = false; mediaError.value = ''; brokenImages.value = new Set(); }
function clearSensitive() { clearMedia(); source.value = null; receipt.value = null; mark.value = ''; money.value = ''; confirmed.value = false; closeConfirmed.value = false; }
function invalidate() {
  if (!alive) return; invalidated.value = true; generation++; readController?.abort(); postController?.abort(); clearSensitive(); pending.value = null;
  loading.value = saving.value = recovering.value = false; notice.value = ''; error.value = '会话、权限或本机原申请已变化，请重新打开页面核对';
}
watch([extractType, money, mark], () => { formVersion++; confirmed.value = false; }, { flush: 'sync' });
watch(extractType, () => { clearMedia(); void loadMedia(); }, { flush: 'sync' });
watch(canManage, (value, previous) => { if (previous && !value) invalidate(); }, { flush: 'sync' });
watch(() => JSON.stringify([auth.token, auth.user?.id, auth.user?.supplier_id, auth.permissions, auth.permissionsLoaded]), invalidate, { flush: 'sync' });
function readPending() {
  pending.value = null; storageError.value = '';
  try {
    const raw = localStorage.getItem(extractApplicationStorageKey(actor.id, actor.supplier));
    if (raw !== null) pending.value = parsePendingExtractApplication(JSON.parse(raw), actor.id, actor.supplier);
  } catch (cause) { storageError.value = '本机原申请记录无法核对，请保留窗口并联系管理员核对历史申请。' + message(cause); }
}
async function load() {
  const ticket = ++generation; readController?.abort(); readController = new AbortController(); clearSensitive(); error.value = ''; notice.value = ''; loading.value = false;
  if (previewMode) { pending.value = null; error.value = '请使用真实登录会话申请或核对提现，预览模式不能提交'; return; }
  if (!routeValid.value) { pending.value = null; error.value = '提现申请入口参数无效，请从财务页面重新进入'; return; }
  readPending(); if (!active() || pending.value || storageError.value || recoveryOnly.value) return;
  if (Object.keys(route.query).length || !canManage.value) { error.value = '请从有财务管理权限的真实供应商会话进入'; return; }
  loading.value = true;
  try { const value = await getExtractApplicationSeed(actor.id, actor.supplier, readController.signal); if (active() && ticket === generation && canManage.value) { source.value = value; void loadMedia(); } }
  catch (cause) { if (active() && ticket === generation) error.value = message(cause); }
  finally { if (ticket === generation) loading.value = false; }
}
const privateSeedQr = computed(() => !!source.value && extractType.value !== 'bank' && !!extractHistoricalPrivateMediaId(source.value.accounts[extractType.value].qrcode_url));
const privateReceiptQr = computed(() => receipt.value?.state === 'committed' && receipt.value.result?.extract_type !== 'bank'
  && !!extractHistoricalPrivateMediaId(receipt.value.result?.qrcode_url ?? ''));
async function loadMedia() {
  if (!active() || mediaLoading.value) return;
  const seed = source.value, original = receipt.value, pageGeneration = generation, channel = extractType.value;
  if (!(seed && privateSeedQr.value && canManage.value) && !(original && privateReceiptQr.value)) return;
  clearMedia(); const ticket = mediaGeneration, controller = new AbortController(); mediaController = controller; mediaLoading.value = true;
  const current = () => active() && generation === pageGeneration && mediaGeneration === ticket && !controller.signal.aborted
    && source.value === seed && receipt.value === original && extractType.value === channel;
  try {
    if (seed && privateSeedQr.value) { const value = await readExtractSeedMedia(seed, controller.signal); if (current()) seedMedia.value = value; }
    else if (original) { const value = await readExtractReceiptMedia(original, controller.signal); if (current()) receiptMedia.value = value; }
    if (current()) mediaTime.value = Math.floor(Date.now() / 1000);
  } catch (cause) {
    if (current()) {
      if (cause instanceof ExtractSeedMediaChanged) { source.value = null; confirmed.value = false; }
      mediaError.value = message(cause);
    }
  } finally { if (active() && generation === pageGeneration && mediaGeneration === ticket) mediaLoading.value = false; }
}
function image(kind: 'seed' | 'receipt') {
  if (!active() || brokenImages.value.has(kind)) return '';
  if (kind === 'seed') return source.value && extractType.value !== 'bank' ? extractSeedQrImage(seedMedia.value, source.value, extractType.value, mediaTime.value) : '';
  return receipt.value ? extractReceiptQrImage(receiptMedia.value, receipt.value, mediaTime.value) : '';
}
function imageError(kind: 'seed' | 'receipt') { if (active()) brokenImages.value = new Set([...brokenImages.value, kind]); }
async function accept(value: ExtractApplicationReceipt, operation: PendingExtractApplication, ticket: number) {
  if (!active() || ticket !== generation || pending.value?.operation_id !== operation.operation_id) return;
  if (value.state === 'unknown') { clearMedia(); receipt.value = null; notice.value = '原申请结果尚未确认，请稍后查询，或核对并封存原申请；核对前不能再次申请。'; return; }
  await clearExtractApplication(operation, () => active() && ticket === generation && pending.value?.operation_id === operation.operation_id);
  if (!active() || ticket !== generation || pending.value?.operation_id !== operation.operation_id) return;
  clearMedia(); pending.value = null; source.value = null; receipt.value = value; confirmed.value = closeConfirmed.value = false; money.value = ''; mark.value = '';
  notice.value = value.state === 'committed' ? '原提现申请已提交，结果来自该次申请的持久记录。当前审核及转账状态请查看提现记录。'
    : '原申请已确认未提交并封存，可重新核对后发起申请。';
  void loadMedia();
}
async function submit() {
  if (!canSubmit.value || !source.value || saving.value) return;
  const seed = source.value, ticket = generation, version = formVersion;
  saving.value = true; error.value = ''; notice.value = ''; postController = new AbortController();
  try {
    const intent = makeExtractApplicationIntent(seed, crypto.randomUUID(), extractType.value, normalizeExtractApplicationMoney(money.value), mark.value.trim());
    const operation = parsePendingExtractApplication({ version: 'supplier-extract-application-pending-v1', operation_id: intent.operation_id,
      actor_id: actor.id, supplier_id: actor.supplier, request_hash: await extractApplicationRequestHash(intent), money: intent.money, extract_type: intent.extract_type }, actor.id, actor.supplier);
    const unchanged = () => active() && ticket === generation && version === formVersion && canManage.value && source.value === seed;
    if (!unchanged()) return;
    await reserveExtractApplication(operation, unchanged);
    if (!active() || ticket !== generation) return;
    const formUnchanged = unchanged();
    // From this point the durable original key remains even if this component
    // disappears. A lost/canceled reply never proves non-application; only
    // the original receipt or a server fence permits a fresh application.
    clearMedia(); pending.value = operation; source.value = null; confirmed.value = false;
    if (!active() || ticket !== generation) return;
    if (!formUnchanged) { notice.value = '提交前申请资料已变化，请先核对并封存原申请；未发送提现申请。'; return; }
    await accept(await submitExtractApplication(intent, operation, () => active() && ticket === generation && pending.value?.operation_id === operation.operation_id, postController.signal), operation, ticket);
  } catch (cause) {
    if (active() && ticket === generation) {
      if (!pending.value) readPending();
      error.value = pending.value ? `${message(cause)}。提交结果待核对，请查询原申请；未自动重发。` : message(cause);
    }
  } finally { if (ticket === generation) saving.value = false; }
}
async function recover(close = false) {
  if (!active() || !pending.value || saving.value || recovering.value || close && !closeConfirmed.value) return;
  const operation = pending.value, ticket = generation; recovering.value = true; error.value = ''; notice.value = '';
  try { await accept(await recoverExtractApplication(operation, close, readController?.signal), operation, ticket); }
  catch (cause) { if (active() && ticket === generation) error.value = `${message(cause)}。原申请仍保留，请继续核对。`; }
  finally { if (ticket === generation) { recovering.value = false; closeConfirmed.value = false; } }
}
function journalChanged(event: Event) {
  const key = (event as StorageEvent).key;
  if (key === null || key === extractApplicationStorageKey(actor.id, actor.supplier)) invalidate();
}
watch(() => route.fullPath, () => { generation++; readController?.abort(); postController?.abort(); clearSensitive(); pending.value = null; saving.value = recovering.value = false; void load(); }, { flush: 'sync' });
onMounted(() => { mediaTimer = setInterval(() => { if (alive && !invalidated.value) mediaTime.value = Math.floor(Date.now() / 1000); }, 1000); window.addEventListener('storage', journalChanged); void load(); });
onScopeDispose(() => { alive = false; generation++; readController?.abort(); postController?.abort(); clearSensitive(); if (mediaTimer) clearInterval(mediaTimer); pending.value = null; session?.dispose(); window.removeEventListener('storage', journalChanged); });
</script>

<template>
  <section class="application-page">
    <header><div><h1>{{ recoveryOnly ? '提现申请结果' : '申请提现' }}</h1><p>申请提交后预占可提现余额，审核拒绝后释放；转账由财务另外登记。</p></div>
      <el-button v-if="auth.can('supplier.finance.view')" @click="router.push('/finance/extracts')">查看提现记录</el-button></header>
    <p v-if="error || storageError" role="alert" class="application-error">{{ error || storageError }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="mediaLoading" role="status">正在核对本次收款二维码…</p><p v-if="mediaError" role="alert" class="application-error">{{ mediaError }}</p>
    <p v-if="loading" role="status">正在核对可提现余额和收款资料…</p>
    <article v-if="pending" class="surface" aria-label="原提现申请待核对">
      <h2>原提现申请结果待核对</h2><p>{{ typeName(pending.extract_type) }} · {{ displayMoney(pending.money) }}。核对前不能再次申请，刷新后仍会保留。</p>
      <div class="application-actions"><el-button :disabled="invalidated || saving || recovering" @click="recover()">查询原提现申请</el-button></div>
      <label class="application-check"><input v-model="closeConfirmed" type="checkbox" :disabled="invalidated || saving || recovering" />核对并封存这次原申请；若已提交，则读取原结果</label>
      <el-button :disabled="invalidated || saving || recovering || !closeConfirmed" @click="recover(true)">确认原提现申请结果</el-button>
    </article>
    <article v-if="source" class="surface" aria-label="当前提现申请资料">
      <div class="application-amounts"><div><span>全账可提现余额</span><strong>{{ displayMoney(source.available) }}</strong></div><div><span>平台提现限额</span><strong>{{ displayMoney(source.min_price) }} 至 {{ displayMoney(source.max_price) }}</strong></div></div>
      <p v-if="!source.can_apply" role="alert">当前余额或平台限额不满足申请条件；上限为零时不能申请，请联系平台核对配置。</p>
      <form @submit.prevent="submit">
        <label>提现方式<select v-model="extractType" :disabled="saving"><option value="bank">银行卡</option><option value="alipay">支付宝</option><option value="weixin">微信</option></select></label>
        <section class="application-account" aria-label="本次申请收款资料">
          <template v-if="extractType === 'bank'"><p>银行卡号：{{ source.accounts.bank.bank_code || '未配置' }}</p><p>开户行：{{ source.accounts.bank.bank_address || '未配置' }}</p></template>
          <template v-else><p>{{ extractType === 'alipay' ? '支付宝账号' : '微信号' }}：{{ source.accounts[extractType].account || '未配置' }}</p>
            <img v-if="image('seed')" :src="image('seed')" alt="本次申请收款二维码" referrerpolicy="no-referrer" @error="imageError('seed')" />
            <p v-else>{{ source.accounts[extractType].qrcode_url ? '二维码已配置，图片暂不可预览，请核对收款资料' : '收款二维码未配置' }}</p>
            <el-button v-if="privateSeedQr" :disabled="mediaLoading || saving" @click="loadMedia">重新核对申请二维码</el-button></template>
          <p v-if="!account?.ready" role="alert">请先在收款设置补齐{{ extractType === 'bank' ? '银行卡号和开户行' : '账号和收款二维码' }}。</p>
          <el-button @click="router.push('/finance/accounts')">打开财务收款设置</el-button>
        </section>
        <label>提现金额<input v-model="money" inputmode="decimal" placeholder="0.00" :disabled="saving" /></label>
        <label>申请备注（最多255字）<textarea v-model="mark" rows="3" maxlength="510" :disabled="saving" /></label>
        <label class="application-check"><input v-model="confirmed" type="checkbox" :disabled="saving || !canManage" />我已核对本次申请金额和收款资料</label>
        <el-button native-type="submit" type="primary" :disabled="!canSubmit">提交提现申请</el-button>
      </form>
    </article>
    <article v-if="receipt?.state === 'committed' && receipt.result" class="surface" aria-label="原提现申请提交结果">
      <h2>申请已提交 · {{ receipt.result.id }}</h2><p>{{ typeName(receipt.result.extract_type) }} · {{ displayMoney(receipt.result.extract_price) }}</p><p>该次申请后余额：{{ displayMoney(receipt.result.balance) }}</p>
      <p>以下为申请提交时的收款快照，当前审核和转账状态请查看提现记录。</p>
      <template v-if="receipt.result.extract_type === 'bank'"><p>银行卡号：{{ receipt.result.bank_code }}</p><p>开户行：{{ receipt.result.bank_address }}</p></template>
      <template v-else><p>{{ receipt.result.extract_type === 'alipay' ? '支付宝账号' : '微信号' }}：{{ receipt.result.extract_type === 'alipay' ? receipt.result.alipay_account : receipt.result.wechat }}</p>
        <img v-if="image('receipt')" class="application-receipt-qr" :src="image('receipt')" alt="原申请收款二维码" referrerpolicy="no-referrer" @error="imageError('receipt')" />
        <p v-else>原申请二维码暂不可预览，收款快照保持原记录。</p>
        <el-button v-if="privateReceiptQr" :disabled="mediaLoading" @click="loadMedia">重新核对原申请二维码</el-button></template>
      <p>申请时备注：{{ receipt.result.supplier_mark || '—' }}</p>
    </article>
    <el-button v-if="!pending && !storageError && canManage && !recoveryOnly" :disabled="loading || saving || recovering" @click="load">重新核对申请资料</el-button>
    <el-button v-if="!pending && !storageError && canManage && recoveryOnly" @click="router.push('/finance/apply')">重新核对并申请提现</el-button>
    <p v-if="recoveryOnly && !pending && !receipt && !storageError && !invalidated">本机没有待核对的原提现申请。</p>
  </section>
</template>

<style scoped>
.application-receipt-qr{width:160px;height:160px;max-width:100%;object-fit:contain}
.application-page{display:grid;gap:20px;max-width:960px;min-width:0;margin:0 auto}.application-page header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.application-page h1{font-size:24px;margin:0 0 8px}.application-page h2{font-size:18px;margin:0 0 12px}.application-page p{line-height:1.7;margin:0;overflow-wrap:anywhere}.application-page .surface{padding:24px;display:grid;gap:18px;min-width:0}.application-page form{display:grid;gap:18px}.application-page label{display:grid;gap:8px;font-size:14px}.application-page input,.application-page select,.application-page textarea{border:1px solid var(--border,#dcdfe6);padding:9px 12px;border-radius:5px;background:#fff;color:inherit;max-width:100%;box-sizing:border-box;font:inherit}.application-page input:focus-visible,.application-page select:focus-visible,.application-page textarea:focus-visible{outline:2px solid var(--accent,#10b9ae);outline-offset:2px}.application-page .application-check{display:flex;align-items:flex-start;line-height:1.6}.application-check input{margin:4px 0 0;flex:none}.application-amounts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.application-amounts>div{display:grid;gap:10px}.application-amounts span{color:var(--text-muted,#64748b);font-size:14px}.application-amounts strong{font-size:22px;overflow-wrap:anywhere}.application-account{display:grid;gap:10px;background:#f8fafc;padding:16px;border-radius:6px;min-width:0}.application-account img{width:160px;height:160px;max-width:100%;object-fit:contain}.application-error{color:#b42318}.application-actions{display:flex;flex-wrap:wrap;gap:12px}.application-page :deep(.el-button){max-width:100%;white-space:normal;height:auto;min-height:32px}.application-page :deep(.el-button+.el-button){margin-left:0}@media(max-width:600px){.application-page{width:100%;box-sizing:border-box}.application-page header{flex-direction:column}.application-page .surface{padding:18px}.application-amounts{grid-template-columns:1fr}.application-page form>label input{width:100%}.application-page .application-check input{width:auto}}
</style>
