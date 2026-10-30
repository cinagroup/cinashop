<template>
  <section class="follow-editor" aria-label="公众号关注作者编辑器">
    <strong>公众号关注</strong>
    <p class="hint">编辑当前组件的头像、二维码与样式，保存页面后生效。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else>
      <div class="toolbar"><el-button :disabled="!canEdit" @click="add">添加公众号关注组件</el-button></div>
      <template v-if="entries.length">
        <el-select :model-value="selected" aria-label="选择公众号关注组件" @update:model-value="select"><el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index + 1} 项 · 公众号关注`" /></el-select>
        <div class="toolbar"><el-button :disabled="!canEdit" @click="move(-1)">上移关注组件</el-button><el-button :disabled="!canEdit" @click="move(1)">下移关注组件</el-button><el-button :disabled="!canEdit" type="danger" @click="remove">删除关注组件</el-button></div>
        <template v-if="block">
          <el-form label-position="top" :disabled="!canEdit">
            <div class="fields">
              <el-form-item label="关注组件显示"><el-switch :model-value="!flag(block.isHide)" @update:model-value="setVisible" /></el-form-item>
              <el-form-item label="关注标题"><el-input :model-value="text(read(block, ['titleConfig', 'value']))" :maxlength="Math.max(10, text(read(block, ['titleConfig', 'value'])).length)" aria-label="关注标题" @update:model-value="setTitle" /></el-form-item>
              <el-form-item label="旧版展示位置"><el-select :model-value="position" @update:model-value="setPosition"><el-option label="顶部" :value="0" /><el-option label="底部" :value="1" /></el-select><p class="hint">保留原位置选择；当前客户端按页面组件顺序展示。</p></el-form-item>
              <el-form-item v-for="field in lengths" :key="field.key" :label="field.label + '（设计 px）'"><el-input-number :model-value="number(read(block, [field.key, 'val']))" :min="0" :max="Math.max(field.max, number(read(block, [field.key, 'val'])))" @update:model-value="setLength(field.key, $event)" /></el-form-item>
            </div>
            <el-form-item v-for="field in images" :key="field.key" :label="field.label">
              <div class="media-field"><p class="stored">{{ text(read(block, [field.key, 'url'])) || '未选择图片' }}</p><SeckillActivityImagePicker :disabled="!canChooseMedia" :editor-key="mediaSessions[field.key].key" :title="field.label" @choose="mediaSessions[field.key].choose" /><el-button :disabled="!canEdit" @click="clearImage(field.key)">清空{{ field.label }}</el-button></div>
            </el-form-item>
            <div class="fields">
              <el-form-item v-for="field in colours" :key="field.key + field.index" :label="field.label"><el-color-picker :model-value="colour(field)" show-alpha @update:model-value="setColour(field, $event)" /><el-input :model-value="colour(field)" :aria-label="field.label" @update:model-value="setColour(field, $event)" /></el-form-item>
              <el-form-item label="关注背景圆角方式"><el-select :model-value="flag(read(block, ['fillet', 'type'])) ? 1 : 0" @update:model-value="setRadiusType"><el-option label="全部圆角" :value="0" /><el-option label="独立四角" :value="1" /></el-select></el-form-item>
              <el-form-item v-if="!flag(read(block, ['fillet', 'type']))" label="关注背景圆角"><el-input-number :model-value="number(read(block, ['fillet', 'val']))" :min="0" :max="Math.max(80, number(read(block, ['fillet', 'val'])))" @update:model-value="setRadius(-1, $event)" /></el-form-item>
              <template v-else><el-form-item v-for="(corner, index) in corners" :key="corner" :label="'关注背景' + corner + '圆角'"><el-input-number :model-value="number(read(block, ['fillet', 'valList', index, 'val']))" :min="0" :max="Math.max(80, number(read(block, ['fillet', 'valList', index, 'val'])))" @update:model-value="setRadius(index, $event)" /></el-form-item></template>
            </div>
          </el-form>
          <p class="hint">导入值原样保留；预览采用当前客户端的数值与圆角规则。图片存储稳定地址，预览签名不会写入页面。</p>
          <el-alert v-if="error" :title="error" type="warning" :closable="false" />
          <div class="toolbar"><el-button :disabled="!canEdit || !pageId || !pagePublished || mediaLoading" :loading="mediaLoading" @click="loadSavedMedia">读取已发布关注图片预览</el-button></div>
          <DiyFollowPreview :block="block" :previews="previews" />
        </template>
      </template>
      <p v-else class="hint">此页面暂无公众号关注组件。</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
import DiyFollowPreview from '@/components/content/DiyFollowPreview.vue';
import { followEntries, addFollowBlock, moveFollowBlock, canonicalFollowBlock } from '@/utils/diyFollowEditor';
import { navigationDocument, navigationRecord as record, navRead as read, navSet, navFlag as flag, navText as text, canonicalNavigationImage } from '@/utils/diyNavigationEditor';
import { listRawNumber as number } from '@/utils/diyListEditor';
import { listSafeColor } from '@/utils/diyListProjection';
import { canonicalPresentationReference, presentationPreviewForReference } from '@/utils/diyPresentationEditor';

type ImageKey = 'imgConfig' | 'codeConfig';
interface Colour { key: string; index: number; label: string; fallback: string }
const props = withDefaults(defineProps<{ modelValue: string; editorKey: string; disabled?: boolean; pageId?: number; pagePublished?: boolean }>(), { disabled: false, pageId: 0, pagePublished: false });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>(), auth = useAuthStore();
const selected = ref(-1), revision = ref(0), error = ref(''), previews = ref<Record<string, string>>({}), mediaLoading = ref(false);
const lengths = [{ key: 'prConfig', label: '左右边距', max: 80 }, { key: 'mbConfig', label: '页面上间距', max: 100 }];
const images: Array<{ key: ImageKey; label: string }> = [{ key: 'imgConfig', label: '公众号头像' }, { key: 'codeConfig', label: '关注二维码' }];
const colours: Colour[] = [{ key: 'themeColor', index: 0, label: '关注按钮颜色', fallback: '#E93323' }, { key: 'bgColor', index: 0, label: '关注背景起始色', fallback: '#fff' }, { key: 'bgColor', index: 1, label: '关注背景结束色', fallback: '#fff' }];
const corners = ['左上', '右上', '右下', '左下'];
let alive = true, lastCommitted = '', receiptEpoch = 0, mediaAbort: AbortController | null = null;
const actor = () => `${auth.token}:${auth.userInfo?.id}:${auth.userInfo?.level}:${auth.uniqueAuth.join(',')}:${getToken()}:${localStorage.getItem('admin_session')}`;
function editable() { return alive && !props.disabled && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('dise.manage')); }
const canEdit = computed(() => { void revision.value; return editable(); });
const canChooseMedia = computed(() => canEdit.value && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('attachment.view')));
const parsed = computed(() => { try { return { value: navigationDocument(props.modelValue), error: '' }; } catch (reason) { return { value: null, error: reason instanceof Error ? reason.message : '装修 JSON 无效' }; } });
const document = computed(() => parsed.value.value), entries = computed(() => followEntries(document.value ?? []));
const block = computed(() => { const row = record(document.value?.[selected.value]); return row?.name === 'follow' ? row : null; });
const position = computed(() => Number(read(block.value, ['positionConfig', 'tabVal'])) === 1 ? 1 : 0);
function stamp() { return { actor: actor(), editor: props.editorKey, index: selected.value, revision: revision.value, raw: props.modelValue }; }
function current(issued: ReturnType<typeof stamp>) { return editable() && issued.actor === actor() && issued.editor === props.editorKey && issued.index === selected.value && issued.revision === revision.value && issued.raw === props.modelValue; }
function invalidate() { revision.value++; mediaAbort?.abort(); mediaAbort = null; mediaLoading.value = false; previews.value = {}; error.value = ''; }
function invalidateContext() { receiptEpoch++; invalidate(); }
watch(entries, () => { if (!entries.value.some(row => row.index === selected.value)) selected.value = entries.value[0]?.index ?? -1; }, { immediate: true });
watch(() => props.modelValue, value => { if (value !== lastCommitted) receiptEpoch++; invalidate(); }, { flush: 'sync' });
watch(() => [props.editorKey, props.disabled, props.pageId, props.pagePublished, actor()], invalidateContext, { flush: 'sync' });
for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) window.addEventListener(event, invalidateContext);
onBeforeUnmount(() => { alive = false; invalidateContext(); for (const event of ['admin-session-changed', 'admin-auth-expired', 'storage']) window.removeEventListener(event, invalidateContext); });
function commit(value: unknown[]) { if (!editable()) return false; try { const raw = JSON.stringify(value, null, 2); navigationDocument(raw); invalidateContext(); lastCommitted = raw; emit('update:modelValue', raw); return true; } catch (reason) { error.value = reason instanceof Error ? reason.message : '当前内容无法完整编辑'; return false; } }
function edit(change: (row: Record<string, unknown>) => void) { if (!editable() || !document.value || !block.value) return false; try { const copy = structuredClone(document.value); change(record(copy[selected.value])!); return commit(copy); } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法修改当前字段'; return false; } }
function setLeaf(path: Array<string | number>, value: unknown) { if (read(block.value, path) === value) return false; return edit(row => navSet(row, path, value)); }
function select(value: unknown) { if (typeof value === 'number' && entries.value.some(row => row.index === value)) { invalidateContext(); selected.value = value; } }
function add() { if (!editable() || !document.value) return; try { const result = addFollowBlock(document.value); if (commit(result.value)) selected.value = result.selected; } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法添加组件'; } }
function remove() { if (!editable() || !document.value || !block.value) return; const copy = structuredClone(document.value); copy.splice(selected.value, 1); if (commit(copy)) selected.value = -1; }
function move(direction: -1 | 1) { if (!editable() || !document.value || !block.value) return; try { const result = moveFollowBlock(document.value, selected.value, direction); if (commit(result.value)) selected.value = result.selected; } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法移动组件'; } }
function setVisible(value: unknown) { if (typeof value === 'boolean' && flag(block.value?.isHide) !== !value) setLeaf(['isHide'], !value); }
function setTitle(value: unknown) { if (typeof value === 'string' && value.length <= Math.max(10, text(read(block.value, ['titleConfig', 'value'])).length) && !/[\u0000-\u001f\u007f]/u.test(value)) setLeaf(['titleConfig', 'value'], value); }
function setPosition(value: unknown) { if ((value === 0 || value === 1) && position.value !== value) setLeaf(['positionConfig', 'tabVal'], value); }
function setLength(key: string, value: unknown) { const field = lengths.find(row => row.key === key); if (field && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= field.max && number(read(block.value, [key, 'val'])) !== value) setLeaf([key, 'val'], value); }
function colour(field: Colour) { return listSafeColor(read(block.value, [field.key, 'color', field.index, 'item']), field.fallback); }
function setColour(field: Colour, value: unknown) { if (colours.some(row => row.key === field.key && row.index === field.index) && typeof value === 'string' && listSafeColor(value, '') === value.trim()) setLeaf([field.key, 'color', field.index, 'item'], value.trim()); }
function setRadiusType(value: unknown) { if ((value === 0 || value === 1) && flag(read(block.value, ['fillet', 'type'])) !== !!value) setLeaf(['fillet', 'type'], value); }
function setRadius(index: number, value: unknown) { if (!Number.isInteger(index) || index < -1 || index > 3 || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 80) return; const path = index < 0 ? ['fillet', 'val'] : ['fillet', 'valList', index, 'val']; if (number(read(block.value, path)) !== value) setLeaf(path, value); }
function clearImage(key: ImageKey) { if (images.some(row => row.key === key)) setLeaf([key, 'url'], ''); }
const mediaSessions = computed(() => {
  const issued = stamp();
  const session = (key: ImageKey) => ({ key: `${props.editorKey}:${revision.value}:${selected.value}:${key}`, choose: async (reference: string, signed: string) => {
    if (!current(issued) || !canChooseMedia.value || !block.value) return;
    const approved = presentationPreviewForReference(reference, signed); if (!approved) return;
    let canonical: string; try { canonical = canonicalNavigationImage(reference); } catch { return; }
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
  return { imgConfig: session('imgConfig'), codeConfig: session('codeConfig') };
});
async function loadSavedMedia() {
  if (!editable() || !block.value || !props.pageId || !props.pagePublished) return;
  mediaAbort?.abort(); const controller = new AbortController(), issued = stamp(), id = props.pageId, expected = JSON.stringify(canonicalFollowBlock(block.value));
  mediaAbort = controller; mediaLoading.value = true; previews.value = {}; error.value = '';
  try {
    const response = await fetch(`/api/diy/get_diy/${id}`, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal });
    const body = record(await response.json()), data = record(body?.data);
    if (!current(issued) || controller.signal.aborted || props.pageId !== id || !props.pagePublished) return;
    if (!response.ok || body?.status !== 200 || !Array.isArray(data?.value)) throw Error('公开关注组件暂不可用');
    const found = data.value.map(record).find(row => row?.name === 'follow' && JSON.stringify(canonicalFollowBlock(row)) === expected);
    if (!found) throw Error('当前关注组件与已发布内容不同，请保存后再读取');
    const next: Record<string, string> = {};
    for (const { key } of images) { const reference = text(read(block.value, [key, 'url'])), approved = presentationPreviewForReference(reference, read(found, [key, 'url'])); if (approved) next[canonicalPresentationReference(reference)] = approved; }
    previews.value = next;
  } catch (reason) { if (current(issued) && mediaAbort === controller && !controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '关注图片预览失败'; }
  finally { if (mediaAbort === controller) { mediaAbort = null; mediaLoading.value = false; } }
}
</script>

<style scoped>
.follow-editor{width:100%;min-width:0}.hint{margin:6px 0 10px;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.toolbar,.media-field{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.stored{flex-basis:100%;max-width:100%;margin:0;font-size:12px;overflow-wrap:anywhere}.follow-editor :deep(.el-select){max-width:100%}.follow-editor :deep(.el-input-number){width:100%}@media(max-width:620px){.fields{grid-template-columns:1fr}}
</style>
