<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { supplierBillDateRange, supplierBillMoney } from '@/api/supplierBills';
import { getSupplierExtractHistory, getSupplierExtractMark, saveSupplierExtractMark, supplierExtractImage,
  type SupplierExtractQuery, type SupplierExtractHistory, type SupplierExtractRecord, type SupplierExtractMark } from '@/api/supplierExtracts';

const props = defineProps<{ embedded?: boolean; refreshKey?: number }>();
const auth = useAuthStore(), route = useRoute();
const status = ref<SupplierExtractQuery['status']>(''), payStatus = ref<SupplierExtractQuery['pay_status']>('');
const extractType = ref<SupplierExtractQuery['extract_type']>(''), from = ref(''), to = ref('');
const result = ref<SupplierExtractHistory | null>(null), loading = ref(false), error = ref(''), notice = ref('');
const active = ref(true), routeValid = ref(false), viewingId = ref(0), brokenImages = ref(new Set<string>());
const editingId = ref(0), mark = ref(''), markContext = ref<SupplierExtractMark | null>(null);
const markLoading = ref(false), saving = ref(false), unknown = ref(false), markError = ref('');
let alive = true, readGeneration = 0, editGeneration = 0;
let readController: AbortController | undefined, editController: AbortController | undefined;
const canRead = computed(() => active.value && !!auth.token && !!auth.user?.id && !!auth.user.supplier_id && auth.can('supplier.finance.view'));
const canManage = computed(() => canRead.value && auth.can('supplier.finance.manage'));
const detail = computed(() => result.value?.list.find(row => row.id === viewingId.value));
const session = createSupplierSessionScope(invalidate);
const current = () => alive && session.isCurrent() && canRead.value && routeValid.value;
const message = (cause: unknown) => cause instanceof Error ? cause.message : '操作失败，请重新读取提现记录';
const money = (value: string) => supplierBillMoney(value, 1);
const typeName = (type: string) => type === 'bank' ? '银行卡' : type === 'alipay' ? '支付宝' : '微信';
const reviewName = (value: number) => value === -1 ? '已拒绝' : value === 0 ? '审核中' : '已通过';
function closeMark() {
  editGeneration++; editController?.abort(); editingId.value = 0; mark.value = ''; markContext.value = null;
  markLoading.value = false; saving.value = false; unknown.value = false; markError.value = '';
}
function clear() {
  readGeneration++; readController?.abort(); result.value = null; loading.value = false; error.value = ''; notice.value = '';
  viewingId.value = 0; brokenImages.value = new Set(); closeMark();
}
function invalidate() { clear(); active.value = false; error.value = '登录会话或权限已改变，请重新打开提现记录'; }
watch([status, payStatus, extractType, from, to], clear, { flush: 'sync' });
watch(canRead, value => { if (!value) invalidate(); }, { flush: 'sync' });
watch(canManage, value => { if (!value) closeMark(); }, { flush: 'sync' });
watch(() => props.refreshKey, () => { void load(); }, { flush: 'sync' });
onScopeDispose(() => { alive = false; clear(); session.dispose(); });
async function load(page = 1) {
  if (!current()) return;
  clear(); const generation = ++readGeneration; readController = new AbortController(); loading.value = true;
  try {
    const query: SupplierExtractQuery = { status: status.value, pay_status: payStatus.value, extract_type: extractType.value,
      data: supplierBillDateRange(from.value, to.value), page, limit: 20 };
    const value = await getSupplierExtractHistory(query, auth.user!.supplier_id, readController.signal);
    if (current() && generation === readGeneration) result.value = value;
  } catch (cause) { if (current() && generation === readGeneration) error.value = message(cause); }
  finally { if (generation === readGeneration) loading.value = false; }
}
function reset() { status.value = ''; payStatus.value = ''; extractType.value = ''; from.value = ''; to.value = ''; void load(); }
function openDetails(row: SupplierExtractRecord) { if (current() && result.value?.list.includes(row)) { viewingId.value = row.id; brokenImages.value = new Set(); } }
function image(reference: string) { return brokenImages.value.has(reference) ? '' : supplierExtractImage(reference); }
function imageError(reference: string) {
  if (current() && detail.value && [detail.value.qrcode_url, detail.value.voucher_image].includes(reference)) brokenImages.value.add(reference);
}
async function openMark(row: SupplierExtractRecord) {
  if (!current() || !canManage.value || saving.value || !result.value?.list.includes(row)) return;
  closeMark(); editingId.value = row.id; await readMark();
}
async function readMark() {
  if (!current() || !canManage.value || !editingId.value || saving.value) return;
  const id = editingId.value, generation = ++editGeneration, desired = unknown.value ? mark.value.trim() : undefined;
  editController?.abort(); editController = new AbortController(); markLoading.value = true; markError.value = ''; markContext.value = null;
  try {
    const value = await getSupplierExtractMark(id, auth.user!.supplier_id, editController.signal);
    if (!current() || !canManage.value || generation !== editGeneration || editingId.value !== id) return;
    markContext.value = value; mark.value = value.supplier_mark; unknown.value = false;
    if (desired !== undefined) markError.value = value.supplier_mark === desired ? '当前备注已与提交内容一致，请核对；未重复提交' : '当前备注与提交内容不同，请核对后重新编辑；未自动重试';
  } catch (cause) { if (current() && generation === editGeneration) markError.value = message(cause); }
  finally { if (generation === editGeneration) markLoading.value = false; }
}
async function saveMark() {
  if (!current() || !canManage.value || !markContext.value || saving.value || unknown.value || markLoading.value) return;
  const value = mark.value.trim(); if (!value || [...value].length > 200) { markError.value = '请输入1至200字备注'; return; }
  const source = markContext.value, id = editingId.value, generation = editGeneration;
  saving.value = true; markError.value = ''; editController = new AbortController();
  try {
    await saveSupplierExtractMark(id, auth.user!.supplier_id, value, source.revision, editController.signal);
    if (!current() || !canManage.value || generation !== editGeneration || editingId.value !== id) return;
    closeMark(); const refresh = load(), refreshGeneration = readGeneration; await refresh;
    if (current() && readGeneration === refreshGeneration) notice.value = '提现备注已保存';
  } catch (cause) {
    if (current() && generation === editGeneration) { unknown.value = true; markContext.value = null; markError.value = `${message(cause)}。请先核对原提现备注，未自动重试`; }
  } finally { if (generation === editGeneration) saving.value = false; }
}
function readRoute() {
  routeValid.value = false; clear(); const q = route.query;
  if (Object.keys(q).some(key => !['status', 'pay_status', 'extract_type', 'from', 'to'].includes(key)) || Object.values(q).some(v => typeof v !== 'string')
    || q.status !== undefined && !['', '-1', '0', '1'].includes(String(q.status)) || q.pay_status !== undefined && !['', '0', '1'].includes(String(q.pay_status))
    || q.extract_type !== undefined && !['', 'bank', 'alipay', 'weixin'].includes(String(q.extract_type))) { error.value = '提现筛选参数无效，请从提现记录入口重新打开'; return; }
  status.value = (q.status ?? '') as SupplierExtractQuery['status']; payStatus.value = (q.pay_status ?? '') as SupplierExtractQuery['pay_status'];
  extractType.value = (q.extract_type ?? '') as SupplierExtractQuery['extract_type']; from.value = String(q.from ?? ''); to.value = String(q.to ?? '');
  routeValid.value = true; void load();
}
watch(() => route.fullPath, readRoute, { flush: 'sync' }); onMounted(readRoute);
</script>

<template>
  <section class="extract-page">
    <header v-if="!props.embedded" class="page-heading"><div><h1>提现记录</h1><p>查看当前供应商的申请、历史收款信息与转账登记</p></div></header>
    <p class="extract-note">时间按北京时间显示，日期筛选使用申请时间。收款信息取自申请时的记录。</p>
    <p v-if="!canRead" role="alert">当前会话无法查看提现记录，请重新登录或核对权限。</p>
    <form class="surface extract-filters" @submit.prevent="load()">
      <label>审核状态<select v-model="status" :disabled="!canRead"><option value="">全部审核状态</option><option value="0">审核中</option><option value="1">已通过</option><option value="-1">已拒绝</option></select></label>
      <label>转账状态<select v-model="payStatus" :disabled="!canRead"><option value="">全部转账状态</option><option value="0">未转账</option><option value="1">已登记转账</option></select></label>
      <label>收款方式<select v-model="extractType" :disabled="!canRead"><option value="">全部方式</option><option value="bank">银行卡</option><option value="alipay">支付宝</option><option value="weixin">微信</option></select></label>
      <label>开始日期<input v-model="from" type="date" :disabled="!canRead" /></label><label>结束日期<input v-model="to" type="date" :disabled="!canRead" /></label>
      <el-button native-type="submit" type="primary" :disabled="!canRead || !routeValid" :loading="loading">查询提现记录</el-button><el-button :disabled="!canRead || !routeValid" @click="reset">重置提现筛选</el-button>
    </form>
    <p v-if="error" class="extract-error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="result">
      <div class="extract-statistics" aria-label="提现统计">
        <article class="surface"><span>待审核金额</span><strong>{{ money(result.statistics.pending_review) }}</strong></article>
        <article class="surface"><span>待转账金额</span><strong>{{ money(result.statistics.pending_transfer) }}</strong></article>
        <article class="surface"><span>累计已转账</span><strong>{{ money(result.statistics.paid) }}</strong></article>
        <article class="surface"><span>全账可提现余额</span><strong>{{ money(result.statistics.withdrawable) }}</strong></article>
      </div>
      <p class="extract-note">前三项保留日期和方式筛选；待审保留当前转账筛选，待转与已转账按各自状态汇总。可提现余额按全部账目计算。</p>
      <p class="extract-note">提现限额配置：最低 {{ money(result.statistics.extract_min_price) }}，最高 {{ result.statistics.extract_max_price === '0.00' ? '¥0.00（暂不可申请）' : money(result.statistics.extract_max_price) }}。申请以提交时核对为准。</p>
    </template>
    <section class="surface extract-panel" aria-label="提现记录列表" :aria-busy="loading">
      <h2>提现记录</h2><p v-if="loading" role="status">正在读取提现记录…</p>
      <template v-if="result">
        <div class="extract-scroll" role="region" aria-label="提现申请列表" tabindex="0"><table>
          <thead><tr><th>申请编号</th><th>申请时间</th><th>收款方式</th><th>申请金额</th><th>审核状态</th><th>转账状态</th><th>经办人</th><th>备注</th><th>操作</th></tr></thead>
          <tbody><tr v-for="row in result.list" :key="row.id"><th scope="row">{{ row.id }}</th><td>{{ row.add_time || '—' }}</td><td>{{ typeName(row.extract_type) }}</td><td>{{ money(row.extract_price) }}</td><td>{{ reviewName(row.status) }}</td><td>{{ row.pay_status === 1 ? '已登记转账' : '未转账' }}</td><td>{{ row.admin_name || '—' }}</td><td class="extract-mark">{{ row.supplier_mark || '—' }}</td><td><div class="extract-actions"><el-button link type="primary" :aria-label="`提现 ${row.id} 查看明细`" @click="openDetails(row)">查看明细</el-button><el-button v-if="canManage" link type="primary" :disabled="saving" :aria-label="`提现 ${row.id} 编辑备注`" @click="openMark(row)">编辑备注</el-button></div></td></tr></tbody>
        </table></div>
        <p v-if="!result.count">当前筛选没有提现申请。</p>
        <div class="extract-pagination"><span>共 {{ result.count }} 条申请 · 第 {{ result.page }} 页</span><div><el-button :disabled="result.page <= 1" @click="load(result.page - 1)">上一页提现</el-button><el-button :disabled="result.page * result.limit >= result.count" @click="load(result.page + 1)">下一页提现</el-button></div></div>
      </template>
    </section>
    <section v-if="detail" class="surface extract-panel" aria-label="提现申请明细">
      <div class="extract-heading"><h2>提现申请 · {{ detail.id }}</h2><el-button @click="viewingId = 0">关闭提现明细</el-button></div>
      <dl class="extract-detail"><div><dt>申请金额</dt><dd>{{ money(detail.extract_price) }}</dd></div><div><dt>申请后余额</dt><dd>{{ money(detail.balance) }}</dd></div><div><dt>审核状态</dt><dd>{{ reviewName(detail.status) }}</dd></div><div><dt>经办人</dt><dd>{{ detail.admin_name || '尚未登记' }}</dd></div>
        <template v-if="detail.extract_type === 'bank'"><div><dt>申请时银行卡号</dt><dd>{{ detail.bank_code || '未记录' }}</dd></div><div><dt>申请时开户行</dt><dd>{{ detail.bank_address || '未记录' }}</dd></div></template>
        <template v-else><div><dt>{{ detail.extract_type === 'alipay' ? '申请时支付宝账号' : '申请时微信号' }}</dt><dd>{{ detail.extract_type === 'alipay' ? detail.alipay_account || '未记录' : detail.wechat || '未记录' }}</dd></div>
          <div><dt>申请时收款二维码</dt><dd><img v-if="image(detail.qrcode_url)" class="extract-image" :src="image(detail.qrcode_url)" alt="申请时收款二维码" referrerpolicy="no-referrer" @error="imageError(detail.qrcode_url)" /><span v-else>图片暂不可用，请联系财务确认</span></dd></div></template>
        <template v-if="detail.status === -1"><div><dt>拒绝原因</dt><dd>{{ detail.fail_msg || '未记录' }}</dd></div><div><dt>拒绝时间</dt><dd>{{ detail.fail_time || '未记录' }}</dd></div></template>
        <div><dt>转账状态</dt><dd>{{ detail.pay_status === 1 ? '已登记转账' : '未转账' }}</dd></div>
        <template v-if="detail.pay_status === 1"><div><dt>转账说明</dt><dd>{{ detail.voucher_title || '未记录' }}</dd></div><div><dt>转账登记时间</dt><dd>{{ detail.pay_time || '未记录' }}</dd></div><div><dt>转账凭证</dt><dd><img v-if="image(detail.voucher_image)" class="extract-image" :src="image(detail.voucher_image)" alt="转账凭证" referrerpolicy="no-referrer" @error="imageError(detail.voucher_image)" /><span v-else>{{ detail.voucher_image ? '图片暂不可用，请联系财务确认' : '未上传凭证图片' }}</span></dd></div></template>
        <div><dt>备注</dt><dd>{{ detail.supplier_mark || '—' }}</dd></div>
      </dl>
    </section>
    <section v-if="editingId" class="surface extract-panel" aria-label="提现备注编辑" :aria-busy="saving || markLoading">
      <div class="extract-heading"><h2>编辑提现备注 · {{ editingId }}</h2><el-button :disabled="saving" @click="closeMark">关闭提现备注</el-button></div>
      <p v-if="markLoading" role="status">正在核对提现备注…</p><label class="extract-editor">提现备注<textarea v-model="mark" maxlength="200" rows="3" :disabled="!markContext || saving || unknown" /></label>
      <p v-if="markError" class="extract-error" role="alert">{{ markError }}</p><div class="extract-actions"><el-button :disabled="saving || markLoading" @click="readMark">核对当前提现备注</el-button><el-button type="primary" :disabled="!markContext || saving || unknown || markLoading" @click="saveMark">保存提现备注</el-button></div>
    </section>
  </section>
</template>

<style scoped>
.extract-page{display:grid;gap:16px;min-width:0}.extract-note{margin:0;color:var(--text-muted,#64748b);line-height:1.6}.extract-filters,.extract-panel{padding:20px;min-width:0}.extract-filters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}.extract-page label{display:grid;gap:8px;font-size:14px;max-width:100%}.extract-page input,.extract-page select,.extract-page textarea{min-height:36px;max-width:100%;padding:6px 10px;border:1px solid var(--border,#dcdfe6);border-radius:5px;background:#fff;color:inherit;font:inherit;box-sizing:border-box}.extract-page input:focus-visible,.extract-page select:focus-visible,.extract-page textarea:focus-visible{outline:2px solid var(--accent,#10b9ae);outline-offset:2px}.extract-statistics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.extract-statistics article{padding:20px;display:grid;gap:12px;min-width:0}.extract-statistics span{color:var(--text-muted,#64748b);font-size:14px}.extract-statistics strong{font-size:24px;overflow-wrap:anywhere}.extract-heading,.extract-pagination{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.extract-panel h2{margin:0;font-size:18px}.extract-scroll{max-width:100%;overflow:auto;margin-top:16px;overscroll-behavior-x:contain}.extract-scroll table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:14px}.extract-scroll th,.extract-scroll td{padding:14px 12px;text-align:left;border-bottom:1px solid var(--border,#ebeef5);font-weight:400}.extract-scroll thead th{font-weight:600;color:var(--text-muted,#64748b)}.extract-mark{min-width:140px;max-width:300px;white-space:normal;overflow-wrap:anywhere}.extract-error{color:#b42318;line-height:1.6;margin:0}.extract-pagination{margin-top:18px}.extract-pagination>div,.extract-actions{display:flex;gap:8px;flex-wrap:wrap}.extract-editor{margin:18px 0}.extract-editor textarea{width:100%;min-height:100px}.extract-detail{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:22px 0 0}.extract-detail dt{color:var(--text-muted,#64748b);font-size:14px}.extract-detail dd{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.extract-image{width:180px;height:180px;max-width:100%;object-fit:contain;border:1px solid var(--border,#ebeef5);border-radius:6px}.extract-page :deep(.el-button+.el-button){margin-left:0}
@media(max-width:850px){.extract-statistics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.extract-filters,.extract-panel{padding:14px}.extract-filters label,.extract-filters input,.extract-filters select{width:100%}.extract-pagination{align-items:flex-start;flex-direction:column}.extract-note{font-size:13px}.extract-heading{align-items:flex-start}.extract-detail{grid-template-columns:1fr}.extract-statistics article{padding:14px}.extract-statistics strong{font-size:22px}}
</style>
