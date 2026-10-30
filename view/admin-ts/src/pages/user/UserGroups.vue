<template>
 <div class="user-groups">
  <el-card shadow="never" v-for="screen in screens" :key="screen.key">
   <template #header><div class="card-header"><div><strong>商城用户分组</strong><p class="sub">维护商城会员分组；已关联用户的分组不能删除。</p></div><el-button v-if="canManage" type="primary" :disabled="!model.writable() || !!state.editor || (state.snapshot?.count ?? 0) >= 20000" @click="screen.create">新增分组</el-button></div></template>
   <el-alert v-if="state.pending" title="原分组操作结果尚未确认，新的提交已暂停" type="warning" :closable="false" class="notice"><p>未找到回执仍表示结果未知。请读取原回执，或主动核对并封存原请求。</p><div class="actions"><el-button :disabled="state.busy" @click="screen.receipt">读取原回执</el-button><el-button :disabled="state.busy" @click="screen.resolve">核对并封存原请求</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy" @click="screen.retry">原样重试</el-button></div></el-alert>
   <el-alert v-if="!canView" title="当前账号没有用户查看权限" type="warning" :closable="false" />
   <el-alert v-if="state.error || state.pendingError" :title="state.error || state.pendingError" type="error" :closable="false" class="notice" />
   <el-alert v-if="state.notice" :title="state.notice" type="success" :closable="false" class="notice" />
   <template v-if="canView">
    <el-alert v-if="!canManage" title="当前账号仅有查看权限；如需维护分组，请联系管理员开通用户管理权限。" type="info" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.write_ready" title="此环境尚未安装分组安全写入能力，目录可查看" type="warning" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && state.snapshot.count >= 20000" title="分组目录已达容量上限，暂不能新增；已有分组仍可维护" type="warning" :closable="false" class="notice" />
    <div class="filters"><label>分组名称<input :value="state.filters.draft" aria-label="分组名称" placeholder="搜索分组名称" :disabled="model.viewLocked()" @input="screen.keyword(($event.target as HTMLInputElement).value)" @keyup.enter="screen.search" /></label><el-button type="primary" :disabled="model.viewLocked()" @click="screen.search">查询</el-button><el-button :disabled="model.viewLocked()" @click="screen.reset">重置</el-button><el-button :disabled="state.busy" @click="screen.refresh">刷新</el-button></div>
    <p v-if="state.loading" role="status">正在读取用户分组…</p>
    <div v-if="state.snapshot && !state.loading" class="table-scroll"><table aria-label="商城用户分组列表"><thead><tr><th>ID</th><th>分组名称</th><th v-if="canManage">操作</th></tr></thead><tbody><tr v-for="item in rows" :key="item.key" class="group-row"><td>{{ item.row.id }}</td><td class="group-name">{{ item.row.group_name || '空名称历史分组' }}</td><td v-if="canManage"><div class="actions"><el-button link type="primary" :disabled="!model.writable() || !!state.editor" @click="item.edit">编辑</el-button><el-button link type="danger" :disabled="!model.writable() || !!state.editor" @click="item.remove">删除</el-button></div></td></tr></tbody></table><p v-if="!visible.length" class="empty">暂无用户分组</p></div>
    <nav class="pager actions" aria-label="用户分组分页"><span>共 {{ visible.length }} 项，第 {{ state.filters.page }} / {{ pageCount }} 页</span><el-button :disabled="model.viewLocked() || state.filters.page <= 1" @click="screen.previous">上一页</el-button><el-button :disabled="model.viewLocked() || state.filters.page >= pageCount" @click="screen.next">下一页</el-button></nav>
   </template>
  </el-card>
  <el-dialog v-for="editor in editors" :key="editor.key" class="group-author-dialog" top="16px" :model-value="true" :title="state.editor?.row ? '编辑分组' : '新增分组'" width="min(440px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false" :destroy-on-close="true">
   <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" class="notice" />
   <label class="name-field">分组名称<input aria-label="编辑分组名称" :value="editor.value" :disabled="!model.writable()" autofocus @input="editor.set(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><p class="sub" aria-label="分组名称字符数">{{ editor.count }} / 64 个字符</p>
   <template #footer><el-button :disabled="state.busy" @click="editor.cancel">取消</el-button><el-button type="primary" :disabled="!model.writable()" @click="editor.submit">保存</el-button></template>
  </el-dialog>
  <el-dialog v-for="confirmation in confirmations" :key="confirmation.key" class="group-author-dialog" top="16px" :model-value="true" title="确认分组操作" width="min(440px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false">
   <p>{{ operationLabels[confirmation.operation] }}<span v-if="confirmation.id"> #{{ confirmation.id }}</span></p><p v-if="confirmation.operation !== 'delete'" class="group-name">{{ confirmation.payload.group_name }}</p><p v-else>已关联用户的分组不能删除。删除后不会改变用户资料或其它分组。</p>
   <template #footer><el-button :disabled="state.busy" @click="confirmation.cancel">取消操作</el-button><el-button type="primary" :disabled="state.busy" @click="confirmation.confirm">确认提交</el-button></template>
  </el-dialog>
 </div>
</template>
<script setup lang="ts">
import { computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiGroupAuthorCatalog, apiGroupAuthorCommit, apiGroupAuthorReceipt, apiGroupAuthorResolve } from '@/api/groupAuthor';
import { groupAuthorState } from '@/utils/groupAuthorState';
import type { GroupAction, GroupOperation } from '../../../../common/groupAuthor';
const auth = useAuthStore(), route = useRoute();
let alive = false, generation = 0, syncing = false, queued = false;
const allowed = (values: string[]) => auth.uniqueAuth.some(p => p === '*' || p === 'user.*' || values.includes(p));
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || allowed(['user.view', 'user.manage'])));
const canManage = computed(() => canView.value && (auth.userInfo?.level === 0 || allowed(['user.manage'])));
const prefix = (actor: number) => `cinashop_group_pending_v1_${actor}_`;
function keys(actor: number) { const result: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix(actor))) result.push(key); } return result.sort(); }
const model = groupAuthorState({ identity: () => `${generation}:${auth.token}:${auth.userInfo?.id}`, actor: () => auth.userInfo?.id ?? 0,
 view: () => canView.value, manage: () => canManage.value, read: apiGroupAuthorCatalog, write: apiGroupAuthorCommit, receipt: apiGroupAuthorReceipt, resolve: apiGroupAuthorResolve,
 readPending: actor => { const key = keys(actor)[0]; if (!key) return null; const raw = localStorage.getItem(key); if (!raw || raw.length > 512 * 1024) throw Error('原分组操作记录异常，请保留核对'); const a = JSON.parse(raw); if (key !== prefix(actor) + a?.operation_id) throw Error('原分组操作标识不一致'); return a; },
 persist: (actor: number, a: GroupAction | null, expected?: GroupAction) => {
  const value = a ?? expected; if (!value) throw Error('缺少原分组操作'); const key = prefix(actor) + value.operation_id, raw = localStorage.getItem(key);
  if (a) { const text = JSON.stringify(a); if (text.length > 512 * 1024 || keys(actor).some(k => k !== key) || raw && raw !== text) throw Error('本账号已有其它未确认分组操作'); localStorage.setItem(key, text); }
  else { if (raw && raw !== JSON.stringify(expected)) throw Error('原分组操作记录已变化，无法清除'); localStorage.removeItem(key); }
 },
}, v => reactive(v) as typeof v);
const state = model.state, screens = computed(() => [model.screen()]), editors = computed(() => model.editorControls()), confirmations = computed(() => model.confirmationControls());
const visible = computed(() => model.visible()), pageCount = computed(() => model.pageCount());
const rows = computed(() => visible.value.slice((state.filters.page - 1) * 10, state.filters.page * 10).map(model.rowControls));
const operationLabels: Record<GroupOperation, string> = { create: '新增分组', update: '保存分组', delete: '删除分组' };
function schedule() {
 if (!alive || syncing) return; generation++; model.dispose(); if (queued) return; queued = true;
 queueMicrotask(() => { queued = false; if (alive) void model.activate(); });
}
function syncStored(event?: Event) {
 if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key) && !event.key.startsWith('cinashop_group_pending_v1_')) return;
 syncing = true; generation++; model.dispose(); const session = getAdminSession();
 auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); syncing = false; schedule();
}
watch(() => [auth.token, auth.userInfo, auth.uniqueAuth, auth.menus], schedule, { deep: true, flush: 'sync' });
watch(() => route.fullPath, schedule, { flush: 'sync' });
const stopAction = auth.$onAction(({ name, after }) => { if (name === 'login' || name === 'logout') after(schedule); });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; generation++; stopAction(); model.dispose(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>
<style scoped>
.user-groups{min-width:0}.card-header,.filters,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.card-header{justify-content:space-between}.sub{margin:4px 0 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.7}.filters{margin:16px 0;align-items:flex-end}.filters label,.name-field{display:grid;gap:8px;min-width:0}.filters label{width:min(280px,100%)}input{box-sizing:border-box;width:100%;max-width:100%;min-width:0;font:inherit;padding:9px 12px;border:1px solid var(--el-border-color);border-radius:4px;background:var(--el-bg-color);color:var(--el-text-color-primary)}input:focus{outline:2px solid var(--el-color-primary);outline-offset:1px}.notice{margin:12px 0}.table-scroll{max-width:100%;overflow-x:auto}table{width:100%;min-width:800px;border-collapse:collapse;text-align:left}th:nth-child(2){min-width:600px}th,td{padding:12px;border-bottom:1px solid var(--el-border-color-lighter)}th{background:var(--el-fill-color-light)}.group-name{overflow-wrap:anywhere;white-space:pre-wrap}.group-row td:first-child{width:70px}.group-row td:last-child{min-width:110px}.pager{margin-top:16px;justify-content:flex-end;font-size:13px}.empty{padding:20px;color:var(--el-text-color-secondary)}.actions :deep(.el-button+.el-button){margin-left:0}.user-groups :deep(.el-overlay-dialog){overflow:clip}.user-groups :deep(.group-author-dialog){max-height:calc(100dvh - 32px);display:flex;flex-direction:column}.user-groups :deep(.group-author-dialog .el-dialog__body){min-height:0;overflow:auto}.user-groups :deep(.group-author-dialog .el-dialog__header),.user-groups :deep(.group-author-dialog .el-dialog__footer){flex-shrink:0}.user-groups :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}@media(max-width:600px){.filters label{width:100%}.pager{justify-content:flex-start}th,td{padding:10px 8px}.card-header>.el-button{margin-left:auto}}
</style>
