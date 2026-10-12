<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { uploadSupplierImage, type SupplierAttachment } from '@/api/attachments';
import { useAttachmentSelection } from '@/utils/attachmentSelection';
import { useAuthStore } from '@/stores/auth';

const props = defineProps<{ modelValue: boolean; supplierId: number; limit: number; contextKey: string }>();
const emit = defineEmits<{ 'update:modelValue': [open: boolean]; selected: [images: SupplierAttachment[], contextKey: string] }>();
const auth = useAuthStore();
const state = useAttachmentSelection({ supplierId: props.supplierId, limit: props.limit });
const { rows, count, pages, loading, error, applied, categories, categoriesLoading, categoriesError, selected, invalidated, canConfirm } = state;
const filter = ref('');
const trail = ref<Array<{ id: number; name: string }>>([{ id: 0, name: '未分类图片' }]);
const folder = computed(() => trail.value.at(-1)!.id);
const uploadInput = ref<HTMLInputElement>();
const uploading = ref(false), uploadMessage = ref(''), unknownUpload = ref(false);
const failedImages = ref(new Set<number>());
const uploadController = new AbortController();
const closed = ref(false);
let alive = true;
const canUpload = computed(() => auth.can('supplier.attachment.manage') && !invalidated.value && !unknownUpload.value);
const frozenContext = props.contextKey;

function current() { return alive && !closed.value && props.modelValue && props.contextKey === frozenContext && !invalidated.value; }
async function readFolder() {
  if (!current()) return;
  failedImages.value = new Set();
  await Promise.all([state.loadCategories(folder.value), state.load({ pid: folder.value, name: filter.value, page: 1 })]);
}
async function enterFolder(id: number, name: string) {
  if (!current() || uploading.value) return;
  trail.value.push({ id, name }); filter.value = ''; await readFolder();
}
async function parentFolder(index: number) {
  if (!current() || uploading.value) return;
  trail.value = trail.value.slice(0, index + 1); filter.value = ''; await readFolder();
}
async function search() {
  if (current() && !uploading.value) await state.load({ pid: folder.value, name: filter.value, page: 1 });
}
async function page(number: number) {
  if (current() && !uploading.value) await state.load({ ...applied.value, page: number });
}
function close() { closed.value = true; state.reset(); uploadController.abort(); emit('update:modelValue', false); }
function confirm() {
  if (!current() || uploading.value) return;
  const images = state.confirm();
  if (images?.length) { closed.value = true; emit('selected', images, frozenContext); close(); }
}
function imageFailed(id: number) { if (current()) failedImages.value = new Set([...failedImages.value, id]); }
async function refresh() {
  if (!current() || uploading.value) return;
  failedImages.value = new Set(); await state.retry();
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = '';
  if (!file || !current() || !canUpload.value || uploading.value) return;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) {
    uploadMessage.value = '请选择不超过10 MiB的 JPEG、PNG、WebP 或 GIF 图片'; return;
  }
  const requestedFolder = folder.value;
  const body = new FormData(); body.append('file', file); body.append('pid', String(requestedFolder));
  uploading.value = true; uploadMessage.value = '';
  try {
    await uploadSupplierImage(body, uploadController.signal);
    if (!current()) return;
    uploadMessage.value = '上传成功，请从当前分类选择图片';
    filter.value = ''; await state.load({ pid: requestedFolder, name: '', page: 1 });
  } catch {
    if (!current()) return;
    // A response can be lost after storage succeeds. Never repeat a write here.
    unknownUpload.value = true;
    uploadMessage.value = '未能确认上传结果，请重读图片列表核对。关闭后重新进入才能再次上传。';
    await state.load({ pid: requestedFolder, name: '', page: 1 });
  } finally { if (alive) uploading.value = false; }
}
watch(() => props.modelValue, open => { if (open && !closed.value) void readFolder(); else { closed.value = true; state.reset(); uploadController.abort(); } }, { immediate: true });
watch(() => props.contextKey, key => { if (key !== frozenContext) close(); });
watch(invalidated, value => { if (value) { uploadController.abort(); close(); } });
onBeforeUnmount(() => { alive = false; uploadController.abort(); state.dispose(); });
</script>

<template>
  <el-dialog :model-value="modelValue" title="选择商品图片" width="min(880px, 96vw)" append-to-body :close-on-click-modal="false" @update:model-value="(value: boolean) => !value && close()">
    <p class="picker-note">从当前供应商素材中选择；确认后只更新商品表单。</p>
    <nav class="folders" aria-label="图片分类路径">
      <el-button v-for="(item, index) in trail" :key="item.id" link :disabled="uploading || invalidated" @click="parentFolder(index)">{{ item.name }}</el-button>
    </nav>
    <div class="folders" v-loading="categoriesLoading">
      <el-button v-for="item in categories" :key="item.id" :disabled="uploading || invalidated" @click="enterFolder(item.id, item.name)">📁 {{ item.name }}</el-button>
      <span v-if="!categories.length && !categoriesLoading && !categoriesError" class="picker-note">没有子分类</span>
    </div>
    <div v-if="categoriesError" role="alert"><p>分类读取失败，请重试。</p><el-button :disabled="categoriesLoading || invalidated" @click="state.retryCategories">重读分类</el-button></div>
    <div class="picker-toolbar">
      <el-input v-model="filter" aria-label="搜索当前分类图片" maxlength="80" placeholder="搜索当前分类图片名称" @keyup.enter="search" />
      <el-button :disabled="uploading || invalidated" @click="search">搜索</el-button>
      <el-button :disabled="uploading || loading || invalidated" @click="refresh">重读图片</el-button>
      <el-button v-if="auth.can('supplier.attachment.manage')" :loading="uploading" :disabled="!canUpload" @click="uploadInput?.click()">上传图片</el-button>
      <input ref="uploadInput" class="hidden-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" aria-label="上传商品图片" @change="upload" />
    </div>
    <p v-if="uploadMessage" role="status">{{ uploadMessage }}</p>
    <div v-if="error" role="alert"><p>{{ error }}；未更新图片，请重试。</p><el-button :disabled="loading || invalidated" @click="refresh">重试图片列表</el-button></div>
    <section v-loading="loading" class="image-grid" aria-label="当前分类图片">
      <p v-if="!rows.length && !loading && !error">当前分类没有匹配图片</p>
      <button v-for="image in rows" :key="image.id" class="image-card" type="button" :aria-label="`选择图片 ${image.name}`" :aria-pressed="selected.some(item => item.id === image.id)" :disabled="loading || !!error || uploading || invalidated" @click="state.toggle(image.id)">
        <img v-if="!failedImages.has(image.id)" :src="image.thumbnailUrl" :alt="image.name" loading="lazy" referrerpolicy="no-referrer" @error="imageFailed(image.id)" />
        <span v-else class="missing-image">预览不可用，可重读图片</span>
        <span class="image-name">{{ image.name }}</span>
        <span v-if="selected.some(item => item.id === image.id)" class="chosen">已选择</span>
      </button>
    </section>
    <nav v-if="!error" class="picker-pagination" aria-label="图片分页">
      <span>共 {{ count }} 张 · 第 {{ applied.page }} / {{ pages }} 页</span>
      <el-button :disabled="loading || uploading || invalidated || applied.page <= 1" @click="page(applied.page - 1)">上一页</el-button>
      <el-button :disabled="loading || uploading || invalidated || applied.page >= pages" @click="page(applied.page + 1)">下一页</el-button>
    </nav>
    <div v-if="selected.length" class="chosen-list" aria-label="已选图片">
      <el-tag v-for="image in selected" :key="image.id" closable @close="state.remove(image.id)">{{ image.name }}</el-tag>
    </div>
    <template #footer>
      <div class="picker-footer"><span>已选 {{ selected.length }} / {{ limit }} 张</span><el-button @click="close">取消</el-button><el-button type="primary" :disabled="!canConfirm || uploading" @click="confirm">使用所选图片</el-button></div>
    </template>
  </el-dialog>
</template>

<style scoped>
.picker-note { color: var(--el-text-color-secondary); }
.folders, .picker-toolbar, .picker-pagination, .chosen-list, .picker-footer { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 12px 0; }
.picker-toolbar .el-input { flex: 1; min-width: 160px; }
.image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(125px, 1fr)); gap: 12px; min-height: 100px; max-height: 45vh; overflow: auto; }
.image-card { border: 1px solid var(--el-border-color); background: var(--el-bg-color); border-radius: 8px; padding: 8px; text-align: left; cursor: pointer; min-width: 0; }
.image-card[aria-pressed="true"] { border-color: var(--el-color-primary); }
.image-card:disabled { cursor: default; opacity: .6; }
.image-card img, .missing-image { width: 100%; aspect-ratio: 1; object-fit: contain; display: block; background: var(--el-fill-color-light); }
.missing-image { display: grid; place-items: center; text-align: center; font-size: 12px; }
.image-name { display: block; overflow-wrap: anywhere; margin-top: 6px; }
.chosen { display: block; color: var(--el-color-primary); }
.picker-footer { justify-content: flex-end; margin: 0; }
.hidden-input { display: none; }
</style>
