<template>
  <el-button v-if="pending" class="recover-video" @click="emit('update:open', true)">查看视频上传记录</el-button>
  <el-dialog :model-value="open" title="上传商品视频" width="min(680px, 95vw)" @update:model-value="emit('update:open', $event)" @closed="stopTransfer">
    <p>支持100 MiB以内的MP4。上传完成后选择“使用这个视频”，再保存商品。</p>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" show-icon />
    <p v-if="pending" class="upload-id">上传记录 {{ pending.upload_id }}</p>
    <p v-if="receipt?.manifest">原文件：{{ receipt.manifest.filename }} · {{ formatBytes(receipt.manifest.total_size) }}</p>
    <p v-if="receipt" role="status">{{ stateName }}</p>
    <p v-if="phase" role="status">{{ phase }}</p>
    <el-progress v-if="receipt?.manifest" :percentage="percentage" :status="receipt.state === 'committed' ? 'success' : undefined" />
    <p v-if="receipt?.manifest">服务器已确认 {{ formatBytes(confirmedBytes) }} / {{ formatBytes(receipt.manifest.total_size) }}</p>
    <template v-if="!receipt || ['unknown', 'active'].includes(receipt.state)">
      <label class="file-label">{{ pending ? '重新选择原MP4文件以恢复' : '选择MP4文件' }}<input type="file" accept="video/mp4,.mp4" :disabled="!canUpload || busy" @change="chooseFile" /></label>
      <p v-if="selectedFile">已选择：{{ selectedFile.name }} · {{ formatBytes(selectedFile.size) }}</p>
      <p v-if="pending">刷新或请求失去响应后，先查询记录，再选择同一文件继续。更换文件请先取消本次上传。</p>
    </template>
    <div class="video-actions">
      <el-button v-if="!storageReady" @click="loadPending">重新读取本机恢复记录</el-button>
      <el-button v-if="!receipt || ['unknown', 'active'].includes(receipt.state)" type="primary" :disabled="!canUpload || !selectedFile || busy" @click="upload(false)">{{ pending ? '核对原文件并继续上传' : '开始上传' }}</el-button>
      <el-button v-if="pending" :disabled="busy" @click="query">查询上传结果</el-button>
      <el-button v-if="busy" @click="stopTransfer">停止传输</el-button>
      <el-button v-if="pending && receipt?.state !== 'committed' && receipt?.state !== 'cancelled'" type="danger" plain @click="cancel">取消本次上传</el-button>
      <el-button v-if="receipt?.state === 'active' && receipt.confirmed.length" :disabled="!canUpload || !selectedFile || busy" @click="upload(true)">重新传输原文件分片</el-button>
      <el-button v-if="receipt?.state === 'cancelled' || receipt?.state === 'committed'" :disabled="busy || !canUpload" @click="fresh">开始另一个上传</el-button>
    </div>
    <p v-if="!canUpload">上传需要当前商品可编辑，并具有素材管理权限；原账号仍可查询或取消自己的未完成记录。</p>
    <template v-if="receipt?.result">
      <p>素材 #{{ receipt.result.id }} 已保存。{{ receipt.result.url }}</p>
      <video v-if="previewSrc" :src="previewSrc" controls preload="metadata" aria-label="已上传视频预览" />
      <p v-else>视频已保存，预览暂不可用。</p>
      <el-button type="primary" :disabled="disabled || busy" @click="apply">使用这个视频</el-button>
    </template>
    <p v-if="receipt?.state === 'expired'">上传记录已过期，请取消本次上传后重新选择文件。</p>
    <p v-if="receipt?.state === 'cancelled'">本次上传已取消，迟到的请求不会创建素材。</p>
    <p>取消上传与移除商品视频分别处理。已经提交的素材会保留在素材库中。</p>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getAdminSession, getToken } from '@/utils/auth';
import { apiVideoCancel, apiVideoComplete, apiVideoInitialize, apiVideoPart, apiVideoPreview, apiVideoQuery,
  parsePendingVideo, videoConfirmedBytes, videoFileManifest, type PendingVideoUpload, type VideoManifest, type VideoReceipt } from '@/api/productVideoUpload';

const props = defineProps<{ open: boolean; disabled: boolean; contextKey: string }>();
const emit = defineEmits<{ (event: 'update:open', value: boolean): void; (event: 'use', value: { url: string; src: string }): void }>();
const pending = ref<PendingVideoUpload | null>(null), receipt = ref<VideoReceipt | null>(null), selectedFile = ref<File | null>(null);
const busy = ref(false), phase = ref(''), error = ref(''), previewSrc = ref(''), sessionVersion = ref(0), storageReady = ref(false);
let alive = true, epoch = 0, controller: AbortController | null = null;
const key = (actor: number) => `cinashop.product-video.pending.v1.${actor}`;
const identity = () => {
  const session = getAdminSession(), token = getToken();
  if (!session || !token || !Number.isSafeInteger(session.userInfo.id) || session.userInfo.id < 1) throw Error('请先登录');
  return { actor: session.userInfo.id, token, session: JSON.stringify(session), context: props.contextKey };
};
const canUpload = computed(() => { void sessionVersion.value; const session = getAdminSession(); return storageReady.value && !props.disabled && !!getToken() && !!session
  && (session.userInfo.level === 0 || session.uniqueAuth.includes('attachment.manage')); });
const canPreview = () => { const session = getAdminSession(); return !!session && (session.userInfo.level === 0
  || session.uniqueAuth.includes('attachment.view') || session.uniqueAuth.includes('attachment.manage')); };
const confirmedBytes = computed(() => videoConfirmedBytes(receipt.value));
const percentage = computed(() => receipt.value?.manifest ? Math.min(100, Math.floor(confirmedBytes.value / receipt.value.manifest.total_size * 100)) : 0);
const stateName = computed(() => ({ unknown: '原请求尚未建立会话，可核对原文件继续。', active: '上传尚未提交为素材。',
  expired: '本次上传已过期。', cancelled: '本次上传已取消。', committed: '视频素材已提交。' })[receipt.value?.state ?? 'unknown']);
const formatBytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;
const message = (reason: unknown) => reason instanceof Error ? reason.message : '视频操作失败';
function stopTransfer() { epoch++; controller?.abort(); controller = null; busy.value = false; phase.value = ''; }
function begin() {
  const who = identity(); stopTransfer(); controller = new AbortController(); busy.value = true; error.value = '';
  return { ...who, epoch, signal: controller.signal };
}
function current(run: ReturnType<typeof begin>) {
  try { const who = identity(); return alive && run.epoch === epoch && who.actor === run.actor && who.token === run.token
    && who.session === run.session && who.context === run.context; } catch { return false; }
}
function end(run: ReturnType<typeof begin>) { if (current(run)) { busy.value = false; phase.value = ''; controller = null; } }
function loadPending() {
  stopTransfer(); pending.value = null; receipt.value = null; previewSrc.value = ''; selectedFile.value = null; error.value = ''; storageReady.value = false; sessionVersion.value++;
  try { const who = identity(), raw = sessionStorage.getItem(key(who.actor)); pending.value = parsePendingVideo(raw, who.actor); storageReady.value = true; }
  catch (reason) { error.value = message(reason); }
}
function chooseFile(event: Event) { const input = event.target as HTMLInputElement; selectedFile.value = input.files?.[0] ?? null; input.value = ''; error.value = ''; }
async function loadPreview(run: ReturnType<typeof begin>) {
  previewSrc.value = '';
  if (!pending.value || !receipt.value?.result || !canPreview()) return;
  try { const src = await apiVideoPreview(pending.value, receipt.value.result.url, run.signal); if (current(run)) previewSrc.value = src; }
  catch (reason) { if (current(run)) error.value = `视频已保存，预览暂不可用：${message(reason)}`; }
}
async function query() {
  if (!pending.value) return;
  const run = begin(), operation = { ...pending.value };
  try { const value = await apiVideoQuery(operation, run.signal); if (!current(run)) return; receipt.value = value; await loadPreview(run); }
  catch (reason) { if (current(run)) error.value = `结果尚未确认，请重试查询：${message(reason)}`; }
  finally { end(run); }
}
const sameManifest = (a: VideoManifest, b: VideoManifest) => a.filename === b.filename && a.total_size === b.total_size && a.chunk_size === b.chunk_size
  && a.pid === b.pid && a.sha256.length === b.sha256.length && a.sha256.every((hash, index) => hash === b.sha256[index]);
async function upload(repair: boolean) {
  if (!canUpload.value || !selectedFile.value || busy.value) return;
  const run = begin(), file = selectedFile.value;
  try {
    if (!pending.value) {
      const operation = { upload_id: crypto.randomUUID(), actor_id: run.actor };
      // A storage failure must stop BEFORE any server mutation.
      sessionStorage.setItem(key(run.actor), JSON.stringify(operation)); pending.value = operation;
    }
    const operation = { ...pending.value }, known = await apiVideoQuery(operation, run.signal);
    if (!current(run)) return; receipt.value = known;
    if (known.state === 'committed') { await loadPreview(run); return; }
    if (!['unknown', 'active'].includes(known.state)) throw Error('原上传已取消或过期，请先处理原记录');
    phase.value = '正在核对原文件';
    const manifest = await videoFileManifest(file, known.manifest?.chunk_size, () => current(run), bytes => { if (current(run)) phase.value = `正在校验文件 ${formatBytes(bytes)} / ${formatBytes(file.size)}`; });
    if (!current(run)) return;
    manifest.pid = known.manifest?.pid ?? 0;
    if (known.manifest && !sameManifest(manifest, known.manifest)) throw Error('文件与原上传不同，请选择同一文件，或先取消本次上传');
    const initialized = await apiVideoInitialize(operation, manifest, run.signal);
    if (!current(run)) return; receipt.value = initialized;
    if (initialized.state === 'committed') { await loadPreview(run); return; }
    if (initialized.state !== 'active') throw Error('原上传不再接受分片，请查询原结果');
    for (let index = 1; index <= manifest.sha256.length; index++) {
      if (!current(run)) return;
      if (!repair && receipt.value.confirmed.includes(index)) continue;
      phase.value = `正在传输第 ${index} / ${manifest.sha256.length} 片`;
      const bytes = new Uint8Array(await file.slice((index - 1) * manifest.chunk_size, index * manifest.chunk_size).arrayBuffer());
      if (!current(run)) return;
      const accepted = await apiVideoPart(operation, index, bytes, run.signal);
      if (!current(run)) return; receipt.value = accepted;
      if (accepted.state === 'committed') break;
    }
    phase.value = '所有分片已确认，正在保存视频素材';
    const completed = await apiVideoComplete(operation, run.signal);
    if (!current(run)) return; receipt.value = completed;
    if (completed.state !== 'committed') throw Error('视频保存结果尚未确认，请查询原记录');
    selectedFile.value = null; await loadPreview(run);
  } catch (reason) { if (current(run)) error.value = `上传尚未确认，请查询原记录：${message(reason)}`; }
  finally { end(run); }
}
async function cancel() {
  if (!pending.value) return;
  const run = begin(), operation = { ...pending.value };
  try { const value = await apiVideoCancel(operation, run.signal); if (!current(run)) return; receipt.value = value; selectedFile.value = null;
    if (value.state === 'committed') { error.value = '视频已经提交，素材会保留；可选择使用或开始另一个上传。'; await loadPreview(run); }
  } catch (reason) { if (current(run)) error.value = `取消结果尚未确认，请查询原记录：${message(reason)}`; }
  finally { end(run); }
}
function fresh() {
  if (!canUpload.value || busy.value || !pending.value || !['committed', 'cancelled'].includes(receipt.value?.state ?? '')) return;
  try { sessionStorage.removeItem(key(identity().actor)); pending.value = null; receipt.value = null; previewSrc.value = ''; selectedFile.value = null; error.value = ''; }
  catch (reason) { error.value = message(reason); }
}
function apply() {
  if (props.disabled || busy.value || !pending.value || !receipt.value?.result || pending.value.actor_id !== identity().actor) return;
  emit('use', { url: receipt.value.result.url, src: previewSrc.value }); emit('update:open', false);
}
function changed() { loadPending(); if (props.open && pending.value) void query(); }
const storageChanged = (event: StorageEvent) => { if (event.key === null || ['admin_token', 'admin_session'].includes(event.key)) changed(); };
onMounted(() => { loadPending(); window.addEventListener('admin-session-changed', changed); window.addEventListener('admin-auth-expired', changed); window.addEventListener('storage', storageChanged); });
watch(() => props.open, open => { if (open && pending.value && !busy.value) void query(); });
watch(() => props.contextKey, () => { stopTransfer(); selectedFile.value = null; previewSrc.value = ''; });
onBeforeUnmount(() => { alive = false; stopTransfer(); window.removeEventListener('admin-session-changed', changed); window.removeEventListener('admin-auth-expired', changed); window.removeEventListener('storage', storageChanged); });
</script>

<style scoped>
.recover-video{margin-top:16px}.file-label{display:grid;gap:10px;margin:20px 0}.upload-id{overflow-wrap:anywhere;color:var(--el-text-color-secondary);font-size:12px}.video-actions{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.video-actions .el-button{margin:0}video{display:block;width:100%;max-height:360px;background:#111;margin:16px 0}p{line-height:1.6}
</style>
