<template>
  <el-config-provider :locale="zhCn">
    <div class="staff-page">
      <h2>下级管理员</h2>
      <p class="hint">管理当前账号下一层级的平台管理员。每次保存、启停和删除都需要先预览，再明确确认。</p>
      <el-alert v-if="canRecover && recoveryError" :title="recoveryError" type="error" :closable="false" show-icon />
      <el-alert v-if="canRecover && pending" title="上一笔操作结果待确认，暂不能提交新的操作" type="warning" :closable="false" show-icon>
        <template #default>
          <p>{{ operationLabel(pending.operation) }} · 操作编号 {{ pending.operation_id }}</p>
          <p>{{ recoveryMessage || '请查询原操作回执。刷新列表不会解除待确认状态。' }}</p>
          <div class="actions"><el-button :disabled="busy" @click="recoverOperation">查询回执</el-button>
            <el-button v-if="canRetry" :disabled="busy" @click="retryOperation">重试同一操作</el-button>
            <el-button type="warning" :disabled="busy" @click="resolveOperation">确认取消未执行操作</el-button></div>
        </template>
      </el-alert>
      <el-alert v-if="!canView" title="当前账号没有下级管理员查看权限" type="warning" :closable="false" show-icon />
      <template v-if="canView">
        <el-alert v-if="!canManage" title="当前账号仅可查看；保存、启停和删除需要下级管理员管理权限" type="info" :closable="false" show-icon />
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <div class="head"><h3>下一层级账号</h3><el-button v-if="canManage && canForm" type="primary" :disabled="writeBlocked || !listReady" @click="openForm()">新增管理员</el-button></div>
        <el-form inline class="filters" @submit.prevent="loadList(1)">
          <el-form-item label="账号/姓名"><el-input v-model="query.name" maxlength="64" clearable @keyup.enter="loadList(1)" /></el-form-item>
          <el-form-item label="状态"><el-select v-model="query.status"><el-option label="全部" value="" /><el-option label="开启" :value="1" /><el-option label="关闭" :value="0" /></el-select></el-form-item>
          <el-form-item><el-button :loading="loading" @click="loadList(1)">查询</el-button><el-button :disabled="loading" @click="resetQuery">重置</el-button></el-form-item>
        </el-form>
        <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon />
        <el-table v-loading="loading" :data="rows" row-key="id" empty-text="暂无下一层级管理员">
          <el-table-column prop="id" label="编号" width="75" /><el-table-column prop="account" label="账号" min-width="160" />
          <el-table-column prop="real_name" label="姓名" min-width="100" /><el-table-column prop="phone" label="手机号" min-width="135" />
          <el-table-column prop="roles" label="角色名称" min-width="150" /><el-table-column prop="level" label="层级" width="75" />
          <el-table-column label="状态" width="85"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '开启' : '关闭' }}</el-tag></template></el-table-column>
          <el-table-column prop="_last_time" label="最后登录" min-width="170" />
          <el-table-column v-if="canForm || canManage" label="操作" min-width="225" fixed="right"><template #default="{ row }">
            <el-button v-if="canForm" link type="primary" :disabled="writeBlocked || !listReady" @click="openForm(row)">{{ canManage ? '编辑' : '查看' }}</el-button>
            <el-button v-if="canManage" link type="warning" :disabled="writeBlocked || !listReady" @click="prepareStatus(row)">{{ row.status === 1 ? '关闭' : '开启' }}</el-button>
            <el-button v-if="canManage" link type="danger" :disabled="writeBlocked || !listReady" @click="prepareDelete(row)">删除</el-button>
          </template></el-table-column>
        </el-table>
        <el-pagination class="pager" :current-page="query.page" :page-size="query.limit" :total="total" layout="total, prev, pager, next" :disabled="loading" @current-change="loadList" />
      </template>
      <el-dialog v-model="editor.show" :title="form?.title || '管理员表单'" width="min(620px, 94vw)" :close-on-click-modal="false" @closed="closeEditor">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon />
        <el-form v-if="form" v-loading="formLoading" :disabled="!canManage || writeBlocked" label-width="100px" @submit.prevent="prepareSave">
          <el-form-item label="管理员账号"><el-input v-model="editor.fields.account" maxlength="32" autocomplete="off" /><span class="hint">4–32位字母、数字、下划线或连字符；编辑时可改名。</span></el-form-item>
          <el-form-item label="密码"><el-input v-model="editor.fields.pwd" type="password" show-password autocomplete="new-password" /><span class="hint">至少12字符，最多72个UTF-8字节。{{ editor.id ? '密码和确认密码均为空时保留原密码。' : '新增时必须设置密码。' }}</span></el-form-item>
          <el-form-item label="确认密码"><el-input v-model="editor.fields.conf_pwd" type="password" show-password autocomplete="new-password" /></el-form-item>
          <el-form-item label="管理员姓名"><el-input v-model="editor.fields.real_name" maxlength="32" placeholder="最多16个字符" /></el-form-item>
          <el-form-item label="手机号"><el-input v-model="editor.fields.phone" maxlength="11" inputmode="tel" /></el-form-item>
          <el-form-item label="角色"><el-select v-model="editor.fields.roles" multiple class="role-select" placeholder="请选择可委派的角色"><el-option v-for="role in form.roleOptions" :key="role.value" :label="`${role.label} (#${role.value})`" :value="role.value" :disabled="role.disabled === true" /></el-select><template v-if="hasInactiveRoles"><span class="hint">原账号含停用或已删除角色，请先移除；停用或已删除角色不能重新选择或保存。</span><el-button :disabled="!canManage || writeBlocked" @click="removeInactiveRoles">移除停用或已删除角色</el-button></template></el-form-item>
          <el-form-item label="状态"><el-radio-group v-model="editor.fields.status"><el-radio :value="1">开启</el-radio><el-radio :value="0">关闭</el-radio></el-radio-group></el-form-item>
        </el-form>
        <template #footer><el-button :disabled="busy" @click="closeEditor">关闭</el-button><el-button v-if="canManage && form" type="primary" :disabled="writeBlocked || formLoading" @click="prepareSave">预览影响</el-button></template>
      </el-dialog>
      <el-dialog v-model="confirmation.show" title="确认管理员变更" width="min(780px, 94vw)" :close-on-click-modal="false" @closed="cancelPreview">
        <template v-if="preview">
          <p>{{ actionLabel(preview.summary.action) }}：{{ preview.summary.target_name }} <span v-if="preview.summary.target_id">(#{{ preview.summary.target_id }})</span></p>
          <div class="comparison"><section><h4>变更前</h4><dl v-if="preview.summary.before"><template v-for="item in displayValues(preview.summary.before)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></template></dl><p v-else>新账号</p></section>
            <section><h4>变更后</h4><dl><template v-for="item in displayValues(preview.summary.after)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></template><dt>密码</dt><dd>{{ preview.summary.after.password_changed ? '设置新密码（不显示密码内容）' : '保留原密码' }}</dd></dl></section></div>
          <p class="hint">操作编号 {{ preview.operation_id }}；预览有效至 {{ new Date(preview.expires_at * 1000).toLocaleTimeString() }}。</p>
          <el-checkbox v-model="confirmation.checked" class="confirm-check">我已核对账号、手机号、角色、状态和密码变更，并确认执行以上操作。</el-checkbox>
        </template>
        <template #footer><el-button :disabled="busy" @click="cancelPreview">取消</el-button><el-button type="primary" :loading="busy" :disabled="!confirmation.checked || writeBlocked || !canManage" @click="confirmOperation">确认执行</el-button></template>
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
import { apiStaffList, apiStaffForm, apiStaffPreview, apiStaffCommit, apiStaffReceipt, apiStaffResolve, validateStaffFields, staffId,
  type LegacyStaffRow, type LegacyStaffFields, type LegacyStaffForm, type LegacyStaffQuery, type LegacyStaffKind, type LegacyStaffAction,
  type LegacyStaffEnvelope, type LegacyStaffCommit, type LegacyStaffPreview, type LegacyStaffPending, type LegacyStaffReceipt, type LegacyStaffValues } from '@/api/legacyAdmin';
import { StaffPendingStore, StaffRequestScope, staffPendingKey, type StaffStamp } from '@/utils/legacyStaffOperation';

const auth = useAuthStore(), sessionVersion = ref(0);
let alive = false, syncing = false, stored = localStorage.getItem('admin_session');
const identity = computed(() => `${auth.token}:${JSON.stringify(auth.userInfo)}:${auth.uniqueAuth.join(',')}`);
function owner() {
  void sessionVersion.value;
  const session = getAdminSession(), id = auth.userInfo?.id;
  return alive && staffId(id) && !!auth.token && auth.token === getToken() && stored === localStorage.getItem('admin_session')
    && session?.userInfo.id === id && session.userInfo.level === auth.userInfo?.level ? id : 0;
}
function permission(fine: string, canonical: string) {
  if (!owner()) return false;
  if (auth.userInfo?.level === 0) return true;
  const session = getAdminSession();
  return [fine, canonical, 'system.manage', 'system.legacy_admin_manage'].some(key => auth.uniqueAuth.includes(key) && session?.uniqueAuth.includes(key));
}
const canRecover = computed(() => owner() > 0);
const canView = computed(() => permission('system.legacy_admin_view', 'system.view'));
const canForm = computed(() => permission('system.legacy_admin_form_view', 'system.view'));
const canManage = computed(() => permission('system.legacy_admin_manage', 'system.manage'));
const scope = new StaffRequestScope(() => identity.value, () => localStorage.getItem('admin_session'), owner);
const store = new StaffPendingStore(localStorage);
const rows = ref<LegacyStaffRow[]>([]), total = ref(0), listReady = ref(false), loading = ref(false), listError = ref('');
const query = reactive<LegacyStaffQuery>({ name: '', status: '', page: 1, limit: 20 });
const emptyFields = (): LegacyStaffFields => ({ account: '', pwd: '', conf_pwd: '', real_name: '', phone: '', roles: [], status: 1 });
const editor = reactive({ show: false, id: 0, fields: emptyFields() });
const form = ref<LegacyStaffForm | null>(null), formLoading = ref(false), formError = ref('');
const hasInactiveRoles = computed(() => form.value?.roleOptions.some(role => role.disabled === true && editor.fields.roles.includes(role.value)) ?? false);
const busy = ref(false), error = ref(''), recoveryError = ref(''), recoveryMessage = ref('');
const pending = ref<LegacyStaffPending | null>(null), preview = ref<LegacyStaffPreview | null>(null);
const confirmation = reactive({ show: false, checked: false });
type Snapshot = { envelope: LegacyStaffEnvelope; fingerprint: string; previewFingerprint: string; stamp: StaffStamp; targetFingerprint: string };
let snapshot: Snapshot | null = null, previewSequence = 0;
const retry = ref<{ envelope: LegacyStaffCommit; fingerprint: string; stamp: StaffStamp } | null>(null);
const writeBlocked = computed(() => busy.value || !!pending.value || !!recoveryError.value);
const canRetry = computed(() => canManage.value && !!pending.value && !!retry.value && scope.current(retry.value.stamp)
  && retry.value.envelope.operation_id === pending.value.operation_id && JSON.stringify(retry.value.envelope) === retry.value.fingerprint);
const message = (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback;
const operationLabel = (kind: LegacyStaffKind) => kind === 'legacy-admin-save' ? '保存管理员' : kind === 'legacy-admin-status' ? '更改管理员状态' : '删除管理员';
const actionLabel = (action: LegacyStaffAction) => ({ create: '新增管理员', update: '修改管理员', status: '更改状态', delete: '删除管理员' })[action];
function displayValues(value: LegacyStaffValues) {
  return [{ label: '账号', value: value.account }, { label: '姓名', value: value.real_name || '未填写' }, { label: '手机号', value: value.phone || '未填写' },
    { label: '角色ID', value: value.roles.join(', ') }, { label: '层级', value: String(value.level) }, { label: '状态', value: value.status === 1 ? '开启' : '关闭' },
    { label: '账号保留', value: value.is_del === 1 ? '已删除' : '保留' }];
}
function cancelPreview() { previewSequence++; snapshot = null; preview.value = null; confirmation.show = false; confirmation.checked = false; }
function closeEditor() { cancelPreview(); editor.show = false; editor.fields.pwd = editor.fields.conf_pwd = ''; }
function restorePending() {
  pending.value = null; retry.value = null; recoveryError.value = recoveryMessage.value = '';
  const actor = owner(); if (!actor) return;
  try { pending.value = store.read(actor); } catch (reason) { recoveryError.value = message(reason, '无法读取待确认记录，请保留记录并核对'); }
}
function clearView() {
  scope.invalidate(); cancelPreview(); closeEditor(); form.value = null; rows.value = []; total.value = 0; listReady.value = false;
  loading.value = formLoading.value = busy.value = false; listError.value = formError.value = error.value = ''; pending.value = null; retry.value = null;
  recoveryError.value = recoveryMessage.value = ''; Object.assign(query, { name: '', status: '', page: 1, limit: 20 }); editor.fields = emptyFields();
}
async function loadList(page = query.page) {
  if (!canView.value) return;
  cancelPreview(); const job = scope.begin('list'), q = { ...query, page }; loading.value = true; listReady.value = false; listError.value = '';
  try { const result = await apiStaffList(q, job.controller.signal); if (!scope.valid('list', job) || !canView.value) return;
    if (result.list.some(row => row.level !== Number(auth.userInfo?.level) + 1)) throw Error('管理员层级已变化，请重新登录后读取');
    rows.value = result.list; total.value = result.count; query.page = page; listReady.value = true;
  } catch (reason) { if (scope.valid('list', job)) listError.value = message(reason, '管理员列表读取失败'); }
  finally { if (scope.finish('list', job)) loading.value = false; }
}
function resetQuery() { query.name = ''; query.status = ''; void loadList(1); }
async function openForm(row?: LegacyStaffRow) {
  if (!canForm.value || writeBlocked.value || !listReady.value || row && !rows.value.includes(row) || !row && !canManage.value) return;
  cancelPreview(); const job = scope.begin('form'), id = row?.id ?? 0; formLoading.value = true; formError.value = ''; form.value = null;
  editor.id = id; editor.fields = emptyFields(); editor.show = true;
  try { const result = await apiStaffForm(id, job.controller.signal); if (!scope.valid('form', job) || !canForm.value || editor.id !== id || !editor.show) return;
    form.value = result; editor.fields = { ...result.fields, roles: [...result.fields.roles] };
  } catch (reason) { if (scope.valid('form', job)) formError.value = message(reason, '管理员表单读取失败'); }
  finally { if (scope.finish('form', job)) formLoading.value = false; }
}
function savePayload() { return { id: editor.id, ...validateStaffFields({ ...editor.fields, roles: [...editor.fields.roles].sort((a, b) => a - b) }, editor.id === 0) }; }
function removeInactiveRoles() {
  if (!canManage.value || writeBlocked.value || !editor.show || !form.value) return;
  const inactive = new Set(form.value.roleOptions.filter(role => role.disabled === true).map(role => role.value));
  editor.fields.roles = editor.fields.roles.filter(id => !inactive.has(id));
}
function targetFingerprint(id: number) { return JSON.stringify(rows.value.find(row => row.id === id) ?? null); }
function unchanged(saved: Snapshot) {
  if (!scope.current(saved.stamp) || !canManage.value) return false;
  return saved.envelope.operation === 'legacy-admin-save' ? editor.show && !!form.value && JSON.stringify(savePayload()) === saved.fingerprint
    : listReady.value && targetFingerprint(Number(saved.envelope.payload.id)) === saved.targetFingerprint;
}
async function prepareOperation(operation: LegacyStaffKind, payload: Record<string, unknown>) {
  if (!canManage.value || writeBlocked.value) return;
  restorePending(); if (writeBlocked.value) return;
  cancelPreview(); const sequence = previewSequence, job = scope.begin('preview'); busy.value = true; error.value = '';
  const envelope: LegacyStaffEnvelope = { operation_id: crypto.randomUUID(), operation, payload }, candidate: Snapshot = { envelope,
    fingerprint: JSON.stringify(payload), previewFingerprint: '', stamp: job.stamp, targetFingerprint: targetFingerprint(Number(payload.id)) };
  try { const result = await apiStaffPreview(envelope, job.stamp.actor, job.controller.signal);
    if (!scope.valid('preview', job) || sequence !== previewSequence || !unchanged(candidate)) return;
    if (result.summary.after.level !== Number(auth.userInfo?.level) + 1) throw Error('管理员层级已变化，请重新登录后预览');
    candidate.previewFingerprint = JSON.stringify(result); snapshot = candidate; preview.value = result; confirmation.checked = false; confirmation.show = true;
  } catch (reason) { if (scope.valid('preview', job)) error.value = message(reason, '影响预览失败，尚未提交'); }
  finally { if (scope.finish('preview', job)) busy.value = false; }
}
async function prepareSave() {
  if (!canForm.value || !form.value || !editor.show || !canManage.value || writeBlocked.value) return;
  if (hasInactiveRoles.value) { error.value = '请先移除停用或已删除角色，再选择可委派的启用角色'; ElMessage.warning(error.value); return; }
  try { await prepareOperation('legacy-admin-save', savePayload()); } catch (reason) { error.value = message(reason, '请核对管理员表单'); ElMessage.warning(error.value); }
}
async function prepareStatus(row: LegacyStaffRow) {
  if (!listReady.value || !rows.value.includes(row) || writeBlocked.value) return;
  closeEditor(); await prepareOperation('legacy-admin-status', { id: row.id, status: row.status === 1 ? 0 : 1 });
}
async function prepareDelete(row: LegacyStaffRow) {
  if (!listReady.value || !rows.value.includes(row) || writeBlocked.value) return;
  closeEditor(); await prepareOperation('legacy-admin-delete', { id: row.id });
}
async function finishReceipt(receipt: LegacyStaffReceipt, expected: LegacyStaffPending, stamp: StaffStamp) {
  if (!scope.current(stamp) || pending.value?.operation_id !== expected.operation_id) return;
  if (receipt.state === 'unknown') { recoveryMessage.value = '尚未查到原耐久回执，结果仍未知。请继续查询或确认取消未执行操作。'; return; }
  const cleared = await store.finish(receipt, expected, () => scope.current(stamp) && pending.value?.operation_id === expected.operation_id);
  if (!cleared || !scope.current(stamp)) return;
  pending.value = null; retry.value = null; recoveryError.value = recoveryMessage.value = ''; closeEditor();
  ElMessage.success(receipt.state === 'not_applied' ? '原操作已永久封存为未执行，可以重新预览' : expected.action === 'create' ? '管理员已创建' : expected.action === 'delete' ? '管理员已删除' : '管理员已更新');
  if (canView.value) await loadList();
}
async function sendCommit(envelope: LegacyStaffCommit, expected: LegacyStaffPending, stamp: StaffStamp) {
  if (!scope.current(stamp) || !canManage.value) return;
  const job = scope.begin('write'); busy.value = true;
  try { const receipt = await apiStaffCommit(envelope, expected, job.controller.signal); if (scope.valid('write', job)) await finishReceipt(receipt, expected, stamp); }
  catch (reason) { if (scope.valid('write', job)) recoveryMessage.value = message(reason, '提交结果未知，请查询原操作回执'); }
  finally { if (scope.finish('write', job)) busy.value = false; }
}
async function confirmOperation() {
  const p = preview.value, saved = snapshot;
  if (!p || !saved || !confirmation.checked || writeBlocked.value || !canManage.value) return;
  try { if (!unchanged(saved) || JSON.stringify(p) !== saved.previewFingerprint || p.expires_at <= Math.floor(Date.now() / 1000)) throw Error('草稿、身份或预览已变化，请重新预览'); }
  catch (reason) { cancelPreview(); error.value = message(reason, '请重新预览'); return; }
  const expected: LegacyStaffPending = { version: 1, operation_id: p.operation_id, actor_id: p.actor_id, operation: p.operation, request_hash: p.request_hash,
    target_id: p.summary.target_id, action: p.summary.action };
  const envelope: LegacyStaffCommit = { ...saved.envelope, revision: p.revision, expires_at: p.expires_at, confirmed: true };
  busy.value = true;
  try { await store.reserve(expected, () => scope.current(saved.stamp) && canManage.value && snapshot === saved && confirmation.checked && unchanged(saved)); }
  catch (reason) { if (scope.current(saved.stamp)) { restorePending(); recoveryError.value = message(reason, '恢复记录未能保存，未提交'); busy.value = false; } return; }
  if (!scope.current(saved.stamp)) return;
  pending.value = expected; retry.value = { envelope, fingerprint: JSON.stringify(envelope), stamp: saved.stamp }; cancelPreview();
  await sendCommit(envelope, expected, saved.stamp);
}
async function recoverOperation() {
  const expected = pending.value; if (!expected || busy.value || !owner()) return;
  const job = scope.begin('recovery'); busy.value = true;
  try { const receipt = await apiStaffReceipt(expected, job.controller.signal); if (scope.valid('recovery', job)) await finishReceipt(receipt, expected, job.stamp); }
  catch (reason) { if (scope.valid('recovery', job)) recoveryMessage.value = message(reason, '回执查询失败，结果仍未知'); }
  finally { if (scope.finish('recovery', job)) busy.value = false; }
}
async function resolveOperation() {
  const expected = pending.value; if (!expected || busy.value || !owner()) return;
  const job = scope.begin('recovery'); busy.value = true;
  try { try { await ElMessageBox.confirm('确认取消这笔尚未执行的操作？服务端会永久封存原操作编号；若已执行，将返回原回执。', '确认操作结果', { type: 'warning' }); } catch { return; }
    if (!scope.valid('recovery', job) || pending.value?.operation_id !== expected.operation_id) return;
    const receipt = await apiStaffResolve(expected, job.controller.signal); if (scope.valid('recovery', job)) await finishReceipt(receipt, expected, job.stamp);
  } catch (reason) { if (scope.valid('recovery', job)) recoveryMessage.value = message(reason, '未能封存原操作，结果仍未知'); }
  finally { if (scope.finish('recovery', job)) busy.value = false; }
}
async function retryOperation() {
  const expected = pending.value, saved = retry.value; if (!expected || !saved || !canRetry.value || busy.value) return;
  const job = scope.begin('retry-confirm'); busy.value = true;
  try { try { await ElMessageBox.confirm('只重试已经确认的原操作编号与原始请求，不提交当前表单的新草稿。', '重试同一操作', { type: 'warning' }); } catch { return; }
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
  else if (event.key === staffPendingKey(owner())) { cancelPreview(); restorePending(); }
}
watch(identity, () => { if (!alive || syncing) return; clearView(); sessionVersion.value++; restorePending(); if (canView.value) void loadList(); }, { flush: 'sync' });
watch(() => JSON.stringify([editor.id, editor.fields]), () => { if (preview.value || snapshot) cancelPreview(); }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; clearView(); scope.dispose(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.staff-page { min-width: 0; }.staff-page :deep(.el-alert) { margin-bottom: 14px; }.hint { color: var(--el-text-color-secondary); font-size: 13px; }.head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 16px 0; }.head h3 { margin: 0; }.filters .el-input { width: 210px; }.filters .el-select { width: 120px; }.role-select { width: 100%; }.pager { margin-top: 16px; max-width: 100%; overflow-x: auto; }.actions { display: flex; flex-wrap: wrap; gap: 8px; }.comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }.comparison section { padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; min-width: 0; }.comparison h4 { margin: 0 0 12px; }.comparison dl { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; }.comparison dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }.confirm-check { margin-top: 16px; height: auto; white-space: normal; }.confirm-check :deep(.el-checkbox__label) { white-space: normal; }
@media (max-width: 600px) { .comparison { grid-template-columns: 1fr; }.filters :deep(.el-form-item) { display: flex; margin-right: 0; }.filters :deep(.el-form-item__content) { min-width: 0; flex-wrap: wrap; gap: 8px; } }
</style>
