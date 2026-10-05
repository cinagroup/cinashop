<template>
  <div class="seckill-times">
    <div class="heading">
      <div><h2>秒杀时段</h2><p class="hint">设置每日秒杀时间、图片和描述。所有时段（含隐藏）不能重叠；删除时会检查未结束秒杀活动的占用。</p></div>
      <div class="actions">
        <el-button v-if="canView" :loading="loading" :disabled="submitting || confirming" @click="load()">刷新</el-button>
        <el-button v-if="canManage" type="primary" :disabled="!loaded || loading || submitting || confirming" @click="openForm(0)">添加秒杀时段</el-button>
      </div>
    </div>
    <el-alert v-if="!canView" title="当前账号没有秒杀时段查看权限" type="warning" :closable="false" show-icon />
    <el-card v-else shadow="never">
      <div class="filters">
        <label class="filter-field"><span>时段名称</span><el-input v-model="draftTitle" aria-label="秒杀时段搜索" maxlength="100" clearable placeholder="时段名称关键词" :disabled="submitting" @keyup.enter="search" /></label>
        <label class="filter-field status-field"><span>显示状态</span>
          <el-select v-model="draftStatus" aria-label="秒杀时段状态" :disabled="submitting" @change="search"><el-option label="全部状态" value="" /><el-option label="显示" :value="1" /><el-option label="隐藏" :value="0" /></el-select>
        </label>
        <div class="actions"><el-button type="primary" :disabled="submitting" @click="search">查询</el-button><el-button :disabled="submitting" @click="reset">重置</el-button></div>
      </div>
      <el-alert v-if="actionNotice" :title="actionNotice" type="warning" :closable="false" show-icon class="notice" />
      <el-alert v-if="listError" :title="listError" type="error" :closable="false" show-icon class="notice"><template #default><el-button link type="primary" @click="load()">重新读取时段</el-button></template></el-alert>
      <div v-else class="table-scroll">
        <p v-if="compactTable" class="hint">左右滑动表格可查看时间、图片、描述和操作。</p>
        <el-table :data="list" v-loading="loading" border row-key="id" :empty-text="loading ? '加载中…' : '暂无秒杀时段'">
          <el-table-column prop="id" label="编号" width="65" />
          <el-table-column label="时段名称" min-width="150"><template #default="{ row }">{{ row.title || '待修复' }}<el-tag v-if="!row.valid" type="danger" size="small">内容无效</el-tag></template></el-table-column>
          <el-table-column prop="start_time" label="开始时间" width="100" />
          <el-table-column prop="end_time" label="结束时间" width="100" />
          <el-table-column label="时段图片" width="105"><template #default="{ row }"><el-image v-if="previewFor(row)" :src="previewFor(row)" :preview-src-list="[previewFor(row)]" preview-teleported fit="cover" class="row-image" /><span v-else class="hint">暂无图片</span></template></el-table-column>
          <el-table-column prop="describe" label="时段描述" min-width="170" show-overflow-tooltip />
          <el-table-column label="状态" width="100"><template #default="{ row }">
            <el-switch v-if="canManage" :model-value="row.status" :active-value="1" :inactive-value="0" inline-prompt active-text="显示" inactive-text="隐藏"
              :aria-label="`时段${row.id}显示状态`" :disabled="submitting || confirming || (!row.valid && row.status === 0)" @change="toggleVisibility(row)" />
            <el-tag v-else :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '显示' : '隐藏' }}</el-tag>
          </template></el-table-column>
          <el-table-column v-if="canManage" label="操作" width="140" :fixed="compactTable ? false : 'right'"><template #default="{ row }"><el-button link type="primary" :disabled="submitting || confirming" @click="openForm(row.id)">编辑</el-button><el-button link type="danger" :disabled="submitting || confirming" @click="remove(row)">删除</el-button></template></el-table-column>
        </el-table>
      </div>
      <el-pagination v-if="!loading && !listError" :current-page="page" :page-size="PAGE_SIZE" :total="count"
        :page-count="Math.min(Math.max(1, Math.ceil(count / PAGE_SIZE)), MAX_PAGE)" :pager-count="5" :disabled="submitting || confirming"
        layout="total, prev, pager, next" class="pager" @current-change="load" />
      <p v-if="count > MAX_PAGE * PAGE_SIZE" class="hint">可浏览前 {{ MAX_PAGE * PAGE_SIZE }} 项，请按名称或状态缩小范围。</p>
    </el-card>

    <el-dialog v-model="formVisible" :title="formId ? '编辑秒杀时段' : '添加秒杀时段'" width="min(560px, calc(100vw - 24px))"
      :close-on-click-modal="false" :close-on-press-escape="!submitting && !assetUploading" :show-close="!submitting && !assetUploading" @closed="onFormClosed">
      <div v-loading="formLoading">
        <el-alert v-if="formError" :title="formError" type="error" :closable="false" show-icon class="notice"><template v-if="!form" #default><el-button link type="primary" @click="openForm(formId)">重新读取表单</el-button></template></el-alert>
        <el-alert v-if="formInvalid" :title="`历史时段内容无效，请补齐图片、描述和合法时间。原时间：${originalTimes}。修复期间可选择隐藏状态。`" type="warning" :closable="false" show-icon class="notice" />
        <el-form v-if="form" label-position="top" :disabled="submitting || assetUploading">
          <el-form-item label="时段名称" required><el-input v-model="form.title" aria-label="时段名称" maxlength="255" show-word-limit /></el-form-item>
          <div class="time-fields">
            <el-form-item label="开始时间" required><el-input v-model="startSelection" aria-label="开始时间" type="time" step="60" /></el-form-item>
            <el-form-item label="结束时间" required><el-input v-model="endSelection" aria-label="结束时间" type="time" step="60" :disabled="midnightEnd" /><el-checkbox v-model="midnightEnd" aria-label="结束于午夜24:00">午夜 24:00</el-checkbox></el-form-item>
          </div>
          <p class="hint form-hint">使用 24 小时制 HH:mm；开始时间早于结束时间，不跨午夜。相邻时段可以首尾相接。</p>
          <el-form-item label="时段图片" required>
            <div class="image-field"><el-input v-model="form.pic" aria-label="时段图片地址" maxlength="255" placeholder="HTTPS 地址或站内图片路径" @input="formPreview = ''" />
              <el-button :disabled="!canChooseAssets" @click="openAssetPicker">从图库选择</el-button>
            </div>
            <p v-if="!canChooseAssets" class="hint">从图库选择需要素材查看权限；可填写已有图片地址。</p>
            <el-image v-if="formImage" :src="formImage" :preview-src-list="[formImage]" preview-teleported fit="contain" class="form-image" />
          </el-form-item>
          <el-form-item label="时段描述" required><el-input v-model="form.describe" aria-label="时段描述" maxlength="255" show-word-limit /></el-form-item>
          <el-form-item label="状态"><el-radio-group v-model="form.status" aria-label="时段显示状态"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></el-form-item>
        </el-form>
      </div>
      <template #footer><el-button :disabled="submitting || assetUploading" @click="formVisible = false">取消</el-button><el-button v-if="canManage" type="primary" :loading="submitting" :disabled="!form || formLoading || assetUploading" @click="save">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="assetVisible" title="选择时段图片" width="min(800px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="!assetUploading" :show-close="!assetUploading" @closed="onAssetsClosed">
      <div class="asset-toolbar">
        <el-select v-model="assetPid" aria-label="图库分类" :disabled="assetUploading" @change="searchAssets"><el-option label="全部分类" :value="0" /><el-option v-for="item in assetCategories" :key="item.id" :label="item.name" :value="item.id" /></el-select>
        <el-input v-model="assetName" aria-label="图库文件名" clearable placeholder="搜索图片文件名" :disabled="assetUploading" @keyup.enter="searchAssets" />
        <el-button :disabled="assetUploading" @click="searchAssets">查询图片</el-button>
        <el-upload v-if="canUploadAssets" :show-file-list="false" accept="image/jpeg,image/png,image/webp,image/gif" :disabled="assetUploading" :http-request="uploadAsset"><el-button type="primary" :loading="assetUploading">上传图片</el-button></el-upload>
      </div>
      <p class="hint">选择图库图片保存稳定地址；上传沿用素材管理权限。单张最大 10 MiB。</p>
      <el-alert v-if="assetCategoryError" :title="assetCategoryError" type="warning" :closable="false" class="notice"><template #default><el-button link type="primary" @click="openAssetPicker">重新读取图库分类</el-button></template></el-alert>
      <el-alert v-if="assetError" :title="assetError" type="error" :closable="false" class="notice"><template #default><el-button link type="primary" @click="loadAssets()">重新读取图片</el-button></template></el-alert>
      <div v-else v-loading="assetLoading" class="asset-grid">
        <article v-for="item in assets" :key="item.att_id" class="asset-card"><el-image :src="imagePreview(item.satt_dir || item.att_dir)" :preview-src-list="[imagePreview(item.att_dir)]" preview-teleported fit="cover" class="asset-image" /><span :title="item.real_name">{{ item.real_name }}</span><el-button :disabled="assetUploading || assetLoading" @click="chooseAsset(item)">选择图片</el-button></article>
        <el-empty v-if="!assetLoading && !assets.length" description="暂无可选图片" />
      </div>
      <el-pagination v-if="!assetLoading && !assetError" :current-page="assetPage" :page-size="20" :total="assetCount" :pager-count="5" :disabled="assetUploading" layout="prev, pager, next" class="pager" @current-change="loadAssets" />
      <template #footer><el-button :disabled="assetUploading" @click="assetVisible = false">取消</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import { AdminResponseError } from '@/utils/request';
import { apiSeckillTimeList, apiSeckillTimeDetail, apiSeckillTimeSave, apiSeckillTimeStatus, apiSeckillTimeDelete,
  normalizeSeckillTimeInput, imagePreview, type SeckillTime, type SeckillTimeInput, type SeckillTimeMutationKey, type SeckillTimeSave } from '@/api/seckillTime';
import { apiAttachmentList, apiAttachmentCategories, apiAttachmentUpload, type AttachmentItem, type AttachmentCategoryItem } from '@/api/attachment';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('seckill_time.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('seckill_time.manage')));
const canChooseAssets = computed(() => canManage.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.view')));
const canUploadAssets = computed(() => canChooseAssets.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.manage')));
const sessionKey = computed(() => `${auth.token}:${auth.userInfo?.id ?? 0}:${auth.userInfo?.level ?? ''}:${auth.uniqueAuth.join(',')}`);
const PAGE_SIZE = 20, MAX_PAGE = Math.floor(10_000 / PAGE_SIZE) + 1;
const compactTable = ref(window.innerWidth <= 768), updateTableWidth = () => { compactTable.value = window.innerWidth <= 768; };
const draftTitle = ref(''), title = ref(''), draftStatus = ref<'' | 0 | 1>(''), status = ref<'' | 0 | 1>('');
const list = ref<SeckillTime[]>([]), count = ref(0), page = ref(1), loading = ref(false), loaded = ref(false);
const listError = ref(''), actionNotice = ref(''), submitting = ref(false), confirming = ref(false);
const formVisible = ref(false), formLoading = ref(false), formError = ref(''), formId = ref(0), formPreview = ref(''), formInvalid = ref(false), originalTimes = ref('');
const form = ref<(SeckillTimeInput & { revision: string }) | null>(null);
const midnightEnd = computed({ get: () => form.value?.end_time === '24:00', set: (value: boolean) => { if (form.value) form.value.end_time = value ? '24:00' : ''; } });
const startSelection = computed({ get: () => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(form.value?.start_time || '') ? form.value!.start_time : '', set: (value: string) => { if (form.value) form.value.start_time = value; } });
const endSelection = computed({ get: () => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(form.value?.end_time || '') ? form.value!.end_time : '', set: (value: string) => { if (form.value) form.value.end_time = value; } });
const formImage = computed(() => safePreview(form.value?.pic || '', formPreview.value));
interface OperationScope { session: string; generation: number; storedSession: string | null }
type Mutation = { kind: 'save'; id: number; body: SeckillTimeSave } | { kind: 'status'; id: number; body: SeckillTimeMutationKey & { status: 0 | 1 } } | { kind: 'delete'; id: number; body: SeckillTimeMutationKey };
const uncertainOperation = ref<Mutation | null>(null);
let mounted = false, syncing = false, generation = 0, confirmationId = 0, mutationId = 0, formGeneration = 0;
let storedSession = localStorage.getItem('admin_session');
let listAbort: AbortController | null = null, formAbort: AbortController | null = null, mutationAbort: AbortController | null = null;
let formScope: OperationScope | null = null;
const assetVisible = ref(false), assetLoading = ref(false), assetUploading = ref(false), assetError = ref(''), assetCategoryError = ref('');
const assets = ref<AttachmentItem[]>([]), assetCategories = ref<AttachmentCategoryItem[]>([]), assetCount = ref(0), assetPage = ref(1), assetPid = ref(0), assetName = ref('');
let assetGeneration = 0, assetListRequest = 0, assetAbort: AbortController | null = null, assetCategoryAbort: AbortController | null = null, assetUploadAbort: AbortController | null = null;
function scope(): OperationScope { return { session: sessionKey.value, generation, storedSession }; }
function current(stamp: OperationScope) { return mounted && canView.value && stamp.generation === generation && stamp.session === sessionKey.value && auth.token === getToken() && stamp.storedSession === localStorage.getItem('admin_session'); }
function currentRow(row: SeckillTime) { return list.value.some(item => item.id === row.id && item.revision === row.revision); }
function actionable() { return current(scope()) && canManage.value && loaded.value && !loading.value && !submitting.value && !confirming.value; }
function safePreview(pic: string, preview: string) { return imagePreview(preview || (/^\/api\/assets\//u.test(pic) ? '' : pic)); }
function previewFor(row: SeckillTime) { return safePreview(row.pic, row.pic_preview || ''); }
function closeAssets() { assetGeneration++; assetListRequest++; assetAbort?.abort(); assetAbort = null; assetCategoryAbort?.abort(); assetCategoryAbort = null; assetUploadAbort?.abort(); assetUploadAbort = null; assetVisible.value = false; assets.value = []; assetCategories.value = []; assetCount.value = 0; assetLoading.value = false; assetUploading.value = false; assetError.value = ''; assetCategoryError.value = ''; }
function onAssetsClosed() { if (!assetVisible.value) closeAssets(); }
function closeForm() { closeAssets(); formGeneration++; formAbort?.abort(); formAbort = null; formVisible.value = false; formLoading.value = false; form.value = null; formScope = null; formError.value = ''; formPreview.value = ''; formInvalid.value = false; originalTimes.value = ''; }
function onFormClosed() { if (!formVisible.value) closeForm(); }
function clearList() { generation++; listAbort?.abort(); listAbort = null; list.value = []; count.value = 0; listError.value = ''; loading.value = false; loaded.value = false; closeForm(); }
function invalidate() { clearList(); mutationId++; mutationAbort?.abort(); mutationAbort = null; confirmationId++; if (confirming.value) ElMessageBox.close(); confirming.value = false; submitting.value = false; actionNotice.value = ''; uncertainOperation.value = null; }
async function load(targetPage = page.value) {
  if (!mounted || !canView.value || auth.token !== getToken() || storedSession !== localStorage.getItem('admin_session') || !Number.isSafeInteger(targetPage) || targetPage < 1 || targetPage > MAX_PAGE) return;
  clearList(); page.value = targetPage; const stamp = scope(), controller = new AbortController(); listAbort = controller; loading.value = true;
  try {
    const result = await apiSeckillTimeList({ page: targetPage, limit: PAGE_SIZE, title: title.value, status: status.value }, controller.signal);
    if (!current(stamp)) return;
    if (!result.list.length && targetPage > 1) { await load(Math.max(1, Math.min(targetPage - 1, Math.ceil(result.count / PAGE_SIZE)))); return; }
    list.value = result.list; count.value = result.count; loaded.value = true;
  } catch (error) { if (current(stamp)) listError.value = error instanceof Error ? error.message : '秒杀时段加载失败'; }
  finally { if (listAbort === controller) { listAbort = null; loading.value = false; } }
}
function search() { if (submitting.value) return; title.value = draftTitle.value.trim(); status.value = draftStatus.value; actionNotice.value = ''; void load(1); }
function reset() { if (!submitting.value) { draftTitle.value = ''; draftStatus.value = ''; search(); } }
async function openForm(id: number) {
  if (!actionable() || (id !== 0 && !list.value.some(row => row.id === id))) return;
  closeForm(); formId.value = id; formVisible.value = true; formLoading.value = true;
  const stamp = scope(), version = formGeneration, controller = new AbortController(); formScope = stamp; formAbort = controller;
  try {
    const result = id === 0 ? { title: '', start_time: '', end_time: '', pic: '', describe: '', status: 1 as const, revision: '', pic_preview: '', valid: true } : await apiSeckillTimeDetail(id, controller.signal);
    if (!current(stamp) || !canManage.value || version !== formGeneration || !formVisible.value) return;
    form.value = { title: result.title, start_time: result.start_time, end_time: result.end_time, pic: result.pic, describe: result.describe, status: result.status, revision: result.revision }; formPreview.value = result.pic_preview || ''; formInvalid.value = !result.valid; originalTimes.value = `${result.start_time || '缺失'} – ${result.end_time || '缺失'}`;
  } catch (error) { if (current(stamp) && version === formGeneration) formError.value = error instanceof Error ? error.message : '秒杀时段详情加载失败'; }
  finally { if (formAbort === controller) { formAbort = null; formLoading.value = false; } }
}
async function mutate(operation: Mutation, stamp: OperationScope, editorVersion?: number) {
  const stillCurrent = () => current(stamp) && canManage.value && (editorVersion === undefined || editorVersion === formGeneration);
  if (!stillCurrent() || submitting.value) return;
  const requestId = ++mutationId, controller = new AbortController(); mutationAbort = controller; submitting.value = true; actionNotice.value = '';
  try {
    if (operation.kind === 'save') await apiSeckillTimeSave(operation.id, operation.body, controller.signal);
    else if (operation.kind === 'status') await apiSeckillTimeStatus(operation.id, operation.body, controller.signal);
    else await apiSeckillTimeDelete(operation.id, operation.body, controller.signal);
    if (!stillCurrent() || requestId !== mutationId) return;
    uncertainOperation.value = null; ElMessage.success(operation.kind === 'delete' ? '秒杀时段已删除' : operation.kind === 'status' ? '显示状态已更新' : '秒杀时段已保存');
  } catch (error) {
    if (!stillCurrent() || requestId !== mutationId) return;
    const rejected = error instanceof AdminResponseError && [400, 403, 404, 409, 422].includes(Number(error.status));
    uncertainOperation.value = rejected ? null : operation;
    actionNotice.value = `${rejected ? '操作未完成' : '操作结果未确认'}：${error instanceof Error ? error.message : '请求失败'}。请核对重新读取的时段后再操作。`;
  } finally { if (requestId === mutationId) { submitting.value = false; mutationAbort = null; } }
  if (stillCurrent()) await load();
}
async function save() {
  if (!form.value || !formScope || !formVisible.value || !current(formScope) || !canManage.value || submitting.value || formLoading.value || assetUploading.value) return;
  let value: SeckillTimeInput;
  try { value = normalizeSeckillTimeInput(form.value); } catch (error) { formError.value = error instanceof Error ? error.message : '请检查时段内容'; return; }
  formError.value = '';
  await mutate({ kind: 'save', id: formId.value, body: { ...value, request_id: crypto.randomUUID(), ...(formId.value ? { revision: form.value.revision } : {}) } }, formScope, formGeneration);
}
async function confirmAction(row: SeckillTime, action: 'status' | 'delete') {
  if (!actionable() || !currentRow(row)) return;
  if (action === 'status' && row.status === 0 && !row.valid) { actionNotice.value = '时段内容无效，请先编辑修复后再显示。'; return; }
  row = { ...row }; const stamp = scope(), requestId = ++confirmationId; confirming.value = true;
  try { await ElMessageBox.confirm(action === 'delete' ? `确认删除秒杀时段「${row.title || row.id}」？若该时段仍被未结束秒杀活动使用，服务端会拒绝删除。` : `确认${row.status === 1 ? '隐藏' : '显示'}秒杀时段「${row.title || row.id}」？`, action === 'delete' ? '删除秒杀时段' : '更新显示状态', { type: 'warning', confirmButtonText: action === 'delete' ? '确认删除' : '确认', cancelButtonText: '取消' }); }
  catch { return; } finally { if (requestId === confirmationId) confirming.value = false; }
  if (requestId !== confirmationId || !current(stamp) || !canManage.value || !currentRow(row)) return;
  const body = { revision: row.revision, request_id: crypto.randomUUID() };
  await mutate(action === 'delete' ? { kind: 'delete', id: row.id, body } : { kind: 'status', id: row.id, body: { ...body, status: row.status === 1 ? 0 : 1 } }, stamp);
}
function remove(row: SeckillTime) { return confirmAction(row, 'delete'); }
function toggleVisibility(row: SeckillTime) { return confirmAction(row, 'status'); }
function assetsCurrent(stamp: OperationScope, editor: number, version: number) { return current(stamp) && canChooseAssets.value && formVisible.value && !!form.value && editor === formGeneration && version === assetGeneration && assetVisible.value; }
async function openAssetPicker() {
  if (!formScope || !current(formScope) || !canChooseAssets.value || !form.value || submitting.value || formLoading.value || assetUploading.value) return;
  closeAssets(); assetVisible.value = true; assetPid.value = 0; assetName.value = ''; assetPage.value = 1;
  const stamp = scope(), editor = formGeneration, version = assetGeneration, controller = new AbortController(); assetCategoryAbort = controller;
  try {
    const result = await apiAttachmentCategories(controller.signal);
    if (!result || !Array.isArray(result.list) || result.list.some(item => !item || !Number.isSafeInteger(item.id) || item.id < 1 || typeof item.name !== 'string')) throw new Error('图库分类格式错误');
    if (assetsCurrent(stamp, editor, version)) assetCategories.value = result.list;
  }
  catch (error) { if (assetsCurrent(stamp, editor, version)) assetCategoryError.value = error instanceof Error ? error.message : '图库分类读取失败'; }
  finally { if (assetCategoryAbort === controller) assetCategoryAbort = null; }
  if (assetsCurrent(stamp, editor, version)) await loadAssets(1);
}
async function loadAssets(targetPage = assetPage.value) {
  if (!assetVisible.value || !canChooseAssets.value || !formScope || !current(formScope) || !Number.isSafeInteger(targetPage) || targetPage < 1) return;
  assetAbort?.abort(); const controller = new AbortController(); assetAbort = controller;
  const stamp = scope(), editor = formGeneration, version = assetGeneration, requestId = ++assetListRequest;
  assetPage.value = targetPage; assets.value = []; assetCount.value = 0; assetLoading.value = true; assetError.value = '';
  try {
    const result = await apiAttachmentList({ page: targetPage, limit: 20, pid: assetPid.value, name: assetName.value.trim(), file_type: 1 }, controller.signal);
    if (!assetsCurrent(stamp, editor, version) || requestId !== assetListRequest) return;
    if (!result || !Array.isArray(result.list) || !Number.isSafeInteger(result.count) || result.count < 0 || result.list.length > 20 || result.list.length > result.count || result.list.some(item => !item || !Number.isSafeInteger(item.att_id) || item.att_id < 1 || typeof item.canonical_url !== 'string' || typeof item.att_dir !== 'string' || typeof item.satt_dir !== 'string' || typeof item.real_name !== 'string')) throw new Error('图库列表格式错误');
    assets.value = result.list; assetCount.value = result.count;
  } catch (error) { if (assetsCurrent(stamp, editor, version) && requestId === assetListRequest) assetError.value = error instanceof Error ? error.message : '图库读取失败'; }
  finally { if (assetAbort === controller) { assetAbort = null; assetLoading.value = false; } }
}
function searchAssets() { if (!assetUploading.value) void loadAssets(1); }
function chooseAsset(item: AttachmentItem) {
  if (!formScope || !current(formScope) || !canChooseAssets.value || !form.value || !assetVisible.value || assetLoading.value || assetUploading.value || !assets.value.some(row => row.att_id === item.att_id && row.canonical_url === item.canonical_url)) return;
  const reference = item.canonical_url || item.att_dir;
  if (!reference || Array.from(reference).length > 255 || !imagePreview(reference)) { assetError.value = '该图片没有可用的稳定地址，请选择其他图片'; return; }
  form.value.pic = reference; formPreview.value = item.att_dir; closeAssets();
}
async function uploadAsset(options: UploadRequestOptions) {
  if (!formScope || !current(formScope) || !canUploadAssets.value || !assetVisible.value || assetUploading.value || !form.value) return;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(options.file.type) || options.file.size < 1 || options.file.size > 10 * 1024 * 1024) { assetError.value = '请选择不超过 10 MiB 的 JPEG、PNG、WebP 或 GIF 图片'; return; }
  const stamp = scope(), editor = formGeneration, version = assetGeneration, controller = new AbortController(); assetUploadAbort = controller; assetUploading.value = true; assetError.value = '';
  try {
    const result = await apiAttachmentUpload(options.file, assetPid.value, controller.signal);
    if (!result || !Number.isSafeInteger(result.att_id) || result.att_id < 1 || typeof result.src !== 'string' || typeof result.url !== 'string') throw new Error('上传响应格式错误');
    if (assetsCurrent(stamp, editor, version) && canUploadAssets.value) ElMessage.success('图片已上传，请从图库中选择');
  }
  catch (error) { if (assetsCurrent(stamp, editor, version)) assetError.value = `上传结果未确认：${error instanceof Error ? error.message : '请求失败'}。请重新读取图库核对，勿重复上传。`; }
  finally { if (assetUploadAbort === controller) { assetUploadAbort = null; assetUploading.value = false; } }
  if (assetsCurrent(stamp, editor, version)) { const notice = assetError.value; await loadAssets(1); if (notice && assetsCurrent(stamp, editor, version)) assetError.value = notice; }
}
function syncSession() {
  syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] });
  storedSession = localStorage.getItem('admin_session'); syncing = false; page.value = 1; draftTitle.value = ''; title.value = ''; draftStatus.value = ''; status.value = ''; void load(1);
}
function syncStorage(event: StorageEvent) { if (event.key === null || event.key === 'admin_token' || event.key === 'admin_session') syncSession(); }
watch(sessionKey, () => { if (mounted && !syncing) { invalidate(); page.value = 1; void load(1); } }, { flush: 'sync' });
onMounted(() => { mounted = true; window.addEventListener('resize', updateTableWidth); window.addEventListener('admin-session-changed', syncSession); window.addEventListener('admin-auth-expired', syncSession); window.addEventListener('storage', syncStorage); syncSession(); });
onBeforeUnmount(() => { mounted = false; invalidate(); window.removeEventListener('resize', updateTableWidth); window.removeEventListener('admin-session-changed', syncSession); window.removeEventListener('admin-auth-expired', syncSession); window.removeEventListener('storage', syncStorage); });
</script>

<style scoped>
.seckill-times { min-width: 0; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.heading h2 { font-size: 18px; margin: 0 0 8px; }
.hint { color: #737985; font-size: 12px; margin: 5px 0; line-height: 1.6; }
.filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 18px; }
.filter-field { display: flex; flex: 1 1 240px; min-width: 0; flex-direction: column; gap: 6px; font-size: 13px; }
.status-field { flex: 0 1 160px; }
.filter-field :deep(.el-input), .filter-field :deep(.el-select) { width: 100%; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }.actions :deep(.el-button + .el-button) { margin-left: 0; }
.notice { margin-bottom: 14px; }.table-scroll { width: 100%; max-width: 100%; overflow-x: auto; }
.pager { margin-top: 18px; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.time-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }.form-hint { margin: 0 0 18px; }
.image-field { display: flex; flex-wrap: wrap; width: 100%; gap: 8px; }.image-field :deep(.el-input) { flex: 1 1 280px; }.form-image { display: block; width: 120px; height: 90px; margin-top: 10px; }
.row-image { width: 68px; height: 48px; display: block; border-radius: 4px; }
.asset-toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }.asset-toolbar :deep(.el-select) { width: 150px; }.asset-toolbar :deep(.el-input) { flex: 1 1 180px; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; min-height: 130px; }.asset-card { min-width: 0; display: grid; gap: 7px; }.asset-card span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }.asset-image { width: 100%; height: 110px; border-radius: 5px; }
@media (max-width: 600px) { .filters { display: grid; grid-template-columns: minmax(0, 1fr); }.pager { justify-content: center; }.pager :deep(.el-pagination__total) { width: 100%; text-align: center; margin-right: 0; }.asset-toolbar :deep(.el-select) { width: 100%; }.asset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
