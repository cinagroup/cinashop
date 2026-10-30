<template>
  <section class="community-editor" aria-label="社区作者编辑器">
    <strong>种草社区</strong><p class="hint">编辑社区组件的标题、布局与样式，保存页面后生效。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else>
      <div class="toolbar"><el-button :disabled="!canEdit" @click="add">添加社区组件</el-button></div>
      <template v-if="entries.length">
        <el-select :model-value="selected" aria-label="选择社区组件" @update:model-value="select"><el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index + 1} 项 · 种草社区`" /></el-select>
        <div class="toolbar"><el-button :disabled="!canEdit" @click="move(-1)">上移社区组件</el-button><el-button :disabled="!canEdit" @click="move(1)">下移社区组件</el-button><el-button :disabled="!canEdit" type="danger" @click="remove">删除社区组件</el-button></div>
        <template v-if="block">
          <el-form label-position="top" :disabled="!canEdit">
            <div class="fields">
              <el-form-item label="社区组件显示"><el-switch :model-value="!flag(block.isHide)" @update:model-value="setVisible" /></el-form-item>
              <el-form-item label="社区编辑分组"><el-select :model-value="Number(read(block, ['setUp', 'tabVal']) || 0)" @update:model-value="setChoice('setUp', $event)"><el-option label="内容" :value="0" /><el-option label="样式" :value="1" /></el-select></el-form-item>
              <el-form-item label="社区布局"><el-select :model-value="config.layout === 'columns' ? 1 : 0" @update:model-value="setChoice('styleConfig', $event)"><el-option label="左右滑动展示" :value="0" /><el-option label="两列展示（纵向）" :value="1" /></el-select></el-form-item>
              <el-form-item label="社区标题类型"><el-select :model-value="config.titleMode === 'image' ? 0 : 1" @update:model-value="setChoice('titleConfig', $event)"><el-option label="图片标题" :value="0" /><el-option label="文字标题" :value="1" /></el-select></el-form-item>
              <el-form-item v-for="field in [{ key: 'titleTxtConfig', label: '社区标题文字' }, { key: 'rightBntConfig', label: '社区右侧文字' }]" :key="field.key" :label="field.label"><el-input :model-value="text(read(block, [field.key, 'value']))" :maxlength="Math.max(6, text(read(block, [field.key, 'value'])).length)" :aria-label="field.label" @update:model-value="setText(field.key, $event)" /></el-form-item>
              <el-form-item label="社区标题字形"><el-select :model-value="Number(read(block, ['titleText', 'tabVal']) || 0)" @update:model-value="setChoice('titleText', $event)"><el-option label="加粗" :value="0" /><el-option label="正常" :value="1" /><el-option label="倾斜" :value="2" /></el-select></el-form-item>
              <el-form-item v-for="field in lengths" :key="field.key" :label="field.label + (field.key === 'numberConfig' ? '' : '（设计 px）')"><el-input-number :model-value="number(read(block, [field.key, 'val']))" :min="Math.min(field.min, number(read(block, [field.key, 'val'])))" :max="Math.max(field.max, number(read(block, [field.key, 'val'])))" :aria-label="field.label" @update:model-value="setLength(field.key, $event)" /></el-form-item>
            </div>
            <el-form-item label="社区图片标题"><div class="media-field"><p class="stored">{{ text(read(block, ['imgConfig', 'url'])) || '未选择图片' }}</p><SeckillActivityImagePicker :disabled="!canChooseMedia" :editor-key="mediaSessions.imgConfig.key" title="社区图片标题" @choose="mediaSessions.imgConfig.choose" /><el-button :disabled="!canEdit" @click="clearImage('imgConfig')">清空社区图片标题</el-button></div></el-form-item>
            <div class="fields">
              <el-form-item v-for="field in colours" :key="field.key + field.index" :label="field.label"><el-color-picker :model-value="colour(field)" show-alpha @update:model-value="setColour(field, $event)" /><el-input :model-value="colour(field)" :aria-label="field.label" @update:model-value="setColour(field, $event)" /></el-form-item>
              <template v-for="radius in [{ key: 'fillet', label: '社区背景', corners: ['左上', '右上', '左下', '右下'] }, { key: 'filletImg', label: '社区横向图片', corners }]" :key="radius.key">
                <el-form-item :label="radius.label + '圆角方式'"><el-select :model-value="flag(read(block, [radius.key, 'type'])) ? 1 : 0" @update:model-value="setRadiusType(radius.key, $event)"><el-option label="全部圆角" :value="0" /><el-option label="独立四角" :value="1" /></el-select></el-form-item>
                <el-form-item v-if="!flag(read(block, [radius.key, 'type']))" :label="radius.label + '圆角'"><el-input-number :model-value="number(read(block, [radius.key, 'val']))" :min="0" :max="Math.max(100, number(read(block, [radius.key, 'val'])))" @update:model-value="setRadius(radius.key, -1, $event)" /></el-form-item>
                <template v-else><el-form-item v-for="(corner, index) in radius.corners" :key="corner" :label="radius.label + corner + '圆角'"><el-input-number :model-value="number(read(block, [radius.key, 'valList', index, 'val']))" :min="0" :max="Math.max(100, number(read(block, [radius.key, 'valList', index, 'val'])))" @update:model-value="setRadius(radius.key, index, $event)" /></el-form-item></template>
              </template>
              <el-form-item label="社区点赞色调元数据"><el-select :model-value="Number(read(block, ['toneConfig', 'tabVal']) || 0)" @update:model-value="setChoice('toneConfig', $event)"><el-option label="跟随主题风格" :value="0" /><el-option label="自定义" :value="1" /></el-select></el-form-item>
            </div>
            <p class="hint">双列按图片与文字的实际高度分列，使用固定白底、间距和图片上圆角。双列间距、色调与点赞颜色保留为原配置元数据；公开页遵循原组件的展示规则。</p>
            <el-form-item label="社区话题值（配置元数据）"><el-input :model-value="String(read(block, ['selectConfig', 'activeValue']) ?? '')" aria-label="社区话题值" @update:model-value="setTopicValue" /></el-form-item>
            <el-form-item label="社区话题列表（完整 JSON 元数据）"><el-input :model-value="topicDraft" type="textarea" @update:model-value="topicSession.change" :rows="4" aria-label="社区话题列表" /><el-button :disabled="!canEdit" @click="applyTopicDraft">应用话题列表 JSON</el-button></el-form-item>
            <div class="toolbar"><el-button :disabled="!canReadTopics || topicLoading" :loading="topicLoading" @click="loadTopics">读取社区话题目录</el-button><el-button :disabled="!canEdit || !topics.length" @click="applyTopics">将读取的话题目录写入配置</el-button></div>
            <el-select v-if="topics.length" :model-value="String(read(block, ['selectConfig', 'activeValue']) ?? '')" aria-label="从目录选择社区话题" @update:model-value="setTopicValue"><el-option v-for="topic in topics" :key="topic.id" :value="String(topic.id)" :label="topic.name" /></el-select>
            <p class="hint">话题值与选项列表仅作配置保存；此组件的公开列表沿用全社区内容。右侧文字固定进入社区发现页。</p>
          </el-form>
          <el-alert v-if="error" :title="error" type="warning" :closable="false" />
          <div class="toolbar"><el-button :disabled="!canEdit || !pageId || !pagePublished || mediaLoading" :loading="mediaLoading" @click="loadSavedMedia">读取已发布社区标题图片</el-button><el-button :disabled="!canEdit || !config.enabled || dataLoading" :loading="dataLoading" @click="loadData">{{ dataState === 'error' ? '重试社区公开内容' : '读取社区公开内容' }}</el-button></div>
          <p v-if="dataLoading" class="hint" role="status">正在读取社区公开内容…</p><p v-else-if="dataState === 'closed' || dataState === 'error'" class="hint" :role="dataState === 'error' ? 'alert' : 'status'">{{ dataMessage }}</p><p v-else-if="dataState === 'open' && !rows.length" class="hint">暂无社区公开内容</p><p v-else-if="dataState === 'idle'" class="hint">读取公开内容后可预览帖子排布。</p>
          <DiyCommunityPreview :block="block" :rows="rows" :previews="previews" :editor-key="`${editorKey}:${revision}:${selected}`" />
        </template>
      </template>
      <p v-else class="hint">此页面暂无社区组件。</p>
    </template>
  </section>
</template>

<script setup lang="ts">

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import DiyCommunityPreview from '@/components/content/DiyCommunityPreview.vue';
import { apiCommunityAllTopics } from '@/api/community';
import { apiDiyCommunityPreview, type CommunityAuthorPost } from '@/api/diyCommunityAuthor';
import { normalizeDiyCommunityPreview } from '@/utils/diyCommunityProjection';
import { communityEntries, addCommunityBlock, moveCommunityBlock, removeCommunityBlock, canonicalCommunityBlock, communitySet, setCommunityNumber, setCommunityTopicMetadata } from '@/utils/diyCommunityEditor';
import { navigationDocument, navigationRecord as record, navRead as read, navFlag as flag, navText as text } from '@/utils/diyNavigationEditor';
import { communityNumber as number, canonicalCommunityImage } from '@/utils/diyCommunityEditor';
import { listSafeColor } from '@/utils/diyListProjection';
import { canonicalPresentationReference, presentationPreviewForReference } from '@/utils/diyPresentationEditor';

type ImageKey = 'imgConfig';
interface Colour { key: string; index: number; label: string; fallback: string }
const props = withDefaults(defineProps<{ modelValue: string; editorKey: string; disabled?: boolean; pageId?: number; pagePublished?: boolean }>(), { disabled: false, pageId: 0, pagePublished: false });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>(), auth = useAuthStore();
const selected = ref(-1), revision = ref(0), error = ref(''), previews = ref<Record<string, string>>({}), mediaLoading = ref(false);
const lengths = [{ key: 'numberConfig', label: '内容数量', min: 1, max: 100 }, { key: 'titleNumber', label: '标题字号', min: 0, max: 40 }, { key: 'bntNumber', label: '右侧字号', min: 0, max: 32 }, ...['videoSpace', 'videoSpace2', 'topConfig', 'bottomConfig', 'prConfig', 'mbConfig'].map((key, index) => ({ key, label: ['双列间距元数据', '横向内容间距', '上边距', '下边距', '左右边距', '页面上间距'][index]!, min: 0, max: 100 }))];
const images: Array<{ key: ImageKey; label: string }> = [{ key: 'imgConfig', label: '社区图片标题' }];
const colours: Colour[] = [{ key: 'headerBgColor', index: 0, label: '头部背景起始色', fallback: '#E93323' }, { key: 'headerBgColor', index: 1, label: '头部背景结束色', fallback: '#FF7931' }, { key: 'titleColor', index: 0, label: '标题颜色', fallback: '#fff' }, { key: 'headerBntColor', index: 0, label: '右侧文字颜色', fallback: '#fff' }, { key: 'moduleColor', index: 0, label: '横向内容背景起始色', fallback: '#fff' }, { key: 'moduleColor', index: 1, label: '横向内容背景结束色', fallback: '#fff' }, { key: 'bottomBgColor', index: 0, label: '外部背景颜色', fallback: '#f5f5f5' }, { key: 'likeSuccessColor', index: 0, label: '点赞颜色元数据', fallback: '#E93323' }];
const corners = ['左上', '右上', '右下', '左下'];
let alive = true, lastCommitted = '', receiptEpoch = 0, mediaAbort: AbortController | null = null;
const actor = () => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
function editable() { return alive && !props.disabled && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('dise.manage')); }
const canEdit = computed(() => { void revision.value; return editable(); });
const canChooseMedia = computed(() => canEdit.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.view')));
const parsed = computed(() => { try { return { value: navigationDocument(props.modelValue), error: '' }; } catch (reason) { return { value: null, error: reason instanceof Error ? reason.message : '装修 JSON 无效' }; } });
const document = computed(() => parsed.value.value), entries = computed(() => communityEntries(document.value ?? []));
const block = computed(() => { const row = record(document.value?.[selected.value]); return row?.name === 'community' ? row : null; });
const config = computed(() => normalizeDiyCommunityPreview(block.value));
const canReadTopics = computed(() => canEdit.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.some(key => ['community.view', 'community.manage'].includes(key))));
const rows = ref<CommunityAuthorPost[]>([]), dataLoading = ref(false), dataState = ref('idle'), dataMessage = ref(''), topics = ref<Array<{ id: number; name: string; is_recommend: number }>>([]), topicLoading = ref(false), topicDraft = ref('[]'), draftContext = ref(0);
let dataAbort: AbortController | null = null, topicAbort: AbortController | null = null, preserveReceipt = false;
function stamp() { return { actor: actor(), editor: props.editorKey, index: selected.value, revision: revision.value, raw: props.modelValue }; }
function current(issued: ReturnType<typeof stamp>) { return editable() && issued.actor === actor() && issued.editor === props.editorKey && issued.index === selected.value && issued.revision === revision.value && issued.raw === props.modelValue; }
function clearFeed() { rows.value = []; dataState.value = 'idle'; dataMessage.value = ''; }
function invalidate(preserveRows = false) { revision.value++; mediaAbort?.abort(); dataAbort?.abort(); topicAbort?.abort(); mediaAbort = dataAbort = topicAbort = null; mediaLoading.value = dataLoading.value = topicLoading.value = false; previews.value = {}; topics.value = []; error.value = ''; if (!preserveRows) clearFeed(); }
function invalidateContext() { receiptEpoch++; draftContext.value++; invalidate(); }
watch(entries, () => { if (!entries.value.some(row => row.index === selected.value)) selected.value = entries.value[0]?.index ?? -1; }, { immediate: true });
watch(() => props.modelValue, value => { if (value !== lastCommitted) { receiptEpoch++; draftContext.value++; } invalidate(value === lastCommitted && preserveReceipt); }, { flush: 'sync' });
watch([() => JSON.stringify(read(block.value, ['selectConfig', 'list']) ?? []), selected, () => props.editorKey, draftContext], () => { topicDraft.value = JSON.stringify(read(block.value, ['selectConfig', 'list']) ?? []); }, { immediate: true, flush: 'sync' });
const topicSession = computed(() => { const issued = stamp(); return { change: (value: unknown) => { if (current(issued) && typeof value === 'string') topicDraft.value = value; } }; });
watch(() => [props.editorKey, props.disabled, props.pageId, props.pagePublished, actor()], invalidateContext, { flush: 'sync' });
for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) window.addEventListener(event, invalidateContext);
onBeforeUnmount(() => { alive = false; invalidateContext(); for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) window.removeEventListener(event, invalidateContext); });
function commit(value: unknown[], preserveRows = false) { if (!editable()) return false; try { const raw = JSON.stringify(value, null, 2); navigationDocument(raw); receiptEpoch++; invalidate(preserveRows); preserveReceipt = preserveRows; lastCommitted = raw; emit('update:modelValue', raw); return true; } catch (reason) { error.value = reason instanceof Error ? reason.message : '当前内容无法完整编辑'; return false; } }
function edit(change: (row: Record<string, unknown>) => void) { if (!editable() || !document.value || !block.value) return false; try { const copy = structuredClone(document.value); change(record(copy[selected.value])!); if (JSON.stringify(copy) === JSON.stringify(document.value)) return false; return commit(copy, normalizeDiyCommunityPreview(record(copy[selected.value])).limit === config.value.limit); } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法修改当前字段'; return false; } }
function setLeaf(path: Array<string | number>, value: unknown) { if (read(block.value, path) === value) return false; return edit(row => communitySet(row, path, value)); }
function select(value: unknown) { if (typeof value === 'number' && entries.value.some(row => row.index === value)) { invalidateContext(); selected.value = value; } }
function add() { if (!editable() || !document.value) return; try { const result = addCommunityBlock(document.value); if (commit(result.value)) selected.value = result.selected; } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法添加组件'; } }
function remove() { if (!editable() || !document.value || !block.value) return; try { const result = removeCommunityBlock(document.value, selected.value); if (commit(result.value)) selected.value = result.selected; } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法删除组件'; } }
function move(direction: -1 | 1) { if (!editable() || !document.value || !block.value) return; try { const result = moveCommunityBlock(document.value, selected.value, direction); if (commit(result.value)) selected.value = result.selected; } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法移动组件'; } }
function setVisible(value: unknown) { if (typeof value === 'boolean' && flag(block.value?.isHide) !== !value) setLeaf(['isHide'], !value); }
function setText(key: string, value: unknown) { if (['titleTxtConfig', 'rightBntConfig'].includes(key) && typeof value === 'string' && value.length <= Math.max(6, text(read(block.value, [key, 'value'])).length) && !/[\u0000-\u001f\u007f]/u.test(value)) setLeaf([key, 'value'], value); }
function setChoice(key: string, value: unknown) { const maximum = key === 'titleText' ? 2 : 1; if (['styleConfig', 'titleConfig', 'titleText', 'toneConfig', 'setUp'].includes(key) && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum && Number(read(block.value, [key, 'tabVal'])) !== value) setLeaf([key, 'tabVal'], value); }
function setLength(key: string, value: unknown) { const field = lengths.find(row => row.key === key); if (field && typeof value === 'number' && Number.isFinite(value) && value >= field.min && value <= Math.max(field.max, number(read(block.value, [key, 'val']))) && number(read(block.value, [key, 'val'])) !== value) edit(row => { setCommunityNumber(row, [key, 'val'], value, field.min, Math.max(field.max, number(read(row, [key, 'val'])))); }); }
function colour(field: Colour) { return listSafeColor(read(block.value, [field.key, 'color', field.index, 'item']), field.fallback); }
function setColour(field: Colour, value: unknown) { if (colours.some(row => row.key === field.key && row.index === field.index) && typeof value === 'string' && listSafeColor(value, '') === value.trim()) setLeaf([field.key, 'color', field.index, 'item'], value.trim()); }
function setRadiusType(key: string, value: unknown) { if (['fillet', 'filletImg'].includes(key) && (value === 0 || value === 1) && flag(read(block.value, [key, 'type'])) !== !!value) setLeaf([key, 'type'], value); }
function setRadius(key: string, index: number, value: unknown) { if (!['fillet', 'filletImg'].includes(key) || !Number.isInteger(index) || index < -1 || index > 3 || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return; const path = index < 0 ? [key, 'val'] : [key, 'valList', index, 'val']; if (value <= Math.max(100, number(read(block.value, path))) && number(read(block.value, path)) !== value) setLeaf(path, value); }
function clearImage(key: ImageKey) { if (images.some(row => row.key === key)) setLeaf([key, 'url'], ''); }
const mediaSessions = computed(() => {
  const issued = stamp();
  const session = (key: ImageKey) => ({ key: `${props.editorKey}:${revision.value}:${selected.value}:${key}`, choose: async (reference: string, signed: string) => {
    if (!current(issued) || !canChooseMedia.value || !block.value) return;
    const approved = presentationPreviewForReference(reference, signed); if (!approved) return;
    let canonical: string; try { canonical = canonicalCommunityImage(reference); } catch { return; }
    if (canonicalPresentationReference(text(read(block.value, [key, 'url']))) === canonical) { previews.value = { ...previews.value, [canonical]: approved }; return; }
    const previous = { ...previews.value };
    if (!setLeaf([key, 'url'], canonical)) return;
    const expected = lastCommitted, page = props.pageId, published = props.pagePublished, epoch = receiptEpoch; await nextTick();
    // Parent v-model propagation invalidates the raw-document stamp once. Bind
    // the receipt to the exact committed value and original owner instead.
    if (editable() && receiptEpoch === epoch && canChooseMedia.value && actor() === issued.actor && props.editorKey === issued.editor && selected.value === issued.index && props.pageId === page && props.pagePublished === published && props.modelValue === expected && canonicalPresentationReference(text(read(block.value, [key, 'url']))) === canonical) {
      const retained: Record<string, string> = {};
      for (const { key: slot } of images) {
        const reference = text(read(block.value, [slot, 'url'])), stable = canonicalPresentationReference(reference), value = presentationPreviewForReference(reference, previous[stable]);
        if (value) retained[stable] = value;
      }
      previews.value = { ...retained, [canonical]: approved };
    }
  } });
  return { imgConfig: session('imgConfig') };
});
async function loadSavedMedia() {
  if (!editable() || !block.value || !props.pageId || !props.pagePublished) return;
  mediaAbort?.abort(); const controller = new AbortController(), issued = stamp(), id = props.pageId, expected = JSON.stringify(canonicalCommunityBlock(block.value));
  mediaAbort = controller; mediaLoading.value = true; previews.value = {}; error.value = '';
  try {
    const response = await fetch(`/api/diy/get_diy/${id}`, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    const body = record(await response.json()), data = record(body?.data);
    if (!current(issued) || controller.signal.aborted || props.pageId !== id || !props.pagePublished) return;
    if (!response.ok || body?.status !== 200 || !Array.isArray(data?.value)) throw Error('公开社区组件暂不可用');
    const found = data.value.map(record).find(row => row?.name === 'community' && JSON.stringify(canonicalCommunityBlock(row)) === expected);
    if (!found) throw Error('当前社区组件与已发布内容不同，请保存后再读取');
    const next: Record<string, string> = {};
    for (const { key } of images) { const reference = text(read(block.value, [key, 'url'])), approved = presentationPreviewForReference(reference, read(found, [key, 'url'])); if (approved) next[canonicalPresentationReference(reference)] = approved; }
    previews.value = next;
  } catch (reason) { if (current(issued) && mediaAbort === controller && !controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '社区图片预览失败'; }
  finally { if (mediaAbort === controller) { mediaAbort = null; mediaLoading.value = false; } }
}
async function loadData() {
  if (!editable() || !block.value || !config.value.enabled || dataLoading.value) return;
  const controller = new AbortController(), issued = stamp();
  dataAbort?.abort(); dataAbort = controller; dataLoading.value = true; clearFeed();
  try {
    const result = await apiDiyCommunityPreview(config.value.limit, controller.signal);
    if (!current(issued) || dataAbort !== controller || controller.signal.aborted || !config.value.enabled) return;
    rows.value = result.rows; dataState.value = result.open ? 'open' : 'closed'; dataMessage.value = result.message;
  } catch (reason) { if (current(issued) && dataAbort === controller && !controller.signal.aborted) { dataState.value = 'error'; dataMessage.value = reason instanceof Error ? reason.message : '社区公开内容读取失败'; } }
  finally { if (dataAbort === controller) { dataAbort = null; dataLoading.value = false; } }
}
async function loadTopics() {
  if (!canReadTopics.value || !editable() || !block.value || topicLoading.value) return;
  const controller = new AbortController(), issued = stamp(); topicAbort?.abort(); topicAbort = controller; topicLoading.value = true; topics.value = []; error.value = '';
  try {
    const result = await apiCommunityAllTopics(controller.signal, true);
    if (!current(issued) || topicAbort !== controller || controller.signal.aborted || !canReadTopics.value) return;
    const ids = new Set<number>();
    if (!Array.isArray(result) || result.length > 1000 || result.some(row => !record(row) || !Number.isSafeInteger(row.id) || row.id < 1 || row.id > 2147483647 || ids.has(row.id) || !ids.add(row.id) || typeof row.name !== 'string' || !row.name.trim() || /[\u0000-\u001f\u007f]/u.test(row.name) || ![0, 1].includes(row.is_recommend))) throw Error('社区话题目录格式错误');
    topics.value = structuredClone(result);
  } catch (reason) { if (current(issued) && topicAbort === controller && !controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '社区话题目录读取失败'; }
  finally { if (topicAbort === controller) { topicAbort = null; topicLoading.value = false; } }
}
function setTopicValue(value: unknown) { const raw = read(block.value, ['selectConfig', 'activeValue']); if (typeof value === 'string' && String(raw ?? '') !== value && !/[\u0000-\u001f\u007f]/u.test(value)) edit(row => { setCommunityTopicMetadata(row, { activeValue: value }); }); }
function applyTopicDraft() { if (!editable()) return; try { const list: unknown = JSON.parse(topicDraft.value); if (!Array.isArray(list)) throw Error('话题列表必须是完整 JSON 数组'); error.value = ''; edit(row => { setCommunityTopicMetadata(row, { list }); }); } catch (reason) { error.value = reason instanceof Error ? reason.message : '社区话题列表 JSON 无效'; } }
function applyTopics() { if (editable() && topics.value.length) edit(row => { setCommunityTopicMetadata(row, { list: topics.value.map(topic => ({ title: topic.name, activeValue: String(topic.id) })) }); }); }
</script>
<style scoped>
.community-editor{width:100%;min-width:0}.hint{margin:6px 0 10px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.toolbar,.media-field{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.stored{flex-basis:100%;max-width:100%;margin:0;font-size:12px;overflow-wrap:anywhere}.community-editor :deep(.el-select){max-width:100%}.community-editor :deep(.el-input-number){width:100%}@media(max-width:620px){.fields{grid-template-columns:1fr}}
</style>
