<template>
  <section class="editorial-editor" aria-label="公告与活动作者编辑器">
    <strong>公告、图片热区与活动四卡</strong>
    <p class="hint">保存页面后生效；导入条目、隐藏组件及未知字段均保留。预览不执行链接。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else>
      <div class="toolbar"><el-select v-model="addKind" aria-label="新增公告与活动组件类型" :disabled="!canEdit"><el-option v-for="name in names" :key="name" :value="name" :label="labels[name]" /></el-select><el-button :disabled="!canEdit" @click="add">添加公告与活动组件</el-button></div>
      <template v-if="entries.length">
        <el-select :model-value="selected" aria-label="选择公告与活动组件" @update:model-value="select"><el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index + 1} 项 · ${labels[entry.kind]}`" /></el-select>
        <div class="toolbar"><el-button :disabled="!canEdit" @click="move(-1)">上移公告与活动组件</el-button><el-button :disabled="!canEdit" @click="move(1)">下移公告与活动组件</el-button><el-button :disabled="!canEdit" @click="add(true)">复制公告与活动组件</el-button><el-button :disabled="!canEdit" type="danger" @click="remove">删除公告与活动组件</el-button></div>
        <template v-if="block && kind">
          <el-form label-position="top" :disabled="!canEdit">
            <div class="fields">
              <el-form-item label="公告与活动组件显示"><el-switch :model-value="!flag(block.isHide)" @update:model-value="setVisible" /></el-form-item>
              <el-form-item v-for="field in enums" :key="field.key" :label="field.label"><el-select :model-value="ordinal(read(block, [field.key, 'tabVal']), field.fallback, field.options.length - 1)" @update:model-value="setEnum(field.key, $event)"><el-option v-for="(label, index) in field.options" :key="index" :value="index" :label="label" /></el-select></el-form-item>
              <el-form-item v-for="field in texts" :key="field.key" :label="field.label"><el-input :model-value="text(read(block, [field.key, 'value']))" :maxlength="Math.max(field.max, text(read(block, [field.key, 'value'])).length)" :aria-label="field.label" @update:model-value="setText(field.key, $event)" /></el-form-item>
            </div>
            <el-form-item v-if="kind === 'news'" label="公告更多链接"><p class="stored">{{ text(read(block, ['linkConfig', 'value'])) || '未设置（客户端使用文章列表）' }}</p><DiyAuthorLinkPicker :disabled="!canEdit" :editor-key="moreLinkSession.key" @choose="moreLinkSession.choose" /><el-button :disabled="!canEdit" @click="clearLink(-1)">清空公告更多链接</el-button></el-form-item>
            <template v-if="kind !== 'activeParty' || item">
              <el-form-item :label="imageLabel"><p class="stored">{{ imageReference || '未选择图片' }}</p><SeckillActivityImagePicker :disabled="!canChooseMedia || kind === 'activeParty' && itemIndex >= 4" :editor-key="mediaSession.key" :title="imageLabel" @choose="mediaSession.choose" /><el-button :disabled="!canEdit" @click="clearImage">清空{{ imageLabel }}</el-button><p v-if="kind === 'hotspot'" class="hint">明确更换底图会清空区域；同一图片的预览续期保留区域。</p></el-form-item>
            </template>
            <div class="toolbar"><el-button :disabled="!canEdit || items.length >= itemLimit || kind === 'hotspot' && !imageSize" @click="addItem">添加{{ itemLabel }}</el-button><el-select v-if="items.length" :model-value="itemIndex" :aria-label="`选择${itemLabel}`" @update:model-value="selectItem"><el-option v-for="(_, index) in items" :key="index" :value="index" :label="`${itemLabel} ${index + 1}`" /></el-select></div>
            <p v-if="items.length > itemLimit" class="hint">完整保留 {{ items.length }} 项导入内容；当前客户端仅消费前 {{ itemLimit }} 项，超量项仍可逐项编辑、移除与排序；活动图片素材只用于公开展示的前 4 项。</p>
            <template v-if="itemIndex >= 0 && itemIndex < items.length">
              <div class="toolbar"><el-button :disabled="!canEdit || itemIndex === 0" @click="moveItem(-1)">上移{{ itemLabel }}</el-button><el-button :disabled="!canEdit || itemIndex === items.length - 1" @click="moveItem(1)">下移{{ itemLabel }}</el-button><el-button :disabled="!canEdit" type="danger" @click="removeItem">删除{{ itemLabel }}</el-button></div>
              <el-alert v-if="!item" title="此导入条目结构异常，可明确删除或在装修 JSON 中修复。" type="warning" :closable="false" />
              <div v-else class="fields">
                <template v-if="kind === 'news'"><el-form-item label="公告条目显示"><el-switch :model-value="flag(item.show)" @update:model-value="setItemVisible" /></el-form-item><el-form-item label="公告条目文字"><el-input :model-value="text(read(item, ['chiild', 0, 'val']))" :maxlength="Math.max(20, text(read(item, ['chiild', 0, 'val'])).length)" aria-label="公告条目文字" @update:model-value="setItemText(0, $event)" /></el-form-item></template>
                <template v-else-if="kind === 'activeParty'"><el-form-item label="活动卡片标题"><el-input :model-value="text(read(item, ['info', 0, 'value']))" :maxlength="Math.max(4, text(read(item, ['info', 0, 'value'])).length)" aria-label="活动卡片标题" @update:model-value="setItemText(0, $event)" /></el-form-item><el-form-item label="活动卡片简介"><el-input :model-value="text(read(item, ['info', 1, 'value']))" :maxlength="Math.max(20, text(read(item, ['info', 1, 'value'])).length)" aria-label="活动卡片简介" @update:model-value="setItemText(1, $event)" /></el-form-item></template>
                <template v-else><el-form-item v-for="field in coordinates" :key="field.key" :label="field.label + '（750 设计坐标）'"><el-input-number :disabled="!imageSize" :model-value="number(item[field.key])" :min="field.key === 'starX' || field.key === 'starY' ? 0 : Math.min(.1, number(item[field.key]))" :max="Math.max(1e6, number(item[field.key]))" :step="1" @update:model-value="setCoordinate(field.key, $event)" /></el-form-item></template>
              </div>
              <el-form-item v-if="item" :label="itemLabel + '链接'"><p class="stored">{{ itemLink || '未选择链接' }}</p><DiyAuthorLinkPicker :disabled="!canEdit" :editor-key="itemLinkSession.key" @choose="itemLinkSession.choose" /><el-button :disabled="!canEdit" @click="clearLink(itemIndex)">清空{{ itemLabel }}链接</el-button></el-form-item>
            </template>
            <div class="fields">
              <el-form-item v-for="field in colours" :key="field.key + field.index" :label="field.label"><el-color-picker :model-value="colour(field)" show-alpha @update:model-value="setColour(field, $event)" /><el-input :model-value="colour(field)" :aria-label="field.label" @update:model-value="setColour(field, $event)" /></el-form-item>
              <el-form-item v-for="field in lengths" :key="field.key" :label="field.label + '（设计 px）'"><el-input-number :model-value="number(read(block, [field.key, 'val']))" :min="0" :max="Math.max(field.max, number(read(block, [field.key, 'val'])))" @update:model-value="setLength(field.key, $event)" /></el-form-item>
              <template v-if="kind !== 'activeParty'"><el-form-item label="公告与热区圆角方式"><el-select :model-value="flag(read(block, ['fillet', 'type'])) ? 1 : 0" @update:model-value="setRadiusType"><el-option label="全部圆角" :value="0" /><el-option label="独立四角" :value="1" /></el-select></el-form-item><el-form-item v-for="(corner, index) in flag(read(block, ['fillet', 'type'])) ? ['左上', '右上', '左下', '右下'] : ['全部']" :key="corner" :label="'公告与热区' + corner + '圆角'"><el-input-number :model-value="number(read(block, flag(read(block, ['fillet', 'type'])) ? ['fillet', 'valList', index, 'val'] : ['fillet', 'val']))" :min="0" :max="Math.max(80, number(read(block, flag(read(block, ['fillet', 'type'])) ? ['fillet', 'valList', index, 'val'] : ['fillet', 'val'])))" @update:model-value="setRadius(flag(read(block, ['fillet', 'type'])) ? index : -1, $event)" /></el-form-item></template>
            </div>
          </el-form>
          <el-alert v-if="error" :title="error" type="warning" :closable="false" />
          <div class="toolbar"><el-button :disabled="!canEdit || !pageId || !pagePublished || mediaLoading" :loading="mediaLoading" @click="loadSavedMedia">读取已发布公告与活动图片</el-button></div>
          <DiyHotspotEditorCanvas v-if="kind === 'hotspot'" :block="block" :previews="previews" :selected="itemIndex" :disabled="!canEdit" :editor-key="canvasKey" @select="selectItem" @size="canvasSession.size" @geometry="canvasSession.geometry" />
          <DiyEditorialPreview :block="block" :previews="previews" :editor-key="canvasKey" />
        </template>
      </template>
      <p v-else class="hint">此页面暂无公告、图片热区或促销活动组件。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import DiyAuthorLinkPicker from '@/components/content/DiyAuthorLinkPicker.vue';
import DiyEditorialPreview from '@/components/content/DiyEditorialPreview.vue';
import DiyHotspotEditorCanvas from '@/components/content/DiyHotspotEditorCanvas.vue';
import type { DiyAuthorChoice } from '@/api/diyAuthorOptions';
import { EDITORIAL_NAMES as names, editorialLabels as labels, editorialKind, editorialEntries, editorialDocument, editorialItems, itemListPath, addEditorialBlock, moveEditorialBlock, removeEditorialBlock, newEditorialItem, addEditorialItem, removeEditorialItem, moveEditorialItem, setEditorialLink, setHotspotGeometry, setHotspotImage, canonicalEditorialImage, type EditorialKind, type EditorialRecord, type HotspotGeometry } from '@/utils/diyEditorialEditor';
import { createDiyAuthorMediaLeases } from '@/utils/diyAuthorMediaLeases';
import { editorialImageIdentity, editorialPreviewUrl } from '@/utils/diyEditorialEditor';
import { publishedEditorialIdentity, editorialMediaReferences } from '@/utils/diyEditorialProjection';
import { navigationRecord as record, navRead as read, navSet, navFlag as flag, navText as text, navigationLink } from '@/utils/diyNavigationEditor';
import { listNumber, listOrdinal as ordinal, listSafeColor } from '@/utils/diyListProjection';
import { canonicalPresentationReference, presentationPreviewForReference } from '@/utils/diyPresentationEditor';
const number = (value: unknown, fallback = 0, max = Number.MAX_VALUE) => listNumber(value, fallback, max);
const props = withDefaults(defineProps<{ modelValue: string; editorKey: string; disabled?: boolean; pageId?: number; pagePublished?: boolean }>(), { disabled: false, pageId: 0, pagePublished: false }), emit = defineEmits<{ 'update:modelValue': [value: string] }>(), auth = useAuthStore();
const selected = ref(-1), itemIndex = ref(0), addKind = ref<EditorialKind>('news'), revision = ref(0), contextRevision = ref(0), error = ref(''), previews = ref<Record<string, string>>({}), mediaLoading = ref(false), imageSize = ref<{ width: number; height: number; reference: string } | null>(null);
let alive = true, receiptEpoch = 0, mediaAbort: AbortController | null = null;
const actor = () => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
function editable() { return alive && !props.disabled && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('dise.manage')); }
const canEdit = computed(() => { void revision.value; return editable(); }), canChooseMedia = computed(() => canEdit.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.view')));
const parsed = computed(() => { try { return { value: editorialDocument(props.modelValue), error: '' }; } catch (reason) { return { value: null, error: reason instanceof Error ? reason.message : '装修 JSON 无效' }; } }), document = computed(() => parsed.value.value), entries = computed(() => editorialEntries(document.value ?? []));
const block = computed(() => record(document.value?.[selected.value])), kind = computed(() => editorialKind(block.value?.name)), items = computed(() => editorialItems(block.value)), item = computed(() => record(items.value[itemIndex.value]));
const itemLimit = computed(() => kind.value === 'news' ? 10 : kind.value === 'activeParty' ? 4 : 30), itemLabel = computed(() => kind.value === 'news' ? '公告条目' : kind.value === 'activeParty' ? '活动卡片' : '热区');
const imageLabel = computed(() => kind.value === 'news' ? '公告标题图片' : kind.value === 'hotspot' ? '热区底图' : '活动卡片图片');
const imagePath = computed<Array<string | number>>(() => kind.value === 'news' ? ['imgConfig', 'url'] : kind.value === 'hotspot' ? ['picStyle', 'url'] : ['menuConfig', 'list', itemIndex.value, 'img']);
const imageReference = computed(() => text(read(block.value, imagePath.value))), itemLink = computed(() => text(read(item.value, kind.value === 'news' ? ['chiild', 1, 'val'] : kind.value === 'activeParty' ? ['info', 2, 'value'] : ['link'])));
const canvasKey = computed(() => `${actor()}:${props.editorKey}:${selected.value}:${props.pageId}:${props.pagePublished}:${contextRevision.value}`);
const enums = computed(() => kind.value === 'news' ? [{ key: 'styleConfig', label: '公告风格', options: ['滚动播报', '公告列表'], fallback: 0 }, { key: 'titleConfig', label: '公告标题类型', options: ['图片', '文字'], fallback: 1 }, { key: 'rollConfig', label: '公告滚动方式', options: ['上下滚动', '左右滚动'], fallback: 0 }, { key: 'buttonConfig', label: '公告更多按钮', options: ['显示', '隐藏'], fallback: 0 }, { key: 'toneConfig', label: '公告色调', options: ['跟随主题', '自定义'], fallback: 0 }] : []);
const texts = computed(() => kind.value === 'news' ? [{ key: 'titleTxtConfig', label: '公告标题文字', max: 4 }, { key: 'textConfig', label: '公告更多文字', max: 4 }] : kind.value === 'activeParty' ? [{ key: 'titleConfig', label: '活动促销标题', max: 10 }, { key: 'desConfig', label: '活动促销简介', max: 8 }] : []);
interface Colour { key: string; index: number; label: string; fallback: string }
const colours = computed<Colour[]>(() => {
  const c = (key: string, label: string, fallback: string, index = 0) => ({ key, label, fallback, index });
  return kind.value === 'activeParty' ? [c('themeColor', '活动主题色', '#fc3c3e'), c('bgColor', '活动标签渐变起始色', '#F62C2C'), c('bgColor', '活动标签渐变结束色', '#F96E29', 1), c('boxColor', '活动背景色', '#ffe5e3')]
    : [...(kind.value === 'news' ? [c('titleBgColor', '公告标题背景起始色', '#FCEAE9'), c('titleBgColor', '公告标题背景结束色', '#FCEAE9', 1), c('titleColor', '公告标题颜色', '#E93323'), c('newsColor', '公告内容颜色', '#333333'), c('bntColor', '公告按钮颜色', '#999999'), c('moduleColor', '公告模块背景起始色', '#fff'), c('moduleColor', '公告模块背景结束色', '#fff', 1)] : []), c('bottomBgColor', '公告与热区底部背景', '#f5f5f5')];
});
const lengths = computed(() => [...(kind.value === 'activeParty' ? [] : [{ key: 'topConfig', label: '上边距', max: 100 }, { key: 'bottomConfig', label: '下边距', max: 100 }, { key: 'prConfig', label: '左右边距', max: 80 }]), { key: 'mbConfig', label: '组件上间距', max: 100 }]);
const coordinates = [{ key: 'starX', label: '左侧位置' }, { key: 'starY', label: '顶部位置' }, { key: 'areaWidth', label: '区域宽度' }, { key: 'areaHeight', label: '区域高度' }];
const mediaIdentity = () => JSON.stringify([actor(), props.editorKey, selected.value, props.disabled, props.pageId, props.pagePublished, contextRevision.value]);
const leases = createDiyAuthorMediaLeases({ current: editable, identity: mediaIdentity, raw: () => props.modelValue,
  references: () => editorialMediaReferences(block.value), stable: editorialImageIdentity, resolve: editorialPreviewUrl,
  read: () => previews.value, write: value => { previews.value = value; } });
function cancelRead() { mediaAbort?.abort(); mediaAbort = null; mediaLoading.value = false; }
function invalidate(clear = true, preserveEcho = false) { const retained = previews.value; revision.value++; cancelRead(); error.value = ''; leases.clear(preserveEcho); if (clear) imageSize.value = null; else leases.renew(retained); }
function invalidateContext() { receiptEpoch++; contextRevision.value++; invalidate(); }
watch(entries, () => { if (!entries.value.some(e => e.index === selected.value)) selected.value = entries.value[0]?.index ?? -1; }, { immediate: true });
watch(() => props.modelValue, (value, before) => {
  const own = leases.pending(), echo = leases.adopt(value, before);
  if (echo) { invalidate(false, true); if (own) leases.settle(own); }
  else { invalidateContext(); itemIndex.value = 0; }
}, { flush: 'sync' });
watch(selected, invalidateContext, { flush: 'sync' });
watch(() => [props.editorKey, props.disabled, props.pageId, props.pagePublished, actor()], invalidateContext, { flush: 'sync' });
for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) window.addEventListener(event, invalidateContext);
onBeforeUnmount(() => { alive = false; invalidateContext(); for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) window.removeEventListener(event, invalidateContext); });
function stamp() { return { actor: actor(), editor: props.editorKey, selected: selected.value, item: itemIndex.value, revision: revision.value, raw: props.modelValue }; }
function current(s: ReturnType<typeof stamp>) { return editable() && s.actor === actor() && s.editor === props.editorKey && s.selected === selected.value && s.item === itemIndex.value && s.revision === revision.value && s.raw === props.modelValue; }
function commit(value: unknown[], nextSelected = selected.value) { if (!editable()) return false; try {
  const raw = JSON.stringify(value, null, 2); editorialDocument(raw);
  const own = leases.capture(props.modelValue, raw), measured = imageSize.value; receiptEpoch++; invalidate(); selected.value = nextSelected;
  leases.expect(own); emit('update:modelValue', raw); void nextTick(() => { if (leases.settle(own) && measured && measured.reference === imageReference.value) imageSize.value = measured; }); return true;
} catch (reason) { error.value = reason instanceof Error ? reason.message : '当前文档无法完整编辑'; return false; } }
function edit(change: (row: EditorialRecord) => void) { if (!editable() || !document.value || !block.value || !kind.value) return false; try { const value = structuredClone(document.value); change(record(value[selected.value])!); return commit(value); } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法修改当前字段'; return false; } }
function leaf(path: Array<string | number>, value: unknown) { if (read(block.value, path) === value) return false; return edit(row => navSet(row, path, value)); }
function select(value: unknown) { if (typeof value === 'number' && entries.value.some(e => e.index === value)) { invalidateContext(); selected.value = value; itemIndex.value = 0; } }
function selectItem(value: unknown) { if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < items.value.length) { receiptEpoch++; invalidate(false); itemIndex.value = value; } }
function add(duplicate: unknown = false) { if (!editable() || !document.value) return; try { const result = addEditorialBlock(document.value, duplicate === true && kind.value ? kind.value : addKind.value, duplicate === true && block.value ? block.value : undefined); if (commit(result.value, result.selected)) itemIndex.value = 0; } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法新增组件'; } }
function move(direction: -1 | 1) { if (!editable() || !document.value) return; try { const result = moveEditorialBlock(document.value, selected.value, direction); commit(result.value, result.selected); } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法移动组件'; } }
function remove() { if (!editable() || !document.value) return; try { const result = removeEditorialBlock(document.value, selected.value); if (commit(result.value, result.selected)) itemIndex.value = 0; } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法删除组件'; } }
function setVisible(value: unknown) { if (typeof value === 'boolean' && flag(block.value?.isHide) !== !value) leaf(['isHide'], !value); }
function setEnum(key: string, value: unknown) { const field = enums.value.find(f => f.key === key); if (field && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < field.options.length && ordinal(read(block.value, [key, 'tabVal']), field.fallback, field.options.length - 1) !== value) leaf([key, 'tabVal'], value); }
function setText(key: string, value: unknown) { const field = texts.value.find(f => f.key === key); if (field && typeof value === 'string' && value.length <= Math.max(field.max, text(read(block.value, [key, 'value'])).length) && !/[\u0000-\u001f\u007f]/u.test(value)) leaf([key, 'value'], value); }
function setItemVisible(value: unknown) { if (kind.value === 'news' && item.value && typeof value === 'boolean' && flag(item.value.show) !== value) leaf(['listConfig', 'list', itemIndex.value, 'show'], value); }
function setItemText(index: number, value: unknown) { if (!kind.value || !item.value || typeof value !== 'string' || ![0, 1].includes(index) || kind.value === 'hotspot' || kind.value === 'news' && index !== 0 || /[\u0000-\u001f\u007f]/u.test(value)) return; const path = [...itemListPath(kind.value), itemIndex.value, kind.value === 'news' ? 'chiild' : 'info', index, kind.value === 'news' ? 'val' : 'value'], max = kind.value === 'news' || index === 1 ? 20 : 4; if (value.length <= Math.max(max, text(read(block.value, path)).length)) leaf(path, value); }
function addItem() { let index = -1; if (edit(row => { index = addEditorialItem(row, imageSize.value?.width, imageSize.value?.height); })) itemIndex.value = index; }
function removeItem() { let index = -1; if (edit(row => { index = removeEditorialItem(row, itemIndex.value); })) itemIndex.value = index; }
function moveItem(direction: -1 | 1) { let index = -1; if (edit(row => { index = moveEditorialItem(row, itemIndex.value, direction); })) itemIndex.value = index; }
function colour(field: Colour) { return listSafeColor(read(block.value, [field.key, 'color', field.index, 'item']), field.fallback); }
function setColour(field: Colour, value: unknown) { if (colours.value.some(f => f.key === field.key && f.index === field.index) && typeof value === 'string' && value && listSafeColor(value, '') === value.trim()) leaf([field.key, 'color', field.index, 'item'], value.trim()); }
function setLength(key: string, value: unknown) { const field = lengths.value.find(f => f.key === key); if (field && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= field.max && number(read(block.value, [key, 'val']), 0, Number.MAX_VALUE) !== value) leaf([key, 'val'], value); }
function setRadiusType(value: unknown) { if (kind.value !== 'activeParty' && (value === 0 || value === 1) && flag(read(block.value, ['fillet', 'type'])) !== !!value) leaf(['fillet', 'type'], value); }
function setRadius(index: number, value: unknown) { if (kind.value === 'activeParty' || !Number.isInteger(index) || index < -1 || index > 3 || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 80) return; const path = index < 0 ? ['fillet', 'val'] : ['fillet', 'valList', index, 'val']; if (number(read(block.value, path), 0, Number.MAX_VALUE) !== value) leaf(path, value); }
function clearLink(index: number) { edit(row => setEditorialLink(row, index, '')); }
const linkSession = (index: number | Array<string | number>) => { const issued = stamp(); return { key: `${props.editorKey}:${revision.value}:${selected.value}:${index}:link`, choose: (choice: DiyAuthorChoice) => { if (current(issued) && choice && typeof choice.url === 'string') { if (Array.isArray(index)) edit(row => navSet(row, index, navigationLink(choice.url))); else edit(row => setEditorialLink(row, index, choice.url)); } } }; };
const moreLinkSession = computed(() => linkSession(-1)), itemLinkSession = computed(() => linkSession(itemIndex.value));
function clearImage() { if (kind.value === 'hotspot') edit(row => setHotspotImage(row, '')); else leaf(imagePath.value, ''); }
function mediaForPath(path: Array<string | number>, issued = stamp()) {
  const allowed = () => !!kind.value && (kind.value !== 'activeParty'
    ? JSON.stringify(path) === JSON.stringify(kind.value === 'news' ? ['imgConfig', 'url'] : ['picStyle', 'url'])
    : path.length === 4 && path[0] === 'menuConfig' && path[1] === 'list' && typeof path[2] === 'number' && path[2] >= 0 && path[2] < Math.min(4, items.value.length) && path[3] === 'img');
  return { key: `${props.editorKey}:${revision.value}:${selected.value}:${JSON.stringify(path)}`, choose: async (reference: string, signed: string) => {
    if (!current(issued) || !canChooseMedia.value || !allowed()) return;
    const approved = editorialPreviewUrl(reference, signed); if (!approved) return;
    let stable: string; try { stable = canonicalEditorialImage(reference); } catch { return; }
    if (editorialImageIdentity(read(block.value, path)) === stable) { leases.renew({ ...previews.value, [stable]: approved }); return; }
    if (!edit(row => row.name === 'hotspot' ? setHotspotImage(row, stable) : navSet(row, path, stable))) return;
    const own = leases.pending(); await nextTick();
    if (leases.current(own) && canChooseMedia.value && allowed() && editorialImageIdentity(read(block.value, path)) === stable)
      leases.renew({ ...previews.value, [stable]: approved });
  } };
}
const mediaSession = computed(() => { const issued = stamp(); return Object.assign((path: Array<string | number>) => mediaForPath(path, issued), mediaForPath([...imagePath.value], issued)); });

function acceptSize(value: { width: number; height: number; reference: string } | null) { if (value === null) { imageSize.value = null; return; } if (editable() && kind.value === 'hotspot' && value.reference === imageReference.value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0) imageSize.value = value; }
function applyGeometry(index: number, rectangle: HotspotGeometry) {
  if (!imageSize.value || kind.value !== 'hotspot') return;
  let target = index;
  if (edit(row => {
    if (target < 0) {
      // Ordinary add buttons retain their limit; an explicit canvas region can
      // extend a complete imported list without removing its existing areas.
      const areas = editorialItems(row); target = areas.length;
      const area = newEditorialItem('hotspot', target, imageSize.value!.width, imageSize.value!.height);
      navSet(row, ['picStyle', 'list'], [...areas, area]);
    }
    setHotspotGeometry(row, target, rectangle, imageSize.value!.width, imageSize.value!.height);
  })) itemIndex.value = target;
}
function setCoordinate(key: string, value: unknown) { if (!imageSize.value || !item.value || !coordinates.some(f => f.key === key) || typeof value !== 'number' || !Number.isFinite(value)) return; const r = { left: Number(item.value.starX), top: Number(item.value.starY), width: Number(item.value.areaWidth), height: Number(item.value.areaHeight) }, mapped = ({ starX: 'left', starY: 'top', areaWidth: 'width', areaHeight: 'height' } as const)[key as 'starX']; if (r[mapped] === value) return; r[mapped] = value; applyGeometry(itemIndex.value, r); }
async function loadSavedMedia() {
  if (!editable() || !block.value || !props.pageId || !props.pagePublished) return; cancelRead(); const issued = stamp(), id = props.pageId, expected = publishedEditorialIdentity(block.value), controller = new AbortController(); mediaAbort = controller; mediaLoading.value = true; leases.renew({}); error.value = '';
  try { const response = await fetch(`/api/diy/get_diy/${id}`, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal }), body = record(await response.json()), data = record(body?.data); if (!current(issued) || controller.signal.aborted || props.pageId !== id || !props.pagePublished) return; if (!response.ok || body?.status !== 200 || !Array.isArray(data?.value)) throw Error('已发布公告与活动素材暂不可用'); const found = data.value.map(record).find(row => row && editorialKind(row.name) && publishedEditorialIdentity(row) === expected); if (!found) throw Error('当前组件与已发布配置不同，请保存后再读取'); const next: Record<string, string> = {}; for (const ref of editorialMediaReferences(found)) { const stable = canonicalPresentationReference(ref); for (const original of editorialMediaReferences(block.value)) if (canonicalPresentationReference(original) === stable) { const approved = presentationPreviewForReference(original, ref); if (approved) next[stable] = approved; } } leases.renew(next); }
  catch (reason) { if (current(issued) && mediaAbort === controller && !controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '公开素材预览失败'; }
  finally { if (mediaAbort === controller) { mediaAbort = null; mediaLoading.value = false; } }
}
function previewImage(path: Array<string | number>) { const reference = read(block.value, path); return editable() ? editorialPreviewUrl(reference, previews.value[editorialImageIdentity(reference)]) : ''; }
// The canvas emits only to handlers captured for its actual current frame.
const canvasSession = computed(() => {
  const issued = stamp(), key = canvasKey.value;
  const allowed = () => current(issued) && key === canvasKey.value && kind.value === 'hotspot' && !!previewImage(['picStyle', 'url']);
  const geometry = (index: number, rectangle: HotspotGeometry) => { if (allowed()) applyGeometry(index, rectangle); };
  const convert = (value: { starX: number; starY: number; areaWidth: number; areaHeight: number }) => ({ left: value.starX, top: value.starY, width: value.areaWidth, height: value.areaHeight });
  return { key, allowed, size: (value: { width: number; height: number; reference: string } | null) => { if (current(issued) && key === canvasKey.value) acceptSize(value); }, geometry,
    create: (value: { starX: number; starY: number; areaWidth: number; areaHeight: number }) => geometry(-1, convert(value)),
    rect: (index: number, value: { starX: number; starY: number; areaWidth: number; areaHeight: number }) => geometry(index, convert(value)) };
});
</script>
<style scoped>
.editorial-editor{width:100%;min-width:0}.hint{margin:6px 0 10px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.toolbar :deep(.el-select){max-width:230px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.stored{margin:0 0 8px;max-width:100%;font-size:12px;overflow-wrap:anywhere}.editorial-editor :deep(.el-input-number){width:100%}@media(max-width:620px){.fields{grid-template-columns:1fr}}
</style>
