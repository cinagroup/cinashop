<template>
  <section class="asset-page">
    <header class="hero">
      <div><p class="eyebrow">PRIVATE MEDIA</p><h1>素材中心</h1><p>图片写入私有 R2，访问链接由 Worker 临时签名；移动与重命名保留原图片对象。</p></div>
      <div class="storage-pill"><span class="pulse" />{{ storage.name }} · {{ storage.binding }}</div>
    </header>
    <el-alert v-if="!canView" type="warning" :closable="false" title="当前账号没有素材查看权限" />
    <el-alert v-else-if="!canManage" type="info" :closable="false" title="当前账号可查看素材；修改需要素材管理权限" />
    <template v-if="canView">
      <el-card shadow="never" class="toolbar-card">
        <div class="toolbar">
          <el-select :model-value="state.query.pid" :disabled="controller.locked" aria-label="当前图片分类" @change="changeCategory">
            <el-option label="根目录" :value="0" /><el-option v-for="item in state.categories" :key="item.id" :label="item.label" :value="item.id" />
          </el-select>
          <el-input v-model="searchName" :disabled="controller.locked" clearable maxlength="80" placeholder="搜索文件名" @keyup.enter="search" />
          <el-button :disabled="controller.locked" @click="search">查询</el-button>
          <el-button :disabled="controller.locked" @click="reload">重新读取</el-button>
          <el-select :model-value="state.query.limit" :disabled="controller.locked" aria-label="每页图片数" class="page-size" @change="changeLimit"><el-option label="20项 / 页" :value="20" /><el-option label="50项 / 页" :value="50" /></el-select>
          <el-button v-if="canManage" :disabled="!controller.writable" @click="categoryDialog = true">新建分类</el-button>
          <el-upload v-if="canManage" :disabled="!controller.writable" :show-file-list="false" accept="image/jpeg,image/png,image/webp,image/gif" :http-request="upload">
            <el-button type="primary" :disabled="!controller.writable" :loading="state.busy === '上传'">上传图片</el-button>
          </el-upload>
        </div>
        <p class="upload-note">单张最大 10 MiB；只接受 JPEG、PNG、WebP、GIF。切换分类、页码或查询会清除当前选择与重命名草稿。</p>
        <div v-if="canManage" class="bulk-toolbar">
          <el-button :disabled="!controller.writable || !state.items.length" @click="controller.selectPage()">选择本页</el-button>
          <el-button :disabled="controller.locked || !state.selected.length" @click="controller.clearSelection()">清除选择</el-button>
          <span class="selection-count">已选 {{ state.selected.length }} / 50 项</span>
          <el-select :model-value="state.targetPid" :disabled="!controller.writable" aria-label="移动目标分类" @change="setTarget">
            <el-option label="根目录" :value="0" /><el-option v-for="item in state.categories" :key="item.id" :label="item.label" :value="item.id" />
          </el-select>
          <el-button type="primary" :disabled="!controller.writable || !state.selected.length" :loading="state.busy === '移动'" @click="controller.move()">移动选中图片</el-button>
        </div>
      </el-card>
      <el-alert v-if="state.error || state.categoryError" type="error" :closable="false" :title="state.error || state.categoryError" />
      <el-alert v-if="state.notice" type="success" :closable="false" :title="state.notice" />
      <div v-loading="state.loading" class="asset-grid">
        <article v-for="item in state.items" :key="item.att_id" class="asset-card" :class="{ selected: state.selected.includes(item.att_id) }">
          <el-image :src="attachmentPreview(item.satt_dir || item.att_dir)" :preview-src-list="[attachmentPreview(item.att_dir)]" fit="cover" class="preview" />
          <div class="asset-body">
            <el-checkbox v-if="canManage" :model-value="state.selected.includes(item.att_id)" :disabled="!controller.writable" :aria-label="'选择' + item.real_name" @change="toggle(item, $event)">选择</el-checkbox>
            <strong :title="item.real_name">{{ item.real_name }}</strong><span>{{ item.att_size }} · {{ item.time || '时间未知' }}</span>
            <div v-if="canManage" class="row-actions"><el-button link :disabled="!controller.writable" @click="controller.openRename(item)">重命名</el-button><el-button type="danger" link :disabled="!controller.writable" @click="controller.remove(item)">删除</el-button></div>
          </div>
        </article>
        <el-empty v-if="!state.loading && !state.items.length" description="当前分类暂无图片素材" />
      </div>
      <el-pagination v-if="state.count > state.query.limit" :current-page="state.query.page" :disabled="controller.locked" :page-size="state.query.limit" :total="state.count" layout="prev, pager, next" @current-change="changePage" />
    </template>
    <el-dialog :model-value="!!state.rename && canManage" title="重命名图片" width="440px" :show-close="!controller.locked" :close-on-click-modal="!controller.locked" :close-on-press-escape="!controller.locked" @update:model-value="setRenameDialog">
      <p>只修改这张图片的显示名称，原图片地址保持不变。</p><el-input :model-value="state.rename?.name ?? ''" :disabled="controller.locked" placeholder="图片名称" @update:model-value="setRenameName" />
      <p class="upload-note">{{ [...(state.rename?.name.trim() ?? '')].length }} / 255 字；名称不能包含控制字符。</p>
      <template #footer><el-button :disabled="controller.locked" @click="controller.closeRename()">取消</el-button><el-button v-if="state.needsReview" :disabled="controller.locked" @click="reload">重新读取并核对</el-button><el-button type="primary" :disabled="!controller.writable" :loading="state.busy === '重命名'" @click="controller.rename()">保存名称</el-button></template>
    </el-dialog>
    <el-dialog v-model="categoryDialog" title="新建根分类" width="420px" :show-close="!controller.locked" :close-on-click-modal="!controller.locked" :close-on-press-escape="!controller.locked">
      <el-input v-model="categoryName" :disabled="controller.locked" maxlength="50" show-word-limit placeholder="分类名称" />
      <template #footer><el-button :disabled="controller.locked" @click="categoryDialog = false">取消</el-button><el-button type="primary" :disabled="!controller.writable" :loading="state.busy === '新建分类'" @click="createCategory">保存</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { UploadRequestOptions } from 'element-plus';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiAttachmentCategories, apiAttachmentCategoryCreate, apiAttachmentDelete, apiAttachmentList, apiAttachmentMove, apiAttachmentRename, apiAttachmentStorage, apiAttachmentUpload, type AttachmentItem } from '@/api/attachment';
import { AttachmentLibraryController, attachmentPreview } from '@/utils/attachmentLibrary';

const auth = useAuthStore(), sessionVersion = ref(0), searchName = ref(''), categoryDialog = ref(false), categoryName = ref('');
let alive = false, syncing = false, stored = localStorage.getItem('admin_session'), storageAbort: AbortController | null = null;
const identity = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
function permission(grant: string) {
  void sessionVersion.value;
  const session = getAdminSession();
  return alive && !!auth.token && auth.token === getToken() && stored === localStorage.getItem('admin_session') && !!session && !!auth.userInfo &&
    session.userInfo.id === auth.userInfo.id && session.userInfo.level === auth.userInfo.level &&
    (auth.userInfo.level === 0 || auth.uniqueAuth.includes(grant) && session.uniqueAuth.includes(grant));
}
const canView = computed(() => permission('attachment.view'));
const canManage = computed(() => canView.value && permission('attachment.manage'));
const controller = new AttachmentLibraryController(() => ({ identity: identity.value, token: auth.token, storedToken: getToken(), session: localStorage.getItem('admin_session'), view: permission('attachment.view'), manage: permission('attachment.view') && permission('attachment.manage') }), {
  list: (query, signal) => apiAttachmentList({ ...query }, signal), categories: signal => apiAttachmentCategories(signal, { all: true }),
  move: apiAttachmentMove, rename: apiAttachmentRename, remove: apiAttachmentDelete, upload: apiAttachmentUpload, createCategory: apiAttachmentCategoryCreate,
  confirm: message => ElMessageBox.confirm(message, '确认素材操作', { type: 'warning', closeOnClickModal: false }),
}, reactive);
const state = controller.state;
const storage = reactive({ name: 'Cloudflare R2', binding: 'ASSETS_BUCKET', configured: false, private: true });
async function loadStorage() {
  if (!canView.value) return;
  storageAbort?.abort(); const abort = new AbortController(), stamp = identity.value, session = stored; storageAbort = abort;
  try { const result = await apiAttachmentStorage(abort.signal); if (alive && canView.value && storageAbort === abort && !abort.signal.aborted && identity.value === stamp && stored === session) Object.assign(storage, result.active); }
  catch { /* Storage discovery does not authorize or block image operations. */ }
  finally { if (storageAbort === abort) storageAbort = null; }
}
function clearScope() {
  if (state.busy) ElMessageBox.close();
  controller.invalidate(); storageAbort?.abort(); storageAbort = null;
  searchName.value = ''; categoryDialog.value = false; categoryName.value = '';
  Object.assign(storage, { name: 'Cloudflare R2', binding: 'ASSETS_BUCKET', configured: false, private: true });
}
function syncSession() {
  syncing = true; clearScope(); const session = getAdminSession();
  auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  stored = localStorage.getItem('admin_session'); sessionVersion.value++; syncing = false;
  if (canView.value) { void controller.activate(); void loadStorage(); }
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
function search() { void controller.setQuery({ name: searchName.value, page: 1 }); }
function changeCategory(pid: number) { void controller.setQuery({ pid, page: 1 }); }
function changePage(page: number) { void controller.setQuery({ page }); }
function changeLimit(limit: 20 | 50) { void controller.setQuery({ limit, page: 1 }); }
function setTarget(pid: number) { controller.setTarget(pid); }
function toggle(item: AttachmentItem, checked: boolean | string | number) { controller.toggle(item, checked === true); }
function setRenameDialog(value: boolean) { if (!value) controller.closeRename(); }
function setRenameName(value: string) { controller.setRenameName(value); }
async function reload() { if (controller.locked) return; await Promise.all([controller.load(), controller.loadCategories()]); }
async function upload(options: UploadRequestOptions) { await controller.upload(options.file); }
async function createCategory() { if (await controller.createCategory(categoryName.value)) { categoryDialog.value = false; categoryName.value = ''; } }
watch(identity, () => { if (alive && !syncing) syncSession(); }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { alive = false; clearScope(); controller.dispose(); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.asset-page { display: grid; gap: 20px; }
.hero { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 28px 32px; border-radius: 18px; color: #edf9f5; background: radial-gradient(circle at 85% 20%, rgba(211,166,82,.3), transparent 25%), linear-gradient(135deg, #102f2b, #17695f); box-shadow: 0 18px 45px rgba(16,61,55,.16); }
.hero h1 { margin: 4px 0 8px; font-size: 28px; }.hero p { margin: 0; color: rgba(237,249,245,.74); }.eyebrow { color: #e9c983 !important; font-size: 11px; font-weight: 750; letter-spacing: 3px; }
.storage-pill { flex: 0 0 auto; padding: 10px 16px; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; background: rgba(255,255,255,.08); font-size: 13px; }.pulse { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%; background: #6de0b4; box-shadow: 0 0 0 5px rgba(109,224,180,.12); }
.toolbar-card { border: 0; border-radius: 14px; }.toolbar, .bulk-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }.toolbar .el-select, .bulk-toolbar .el-select { width: 210px; }.toolbar .page-size { width: 130px; }.toolbar .el-input { width: min(280px, 100%); }.upload-note { margin: 12px 0 0; color: #89938f; font-size: 12px; }.bulk-toolbar { margin-top: 16px; padding-top: 16px; border-top: 1px solid #e8ecea; }.selection-count { color: #52645e; font-size: 13px; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; min-height: 220px; }.asset-card { overflow: hidden; border: 1px solid #e8ecea; border-radius: 15px; background: #fff; box-shadow: 0 8px 24px rgba(25,52,47,.05); }.asset-card.selected { border-color: #17816e; box-shadow: 0 0 0 1px #17816e; }.preview { width: 100%; height: 160px; background: #eef3f1; }.asset-body { display: grid; gap: 7px; padding: 14px; }.asset-body strong { overflow: hidden; color: #263d39; text-overflow: ellipsis; white-space: nowrap; }.asset-body span { color: #909a97; font-size: 12px; }.row-actions { display: flex; gap: 14px; }.row-actions .el-button { margin: 0; padding: 0; }
@media (max-width: 700px) { .hero { align-items: flex-start; flex-direction: column; padding: 24px; }.toolbar > *, .bulk-toolbar > * { width: 100% !important; }.asset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.preview { height: 125px; } }
</style>
