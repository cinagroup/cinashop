<template>
  <section class="customer-editor" aria-label="悬浮客服组件编辑器">
    <strong>页面悬浮按钮</strong>
    <p class="hint">设置本页面的圆形按钮、跳转和初始位置。它与全局悬浮导航分别维护；修改后保存页面生效。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else>
      <div class="toolbar"><el-button :disabled="!canEdit" @click="add">添加页面悬浮按钮</el-button></div>
      <template v-if="entries.length">
        <el-select :model-value="selected" aria-label="选择页面悬浮按钮" @update:model-value="select"><el-option v-for="entry in entries" :key="entry.index" :label="`第 ${entry.index + 1} 项 · 页面悬浮按钮`" :value="entry.index" /></el-select>
        <div class="toolbar"><el-button :disabled="!canEdit || position <= 0" @click="move(-1)">在本族中上移</el-button><el-button :disabled="!canEdit || position >= entries.length - 1" @click="move(1)">在本族中下移</el-button><el-button :disabled="!canEdit" type="danger" @click="remove">删除当前悬浮按钮</el-button></div>
        <el-alert v-if="project.error" :title="project.error" type="warning" :closable="false" />
        <el-form v-if="block" label-position="top" :disabled="!canEdit">
          <div class="fields">
            <el-form-item label="组件显示"><el-select :model-value="project.value?.enabled ?? true" @update:model-value="setVisible"><el-option label="显示" :value="true" /><el-option label="隐藏并保留配置" :value="false" /></el-select></el-form-item>
            <el-form-item label="按钮跳转"><el-select :model-value="project.value?.service ? 1 : 0" @update:model-value="setMode"><el-option label="页面链接" :value="0" /><el-option label="客服入口（采用站点客服配置）" :value="1" /></el-select></el-form-item>
            <el-form-item label="显示位置"><el-select :model-value="project.value?.right ? 1 : 0" @update:model-value="setSide"><el-option label="左侧" :value="0" /><el-option label="右侧" :value="1" /></el-select></el-form-item>
            <el-form-item label="初始上下偏移（%）"><el-input-number :model-value="offset" :min="0" :max="80" @update:model-value="setOffset" /><span class="hint">数值 0 采用默认 30%，最大显示偏移为 80%。</span></el-form-item>
            <el-form-item label="图标稳定地址"><el-input :model-value="logo" @update:model-value="setLogo" /></el-form-item>
            <el-form-item label="页面链接"><el-input :model-value="link" maxlength="2048" @update:model-value="setLink" /></el-form-item>
          </div>
          <div class="toolbar"><SeckillActivityImagePicker :key="mediaSession.key" :editor-key="mediaSession.key" :disabled="!canChooseMedia" title="选择悬浮按钮图标" @choose="mediaSession.choose" /><el-button :disabled="!canEdit || !pageId || !pagePublished || previewLoading" :loading="previewLoading" @click="loadPreview">读取已发布图标预览</el-button></div>
        </el-form>
        <p class="hint">建议使用 100×100 图片，客户端按 86rpx 圆形显示。临时预览地址不会写入页面；导入原值和其它组件保持完整，只有明确编辑的字段会改变。</p>
        <p class="hint">微信小程序采用原生客服会话时，由站点客服配置决定，优先于按钮跳转选择。</p>
        <el-alert v-if="error" :title="error" type="warning" :closable="false" />
        <div class="preview" aria-label="悬浮按钮位置预览"><div v-if="project.value?.enabled" class="preview-button" :style="{top: `${project.value.topPercent}%`, left: project.value.right ? 'auto' : '10px', right: project.value.right ? '10px' : 'auto'}"><img v-if="preview" :src="preview" alt="悬浮按钮图标" /><span v-else>图标</span></div></div>
      </template>
      <p v-else class="hint">本页面没有悬浮按钮，可添加后配置图标和目标。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import { customerServiceRecord as record, newDiyCustomerService, readDiyCustomerService } from '../../../../common/diyCustomerService';
import { canonicalCustomerServiceBlock, customerServiceDocument, customerServicePreview } from '@/utils/diyCustomerServiceEditor';
import { canonicalPresentationReference } from '@/utils/diyPresentationEditor';
const props = withDefaults(defineProps<{modelValue: string; editorKey: string; disabled?: boolean; pageId?: number; pagePublished?: boolean}>(), {disabled: false, pageId: 0, pagePublished: false});
const emit = defineEmits<{ 'update:modelValue': [value: string] }>(), auth = useAuthStore();
const selected = ref(-1), revision = ref(0), previewLoading = ref(false), error = ref(''), previews = ref<Record<string, string>>({});
let alive = true, controller: AbortController | null = null, lastCommittedValue = '';
const actor = () => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
const canEdit = computed(() => !props.disabled && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('dise.manage')));
const canChooseMedia = computed(() => canEdit.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.view')));
const parsed = computed(() => { try { return {value: customerServiceDocument(props.modelValue), error: ''}; } catch (reason) { return {value: null, error: reason instanceof Error ? reason.message : '装修 JSON 无效'}; } });
const entries = computed(() => (parsed.value.value ?? []).flatMap((value, index) => record(value)?.name === 'customerService' ? [{index}] : []).sort((a, b) => {
  const left = Number(record(parsed.value.value?.[a.index])?.timestamp), right = Number(record(parsed.value.value?.[b.index])?.timestamp);
  return (Number.isFinite(left) ? left : Number.MAX_SAFE_INTEGER) - (Number.isFinite(right) ? right : Number.MAX_SAFE_INTEGER);
}));
const block = computed(() => record(parsed.value.value?.[selected.value])), position = computed(() => entries.value.findIndex(entry => entry.index === selected.value));
const project = computed(() => { try { return {value: readDiyCustomerService(block.value), error: ''}; } catch (reason) { return {value: null, error: reason instanceof Error ? reason.message : '配置无效'}; } });
const logo = computed(() => typeof record(block.value?.logoConfig)?.url === 'string' ? record(block.value?.logoConfig)!.url as string : '');
const link = computed(() => typeof record(block.value?.logoConfig)?.link === 'string' ? record(block.value?.logoConfig)!.link as string : '');
const offset = computed(() => { const value = record(block.value?.topConfig)?.val; return typeof value === 'number' || typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) ? Number(value) : 0; });
const preview = computed(() => customerServicePreview(logo.value, previews.value[canonicalPresentationReference(logo.value)] ?? logo.value));
const stamp = () => `${actor()}:${props.editorKey}:${revision.value}:${selected.value}:${props.modelValue}`;
const current = (issued: string) => alive && canEdit.value && auth.token === getToken() && issued === stamp();
function invalidate() { revision.value++; controller?.abort(); controller = null; previewLoading.value = false; previews.value = {}; error.value = ''; }
watch(entries, value => { if (!value.some(entry => entry.index === selected.value)) selected.value = value[0]?.index ?? -1; }, {immediate: true, flush: 'sync'});
watch(() => props.modelValue, invalidate, {flush: 'sync'});
watch(() => props.editorKey, () => { invalidate(); selected.value = entries.value[0]?.index ?? -1; }, {flush: 'sync'});
watch(() => props.disabled, value => { if (value) invalidate(); }, {flush: 'sync'});
watch(() => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}`, invalidate, {flush: 'sync'});
window.addEventListener('admin-session-changed', invalidate); window.addEventListener('admin-auth-expired', invalidate); window.addEventListener('storage', invalidate);
onBeforeUnmount(() => { alive = false; invalidate(); window.removeEventListener('admin-session-changed', invalidate); window.removeEventListener('admin-auth-expired', invalidate); window.removeEventListener('storage', invalidate); });
function commit(value: unknown[]) {
  if (!alive || !canEdit.value || auth.token !== getToken()) return false;
  try { const raw = JSON.stringify(value, null, 2); customerServiceDocument(raw); lastCommittedValue = raw; invalidate(); emit('update:modelValue', raw); return true; }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '无法完整保存'; return false; }
}
function edit(change: (row: Record<string, unknown>) => void) { if (!parsed.value.value || block.value?.name !== 'customerService') return false; const value = structuredClone(parsed.value.value), row = record(value[selected.value]); if (!row) return false; change(row); return commit(value); }
function select(value: unknown) { if (typeof value === 'number' && entries.value.some(entry => entry.index === value)) { invalidate(); selected.value = value; } }
function add() { if (!parsed.value.value) return; const value = structuredClone(parsed.value.value), maximum = value.reduce<number>((max, row) => Math.max(max, Number.isFinite(Number(record(row)?.timestamp)) ? Number(record(row)?.timestamp) : 0), 0); if (!Number.isSafeInteger(maximum) || maximum >= Number.MAX_SAFE_INTEGER) { error.value = '排序值无法增加，请先在 JSON 中调整'; return; } value.push(newDiyCustomerService(maximum + 1)); if (commit(value)) selected.value = value.length - 1; }
function remove() { if (!parsed.value.value || block.value?.name !== 'customerService') return; const value = structuredClone(parsed.value.value); value.splice(selected.value, 1); if (commit(value)) selected.value = -1; }
function move(direction: number) { if (!parsed.value.value || ![-1, 1].includes(direction)) return; const neighbour = entries.value[position.value + direction]; if (!neighbour) return; const from = selected.value, to = neighbour.index, value = structuredClone(parsed.value.value), a = record(value[from])!, b = record(value[to])!; const ah = Object.hasOwn(a, 'timestamp'), bh = Object.hasOwn(b, 'timestamp'), at = a.timestamp, bt = b.timestamp; if (bh) a.timestamp = bt; else delete a.timestamp; if (ah) b.timestamp = at; else delete b.timestamp; [value[from], value[to]] = [value[to], value[from]]; if (commit(value)) selected.value = to; }
function setVisible(value: unknown) { if (typeof value === 'boolean') edit(row => { row.isHide = !value; }); }
function setMode(value: unknown) { if (value === 0 || value === 1) edit(row => { row.buttonConfig = {...record(row.buttonConfig), tabVal: value}; }); }
function setSide(value: unknown) { if (value === 0 || value === 1) edit(row => { row.locationConfig = {...record(row.locationConfig), tabVal: value}; }); }
function setOffset(value: unknown) { if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 80) edit(row => { row.topConfig = {...record(row.topConfig), val: value}; }); }
function setLink(value: unknown) { if (typeof value === 'string' && value.length <= 2048) edit(row => { row.logoConfig = {...record(row.logoConfig), link: value}; }); }
function setLogo(value: unknown) {
  if (typeof value !== 'string') return false;
  const reference = canonicalPresentationReference(value.trim());
  if (reference.length > 4096 || reference && (!/^(?:https:\/\/|\/(?!\/))/iu.test(reference) || /[\u0000-\u0020\u007f\\]/u.test(reference))) { error.value = '请输入有效的稳定 HTTPS 或站内图片地址'; return false; }
  return edit(row => { row.logoConfig = {...record(row.logoConfig), url: reference}; });
}
const mediaSession = computed(() => {
  const issued = stamp(), key = `${props.editorKey}:${revision.value}:${selected.value}`, actorAtIssue = actor(), editor = props.editorKey;
  return {key, choose: async (reference: string, signed: string) => {
    if (!current(issued) || !canChooseMedia.value || typeof reference !== 'string' || typeof signed !== 'string') return;
    const approved = customerServicePreview(reference, signed), index = selected.value;
    if (!setLogo(reference)) return;
    const expected = lastCommittedValue;
    // The parent v-model patches child props on the next Vue turn. Let that
    // ordinary invalidation finish, then admit this exact edit's same-asset
    // preview only if its actor, page, selection and complete value survived.
    await nextTick();
    if (alive && canChooseMedia.value && actor() === actorAtIssue && props.editorKey === editor && selected.value === index && props.modelValue === expected && canonicalPresentationReference(logo.value) === canonicalPresentationReference(reference) && approved) previews.value = {[canonicalPresentationReference(reference)]: approved};
  }};
});
function comparable(value: Record<string, unknown>) { const copy = canonicalCustomerServiceBlock(value); delete copy.routine_contact_type; return JSON.stringify(copy); }
async function loadPreview() {
  if (!alive || !canEdit.value || block.value?.name !== 'customerService' || !props.pageId || !props.pagePublished) return;
  controller?.abort(); const pending = new AbortController(), issued = stamp(), id = props.pageId, expected = comparable(block.value); controller = pending; previewLoading.value = true; error.value = '';
  try {
    const response = await fetch(`/api/diy/get_diy/${id}`, {credentials: 'omit', cache: 'no-store', signal: pending.signal});
    const body = record(await response.json()), data = record(body?.data);
    if (!current(issued) || props.pageId !== id || !props.pagePublished || pending.signal.aborted) return;
    if (!response.ok || body?.status !== 200 || !Array.isArray(data?.value)) throw Error('公开图标预览暂不可用，请检查发布状态');
    const found = data.value.map(record).find(row => row?.name === 'customerService' && comparable(row) === expected);
    if (!found) throw Error('当前配置与已发布页面不一致，请保存后再读取');
    const signed = record(found.logoConfig)?.url, approved = customerServicePreview(logo.value, signed);
    previews.value = approved ? {[canonicalPresentationReference(logo.value)]: approved} : {};
    if (!approved) throw Error('图标尚未获准公开预览，请检查素材');
  } catch (reason) { if (current(issued)) error.value = reason instanceof Error ? reason.message : '图标读取失败'; }
  finally { if (controller === pending) { controller = null; previewLoading.value = false; } }
}
</script>
<style scoped>
.customer-editor{display:grid;gap:12px;width:100%;padding:14px;border:1px solid var(--el-border-color);border-radius:8px;box-sizing:border-box}.hint{margin:0;color:var(--el-text-color-secondary);font-size:12px;line-height:1.7}.toolbar{display:flex;gap:10px;flex-wrap:wrap}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.fields :deep(.el-select),.fields :deep(.el-input-number){width:100%}.preview{position:relative;width:min(375px,100%);height:360px;background:#f5f5f5;border:1px solid #ddd;box-sizing:border-box}.preview-button{position:absolute;width:43px;height:43px;border-radius:50%;background:#e8e8e8;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:12px;color:#666}.preview-button img{width:100%;height:100%;border-radius:50%}@media(max-width:620px){.fields{grid-template-columns:1fr}}
</style>
