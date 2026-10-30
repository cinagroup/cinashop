<template>
 <div v-if="props.active" class="parameter-author">
  <el-card v-for="screen in screens" :key="screen.key" shadow="never">
   <template #header><div class="card-header"><div><strong>商品参数模板</strong><p class="sub">维护材质、产地等说明参数。修改模板不会回写商品已保存的参数快照。</p></div><el-button v-if="canManage" type="primary" :disabled="!model.writable() || !!state.editor || !state.snapshot?.can_create" @click="screen.create">新增参数模板</el-button></div></template>
   <el-alert v-if="state.pending" title="原参数模板操作结果尚未确认，新的提交已暂停" type="warning" :closable="false" class="notice"><p>未找到回执仍表示结果未知。请读取原回执，或主动核对并封存原请求。</p><div class="actions"><el-button :disabled="state.busy" @click="screen.receipt">读取原回执</el-button><el-button :disabled="state.busy" @click="screen.resolve">核对并封存原请求</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy" @click="screen.retry">原样重试</el-button></div></el-alert>
   <el-alert v-if="!canView" title="当前账号没有商品查看权限" type="warning" :closable="false" />
   <el-alert v-if="state.error || state.pendingError" :title="state.error || state.pendingError" type="error" :closable="false" class="notice" />
   <el-alert v-if="state.notice" :title="state.notice" type="success" :closable="false" class="notice" />
   <template v-if="canView">
    <el-alert v-if="!canManage" title="当前账号仅可查看模板；维护需要商品管理权限。" type="info" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.write_ready" title="此环境尚未安装参数模板安全写入能力，目录可查看" type="warning" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.can_create" title="参数模板已达容量上限，暂不能新增；已有模板仍可维护" type="warning" :closable="false" class="notice" />
    <div class="filters"><label>参数模板名称<input :value="state.filters.draft" aria-label="参数模板搜索" placeholder="请输入模板名称" :disabled="model.viewLocked()" @input="screen.keyword(($event.target as HTMLInputElement).value)" @keyup.enter="screen.search" /></label><el-button :disabled="model.viewLocked()" type="primary" @click="screen.search">查询</el-button><el-button :disabled="model.viewLocked()" @click="screen.reset">重置</el-button><el-button :disabled="state.busy" @click="screen.refresh">刷新</el-button></div>
    <p v-if="state.loading" role="status">正在读取参数模板…</p>
    <div v-if="state.snapshot && !state.loading" class="table-scroll"><table aria-label="商品参数模板列表"><thead><tr><th>ID</th><th>参数模板名称</th><th>排序</th><th>创建时间</th><th v-if="canManage">操作</th></tr></thead><tbody>
     <tr v-for="item in rows" :key="item.key" class="parameter-row"><td>{{ item.row.id }}</td><td class="parameter-name">{{ item.row.name || '空名称历史模板' }}</td><td>{{ item.row.sort }}</td><td>{{ formatTime(item.row.add_time) }}</td><td v-if="canManage"><div class="actions"><el-button link type="primary" :disabled="!model.writable() || !!state.editor" @click="item.edit">编辑</el-button><el-button link type="danger" :disabled="!model.writable() || !!state.editor" @click="item.remove">删除</el-button></div></td></tr>
    </tbody></table><p v-if="!visible.length" class="empty">暂无参数模板</p></div>
    <nav class="pager actions" aria-label="参数模板分页"><span>共 {{ visible.length }} 项，第 {{ state.filters.page }} / {{ pageCount }} 页</span><el-button :disabled="model.viewLocked() || state.filters.page <= 1" @click="screen.previous">上一页</el-button><el-button :disabled="model.viewLocked() || state.filters.page >= pageCount" @click="screen.next">下一页</el-button></nav>
   </template>
  </el-card>
  <el-dialog v-for="editor in editors" :key="editor.key" class="parameter-author-dialog" top="16px" :model-value="true" :title="state.editor?.row ? '编辑商品参数模板' : '新增商品参数模板'" width="min(820px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false" :destroy-on-close="true">
   <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" class="notice" />
   <label class="field">参数模板名称<textarea rows="2" aria-label="编辑参数模板名称" :value="editor.value" :disabled="!model.writable()" @input="editor.set(($event.target as HTMLTextAreaElement).value)" @keydown.ctrl.enter.prevent="editor.submit" /></label><p class="sub">{{ editor.count }} / 255 个字符；未修改的历史名称和排序可原样保留。</p>
   <label class="field">排序<input aria-label="编辑参数模板排序" :value="editor.rawSort" :disabled="!model.writable()" @input="editor.sort(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label>
   <template v-if="editor.mode === 'preserve'"><el-alert title="原样保留全部历史参数" type="info" :closable="false"><p>只改名称或排序不会重写任何参数子行。需要修改参数时，请明确选择替换全部参数。</p></el-alert><el-button :disabled="!model.writable()" @click="editor.replace">编辑/替换全部参数</el-button>
    <div class="table-scroll history"><table aria-label="原参数只读明细"><thead><tr><th>参数名称</th><th>参数值</th><th>排序</th><th>状态</th></tr></thead><tbody><tr v-for="entry in editor.history" :key="entry.id" class="parameter-history-row"><td>{{ entry.name }}</td><td>{{ entry.value }}</td><td>{{ entry.sort }}</td><td>{{ entry.status === 1 ? '启用' : entry.status === 0 ? '停用' : '历史状态 ' + entry.status }}</td></tr></tbody></table></div>
   </template>
   <template v-else>
    <el-alert v-if="state.editor?.row" title="保存将替换全部原参数子行" type="warning" :closable="false" class="notice"><p>请核对完整新稿；原参数的行编号、创建时间和其它只读资料将由保存流程重建。已有商品参数快照不会被回写。</p></el-alert>
    <el-alert v-if="editor.total > 100" title="完整历史参数超过新写100项，尚未截断" type="warning" :closable="false"><p>可恢复原样保留，或明确整理、清空新稿后重新填写；当前全部 {{ editor.total }} 项仍在稿中。</p></el-alert>
    <div class="actions"><el-button :disabled="!model.writable() || editor.total >= 100 || editor.clear" @click="editor.add">添加参数</el-button><el-button :disabled="!model.writable() || editor.clear" @click="editor.askClear">清空全部新参数稿</el-button><el-button v-if="state.editor?.row" :disabled="!model.writable()" @click="editor.preserve">恢复原样保留</el-button></div>
    <el-alert v-if="editor.clear" title="确认清空当前全部新参数稿？" type="warning" :closable="false" class="notice"><p>这里只清空待保存的新稿；确认提交前不会改写模板或商品。</p><div class="actions"><el-button @click="editor.cancelClear">取消清空</el-button><el-button type="danger" @click="editor.confirmClear">确认清空新稿</el-button></div></el-alert>
    <fieldset v-for="entry in editor.entries" :key="entry.key" class="parameter-entry"><legend>参数 {{ entry.number }}</legend><div class="entry-grid"><label>参数名称<textarea rows="2" :aria-label="'参数名称' + entry.number" :value="entry.name" :disabled="!model.writable() || editor.clear" @input="entry.nameInput(($event.target as HTMLTextAreaElement).value)" @keydown.ctrl.enter.prevent="editor.submit" /></label><label>参数值<textarea rows="2" :aria-label="'参数值' + entry.number" :value="entry.value" :disabled="!model.writable() || editor.clear" @input="entry.valueInput(($event.target as HTMLTextAreaElement).value)" @keydown.ctrl.enter.prevent="editor.submit" /></label><label>排序<input :aria-label="'参数排序' + entry.number" :value="entry.sort" :disabled="!model.writable() || editor.clear" @input="entry.sortInput(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><label>状态<select :aria-label="'参数状态' + entry.number" :value="entry.status" :disabled="!model.writable() || editor.clear" @change="entry.statusInput(($event.target as HTMLSelectElement).value)"><option v-if="!['0','1'].includes(entry.status)" :value="entry.status" disabled>历史状态 {{ entry.status }}</option><option value="1">启用</option><option value="0">停用</option></select></label></div><el-button type="danger" :disabled="!model.writable() || editor.clear" @click="entry.remove">删除参数</el-button></fieldset>
    <p class="sub">新稿可为0至100项，每项名称和值最多255个字符。重复名称允许；负排序或历史状态须明确修正后才能替换保存。</p>
   </template>
   <nav class="pager actions" aria-label="参数明细分页"><span>完整 {{ editor.total }} 项，第 {{ editor.page }} / {{ editor.pages }} 页（每页20项）</span><el-button :disabled="!model.writable() || editor.page <= 1 || editor.clear" @click="editor.previous">参数上一页</el-button><el-button :disabled="!model.writable() || editor.page >= editor.pages || editor.clear" @click="editor.next">参数下一页</el-button></nav>
   <template #footer><el-button :disabled="state.busy" @click="editor.cancel">取消</el-button><el-button type="primary" :disabled="!model.writable() || editor.clear" @click="editor.submit">保存模板</el-button></template>
  </el-dialog>
  <el-dialog v-for="confirmation in confirmations" :key="confirmation.key" class="parameter-author-dialog" top="16px" :model-value="true" title="确认参数模板操作" width="min(560px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false"><p>{{ operationLabels[confirmation.operation] }}<span v-if="confirmation.id"> #{{ confirmation.id }}</span></p><template v-if="confirmation.operation !== 'delete'"><pre class="confirmation-name">{{ confirmation.payload.name }}</pre><p>排序：{{ confirmation.payload.sort }}</p><p>{{ confirmation.payload.mode === 'preserve' ? '原样保留全部参数子行' : '完整替换为新参数稿' }}<span v-if="confirmation.payload.mode === 'replace'">（{{ (confirmation.payload.specs as unknown[]).length }} 项）</span></p></template><p v-else>删除将永久移除模板及其参数子行；仍被商品直接资料或关联记录引用时会拒绝删除。此操作不会改写任何商品参数快照。</p><template #footer><el-button :disabled="state.busy" @click="confirmation.cancel">取消操作</el-button><el-button type="primary" :disabled="state.busy" @click="confirmation.confirm">确认提交</el-button></template></el-dialog>
 </div>
</template>
<script setup lang="ts">
import { computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiParameterAuthorCatalog, apiParameterAuthorCommit, apiParameterAuthorReceipt, apiParameterAuthorResolve } from '@/api/parameterAuthor';
import { parameterAuthorState } from '@/utils/parameterAuthorState';
import type { ParameterAction, ParameterOperation } from '../../../../common/parameterAuthor';
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const emit = defineEmits<{ changed: [] }>();
const auth = useAuthStore(), route = useRoute();
let alive = false, generation = 0, syncing = false, queued = false;
const allowed = (values: string[]) => auth.uniqueAuth.some(p => p === '*' || p === 'product.*' || values.includes(p));
const canView = computed(() => props.active && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || allowed(['product.view', 'product.manage'])));
const canManage = computed(() => canView.value && (auth.userInfo?.level === 0 || allowed(['product.manage'])));
const prefix = (actor: number) => `cinashop_parameter_pending_v1_${actor}_`;
function keys(actor: number) { const result: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix(actor))) result.push(key); } return result.sort(); }
const model = parameterAuthorState({ identity: () => `${generation}:${auth.token}:${auth.userInfo?.id}`, actor: () => auth.userInfo?.id ?? 0,
 view: () => canView.value, manage: () => canManage.value, read: apiParameterAuthorCatalog, write: apiParameterAuthorCommit, receipt: apiParameterAuthorReceipt, resolve: apiParameterAuthorResolve, changed: () => emit('changed'),
 readPending: actor => { const key = keys(actor)[0]; if (!key) return null; const raw = localStorage.getItem(key); if (!raw || raw.length > 512 * 1024) throw Error('原参数模板操作记录异常，请保留核对'); const a = JSON.parse(raw); if (key !== prefix(actor) + a?.operation_id) throw Error('原参数模板操作标识不一致'); return a; },
 persist: (actor: number, a: ParameterAction | null, expected?: ParameterAction) => {
  const value = a ?? expected; if (!value) throw Error('缺少原参数模板操作'); const key = prefix(actor) + value.operation_id, raw = localStorage.getItem(key);
  if (a) { const text = JSON.stringify(a); if (text.length > 512 * 1024 || keys(actor).some(k => k !== key) || raw && raw !== text) throw Error('本账号已有其它未确认参数模板操作'); localStorage.setItem(key, text); }
  else { if (raw && raw !== JSON.stringify(expected)) throw Error('原参数模板操作记录已变化，无法清除'); localStorage.removeItem(key); }
 },
}, v => reactive(v) as typeof v);
const state = model.state, screens = computed(() => [model.screen()]), editors = computed(() => model.editorControls()), confirmations = computed(() => model.confirmationControls());
const visible = computed(() => model.visible()), pageCount = computed(() => model.pageCount());
const rows = computed(() => visible.value.slice((state.filters.page - 1) * 15, state.filters.page * 15).map(model.rowControls));
const clock = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function formatTime(seconds: number) { if (!seconds) return ''; const values = Object.fromEntries(clock.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value])); return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`; }
const operationLabels: Record<ParameterOperation, string> = { create: '新增参数模板', update: '保存参数模板', delete: '删除参数模板' };
function schedule() {
 if (!alive || syncing) return; generation++; model.dispose(); if (queued) return; queued = true;
 queueMicrotask(() => { queued = false; if (alive && props.active) void model.activate(); });
}
function syncStored(event?: Event) {
 if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key) && !event.key.startsWith('cinashop_parameter_pending_v1_')) return;
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
.parameter-author{min-width:0}.card-header,.filters,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.card-header{justify-content:space-between}.sub{margin:8px 0 12px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.7;overflow-wrap:anywhere}.filters{margin:16px 0;align-items:flex-end}.filters label,.field{display:grid;gap:8px;min-width:0}.field{margin-bottom:16px}.filters label{width:min(300px,100%)}input,textarea,select{box-sizing:border-box;width:100%;min-width:0;max-width:100%;font:inherit;padding:9px 12px;border:1px solid var(--el-border-color);border-radius:4px;background:var(--el-bg-color);color:var(--el-text-color-primary)}textarea{resize:vertical;white-space:pre-wrap}input:focus,textarea:focus,select:focus{outline:2px solid var(--el-color-primary);outline-offset:1px}.notice{margin:12px 0}.table-scroll{max-width:100%;overflow-x:auto}table{width:100%;min-width:800px;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid var(--el-border-color-lighter)}th{background:var(--el-fill-color-light);white-space:nowrap}th:first-child{min-width:60px}th:nth-child(2){min-width:240px}th:nth-child(3){min-width:90px}th:nth-child(4){min-width:160px}th:nth-child(5),td:last-child{min-width:120px}td{overflow-wrap:anywhere;white-space:pre-wrap}td:nth-child(3),td:nth-child(4){white-space:nowrap}.pager{margin-top:16px;justify-content:flex-end;font-size:13px}.empty{padding:20px;color:var(--el-text-color-secondary)}.actions :deep(.el-button+.el-button){margin-left:0}.parameter-entry{min-width:0;margin:16px 0;border:1px solid var(--el-border-color);padding:12px}.entry-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:12px}.entry-grid label{display:grid;gap:8px;min-width:0}.history{margin-top:16px}.history table{min-width:640px}.history th:nth-child(2){min-width:200px}.history th:nth-child(4){min-width:90px}.confirmation-name{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.parameter-author :deep(.el-overlay-dialog){overflow:clip}.parameter-author :deep(.parameter-author-dialog){max-height:calc(100dvh - 32px);display:flex;flex-direction:column}.parameter-author :deep(.parameter-author-dialog .el-dialog__body){min-height:0;overflow:auto}.parameter-author :deep(.parameter-author-dialog .el-dialog__header),.parameter-author :deep(.parameter-author-dialog .el-dialog__footer){flex-shrink:0}.parameter-author :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}@media(max-width:600px){.filters label{width:100%}.pager{justify-content:flex-start}.card-header>.el-button{margin-left:auto}th,td{padding:10px 8px}.entry-grid{grid-template-columns:minmax(0,1fr)}}
</style>
