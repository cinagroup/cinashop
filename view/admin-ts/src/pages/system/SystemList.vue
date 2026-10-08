<template>
  <el-config-provider :locale="zhCn">
  <div class="system-page">
    <el-alert v-if="!canView" title="当前账号没有管理员与角色查看权限" type="warning" show-icon :closable="false" />
    <template v-else>
      <el-alert v-if="!canManage" title="当前账号仅可查看管理员与角色" type="info" show-icon :closable="false" class="notice" />
      <el-alert v-if="writeError" :title="writeError" type="error" show-icon :closable="false" class="notice" />
      <el-tabs v-model="activeTab">
        <el-tab-pane label="管理员" name="admin">
          <div class="page-head"><h3>系统管理员</h3><el-button v-if="canManage" type="primary" :disabled="busy || !adminReady" @click="openAdminForm()">＋ 新增管理员</el-button></div>
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
            <el-table-column v-if="canManage" label="操作" width="80"><template #default="{ row }"><el-button link type="primary" :disabled="busy || !adminReady || (row.level === 0 && auth.userInfo?.level !== 0)" @click="openAdminForm(row)">编辑</el-button></template></el-table-column>
          </el-table>
          <el-pagination class="pager" layout="total, prev, pager, next" :total="adminTotal" :page-count="Math.min(500, Math.ceil(adminTotal / adminQuery.limit))" :page-size="adminQuery.limit" :current-page="adminQuery.page" :disabled="adminLoading || busy" @current-change="loadAdmin" />
          <p v-if="adminTotal > 10000" class="hint">最多浏览前 10000 条匹配结果，请缩小关键词或状态范围。</p>
        </el-tab-pane>
        <el-tab-pane label="角色权限" name="role">
          <div class="page-head"><h3>角色管理</h3><el-button v-if="canManage" type="primary" :disabled="busy || !roleReady || !permissionTreeReady" @click="openRoleForm()">＋ 新增角色</el-button></div>
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
            <el-table-column v-if="canManage" label="操作" width="140"><template #default="{ row }"><el-button link type="primary" :disabled="busy || !roleReady || !permissionTreeReady" @click="openRoleForm(row)">编辑</el-button><el-button link type="danger" :disabled="busy || !roleReady || ownRole(row.id)" @click="delRole(row)">删除</el-button></template></el-table-column>
          </el-table>
          <el-pagination class="pager" layout="total, prev, pager, next" :total="roleTotal" :page-count="Math.min(500, Math.ceil(roleTotal / roleQuery.limit))" :page-size="roleQuery.limit" :current-page="roleQuery.page" :disabled="roleLoading || busy" @current-change="loadRoles" />
          <p v-if="roleTotal > 10000" class="hint">最多浏览前 10000 条匹配结果，请缩小关键词或状态范围。</p>
        </el-tab-pane>
      </el-tabs>
    </template>
    <el-dialog v-model="adminDialog.show" :title="adminDialog.id ? '编辑管理员' : '新增管理员'" width="min(480px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @closed="adminDialog.pwd = ''">
      <el-form label-width="80px" :disabled="busy || !canManage || !adminReady">
        <el-form-item label="账号"><el-input v-model="adminDialog.account" :disabled="!!adminDialog.id" placeholder="登录账号" /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="adminDialog.real_name" placeholder="真实姓名" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="adminDialog.phone" placeholder="手机号" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="adminDialog.pwd" type="password" show-password autocomplete="new-password" :placeholder="adminDialog.id ? '不修改留空；修改至少 12 位' : '至少 12 位'" /></el-form-item>
        <el-form-item label="角色 ID"><el-input v-model="adminDialog.roles" placeholder="角色 ID，逗号分隔" /></el-form-item>
        <el-form-item label="等级"><el-input-number v-model="adminDialog.level" :min="auth.userInfo?.level === 0 ? 0 : 1" :max="9" :precision="0" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="adminDialog.show = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!canManage || !adminReady" @click="saveAdmin">保存</el-button></template>
    </el-dialog>
    <el-dialog v-model="roleDialog.show" :title="roleDialog.id ? '编辑角色' : '新增角色'" width="min(620px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy">
      <el-alert v-if="roleDialog.permissionError" :title="roleDialog.permissionError" type="warning" :closable="false" class="notice" />
      <el-form label-width="80px" :disabled="busy || !canManage || !roleReady || !permissionTreeReady || !!roleDialog.permissionError">
        <el-form-item label="角色名称"><el-input v-model="roleDialog.role_name" placeholder="角色名称" /></el-form-item>
        <el-form-item label="等级"><el-input-number v-model="roleDialog.level" :min="0" :max="9" :precision="0" /></el-form-item>
        <el-form-item label="菜单权限"><el-tree ref="permissionTreeRef" class="permission-tree" :data="permissionTree" node-key="key" show-checkbox default-expand-all :props="{ label: 'label', children: 'children' }" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="busy" @click="roleDialog.show = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="!canManage || !roleReady || !permissionTreeReady || !!roleDialog.permissionError" @click="saveRole">保存</el-button></template>
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
import { apiAdminSystemAdminDirectory, apiAdminSystemRoleDirectory, apiAdminSystemAdminSave, apiAdminSystemRoleSave,
  apiAdminSystemRoleDel, apiAdminPermissionTree, type AdminAccount, type RoleItem, type PermissionTreeNode, type SystemDirectoryQuery } from '@/api/system';

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
const adminDialog = reactive({ show: false, id: 0, account: '', real_name: '', phone: '', pwd: '', roles: '', level: 1 });
const roleDialog = reactive({ show: false, id: 0, role_name: '', level: 0, permissionKeys: [] as string[], permissionError: '' });
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

function clear() {
  generation++; adminSequence++; roleSequence++; treeSequence++;
  for (const controller of [adminAbort, roleAbort, treeAbort, writeAbort]) controller?.abort();
  adminAbort = roleAbort = treeAbort = writeAbort = null;
  adminList.value = []; roleList.value = []; permissionTree.value = [];
  adminTotal.value = roleTotal.value = 0;
  adminLoading.value = roleLoading.value = permissionTreeLoading.value = busy.value = false;
  adminReady.value = roleReady.value = permissionTreeReady.value = false;
  adminError.value = roleError.value = permissionTreeError.value = writeError.value = '';
  Object.assign(adminQuery, { keyword: '', status: '', page: 1, limit: 20 }); Object.assign(roleQuery, { keyword: '', status: '', page: 1, limit: 20 });
  Object.assign(adminDialog, { show: false, id: 0, account: '', real_name: '', phone: '', pwd: '', roles: '', level: 1 });
  Object.assign(roleDialog, { show: false, id: 0, role_name: '', level: 0, permissionKeys: [], permissionError: '' });
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
  Object.assign(roleDialog, { show: false, id: 0, role_name: '', level: 0, permissionKeys: [], permissionError: '' });
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
  if (!current(generation) || !canManage.value || busy.value || !adminReady.value || row && (!adminList.value.includes(row) || row.level === 0 && auth.userInfo?.level !== 0)) return;
  Object.assign(adminDialog, row ? { id: row.id, account: row.account, real_name: row.realName, phone: row.phone, roles: row.roles, level: row.level }
    : { id: 0, account: '', real_name: '', phone: '', roles: '', level: 1 });
  adminDialog.pwd = ''; adminDialog.show = true; writeError.value = '';
}
async function openRoleForm(row?: RoleItem) {
  if (!current(generation) || !canManage.value || busy.value || !roleReady.value || !permissionTreeReady.value || row && !roleList.value.includes(row)) return;
  const known = new Set(permissionTree.value.flatMap(node => node.children.map(child => child.key)));
  const rawRules = row?.rules.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  Object.assign(roleDialog, { id: row?.id ?? 0, role_name: row?.roleName ?? '', level: row?.level ?? 0, permissionKeys: [...(row?.permissionKeys ?? [])],
    permissionError: rawRules.some(key => !known.has(key)) ? '此角色含旧格式或未登记的权限规则，请先核对权限映射；当前仅可查看。' : '' });
  const stamp = generation; roleDialog.show = true; writeError.value = '';
  await nextTick(); if (current(stamp) && roleDialog.show) permissionTreeRef.value?.setCheckedKeys(roleDialog.permissionKeys);
}
async function saveAdmin() {
  if (!current(generation) || !canManage.value || busy.value || !adminReady.value || !adminDialog.show) return;
  if (!adminDialog.account.trim()) return ElMessage.warning('请输入管理员账号');
  if ((!adminDialog.id || adminDialog.pwd) && adminDialog.pwd.length < 12) return ElMessage.warning('管理员密码至少 12 位');
  if (adminDialog.roles.split(',').map(value => value.trim()).filter(Boolean).some(value => !/^[1-9]\d*$/u.test(value))) return ElMessage.warning('角色 ID 应为正整数，使用逗号分隔');
  const stamp = generation, controller = new AbortController(); writeAbort = controller; busy.value = true; writeError.value = '';
  const input = { id: adminDialog.id || undefined, account: adminDialog.account, real_name: adminDialog.real_name, phone: adminDialog.phone,
    pwd: adminDialog.pwd || undefined, roles: adminDialog.roles, level: adminDialog.level };
  try {
    await apiAdminSystemAdminSave(input, controller.signal);
    if (!current(stamp) || !canManage.value) return;
    adminDialog.show = false; adminDialog.pwd = ''; ElMessage.success(input.id ? '更新成功' : '创建成功'); await loadAdmin();
  } catch (error) { if (current(stamp)) { adminReady.value = false; writeError.value = message(error, '保存失败，请先刷新目录核对结果'); ElMessage.error(writeError.value); } }
  finally { if (writeAbort === controller) { writeAbort = null; busy.value = false; } }
}
async function saveRole() {
  if (!current(generation) || !canManage.value || busy.value || !roleReady.value || !roleDialog.show || !permissionTreeReady.value || roleDialog.permissionError || !permissionTreeRef.value) return;
  if (!roleDialog.role_name.trim()) return ElMessage.warning('请输入角色名称');
  const keys = permissionTreeRef.value.getCheckedKeys(true), known = new Set(permissionTree.value.flatMap(node => node.children.map(child => child.key)));
  if (keys.some(key => typeof key !== 'string' || !known.has(key))) return ElMessage.warning('请选择有效权限规则');
  const stamp = generation, controller = new AbortController(); writeAbort = controller; busy.value = true; writeError.value = '';
  const input = { id: roleDialog.id || undefined, role_name: roleDialog.role_name, level: roleDialog.level, rules: [...new Set(keys as string[])].join(',') };
  try {
    await apiAdminSystemRoleSave(input, controller.signal);
    if (!current(stamp) || !canManage.value) return;
    roleDialog.show = false; ElMessage.success(input.id ? '更新成功' : '创建成功'); await loadRoles();
  } catch (error) { if (current(stamp)) { roleReady.value = false; writeError.value = message(error, '保存失败，请先刷新目录核对结果'); ElMessage.error(writeError.value); } }
  finally { if (writeAbort === controller) { writeAbort = null; busy.value = false; } }
}
async function delRole(row: RoleItem) {
  if (!current(generation) || !canManage.value || busy.value || !roleReady.value || !roleList.value.includes(row) || ownRole(row.id)) return;
  const stamp = generation; busy.value = true;
  try {
    try { await ElMessageBox.confirm(`确认删除角色「${row.roleName}」？`, '删除角色', { type: 'warning' }); } catch { return; }
    if (!current(stamp) || !canManage.value || !roleReady.value || !roleList.value.includes(row) || ownRole(row.id)) return;
    const controller = new AbortController(); writeAbort = controller; writeError.value = '';
    try { await apiAdminSystemRoleDel(row.id, controller.signal); if (current(stamp) && canManage.value) { ElMessage.success('已删除'); await loadRoles(); } }
    catch (error) { if (current(stamp)) { roleReady.value = false; writeError.value = message(error, '删除失败，请先刷新目录核对结果'); ElMessage.error(writeError.value); } }
    finally { if (writeAbort === controller) writeAbort = null; }
  } finally { if (current(stamp)) busy.value = false; }
}
function syncSession() {
  syncing = true; clear();
  const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem('admin_session'); sessionVersion.value++; syncing = false;
  if (alive && canView.value) { void loadAdmin(); void loadRoles(); if (canManage.value) void loadPermissionTree(); }
}
function syncStorage(event: StorageEvent) { if (event.storageArea === localStorage && (event.key === null || event.key === 'admin_token' || event.key === 'admin_session')) syncSession(); }
watch(identity, () => {
  if (!alive || syncing) return;
  // Reactive permission changes are authoritative; never restore old grants from storage.
  clear(); sessionVersion.value++;
  if (canView.value) { void loadAdmin(); void loadRoles(); if (canManage.value) void loadPermissionTree(); }
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
@media (max-width: 600px) { .filters :deep(.el-form-item) { display: flex; margin-right: 0; } .filters :deep(.el-form-item__content) { min-width: 0; flex-wrap: wrap; gap: 8px; } }
</style>
