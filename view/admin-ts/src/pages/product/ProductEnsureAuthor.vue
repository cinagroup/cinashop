<template>
 <div v-if="props.active" class="ensure-author">
  <el-card v-for="screen in screens" :key="screen.key" shadow="never">
   <template #header><div class="card-header"><div><strong>保障服务</strong><p class="sub">维护商品保障条款、内容、图标与排序；显示状态独立确认，被商品引用的保障不能删除。</p></div><el-button v-if="canManage" type="primary" :disabled="!model.writable() || !!state.editor || !state.snapshot?.can_create" @click="screen.create">添加保障服务</el-button></div></template>
   <el-alert v-if="state.pending" title="原保障操作结果尚未确认，新的提交已暂停" type="warning" :closable="false" class="notice"><p>未找到回执仍表示结果未知。可以读取原回执，或主动核对并封存原请求。</p><div class="actions"><el-button :disabled="state.busy" @click="screen.receipt">读取原回执</el-button><el-button :disabled="state.busy" @click="screen.resolve">核对并封存原请求</el-button><el-button v-if="state.retryReady && canManage" :disabled="state.busy" @click="screen.retry">原样重试</el-button></div></el-alert>
   <el-alert v-if="!canView" title="当前账号没有商品查看权限" type="warning" :closable="false" />
   <el-alert v-if="state.error || state.pendingError" :title="state.error || state.pendingError" type="error" :closable="false" class="notice" />
   <el-alert v-if="state.notice" :title="state.notice" type="success" :closable="false" class="notice" />
   <template v-if="canView">
    <el-alert v-if="!canManage" title="当前账号仅可查看保障；维护需要商品管理权限。" type="info" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.write_ready" title="此环境尚未安装保障安全写入能力，目录可查看" type="warning" :closable="false" class="notice" />
    <el-alert v-if="state.snapshot && !state.snapshot.can_create" title="保障目录已达容量上限，暂不能新增；已有保障仍可维护" type="warning" :closable="false" class="notice" />
    <div class="filters"><label>搜索<input :value="state.filters.draft" aria-label="保障搜索" placeholder="请输入服务条款、ID" :disabled="model.viewLocked()" @input="screen.keyword(($event.target as HTMLInputElement).value)" @keyup.enter="screen.search" /></label><el-button type="primary" :disabled="model.viewLocked()" @click="screen.search">查询</el-button><el-button :disabled="model.viewLocked()" @click="screen.reset">重置</el-button><el-button :disabled="state.busy" @click="screen.refresh">刷新</el-button></div>
    <p v-if="state.loading" role="status">正在读取保障服务…</p>
    <div v-if="state.snapshot && !state.loading" class="table-scroll"><table aria-label="商品保障列表"><thead><tr><th>ID</th><th>服务条款</th><th>图标</th><th>内容描述</th><th>使用商品</th><th>是否显示</th><th>排序</th><th>创建时间</th><th v-if="canManage">操作</th></tr></thead><tbody>
     <tr v-for="item in rows" :key="item.key" class="ensure-row"><td>{{ item.row.id }}</td><td class="ensure-name">{{ item.row.name || '空名称历史保障' }}</td><td><el-image v-if="item.preview" :src="item.preview" :preview-src-list="[item.preview]" preview-teleported class="ensure-icon" fit="contain" @error="item.imageError" /><span v-else>无可用预览</span></td><td><span class="description" :title="item.row.desc">{{ item.row.desc || '—' }}</span></td><td>{{ item.row.product_count }}</td><td class="status">{{ statusLabel(item.row.status) }}<el-button v-if="canManage" link :disabled="!model.writable() || !!state.editor" @click="item.status">{{ item.row.status === 1 ? '隐藏' : '显示' }}</el-button></td><td>{{ item.row.sort }}</td><td class="date">{{ addedTime(item.row.add_time) }}</td><td v-if="canManage"><div class="actions"><el-button link type="primary" :disabled="!model.writable() || !!state.editor" @click="item.edit">编辑</el-button><el-button link type="danger" :disabled="!model.writable() || !!state.editor" @click="item.remove">删除</el-button></div></td></tr>
    </tbody></table><p v-if="!visible.length" class="empty">暂无保障服务</p></div>
    <nav class="pager actions" aria-label="商品保障分页"><span>共 {{ visible.length }} 项，第 {{ state.filters.page }} / {{ pageCount }} 页</span><el-button :disabled="model.viewLocked() || state.filters.page <= 1" @click="screen.previous">上一页</el-button><el-button :disabled="model.viewLocked() || state.filters.page >= pageCount" @click="screen.next">下一页</el-button></nav>
   </template>
  </el-card>
  <el-dialog v-for="editor in editors" :key="editor.key" class="ensure-author-dialog" top="16px" :model-value="true" :title="state.editor?.row ? '编辑保障服务' : '添加保障服务'" width="min(560px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false" :destroy-on-close="true">
   <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" class="notice" />
   <label class="field">保障服务条款<input aria-label="编辑保障条款" :value="editor.value" :disabled="!model.writable() || !!state.gallery" autofocus @input="editor.set(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><p class="sub" aria-label="保障名称字符数">{{ editor.count }} / 100 个字符；未修改的历史名称可原样保留。</p>
   <label class="field">内容描述<textarea aria-label="编辑保障描述" :value="editor.desc" rows="4" :disabled="!model.writable() || !!state.gallery" @input="editor.description(($event.target as HTMLTextAreaElement).value)" /></label>
   <div class="field"><label>图标</label><div class="image-line"><img v-if="editor.preview" :key="editor.imageKey" :src="editor.preview" alt="保障图标预览" class="editor-icon" @error="editor.imageError" /><span v-else>无可用预览</span><el-button :disabled="!model.writable() || !!state.gallery" @click="editor.picker">选择图标</el-button></div><input aria-label="保障图标原始地址" :value="editor.image" readonly /><p class="sub">建议100×100。新图标从图库选择；历史地址仅原样保留，预览不会替代保存值。</p></div>
   <label class="field">排序<input aria-label="编辑保障排序" inputmode="numeric" :value="editor.rawSort" :disabled="!model.writable() || !!state.gallery" @input="editor.sort(($event.target as HTMLInputElement).value)" @keyup.enter="editor.submit" /></label><p class="sub">新排序请输入0至2147483647的整数；未修改的历史值可保留。显示状态在列表独立调整。</p>
   <template #footer><el-button :disabled="state.busy || !!state.gallery" @click="editor.cancel">取消</el-button><el-button type="primary" :disabled="!model.writable() || !!state.gallery" @click="editor.submit">保存</el-button></template>
  </el-dialog>
  <el-dialog v-for="gallery in galleries" :key="gallery.key" class="ensure-author-dialog ensure-gallery" top="16px" :model-value="true" title="选择保障图标" width="min(760px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false">
   <el-alert v-if="gallery.error" :title="gallery.error" type="error" :closable="false" />
   <div class="gallery-filters"><label class="field">图片分类<select aria-label="图库分类" :value="gallery.pid" @change="gallery.category(($event.target as HTMLSelectElement).value)"><option value="0">根目录</option><option v-for="category in gallery.categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label><label class="field">图片名称<input aria-label="图库名称" :value="gallery.name" @input="gallery.nameInput(($event.target as HTMLInputElement).value)" @keyup.enter="gallery.search" /></label><el-button :disabled="gallery.loading" @click="gallery.search">查询图片</el-button><el-button :disabled="gallery.loading" @click="gallery.refresh">刷新图片</el-button></div>
   <p v-if="gallery.loading" role="status">正在读取图库…</p><div v-else class="image-grid"><div v-for="option in gallery.items" :key="option.key" class="image-option"><img v-if="option.row.preview" :src="option.row.preview" :alt="option.row.real_name" @error="option.error" /><span v-else>图片预览不可用</span><span>{{ option.row.real_name }}</span><el-button :disabled="!option.row.preview" @click="option.choose">选择此图</el-button></div></div><p v-if="!gallery.loading && !gallery.items.length" class="sub">当前分类没有可选择图片。</p>
   <nav class="pager actions"><span>共 {{ gallery.count }} 项，第 {{ gallery.page }} / {{ gallery.pages }} 页</span><el-button :disabled="gallery.loading || gallery.page <= 1" @click="gallery.previous">图库上一页</el-button><el-button :disabled="gallery.loading || gallery.page >= gallery.pages" @click="gallery.next">图库下一页</el-button></nav>
   <template #footer><el-button @click="gallery.close">关闭图库</el-button></template>
  </el-dialog>
  <el-dialog v-for="confirmation in confirmations" :key="confirmation.key" class="ensure-author-dialog" top="16px" :model-value="true" title="确认保障操作" width="min(560px, calc(100vw - 24px))" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false">
   <p>{{ operationLabels[confirmation.operation] }}<span v-if="confirmation.id"> #{{ confirmation.id }}</span></p><template v-if="confirmation.operation === 'create' || confirmation.operation === 'update'"><p class="ensure-name">{{ confirmation.payload.name }} · 排序 {{ confirmation.payload.sort }}</p><p class="description">{{ confirmation.payload.desc }}</p></template><p v-else-if="confirmation.operation === 'status'">确定将此保障设为{{ confirmation.payload.status === 1 ? '显示' : '隐藏' }}？现有商品引用不会被移除，停用后不能新绑定。</p><p v-else>此操作永久删除保障记录。被任何商品引用时服务端会拒绝，不会修改商品或供应商资料。</p>
   <template #footer><el-button :disabled="state.busy" @click="confirmation.cancel">取消操作</el-button><el-button type="primary" :disabled="state.busy" @click="confirmation.confirm">确认提交</el-button></template>
  </el-dialog>
 </div>
</template>
<script setup lang="ts">
import { computed, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiEnsureAuthorCatalog, apiEnsureAuthorCommit, apiEnsureAuthorReceipt, apiEnsureAuthorResolve, apiEnsureAuthorAttachmentCategories, apiEnsureAuthorAttachmentOptions } from '@/api/ensureAuthor';
import { ensureAuthorState } from '@/utils/ensureAuthorState';
import type { EnsureAction, EnsureOperation } from '../../../../common/ensureAuthor';
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const emit = defineEmits<{ changed: [] }>();
const auth = useAuthStore(), route = useRoute();
let alive = false, generation = 0, syncing = false, queued = false;
const allowed = (values: string[]) => auth.uniqueAuth.some(p => p === '*' || p === 'product.*' || values.includes(p));
const canView = computed(() => props.active && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || allowed(['product.view', 'product.manage'])));
const canManage = computed(() => canView.value && (auth.userInfo?.level === 0 || allowed(['product.manage'])));
const prefix = (actor: number) => `cinashop_ensure_pending_v1_${actor}_`;
function keys(actor: number) { const result: string[] = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix(actor))) result.push(key); } return result.sort(); }
const model = ensureAuthorState({ identity: () => `${generation}:${auth.token}:${auth.userInfo?.id}`, actor: () => auth.userInfo?.id ?? 0,
 view: () => canView.value, manage: () => canManage.value, read: apiEnsureAuthorCatalog, write: apiEnsureAuthorCommit, receipt: apiEnsureAuthorReceipt, resolve: apiEnsureAuthorResolve, categories: apiEnsureAuthorAttachmentCategories, options: apiEnsureAuthorAttachmentOptions, changed: () => emit('changed'),
 readPending: actor => { const key = keys(actor)[0]; if (!key) return null; const raw = localStorage.getItem(key); if (!raw || raw.length > 512 * 1024) throw Error('原保障操作记录异常，请保留核对'); const a = JSON.parse(raw); if (key !== prefix(actor) + a?.operation_id) throw Error('原保障操作标识不一致'); return a; },
 persist: (actor: number, a: EnsureAction | null, expected?: EnsureAction) => {
  const value = a ?? expected; if (!value) throw Error('缺少原保障操作'); const key = prefix(actor) + value.operation_id, raw = localStorage.getItem(key);
  if (a) { const text = JSON.stringify(a); if (text.length > 512 * 1024 || keys(actor).some(k => k !== key) || raw && raw !== text) throw Error('本账号已有其它未确认保障操作'); localStorage.setItem(key, text); }
  else { if (raw && raw !== JSON.stringify(expected)) throw Error('原保障操作记录已变化，无法清除'); localStorage.removeItem(key); }
 },
}, v => reactive(v) as typeof v);
const state = model.state, screens = computed(() => [model.screen()]), editors = computed(() => model.editorControls()), confirmations = computed(() => model.confirmationControls()), galleries = computed(() => model.galleryControls());
const visible = computed(() => model.visible()), pageCount = computed(() => model.pageCount());
const rows = computed(() => visible.value.slice((state.filters.page - 1) * 15, state.filters.page * 15).map(model.rowControls));
const operationLabels: Record<EnsureOperation, string> = { create: '新增保障', update: '保存保障', status: '修改显示状态', delete: '删除保障' };
function statusLabel(value: number) { return value === 1 ? '显示' : value === 0 ? '隐藏' : `历史状态 ${value}`; }
function addedTime(value: number) { if (!value) return '—'; return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value * 1000)); }
function schedule() {
 if (!alive || syncing) return; generation++; model.dispose(); if (queued) return; queued = true;
 queueMicrotask(() => { queued = false; if (alive && props.active) void model.activate(); });
}
function syncStored(event?: Event) {
 if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key) && !event.key.startsWith('cinashop_ensure_pending_v1_')) return;
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
.ensure-author{min-width:0}.card-header,.filters,.actions,.image-line,.gallery-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.card-header{justify-content:space-between}.sub{margin:6px 0 12px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.7;overflow-wrap:anywhere}.filters{margin:16px 0;align-items:flex-end}.filters label,.field{display:grid;gap:8px;min-width:0}.filters label{width:min(280px,100%)}.field{margin-bottom:16px}input,textarea,select{box-sizing:border-box;width:100%;max-width:100%;min-width:0;font:inherit;padding:9px 12px;border:1px solid var(--el-border-color);border-radius:4px;background:var(--el-bg-color);color:var(--el-text-color-primary)}input:focus,textarea:focus,select:focus{outline:2px solid var(--el-color-primary);outline-offset:1px}input[readonly]{color:var(--el-text-color-secondary)}.notice{margin:12px 0}.table-scroll{max-width:100%;overflow-x:auto}table{width:100%;min-width:1100px;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid var(--el-border-color-lighter)}th{background:var(--el-fill-color-light);white-space:nowrap}th:nth-child(2),th:nth-child(3),th:nth-child(4),th:nth-child(5),th:nth-child(6),th:nth-child(7){min-width:100px}.ensure-name{overflow-wrap:anywhere;white-space:pre-wrap;min-width:100px}.description{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:250px;white-space:pre-wrap;overflow-wrap:anywhere}.status,.date{white-space:nowrap}.ensure-row td:first-child{width:60px}.ensure-row td:last-child{min-width:120px}.ensure-icon{width:36px;height:36px}.editor-icon{width:100px;height:100px;object-fit:contain}.image-line{align-items:center}.pager{margin-top:16px;justify-content:flex-end;font-size:13px}.empty{padding:20px;color:var(--el-text-color-secondary)}.actions :deep(.el-button+.el-button){margin-left:0}.ensure-author :deep(.el-overlay-dialog){overflow:clip}.ensure-author :deep(.ensure-author-dialog){max-height:calc(100dvh - 32px);display:flex;flex-direction:column}.ensure-author :deep(.ensure-author-dialog .el-dialog__body){min-height:0;overflow:auto}.ensure-author :deep(.ensure-author-dialog .el-dialog__header),.ensure-author :deep(.ensure-author-dialog .el-dialog__footer){flex-shrink:0}.ensure-author :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}.gallery-filters{align-items:flex-end}.gallery-filters .field{flex:1 1 160px}.image-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(130px,100%),1fr));gap:12px}.image-option{display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid var(--el-border-color);padding:8px;border-radius:6px;overflow-wrap:anywhere}.image-option img{width:100%;height:100px;object-fit:contain}@media(max-width:600px){.filters label,.gallery-filters .field{width:100%;flex-basis:100%}.pager{justify-content:flex-start}th,td{padding:10px 8px}.card-header>.el-button{margin-left:auto}}
</style>
