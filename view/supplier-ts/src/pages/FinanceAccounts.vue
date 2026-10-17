<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { previewMode } from '@/api/supplier';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import ProductImagePicker from '@/components/ProductImagePicker.vue';
import type { SupplierAttachment } from '@/api/attachments';
import { emptyFinanceAccounts, financeAccountCanonicalReference, financeAccountLimits, financeAccountPreview,
  financeAccountsIdentity, makeFinanceAccountsSave, readFinanceAccounts, sameFinanceAccounts, saveFinanceAccounts,
  type FinanceAccounts, type FinanceAccountsContext, type FinanceAccountsIdentity, type FinanceQrChannel, type FinanceQrPreview } from '@/api/supplierFinanceAccounts';
import { classifyProductMediaReference } from '../../../common/productMediaReference';

const props = defineProps<{ embedded?: boolean }>();
const auth = useAuthStore(), route = useRoute(), router = useRouter();
const context = shallowRef<FinanceAccountsContext>(), form = reactive(emptyFinanceAccounts());
const loading = ref(false), saving = ref(false), unknown = ref(false), reviewed = ref(false), invalidated = ref(false);
const error = ref(''), message = ref(''), pickerOpen = ref(false), pickerKey = ref('');
const selectedPreviews = shallowRef<Partial<Record<FinanceQrChannel, FinanceQrPreview>>>({});
const failedPreviews = ref(new Set<string>());
const previewTime = ref(Math.floor(Date.now() / 1000));
let previewTimer: ReturnType<typeof setInterval> | undefined;
let alive = true, generation = 0, pickerGeneration = 0;
let identity: FinanceAccountsIdentity | undefined, scope: ReturnType<typeof createSupplierSessionScope> | undefined;
let reading: AbortController | undefined, posting: AbortController | undefined, attempted: FinanceAccounts | undefined;
let pickerChannel: FinanceQrChannel = 'alipay', pickerRevision = '';
const qrField = (channel: FinanceQrChannel) => channel === 'alipay' ? 'alipay_qrcode_url' : 'wechat_qrcode_url';
const validRoute = () => !Object.keys(route.query).length && route.path === (props.embedded ? '/finance' : '/finance/accounts');
function clearContext() {
  generation++; reading?.abort(); posting?.abort(); reading = posting = undefined;
  context.value = undefined; Object.assign(form, emptyFinanceAccounts()); selectedPreviews.value = {};
  failedPreviews.value = new Set(); reviewed.value = false; pickerOpen.value = false; pickerKey.value = '';
}
function invalidate() {
  if (invalidated.value) return;
  invalidated.value = true; clearContext(); attempted = undefined; unknown.value = false; loading.value = saving.value = false;
  error.value = '会话、权限或页面已变化，请重新打开收款设置'; message.value = '';
}
function active() {
  try {
    if (alive && !invalidated.value && identity && scope?.isCurrent() && validRoute()) return true;
  } catch { /* Storage failure invalidates the mounted scope. */ }
  invalidate(); return false;
}
try { identity = financeAccountsIdentity(); scope = createSupplierSessionScope(invalidate); }
catch { invalidate(); }
const canView = computed(() => active() && auth.can('supplier.finance.view'));
const canManage = computed(() => canView.value && auth.can('supplier.finance.manage'));
const locked = computed(() => !canManage.value || loading.value || saving.value || unknown.value || pickerOpen.value);
const canChoose = computed(() => !locked.value && auth.can('supplier.attachment.view'));
const canSave = computed(() => !locked.value && !!context.value && reviewed.value);
watch(form, () => { reviewed.value = false; });
watch(() => route.fullPath, invalidate);
watch(() => JSON.stringify([auth.token, auth.user?.id, auth.user?.supplier_id, auth.permissions, auth.permissionsLoaded]), invalidate);

function applyContext(value: FinanceAccountsContext) {
  context.value = value; Object.assign(form, value.accounts); selectedPreviews.value = {}; failedPreviews.value = new Set();
  pickerOpen.value = false; reviewed.value = false;
}
async function load(reconcile = false) {
  if (!active() || !canView.value || !identity || saving.value || (unknown.value && !reconcile)) return;
  const last = reconcile ? attempted : undefined;
  clearContext(); const id = generation, controller = new AbortController(); reading = controller;
  loading.value = true; error.value = ''; message.value = '';
  try {
    if (previewMode) throw new Error('预览模式不能读取真实收款资料');
    const value = await readFinanceAccounts(identity, controller.signal);
    if (!active() || id !== generation || controller.signal.aborted || !canView.value) return;
    applyContext(value); unknown.value = false; attempted = undefined;
    if (last) message.value = sameFinanceAccounts(last, value.accounts)
      ? '当前收款资料与上次填写一致。这只是当前值核对，不是原保存回执。'
      : '当前收款资料与上次填写不同，已显示当前保存值。请重新核对后编辑。';
  } catch (failure) {
    if (active() && id === generation && !controller.signal.aborted) error.value = failure instanceof Error ? failure.message : '收款资料读取失败';
  } finally { if (active() && id === generation) loading.value = false; }
}
async function save() {
  if (!canSave.value || !context.value) return;
  const source = context.value;
  let data: ReturnType<typeof makeFinanceAccountsSave>;
  try { data = makeFinanceAccountsSave(source, { ...form }); }
  catch (failure) { error.value = failure instanceof Error ? failure.message : '收款资料格式错误'; return; }
  const id = ++generation, controller = new AbortController(); reading?.abort(); posting = controller;
  attempted = { ...data }; delete (attempted as Partial<typeof data>).revision;
  saving.value = true; error.value = ''; message.value = '';
  const current = () => active() && canManage.value && id === generation && context.value === source;
  try {
    const value = await saveFinanceAccounts(source, data, current, controller.signal);
    if (!current() || controller.signal.aborted) return;
    applyContext(value); attempted = undefined; message.value = '收款资料已保存，后续新提现申请将核对这些资料。';
  } catch (failure) {
    if (!current() || controller.signal.aborted) return;
    unknown.value = true; reviewed.value = false; pickerOpen.value = false;
    error.value = `${failure instanceof Error ? failure.message : '保存结果待核对'}。请读取当前收款资料核对，未自动重发。`;
  } finally { if (active() && id === generation) saving.value = false; }
}
function openPicker(channel: FinanceQrChannel) {
  if (!canChoose.value || !context.value || !identity) return;
  pickerChannel = channel; pickerRevision = context.value.revision;
  pickerKey.value = `${identity.actor_id}:${identity.supplier_id}:${pickerRevision}:${channel}:${++pickerGeneration}`;
  pickerOpen.value = true;
}
function acceptImages(images: SupplierAttachment[], key: string) {
  if (!active() || !canManage.value || !auth.can('supplier.attachment.view') || !pickerOpen.value || key !== pickerKey.value
    || !context.value || context.value.revision !== pickerRevision || loading.value || saving.value || unknown.value) return;
  try {
    if (images.length !== 1) throw new Error('请选择一张收款二维码');
    const row = images[0], reference = financeAccountCanonicalReference(row.canonicalUrl);
    if ([...reference].length > 255) throw new Error('收款二维码引用不能超过255字');
    const media = classifyProductMediaReference(reference), match = /^\/api\/assets\/([1-9]\d*)\?expires=([1-9]\d*)&signature=([A-Za-z0-9_-]{43})$/.exec(row.previewUrl);
    const preview: FinanceQrPreview = { reference, status: 'ready', src: row.previewUrl,
      expires_at: media.kind === 'asset' && match ? Number(match[2]) : null };
    if (!financeAccountPreview(preview, reference)) throw new Error('所选二维码预览无法核对，请重读图片');
    form[qrField(pickerChannel)] = reference;
    selectedPreviews.value = { ...selectedPreviews.value, [pickerChannel]: Object.freeze(preview) };
    failedPreviews.value = new Set(); pickerOpen.value = false; error.value = '';
  } catch (failure) { error.value = failure instanceof Error ? failure.message : '所选二维码无法核对'; }
}
function qrPreview(channel: FinanceQrChannel): string {
  if (!active() || !context.value) return '';
  const reference = form[qrField(channel)];
  if (failedPreviews.value.has(channel + reference)) return '';
  if (reference === context.value.accounts[qrField(channel)]) return financeAccountPreview(context.value.previews[channel], reference, previewTime.value);
  const selected = selectedPreviews.value[channel];
  if (selected?.reference === reference) return financeAccountPreview(selected, reference, previewTime.value);
  const media = classifyProductMediaReference(reference);
  return media.kind === 'public' && media.reference === reference ? reference : '';
}
function imageFailed(channel: FinanceQrChannel) { failedPreviews.value = new Set([...failedPreviews.value, channel + form[qrField(channel)]]); }
onMounted(() => { previewTimer = setInterval(() => { if (alive && !invalidated.value) previewTime.value = Math.floor(Date.now() / 1000); }, 1000); void load(); });
onBeforeUnmount(() => { if (previewTimer) clearInterval(previewTimer); alive = false; invalidate(); scope?.dispose(); });
</script>

<template>
  <section class="finance-accounts page-section" :class="{ embedded }" aria-label="供应商收款设置">
    <header class="accounts-heading"><div><h1>收款设置</h1><p>保存后用于新提现申请；已提交申请保留当时的收款快照。</p></div>
      <el-button v-if="!embedded && canManage" @click="router.push('/finance/apply')">核对并申请提现</el-button></header>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <p v-if="loading" role="status">正在读取当前收款资料…</p>
    <p v-if="saving" role="status">正在保存收款资料，请等待结果…</p>
    <section v-if="unknown" class="unknown-result" aria-label="收款保存结果待核对"><h2>保存结果待核对</h2>
      <p>核对前不能再次保存。读取到相同资料也只代表当前值一致。</p>
      <el-button :disabled="loading || !canView" @click="load(true)">核对当前收款资料</el-button></section>
    <form v-if="context" class="accounts-form" @submit.prevent="save">
      <fieldset :disabled="locked"><legend>银行卡</legend>
        <label for="finance-bank-code">银行卡号</label><input id="finance-bank-code" v-model="form.bank_code" autocomplete="off" :maxlength="financeAccountLimits.bank_code * 2" />
        <label for="finance-bank-address">开户行</label><input id="finance-bank-address" v-model="form.bank_address" autocomplete="off" :maxlength="financeAccountLimits.bank_address * 2" />
      </fieldset>
      <fieldset :disabled="locked"><legend>支付宝</legend>
        <label for="finance-alipay-account">支付宝账号</label><input id="finance-alipay-account" v-model="form.alipay_account" autocomplete="off" :maxlength="financeAccountLimits.alipay_account * 2" />
        <label for="finance-alipay-qr">支付宝收款二维码引用</label><input id="finance-alipay-qr" v-model="form.alipay_qrcode_url" autocomplete="off" :maxlength="financeAccountLimits.alipay_qrcode_url * 2" />
      </fieldset>
      <section class="qr-preview" aria-label="支付宝收款二维码"><img v-if="qrPreview('alipay')" :src="qrPreview('alipay')" alt="支付宝收款二维码" referrerpolicy="no-referrer" @error="imageFailed('alipay')" />
        <p v-else>{{ form.alipay_qrcode_url ? '二维码预览暂不可用，可重新读取或选择图片核对。' : '尚未配置支付宝收款二维码。' }}</p>
        <el-button v-if="canManage" :disabled="!canChoose" @click="openPicker('alipay')">选择支付宝二维码</el-button></section>
      <fieldset :disabled="locked"><legend>微信</legend>
        <label for="finance-wechat-account">微信号</label><input id="finance-wechat-account" v-model="form.wechat" autocomplete="off" :maxlength="financeAccountLimits.wechat * 2" />
        <label for="finance-wechat-qr">微信收款二维码引用</label><input id="finance-wechat-qr" v-model="form.wechat_qrcode_url" autocomplete="off" :maxlength="financeAccountLimits.wechat_qrcode_url * 2" />
      </fieldset>
      <section class="qr-preview" aria-label="微信收款二维码"><img v-if="qrPreview('weixin')" :src="qrPreview('weixin')" alt="微信收款二维码" referrerpolicy="no-referrer" @error="imageFailed('weixin')" />
        <p v-else>{{ form.wechat_qrcode_url ? '二维码预览暂不可用，可重新读取或选择图片核对。' : '尚未配置微信收款二维码。' }}</p>
        <el-button v-if="canManage" :disabled="!canChoose" @click="openPicker('weixin')">选择微信二维码</el-button></section>
      <p v-if="canManage && !auth.can('supplier.attachment.view')">选择图片需要素材查看权限，上传图片另需素材管理权限。</p>
      <p>收款资料允许暂不填写。申请提现时，银行需卡号与开户行；支付宝、微信需账号与收款二维码同时完整。</p>
      <label v-if="canManage" class="reviewed"><input v-model="reviewed" type="checkbox" :disabled="locked" />我已核对本次收款资料</label>
      <el-button v-if="canManage" type="primary" native-type="submit" :disabled="!canSave">保存收款资料</el-button>
    </form>
    <el-button v-if="!unknown" :disabled="loading || saving || pickerOpen || !canView" @click="load()">重新读取收款资料</el-button>
    <ProductImagePicker v-if="pickerOpen && identity" :key="pickerKey" v-model="pickerOpen" purpose="finance" :supplier-id="identity.supplier_id" :limit="1" :context-key="pickerKey" @selected="acceptImages" />
  </section>
</template>

<style scoped>
.finance-accounts { max-width: 1080px; }
.accounts-heading { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
.accounts-heading p { color: var(--el-text-color-secondary); }
.accounts-form { display: grid; gap: 16px; padding: 24px; background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 10px; }
fieldset { display: grid; gap: 10px; border: 0; padding: 0; margin: 0; min-width: 0; }
legend { font-weight: 600; margin-bottom: 14px; }
input:not([type="checkbox"]) { width: 100%; min-width: 0; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--el-border-color); border-radius: 5px; color: var(--el-text-color-primary); background: var(--el-bg-color); font: inherit; }
input:disabled { background: var(--el-fill-color-light); }
.qr-preview { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; overflow-wrap: anywhere; }
.qr-preview img { width: 150px; height: 150px; object-fit: contain; border: 1px solid var(--el-border-color-light); }
.reviewed { display: flex; gap: 8px; align-items: center; }
.unknown-result { border: 1px solid var(--el-color-warning); border-radius: 8px; padding: 16px; }
.finance-accounts > .el-button { margin-top: 16px; }
.embedded { padding: 0; }
@media(max-width: 640px) { .accounts-heading { flex-direction: column; } .accounts-form { padding: 16px; } }
</style>
