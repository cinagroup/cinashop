<template>
  <div class="invoice-management">
    <div class="heading"><div><h2>发票管理</h2><p class="hint">处理订单发票申请。票面金额由服务端核对退款与开票证据，此处只读；已开票状态不代表税务平台已上传或红字发票已办结。</p></div>
      <el-button v-if="canView" :disabled="submitting || confirming" :loading="loading" @click="load(page)">刷新</el-button></div>
    <el-alert v-if="!canView" title="当前账号没有发票查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon class="section" />
      <el-alert v-if="uncertainOperation" title="处理结果未确认，新的处理已暂停" type="warning" :closable="false" show-icon class="section">
        <p>仅重新读取发票与订单状态核对，不自动重发原请求。读到相同状态也不能证明原请求的结果。</p>
        <details><summary>保留的原请求</summary><pre>{{ JSON.stringify(uncertainOperation, null, 2) }}</pre></details>
        <el-button :disabled="loading || submitting" @click="load(page)">重新读取核对</el-button>
        <el-button v-if="canManage" :disabled="loading || submitting || confirming || !!listError" @click="acknowledge">结束本地待核对状态</el-button>
      </el-alert>
      <el-card shadow="never" class="section">
        <div class="filters">
          <label class="filter-field"><span>申请时间（上海时间，结束分钟包含）</span><el-date-picker v-model="draftDates" type="datetimerange" format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DD HH:mm" start-placeholder="开始时间" end-placeholder="结束时间" range-separator="至" aria-label="发票申请时间" :disabled="submitting || confirming" /></label>
          <label class="filter-field field-select"><span>查询字段</span><el-select v-model="draftField" aria-label="发票查询字段" :disabled="submitting || confirming"><el-option label="全部" value="all" /><el-option label="订单号" value="order_number" /><el-option label="UID" value="uid" /><el-option label="订单姓名" value="real_name" /><el-option label="订单电话" value="user_phone" /><el-option label="发票抬头" value="invoice_name" /><el-option label="开票电话" value="drawer_phone" /></el-select></label>
          <label class="filter-field"><span>关键词</span><el-input v-model="draftKeyword" aria-label="发票关键词" maxlength="100" clearable placeholder="订单号 / UID / 抬头 / 手机号" :disabled="submitting || confirming" @keyup.enter="search" /></label>
          <label class="filter-field field-select"><span>开票状态</span><el-select v-model="draftStatus" aria-label="发票状态" :disabled="submitting || confirming"><el-option label="全部" value="all" /><el-option label="待处理（未退款）" value="pending" /><el-option label="已开票" :value="1" /><el-option label="已退款" value="refunded" /><el-option label="待开票（含历史）" :value="0" /><el-option label="已拒绝" :value="-1" /></el-select></label>
          <div class="filter-actions"><el-button type="primary" :disabled="submitting || confirming" @click="search">查询</el-button><el-button :disabled="submitting || confirming" @click="reset">重置</el-button></div>
        </div>
        <p class="hint">共 {{ count }} 条匹配记录；每页 10 条。状态计数和导出仅覆盖当前已加载页，不代表全量统计。</p>
        <p v-if="list.length" class="hint">本页：待开票 {{ list.filter(row => row.is_invoice === 0).length }} · 已开票 {{ list.filter(row => row.is_invoice === 1).length }} · 已拒绝 {{ list.filter(row => row.is_invoice === -1).length }}</p>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="section"><el-button link type="primary" @click="load(page)">重新读取</el-button></el-alert>
        <div v-else class="table-scroll">
          <el-table :data="list" v-loading="loading" border row-key="id" :empty-text="loading ? '读取中…' : '暂无发票申请'">
            <el-table-column label="订单号" min-width="180"><template #default="{ row }">{{ row.order_number || '关联订单异常' }}</template></el-table-column>
            <el-table-column label="订单金额" min-width="115"><template #default="{ row }">{{ row.order ? `¥${row.order.pay_price}` : '—' }}</template></el-table-column>
            <el-table-column label="发票类型" min-width="130" :filters="[{ text: '电子普通发票', value: 1 }, { text: '纸质专用发票', value: 2 }]" :filter-method="filterInvoiceType"><template #default="{ row }">{{ invoiceTypeLabel(row.type) }}</template></el-table-column>
            <el-table-column prop="name" label="抬头名称" min-width="160" />
            <el-table-column label="抬头类型" min-width="100" :filters="[{ text: '个人', value: 1 }, { text: '企业', value: 2 }]" :filter-method="filterInvoiceHeader"><template #default="{ row }">{{ invoiceHeaderLabel(row.header_type) }}</template></el-table-column>
            <el-table-column label="开票状态" min-width="100"><template #default="{ row }"><el-tag :type="row.is_invoice === 1 ? 'success' : row.is_invoice === -1 ? 'danger' : 'warning'">{{ invoiceStatusLabel(row.is_invoice) }}</el-tag></template></el-table-column>
            <el-table-column label="订单状态" min-width="115"><template #default="{ row }">{{ invoiceOrderStatusLabel(row.order) }}</template></el-table-column>
            <el-table-column label="操作" min-width="160" fixed="right"><template #default="{ row }"><el-button link type="primary" :disabled="submitting || confirming" @click="openDetail(row)">查看详情</el-button><el-tag v-if="row.issues.length" size="small" type="warning">需核对</el-tag></template></el-table-column>
          </el-table>
        </div>
        <div class="table-actions"><el-button :disabled="loading || !!listError || !list.length || submitting || confirming" @click="exportPage">导出当前页 CSV（8 列）</el-button>
          <el-pagination v-if="!loading && !listError" :current-page="page" :page-size="10" :total="count" :pager-count="5" layout="total, prev, pager, next" :disabled="submitting || confirming" @current-change="load" /></div>
      </el-card>
      <el-dialog v-model="detailVisible" title="发票申请详情" width="min(820px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting" @closed="closeDetail">
        <div v-loading="detailLoading">
          <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" show-icon><el-button link type="primary" @click="reloadDetail">重新读取详情</el-button></el-alert>
          <template v-else-if="detail">
            <el-descriptions :column="descriptionColumns" border>
              <el-descriptions-item label="申请行 ID">{{ detail.id }}</el-descriptions-item>
              <el-descriptions-item label="UID">{{ detail.uid }}</el-descriptions-item>
              <el-descriptions-item label="订单号"><router-link v-if="detail.order && canViewOrder" :to="`/order/${encodeURIComponent(detail.order.order_number)}`">{{ detail.order.order_number }}</router-link><span v-else>{{ detail.order_number || '关联订单异常' }}</span></el-descriptions-item>
              <el-descriptions-item label="订单状态">{{ invoiceOrderStatusLabel(detail.order) }}</el-descriptions-item>
              <el-descriptions-item label="订单联系人">{{ detail.order?.real_name || '—' }}</el-descriptions-item>
              <el-descriptions-item label="订单电话">{{ detail.order?.user_phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="申请时间">{{ invoiceTimeLabel(detail.add_time) }}</el-descriptions-item>
              <el-descriptions-item label="开票时间">{{ invoiceTimeLabel(detail.invoice_time) }}</el-descriptions-item>
              <el-descriptions-item label="发票类型">{{ invoiceTypeLabel(detail.type) }}</el-descriptions-item>
              <el-descriptions-item label="抬头类型">{{ invoiceHeaderLabel(detail.header_type) }}</el-descriptions-item>
              <el-descriptions-item label="抬头名称">{{ detail.name || '—' }}</el-descriptions-item>
              <el-descriptions-item v-if="detail.header_type === 2" label="税号">{{ detail.duty_number || '—' }}</el-descriptions-item>
              <el-descriptions-item label="申请手机号">{{ detail.drawer_phone || '—' }}</el-descriptions-item>
              <el-descriptions-item label="邮箱">{{ detail.email || '—' }}</el-descriptions-item>
              <el-descriptions-item v-if="detail.header_type === 2 && detail.type === 2" label="电话">{{ detail.tell || '—' }}</el-descriptions-item>
              <el-descriptions-item v-if="detail.header_type === 2 && detail.type === 2" label="地址">{{ detail.address || '—' }}</el-descriptions-item>
              <el-descriptions-item v-if="detail.header_type === 2 && detail.type === 2" label="开户行">{{ detail.bank || '—' }}</el-descriptions-item>
              <el-descriptions-item v-if="detail.header_type === 2 && detail.type === 2" label="银行账号">{{ detail.card_number || '—' }}</el-descriptions-item>
              <el-descriptions-item label="订单实付金额">{{ detail.order ? `¥${detail.order.pay_price}` : '—' }}</el-descriptions-item>
              <el-descriptions-item label="保存的票面金额">¥{{ detail.invoice_amount }}</el-descriptions-item>
              <el-descriptions-item label="当前证据推导金额">{{ detail.expected_amount === null ? '暂不可核定' : `¥${detail.expected_amount}` }}</el-descriptions-item>
              <el-descriptions-item label="当前开票状态">{{ invoiceStatusLabel(detail.is_invoice) }}</el-descriptions-item>
              <el-descriptions-item label="发票号码">{{ detail.invoice_number || '—' }}</el-descriptions-item>
              <el-descriptions-item label="备注">{{ detail.remark || '—' }}</el-descriptions-item>
            </el-descriptions>
            <section v-if="detail.order" class="section" aria-label="发票关联订单信息">
              <div class="heading"><h3>关联订单信息</h3><el-button :loading="orderInfoLoading" :disabled="submitting || confirming" @click="loadOrderInfo">{{ orderInfo ? '重新读取订单信息' : '查看订单与商品' }}</el-button></div>
              <p class="hint">此处仅按发票申请行读取旧开票弹窗所需的订单快照；普通订单详情仍需 order.view 权限。</p>
              <el-alert v-if="orderInfoError" :title="orderInfoError" type="error" :closable="false" show-icon />
              <template v-if="orderInfo">
                <el-descriptions :column="descriptionColumns" border>
                  <el-descriptions-item label="用户昵称">{{ orderInfo.user.nickname || '—' }}</el-descriptions-item>
                  <el-descriptions-item label="推广人">{{ orderInfo.user.spread_name || '—' }}</el-descriptions-item>
                  <el-descriptions-item label="收货人">{{ orderInfo.order.real_name || '—' }}</el-descriptions-item>
                  <el-descriptions-item label="收货电话">{{ orderInfo.order.user_phone || '—' }}</el-descriptions-item>
                  <el-descriptions-item label="收货地址">{{ orderInfo.order.user_address || '—' }}</el-descriptions-item>
                  <el-descriptions-item label="商品总数">{{ orderInfo.order.total_num }}</el-descriptions-item>
                  <el-descriptions-item label="商品总价">¥{{ orderInfo.order.total_price }}</el-descriptions-item>
                  <el-descriptions-item label="运费">¥{{ orderInfo.order.pay_postage }}</el-descriptions-item>
                  <el-descriptions-item label="优惠券抵扣">¥{{ orderInfo.order.coupon_price }}</el-descriptions-item>
                  <el-descriptions-item label="会员优惠">{{ orderInfo.order.vip_true_price === null ? '原订单无记录' : `¥${orderInfo.order.vip_true_price}` }}</el-descriptions-item>
                  <el-descriptions-item label="积分抵扣">¥{{ orderInfo.order.deduction_price }}</el-descriptions-item>
                  <el-descriptions-item label="实付金额">¥{{ orderInfo.order.pay_price }}</el-descriptions-item>
                  <el-descriptions-item label="下单时间">{{ invoiceTimeLabel(orderInfo.order.add_time) }}</el-descriptions-item>
                  <el-descriptions-item label="支付方式">{{ invoiceOrderPayTypeLabel(orderInfo.order.pay_type) }}</el-descriptions-item>
                  <el-descriptions-item label="订单备注">{{ orderInfo.order.mark || '—' }}</el-descriptions-item>
                </el-descriptions>
                <h4>商品快照</h4>
                <div class="table-scroll"><el-table :data="orderInfo.cart_items" border row-key="id" empty-text="原订单没有可用商品快照">
                  <el-table-column label="商品" min-width="240"><template #default="{ row }"><div class="product-cell"><el-image v-if="row.image" :src="row.image" fit="cover" class="product-image" /><div><div>{{ row.product_name || `商品 #${row.product_id ?? '未知'}` }}</div><div class="hint">{{ row.category_name || row.sku || '规格未记录' }}</div></div></div></template></el-table-column>
                  <el-table-column label="商品 ID" width="110"><template #default="{ row }">{{ row.product_id ?? '—' }}</template></el-table-column>
                  <el-table-column label="单价" width="115"><template #default="{ row }">{{ row.unit_price === null ? '原订单无记录' : `¥${row.unit_price}` }}</template></el-table-column>
                  <el-table-column prop="quantity" label="数量" width="75" />
                </el-table></div>
              </template>
            </section>
            <el-alert v-if="detail.invoice_amount === '0.00' && detail.expected_amount !== null" class="section" title="历史零金额申请须由服务端在锁内核对权威净额与开票证据。符合条件时由服务端回填；无法证明的旧记录仍只读，页面不提交金额。" type="info" :closable="false" />
            <el-alert v-if="detail.header_type === 1 && detail.type === 2" class="section" title="历史个人纸质组合没有旧版详情模板，请核对原始字段与发票证据。" type="warning" :closable="false" />
            <el-alert v-if="detail.issues.length" class="section" title="需核对的历史或金额问题" type="warning" :closable="false"><ul><li v-for="(issue, index) in detail.issues" :key="index">{{ issue }}</li></ul></el-alert>
            <el-alert v-if="!detail.can_process" class="section" title="当前记录只读；服务端未确认其归属、退款证据或金额可处理。" type="warning" :closable="false" />
            <el-form v-if="canManage && detail.can_process && !uncertainOperation" class="section" label-position="top" :disabled="submitting || confirming">
              <el-form-item label="处理状态"><el-radio-group v-model="formStatus" aria-label="发票处理状态"><el-radio :value="0">待开票</el-radio><el-radio :value="1">已开票</el-radio><el-radio :value="-1">已拒绝</el-radio></el-radio-group></el-form-item>
              <el-form-item label="发票号" :required="formStatus === 1"><el-input v-model="formNumber" aria-label="发票号" maxlength="50" placeholder="标记已开票时必填" /></el-form-item>
              <el-form-item label="备注"><el-input v-model="formRemark" aria-label="发票备注" type="textarea" :rows="3" maxlength="255" show-word-limit /></el-form-item>
              <p class="hint">订单金额和票面金额不可在此修改。提交前服务端会重新校验归属、支付、退款、金额与版本；此操作不上传税务发票，也不办理红字发票。</p>
              <el-alert v-if="formError" :title="formError" type="error" :closable="false" />
            </el-form>
            <p v-else-if="!canManage" class="hint">当前账号仅可查看；处理需要 invoice.manage。</p>
          </template>
        </div>
        <template #footer><el-button :disabled="submitting" @click="detailVisible = false">关闭</el-button><el-button v-if="canManage && detail?.can_process && !uncertainOperation" type="primary" :loading="submitting" :disabled="detailLoading || !!detailError || confirming" @click="process">确认处理</el-button></template>
      </el-dialog>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiInvoiceDetail, apiInvoiceList, apiInvoiceOrderInfo, apiProcessInvoice, currentInvoicePageCsv, invoiceHeaderLabel, invoiceOrderPayTypeLabel, invoiceOrderStatusLabel,
  invoiceStatusLabel, invoiceTimeLabel, invoiceTypeLabel, normalizeInvoiceProcess, normalizeInvoiceQuery,
  type AdminInvoice, type InvoiceOrderInfo, type InvoiceProcessInput, type InvoiceQuery, type InvoiceSearchField, type InvoiceStatus, type InvoiceStatusFilter } from '@/api/invoiceManagement';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('invoice.view') || auth.uniqueAuth.includes('invoice.manage')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('invoice.manage')));
const canViewOrder = computed(() => !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('order.view') || auth.uniqueAuth.includes('order.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const descriptionColumns = computed(() => window.innerWidth <= 680 ? 1 : 2);
const draftDates = ref<[string, string] | null>(null), draftField = ref<InvoiceSearchField>('all'), draftKeyword = ref(''), draftStatus = ref<InvoiceStatusFilter>('all');
const applied = ref<Pick<InvoiceQuery, 'start_time' | 'end_time' | 'field' | 'keyword' | 'status'>>({ start_time: '', end_time: '', field: 'all', keyword: '', status: 'all' });
const list = ref<AdminInvoice[]>([]), count = ref(0), page = ref(1), loading = ref(false), listError = ref(''), notice = ref('');
const detailVisible = ref(false), detailLoading = ref(false), detailError = ref(''), detail = ref<AdminInvoice | null>(null), detailId = ref(0);
const orderInfo = ref<InvoiceOrderInfo | null>(null), orderInfoLoading = ref(false), orderInfoError = ref('');
const formStatus = ref<InvoiceStatus>(0), formNumber = ref(''), formRemark = ref(''), formError = ref('');
const submitting = ref(false), confirming = ref(false);
const uncertainOperation = ref<{ id: number; body: InvoiceProcessInput } | null>(null);
type Scope = { identity: string; generation: number; stored: string | null };
let alive = false, syncing = false, generation = 0, detailVersion = 0, orderInfoVersion = 0, confirmVersion = 0, mutationVersion = 0, stored = localStorage.getItem('admin_session');
let listAbort: AbortController | null = null, detailAbort: AbortController | null = null, orderInfoAbort: AbortController | null = null, mutationAbort: AbortController | null = null;
function scope(): Scope { return { identity: identity.value, generation, stored }; }
function current(value: Scope) { return alive && canView.value && value.identity === identity.value && value.generation === generation &&
  auth.token === getToken() && value.stored === localStorage.getItem('admin_session'); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '请求失败'; }
function filterInvoiceType(value: unknown, row: AdminInvoice) { return row.type === value; }
function filterInvoiceHeader(value: unknown, row: AdminInvoice) { return row.header_type === value; }
function clearOrderInfo() { orderInfoVersion++; orderInfoAbort?.abort(); orderInfoAbort = null; orderInfo.value = null; orderInfoLoading.value = false; orderInfoError.value = ''; }
function resetDetail() { detailVersion++; detailAbort?.abort(); detailAbort = null; clearOrderInfo(); detail.value = null; detailId.value = 0; detailVisible.value = false; detailLoading.value = false; detailError.value = formError.value = ''; formStatus.value = 0; formNumber.value = formRemark.value = ''; }
function closeDetail() { if (!detailVisible.value) resetDetail(); }
function clearList() { generation++; listAbort?.abort(); listAbort = null; list.value = []; count.value = 0; listError.value = ''; loading.value = false; resetDetail(); }
function invalidate() { clearList(); mutationVersion++; mutationAbort?.abort(); mutationAbort = null; confirmVersion++; if (confirming.value) ElMessageBox.close(); confirming.value = submitting.value = false; notice.value = ''; uncertainOperation.value = null; }
async function load(target = page.value) {
  if (!alive || !canView.value || auth.token !== getToken() || stored !== localStorage.getItem('admin_session') || !Number.isSafeInteger(target) || target < 1 || target > 1000) return;
  clearList(); page.value = target;
  const stamp = scope(), controller = new AbortController(); listAbort = controller; loading.value = true;
  try {
    const result = await apiInvoiceList({ page: target, limit: 10, ...applied.value }, controller.signal);
    if (!current(stamp) || listAbort !== controller) return;
    if (!result.list.length && target > 1 && result.count > 0) { await load(Math.min(target - 1, Math.ceil(result.count / 10))); return; }
    list.value = result.list; count.value = result.count;
  } catch (error) { if (current(stamp) && listAbort === controller) listError.value = errorMessage(error); }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search() {
  if (!current(scope()) || submitting.value || confirming.value) return;
  let query: InvoiceQuery;
  try { query = normalizeInvoiceQuery({ page: 1, limit: 10, start_time: draftDates.value?.[0] ?? '', end_time: draftDates.value?.[1] ?? '', field: draftField.value, keyword: draftKeyword.value, status: draftStatus.value }); }
  catch (error) { listError.value = errorMessage(error); return; }
  applied.value = { start_time: query.start_time, end_time: query.end_time, field: query.field, keyword: query.keyword, status: query.status };
  notice.value = ''; void load(1);
}
function reset() { draftDates.value = null; draftField.value = 'all'; draftKeyword.value = ''; draftStatus.value = 'all'; search(); }
async function openDetail(row: AdminInvoice) {
  if (!current(scope()) || submitting.value || confirming.value || !list.value.some(item => item.id === row.id && item.revision === row.revision)) return;
  resetDetail(); detailVisible.value = true; detailId.value = row.id; await reloadDetail();
}
async function reloadDetail() {
  const id = detailId.value;
  if (!id || !detailVisible.value || !current(scope()) || submitting.value) return;
  detailVersion++; detailAbort?.abort(); clearOrderInfo(); const version = detailVersion, stamp = scope(), controller = new AbortController(); detailAbort = controller;
  detailLoading.value = true; detailError.value = formError.value = ''; detail.value = null;
  try {
    const result = await apiInvoiceDetail(id, controller.signal);
    if (!current(stamp) || version !== detailVersion || detailAbort !== controller || !detailVisible.value) return;
    detail.value = result; formStatus.value = result.is_invoice === -1 || result.is_invoice === 0 || result.is_invoice === 1 ? result.is_invoice : 0;
    formNumber.value = result.invoice_number; formRemark.value = result.remark;
  } catch (error) { if (current(stamp) && version === detailVersion) detailError.value = errorMessage(error); }
  finally { if (detailAbort === controller) { detailAbort = null; detailLoading.value = false; } }
}
async function loadOrderInfo() {
  const row = detail.value;
  if (!row?.order || !detailVisible.value || !current(scope()) || submitting.value || confirming.value) return;
  clearOrderInfo();
  const stamp = scope(), detailStamp = detailVersion, version = orderInfoVersion, controller = new AbortController();
  orderInfoAbort = controller; orderInfoLoading.value = true;
  try {
    const result = await apiInvoiceOrderInfo(row.id, controller.signal);
    if (!current(stamp) || !detailVisible.value || detailStamp !== detailVersion || version !== orderInfoVersion || orderInfoAbort !== controller) return;
    if (result.order.id !== row.order_db_id || result.order.uid !== row.uid || result.order.order_number !== row.order_number)
      throw new Error('发票与订单信息归属不一致，请重新读取详情');
    orderInfo.value = result;
  } catch (error) { if (current(stamp) && detailStamp === detailVersion && version === orderInfoVersion && orderInfoAbort === controller)
    orderInfoError.value = errorMessage(error); }
  finally { if (orderInfoAbort === controller) { orderInfoAbort = null; orderInfoLoading.value = false; } }
}
async function process() {
  const row = detail.value;
  if (!row || !current(scope()) || !canManage.value || !row.can_process || !detailVisible.value || detailLoading.value || submitting.value || confirming.value || uncertainOperation.value) return;
  let body: InvoiceProcessInput;
  try { body = normalizeInvoiceProcess({ is_invoice: formStatus.value, invoice_number: formNumber.value, remark: formRemark.value, revision: row.revision, request_id: crypto.randomUUID() }); }
  catch (error) { formError.value = errorMessage(error); return; }
  const stamp = scope(), currentDetailVersion = detailVersion, version = ++confirmVersion;
  const before = JSON.stringify([formStatus.value, formNumber.value, formRemark.value]); formError.value = ''; confirming.value = true;
  try { await ElMessageBox.confirm(`确认处理发票申请 #${row.id}（订单 ${row.order_number || '关联订单异常'}）？\n状态：${invoiceStatusLabel(row.is_invoice)} → ${invoiceStatusLabel(body.is_invoice)}；发票号：${body.invoice_number || '无'}；备注：${body.remark || '无'}。\n票面金额 ¥${row.invoice_amount} 只读；这一步不上传税务发票、不办理红字发票。`,
    '确认发票处理', { type: 'warning', confirmButtonText: '确认处理', cancelButtonText: '取消' }); }
  catch { return; } finally { if (version === confirmVersion) confirming.value = false; }
  if (version !== confirmVersion || currentDetailVersion !== detailVersion || !current(stamp) || !canManage.value || !detailVisible.value ||
    detail.value?.revision !== row.revision || !detail.value.can_process || before !== JSON.stringify([formStatus.value, formNumber.value, formRemark.value])) return;
  const mutation = ++mutationVersion, controller = new AbortController(); mutationAbort = controller; submitting.value = true; notice.value = '';
  try {
    const receipt = await apiProcessInvoice(row.id, body, controller.signal);
    if (!current(stamp) || mutation !== mutationVersion || !canManage.value) return;
    uncertainOperation.value = null;
    if (receipt.archived) notice.value = '原请求已提交，但当前发票申请已归档；请按订单审计记录核对。';
    else if (receipt.superseded) notice.value = `原请求已提交，但发票记录之后已变化，当前状态为${invoiceStatusLabel(receipt.is_invoice)}；请按订单审计记录核对。`;
    ElMessage.success(receipt.archived || receipt.superseded ? '历史发票操作已确认' : '发票申请已处理');
  } catch (error) {
    if (!current(stamp) || mutation !== mutationVersion || !canManage.value) return;
    const rejected = error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status));
    uncertainOperation.value = rejected ? null : { id: row.id, body };
    notice.value = `${rejected ? '处理未完成' : '处理结果未确认'}：${errorMessage(error)}。请重新读取该申请及订单核对；不会自动重发。`;
  } finally { if (mutationAbort === controller) { mutationAbort = null; submitting.value = false; } }
  if (current(stamp)) await load(page.value);
}
async function acknowledge() {
  if (!uncertainOperation.value || !current(scope()) || !canManage.value || loading.value || submitting.value || confirming.value || listError.value) return;
  const stamp = scope(), operation = uncertainOperation.value, version = ++confirmVersion; confirming.value = true;
  try { await ElMessageBox.confirm('仅结束本地待核对状态，不证明原请求成功或失败。请先查看重新读取的发票及订单；之后使用新请求 ID 是一次新的处理。', '结束本地待核对状态', { type: 'warning', confirmButtonText: '已人工核对', cancelButtonText: '取消' }); }
  catch { return; } finally { if (version === confirmVersion) confirming.value = false; }
  if (version === confirmVersion && current(stamp) && canManage.value && uncertainOperation.value === operation) { uncertainOperation.value = null; notice.value = ''; }
}
function exportPage() {
  if (!current(scope()) || loading.value || listError.value || !list.value.length || submitting.value || confirming.value) return;
  const blob = new Blob([currentInvoicePageCsv(list.value)], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob);
  try { const link = document.createElement('a'); link.href = url; link.download = `invoice-page-${page.value}.csv`; document.body.appendChild(link); link.click(); link.remove(); }
  finally { URL.revokeObjectURL(url); }
}
function syncSession() {
  syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); stored = localStorage.getItem('admin_session'); syncing = false;
  page.value = 1; draftDates.value = null; draftField.value = 'all'; draftKeyword.value = ''; draftStatus.value = 'all';
  applied.value = { start_time: '', end_time: '', field: 'all', keyword: '', status: 'all' }; void load(1);
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(identity, () => { if (alive && !syncing) { invalidate(); page.value = 1; void load(1); } }, { flush: 'sync' });
watch(detailVisible, visible => { if (!visible) clearOrderInfo(); }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.invoice-management { min-width: 0; }.heading, .table-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.heading h2 { font-size: 20px; margin: 0 0 7px; }.hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.65; }
.section { margin-top: 16px; }.filters { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
.filter-field { display: flex; flex-direction: column; gap: 6px; min-width: 165px; font-size: 13px; }.filter-field:first-child { flex: 0 1 310px; }.filter-field:nth-child(3) { flex: 1 1 210px; }
.field-select { width: 165px; }.filter-field :deep(.el-date-editor), .filter-field :deep(.el-select), .filter-field :deep(.el-input) { width: 100%; }
.product-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }.product-image { width: 48px; height: 48px; flex: 0 0 48px; border-radius: 4px; }
.filter-actions { display: flex; gap: 8px; }.filter-actions :deep(.el-button + .el-button) { margin-left: 0; }
.table-scroll { width: 100%; overflow-x: auto; }.table-actions { margin-top: 16px; }pre { white-space: pre-wrap; overflow-wrap: anywhere; }
@media(max-width: 680px) { .heading h2 { font-size: 18px; }.filter-field, .field-select { width: 100%; flex: 1 1 100%; } }
</style>
