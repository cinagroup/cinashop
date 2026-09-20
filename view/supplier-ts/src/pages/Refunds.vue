<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import {
  agreeRefundReturn,
  getRefundDetail,
  getRefundReasons,
  getRefunds,
  refundOrder,
  refuseRefund,
  updateRefundRemark,
  previewMode,
} from "@/api/supplier";
import { ApiError } from '@/api/http';
import { createSupplierSessionScope } from '@/utils/supplierSession';
import { useAuthStore } from '@/stores/auth';
import type { RefundDetail, RefundRow } from "@/types";
import { formatMoney, formatTime, payType } from "@/utils/format";

const loading = ref(false);
const rows = ref<RefundRow[]>([]);
const total = ref(0);
const filters = reactive({
  page: 1,
  limit: 20,
  keyword: "",
  refund_type: "",
  apply_type: "",
  refund_reason: "",
});
const refundReasons = ref<string[]>([]);
const drawerOpen = ref(false);
const detailLoading = ref(false);
const current = ref<RefundDetail | null>(null);
const remark = ref("");
const refuseDialogOpen = ref(false);
const refuseReason = ref("");
const actionLoading = ref(false);
const detailError = ref('');
const listError = ref('');
const selectedId = ref(0);
const invalidated = ref(false);
const uncertainIds = reactive(new Set<number>());
const brokenImages = reactive(new Set<string>());
const auth = useAuthStore();
const route = useRoute();
const mountedPath = route.fullPath;
let detailGeneration = 0, listGeneration = 0, confirmationPending = false;
function clearDetail() {
  detailGeneration += 1; selectedId.value = 0; current.value = null; remark.value = '';
  refuseDialogOpen.value = false; refuseReason.value = ''; detailLoading.value = false; detailError.value = ''; brokenImages.clear();
  if (confirmationPending) ElMessageBox.close();
  confirmationPending = false;
}
function invalidate() {
  invalidated.value = true; clearDetail(); drawerOpen.value = false;
  listGeneration += 1; rows.value = []; total.value = 0; refundReasons.value = [];
  loading.value = false; listError.value = ''; filters.keyword = ''; filters.refund_reason = '';
}
const session = createSupplierSessionScope(invalidate, previewMode);
function active() { return session.isCurrent() && !invalidated.value && route.fullPath === mountedPath; }
watch(() => route.fullPath, () => { invalidate(); session.dispose(); }, { flush: 'sync' });
watch(drawerOpen, open => { if (!open) clearDetail(); }, { flush: 'sync' });
onBeforeUnmount(() => { invalidate(); session.dispose(); });
const canManage = computed(() => !invalidated.value && (previewMode || auth.can('supplier.refund.manage')));
const canWrite = computed(() => canManage.value && drawerOpen.value && !!current.value && current.value.is_cancel === 0
  && !detailLoading.value && !actionLoading.value && !uncertainIds.has(current.value.id));

const statusMap: Record<number, { label: string; tone: string }> = {
  0: { label: "待处理", tone: "warning" },
  1: { label: "待处理", tone: "warning" },
  2: { label: "待处理", tone: "warning" },
  3: { label: "已拒绝", tone: "danger" },
  4: { label: "等待退货", tone: "primary" },
  5: { label: "用户已退货", tone: "primary" },
  6: { label: "已退款", tone: "success" },
};

function refundStatus(type: number) {
  return statusMap[type] ?? { label: "未知", tone: "info" };
}

const providerStatusMap: Record<string, { label: string; tone: string }> = {
  CREATED: { label: "待发起", tone: "warning" },
  REQUESTING: { label: "渠道请求中", tone: "warning" },
  PROCESSING: { label: "渠道处理中", tone: "primary" },
  SUCCESS: { label: "渠道已成功", tone: "success" },
  CLOSED: { label: "渠道已关闭", tone: "danger" },
  ABNORMAL: { label: "渠道异常", tone: "danger" },
  FAILED: { label: "渠道失败", tone: "danger" },
  UNKNOWN: { label: "结果待核对", tone: "warning" },
};

function displayStatus(row: RefundRow) {
  if (row.is_cancel === 1) return { label: '用户已取消', tone: 'info' };
  return row.provider_status ? providerStatusMap[row.provider_status] ?? refundStatus(row.refund_type) : refundStatus(row.refund_type);
}

function applyType(type: number) {
  return type === 1 ? "仅退款" : type === 2 ? "退货退款" : type === 3 ? "到店退货" : "平台退款";
}

const canProcess = computed(() => canWrite.value && current.value && [0, 1, 2, 4, 5].includes(current.value.refund_type));
const canAgreeReturn = computed(
  () => canProcess.value && current.value && [2, 3].includes(current.value.apply_type) && current.value.refund_type < 4,
);
const canRefund = computed(
  () => canProcess.value && current.value &&
    ([0, 1, 2, 5].includes(current.value.refund_type) ||
      (current.value.refund_type === 4 && current.value.apply_type === 3)) &&
    ["yue", "weixin", "alipay"].includes(current.value.pay_type),
);
const canRefuse = computed(() => {
  if (!canProcess.value || !current.value) return false;
  return !["REQUESTING", "PROCESSING", "SUCCESS", "UNKNOWN", "ABNORMAL"].includes(current.value.provider_status ?? "");
});

async function load() {
  if (!active()) return;
  const generation = ++listGeneration;
  loading.value = true; listError.value = ''; rows.value = []; total.value = 0;
  try {
    const result = await getRefunds({ ...filters }, session.signal);
    if (!active() || generation !== listGeneration) return;
    if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0) throw Error('售后列表响应无效');
    rows.value = result.list;
    total.value = result.count;
  } catch (error) {
    if (active() && generation === listGeneration) listError.value = error instanceof Error ? error.message : '售后列表加载失败';
  } finally {
    if (active() && generation === listGeneration) loading.value = false;
  }
}

async function loadRefundReasons() {
  try {
    const result = await getRefundReasons(session.signal);
    if (active()) refundReasons.value = result;
  } catch (error) {
    if (active()) ElMessage.error(error instanceof Error ? error.message : "退款原因加载失败");
  }
}

function search() {
  filters.page = 1;
  void load();
}

async function openRefund({ id }: Pick<RefundRow, 'id'>) {
  if (!active() || !Number.isSafeInteger(id) || id <= 0) return;
  clearDetail(); selectedId.value = id;
  const generation = detailGeneration;
  const isCurrent = () => active() && drawerOpen.value && selectedId.value === id && generation === detailGeneration;
  drawerOpen.value = true;
  detailLoading.value = true;
  try {
    const result = await getRefundDetail(id, session.signal);
    if (!isCurrent()) return;
    current.value = result; remark.value = result.remark;
    const index = rows.value.findIndex(item => item.id === id);
    if (index >= 0) rows.value[index] = { ...rows.value[index], ...result };
  } catch (error) {
    if (isCurrent()) detailError.value = error instanceof Error ? error.message : '售后详情加载失败';
  } finally {
    if (isCurrent()) detailLoading.value = false;
  }
}

async function refreshCurrent() {
  if (!active() || !selectedId.value || actionLoading.value) return;
  await openRefund({ id: selectedId.value });
}

// A confirmation, request and read-back belong to one immutable detail opening.
// Switching A -> B -> A, closing or replacing the session cannot revive it.
async function mutate(kind: 'remark' | 'agree' | 'refuse' | 'refund') {
  if (!active() || !canWrite.value || !current.value) return;
  if ((kind === 'agree' && !canAgreeReturn.value) || (kind === 'refuse' && (!canRefuse.value || !refuseDialogOpen.value))
    || (kind === 'refund' && !canRefund.value)) return;
  const target = { id: current.value.id, amount: current.value.refund_price, generation: detailGeneration };
  const text = (kind === 'remark' ? remark.value : refuseReason.value).trim();
  if (['remark', 'refuse'].includes(kind) && (!text || text.length > 255)) { ElMessage.warning('请输入不超过 255 字的内容'); return; }
  const ownsView = () => active() && drawerOpen.value && selectedId.value === target.id && detailGeneration === target.generation;
  actionLoading.value = true;
  let dispatched = false;
  try {
    if (kind === 'refund') {
      confirmationPending = true;
      try {
        await ElMessageBox.confirm(`确认向用户退款 ${formatMoney(target.amount)}？该操作不可撤销。`, '确认退款',
          { type: 'warning', confirmButtonText: '确认退款', cancelButtonText: '取消' });
      } catch { return; }
      finally { confirmationPending = false; }
    }
    if (!ownsView() || !canManage.value) return;
    dispatched = true;
    let message: string;
    if (kind === 'refund') {
      const result = await refundOrder(target.id, target.amount, session.signal);
      if (!result || !((result.completed === true && ['SUCCESS', 'BALANCE_SUCCESS'].includes(result.status))
        || (result.completed === false && result.status === 'PROCESSING'))) throw Error('退款回执无效，结果待核对');
      message = result.completed ? '退款完成' : '退款已受理，正在等待渠道确认';
    } else {
      const result = kind === 'remark' ? await updateRefundRemark(target.id, text, session.signal)
        : kind === 'agree' ? await agreeRefundReturn(target.id, session.signal) : await refuseRefund(target.id, text, session.signal);
      if (result !== null) throw Error('操作回执无效，结果待核对');
      message = kind === 'remark' ? '备注已保存' : kind === 'agree' ? '已同意退货，等待用户寄回' : '已拒绝退款';
    }
    if (!ownsView()) return;
    refuseDialogOpen.value = false;
    const refreshedGeneration = detailGeneration + 1;
    await openRefund({ id: target.id });
    if (active() && drawerOpen.value && selectedId.value === target.id && detailGeneration === refreshedGeneration) {
      if (detailError.value) ElMessage.warning('操作已受理，但最新详情读取失败，请刷新核对');
      else ElMessage.success(message);
    }
  } catch (error) {
    if (!active()) return;
    // Do not infer failure from transport errors, malformed success or 5xx.
    if (dispatched && !(error instanceof ApiError && error.status === 400)) uncertainIds.add(target.id);
    if (ownsView()) ElMessage.error(error instanceof Error ? error.message : '操作结果待核对');
  } finally {
    actionLoading.value = false;
  }
}
async function saveRemark() { await mutate('remark'); }
async function agreeReturnAction() { await mutate('agree'); }

function openRefuse() {
  if (!active() || !canRefuse.value) return;
  refuseReason.value = "";
  refuseDialogOpen.value = true;
}

async function submitRefuse() {
  await mutate('refuse');
}

async function refundAction() {
  await mutate('refund');
}

onMounted(() => {
  void Promise.all([load(), loadRefundReasons()]);
});
</script>

<template>
  <section class="page-section">
    <header class="page-heading"><div><h1>售后管理</h1><p>所有售后操作均限定当前供应商订单</p></div></header>
    <el-alert v-if="invalidated" title="账号、权限或页面已改变，请重新进入售后管理。" type="warning" :closable="false" />
    <el-alert v-if="listError" :title="listError" type="error" :closable="false" />
    <div class="surface list-surface">
      <div class="filter-row">
        <el-input v-model="filters.keyword" class="search-input" clearable placeholder="售后单号、订单号或客户" @keyup.enter="search">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select v-model="filters.apply_type" class="state-select" placeholder="售后类型" clearable @change="search">
          <el-option label="仅退款" value="1" /><el-option label="退货退款" value="2" /><el-option label="到店退货" value="3" />
        </el-select>
        <el-select v-model="filters.refund_type" class="state-select" placeholder="处理状态" clearable @change="search">
          <el-option label="待处理" value="0" /><el-option label="已拒绝" value="3" /><el-option label="等待退货" value="4" /><el-option label="用户已退货" value="5" /><el-option label="已退款" value="6" />
        </el-select>
        <el-select v-model="filters.refund_reason" class="state-select" placeholder="退款原因" clearable filterable @change="search">
          <el-option v-for="reason in refundReasons" :key="reason" :label="reason" :value="reason" />
        </el-select>
        <el-button type="primary" :disabled="invalidated" @click="search">查询</el-button>
      </div>
      <el-table v-loading="loading" :data="rows" row-key="id" @row-click="openRefund">
        <el-table-column prop="refund_order_id" label="售后单号" min-width="170" />
        <el-table-column prop="order_id" label="订单号" min-width="180" />
        <el-table-column label="客户" min-width="170"><template #default="scope"><div class="customer-cell"><strong>{{ scope.row.real_name }}</strong><span>{{ scope.row.user_phone }}</span></div></template></el-table-column>
        <el-table-column label="类型" width="110"><template #default="scope">{{ applyType(scope.row.apply_type) }}</template></el-table-column>
        <el-table-column label="退款金额" width="130"><template #default="scope">{{ formatMoney(scope.row.refund_price) }}</template></el-table-column>
        <el-table-column label="状态" width="130"><template #default="scope"><span class="status-text" :class="displayStatus(scope.row).tone">{{ displayStatus(scope.row).label }}</span></template></el-table-column>
        <el-table-column label="申请时间" width="180"><template #default="scope">{{ formatTime(scope.row.add_time) }}</template></el-table-column>
        <el-table-column label="操作" width="90"><template #default="scope"><el-button link type="primary" @click.stop="openRefund(scope.row)">详情</el-button></template></el-table-column>
      </el-table>
      <div class="pagination-row"><span>共 {{ total }} 个售后单</span><el-pagination v-model:current-page="filters.page" :page-size="filters.limit" :total="total" layout="prev, pager, next" @current-change="load" /></div>
    </div>

    <el-drawer v-model="drawerOpen" title="售后详情" size="min(560px, 94vw)">
      <div v-loading="detailLoading" class="order-detail">
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" />
        <el-button v-if="selectedId" :disabled="detailLoading || actionLoading" @click="refreshCurrent">刷新详情 / 凭证</el-button>
        <el-alert v-if="uncertainIds.has(selectedId)" title="此单有操作结果待核对，本页已暂停重复提交。请只读刷新并核对渠道和操作记录；重新进入页面前先确认结果。" type="warning" :closable="false" />
        <template v-if="current">
          <div class="detail-order-id">{{ current.refund_order_id }}</div>
          <dl class="detail-grid">
            <div><dt>关联订单</dt><dd>{{ current.order_id }}</dd></div>
            <div><dt>客户</dt><dd>{{ current.real_name }}</dd></div>
            <div><dt>售后类型</dt><dd>{{ applyType(current.apply_type) }}</dd></div>
            <div><dt>支付方式</dt><dd>{{ payType(current.pay_type) }}</dd></div>
            <div><dt>申请金额</dt><dd>{{ formatMoney(current.refund_price) }}</dd></div>
            <div><dt>处理状态</dt><dd><span class="status-text" :class="displayStatus(current).tone">{{ displayStatus(current).label }}</span></dd></div>
            <div v-if="current.out_refund_no"><dt>渠道退款号</dt><dd>{{ current.out_refund_no }}</dd></div>
          </dl>
          <div class="refund-reason"><span>用户原因</span><p>{{ current.refund_reason || "未填写" }}</p></div>
          <div v-if="current.refund_explain" class="refund-reason"><span>申请说明</span><p>{{ current.refund_explain }}</p></div>
          <section v-if="current.refundHistory" class="refund-history" aria-label="退款商品快照">
            <h3>退款商品快照</h3>
            <p>以下为退款完成时的归档商品，不随后续拆单或商品编辑变化。</p>
            <el-alert v-if="current.refundHistory.itemsError" :title="current.refundHistory.itemsError" type="warning" :closable="false" />
            <template v-else>
              <p>原申请订单 ID：{{ current.refundHistory.sourceOrderId }} · 退款归属订单 ID：{{ current.refundHistory.physicalOrderId }}</p>
              <ul><li v-for="item in current.refundHistory.items" :key="item.id">
                <strong>{{ item.name }}</strong><span>{{ item.sku || '无规格' }} · 退款数量：{{ item.quantity }}</span>
              </li></ul>
            </template>
          </section>
          <section class="return-evidence" aria-label="用户退货信息">
            <h3>用户退货信息</h3>
            <p class="security-note">以下为用户提交内容，不代表商家已收货或退款已到账。</p>
            <dl class="detail-grid">
              <div><dt>退货快递</dt><dd>{{ current.refund_express_name || '未填写' }}</dd></div>
              <div><dt>退货运单号</dt><dd>{{ current.refund_express || '未填写' }}</dd></div>
              <div><dt>退货联系电话</dt><dd>{{ current.refund_phone || '未填写' }}</dd></div>
            </dl>
            <div class="refund-reason"><span>退货备注</span><p>{{ current.refund_goods_explain || '未填写' }}</p></div>
            <h4>退货凭证</h4>
            <el-alert v-if="current.returnImagesError" :title="current.returnImagesError" type="warning" :closable="false" />
            <p v-else-if="!current.returnImages.length" class="security-note">用户未上传退货凭证</p>
            <div v-else class="return-images">
              <div v-for="(image, index) in current.returnImages" :key="image.src">
                <span v-if="brokenImages.has(image.src)" class="security-note">凭证 {{ index + 1 }} 读取失败，请刷新详情</span>
                <a v-else :href="image.src" target="_blank" rel="noopener noreferrer" :aria-label="`查看退货凭证 ${index + 1}`">
                  <img :src="image.src" :alt="`用户退货凭证 ${index + 1}`" referrerpolicy="no-referrer" @error="brokenImages.add(image.src)" />
                </a>
              </div>
            </div>
          </section>
          <div v-if="current.refuse_reason" class="refund-reason danger-note"><span>拒绝原因</span><p>{{ current.refuse_reason }}</p></div>
          <div class="remark-editor"><label for="refund-remark">供应商备注</label><el-input id="refund-remark" v-model="remark" :disabled="!canWrite" type="textarea" :rows="3" maxlength="255" show-word-limit /></div>
          <div class="drawer-actions">
            <el-button :loading="actionLoading" :disabled="!canWrite" @click="saveRemark">保存备注</el-button>
            <el-button v-if="canAgreeReturn" type="primary" plain :loading="actionLoading" @click="agreeReturnAction">同意退货</el-button>
            <el-button v-if="canRefuse" type="danger" plain :loading="actionLoading" @click="openRefuse">拒绝退款</el-button>
            <el-button v-if="canRefund" type="primary" :loading="actionLoading" @click="refundAction">{{ current.provider_status ? "查询 / 重试退款" : "确认退款" }}</el-button>
          </div>
          <p v-if="current.provider_error" class="security-note">渠道信息：{{ current.provider_error }}</p>
          <p v-if="current.provider_status && current.refund_type !== 6" class="security-note">渠道受理不等于退款完成；系统仅在验签回调或主动查询确认成功后完成本地入账。</p>
        </template>
      </div>
    </el-drawer>

    <el-dialog v-model="refuseDialogOpen" title="拒绝退款" width="min(460px, 92vw)">
      <el-input v-model="refuseReason" type="textarea" :rows="4" maxlength="255" show-word-limit placeholder="请填写清晰、可审计的拒绝原因" />
      <template #footer><el-button @click="refuseDialogOpen = false">取消</el-button><el-button type="danger" :disabled="!canRefuse" :loading="actionLoading" @click="submitRefuse">确认拒绝</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.return-evidence { margin: 24px 0; border-top: 1px solid var(--border-soft); }
.return-evidence h3 { margin-bottom: 8px; }
.return-evidence h4 { font-size: 14px; }
.return-images { display: flex; flex-wrap: wrap; gap: 12px; }
.return-images > div { width: 112px; }
.return-images img { width: 112px; height: 112px; object-fit: contain; border: 1px solid var(--border-soft); border-radius: 8px; }
.detail-grid dd, .refund-reason p, .detail-order-id { overflow-wrap: anywhere; white-space: pre-wrap; }
.refund-history { margin:20px 0; border-top:1px solid var(--border-soft); }.refund-history ul { padding-left:20px; }
.refund-history li,.refund-history p { overflow-wrap:anywhere; }.refund-history li { margin:12px 0; }
.refund-history li span { display:block; margin-top:4px; }
</style>
