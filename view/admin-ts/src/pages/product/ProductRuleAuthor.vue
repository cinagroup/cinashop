<template>
 <div v-if="props.active" class="rule-author">
  <el-card v-for="screen in screens" :key="screen.key" shadow="never">
   <template #header><div class="card-header"><div><strong>SKU 规格模板</strong><p class="sub">维护颜色、尺码等组合维度。模板用于复制，修改或删除不会改变商品已复制的 SKU。</p></div><el-button v-if="canManage" type="primary" :disabled="!model.writable() || !!state.editor || !state.snapshot?.can_create" @click="screen.create">新增规格模板</el-button></div></template>
   <el-alert v-if="state.pending" title="原规格模板操作结果尚未确认，新的提交已暂停" type="warning" :closable="false" class="notice"><p>未找到回执仍表示结果未知。请读取原回执，或主动核对并封存原请求。</p><div class="actions"><el-button :disabled="state.busy" @click="screen.receipt">读取原回执</el-button><el-button :disabled="state.busy" @click="screen.resolve">核对并封存原请求</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy" @click="screen.retry">原样重试</el-button></div></el-alert>
   <el-alert v-if="!canView" title="当前账号没有商品查看权限" type="warning" :closable="false" />
   <el-alert v-if="state.error || state.pendingError" :title="state.error || state.pendingError" type="error" :closable="false" class="notice" />
   <el-alert v-if="state.notice" :title="state.notice" type="success" :closable="false" class="notice" />
   <template v-if="canView">
    <el-alert v-if="!canManage" title="当前账号仅可查看模板；维护需要商品管理权限。" type="info" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.write_ready" title="此环境尚未安装规格模板安全写入能力，目录可查看" type="warning" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.can_create" title="规格模板已达容量上限，暂不能新增；已有模板仍可维护" type="warning" :closable="false" class="notice" />
    <div class="filters"><label>模板分类名称<input :value="state.filters.draft" aria-label="规格模板搜索" placeholder="请输入模板名称" :disabled="model.viewLocked()" @input="screen.keyword(($event.target as HTMLInputElement).value)" @keyup.enter="screen.search" /></label><el-button :disabled="model.viewLocked()" type="primary" @click="screen.search">查询</el-button><el-button :disabled="model.viewLocked()" @click="screen.reset">重置</el-button><el-button :disabled="state.busy" @click="screen.refresh">刷新</el-button></div>
    <p v-if="state.loading" role="status">正在读取规格模板…</p>
    <div v-if="state.snapshot && !state.loading" class="table-scroll"><table aria-label="SKU 规格模板列表"><thead><tr><th>ID</th><th>模板分类名称</th><th>规格名</th><th>规格值</th><th v-if="canManage">操作</th></tr></thead><tbody>
     <tr v-for="item in rows" :key="item.key" class="rule-row"><td>{{ item.row.id }}</td><td class="rule-name">{{ item.row.rule_name || '空名称历史模板' }}</td><td><template v-if="item.projection.spec"><div v-for="(dimension, index) in item.projection.spec" :key="index">{{ dimension.value }}</div></template><span v-else>历史规格需核对</span></td><td><template v-if="item.projection.spec"><div v-for="(dimension, index) in item.projection.spec" :key="index">{{ dimension.detail.join('，') }}</div></template><span v-else>{{ item.projection.problem }}</span></td><td v-if="canManage"><div class="actions"><el-button link type="primary" :disabled="!model.writable() || !!state.editor" @click="item.edit">编辑</el-button><el-button link type="danger" :disabled="!model.writable() || !!state.editor" @click="item.remove">删除</el-button></div></td></tr>
    </tbody></table><p v-if="!visible.length" class="empty">暂无规格模板</p></div>
    <nav class="pager actions" aria-label="规格模板分页"><span>共 {{ visible.length }} 项，第 {{ state.filters.page }} / {{ pageCount }} 页</span><el-button :disabled="model.viewLocked() || state.filters.page <= 1" @click="screen.previous">上一页</el-button><el-button :disabled="model.viewLocked() || state.filters.page >= pageCount" @click="screen.next">下一页</el-button></nav>
   </template>
  </el-card>
  <el-dialog v-for="editor in editors" :key="editor.key" class="rule-author-dialog" top="16px" :model-value="true" :title="state.editor?.row ? '编辑 SKU 规格模板' : '新增 SKU 规格模板'" width="min(760px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false" :destroy-on-close="true">
   <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" class="notice" />
   <label class="field">模板分类名称<input aria-label="编辑规格模板名称" :value="editor.value" :disabled="!model.writable()" @input="editor.set(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><p class="sub">{{ editor.count }} / 32 个字符；未修改的历史名称可原样保留。</p>
   <template v-if="state.editor?.row"><p class="sub">原始规格（仅供核对，不会因打开或改名而重写）</p><pre class="raw-spec" aria-label="原始规格数据">{{ editor.raw === null ? '数据库 NULL' : editor.raw === '' ? '（空字符串）' : editor.raw }}</pre></template>
   <template v-if="editor.mode === 'preserve'"><el-alert title="原样保留全部历史规格" type="info" :closable="false"><p>只改名称不会重写原始规格。需要修改规格时，请明确选择替换全部结构。</p><p v-if="editor.problem">{{ editor.problem }}</p></el-alert><el-button :disabled="!model.writable()" @click="editor.replace">编辑/替换全部规格</el-button></template>
   <template v-else><el-alert v-if="state.editor?.row" title="保存将替换全部原始规格结构" type="warning" :closable="false" class="notice"><p>确认提交前请核对全部维度和值；历史未知字段和不可编辑结构将被完整替换。</p></el-alert><div class="actions"><el-button :disabled="!model.writable()" @click="editor.addDimension">添加维度</el-button><el-button v-if="state.editor?.row" :disabled="!model.writable()" @click="editor.preserve">恢复原样保留</el-button></div>
    <fieldset v-for="(dimension, di) in editor.dimensions" :key="dimension.key" class="dimension-row"><legend>规格维度 {{ di + 1 }}</legend><label class="field">规格名称<input :aria-label="'维度名称' + (di + 1)" :value="dimension.value" :disabled="!model.writable()" @input="dimension.set(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><div v-for="(entry, vi) in dimension.entries" :key="entry.key" class="value-line"><label>规格值 {{ vi + 1 }}<input :aria-label="'规格值' + (di + 1) + '-' + (vi + 1)" :value="entry.value" :disabled="!model.writable()" @input="entry.set(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><el-button :disabled="!model.writable()" @click="entry.remove">删除规格值</el-button></div><div class="actions"><el-button :disabled="!model.writable()" @click="dimension.add">添加规格值</el-button><el-button type="danger" :disabled="!model.writable()" @click="dimension.remove">删除维度</el-button></div></fieldset>
    <p class="sub">1至3个维度；每个维度1至50个值。规格名称32、规格值64个Unicode字符；重复名称或值须明确修正。</p>
   </template>
   <template #footer><el-button :disabled="state.busy" @click="editor.cancel">取消</el-button><el-button type="primary" :disabled="!model.writable()" @click="editor.submit">保存模板</el-button></template>
  </el-dialog>
  <el-dialog v-for="confirmation in confirmations" :key="confirmation.key" class="rule-author-dialog" top="16px" :model-value="true" title="确认规格模板操作" width="min(560px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false"><p>{{ operationLabels[confirmation.operation] }}<span v-if="confirmation.id"> #{{ confirmation.id }}</span></p><template v-if="confirmation.operation !== 'delete'"><p class="rule-name">{{ confirmation.payload.rule_name }}</p><p>{{ confirmation.payload.mode === 'preserve' ? '原样保留全部原始规格，仅保存名称。' : '将以当前完整维度和值替换全部原始规格结构。' }}</p></template><p v-else>永久删除此模板，不修改任何商品已复制的 SKU、价格或库存。</p><template #footer><el-button :disabled="state.busy" @click="confirmation.cancel">取消操作</el-button><el-button type="primary" :disabled="state.busy" @click="confirmation.confirm">确认提交</el-button></template></el-dialog>
 </div>
</template>
<script setup lang="ts">
import { computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiRuleAuthorCatalog, apiRuleAuthorCommit, apiRuleAuthorReceipt, apiRuleAuthorResolve } from '@/api/ruleAuthor';
import { ruleAuthorState } from '@/utils/ruleAuthorState';
import type { RuleAction, RuleOperation } from '../../../../common/ruleAuthor';
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const emit = defineEmits<{ changed: [] }>();
const auth = useAuthStore(), route = useRoute();
let alive = false, generation = 0, syncing = false, queued = false;
const allowed = (values: string[]) => auth.uniqueAuth.some(p => p === '*' || p === 'product.*' || values.includes(p));
const canView = computed(() => props.active && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || allowed(['product.view', 'product.manage'])));
const canManage = computed(() => canView.value && (auth.userInfo?.level === 0 || allowed(['product.manage'])));
const prefix = (actor: number) => `cinashop_rule_pending_v1_${actor}_`;
function keys(actor: number) { const result: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix(actor))) result.push(key); } return result.sort(); }
const model = ruleAuthorState({ identity: () => `${generation}:${auth.token}:${auth.userInfo?.id}`, actor: () => auth.userInfo?.id ?? 0,
 view: () => canView.value, manage: () => canManage.value, read: apiRuleAuthorCatalog, write: apiRuleAuthorCommit, receipt: apiRuleAuthorReceipt, resolve: apiRuleAuthorResolve, changed: () => emit('changed'),
 readPending: actor => { const key = keys(actor)[0]; if (!key) return null; const raw = localStorage.getItem(key); if (!raw || raw.length > 512 * 1024) throw Error('原规格模板操作记录异常，请保留核对'); const a = JSON.parse(raw); if (key !== prefix(actor) + a?.operation_id) throw Error('原规格模板操作标识不一致'); return a; },
 persist: (actor: number, a: RuleAction | null, expected?: RuleAction) => {
  const value = a ?? expected; if (!value) throw Error('缺少原规格模板操作'); const key = prefix(actor) + value.operation_id, raw = localStorage.getItem(key);
  if (a) { const text = JSON.stringify(a); if (text.length > 512 * 1024 || keys(actor).some(k => k !== key) || raw && raw !== text) throw Error('本账号已有其它未确认规格模板操作'); localStorage.setItem(key, text); }
  else { if (raw && raw !== JSON.stringify(expected)) throw Error('原规格模板操作记录已变化，无法清除'); localStorage.removeItem(key); }
 },
}, v => reactive(v) as typeof v);
const state = model.state, screens = computed(() => [model.screen()]), editors = computed(() => model.editorControls()), confirmations = computed(() => model.confirmationControls());
const visible = computed(() => model.visible()), pageCount = computed(() => model.pageCount());
const rows = computed(() => visible.value.slice((state.filters.page - 1) * 10, state.filters.page * 10).map(model.rowControls));
const operationLabels: Record<RuleOperation, string> = { create: '新增规格模板', update: '保存规格模板', delete: '删除规格模板' };
function schedule() {
 if (!alive || syncing) return; generation++; model.dispose(); if (queued) return; queued = true;
 queueMicrotask(() => { queued = false; if (alive && props.active) void model.activate(); });
}
function syncStored(event?: Event) {
 if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key) && !event.key.startsWith('cinashop_rule_pending_v1_')) return;
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
.rule-author{min-width:0}.card-header,.filters,.actions,.value-line{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.card-header{justify-content:space-between}.sub{margin:8px 0 12px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.7;overflow-wrap:anywhere}.filters{margin:16px 0;align-items:flex-end}.filters label,.field{display:grid;gap:8px;min-width:0}.field{margin-bottom:16px}.filters label{width:min(300px,100%)}input{box-sizing:border-box;width:100%;min-width:0;max-width:100%;font:inherit;padding:9px 12px;border:1px solid var(--el-border-color);border-radius:4px;background:var(--el-bg-color);color:var(--el-text-color-primary)}input:focus{outline:2px solid var(--el-color-primary);outline-offset:1px}.notice{margin:12px 0}.table-scroll{max-width:100%;overflow-x:auto}table{width:100%;min-width:1000px;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid var(--el-border-color-lighter)}th{background:var(--el-fill-color-light);white-space:nowrap}th:first-child{min-width:60px}th:nth-child(2){min-width:150px}th:nth-child(3){min-width:250px}th:nth-child(4){min-width:300px}td:last-child{min-width:120px}.rule-name,td{overflow-wrap:anywhere;white-space:pre-wrap}.pager{margin-top:16px;justify-content:flex-end;font-size:13px}.empty{padding:20px;color:var(--el-text-color-secondary)}.actions :deep(.el-button+.el-button){margin-left:0}.dimension-row{min-width:0;margin:16px 0;border:1px solid var(--el-border-color);padding:12px}.value-line{margin:10px 0;align-items:flex-end}.value-line label{flex:1 1 200px;display:grid;gap:6px;min-width:0}.raw-spec{font:12px/1.6 monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;background:var(--el-fill-color-light);padding:12px}.rule-author :deep(.el-overlay-dialog){overflow:clip}.rule-author :deep(.rule-author-dialog){max-height:calc(100dvh - 32px);display:flex;flex-direction:column}.rule-author :deep(.rule-author-dialog .el-dialog__body){min-height:0;overflow:auto}.rule-author :deep(.rule-author-dialog .el-dialog__header),.rule-author :deep(.rule-author-dialog .el-dialog__footer){flex-shrink:0}.rule-author :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}@media(max-width:600px){.filters label{width:100%}.pager{justify-content:flex-start}.card-header>.el-button{margin-left:auto}th,td{padding:10px 8px}}
</style>
