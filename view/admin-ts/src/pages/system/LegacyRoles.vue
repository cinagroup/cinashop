<template>
  <el-config-provider :locale="zhCn">
    <div class="roles-page">
      <h2>下级角色</h2>
      <p class="hint">管理当前账号下一层级的平台角色。启停和删除分别需要对应权限，并须先核对完整影响账号再确认执行。</p>
      <el-alert v-if="canRecover && recoveryError" :title="recoveryError" type="error" :closable="false" show-icon />
      <el-alert v-if="canRecover && pending" title="上一笔角色操作结果待确认，暂不能提交新的操作" type="warning" :closable="false" show-icon>
        <template #default>
          <p>{{ operationLabel(pending.operation) }} · 操作编号 {{ pending.operation_id }}</p>
          <p>{{ recoveryMessage || '请查询原操作回执。刷新列表不会解除待确认状态。' }}</p>
          <div class="actions"><el-button :disabled="busy" @click="recoverOperation">查询回执</el-button>
            <el-button v-if="canRetry" :disabled="busy" @click="retryOperation">重试同一操作</el-button>
            <el-button type="warning" :disabled="busy" @click="resolveOperation">确认取消未执行操作</el-button></div>
        </template>
      </el-alert>
      <el-alert v-if="!canView" title="当前账号没有下级角色查看权限" type="warning" :closable="false" show-icon />
      <template v-if="canView">
        <el-alert v-if="!canStatus && !canDelete" title="当前账号仅可查看；启停和删除分别需要对应角色权限" type="info" :closable="false" show-icon />
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-form inline class="filters" @submit.prevent="loadList(1)">
          <el-form-item label="角色名称"><el-input v-model="query.role_name" maxlength="64" clearable @keyup.enter="loadList(1)" /></el-form-item>
          <el-form-item label="状态"><el-select v-model="query.status"><el-option label="全部" value="" /><el-option label="开启" :value="1" /><el-option label="关闭" :value="0" /></el-select></el-form-item>
          <el-form-item><el-button :loading="loading" @click="loadList(1)">查询</el-button><el-button :disabled="loading" @click="resetQuery">重置</el-button></el-form-item>
        </el-form>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon />
        <el-table v-loading="loading" :data="rows" row-key="id" empty-text="暂无下一层级角色">
          <el-table-column prop="id" label="编号" width="75" /><el-table-column prop="role_name" label="角色名称" min-width="150" />
          <el-table-column label="权限规则" min-width="240"><template #default="{ row }"><span class="rule-text">{{ row.rules || '未配置' }}</span></template></el-table-column>
          <el-table-column prop="level" label="层级" width="75" />
          <el-table-column label="状态" width="85"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '开启' : '关闭' }}</el-tag></template></el-table-column>
          <el-table-column v-if="canStatus || canDelete" label="操作" min-width="150" fixed="right"><template #default="{ row }">
            <el-button v-if="canStatus" link type="warning" :disabled="writeBlocked || !listReady" @click="prepareStatus(row)">{{ row.status === 1 ? '关闭' : '开启' }}</el-button>
            <el-button v-if="canDelete" link type="danger" :disabled="writeBlocked || !listReady" @click="prepareDelete(row)">删除</el-button>
          </template></el-table-column>
        </el-table>
        <p class="hint">列表规则为展示名称。操作请求仅发送角色编号和目标状态，不会回写这些名称。</p>
        <el-pagination class="pager" :current-page="query.page" :page-size="query.limit" :total="total" layout="total, prev, pager, next" :disabled="loading" @current-change="loadList" />
      </template>
      <el-dialog v-model="confirmation.show" title="确认角色变更" width="min(980px, 94vw)" :close-on-click-modal="false" @closed="cancelPreview">
        <template v-if="preview">
          <p>{{ operationLabel(preview.operation) }}：{{ preview.summary.target_name }} (#{{ preview.summary.target_id }})</p>
          <el-alert v-if="preview.summary.action === 'delete'" title="将永久删除此角色；引用账号的角色编号仍保留，但此角色不再授予权限" type="warning" :closable="false" show-icon />
          <div class="comparison"><section><h4>变更前</h4><dl><template v-for="item in displayRole(preview.summary.before)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></template></dl></section>
            <section><h4>变更后</h4><dl v-if="preview.summary.after"><template v-for="item in displayRole(preview.summary.after)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></template></dl><p v-else>角色不存在（物理删除）</p></section></div>
          <h4>完整引用账号（{{ preview.summary.impact.reference_count }} 个，当前启用 {{ preview.summary.impact.active_reference_count }} 个）</h4>
          <p class="hint">包括停用、已删除的历史引用；“权限变化”描述当前有效权限是否改变。</p>
          <div class="impact"><el-table :data="preview.summary.impact.references" row-key="id" empty-text="没有引用账号">
            <el-table-column prop="id" label="编号" width="75" /><el-table-column prop="account" label="账号" min-width="135" /><el-table-column prop="real_name" label="姓名" min-width="100" />
            <el-table-column label="角色编号" min-width="140"><template #default="{ row }">{{ row.roles.join(', ') }}</template></el-table-column>
            <el-table-column prop="level" label="层级" width="65" /><el-table-column label="账号状态" min-width="100"><template #default="{ row }">{{ row.is_del === 1 ? '已删除' : row.status === 1 ? '启用' : '停用' }}</template></el-table-column>
            <el-table-column label="权限变化" min-width="110"><template #default="{ row }"><el-tag :type="row.effective_permission_change ? 'warning' : 'info'">{{ row.effective_permission_change ? '有变化' : '无变化' }}</el-tag></template></el-table-column>
          </el-table></div>
          <p class="hint">操作编号 {{ preview.operation_id }}；预览有效至 {{ new Date(preview.expires_at * 1000).toLocaleTimeString() }}。</p>
          <el-checkbox v-model="confirmation.checked" class="confirm-check">我已核对角色、目标状态或永久删除，以及上方全部引用账号，并确认执行。</el-checkbox>
        </template>
        <template #footer><el-button :disabled="busy" @click="cancelPreview">取消</el-button><el-button type="primary" :loading="busy" :disabled="!confirmation.checked || writeBlocked || !preview || !canWrite(preview.operation)" @click="confirmOperation">确认执行</el-button></template>
      </el-dialog>
    </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiRoleList, apiRolePreview, apiRoleCommit, apiRoleReceipt, apiRoleResolve, roleId,
  type LegacyRoleRow, type LegacyRoleQuery, type LegacyRoleKind, type LegacyRoleEnvelope, type LegacyRoleCommit,
  type LegacyRolePreview, type LegacyRolePending, type LegacyRoleReceipt } from '@/api/legacyRole';
import { RolePendingStore, RoleRequestScope, rolePendingKey, type RoleStamp } from '@/utils/legacyRoleOperation';

const auth = useAuthStore(), sessionVersion = ref(0);
let alive = false, syncing = false, stored = localStorage.getItem('admin_session');
const identity = computed(() => `${auth.token}:${JSON.stringify(auth.userInfo)}:${auth.uniqueAuth.join(',')}`);
function owner() {
  void sessionVersion.value;
  const session = getAdminSession(), id = auth.userInfo?.id;
  return alive && roleId(id) && !!auth.token && auth.token === getToken() && stored === localStorage.getItem('admin_session')
    && session?.userInfo.id === id && session.userInfo.level === auth.userInfo?.level ? id : 0;
}
function permission(keys: string[]) {
  if (!owner()) return false;
  if (auth.userInfo?.level === 0) return true;
  const session = getAdminSession();
  return keys.some(key => auth.uniqueAuth.includes(key) && session?.uniqueAuth.includes(key));
}
const canRecover = computed(() => owner() > 0);
const canView = computed(() => permission(['system.legacy_role_view', 'system.view', 'system.manage', 'system.legacy_role_status', 'system.legacy_role_delete']));
const canStatus = computed(() => permission(['system.legacy_role_status', 'system.manage']));
const canDelete = computed(() => permission(['system.legacy_role_delete', 'system.manage']));
function canWrite(operation: LegacyRoleKind) { return operation === 'legacy-role-status' ? canStatus.value : canDelete.value; }
const scope = new RoleRequestScope(() => identity.value, () => localStorage.getItem('admin_session'), owner);
const store = new RolePendingStore(localStorage);
const rows = ref<LegacyRoleRow[]>([]), total = ref(0), listReady = ref(false), loading = ref(false), listError = ref('');
const query = reactive<LegacyRoleQuery>({ role_name: '', status: '', page: 1, limit: 20 });
const busy = ref(false), error = ref(''), recoveryError = ref(''), recoveryMessage = ref('');
const pending = ref<LegacyRolePending | null>(null), preview = ref<LegacyRolePreview | null>(null);
const confirmation = reactive({ show: false, checked: false });
type Snapshot = { envelope: LegacyRoleEnvelope; fingerprint: string; previewFingerprint: string; stamp: RoleStamp; targetFingerprint: string };
let snapshot: Snapshot | null = null, previewSequence = 0;
const retry = ref<{ envelope: LegacyRoleCommit; fingerprint: string; stamp: RoleStamp } | null>(null);
const writeBlocked = computed(() => busy.value || !!pending.value || !!recoveryError.value);
const canRetry = computed(() => !!pending.value && !!retry.value && canWrite(pending.value.operation) && scope.current(retry.value.stamp)
  && retry.value.envelope.operation_id === pending.value.operation_id && JSON.stringify(retry.value.envelope) === retry.value.fingerprint);
const message = (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback;
const operationLabel = (kind: LegacyRoleKind) => kind === 'legacy-role-status' ? '更改角色状态' : '永久删除角色';
function displayRole(value: LegacyRoleRow) {
  return [{ label: '编号', value: String(value.id) }, { label: '角色名称', value: value.role_name }, { label: '规则原值', value: value.rules || '未配置' },
    { label: '类型', value: String(value.type) }, { label: '关系编号', value: String(value.relation_id) }, { label: '层级', value: String(value.level) }, { label: '状态', value: value.status === 1 ? '开启' : '关闭' }];
}
function cancelPreview() { previewSequence++; snapshot = null; preview.value = null; confirmation.show = false; confirmation.checked = false; }
function restorePending() {
  pending.value = null; retry.value = null; recoveryError.value = recoveryMessage.value = '';
  const actor = owner(); if (!actor) return;
  try { pending.value = store.read(actor); } catch (reason) { recoveryError.value = message(reason, '无法读取角色待确认记录，请保留记录并核对'); }
}
function clearView() {
  scope.invalidate(); cancelPreview(); rows.value = []; total.value = 0; listReady.value = false;
  loading.value = busy.value = false; listError.value = error.value = ''; pending.value = null; retry.value = null;
  recoveryError.value = recoveryMessage.value = ''; Object.assign(query, { role_name: '', status: '', page: 1, limit: 20 });
}
async function loadList(page = query.page) {
  if (!canView.value) return;
  cancelPreview(); const job = scope.begin('list'), q = { ...query, page }; loading.value = true; listReady.value = false; listError.value = '';
  try { const result = await apiRoleList(q, job.controller.signal); if (!scope.valid('list', job) || !canView.value) return;
    if (result.list.some(row => row.level !== Number(auth.userInfo?.level) + 1)) throw Error('角色层级已变化，请重新登录后查询');
    rows.value = result.list; total.value = result.count; query.page = page; listReady.value = true;
  } catch (reason) { if (scope.valid('list', job)) { rows.value = []; total.value = 0; listError.value = message(reason, '角色列表读取失败'); } }
  finally { if (scope.finish('list', job)) loading.value = false; }
}
function resetQuery() { query.role_name = ''; query.status = ''; void loadList(1); }
function targetFingerprint(id: number) { return JSON.stringify(rows.value.find(row => row.id === id) ?? null); }
function unchanged(saved: Snapshot) {
  return scope.current(saved.stamp) && canWrite(saved.envelope.operation) && listReady.value
    && JSON.stringify(saved.envelope.payload) === saved.fingerprint && targetFingerprint(Number(saved.envelope.payload.id)) === saved.targetFingerprint;
}
async function prepareOperation(operation: LegacyRoleKind, payload: Record<string, unknown>) {
  if (!canWrite(operation) || writeBlocked.value || !listReady.value) return;
  restorePending(); if (writeBlocked.value) return;
  cancelPreview(); const sequence = previewSequence, job = scope.begin('preview'); busy.value = true; error.value = '';
  const envelope: LegacyRoleEnvelope = { operation_id: crypto.randomUUID(), operation, payload }, candidate: Snapshot = { envelope,
    fingerprint: JSON.stringify(payload), previewFingerprint: '', stamp: job.stamp, targetFingerprint: targetFingerprint(Number(payload.id)) };
  try { const result = await apiRolePreview(envelope, job.stamp.actor, job.controller.signal);
    if (!scope.valid('preview', job) || sequence !== previewSequence || !unchanged(candidate)) return;
    if (result.summary.before.level !== Number(auth.userInfo?.level) + 1) throw Error('角色层级已变化，请重新登录后预览');
    candidate.previewFingerprint = JSON.stringify(result); snapshot = candidate; preview.value = result; confirmation.checked = false; confirmation.show = true;
  } catch (reason) { if (scope.valid('preview', job)) error.value = message(reason, '角色影响预览失败，尚未提交'); }
  finally { if (scope.finish('preview', job)) busy.value = false; }
}
async function prepareStatus(row: LegacyRoleRow) {
  if (!canStatus.value || !listReady.value || !rows.value.includes(row) || writeBlocked.value) return;
  await prepareOperation('legacy-role-status', { id: row.id, status: row.status === 1 ? 0 : 1 });
}
async function prepareDelete(row: LegacyRoleRow) {
  if (!canDelete.value || !listReady.value || !rows.value.includes(row) || writeBlocked.value) return;
  await prepareOperation('legacy-role-delete', { id: row.id });
}
async function finishReceipt(receipt: LegacyRoleReceipt, expected: LegacyRolePending, stamp: RoleStamp) {
  if (!scope.current(stamp) || pending.value?.operation_id !== expected.operation_id) return;
  if (receipt.state === 'unknown') { recoveryMessage.value = '尚未查到原耐久回执，结果仍未知。请继续查询或确认取消未执行操作。'; return; }
  const cleared = await store.finish(receipt, expected, () => scope.current(stamp) && pending.value?.operation_id === expected.operation_id);
  if (!cleared || !scope.current(stamp)) return;
  pending.value = null; retry.value = null; recoveryError.value = recoveryMessage.value = ''; cancelPreview();
  ElMessage.success(receipt.state === 'not_applied' ? '原操作已永久封存为未执行，可以重新预览' : expected.action === 'delete' ? '角色已永久删除' : '角色状态已更新');
  if (canView.value) await loadList();
}
async function sendCommit(envelope: LegacyRoleCommit, expected: LegacyRolePending, stamp: RoleStamp) {
  if (!scope.current(stamp) || !canWrite(envelope.operation)) return;
  const job = scope.begin('write'); busy.value = true;
  try { const receipt = await apiRoleCommit(envelope, expected, job.controller.signal); if (scope.valid('write', job)) await finishReceipt(receipt, expected, stamp); }
  catch (reason) { if (scope.valid('write', job)) recoveryMessage.value = message(reason, '提交结果未知，请查询原角色操作回执'); }
  finally { if (scope.finish('write', job)) busy.value = false; }
}
async function confirmOperation() {
  const p = preview.value, saved = snapshot;
  if (!p || !saved || !confirmation.checked || writeBlocked.value || !canWrite(p.operation)) return;
  try { if (!unchanged(saved) || JSON.stringify(p) !== saved.previewFingerprint || p.expires_at <= Math.floor(Date.now() / 1000)) throw Error('角色、身份或预览已变化，请重新预览'); }
  catch (reason) { cancelPreview(); error.value = message(reason, '请重新预览'); return; }
  const expected: LegacyRolePending = { version: 1, operation_id: p.operation_id, actor_id: p.actor_id, operation: p.operation, request_hash: p.request_hash,
    target_id: p.summary.target_id, action: p.summary.action };
  const envelope: LegacyRoleCommit = { ...saved.envelope, revision: p.revision, expires_at: p.expires_at, confirmed: true };
  busy.value = true;
  try { await store.reserve(expected, () => scope.current(saved.stamp) && canWrite(p.operation) && snapshot === saved && confirmation.checked && unchanged(saved)); }
  catch (reason) { if (scope.current(saved.stamp)) { restorePending(); recoveryError.value = message(reason, '恢复记录未能保存，未提交'); busy.value = false; } return; }
  if (!scope.current(saved.stamp)) return;
  pending.value = expected; retry.value = { envelope, fingerprint: JSON.stringify(envelope), stamp: saved.stamp }; cancelPreview();
  await sendCommit(envelope, expected, saved.stamp);
}
async function recoverOperation() {
  const expected = pending.value; if (!expected || busy.value || !owner()) return;
  const job = scope.begin('recovery'); busy.value = true;
  try { const receipt = await apiRoleReceipt(expected, job.controller.signal); if (scope.valid('recovery', job)) await finishReceipt(receipt, expected, job.stamp); }
  catch (reason) { if (scope.valid('recovery', job)) recoveryMessage.value = message(reason, '回执查询失败，结果仍未知'); }
  finally { if (scope.finish('recovery', job)) busy.value = false; }
}
async function resolveOperation() {
  const expected = pending.value; if (!expected || busy.value || !owner()) return;
  const job = scope.begin('recovery'); busy.value = true;
  try { try { await ElMessageBox.confirm('确认取消这笔尚未执行的角色操作？服务端会永久封存原操作编号；若已执行，将返回原回执。', '确认操作结果', { type: 'warning' }); } catch { return; }
    if (!scope.valid('recovery', job) || pending.value?.operation_id !== expected.operation_id) return;
    const receipt = await apiRoleResolve(expected, job.controller.signal); if (scope.valid('recovery', job)) await finishReceipt(receipt, expected, job.stamp);
  } catch (reason) { if (scope.valid('recovery', job)) recoveryMessage.value = message(reason, '未能封存原角色操作，结果仍未知'); }
  finally { if (scope.finish('recovery', job)) busy.value = false; }
}
async function retryOperation() {
  const expected = pending.value, saved = retry.value; if (!expected || !saved || !canRetry.value || busy.value) return;
  const job = scope.begin('retry-confirm'); busy.value = true;
  try { try { await ElMessageBox.confirm('只重试已经确认的原操作编号和原始请求，不会生成新的角色操作。', '重试同一操作', { type: 'warning' }); } catch { return; }
    if (!scope.valid('retry-confirm', job) || !canRetry.value || retry.value !== saved || pending.value?.operation_id !== expected.operation_id) return;
    await sendCommit(saved.envelope, expected, saved.stamp);
  } finally { if (scope.finish('retry-confirm', job)) busy.value = false; }
}
function syncSession() {
  syncing = true; clearView(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem('admin_session'); sessionVersion.value++; syncing = false; restorePending(); if (canView.value) void loadList();
}
function syncStorage(event: StorageEvent) {
  if (event.storageArea !== localStorage) return;
  if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession();
  else if (event.key === rolePendingKey(owner())) { cancelPreview(); restorePending(); }
}
watch(identity, () => { if (!alive || syncing) return; clearView(); sessionVersion.value++; restorePending(); if (canView.value) void loadList(); }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; clearView(); scope.dispose(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.roles-page { min-width: 0; }.roles-page :deep(.el-alert) { margin-bottom: 14px; }.hint { color: var(--el-text-color-secondary); font-size: 13px; }.filters .el-input { width: 210px; }.filters .el-select { width: 120px; }.pager { margin-top: 16px; max-width: 100%; overflow-x: auto; }.actions { display: flex; flex-wrap: wrap; gap: 8px; }.rule-text { overflow-wrap: anywhere; white-space: pre-wrap; }.comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }.comparison section { padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; min-width: 0; }.comparison h4 { margin: 0 0 12px; }.comparison dl { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; }.comparison dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }.impact { max-height: 380px; overflow: auto; }.confirm-check { margin-top: 16px; height: auto; white-space: normal; }.confirm-check :deep(.el-checkbox__label) { white-space: normal; }
@media (max-width: 600px) { .comparison { grid-template-columns: 1fr; }.filters :deep(.el-form-item) { display: flex; margin-right: 0; }.filters :deep(.el-form-item__content) { min-width: 0; flex-wrap: wrap; gap: 8px; } }
</style>
