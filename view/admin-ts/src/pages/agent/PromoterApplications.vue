<template>
  <div class="promoter-applications">
    <div class="heading">
      <div><h2>分销员申请审核</h2><p class="hint">审核申请中的记录；删除申请不会取消用户已获得的分销资格。申请与审核时间均为 UTC。</p></div>
      <el-button v-if="canView" :disabled="submitting || confirming" :loading="loading" @click="load()">刷新</el-button>
    </div>
    <el-alert v-if="!canView" title="当前账号没有分销管理查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-card shadow="never">
        <div class="filters">
          <label class="filter-field">
            <span>搜索</span>
            <el-input v-model="draftKeyword" aria-label="分销员申请搜索" maxlength="100" clearable placeholder="姓名 / UID / 昵称 / 电话" :disabled="submitting" @keyup.enter="search" />
          </label>
          <label class="filter-field status-field">
            <span>申请状态</span>
            <el-select v-model="draftStatus" aria-label="分销员申请状态" :disabled="submitting">
              <el-option label="全部状态" value="all" />
              <el-option label="申请中" :value="0" /><el-option label="已通过" :value="1" /><el-option label="已拒绝" :value="2" />
            </el-select>
          </label>
          <div class="filter-actions">
            <el-button type="primary" :disabled="submitting" @click="search">查询</el-button>
            <el-button :disabled="submitting" @click="reset">重置</el-button>
          </div>
        </div>
        <el-alert v-if="actionNotice" :title="actionNotice" type="warning" :closable="false" show-icon class="notice" />
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice">
          <template #default><el-button link type="primary" @click="load()">重新读取申请状态</el-button></template>
        </el-alert>
        <div v-else class="table-scroll">
          <p v-if="compactTable" class="hint">左右滑动表格可查看姓名、状态和操作。</p>
          <el-table :data="list" v-loading="loading" border row-key="id" :empty-text="loading ? '加载中…' : '暂无申请记录'">
            <el-table-column prop="id" label="ID" width="75" />
            <el-table-column prop="uid" label="UID" min-width="95" />
            <el-table-column prop="nickname" label="用户昵称" min-width="130" />
            <el-table-column prop="real_name" label="姓名" min-width="110" />
            <el-table-column prop="phone" label="电话" min-width="145" />
            <el-table-column label="申请状态" min-width="105">
              <template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : row.status === 2 ? 'danger' : 'warning'">{{ statusLabel(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column label="申请时间" min-width="175"><template #default="{ row }">{{ row.add_time || '—' }}</template></el-table-column>
            <el-table-column label="审核时间" min-width="175"><template #default="{ row }">{{ row.status_time || '—' }}</template></el-table-column>
            <el-table-column label="拒绝原因" min-width="190"><template #default="{ row }"><span class="reason">{{ row.refusal_reason || '—' }}</span></template></el-table-column>
            <el-table-column v-if="canManage" label="操作" width="190" :fixed="compactTable ? false : 'right'">
              <template #default="{ row }">
                <el-button v-if="row.status === 0" link type="success" :disabled="submitting || confirming" @click="approve(row)">通过</el-button>
                <el-button v-if="row.status === 0" link type="warning" :disabled="submitting || confirming" @click="openReject(row)">拒绝</el-button>
                <el-button link type="danger" :disabled="submitting || confirming" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
        <el-pagination v-if="!loading && !listError" :current-page="page" :page-size="PAGE_SIZE" :total="count"
          :page-count="Math.min(Math.max(1, Math.ceil(count / PAGE_SIZE)), MAX_PAGE)" :pager-count="5" :disabled="submitting || confirming"
          layout="total, prev, pager, next" class="pager" @current-change="load" />
        <p v-if="count > MAX_PAGE * PAGE_SIZE" class="hint">可浏览前 {{ MAX_PAGE * PAGE_SIZE }} 项，请使用搜索和状态筛选缩小范围。</p>
      </el-card>
    </template>
    <el-dialog v-model="rejectVisible" title="拒绝分销员申请" width="min(520px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="!submitting" :show-close="!submitting">
      <p v-if="rejectRow">确认拒绝「{{ rejectRow.real_name || rejectRow.nickname }}」（UID {{ rejectRow.uid }}）的申请？</p>
      <el-form label-position="top">
        <el-form-item label="拒绝原因" required :error="rejectError">
          <el-input v-model="rejectReason" aria-label="拒绝原因" type="textarea" :rows="4" maxlength="1000" show-word-limit :disabled="submitting" placeholder="请填写明确的拒绝原因" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="submitting" @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" :disabled="!canManage" @click="confirmReject">确认拒绝</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiPromoterApplicationList, apiPromoterApplicationReview, apiPromoterApplicationDelete,
  type PromoterApplication, type PromoterApplicationStatus } from '@/api/promoterApplication';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('distribution.view')));
const canManage = computed(() => canView.value && !!auth.userInfo &&
  (auth.userInfo.level === 0 || auth.uniqueAuth.includes('distribution.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const PAGE_SIZE = 15;
const MAX_PAGE = Math.floor(10_000 / PAGE_SIZE) + 1;
const compactTable = ref(window.innerWidth <= 768);
const updateTableWidth = () => { compactTable.value = window.innerWidth <= 768; };
const draftKeyword = ref('');
const draftStatus = ref<'all' | PromoterApplicationStatus>('all');
const keyword = ref('');
const status = ref<'all' | PromoterApplicationStatus>('all');
const list = ref<PromoterApplication[]>([]);
const count = ref(0), page = ref(1), loading = ref(false);
const listError = ref(''), actionNotice = ref('');
const submitting = ref(false), confirming = ref(false);
const rejectVisible = ref(false), rejectRow = ref<PromoterApplication | null>(null);
const rejectReason = ref(''), rejectError = ref('');
let mounted = false, syncing = false, generation = 0, confirmationId = 0, mutationId = 0;
let storedSession = localStorage.getItem('admin_session');
let listAbort: AbortController | null = null, mutationAbort: AbortController | null = null;
interface OperationScope { session: string; generation: number; storedSession: string | null }
let rejectScope: OperationScope | null = null;

function scope(): OperationScope { return { session: sessionKey.value, generation, storedSession }; }
function current(value: OperationScope) {
  return mounted && canView.value && value.generation === generation && value.session === sessionKey.value &&
    auth.token === getToken() && value.storedSession === localStorage.getItem('admin_session');
}
function statusLabel(value: PromoterApplicationStatus) { return ['申请中', '已通过', '已拒绝'][value]; }
function currentRow(row: PromoterApplication) { return list.value.some(item => item.id === row.id && item.uid === row.uid && item.status === row.status && item.revision === row.revision); }
function actionable(row: PromoterApplication, pendingOnly = false) {
  return current(scope()) && canManage.value && !loading.value && !submitting.value && !confirming.value &&
    currentRow(row) && (!pendingOnly || row.status === 0);
}
function clearList() {
  generation++; listAbort?.abort(); listAbort = null;
  list.value = []; count.value = 0; listError.value = ''; loading.value = false;
}
function invalidate() {
  clearList(); mutationId++; mutationAbort?.abort(); mutationAbort = null;
  confirmationId++;
  if (confirming.value) ElMessageBox.close();
  confirming.value = false; submitting.value = false;
  rejectVisible.value = false; rejectRow.value = null; rejectScope = null;
  rejectReason.value = ''; rejectError.value = ''; actionNotice.value = '';
}

async function load(targetPage = page.value) {
  if (!mounted || !canView.value || auth.token !== getToken() || storedSession !== localStorage.getItem('admin_session')) return;
  if (!Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > MAX_PAGE) return;
  clearList(); page.value = targetPage;
  const stamp = scope(), controller = new AbortController();
  listAbort = controller; loading.value = true;
  try {
    const result = await apiPromoterApplicationList({ page: targetPage, limit: PAGE_SIZE, keyword: keyword.value, status: status.value }, controller.signal);
    if (!current(stamp)) return;
    if (!result.list.length && targetPage > 1) {
      await load(Math.max(1, Math.min(targetPage - 1, Math.ceil(result.count / PAGE_SIZE))));
      return;
    }
    list.value = result.list; count.value = result.count;
  } catch (error) {
    if (current(stamp)) listError.value = error instanceof Error ? error.message : '分销员申请加载失败';
  } finally {
    if (listAbort === controller) { listAbort = null; loading.value = false; }
  }
}
function search() {
  if (submitting.value) return;
  keyword.value = draftKeyword.value.trim(); status.value = draftStatus.value;
  actionNotice.value = ''; void load(1);
}
function reset() {
  if (submitting.value) return;
  draftKeyword.value = ''; draftStatus.value = 'all'; search();
}

async function mutate(row: PromoterApplication, action: 'approve' | 'reject' | 'delete', stamp: OperationScope, reason = '') {
  if (!current(stamp) || !canManage.value || !currentRow(row) || submitting.value || (action !== 'delete' && row.status !== 0)) return;
  const requestId = ++mutationId, controller = new AbortController();
  mutationAbort = controller; submitting.value = true; actionNotice.value = '';
  try {
    if (action === 'delete') await apiPromoterApplicationDelete(row.id, row.revision, controller.signal);
    else await apiPromoterApplicationReview(row.id, row.uid, action === 'approve' ? 1 : 2, row.revision, reason, controller.signal);
    if (!current(stamp) || requestId !== mutationId || !canManage.value) return;
    rejectVisible.value = false;
    ElMessage.success(action === 'delete' ? '申请已删除；已获得的分销资格不受影响' : action === 'approve' ? '申请已通过' : '申请已拒绝');
  } catch (error) {
    if (!current(stamp) || requestId !== mutationId || !canManage.value) return;
    rejectVisible.value = false;
    const detail = error instanceof Error ? error.message : '请求失败';
    actionNotice.value = `${error instanceof AdminResponseError ? '操作未完成' : '操作结果未确认'}：${detail}。请核对重新读取的申请状态后再操作。`;
  } finally {
    if (requestId === mutationId) { submitting.value = false; mutationAbort = null; }
  }
  // Reads are safe after either a success or an ambiguous result. Never replay a write automatically.
  if (current(stamp)) await load();
}

async function confirmAction(row: PromoterApplication, action: 'approve' | 'delete') {
  if (!actionable(row, action === 'approve')) return;
  row = { ...row };
  const stamp = scope(), requestId = ++confirmationId;
  confirming.value = true;
  try {
    await ElMessageBox.confirm(action === 'approve'
      ? `确认通过「${row.real_name || row.nickname}」（UID ${row.uid}）的申请？通过后该用户将获得分销员资格。`
      : `确认删除「${row.real_name || row.nickname}」（UID ${row.uid}）的申请记录？仅删除这条记录，不会取消已获得的分销资格。`,
      action === 'approve' ? '通过分销员申请' : '删除分销员申请',
      { type: 'warning', confirmButtonText: action === 'approve' ? '确认通过' : '确认删除', cancelButtonText: '取消' });
  } catch { return; }
  finally { if (requestId === confirmationId) confirming.value = false; }
  if (requestId === confirmationId && current(stamp)) await mutate(row, action, stamp);
}
function approve(row: PromoterApplication) { return confirmAction(row, 'approve'); }
function remove(row: PromoterApplication) { return confirmAction(row, 'delete'); }
function openReject(row: PromoterApplication) {
  if (!actionable(row, true)) return;
  rejectRow.value = { ...row }; rejectScope = scope();
  rejectReason.value = ''; rejectError.value = ''; rejectVisible.value = true;
}
async function confirmReject() {
  if (!rejectVisible.value || !rejectRow.value || !rejectScope || !current(rejectScope) || !canManage.value || submitting.value) return;
  const reason = rejectReason.value.trim();
  if (!reason || Array.from(reason).length > 1000) { rejectError.value = '请填写 1–1000 字的拒绝原因'; return; }
  rejectError.value = '';
  await mutate(rejectRow.value, 'reject', rejectScope, reason);
}

function syncSession() {
  syncing = true; invalidate();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null,
    menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  storedSession = localStorage.getItem('admin_session'); syncing = false;
  page.value = 1; draftKeyword.value = ''; keyword.value = ''; draftStatus.value = 'all'; status.value = 'all';
  void load(1);
}
function syncStorage(event: StorageEvent) {
  if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession();
}
watch(sessionKey, () => {
  if (mounted && !syncing) { invalidate(); page.value = 1; void load(1); }
}, { flush: 'sync' });
onMounted(() => {
  mounted = true;
  window.addEventListener('resize', updateTableWidth);
  window.addEventListener('admin-session-changed', syncSession);
  window.addEventListener('admin-auth-expired', syncSession);
  window.addEventListener('storage', syncStorage);
  syncSession();
});
onBeforeUnmount(() => {
  mounted = false; invalidate();
  window.removeEventListener('resize', updateTableWidth);
  window.removeEventListener('admin-session-changed', syncSession);
  window.removeEventListener('admin-auth-expired', syncSession);
  window.removeEventListener('storage', syncStorage);
});
</script>

<style scoped>
.promoter-applications { min-width: 0; }
.heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.heading h2 { font-size: 18px; margin: 0 0 8px; }
.hint { color: #737985; font-size: 12px; margin: 5px 0; line-height: 1.6; }
.filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 18px; }
.filter-field { display: flex; flex: 1 1 260px; min-width: 0; flex-direction: column; gap: 6px; font-size: 13px; }
.status-field { flex: 0 1 180px; }
.filter-field :deep(.el-input), .filter-field :deep(.el-select) { width: 100%; }
.filter-actions { display: flex; gap: 8px; }
.filter-actions :deep(.el-button + .el-button) { margin-left: 0; }
.notice { margin-bottom: 14px; }
.table-scroll { width: 100%; max-width: 100%; overflow-x: auto; }
.reason { overflow-wrap: anywhere; white-space: pre-wrap; }
.pager { margin-top: 18px; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 600px) {
  .filters { display: grid; grid-template-columns: minmax(0, 1fr); }
  .pager { justify-content: center; }
  .pager :deep(.el-pagination__total) { width: 100%; text-align: center; margin-right: 0; }
}
</style>
