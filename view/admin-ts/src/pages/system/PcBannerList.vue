<template>
  <main class="pc-banners">
    <header class="heading"><div><h2>PC 主页轮播</h2><p class="hint">管理 PC 首页轮播的全部字段。前台按排序从高到低显示，同排序按记录 ID 从大到小，最多展示前 10 条；后台可管理全部记录。</p></div><el-button v-if="canView" :disabled="busy || confirming || restoring || readingReceipt || loading" @click="reload">重新读取</el-button></header>
    <el-alert v-if="!canView" title="当前账号没有 PC 轮播查看权限" type="warning" :closable="false" show-icon />
    <template v-else>
      <el-alert v-if="!canManage" title="当前账号仅可查看 PC 轮播" type="info" :closable="false" show-icon />
      <el-alert v-if="recoveryError" :title="recoveryError" type="error" :closable="false" show-icon><template #default>已暂停写入，请保留本地原请求记录并核对结果。</template></el-alert>
      <el-alert v-if="pending" title="有一项轮播提交结果尚未确认，已暂停新的写入" type="warning" :closable="false" show-icon>
        <template #default><p>原请求 {{ pending.input.request_id }}；{{ operationLabel(pending.operation) }}{{ pending.id ? ` #${pending.id}` : '' }}。</p><div class="buttons"><el-button :loading="readingReceipt" :disabled="busy || confirming || restoring" @click="readReceipt">读取提交结果</el-button><el-button v-if="retryReady && canManage" type="primary" :disabled="busy || confirming || readingReceipt" @click="retryOriginal">重新提交原请求</el-button></div><details><summary>保留的原请求</summary><pre>{{ JSON.stringify(pending, null, 2) }}</pre></details></template>
      </el-alert>
      <el-alert v-if="notice" :title="notice" :type="noticeSuccess ? 'success' : 'warning'" :closable="false" show-icon />
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><template #default><p v-if="snapshot">下方保留上次读取的数据，尚未确认最新状态；请重新读取后再修改。</p></template></el-alert>
      <el-alert v-if="snapshot && !snapshot.group_present" title="PC 轮播组尚未建立，读取不会创建数据" type="info" :closable="false" show-icon><template #default>有管理权限时，可完整填写默认表单并确认新增，由服务端创建轮播组。</template></el-alert>
      <el-alert v-if="snapshot?.group?.issues.length" :title="snapshot.group.fields.length ? '轮播字段提示' : '轮播组元数据异常，已暂停全部写入'" type="warning" :closable="false" show-icon><template #default><ul><li v-for="(issue, index) in snapshot.group.issues" :key="index">{{ issue }}</li></ul></template></el-alert>
      <section class="toolbar" aria-label="轮播筛选">
        <el-select v-model="draftStatus" aria-label="轮播显示筛选" :disabled="!canView || locked" placeholder="全部状态"><el-option label="全部状态" value="all" /><el-option label="显示" :value="1" /><el-option label="隐藏" :value="0" /></el-select>
        <el-button :disabled="locked" @click="query">查询</el-button>
        <el-button v-if="canManage" type="primary" :disabled="!writable || locked" @click="add">新增轮播</el-button>
      </section>
      <div v-loading="loading" class="table-wrap">
        <el-table :data="snapshot?.list || []" row-key="id" border empty-text="暂无轮播记录" :max-height="650">
          <el-table-column prop="id" label="ID" width="76" />
          <el-table-column v-for="field in fields" :key="field.key" :label="field.label || field.key" :min-width="imageField(field) ? 170 : 190">
            <template #default="{ row }"><template v-if="imageField(field)"><div class="image-list"><el-image v-for="(image, index) in images(row, field)" :key="`${row.id}:${field.key}:${index}`" :src="image" :preview-src-list="images(row, field)" preview-teleported fit="cover" /><span v-if="!images(row, field).length" class="hint">无可读预览</span></div><span class="cell-text">{{ displayValue(row.values[field.key]) }}</span></template><span v-else class="cell-text">{{ displayValue(row.values[field.key]) }}</span></template>
          </el-table-column>
          <el-table-column prop="sort" label="排序" width="88" />
          <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 1 ? 'success' : 'info'">{{ row.status === 1 ? '显示' : row.status === 0 ? '隐藏' : `异常 ${row.status}` }}</el-tag></template></el-table-column>
          <el-table-column label="历史诊断" min-width="230"><template #default="{ row }"><p v-if="!row.editable" class="issue">内容损坏，只可隐藏或删除</p><ul v-if="row.issues.length" class="issues"><li v-for="(issue, index) in row.issues" :key="index">{{ issue }}</li></ul><span v-else class="hint">—</span></template></el-table-column>
          <el-table-column v-if="canManage" label="操作" width="218"><template #default="{ row }"><div class="row-actions"><el-button link type="primary" :disabled="!writable || locked || !row.editable" @click="edit(row)">编辑</el-button><el-button link :disabled="!writable || locked || !row.editable && row.status === 0" @click="setStatus(row)">{{ row.editable && row.status === 0 ? '显示' : '隐藏' }}</el-button><el-button link type="danger" :disabled="!writable || locked" @click="remove(row)">删除</el-button></div></template></el-table-column>
        </el-table>
      </div>
      <el-pagination :current-page="applied.page" :page-size="applied.limit" :page-sizes="[20, 50, 100]" :total="snapshot?.count || 0" layout="total, sizes, prev, pager, next" :disabled="locked" @current-change="pageChanged" @size-change="sizeChanged" />
      <el-dialog :model-value="!!editor" :title="editor?.id ? `编辑轮播 #${editor.id}` : '新增 PC 轮播'" width="min(760px, calc(100vw - 24px))" :close-on-click-modal="false" :close-on-press-escape="!confirming && !busy" @close="closeEditor">
        <template v-if="editor">
          <el-alert v-if="editorError" :title="editorError" type="error" :closable="false" show-icon />
          <el-alert v-if="editor.issues.length" title="请核对并修复以下历史字段" type="warning" :closable="false"><template #default><ul><li v-for="(issue, index) in editor.issues" :key="index">{{ issue }}</li></ul></template></el-alert>
          <p class="hint">所有字段都需完整填写。图片保存稳定素材地址，签名预览链接仅用于显示。</p>
          <el-form label-position="top" :disabled="editorLocked" class="editor-form">
            <el-form-item v-for="field in editor.fields" :key="field.key" :label="field.label || field.key" required>
              <el-radio-group v-if="pcBannerFieldType(field) === 'radio'" :model-value="textValue(field)" :disabled="editorLocked" :aria-label="field.label || field.key" @update:model-value="setValue(field, $event)"><el-radio v-for="choice in field.choices" :key="choice.value" :value="choice.value">{{ choice.label }}</el-radio></el-radio-group>
              <el-checkbox-group v-else-if="pcBannerFieldType(field) === 'checkbox'" :model-value="arrayValue(field)" :disabled="editorLocked" :aria-label="field.label || field.key" @update:model-value="setValue(field, $event)"><el-checkbox v-for="choice in field.choices" :key="choice.value" :value="choice.value">{{ choice.label }}</el-checkbox></el-checkbox-group>
              <el-select v-else-if="pcBannerFieldType(field) === 'select'" :model-value="textValue(field)" :disabled="editorLocked" :aria-label="field.label || field.key" :placeholder="field.placeholder || '请选择'" @update:model-value="setValue(field, $event)"><el-option v-for="choice in field.choices" :key="choice.value" :label="choice.label" :value="choice.value" /></el-select>
              <div v-else-if="imageField(field)" class="image-field">
                <template v-if="pcBannerFieldType(field) !== 'uploads'"><el-image v-if="editorImage(field, 0)" :src="editorImage(field, 0)" fit="cover" /><el-input :model-value="textValue(field)" :disabled="editorLocked" :aria-label="`${field.label || field.key}稳定地址`" maxlength="255" placeholder="从图库选择，或填写稳定图片地址" @update:model-value="setValue(field, $event)" /></template>
                <template v-else><div v-for="(reference, index) in arrayValue(field)" :key="index" class="upload-row"><el-image v-if="editorImage(field, index)" :src="editorImage(field, index)" fit="cover" /><el-input :model-value="reference" :disabled="editorLocked" :aria-label="`${field.label || field.key}第${index + 1}张稳定地址`" maxlength="255" @update:model-value="setImage(field, index, $event)" /><el-button :disabled="editorLocked" @click="removeImage(field, index)">移除</el-button></div><el-button :disabled="editorLocked || arrayValue(field).length >= 5" @click="appendImage(field)">添加图片地址</el-button></template>
                <SeckillActivityImagePicker :disabled="editorLocked || pcBannerFieldType(field) === 'uploads' && arrayValue(field).length >= 5" :editor-key="`${identity}:${editor.key}:${field.key}`" :title="`选择${field.label || field.key}`" @choose="(reference, preview) => chooseImage(field, reference, preview)" /><p class="hint">{{ pcBannerFieldType(field) === 'uploads' ? '1至5张，按当前顺序保存。' : '单张图片。' }}</p>
              </div>
              <el-input v-else :model-value="textValue(field)" :type="pcBannerFieldType(field) === 'textarea' ? 'textarea' : 'text'" :rows="pcBannerFieldType(field) === 'textarea' ? 4 : undefined" :maxlength="field.key === 'title' ? 4096 : field.key === 'url' ? 2048 : pcBannerFieldType(field) === 'textarea' ? 10000 : 4096" :placeholder="field.placeholder" :disabled="editorLocked" :aria-label="field.label || field.key" @update:model-value="setValue(field, $event)" />
            </el-form-item>
            <el-form-item label="排序" required><el-input-number v-model="editor.sort" :min="0" :max="2147483647" :precision="0" :disabled="editorLocked" aria-label="轮播排序" /><p class="hint">数值越大越靠前，同排序的新记录优先。</p></el-form-item>
            <el-form-item label="状态" required><el-radio-group v-model="editor.status" :disabled="editorLocked" aria-label="轮播状态"><el-radio :value="1">显示</el-radio><el-radio :value="0">隐藏</el-radio></el-radio-group></el-form-item>
          </el-form>
        </template>
        <template #footer><el-button :disabled="confirming || busy" @click="closeEditor">取消</el-button><el-button type="primary" :disabled="editorLocked" @click="saveEditor">保存轮播</el-button></template>
      </el-dialog>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { getAdminSession, getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import { apiPcBannerList, apiPcBannerDetail, apiPcBannerWrite, apiPcBannerReceipt, normalizePcBannerIntent,
  pcBannerFieldType, pcBannerPreview, pcBannerFingerprint, pcBannerPendingKey, parsePcBannerPending,
  assertPcBannerReceipt, pcBannerReceiptNotFound, isPcBannerStale,
  type PcBannerField, type PcBannerValues, type PcBannerRow, type PcBannerList, type PcBannerQuery,
  type PcBannerIntent, type PcBannerPending, type PcBannerReceipt, type PcBannerOperation } from '@/api/pcBanner';

const auth = useAuthStore();
const canView = computed(() => !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('pc_home_banner.view')));
const canManage = computed(() => canView.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('pc_home_banner.manage')));
const identity = computed(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`);
const snapshot = ref<PcBannerList | null>(null), applied = ref<PcBannerQuery>({ page: 1, limit: 20 }), draftStatus = ref<'all' | 0 | 1>('all');
const ready = ref(false), loading = ref(false), detailLoading = ref(false), error = ref('');
const pending = ref<PcBannerPending | null>(null), recoveryError = ref(''), restoring = ref(false), retryReady = ref(false);
const busy = ref(false), confirming = ref(false), readingReceipt = ref(false), notice = ref(''), noticeSuccess = ref(false);
const fields = computed(() => snapshot.value?.group?.fields ?? snapshot.value?.default_fields ?? []);
const writable = computed(() => canManage.value && ready.value && !!snapshot.value && fields.value.length > 0);
const locked = computed(() => loading.value || detailLoading.value || busy.value || confirming.value || restoring.value || readingReceipt.value || !!pending.value || !!recoveryError.value);
type Editor = { id: number; key: string; revision: string; fields: PcBannerField[]; values: PcBannerValues; sort: number | undefined; status: 0 | 1 | null; issues: string[]; previews: Record<string, string[]> };
const editor = ref<Editor | null>(null), editorError = ref(''), editorLocked = computed(() => !writable.value || locked.value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Stamp = { generation: number; identity: string; stored: string | null };
type Job = { stamp: Stamp; controller: AbortController };
let alive = false, syncing = false, generation = 0, confirmationId = 0, stored = localStorage.getItem('admin_session');
const jobs = new Map<string, Job>();
const stamp = (): Stamp => ({ generation, identity: identity.value, stored });
const current = (scope: Stamp) => alive && canView.value && scope.generation === generation && scope.identity === identity.value && scope.stored === localStorage.getItem('admin_session') && auth.token === getToken();
const message = (reason: unknown) => { const value = reason instanceof Error ? reason.message : '请求失败'; return typeof value === 'string' && value.length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '请求失败，请重新读取并核对'; };
const operationLabel = (operation: PcBannerOperation) => ({ create: '新增', update: '编辑', status: '修改显隐', delete: '删除' })[operation];
const imageField = (field: PcBannerField) => field.key === 'image' || ['upload', 'uploads'].includes(pcBannerFieldType(field));
function cancel(channel: string) { jobs.get(channel)?.controller.abort(); jobs.delete(channel); }
function start(channel: string): Job { cancel(channel); const job = { stamp: stamp(), controller: new AbortController() }; jobs.set(channel, job); return job; }
function valid(channel: string, job: Job) { return jobs.get(channel) === job && current(job.stamp); }
function finish(channel: string, job: Job) { if (!valid(channel, job)) return false; jobs.delete(channel); return true; }
function displayValue(value: unknown) { return value === null || value === undefined ? '字段待修复' : Array.isArray(value) ? value.join('、') : String(value); }
function images(row: PcBannerRow, field: PcBannerField) { return (row.image_previews[field.key] ?? (field.key === 'image' ? [row.image_preview] : [])).map(pcBannerPreview).filter(Boolean); }
function textValue(field: PcBannerField): string { const value = editor.value?.values[field.key]; return typeof value === 'string' ? value : ''; }
function arrayValue(field: PcBannerField): string[] { const value = editor.value?.values[field.key]; return Array.isArray(value) ? value : []; }
function setValue(field: PcBannerField, value: unknown) {
  if (!current(stamp()) || editorLocked.value || !editor.value) return;
  if (typeof value === 'string' || Array.isArray(value) && value.every(item => typeof item === 'string')) { editor.value.values[field.key] = Array.isArray(value) ? [...value] : value; if (imageField(field)) delete editor.value.previews[field.key]; }
}
function editorImage(field: PcBannerField, index: number): string { const references = pcBannerFieldType(field) === 'uploads' ? arrayValue(field) : [textValue(field)]; return pcBannerPreview(editor.value?.previews[field.key]?.[index] || references[index]); }
function setImage(field: PcBannerField, index: number, value: string) { if (editorLocked.value || !editor.value) return; const items = [...arrayValue(field)]; items[index] = value; setValue(field, items); }
function appendImage(field: PcBannerField) { if (!editorLocked.value && arrayValue(field).length < 5) setValue(field, [...arrayValue(field), '']); }
function removeImage(field: PcBannerField, index: number) { if (!editorLocked.value) setValue(field, arrayValue(field).filter((_, position) => position !== index)); }
function chooseImage(field: PcBannerField, reference: string, preview: string) {
  if (!current(stamp()) || editorLocked.value || !editor.value) return;
  if (pcBannerFieldType(field) === 'uploads') { const existing = arrayValue(field); if (existing.length >= 5) return; const previews = existing.map((_, index) => editorImage(field, index)); setValue(field, [...existing, reference]); editor.value.previews[field.key] = [...previews, preview]; }
  else { setValue(field, reference); editor.value.previews[field.key] = [preview]; }
}
async function load(query: PcBannerQuery = applied.value) {
  if (!current(stamp()) || busy.value || confirming.value) return;
  const job = start('list'); loading.value = true; ready.value = false; error.value = '';
  try { const result = await apiPcBannerList(query, job.controller.signal); if (!valid('list', job)) return; snapshot.value = result; applied.value = { ...query }; ready.value = true; }
  catch (reason) { if (valid('list', job)) error.value = message(reason); }
  finally { if (finish('list', job)) loading.value = false; }
}
async function reload() { if (!current(stamp()) || busy.value || confirming.value || restoring.value || readingReceipt.value) return; closeEditor(); await load(); }
function query() { if (!locked.value) { closeEditor(); void load({ page: 1, limit: applied.value.limit, ...(draftStatus.value === 'all' ? {} : { status: draftStatus.value }) }); } }
function pageChanged(page: number) { if (!locked.value && page !== applied.value.page) { closeEditor(); void load({ ...applied.value, page }); } }
function sizeChanged(limit: number) { if (!locked.value && limit !== applied.value.limit) { closeEditor(); void load({ ...applied.value, page: 1, limit }); } }
function closeEditor() { if (busy.value || confirming.value) return; cancel('detail'); detailLoading.value = false; editor.value = null; editorError.value = ''; }
function add() {
  if (!current(stamp()) || !writable.value || locked.value || !snapshot.value) return;
  editorError.value = ''; editor.value = { id: 0, key: crypto.randomUUID(), revision: snapshot.value.revision, fields: clone(fields.value),
    values: Object.fromEntries(fields.value.map(field => [field.key, ['checkbox', 'uploads'].includes(pcBannerFieldType(field)) ? [] : ''])), sort: 1, status: 1, issues: [], previews: {} };
}
async function edit(row: PcBannerRow) {
  if (!current(stamp()) || !writable.value || locked.value || !row.editable) return;
  closeEditor(); const job = start('detail'); detailLoading.value = true; notice.value = '';
  try { const result = await apiPcBannerDetail(row.id, job.controller.signal); if (!valid('detail', job) || !canManage.value) return;
    if (!result.info.editable || !result.group.fields.length) throw Error('该轮播内容或组元数据已变化，不能编辑，请重新读取');
    editor.value = { id: row.id, key: crypto.randomUUID(), revision: result.info.revision, fields: result.group.fields,
      values: clone(result.info.values), sort: result.info.sort >= 0 ? result.info.sort : undefined, status: result.info.status === 0 || result.info.status === 1 ? result.info.status : null,
      issues: result.info.issues, previews: clone(result.info.image_previews) };
  } catch (reason) { if (valid('detail', job)) notice.value = message(reason); }
  finally { if (finish('detail', job)) detailLoading.value = false; }
}
function clearPending(frozen: PcBannerPending) {
  const key = pcBannerPendingKey(frozen.actor);
  if (sessionStorage.getItem(key) !== JSON.stringify(frozen)) throw Error('本地原轮播请求记录已发生变化，请保留记录并核对');
  sessionStorage.removeItem(key); pending.value = null; retryReady.value = false;
}
function accept(result: PcBannerReceipt, frozen: PcBannerPending) {
  assertPcBannerReceipt(result, frozen); clearPending(frozen); editor.value = null; noticeSuccess.value = true; notice.value = `轮播${operationLabel(frozen.operation)}已确认，将重新读取当前列表。`;
}
async function submitOriginal(frozen: PcBannerPending) {
  if (!current(stamp()) || !canManage.value || busy.value || readingReceipt.value || pending.value?.input.request_id !== frozen.input.request_id) return;
  const job = start('write'); busy.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiPcBannerWrite({ operation: frozen.operation, id: frozen.id, input: frozen.input }, job.controller.signal); if (valid('write', job) && canManage.value) accept(result, frozen); }
  catch (reason) { if (!valid('write', job)) return;
    if (isPcBannerStale(reason, frozen)) { try { clearPending(frozen); editor.value = null; ready.value = false; notice.value = '轮播版本已改变，本次未保存。重新读取最新列表后，请核对并再次确认。'; } catch (failure) { recoveryError.value = message(failure); } }
    else notice.value = `提交结果未确认：${message(reason)}。请读取原请求回执，不能发起新的写入。`;
  } finally { if (finish('write', job)) busy.value = false; }
  if (current(job.stamp) && !pending.value && !recoveryError.value) await load();
}
async function confirmWrite(intent: PcBannerIntent, description: string, metadata?: PcBannerField[]) {
  if (!current(stamp()) || !writable.value || locked.value) return;
  const scope = stamp(), version = ++confirmationId; confirming.value = true; notice.value = ''; editorError.value = ''; noticeSuccess.value = false; let frozen: PcBannerPending | null = null;
  try {
    const normalized = normalizePcBannerIntent(intent, metadata), fingerprint = await pcBannerFingerprint(normalized);
    if (!current(scope) || !canManage.value || version !== confirmationId) return;
    await ElMessageBox.confirm(description, `确认${operationLabel(intent.operation)}轮播`, { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '取消' });
    if (!current(scope) || !canManage.value || version !== confirmationId || pending.value || recoveryError.value) return;
    frozen = { version: 1, actor: auth.userInfo!.id, ...normalized, fingerprint };
    const key = pcBannerPendingKey(frozen.actor);
    if (sessionStorage.getItem(key) !== null) { recoveryError.value = '已有未完成轮播请求记录，请重新读取页面并核对'; throw Error(recoveryError.value); }
    sessionStorage.setItem(key, JSON.stringify(frozen)); pending.value = frozen; editor.value = null;
  } catch (reason) { if (current(scope) && reason !== 'cancel' && reason !== 'close') { notice.value = message(reason); if (editor.value) editorError.value = notice.value; } }
  finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && frozen && pending.value?.input.request_id === frozen.input.request_id) await submitOriginal(frozen);
}
function saveEditor() {
  if (!editor.value || editorLocked.value) return; const item = editor.value;
  void confirmWrite({ operation: item.id ? 'update' : 'create', id: item.id, input: { request_id: crypto.randomUUID(), revision: item.revision, values: clone(item.values), sort: item.sort, status: item.status as 0 | 1 } }, `确认${item.id ? `保存轮播 #${item.id}` : '新增轮播'}的全部 ${item.fields.length} 个字段？排序 ${item.sort}，状态${item.status === 1 ? '显示' : '隐藏'}。`, item.fields);
}
function setStatus(row: PcBannerRow) { if (!row.editable && row.status === 0) return; const status = row.editable && row.status === 0 ? 1 : 0; void confirmWrite({ operation: 'status', id: row.id, input: { request_id: crypto.randomUUID(), revision: row.revision, status } }, `确认将轮播 #${row.id}${status ? '显示' : '隐藏'}？`); }
function remove(row: PcBannerRow) { void confirmWrite({ operation: 'delete', id: row.id, input: { request_id: crypto.randomUUID(), revision: row.revision } }, `确认删除轮播 #${row.id}？删除后不再展示，记录将移除。`); }
async function readReceipt() {
  if (!current(stamp()) || !pending.value || busy.value || confirming.value || readingReceipt.value || restoring.value) return;
  const frozen = pending.value, job = start('receipt'); readingReceipt.value = true; retryReady.value = false; notice.value = ''; noticeSuccess.value = false;
  try { const result = await apiPcBannerReceipt(frozen.input.request_id, job.controller.signal); if (valid('receipt', job)) accept(result, frozen); }
  catch (reason) { if (valid('receipt', job)) { if (pcBannerReceiptNotFound(reason)) { retryReady.value = true; notice.value = '明确未发现该请求回执。可主动重试原请求，UUID、版本和全部原内容保持不变。'; } else notice.value = `提交结果仍未确认：${message(reason)}`; } }
  finally { if (finish('receipt', job)) readingReceipt.value = false; }
  if (current(job.stamp) && !pending.value && !recoveryError.value) await load();
}
async function retryOriginal() {
  if (!pending.value || !retryReady.value || !canManage.value || busy.value || readingReceipt.value || confirming.value || !current(stamp())) return;
  const frozen = pending.value, scope = stamp(), version = ++confirmationId; confirming.value = true;
  try { await ElMessageBox.confirm(`确认重新提交原请求 ${frozen.input.request_id}？原操作、版本及内容保持不变。`, '重试原请求', { type: 'warning', confirmButtonText: '重试原请求', cancelButtonText: '取消' }); }
  catch { return; } finally { if (current(scope) && version === confirmationId) confirming.value = false; }
  if (current(scope) && version === confirmationId && canManage.value && pending.value === frozen && retryReady.value) await submitOriginal(frozen);
}
async function restore() {
  if (!current(stamp()) || !auth.userInfo) return; const scope = stamp(); restoring.value = true;
  try { const raw = sessionStorage.getItem(pcBannerPendingKey(auth.userInfo.id)); if (!raw) return; const saved = await parsePcBannerPending(raw, auth.userInfo.id); if (current(scope)) pending.value = saved; }
  catch (reason) { if (current(scope)) recoveryError.value = `原轮播请求无法安全恢复：${message(reason)}`; }
  finally { if (current(scope)) restoring.value = false; }
}
function invalidate() {
  generation++; confirmationId++; if (confirming.value) ElMessageBox.close(); for (const job of jobs.values()) job.controller.abort(); jobs.clear();
  snapshot.value = null; editor.value = null; pending.value = null; applied.value = { page: 1, limit: 20 }; draftStatus.value = 'all';
  ready.value = loading.value = detailLoading.value = busy.value = confirming.value = readingReceipt.value = restoring.value = retryReady.value = false;
  error.value = notice.value = recoveryError.value = editorError.value = ''; noticeSuccess.value = false;
}
async function boot() { const scope = stamp(); await restore(); if (current(scope)) await load(); }
function syncStored(event?: Event) {
  if (syncing || event instanceof StorageEvent && event.key !== null && !['admin_token', 'admin_session'].includes(event.key)) return;
  syncing = true; invalidate(); const session = getAdminSession(); auth.$patch({ token: getToken() ?? '', userInfo: session?.userInfo ?? null, menus: (session?.menus as typeof auth.menus) ?? [], uniqueAuth: session?.uniqueAuth ?? [] }); stored = localStorage.getItem('admin_session'); syncing = false; void boot();
}
watch(identity, () => { if (alive && !syncing) { invalidate(); stored = localStorage.getItem('admin_session'); void boot(); } }, { flush: 'sync' });
onMounted(() => { alive = true; window.addEventListener('storage', syncStored); window.addEventListener('admin-session-changed', syncStored); window.addEventListener('admin-auth-expired', syncStored); syncStored(); });
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('storage', syncStored); window.removeEventListener('admin-session-changed', syncStored); window.removeEventListener('admin-auth-expired', syncStored); });
</script>

<style scoped>
.pc-banners{display:grid;gap:16px;min-width:0}.heading{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.heading h2{font-size:20px;margin:0}.hint{font-size:13px;color:var(--el-text-color-secondary);line-height:1.65;margin:6px 0;overflow-wrap:anywhere}.toolbar,.buttons,.row-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.toolbar .el-select{width:160px}.buttons{margin:10px 0}.buttons .el-button+.el-button,.row-actions .el-button+.el-button{margin-left:0}.table-wrap{min-width:0;overflow:hidden}.cell-text{display:block;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto;font-size:13px;line-height:1.6}.image-list{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.image-list .el-image{width:70px;height:48px}.issues{padding-left:16px;margin:0;font-size:12px;line-height:1.6}.issue{color:var(--el-color-danger);font-size:12px}.image-field{width:100%;display:grid;gap:10px;justify-items:start}.image-field .el-image{width:120px;height:80px}.image-field>.el-input,.editor-form .el-select{width:100%}.upload-row{display:flex;align-items:center;gap:8px;width:100%}.upload-row .el-image{flex:0 0 80px;width:80px;height:60px}.upload-row .el-input{flex:1;min-width:0}.editor-form{margin-top:12px;max-height:60vh;overflow-y:auto;padding-right:6px}.editor-form :deep(.el-form-item__label){height:auto;line-height:1.5;overflow-wrap:anywhere}.editor-form .hint{width:100%}pre{max-height:230px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.pc-banners :deep(.el-alert__content){min-width:0;overflow-wrap:anywhere}.pc-banners :deep(.el-pagination){flex-wrap:wrap;gap:8px}
@media(max-width:600px){.heading h2{font-size:18px}.toolbar{align-items:stretch}.toolbar .el-select{width:100%}.toolbar .el-button{margin-left:0}.upload-row{flex-wrap:wrap}.upload-row .el-input{flex-basis:calc(100% - 90px)}.editor-form{max-height:55vh}.pc-banners :deep(.el-dialog__body){padding:12px}.pc-banners :deep(.el-pagination){font-size:12px}}
</style>
