<template>
 <div v-if="props.active" class="unit-author">
  <el-card shadow="never" v-for="screen in screens" :key="screen.key">
   <template #header><div class="card-header"><div><strong>商品单位</strong><p class="sub">维护平台商品单位的名称与排序；已被商品使用的单位不能改名或删除。</p></div><el-button v-if="canManage" type="primary" :disabled="!model.writable() || !!state.editor || !state.snapshot?.can_create" @click="screen.create">新增单位</el-button></div></template>
   <el-alert v-if="state.pending" title="原单位操作结果尚未确认，新的提交已暂停" type="warning" :closable="false" class="notice"><p>未找到回执仍表示结果未知。请读取原回执，或主动核对并封存原请求。</p><div class="actions"><el-button :disabled="state.busy" @click="screen.receipt">读取原回执</el-button><el-button :disabled="state.busy" @click="screen.resolve">核对并封存原请求</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy" @click="screen.retry">原样重试</el-button></div></el-alert>
   <el-alert v-if="!canView" title="当前账号没有商品查看权限" type="warning" :closable="false" />
   <el-alert v-if="state.error || state.pendingError" :title="state.error || state.pendingError" type="error" :closable="false" class="notice" />
   <el-alert v-if="state.notice" :title="state.notice" type="success" :closable="false" class="notice" />
   <template v-if="canView">
    <el-alert v-if="!canManage" title="当前账号仅有查看权限；如需维护单位，请联系管理员开通商品管理权限。" type="info" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.write_ready" title="此环境尚未安装单位安全写入能力，目录可查看" type="warning" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.can_create" title="单位目录已达容量上限，暂不能新增；已有单位仍可维护" type="warning" :closable="false" class="notice" />
    <div class="filters"><label>单位名称<input :value="state.filters.draft" aria-label="单位名称" placeholder="搜索单位名称" :disabled="model.viewLocked()" @input="screen.keyword(($event.target as HTMLInputElement).value)" @keyup.enter="screen.search" /></label><el-button type="primary" :disabled="model.viewLocked()" @click="screen.search">查询</el-button><el-button :disabled="model.viewLocked()" @click="screen.reset">重置</el-button><el-button :disabled="state.busy" @click="screen.refresh">刷新</el-button></div>
    <p v-if="state.loading" role="status">正在读取商品单位…</p>
    <div v-if="state.snapshot && !state.loading" class="table-scroll"><table aria-label="商品单位列表"><thead><tr><th>ID</th><th>单位名称</th><th>排序</th><th>状态</th><th v-if="canManage">操作</th></tr></thead><tbody><tr v-for="item in rows" :key="item.key" class="unit-row"><td>{{ item.row.id }}</td><td class="unit-name">{{ item.row.name || '空名称历史单位' }}</td><td>{{ item.row.sort }}</td><td>启用</td><td v-if="canManage"><div class="actions"><el-button link type="primary" :disabled="!model.writable() || !!state.editor" @click="item.edit">编辑</el-button><el-button link type="danger" :disabled="!model.writable() || !!state.editor" @click="item.remove">删除</el-button></div></td></tr></tbody></table><p v-if="!visible.length" class="empty">暂无商品单位</p></div>
    <nav class="pager actions" aria-label="商品单位分页"><span>共 {{ visible.length }} 项，第 {{ state.filters.page }} / {{ pageCount }} 页</span><el-button :disabled="model.viewLocked() || state.filters.page <= 1" @click="screen.previous">上一页</el-button><el-button :disabled="model.viewLocked() || state.filters.page >= pageCount" @click="screen.next">下一页</el-button></nav>
   </template>
  </el-card>
  <el-dialog v-for="editor in editors" :key="editor.key" class="unit-author-dialog" top="16px" :model-value="true" :title="state.editor?.row ? '编辑单位' : '新增单位'" width="min(440px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false" :destroy-on-close="true">
   <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" class="notice" />
   <label class="name-field">单位名称<input aria-label="编辑单位名称" :value="editor.value" :disabled="!model.writable()" autofocus @input="editor.set(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><p class="sub" aria-label="单位名称字符数">{{ editor.count }} / 15 个字符</p><p v-if="state.editor?.row" class="sub">历史名称可原样保留；修改后的名称最多15个字符。</p><label class="name-field sort-field">排序<input aria-label="编辑单位排序" inputmode="numeric" :value="editor.rawSort" :disabled="!model.writable()" @input="editor.sort(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><p class="sub">新排序请输入0至32767的整数；未修改的历史值可保留。</p>
   <template #footer><el-button :disabled="state.busy" @click="editor.cancel">取消</el-button><el-button type="primary" :disabled="!model.writable()" @click="editor.submit">保存</el-button></template>
  </el-dialog>
  <el-dialog v-for="confirmation in confirmations" :key="confirmation.key" class="unit-author-dialog" top="16px" :model-value="true" title="确认单位操作" width="min(440px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false">
   <p>{{ operationLabels[confirmation.operation] }}<span v-if="confirmation.id"> #{{ confirmation.id }}</span></p><p v-if="confirmation.operation !== 'delete'" class="unit-name">{{ confirmation.payload.name }} · 排序 {{ confirmation.payload.sort }}</p><p v-else>已被商品使用的单位不能改名或删除。删除只将该单位移入回收状态，不改写现有商品。</p>
   <template #footer><el-button :disabled="state.busy" @click="confirmation.cancel">取消操作</el-button><el-button type="primary" :disabled="state.busy" @click="confirmation.confirm">确认提交</el-button></template>
  </el-dialog>
 </div>
</template>
<script setup lang="ts">
import { computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiUnitAuthorCatalog, apiUnitAuthorCommit, apiUnitAuthorReceipt, apiUnitAuthorResolve } from '@/api/unitAuthor';
import { unitAuthorState } from '@/utils/unitAuthorState';
import type { UnitAction, UnitOperation } from '../../../../common/unitAuthor';
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const emit = defineEmits<{ changed: [] }>();
const auth = useAuthStore(), route = useRoute();
let alive = false, generation = 0, syncing = false, queued = false;
const allowed = (values: string[]) => auth.uniqueAuth.some(p => p === '*' || p === 'product.*' || values.includes(p));
const canView = computed(() => props.active && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || allowed(['product.view', 'product.manage'])));
const canManage = computed(() => canView.value && (auth.userInfo?.level === 0 || allowed(['product.manage'])));
const prefix = (actor: number) => `cinashop_unit_pending_v1_${actor}_`;
function keys(actor: number) { const result: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix(actor))) result.push(key); } return result.sort(); }
const model = unitAuthorState({ identity: () => `${generation}:${auth.token}:${auth.userInfo?.id}`, actor: () => auth.userInfo?.id ?? 0,
 view: () => canView.value, manage: () => canManage.value, read: apiUnitAuthorCatalog, write: apiUnitAuthorCommit, receipt: apiUnitAuthorReceipt, resolve: apiUnitAuthorResolve, changed: () => emit('changed'),
 readPending: actor => { const key = keys(actor)[0]; if (!key) return null; const raw = localStorage.getItem(key); if (!raw || raw.length > 512 * 1024) throw Error('原单位操作记录异常，请保留核对'); const a = JSON.parse(raw); if (key !== prefix(actor) + a?.operation_id) throw Error('原单位操作标识不一致'); return a; },
 persist: (actor: number, a: UnitAction | null, expected?: UnitAction) => {
  const value = a ?? expected; if (!value) throw Error('缺少原单位操作'); const key = prefix(actor) + value.operation_id, raw = localStorage.getItem(key);
  if (a) { const text = JSON.stringify(a); if (text.length > 512 * 1024 || keys(actor).some(k => k !== key) || raw && raw !== text) throw Error('本账号已有其它未确认单位操作'); localStorage.setItem(key, text); }
  else { if (raw && raw !== JSON.stringify(expected)) throw Error('原单位操作记录已变化，无法清除'); localStorage.removeItem(key); }
 },
}, v => reactive(v) as typeof v);
const state = model.state, screens = computed(() => [model.screen()]), editors = computed(() => model.editorControls()), confirmations = computed(() => model.confirmationControls());
const visible = computed(() => model.visible()), pageCount = computed(() => model.pageCount());
const rows = computed(() => visible.value.slice((state.filters.page - 1) * 15, state.filters.page * 15).map(model.rowControls));
const operationLabels: Record<UnitOperation, string> = { create: '新增单位', update: '保存单位', delete: '删除单位' };
function schedule() {
 if (!alive || syncing) return; generation++; model.dispose(); if (queued) return; queued = true;
 queueMicrotask(() => { queued = false; if (alive && props.active) void model.activate(); });
}
function syncStored(event?: Event) {
 if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key) && !event.key.startsWith('cinashop_unit_pending_v1_')) return;
 syncing = true; generation++; model.dispose(); const session = getAdminSession();
 auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); syncing = false; schedule();
}
watch(() => [auth.token, auth.userInfo, auth.uniqueAuth, auth.menus], schedule, { deep: true, flush: 'sync' });
watch(() => route.fullPath, schedule, { flush: 'sync' });
watch(() => props.active, schedule, { flush: 'sync' });
const stopAction = auth.$onAction(({ name, after }) => { if (name === 'login' || name === 'logout') after(schedule); });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; generation++; stopAction(); model.dispose(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>
<style scoped>
.unit-author{min-width:0}.card-header,.filters,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.card-header{justify-content:space-between}.sub{margin:4px 0 0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.7}.filters{margin:16px 0;align-items:flex-end}.filters label,.name-field{display:grid;gap:8px;min-width:0}.filters label{width:min(280px,100%)}input{box-sizing:border-box;width:100%;max-width:100%;min-width:0;font:inherit;padding:9px 12px;border:1px solid var(--el-border-color);border-radius:4px;background:var(--el-bg-color);color:var(--el-text-color-primary)}input:focus{outline:2px solid var(--el-color-primary);outline-offset:1px}.notice{margin:12px 0}.table-scroll{max-width:100%;overflow-x:auto}table{width:100%;min-width:540px;border-collapse:collapse;text-align:left}th:nth-child(2),th:nth-child(3){min-width:100px}th:nth-child(4),td:nth-child(4){white-space:nowrap}th,td{padding:12px;border-bottom:1px solid var(--el-border-color-lighter)}th{background:var(--el-fill-color-light)}.unit-name{overflow-wrap:anywhere;white-space:pre-wrap}.unit-row td:first-child{width:60px}.unit-row td:nth-child(3),.unit-row td:nth-child(4){min-width:42px}.sort-field{margin-top:16px}.unit-row td:last-child{min-width:110px}.pager{margin-top:16px;justify-content:flex-end;font-size:13px}.empty{padding:20px;color:var(--el-text-color-secondary)}.actions :deep(.el-button+.el-button){margin-left:0}.unit-author :deep(.el-overlay-dialog){overflow:clip}.unit-author :deep(.unit-author-dialog){max-height:calc(100dvh - 32px);display:flex;flex-direction:column}.unit-author :deep(.unit-author-dialog .el-dialog__body){min-height:0;overflow:auto}.unit-author :deep(.unit-author-dialog .el-dialog__header),.unit-author :deep(.unit-author-dialog .el-dialog__footer){flex-shrink:0}.unit-author :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}@media(max-width:600px){.filters label{width:100%}.pager{justify-content:flex-start}th,td{padding:10px 8px}.card-header>.el-button{margin-left:auto}}
</style>
