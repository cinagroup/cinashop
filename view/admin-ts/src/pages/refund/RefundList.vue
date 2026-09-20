<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import dayjs from 'dayjs';
import RefundCreation from './RefundCreation.vue';
import { apiAdminRefundList, apiAdminRefundDetail, apiAdminRefundOperation, previewMode, type AdminRefund, type AdminRefundDetail } from '@/api/refund';
import { getAdminSession } from '@/utils/auth';
import { createAdminSessionScope } from '@/utils/adminSessionScope';
import { refundIntentKey } from '@/utils/refundIntent';
import { makeRefundOperation, readRefundOperation, refundOperationKey, withRefundActionLock, writeRefundOperation,
  applyOperationResult, operationMessage, type RefundOperation, type RefundAction, type OperationResult, type OperationMode } from '@/utils/refundOperation';

const route = useRoute(), routeKey = route.fullPath, identity = getAdminSession();
const list = ref<AdminRefund[]>([]), loading = ref(false), listError = ref(''), detailError = ref('');
const keyword = ref(''), status = ref(''), before = ref<string>(), nextCursor = ref<string | null>(null), history = ref<Array<string | undefined>>([]);
const recoveryId = ref('');
const selectedId = ref(0), detailOpen = ref(false), detailLoading = ref(false), current = ref<AdminRefundDetail | null>(null);
const actionLoading = ref(false), sessionInvalid = ref(false), received = ref(false);
const brokenImages = reactive(new Set<string>()), uncertainIds = reactive(new Set<number>());
let listGeneration = 0, detailGeneration = 0, actionGeneration = 0;
let detailController: AbortController | undefined;
let ownsConfirmation = false;
const actorId = identity?.userInfo.id ?? (previewMode ? 1 : 0);
const pendingReadable = ref(true), legacyPending = ref(false), pendingIntent = ref<RefundOperation | null>(null), reconcileMessage = ref('');
let observedRaw: string | null = null;
function acceptIntent(state: Awaited<ReturnType<typeof readRefundOperation>>, id: number) {
  observedRaw = state.raw; legacyPending.value = state.legacy; pendingIntent.value = state.intent; pendingReadable.value = true;
  if (state.legacy || state.intent?.phase === 'pending') uncertainIds.add(id); else uncertainIds.delete(id);
}
function clearDetail(preserveAction = false) {
  if (ownsConfirmation) { ElMessageBox.close(); ownsConfirmation = false; }
  detailGeneration++; if (!preserveAction) { actionGeneration++; actionLoading.value = false; } detailController?.abort();
  current.value = null; detailError.value = ''; detailLoading.value = false;
  pendingIntent.value = null; observedRaw = null; legacyPending.value = false; reconcileMessage.value = '';
  received.value = false; brokenImages.clear();
}
function invalidate() {
  sessionInvalid.value = true; listGeneration++; loading.value = false; list.value = []; listError.value = '';
  clearDetail(); detailOpen.value = false; selectedId.value = 0; nextCursor.value = null;
  keyword.value = ''; status.value = ''; history.value = []; before.value = undefined;
  recoveryId.value = '';
  uncertainIds.clear();
}
const scope = createAdminSessionScope(invalidate, previewMode);
const active = () => scope.isCurrent() && route.fullPath === routeKey && !sessionInvalid.value;
const canManage = computed(() => !sessionInvalid.value && (previewMode || identity?.userInfo.level === 0 || identity?.uniqueAuth.includes('refund.manage')));
const canWrite = computed(() => !previewMode && !!current.value && canManage.value && !actionLoading.value && !detailLoading.value
  && current.value.isCancel === 0 && current.value.isDel === 0 && [0,1,2,4,5].includes(current.value.refundType) && pendingReadable.value
  && !uncertainIds.has(current.value.id) && (!current.value.providerStatus || ['CREATED','FAILED','CLOSED'].includes(current.value.providerStatus)));
const canReturn = computed(() => canWrite.value && [2,3].includes(current.value!.applyType) && [0,1,2].includes(current.value!.refundType));
const needsReceipt = computed(() => !!current.value && (current.value.applyType === 2 && current.value.refundType === 5
  || current.value.applyType === 3 && [4,5].includes(current.value.refundType)));
const canRefund = computed(() => canWrite.value && (![2,3].includes(current.value!.applyType) || (needsReceipt.value && received.value)));
const canReconcile = computed(() => !previewMode && canManage.value && !actionLoading.value && !detailLoading.value && pendingReadable.value && !legacyPending.value && pendingIntent.value?.phase === 'pending');
function storageChanged(event: StorageEvent) {
  if (!selectedId.value || !active()) return;
  if (event.storageArea !== localStorage) return;
  if (event.key === null || event.key === 'admin-refund-pending-v1:' + actorId || event.key === refundIntentKey(actorId, selectedId.value) || event.key === refundOperationKey(actorId, selectedId.value)) {
    clearDetail(); detailError.value = '其他标签页已更新操作记录，请刷新详情后核对';
  }
}
window.addEventListener('storage', storageChanged);
watch(detailOpen, value => { if (!value) { clearDetail(); selectedId.value = 0; } }, { flush: 'sync' });
watch(() => route.fullPath, value => { if (value !== routeKey) { invalidate(); scope.dispose(); } }, { flush: 'sync' });
onBeforeUnmount(() => { window.removeEventListener('storage', storageChanged); invalidate(); scope.dispose(); });

const applyTypeText = (type: number) => ({1:'仅退款',2:'退货退款',3:'到店退货',4:'平台退款'}[type] ?? '未知类型');
function statusText(row: AdminRefund) {
  if (row.isCancel) return '用户已取消';
  if (row.providerStatus && !['CREATED','FAILED','CLOSED','SUCCESS'].includes(row.providerStatus)) return '渠道处理中';
  return ({0:'待处理',1:'处理中',2:'待审核',3:'已拒绝',4:'等待退货',5:'用户已寄回',6:'已退款'}[row.refundType] ?? '未知状态');
}
const formatTime = (ts: number) => ts ? dayjs(ts * 1000).format('YYYY-MM-DD HH:mm') : '-';
async function load() {
  if (!active()) return;
  const generation = ++listGeneration;
  list.value = []; nextCursor.value = null; listError.value = ''; loading.value = true;
  try {
    const result = await apiAdminRefundList({ limit: 20, before: before.value, keyword: keyword.value, status: status.value }, scope.signal);
    if (active() && generation === listGeneration) { list.value = result.list; nextCursor.value = result.nextCursor; }
  } catch (error) { if (active() && generation === listGeneration) listError.value = error instanceof Error ? error.message : '列表读取失败'; }
  finally { if (active() && generation === listGeneration) loading.value = false; }
}
async function search() { before.value = undefined; history.value = []; await load(); }
async function nextPage() { if (loading.value || !nextCursor.value) return; history.value.push(before.value); before.value = nextCursor.value; await load(); }
async function previousPage() { if (loading.value || !history.value.length) return; before.value = history.value.pop(); await load(); }
async function readCurrent() { return readDetail(false); }
async function readDetail(preserveAction: boolean) {
  if (!active() || !detailOpen.value || !selectedId.value) return false;
  clearDetail(preserveAction); const generation = detailGeneration, id = selectedId.value;
  detailController = new AbortController(); detailLoading.value = true;
  try {
    let stored: Awaited<ReturnType<typeof readRefundOperation>>;
    try {
      stored = await readRefundOperation(actorId, id);
      if (!active() || generation !== detailGeneration || selectedId.value !== id || !detailOpen.value) return false;
      acceptIntent(stored, id);
    }
    catch (error) { if (active() && generation === detailGeneration) pendingReadable.value = false; throw error; }
    const value = await apiAdminRefundDetail(id, detailController.signal);
    if (!active() || generation !== detailGeneration || selectedId.value !== id || !detailOpen.value) return false;
    const latest = await readRefundOperation(actorId, id);
    if (!active() || generation !== detailGeneration || selectedId.value !== id || !detailOpen.value) return false;
    if (stored.raw !== latest.raw || stored.legacy !== latest.legacy) throw Error('读取期间原操作已被其他标签页更新，请重新刷新核对');
    current.value = value; return true;
  } catch (error) { if (active() && generation === detailGeneration) detailError.value = error instanceof Error ? error.message : '详情读取失败'; return false; }
  finally { if (active() && generation === detailGeneration) detailLoading.value = false; }
}
async function openRefund(row: Pick<AdminRefund, 'id'>) {
  if (!active()) return;
  detailOpen.value = true; selectedId.value = row.id; await readCurrent();
}
async function openRecovery() {
  if (!active()) return;
  if (!/^[1-9]\d{0,9}$/.test(recoveryId.value) || Number(recoveryId.value) > 2147483647) {
    ElMessage.error('请输入有效的退款单 ID'); return;
  }
  await openRefund({ id: Number(recoveryId.value) });
}
async function mutate(kind: RefundAction) {
  if (!active() || !canWrite.value || !current.value || (kind === 'return' && !canReturn.value) || (kind === 'refund' && !canRefund.value)) return;
  const target = Object.freeze({ ...current.value }), expectedRaw = observedRaw, action = ++actionGeneration;
  const owns = () => active() && action === actionGeneration && detailOpen.value && selectedId.value === target.id;
  actionLoading.value = true; let dispatched = false;
  try {
    let reason = '';
    ownsConfirmation = true;
    if (kind === 'refuse') {
      const result = await ElMessageBox.prompt('请输入拒绝原因', '拒绝退款', { inputValue: '不满足退款条件', inputValidator: value => !!value?.trim() && value.length <= 255 || '请填写1–255字的拒绝原因' });
      reason = result.value.trim(); if (!reason || reason.length > 255) return;
    } else {
      await ElMessageBox.confirm(kind === 'return' ? '同意此单退货，等待用户寄回；此操作不会发起资金退款。'
        : '确认向 UID ' + target.uid + ' 退款 ¥' + target.refundPrice + '？退款单：' + target.orderId, kind === 'return' ? '退货审批' : '退款确认');
    }
    if (!owns()) return;
    ownsConfirmation = false;
    if (kind === 'refund' && [2,3].includes(target.applyType) && !received.value) return;
    await withRefundActionLock(target.id, async () => {
      if (!owns() || kind === 'refund' && [2,3].includes(target.applyType) && !received.value) return;
      const stored = await readRefundOperation(actorId, target.id);
      if (!owns()) return;
      if (stored.raw !== expectedRaw || stored.legacy || stored.intent?.phase === 'pending') throw Error('原操作记录已变化，请刷新核对；不会再次提交');
      const intent = await makeRefundOperation(actorId, target, kind, reason, kind === 'refund' && received.value);
      if (!owns() || kind === 'refund' && [2,3].includes(target.applyType) && !received.value) return;
      let raw: string;
      try { raw = writeRefundOperation(intent, expectedRaw); }
      catch (error) { pendingReadable.value = false; throw error; }
      acceptIntent({ raw, legacy: false, intent }, target.id);
      dispatched = true;
      const result = await apiAdminRefundOperation(intent, 'execute', scope.signal);
      if (!owns()) return;
      const message = await recordResult(intent, raw, result, owns);
      if (!owns()) return;
      if (result.receipt?.outcome === 'abandoned') ElMessage.warning(message); else ElMessage.success(message);
      await readDetail(true);
      if (!owns()) return;
      reconcileMessage.value = message;
      await load();
    });
  } catch (error) {
    if (!owns() || error === 'cancel' || error === 'close') return;
    ElMessage.error(dispatched ? '操作结果待核对，原键已保留；请查询回执，不要新建请求' : error instanceof Error ? error.message : '操作未提交');
  } finally { if (action === actionGeneration) { actionLoading.value = false; ownsConfirmation = false; } }
}
/** Only bound durable evidence can resolve v3. Mutable business detail is never
 * evidence that a delayed original request has been fenced or accepted. */
async function recordResult(intent: RefundOperation, raw: string, result: OperationResult, owns: () => boolean) {
  const stored = await readRefundOperation(actorId, intent.refundId);
  if (!owns()) return '';
  if (stored.raw !== raw || stored.legacy) throw Error('原操作已变化，请刷新核对');
  const next = applyOperationResult(intent, result);
  let nextRaw: string;
  try { nextRaw = writeRefundOperation(next, raw); }
  catch (error) { pendingReadable.value = false; throw error; }
  acceptIntent({ raw: nextRaw, legacy: false, intent: next }, intent.refundId);
  return operationMessage(next);
}
async function reconcilePending() { return recoverPending('receipt'); }
async function recoverPending(mode: OperationMode) {
  if (!active() || !canReconcile.value || !pendingIntent.value || observedRaw === null) return;
  const intent = pendingIntent.value, raw = observedRaw, action = ++actionGeneration;
  const owns = () => active() && action === actionGeneration && detailOpen.value && selectedId.value === intent.refundId;
  actionLoading.value = true;
  try {
    if (mode !== 'receipt') {
      ownsConfirmation = true;
      await ElMessageBox.confirm(mode === 'abandon'
        ? '仅为未受理的原键建立永久放弃屏障；已受理操作不会取消。确认继续？'
        : '使用已保存的原键和原决定重试，可能执行尚未受理的操作或继续查询退款渠道。不会生成新键。确认继续？',
        mode === 'abandon' ? '放弃未受理的原操作' : '重试原操作');
      if (!owns()) return;
      ownsConfirmation = false;
    }
    await withRefundActionLock(intent.refundId, async () => {
      if (!owns()) return;
      const stored = await readRefundOperation(actorId, intent.refundId);
      if (!owns()) return;
      if (stored.raw !== raw || stored.legacy) throw Error('原操作已变化，请刷新核对');
      const result = await apiAdminRefundOperation(intent, mode, scope.signal);
      if (!owns()) return;
      const message = await recordResult(intent, raw, result, owns);
      if (!owns()) return;
      await readDetail(true);
      if (!owns()) return;
      reconcileMessage.value = message;
      await load();
    });
  } catch (error) { if (owns() && error !== 'cancel' && error !== 'close') reconcileMessage.value = error instanceof Error ? error.message : '核对失败，原操作仍保留'; }
  finally { if (action === actionGeneration) { actionLoading.value = false; ownsConfirmation = false; } }
}
onMounted(load);
</script>

<template>
  <section class="refund-list">
    <RefundCreation />
    <el-alert v-if="previewMode" title="本地预览仅可查看，未连接持久化回执接口，不支持提交操作" type="info" :closable="false" />
    <el-alert v-if="sessionInvalid" title="登录状态或权限已变化，请重新登录或重新打开页面" type="warning" :closable="false" />
    <el-card shadow="never">
      <form class="toolbar" @submit.prevent="search">
        <el-input v-model="keyword" placeholder="搜索原订单号或退款单号" aria-label="搜索单号" maxlength="64" :disabled="sessionInvalid" />
        <el-select v-model="status" aria-label="售后状态" :disabled="sessionInvalid">
          <el-option label="全部状态" value="" />
          <el-option v-for="i in [0,1,2,3,4,5,6]" :key="i" :label="['待处理','处理中','待审核','已拒绝','等待退货','用户已寄回','已退款'][i]" :value="String(i)" />
        </el-select>
        <el-button native-type="submit" :loading="loading" :disabled="sessionInvalid">查询</el-button>
      </form>
      <form class="toolbar" @submit.prevent="openRecovery">
        <el-input v-model="recoveryId" placeholder="原退款单 ID（列表已移除也可查询）" aria-label="恢复原操作的退款单 ID" maxlength="10" :disabled="sessionInvalid" />
        <el-button native-type="submit" :disabled="sessionInvalid || actionLoading">打开原操作</el-button>
      </form>
      <el-alert v-if="listError" :title="listError" type="error" :closable="false" />
      <el-button v-if="listError" @click="load">重试当前页</el-button>
      <el-table :data="list" v-loading="loading">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="orderId" label="退款单号" min-width="180" />
        <el-table-column label="类型" width="110"><template #default="{row}">{{ applyTypeText(row.applyType) }}</template></el-table-column>
        <el-table-column label="退款金额" width="110"><template #default="{row}">¥{{ row.refundPrice }}</template></el-table-column>
        <el-table-column label="状态" width="130"><template #default="{row}">{{ statusText(row) }}</template></el-table-column>
        <el-table-column label="申请时间" width="160"><template #default="{row}">{{ formatTime(row.addTime) }}</template></el-table-column>
        <el-table-column label="操作" fixed="right" width="90"><template #default="{row}"><el-button link type="primary" @click="openRefund(row)">详情</el-button></template></el-table-column>
      </el-table>
      <div class="pagination">
        <el-button :disabled="loading || !history.length || sessionInvalid" @click="previousPage">上一页</el-button>
        <span>第 {{ history.length + 1 }} 页</span>
        <el-button :disabled="loading || !nextCursor || sessionInvalid" @click="nextPage">下一页</el-button>
      </div>
    </el-card>
    <el-dialog v-model="detailOpen" title="退款详情" width="min(760px, 94vw)" :close-on-click-modal="false">
      <div v-loading="detailLoading" class="detail-body">
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false" />
        <el-alert v-if="!pendingReadable || uncertainIds.has(selectedId)" title="此单有待核对操作，已暂停新建请求。刷新或重开页面不会重新提交；查询回执不会执行退款。" type="warning" :closable="false" />
        <el-button :disabled="detailLoading || actionLoading || sessionInvalid" @click="readCurrent">刷新详情</el-button>
        <div v-if="pendingIntent?.phase === 'pending'" class="pending-intent">
          <p>原操作：{{ { return: '同意退货', refuse: '拒绝退款', refund: '执行退款' }[pendingIntent.action] }} · 退款单 {{ pendingIntent.review.orderId }} · ¥{{ pendingIntent.review.refundPrice }}</p>
          <p v-if="pendingIntent.reason">原拒绝原因：{{ pendingIntent.reason }}</p>
          <div class="actions">
            <el-button :disabled="!canReconcile" :loading="actionLoading" @click="reconcilePending">查询原操作回执</el-button>
            <el-button :disabled="!canReconcile" @click="recoverPending('execute')">重试原操作</el-button>
            <el-button :disabled="!canReconcile" @click="recoverPending('abandon')">放弃未受理的原操作</el-button>
          </div>
        </div>
        <p v-if="legacyPending">检测到旧版 v1/v2 记录，其请求未使用持久化回执协议。新回执查询或放弃屏障无法证明旧请求不会迟到；请人工核对并完成旧客户端停用，不会自动解除限制。</p>
        <el-alert v-if="reconcileMessage" :title="reconcileMessage" type="info" :closable="false" />
        <template v-if="current">
          <dl class="details">
            <dt>退款单号</dt><dd>{{ current.orderId }}</dd><dt>原订单号</dt><dd>{{ current.originalOrderId }}</dd>
            <dt>申请用户</dt><dd>UID {{ current.uid }}</dd><dt>退款金额</dt><dd>¥{{ current.refundPrice }}（已退 ¥{{ current.refundedPrice }}）</dd>
            <dt>类型 / 状态</dt><dd>{{ applyTypeText(current.applyType) }} / {{ statusText(current) }}</dd>
            <dt>渠道状态</dt><dd>{{ current.providerStatus || '暂无渠道回执' }}</dd>
            <dt>申请原因</dt><dd>{{ current.refundReason || '—' }}</dd><dt>申请说明</dt><dd>{{ current.refundExplain || '—' }}</dd>
            <dt>拒绝原因</dt><dd>{{ current.refuseReason || '—' }}</dd>
            <dt>商家收件信息</dt><dd>{{ current.returnContact.name || '未配置' }} / {{ current.returnContact.phone || '—' }}<br>{{ current.returnContact.address || '未配置退货地址' }}</dd>
          </dl>
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
          <h3>用户提交的退货信息</h3>
          <p>以下信息由用户提交，不代表商家已收货，也不代表资金退款完成。</p>
          <dl class="details">
            <dt>快递公司</dt><dd>{{ current.refundExpressName || '未提交' }}</dd><dt>运单号</dt><dd>{{ current.refundExpress || '未提交' }}</dd>
            <dt>联系电话</dt><dd>{{ current.refundPhone || '未填写' }}</dd><dt>退货备注</dt><dd>{{ current.refundGoodsExplain || '未填写' }}</dd>
          </dl>
          <el-alert v-if="current.returnImagesError" :title="current.returnImagesError" type="warning" :closable="false" />
          <div class="evidence">
            <div v-for="(image, i) in current.returnImages" :key="image.url">
              <p v-if="brokenImages.has(image.url)">凭证加载失败，请刷新详情后重试</p>
              <a v-else :href="image.src" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">
                <img :src="image.src" :alt="'退货凭证 ' + (i + 1)" referrerpolicy="no-referrer" @error="brokenImages.add(image.url)">
              </a>
            </div>
          </div>
          <p v-if="!current.returnImages.length && !current.returnImagesError">用户未提交退货凭证</p>
          <template v-if="canManage">
            <el-checkbox v-if="needsReceipt" v-model="received" :disabled="!canWrite">已实际验收退货，确认可以退款</el-checkbox>
            <div class="actions">
              <el-button v-if="[2,3].includes(current.applyType)" :disabled="!canReturn" @click="mutate('return')">同意退货</el-button>
              <el-button type="danger" :disabled="!canRefund" @click="mutate('refund')">执行退款 ¥{{ current.refundPrice }}</el-button>
              <el-button :disabled="!canWrite" @click="mutate('refuse')">拒绝退款</el-button>
            </div>
          </template>
          <p v-else>当前账号仅可查看售后信息。</p>
        </template>
      </div>
    </el-dialog>
  </section>
</template>
<style scoped>
.toolbar,.pagination,.actions,.evidence { display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin:12px 0; }
.toolbar .el-input { max-width:320px; }.toolbar .el-select { width:160px; }.pagination { justify-content:flex-end; }
.detail-body { min-height:100px; }.details { display:grid; grid-template-columns:110px minmax(0,1fr); gap:10px; }
dt { color:#666; } dd { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.evidence img { width:130px; height:130px; object-fit:contain; border:1px solid #ddd; border-radius:6px; }
.actions .el-button { margin-left:0; }.detail-body p { overflow-wrap:anywhere; }
.refund-history { margin:20px 0; border-top:1px solid #ddd; }.refund-history ul { padding-left:20px; }
.refund-history li { margin:12px 0; overflow-wrap:anywhere; }.refund-history li span { display:block; margin-top:4px; }
@media (max-width:600px) { .details { grid-template-columns:1fr; gap:6px; } dd { margin-bottom:8px; } .actions { align-items:stretch; flex-direction:column; } }
</style>
