<template>
  <el-config-provider :locale="zhCn">
  <div class="system-page">
    <el-alert v-if="!canView" title="当前账号没有管理员与角色查看权限" type="warning" show-icon :closable="false" />
      <el-alert v-if="canRecover && recoveryError" :title="recoveryError" type="error" show-icon :closable="false" class="notice" />
      <el-alert v-if="canRecover && pendingOperation" title="上一笔操作结果待确认，暂不能提交新的操作" type="warning" show-icon :closable="false" class="notice">
        <template #default><p>{{ operationLabel(pendingOperation.operation) }} · 操作编号 {{ pendingOperation.operation_id }}</p>
          <p>{{ recoveryMessage || '请查询操作回执；刷新目录不会解除待确认状态。' }}</p>
          <div class="recovery-actions"><el-button :loading="busy" :disabled="busy" @click="recoverOperation">查询回执</el-button>
            <el-button v-if="canRetryOperation" :disabled="busy" @click="retryOperation">重试同一操作</el-button>
            <el-button type="warning" :disabled="busy" @click="resolveOperation">确认取消未执行操作</el-button></div>
        </template>
      </el-alert>
    <template v-if="canView">
      <el-alert v-if="!canManage" title="当前账号仅可查看管理员与角色" type="info" show-icon :closable="false" class="notice" />
      <el-alert v-if="writeError" :title="writeError" type="error" show-icon :closable="false" class="notice" />
      <el-tabs v-model="activeTab">
        <el-tab-pane label="管理员" name="admin">
          <div class="page-head"><h3>系统管理员</h3><el-button v-if="canManage" type="primary" :disabled="writeBlocked || !adminReady" @click="openAdminForm()">＋ 新增管理员</el-button></div>
          <el-form :inline="true" class="filters" @submit.prevent="searchAdmin">
            <el-form-item label="关键词"><el-input v-model="adminQuery.keyword" placeholder="账号、姓名或手机号" clearable maxlength="64" /></el-form-item>
            <el-form-item label="状态"><el-select v-model="adminQuery.status" placeholder="全部" aria-label="管理员状态筛选"><el-option label="全部" value="" /><el-option label="正常" :value="1" /><el-option label="禁用" :value="0" /></el-select></el-form-item>
            <el-form-item><el-button type="primary" native-type="submit" :loading="adminLoading">查询</el-button><el-button @click="resetAdmin">重置</el-button><el-button :disabled="adminLoading" @click="loadAdmin()">刷新</el-button></el-form-item>
          </el-form>
          <el-alert v-if="adminError" :title="adminError" type="error" show-icon :closable="false" class="notice"><template #default>上次读取的列表仅供查看，请重新读取后再编辑。</template></el-alert>
          <el-table :data="adminList" v-loading="adminLoading" border empty-text="没有匹配的管理员">
            <el-table-column prop="id" label="ID" width="70" /><el-table-column prop="account" label="账号" min-width="140" /><el-table-column prop="realName" label="姓名" min-width="100" />
            <el-table-column prop="phone" label="手机号" min-width="130" /><el-table-column prop="roles" label="角色 ID" min-width="110" />
            <el-table-column label="等级" width="80"><template #default="{ row }">{{ row.level === 0 ? '超级' : `L${row.level}` }}</template></el-table-column>
            <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '禁用' }}</el-tag></template></el-table-column>
            <el-table-column label="最后登录" min-width="165"><template #default="{ row }">{{ formatTime(row.lastTime) }}</template></el-table-column>
            <el-table-column v-if="canManage" label="操作" width="80"><template #default="{ row }"><el-button link type="primary" :disabled="writeBlocked || !adminReady || (row.level === 0 && auth.userInfo?.level !== 0)" @click="openAdminForm(row)">编辑</el-button></template></el-table-column>
          </el-table>
          <el-pagination class="pager" layout="total, prev, pager, next" :total="adminTotal" :page-count="Math.min(500, Math.ceil(adminTotal / adminQuery.limit))" :page-size="adminQuery.limit" :current-page="adminQuery.page" :disabled="adminLoading || busy" @current-change="loadAdmin" />
          <p v-if="adminTotal > 10000" class="hint">最多浏览前 10000 条匹配结果，请缩小关键词或状态范围。</p>
        </el-tab-pane>
        <el-tab-pane label="角色权限" name="role">
          <div class="page-head"><h3>角色管理</h3><el-button v-if="canManage" type="primary" :disabled="writeBlocked || !roleReady || !permissionTreeReady" @click="openRoleForm()">＋ 新增角色</el-button></div>
          <el-form :inline="true" class="filters" @submit.prevent="searchRoles">
            <el-form-item label="关键词"><el-input v-model="roleQuery.keyword" placeholder="角色名称" clearable maxlength="64" /></el-form-item>
            <el-form-item label="状态"><el-select v-model="roleQuery.status" placeholder="全部" aria-label="角色状态筛选"><el-option label="全部" value="" /><el-option label="正常" :value="1" /><el-option label="禁用" :value="0" /></el-select></el-form-item>
            <el-form-item><el-button type="primary" native-type="submit" :loading="roleLoading">查询</el-button><el-button @click="resetRoles">重置</el-button><el-button :disabled="roleLoading" @click="loadRoles()">刷新</el-button></el-form-item>
          </el-form>
          <el-alert v-if="roleError" :title="roleError" type="error" show-icon :closable="false" class="notice"><template #default>上次读取的列表仅供查看，请重新读取后再编辑。</template></el-alert>
          <el-alert v-if="permissionTreeError" :title="permissionTreeError" type="warning" show-icon :closable="false" class="notice"><template #default><el-button :disabled="busy || permissionTreeLoading" @click="loadPermissionTree">重新读取权限目录</el-button></template></el-alert>
          <el-table :data="roleList" v-loading="roleLoading" border empty-text="没有匹配的角色">
            <el-table-column prop="id" label="ID" width="70" /><el-table-column prop="roleName" label="角色名称" min-width="160" />
            <el-table-column label="权限规则" min-width="240"><template #default="{ row }"><el-tag v-for="key in row.permissionKeys" :key="key" size="small" class="rule-tag">{{ key }}</el-tag><span v-if="!row.permissionKeys.length">未配置可识别权限</span></template></el-table-column>
            <el-table-column prop="level" label="等级" width="80" /><el-table-column label="状态" width="80"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'danger'">{{ row.status === 1 ? '正常' : '禁用' }}</el-tag></template></el-table-column>
            <el-table-column v-if="canManage" label="操作" width="140"><template #default="{ row }"><el-button link type="primary" :disabled="writeBlocked || !roleReady || !permissionTreeReady" @click="openRoleForm(row)">编辑</el-button><el-button link type="danger" :disabled="writeBlocked || !roleReady || ownRole(row.id)" @click="delRole(row)">删除</el-button></template></el-table-column>
          </el-table>
          <el-pagination class="pager" layout="total, prev, pager, next" :total="roleTotal" :page-count="Math.min(500, Math.ceil(roleTotal / roleQuery.limit))" :page-size="roleQuery.limit" :current-page="roleQuery.page" :disabled="roleLoading || busy" @current-change="loadRoles" />
          <p v-if="roleTotal > 10000" class="hint">最多浏览前 10000 条匹配结果，请缩小关键词或状态范围。</p>
        </el-tab-pane>
      </el-tabs>
    </template>
    <el-dialog v-model="adminDialog.show" :title="adminDialog.id ? '编辑管理员' : '新增管理员'" width="min(480px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @closed="adminDialog.pwd = ''">
      <el-form label-width="80px" :disabled="writeBlocked || !canManage || !adminReady">
        <el-form-item label="账号"><el-input v-model="adminDialog.account" :disabled="!!adminDialog.id" placeholder="登录账号" /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="adminDialog.real_name" placeholder="真实姓名" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="adminDialog.phone" placeholder="手机号" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="adminDialog.pwd" type="password" show-password autocomplete="new-password" :placeholder="adminDialog.id ? '不修改留空；修改至少 12 位' : '至少 12 位'" /></el-form-item>
        <el-form-item label="角色 ID"><el-input v-model="adminDialog.roles" placeholder="角色 ID，逗号分隔" /></el-form-item>
        <el-form-item label="等级"><el-input-number v-model="adminDialog.level" :min="auth.userInfo?.level === 0 ? 0 : 1" :max="9" :precision="0" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="adminDialog.status"><el-option label="正常" :value="1" /><el-option label="禁用" :value="0" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="cancelAdminDialog">取消</el-button><el-button type="primary" :loading="busy" :disabled="writeBlocked || !canManage || !adminReady" @click="saveAdmin">预览变更</el-button></template>
    </el-dialog>
    <el-dialog v-model="roleDialog.show" :title="roleDialog.id ? '编辑角色' : '新增角色'" width="min(620px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
      <el-alert v-if="roleDialog.permissionError" :title="roleDialog.permissionError" type="warning" :closable="false" class="notice" />
      <el-form label-width="80px" :disabled="writeBlocked || !canManage || !roleReady || !permissionTreeReady || !!roleDialog.permissionError">
        <el-form-item label="角色名称"><el-input v-model="roleDialog.role_name" placeholder="角色名称" /></el-form-item>
        <el-form-item label="等级"><template v-if="roleDialog.originalLevel !== null && roleDialog.originalLevel > 9"><span>既有等级 {{ roleDialog.originalLevel }}；默认保留</span><el-checkbox :model-value="roleDialog.changeLegacyLevel" @change="changeLegacyRoleLevel">修改等级</el-checkbox></template><el-input-number v-if="roleDialog.originalLevel === null || roleDialog.originalLevel <= 9 || roleDialog.changeLegacyLevel" v-model="roleDialog.level" :min="0" :max="9" :precision="0" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="roleDialog.status"><el-option label="正常" :value="1" /><el-option label="禁用" :value="0" /></el-select></el-form-item>
        <el-form-item label="菜单权限"><el-tree ref="permissionTreeRef" class="permission-tree" :data="permissionTree" node-key="key" show-checkbox default-expand-all :props="{ label: 'label', children: 'children' }" @check="roleSelectionChanged" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="cancelRoleDialog">取消</el-button><el-button type="primary" :loading="busy" :disabled="writeBlocked || !canManage || !roleReady || !permissionTreeReady || !!roleDialog.permissionError" @click="saveRole">预览变更</el-button></template>
    </el-dialog>
    <el-dialog v-model="previewDialog.show" title="确认管理员与角色变更" width="min(900px, calc(100vw - 24px))"
      :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @closed="cancelPreview">
      <template v-if="operationPreview">
        <el-alert title="以下为变更预览，尚未执行。请核对变更及完整影响名单后确认。" type="warning" :closable="false" class="notice" />
        <p>{{ operationLabel(operationPreview.operation) }}：{{ operationPreview.summary.target_name }} · {{ operationPreview.summary.action === 'create' ? '新建' : `ID ${operationPreview.summary.target_id}` }}</p>
        <div class="change-comparison"><section><h4>变更前</h4><p v-if="!operationPreview.summary.before">尚未创建</p><dl v-else><template v-for="item in previewValues(operationPreview.summary.before)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></template></dl></section>
          <section><h4>变更后</h4><dl><template v-for="item in previewValues(operationPreview.summary.after)" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></template></dl></section></div>
        <h4>完整影响名单（{{ operationPreview.affected_accounts.length }} 个账号）</h4>
        <el-table :data="operationPreview.affected_accounts" border max-height="360" empty-text="没有受影响的既有账号">
          <el-table-column prop="id" label="ID" width="70" /><el-table-column prop="account" label="账号" min-width="140" /><el-table-column prop="real_name" label="姓名" min-width="100" />
          <el-table-column label="等级" width="90"><template #default="{ row }">{{ row.level === 0 ? '超级管理员' : `L${row.level}` }}</template></el-table-column>
          <el-table-column label="状态" width="80"><template #default="{ row }">{{ row.status === 1 ? '正常' : '禁用' }}</template></el-table-column>
          <el-table-column label="删除状态" width="95"><template #default="{ row }">{{ row.is_del === 1 ? '已删除' : '未删除' }}</template></el-table-column>
        </el-table>
        <el-checkbox v-model="previewDialog.confirmed" :disabled="busy" class="confirm-check">我已核对变更内容与完整影响名单，确认执行此操作</el-checkbox>
      </template>
      <template #footer><el-button :disabled="busy" @click="cancelPreview">取消预览</el-button><el-button type="primary" :loading="busy" :disabled="!previewDialog.confirmed || writeBlocked || !canManage" @click="confirmOperation">确认执行</el-button></template>
    </el-dialog>
  </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import dayjs from 'dayjs';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiAdminSystemAdminDirectory, apiAdminSystemRoleDirectory, apiAdminPermissionTree,
  apiAdminAuthorityPreview, apiAdminAuthorityCommit, apiAdminAuthorityReceipt, apiAdminAuthorityResolve, isAdminAuthorityPending,
  type AdminAuthorityPreview, type AdminAuthorityPending, type AdminAuthorityCommit, type AdminAuthorityReceipt, type AdminAuthorityOperationKind,
  type AdminAuthorityValues, type AdminAccount, type RoleItem, type PermissionTreeNode, type SystemDirectoryQuery } from '@/api/system';

const auth = useAuthStore();
const activeTab = ref('admin');
const adminList = ref<AdminAccount[]>([]), roleList = ref<RoleItem[]>([]);
const adminTotal = ref(0), roleTotal = ref(0);
const adminLoading = ref(false), roleLoading = ref(false), busy = ref(false);
const adminReady = ref(false), roleReady = ref(false);
const adminError = ref(''), roleError = ref(''), writeError = ref('');
const adminQuery = reactive<SystemDirectoryQuery>({ keyword: '', status: '', page: 1, limit: 20 });
const roleQuery = reactive<SystemDirectoryQuery>({ keyword: '', status: '', page: 1, limit: 20 });
const permissionTree = ref<PermissionTreeNode[]>([]), permissionTreeReady = ref(false), permissionTreeError = ref(''), permissionTreeLoading = ref(false);
const permissionTreeRef = ref<{ setCheckedKeys(keys: string[]): void; getCheckedKeys(leafOnly?: boolean): unknown[] } | null>(null);
const adminDialog = reactive({ show: false, id: 0, account: '', real_name: '', phone: '', pwd: '', roles: '', level: 1, status: 1 });
const roleDialog = reactive({ show: false, id: 0, role_name: '', level: 0, originalLevel: null as number | null, changeLegacyLevel: false, status: 1, permissionKeys: [] as string[], permissionError: '' });
const previewDialog = reactive({ show: false, confirmed: false });
const operationPreview = ref<AdminAuthorityPreview | null>(null), pendingOperation = ref<AdminAuthorityPending | null>(null);
const recoveryError = ref(''), recoveryMessage = ref('');
const writeBlocked = computed(() => busy.value || !!pendingOperation.value || !!recoveryError.value);
let previewRequest: { payload: Record<string, unknown>; fingerprint: string; previewFingerprint: string; generation: number } | null = null;
const retryRequest = ref<{ envelope: AdminAuthorityCommit; generation: number } | null>(null);
const canRetryOperation = computed(() => canManage.value && !!pendingOperation.value && !!retryRequest.value && retryRequest.value.generation === generation
  && retryRequest.value.envelope.operation_id === pendingOperation.value.operation_id && pendingOperation.value.actor_id === auth.userInfo?.id);
const canRecover = computed(() => loggedOwner() > 0);
let alive = false, syncing = false, generation = 0;
let stored = localStorage.getItem('admin_session');
const sessionVersion = ref(0);
let adminSequence = 0, roleSequence = 0, treeSequence = 0;
let adminAbort: AbortController | null = null, roleAbort: AbortController | null = null, treeAbort: AbortController | null = null, writeAbort: AbortController | null = null;
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const canView = computed(() => {
  void sessionVersion.value;
  const session = getAdminSession();
  return !!auth.token && auth.token === getToken() && stored === localStorage.getItem('admin_session') && !!session && !!auth.userInfo
    && session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level
    && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('system.view') && session.uniqueAuth.includes('system.view'));
});
const canManage = computed(() => canView.value && (auth.userInfo?.level === 0 || auth.uniqueAuth.includes('system.manage') && !!getAdminSession()?.uniqueAuth.includes('system.manage')));
function current(stamp: number) { return alive && canView.value && stamp === generation && stored === localStorage.getItem('admin_session') && auth.token === getToken(); }
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
function formatTime(ts: number) { return ts ? dayjs(ts * 1000).format('YYYY-MM-DD HH:mm') : '—'; }
function ownRole(id: number) { return (auth.userInfo?.roles ?? '').split(',').map(value => value.trim()).includes(String(id)); }
const pendingStorageKey = (owner: number) => `admin_authority_pending_v1:${owner}`;
function loggedOwner(): number {
  void sessionVersion.value;
  const owner = auth.userInfo?.id ?? 0, session = getAdminSession();
  return alive && !!auth.token && auth.token === getToken() && Number.isSafeInteger(owner) && owner > 0
    && stored === localStorage.getItem('admin_session') && session?.userInfo.id === owner ? owner : 0;
}
function ownerCurrent(stamp: number, owner: number) { return stamp === generation && loggedOwner() === owner; }
function operationLabel(kind: AdminAuthorityOperationKind) { return kind === 'admin-save' ? '保存管理员' : kind === 'role-save' ? '保存角色' : '删除角色'; }
function previewValues(value: AdminAuthorityValues) {
  return Object.entries(value).map(([key, field]) => ({ label: ({ role_name: '角色名称', rules: '权限规则', roles: '角色 ID', level: '等级', status: '状态' } as Record<string, string>)[key],
    value: key === 'status' ? field === 1 ? '正常' : field === 0 ? '禁用' : '删除' : String(field || (field === 0 ? 0 : '未配置')) }));
}
let previewSequence = 0;
function cancelPreview() {
  previewSequence++; previewDialog.show = false; previewDialog.confirmed = false;
  operationPreview.value = null; previewRequest = null;
}
function cancelAdminDialog() { cancelPreview(); adminDialog.show = false; adminDialog.pwd = ''; }
function cancelRoleDialog() { cancelPreview(); roleDialog.show = false; }
function restorePending() {
  pendingOperation.value = null; retryRequest.value = null; recoveryError.value = ''; recoveryMessage.value = '';
  const owner = loggedOwner(); if (!owner) return;
  try {
    const raw = localStorage.getItem(pendingStorageKey(owner)); if (!raw) return;
    const value: unknown = JSON.parse(raw);
    if (!isAdminAuthorityPending(value, owner)) throw Error('待确认操作记录无效，请保留记录并联系管理员核对');
    pendingOperation.value = value;
  } catch (error) { recoveryError.value = message(error, '无法读取待确认操作，请保留记录并核对'); }
}
function persistPending(value: AdminAuthorityPending) {
  const key = pendingStorageKey(value.actor_id);
  if (localStorage.getItem(key)) throw Error('已有待确认操作，请先查询回执');
  localStorage.setItem(key, JSON.stringify(value));
  if (localStorage.getItem(key) !== JSON.stringify(value)) throw Error('无法可靠保存待确认操作，未提交');
  pendingOperation.value = value;
}
function adminPayload(): Record<string, unknown> {
  return { ...(adminDialog.id ? { id: adminDialog.id } : {}), account: adminDialog.account, real_name: adminDialog.real_name,
    phone: adminDialog.phone, ...(adminDialog.pwd ? { pwd: adminDialog.pwd } : {}), roles: adminDialog.roles, level: adminDialog.level, status: adminDialog.status };
}
function rolePayload(): Record<string, unknown> {
  const keys = permissionTreeRef.value?.getCheckedKeys(true) ?? [];
  return { ...(roleDialog.id ? { id: roleDialog.id } : {}), role_name: roleDialog.role_name,
    ...(!roleDialog.id || roleDialog.level !== roleDialog.originalLevel ? { level: roleDialog.level } : {}),
    status: roleDialog.status, rules: [...new Set(keys as string[])].join(',') };
}
function roleSelectionChanged() { roleDialog.permissionKeys = (permissionTreeRef.value?.getCheckedKeys(true) ?? []).filter((key): key is string => typeof key === 'string'); }
function changeLegacyRoleLevel(value: unknown) {
  roleDialog.changeLegacyLevel = value === true;
  roleDialog.level = value === true ? 0 : roleDialog.originalLevel ?? 0;
}
function draftUnchanged(kind: AdminAuthorityOperationKind, payload: Record<string, unknown>, fingerprint: string) {
  return kind === 'admin-save' ? adminDialog.show && JSON.stringify(adminPayload()) === fingerprint
    : kind === 'role-save' ? roleDialog.show && JSON.stringify(rolePayload()) === fingerprint
      : roleReady.value && roleList.value.some(row => row.id === payload.id) && !ownRole(Number(payload.id));
}
async function prepareOperation(kind: AdminAuthorityOperationKind, payload: Record<string, unknown>) {
  if (!current(generation) || !canManage.value || writeBlocked.value) return;
  restorePending(); if (writeBlocked.value) return;
  cancelPreview(); const sequence = previewSequence, stamp = generation, owner = loggedOwner();
  const fingerprint = JSON.stringify(payload), envelope = { operation_id: crypto.randomUUID(), operation: kind, payload };
  const controller = new AbortController(); writeAbort = controller; busy.value = true; writeError.value = '';
  try {
    const result = await apiAdminAuthorityPreview(envelope, owner, controller.signal);
    if (!current(stamp) || !canManage.value || sequence !== previewSequence || !draftUnchanged(kind, payload, fingerprint)) return;
    previewRequest = { payload, fingerprint, previewFingerprint: JSON.stringify(result), generation: stamp }; operationPreview.value = result;
    previewDialog.confirmed = false; previewDialog.show = true;
  } catch (error) { if (current(stamp)) { writeError.value = message(error, '预览失败，尚未提交'); ElMessage.error(writeError.value); } }
  finally { if (writeAbort === controller) { writeAbort = null; busy.value = false; } }
}
async function finishReceipt(receipt: AdminAuthorityReceipt, expected: AdminAuthorityPending, stamp: number) {
  if (!ownerCurrent(stamp, expected.actor_id) || pendingOperation.value?.operation_id !== expected.operation_id) return;
  if (receipt.state === 'unknown') { recoveryMessage.value = '尚未查到耐久回执，执行结果仍未知。请继续查询或确认取消未执行操作。'; return; }
  const key = pendingStorageKey(expected.actor_id), raw = localStorage.getItem(key);
  if (raw && (!isAdminAuthorityPending(JSON.parse(raw), expected.actor_id) || JSON.parse(raw).operation_id !== expected.operation_id)) {
    restorePending(); throw Error('待确认操作记录已变化，请重新核对');
  }
  localStorage.removeItem(key); pendingOperation.value = null; retryRequest.value = null; recoveryMessage.value = ''; cancelPreview();
  adminDialog.pwd = '';
  if (receipt.state === 'not_applied') { ElMessage.success('操作已封存为未执行，可以重新预览'); return; }
  if (expected.operation === 'admin-save') adminDialog.show = false; else roleDialog.show = false;
  ElMessage.success(expected.operation === 'role-delete' ? '已删除' : receipt.result?.created ? '创建成功' : '更新成功');
  if (canView.value) { if (expected.operation === 'admin-save') await loadAdmin(); else await loadRoles(); }
}
async function sendCommit(envelope: AdminAuthorityCommit, expected: AdminAuthorityPending, stamp: number) {
  const controller = new AbortController(); writeAbort = controller; busy.value = true; writeError.value = '';
  try { await finishReceipt(await apiAdminAuthorityCommit(envelope, expected, controller.signal), expected, stamp); }
  catch (error) { if (ownerCurrent(stamp, expected.actor_id)) { recoveryMessage.value = message(error, '提交结果未知，请查询操作回执'); ElMessage.error(recoveryMessage.value); } }
  finally { if (writeAbort === controller) { writeAbort = null; busy.value = false; } }
}
async function confirmOperation() {
  const preview = operationPreview.value, snapshot = previewRequest;
  if (!preview || !snapshot || !previewDialog.confirmed || !current(snapshot.generation) || !canManage.value || writeBlocked.value) return;
  if (JSON.stringify(preview) !== snapshot.previewFingerprint || preview.expires_at <= Math.floor(Date.now() / 1000)
    || !draftUnchanged(preview.operation, snapshot.payload, snapshot.fingerprint)) {
    cancelPreview(); writeError.value = '草稿或预览已变化，请重新预览'; return;
  }
  const expected: AdminAuthorityPending = { version: 1, operation_id: preview.operation_id, actor_id: preview.actor_id,
    operation: preview.operation, request_hash: preview.request_hash, target_id: preview.summary.target_id, action: preview.summary.action };
  const envelope: AdminAuthorityCommit = { operation_id: preview.operation_id, operation: preview.operation, payload: snapshot.payload,
    revision: preview.revision, expires_at: preview.expires_at, confirmed: true };
  try { persistPending(expected); }
  catch (error) { recoveryError.value = message(error, '无法保存恢复记录，未提交'); return; }
  retryRequest.value = { envelope, generation: snapshot.generation }; cancelPreview();
  await sendCommit(envelope, expected, snapshot.generation);
}
async function recoverOperation() {
  const expected = pendingOperation.value, stamp = generation;
  if (!expected || busy.value || !ownerCurrent(stamp, expected.actor_id)) return;
  const controller = new AbortController(); writeAbort = controller; busy.value = true;
  try { await finishReceipt(await apiAdminAuthorityReceipt(expected, controller.signal), expected, stamp); }
  catch (error) { if (ownerCurrent(stamp, expected.actor_id)) recoveryMessage.value = message(error, '回执查询失败，操作仍待确认'); }
  finally { if (writeAbort === controller) { writeAbort = null; busy.value = false; } }
}
async function resolveOperation() {
  const expected = pendingOperation.value, stamp = generation;
  if (!expected || busy.value || !ownerCurrent(stamp, expected.actor_id)) return;
  busy.value = true;
  try {
    try { await ElMessageBox.confirm('确认取消这笔尚未执行的操作？服务端会永久封存此操作编号；若已执行，将返回原回执。', '确认操作结果', { type: 'warning' }); } catch { return; }
    if (!ownerCurrent(stamp, expected.actor_id) || pendingOperation.value?.operation_id !== expected.operation_id) return;
    const controller = new AbortController(); writeAbort = controller;
    try { await finishReceipt(await apiAdminAuthorityResolve(expected, controller.signal), expected, stamp); }
    finally { if (writeAbort === controller) writeAbort = null; }
  } catch (error) { if (ownerCurrent(stamp, expected.actor_id)) recoveryMessage.value = message(error, '操作未能封存，仍待确认'); }
  finally { if (ownerCurrent(stamp, expected.actor_id)) busy.value = false; }
}
async function retryOperation() {
  const expected = pendingOperation.value, saved = retryRequest.value, stamp = generation;
  if (!expected || !saved || busy.value || !canRetryOperation.value || !ownerCurrent(stamp, expected.actor_id)) return;
  busy.value = true;
  try {
    try { await ElMessageBox.confirm('只重试已经确认的同一操作编号和原始请求，不会提交当前编辑的新草稿。', '重试同一操作', { type: 'warning' }); } catch { return; }
    if (!ownerCurrent(stamp, expected.actor_id) || !canManage.value || pendingOperation.value?.operation_id !== expected.operation_id || retryRequest.value !== saved) return;
    await sendCommit(saved.envelope, expected, stamp);
  } finally { if (ownerCurrent(stamp, expected.actor_id)) busy.value = false; }
}

function clear() {
  generation++; adminSequence++; roleSequence++; treeSequence++;
  for (const controller of [adminAbort, roleAbort, treeAbort, writeAbort]) controller?.abort();
  adminAbort = roleAbort = treeAbort = writeAbort = null;
  adminList.value = []; roleList.value = []; permissionTree.value = [];
  adminTotal.value = roleTotal.value = 0;
  adminLoading.value = roleLoading.value = permissionTreeLoading.value = busy.value = false;
  adminReady.value = roleReady.value = permissionTreeReady.value = false;
  adminError.value = roleError.value = permissionTreeError.value = writeError.value = '';
  cancelPreview(); pendingOperation.value = null; retryRequest.value = null; recoveryError.value = recoveryMessage.value = '';
  Object.assign(adminQuery, { keyword: '', status: '', page: 1, limit: 20 }); Object.assign(roleQuery, { keyword: '', status: '', page: 1, limit: 20 });
  Object.assign(adminDialog, { show: false, id: 0, account: '', real_name: '', phone: '', pwd: '', roles: '', level: 1, status: 1 });
  Object.assign(roleDialog, { show: false, id: 0, role_name: '', level: 0, originalLevel: null, changeLegacyLevel: false, status: 1, permissionKeys: [], permissionError: '' });
}
async function loadAdmin(nextPage = adminQuery.page) {
  if (!alive || !canView.value) return;
  const stamp = generation, sequence = ++adminSequence, query = { ...adminQuery, page: nextPage };
  adminAbort?.abort(); const controller = new AbortController(); adminAbort = controller;
  adminLoading.value = true; adminReady.value = false; adminError.value = '';
  try {
    const result = await apiAdminSystemAdminDirectory(query, controller.signal);
    if (!current(stamp) || sequence !== adminSequence || adminAbort !== controller) return;
    adminList.value = result.list; adminTotal.value = result.total; adminQuery.page = result.page; adminReady.value = true;
  } catch (error) {
    if (current(stamp) && sequence === adminSequence && adminAbort === controller) adminError.value = message(error, '管理员目录读取失败');
  } finally { if (adminAbort === controller) { adminAbort = null; adminLoading.value = false; } }
}
async function loadRoles(nextPage = roleQuery.page) {
  if (!alive || !canView.value) return;
  const stamp = generation, sequence = ++roleSequence, query = { ...roleQuery, page: nextPage };
  roleAbort?.abort(); const controller = new AbortController(); roleAbort = controller;
  roleLoading.value = true; roleReady.value = false; roleError.value = '';
  try {
    const result = await apiAdminSystemRoleDirectory(query, controller.signal);
    if (!current(stamp) || sequence !== roleSequence || roleAbort !== controller) return;
    roleList.value = result.list; roleTotal.value = result.total; roleQuery.page = result.page; roleReady.value = true;
  } catch (error) {
    if (current(stamp) && sequence === roleSequence && roleAbort === controller) roleError.value = message(error, '角色目录读取失败');
  } finally { if (roleAbort === controller) { roleAbort = null; roleLoading.value = false; } }
}
function searchAdmin() { void loadAdmin(1); }
function searchRoles() { void loadRoles(1); }
function resetAdmin() { adminQuery.keyword = ''; adminQuery.status = ''; void loadAdmin(1); }
function resetRoles() { roleQuery.keyword = ''; roleQuery.status = ''; void loadRoles(1); }

async function loadPermissionTree() {
  if (!alive || !canManage.value || busy.value) return;
  // A rebuilt tree must not silently replace an open editor's checked rules.
  cancelPreview();
  Object.assign(roleDialog, { show: false, id: 0, role_name: '', level: 0, originalLevel: null, changeLegacyLevel: false, status: 1, permissionKeys: [], permissionError: '' });
  const stamp = generation, sequence = ++treeSequence;
  treeAbort?.abort(); const controller = new AbortController(); treeAbort = controller;
  permissionTreeReady.value = false; permissionTreeLoading.value = true; permissionTreeError.value = '';
  try {
    const result = await apiAdminPermissionTree(controller.signal);
    const keys = new Set<string>();
    if (!Array.isArray(result) || !result.length || result.some(node => !node || typeof node.key !== 'string' || typeof node.label !== 'string' || typeof node.path !== 'string'
      || !Array.isArray(node.children) || !node.children.length || node.children.some(child => !child || typeof child.key !== 'string' || typeof child.label !== 'string'
        || !child.key.startsWith(`${node.key}.`) || keys.has(child.key) || !keys.add(child.key)))) throw Error('权限目录响应格式错误');
    if (current(stamp) && canManage.value && sequence === treeSequence && treeAbort === controller) { permissionTree.value = result; permissionTreeReady.value = true; }
  } catch (error) {
    if (current(stamp) && sequence === treeSequence && treeAbort === controller) { permissionTree.value = []; permissionTreeError.value = message(error, '权限目录读取失败，暂不能编辑角色'); }
  } finally { if (treeAbort === controller) { treeAbort = null; permissionTreeLoading.value = false; } }
}
function openAdminForm(row?: AdminAccount) {
  if (!current(generation) || !canManage.value || writeBlocked.value || !adminReady.value || row && (!adminList.value.includes(row) || row.level === 0 && auth.userInfo?.level !== 0)) return;
  cancelPreview();
  Object.assign(adminDialog, row ? { id: row.id, account: row.account, real_name: row.realName, phone: row.phone, roles: row.roles, level: row.level, status: row.status }
    : { id: 0, account: '', real_name: '', phone: '', roles: '', level: 1, status: 1 });
  adminDialog.pwd = ''; adminDialog.show = true; writeError.value = '';
}
async function openRoleForm(row?: RoleItem) {
  if (!current(generation) || !canManage.value || writeBlocked.value || !roleReady.value || !permissionTreeReady.value || row && !roleList.value.includes(row)) return;
  cancelPreview();
  const known = new Set(permissionTree.value.flatMap(node => node.children.map(child => child.key)));
  const rawRules = row?.rules.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  Object.assign(roleDialog, { id: row?.id ?? 0, role_name: row?.roleName ?? '', level: row?.level ?? 0, originalLevel: row?.level ?? null, changeLegacyLevel: false, status: row?.status ?? 1, permissionKeys: [...(row?.permissionKeys ?? [])],
    permissionError: rawRules.some(key => !known.has(key)) ? '此角色含旧格式或未登记的权限规则，请先核对权限映射；当前仅可查看。' : '' });
  const stamp = generation; roleDialog.show = true; writeError.value = '';
  await nextTick(); if (current(stamp) && roleDialog.show) permissionTreeRef.value?.setCheckedKeys(roleDialog.permissionKeys);
}
async function saveAdmin() {
  if (!current(generation) || !canManage.value || writeBlocked.value || !adminReady.value || !adminDialog.show) return;
  if (!adminDialog.account.trim()) return ElMessage.warning('请输入管理员账号');
  if ((!adminDialog.id || adminDialog.pwd) && adminDialog.pwd.length < 12) return ElMessage.warning('管理员密码至少 12 位');
  if ([...adminDialog.roles].length > 128 || adminDialog.roles.split(',').map(value => value.trim()).filter(Boolean)
    .some(value => !/^[1-9]\d*$/u.test(value) || value.length > 10 || Number(value) > 2147483647)) return ElMessage.warning('角色 ID 应为正 int32，完整数据最多 128 字符');
  await prepareOperation('admin-save', adminPayload());
}
async function saveRole() {
  if (!current(generation) || !canManage.value || writeBlocked.value || !roleReady.value || !roleDialog.show || !permissionTreeReady.value || roleDialog.permissionError || !permissionTreeRef.value) return;
  if (!roleDialog.role_name.trim()) return ElMessage.warning('请输入角色名称');
  if ((!roleDialog.id || roleDialog.level !== roleDialog.originalLevel) && (!Number.isInteger(roleDialog.level) || roleDialog.level < 0 || roleDialog.level > 9)) return ElMessage.warning('新设角色等级应为 0 至 9');
  const keys = permissionTreeRef.value.getCheckedKeys(true), known = new Set(permissionTree.value.flatMap(node => node.children.map(child => child.key)));
  if (keys.some(key => typeof key !== 'string' || !known.has(key))) return ElMessage.warning('请选择有效权限规则');
  await prepareOperation('role-save', rolePayload());
}
async function delRole(row: RoleItem) {
  if (!current(generation) || !canManage.value || writeBlocked.value || !roleReady.value || !roleList.value.includes(row) || ownRole(row.id)) return;
  await prepareOperation('role-delete', { id: row.id });
}
function syncSession() {
  syncing = true; clear();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem('admin_session'); sessionVersion.value++; syncing = false;
  restorePending();
  if (alive && canView.value) { void loadAdmin(); void loadRoles(); if (canManage.value) void loadPermissionTree(); }
}
function syncStorage(event: StorageEvent) {
  if (event.storageArea !== localStorage) return;
  if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession();
  else if (event.key === pendingStorageKey(loggedOwner())) { cancelPreview(); restorePending(); }
}
watch(identity, () => {
  if (!alive || syncing) return;
  // Reactive permission changes are authoritative; never restore old grants from storage.
  clear(); sessionVersion.value++;
  restorePending();
  if (canView.value) { void loadAdmin(); void loadRoles(); if (canManage.value) void loadPermissionTree(); }
}, { flush: 'sync' });
watch(() => JSON.stringify([adminPayload(), roleDialog.id, roleDialog.role_name, roleDialog.level, roleDialog.status, roleDialog.permissionKeys]), () => {
  if (operationPreview.value || previewRequest || busy.value && !pendingOperation.value) cancelPreview();
}, { flush: 'sync' });
watch(() => JSON.stringify([adminList.value, roleList.value]), () => {
  if (operationPreview.value) cancelPreview();
}, { flush: 'sync' });
onMounted(() => {
  alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession();
});
onBeforeUnmount(() => {
  alive = false; clear(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage);
});
</script>

<style scoped>
.notice { margin-bottom: 16px; }
.page-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.page-head h3 { font-size: 16px; margin: 0; }
.filters .el-input { width: 220px; max-width: 100%; }
.filters .el-select { width: 140px; }
.rule-tag { margin: 2px 4px 2px 0; }
.pager { margin-top: 16px; max-width: 100%; overflow-x: auto; }
.hint { color: var(--el-text-color-secondary); }
.permission-tree { width: 100%; max-height: 360px; overflow: auto; border: 1px solid var(--el-border-color-light); border-radius: 6px; padding: 8px 12px; }
.recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.change-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.change-comparison section { min-width: 0; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; }
.change-comparison h4 { margin-top: 0; }
.change-comparison dl { display: grid; grid-template-columns: 85px minmax(0, 1fr); gap: 8px; }
.change-comparison dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.confirm-check { margin-top: 16px; height: auto; white-space: normal; }
.confirm-check :deep(.el-checkbox__label) { white-space: normal; }
@media (max-width: 600px) { .change-comparison { grid-template-columns: 1fr; } }
@media (max-width: 600px) { .filters :deep(.el-form-item) { display: flex; margin-right: 0; } .filters :deep(.el-form-item__content) { min-width: 0; flex-wrap: wrap; gap: 8px; } }
</style>
