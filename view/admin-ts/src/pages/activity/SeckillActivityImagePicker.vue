<template>
  <el-button :disabled="!canChoose || disabled" @click="open">从图库选择</el-button>
  <span v-if="!canChoose" class="hint">选择图片需要图库查看权限</span>
  <el-dialog v-model="visible" :title="title || '选择活动氛围图'" width="min(840px, calc(100vw - 24px))" append-to-body @closed="onClosed">
    <div class="toolbar">
      <el-select v-model="pid" aria-label="图片分类" @change="search"><el-option label="全部分类" :value="0" /><el-option v-for="item in categories" :key="item.id" :label="item.name" :value="item.id" /></el-select>
      <el-input v-model="name" aria-label="图片名称" placeholder="搜索图片名称" maxlength="100" clearable @keyup.enter="search" />
      <el-button :disabled="uploading" @click="search">查询</el-button>
      <el-upload v-if="canUpload" :show-file-list="false" accept="image/jpeg,image/png,image/webp,image/gif" :http-request="upload" :disabled="uploading"><el-button :loading="uploading">上传图片</el-button></el-upload>
    </div>
    <el-alert v-if="categoryError" :title="categoryError" type="warning" :closable="false" show-icon />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><template #default><el-button link @click="load()">重新读取图库</el-button></template></el-alert>
    <div v-loading="loading" class="grid">
      <article v-for="item in items" :key="item.att_id"><el-image v-if="preview(item.att_dir)" :src="preview(item.satt_dir || item.att_dir)" :preview-src-list="[preview(item.att_dir)]" preview-teleported fit="cover" /><span>{{ item.real_name }}</span><el-button :disabled="loading || uploading" @click="choose(item)">选择</el-button></article>
      <p v-if="!loading && !items.length" class="hint">暂无图片</p>
    </div>
    <el-pagination :current-page="page" :page-size="20" :total="count" layout="total, prev, pager, next" :disabled="loading || uploading" @current-change="load" />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, type UploadRequestOptions } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import { apiAttachmentCategories, apiAttachmentList, apiAttachmentUpload, type AttachmentItem, type AttachmentCategoryItem } from '@/api/attachment';
const props = defineProps<{ disabled: boolean; editorKey: string; title?: string }>();
const emit = defineEmits<{ choose: [reference: string, preview: string] }>();
const auth = useAuthStore();
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${props.editorKey}`);
const canChoose = computed(() => !props.disabled && auth.token === getToken() && !!auth.token && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.view')));
const canUpload = computed(() => canChoose.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.manage')));
const visible = ref(false), loading = ref(false), uploading = ref(false), error = ref(''), categoryError = ref('');
const items = ref<AttachmentItem[]>([]), categories = ref<AttachmentCategoryItem[]>([]), name = ref(''), pid = ref(0), page = ref(1), count = ref(0);
let alive = true, epoch = 0, requestId = 0, listAbort: AbortController | null = null, categoryAbort: AbortController | null = null, uploadAbort: AbortController | null = null;
type Stamp = { epoch: number; identity: string; stored: string | null };
let visibleScope: Stamp | null = null;
function stamp(): Stamp { return { epoch, identity: identity.value, stored: localStorage.getItem('admin_session') }; }
function current(value: Stamp) { return alive && canChoose.value && auth.token === getToken() && visible.value && !!visibleScope && value.epoch === epoch && value.identity === identity.value && value.stored === visibleScope.stored && value.stored === localStorage.getItem('admin_session'); }
function preview(value: string) { return /^(https:\/\/|\/(?!\/))/iu.test(value) && !/[\u0000-\u0020\u007f\\]/u.test(value) ? value : ''; }
function close() { epoch++; requestId++; listAbort?.abort(); categoryAbort?.abort(); uploadAbort?.abort(); listAbort = categoryAbort = uploadAbort = null; visibleScope = null; visible.value = loading.value = uploading.value = false; items.value = []; categories.value = []; count.value = 0; error.value = categoryError.value = ''; }
function onClosed() { if (!visible.value) close(); }
async function open() {
  if (!canChoose.value || auth.token !== getToken() || uploading.value) return;
  close(); visible.value = true; name.value = ''; pid.value = 0;
  const value = stamp(), controller = new AbortController(); visibleScope = value; categoryAbort = controller;
  try { const result = await apiAttachmentCategories(controller.signal); if (!result || !Array.isArray(result.list) || result.list.some(item => !item || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.name !== 'string')) throw Error('图库分类格式错误'); if (current(value)) categories.value = result.list; }
  catch (reason) { if (current(value)) categoryError.value = reason instanceof Error ? reason.message : '图库分类读取失败'; }
  finally { if (categoryAbort === controller) categoryAbort = null; }
  if (current(value)) await load(1);
}
async function load(target = page.value) {
  if (!current(stamp()) || !Number.isSafeInteger(target) || target < 1 || target > 501) return;
  listAbort?.abort(); const value = stamp(), serial = ++requestId, controller = new AbortController(); listAbort = controller; page.value = target; loading.value = true; error.value = ''; items.value = [];
  try {
    const result = await apiAttachmentList({ page: target, limit: 20, pid: pid.value, name: name.value.trim(), file_type: 1 }, controller.signal);
    if (!current(value) || serial !== requestId) return;
    if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0 || result.list.length > 20 || result.list.some(item => !item || !Number.isSafeInteger(item.att_id) || item.att_id < 1 || typeof item.canonical_url !== 'string' || typeof item.att_dir !== 'string' || typeof item.satt_dir !== 'string' || typeof item.real_name !== 'string')) throw Error('图库列表格式错误');
    items.value = result.list; count.value = result.count;
  } catch (reason) { if (current(value) && serial === requestId) error.value = reason instanceof Error ? reason.message : '图库读取失败'; }
  finally { if (listAbort === controller) { loading.value = false; listAbort = null; } }
}
function search() { if (!uploading.value) void load(1); }
function choose(item: AttachmentItem) {
  if (!current(stamp()) || loading.value || uploading.value || !items.value.some(row => row.att_id === item.att_id && row.canonical_url === item.canonical_url)) return;
  if (!item.canonical_url || [...item.canonical_url].length > 128 || !preview(item.canonical_url)) { error.value = '该图片没有可用的稳定地址，或地址超过128字，请重新选择'; return; }
  emit('choose', item.canonical_url, preview(item.att_dir)); close();
}
async function upload(options: UploadRequestOptions) {
  if (!canUpload.value || !current(stamp()) || uploading.value) return;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(options.file.type) || options.file.size < 1 || options.file.size > 10 * 1024 * 1024) { error.value = '请选择不超过10 MiB的JPEG、PNG、WebP或GIF图片'; return; }
  const value = stamp(), controller = new AbortController(); uploadAbort = controller; uploading.value = true; error.value = '';
  try { const result = await apiAttachmentUpload(options.file, pid.value, controller.signal); if (!result || !Number.isSafeInteger(result.att_id) || result.att_id < 1 || typeof result.src !== 'string' || typeof result.url !== 'string') throw Error('图片上传响应格式错误'); if (current(value) && canUpload.value) ElMessage.success('已上传，请从图库选择图片'); }
  catch (reason) { if (current(value)) error.value = `上传结果未确认：${reason instanceof Error ? reason.message : '请求失败'}。请重新读取图库核对，勿重复上传。`; }
  finally { if (uploadAbort === controller) { uploading.value = false; uploadAbort = null; } }
  if (current(value)) { const notice = error.value; await load(1); if (current(value) && notice) error.value = notice; }
}
watch(identity, close, { flush: 'sync' });
watch(() => props.disabled, disabled => { if (disabled) close(); }, { flush: 'sync' });
onBeforeUnmount(() => { alive = false; close(); });
</script>

<style scoped>
.hint { color: #737985; font-size: 12px; }.toolbar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }.toolbar :deep(.el-input) { flex: 1 1 160px; }.toolbar :deep(.el-select) { width: 160px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); min-height: 150px; gap: 12px; margin: 16px 0; }.grid article { min-width: 0; display: grid; gap: 7px; }.grid :deep(.el-image) { width: 100%; height: 110px; }.grid span { font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
@media (max-width: 600px) { .toolbar :deep(.el-select) { width: 100%; }.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
