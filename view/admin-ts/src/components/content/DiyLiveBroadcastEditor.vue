<template>
  <section class="live-broadcast-editor" aria-label="直播作者编辑器">
    <strong>小程序直播</strong>
    <p class="hint">编辑与装修 JSON 同步，保存页面后生效。完整保留导入资料；公开客户端仅微信小程序展示直播目录。</p>
    <el-alert v-if="parsed.error" :title="parsed.error" type="warning" :closable="false" />
    <template v-else>
      <div :key="`add:${session.key}`" class="toolbar"><el-button :disabled="!canEdit" @click="session.add">添加直播组件</el-button></div>
      <template v-if="entries.length">
        <el-select :key="`select:${session.key}`" :model-value="selected" :disabled="!canEdit" aria-label="选择直播组件" @update:model-value="session.select">
          <el-option v-for="entry in entries" :key="entry.index" :value="entry.index" :label="`第 ${entry.index + 1} 项 · 小程序直播`" />
        </el-select>
        <div :key="`move:${session.key}`" class="toolbar">
          <el-button :disabled="!canEdit" @click="session.up">上移直播组件</el-button>
          <el-button :disabled="!canEdit" @click="session.down">下移直播组件</el-button>
          <el-button :disabled="!canEdit" type="danger" @click="session.remove">删除直播组件</el-button>
        </div>
        <template v-if="block">
          <el-form :key="session.key" label-position="top" :disabled="!canEdit">
            <div class="fields">
              <el-form-item label="直播显示"><el-switch :model-value="!flag(block.isHide)" @update:model-value="session.visible" /></el-form-item>
              <el-form-item v-for="field in enums" :key="field.key" :label="field.label">
                <el-select :model-value="number(read(block, [field.key, 'tabVal']))" :aria-label="field.label" @update:model-value="session.enums[field.key]">
                  <el-option v-for="(label, index) in field.options" :key="index" :label="label" :value="index" />
                </el-select>
              </el-form-item>
              <el-form-item label="直播数量">
                <el-input-number :model-value="number(read(block, ['numberConfig', 'val']), 10)" :min="Math.min(1, number(read(block, ['numberConfig', 'val']), 10))" :max="Math.max(100, number(read(block, ['numberConfig', 'val']), 10))" aria-label="直播数量" @update:model-value="session.count" />
              </el-form-item>
            </div>
            <el-form-item label="展示信息">
              <div class="checks"><el-checkbox v-for="field in checkFields" :key="field.id" :model-value="checks.includes(field.id)" :aria-label="field.label" @update:model-value="session.checks[field.id]">{{ field.label }}</el-checkbox></div>
            </el-form-item>
            <p class="hint">普通新数量为1–100，当前公开目录最多展示50项。导入的0、微小数、超量值和备用样式资料完整保留；展示选项不会更改目录的直播间或商品。</p>
            <div class="fields">
              <el-form-item v-for="field in lengths" :key="field.key" :label="field.label">
                <el-input-number :model-value="number(read(block, [field.key, 'val']), field.fallback)" :min="0" :max="Math.max(100, number(read(block, [field.key, 'val']), field.fallback))" :aria-label="field.label" @update:model-value="session.lengths[field.key]" />
              </el-form-item>
              <template v-for="field in radiusFields" :key="field.key">
                <el-form-item :label="field.label + '方式'">
                  <el-select :model-value="!!read(block, [field.key, 'type']) ? 1 : 0" :aria-label="field.label + '方式'" @update:model-value="session.radiusModes[field.key]">
                    <el-option label="统一圆角" :value="0" /><el-option label="独立四角" :value="1" />
                  </el-select>
                </el-form-item>
                <el-form-item v-for="(label, index) in !!read(block, [field.key, 'type']) ? ['左上', '右上', '左下', '右下'] : ['统一']" :key="field.key + label" :label="field.label + label">
                  <el-input-number :model-value="number(read(block, radiusPath(field.key, index)), field.fallback)" :min="0" :max="Math.max(100, number(read(block, radiusPath(field.key, index)), field.fallback))" :aria-label="field.label + label" @update:model-value="session.radii[field.key][index]" />
                </el-form-item>
              </template>
              <el-form-item v-for="field in colours" :key="field.label" :label="field.label">
                <el-input :model-value="colour(field)" :aria-label="field.label" @update:model-value="session.colours[field.label]" />
                <el-color-picker :model-value="colour(field)" show-alpha @update:model-value="session.colours[field.label]" />
              </el-form-item>
            </div>
            <p class="hint">间距和圆角按设计px保存。封面、主播头像与商品图片来自公开直播目录，不属于此组件的可编辑图片。</p>
          </el-form>
          <el-alert v-if="error" :title="error" type="warning" :closable="false" />
          <div :key="`preview:${session.key}`" class="toolbar"><el-button :disabled="!canEdit || loading" :loading="loading" @click="session.preview">读取公开直播目录</el-button></div>
          <DiyLiveBroadcastPreview :block="block" :rooms="rooms" :loaded="loaded" :loading="loading" :error="previewError" />
        </template>
      </template>
      <p v-else class="hint">此页面暂无直播组件。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/utils/auth';
import {
  liveBroadcastDocument, liveBroadcastRecord as record, liveBroadcastEntries,
  liveBroadcastRead as read, liveBroadcastFlag as flag, liveBroadcastNumber as number,
  addLiveBroadcastBlock, moveLiveBroadcastBlock, removeLiveBroadcastBlock,
  liveBroadcastSet, setLiveBroadcastNumber, setLiveBroadcastCount, setLiveBroadcastEnum,
  liveBroadcastChecks, setLiveBroadcastChecks, type LiveBroadcastCheck, type LiveBroadcastRecord,
} from '@/utils/diyLiveBroadcastEditor';
import { apiDiyLiveBroadcastPreview, type LiveBroadcastRoomPreview } from '@/api/diyLiveBroadcastAuthor';
import { liveBroadcastPresentation } from '../../../../common/diyLiveBroadcast';
import { listSafeColor } from '@/utils/diyListProjection';
import DiyLiveBroadcastPreview from './DiyLiveBroadcastPreview.vue';

const props = withDefaults(defineProps<{
  modelValue: string; editorKey: string; disabled?: boolean; pageId?: number; pagePublished?: boolean;
}>(), { disabled: false, pageId: 0, pagePublished: false });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const auth = useAuthStore();
const selected = ref(-1), revision = ref(0), contextEpoch = ref(0), error = ref('');
const rooms = ref<LiveBroadcastRoomPreview[]>([]), loading = ref(false), loaded = ref(false), previewError = ref(''), awaitingReceipt = ref(false);
let alive = true, request: AbortController | null = null, receiptSerial = 0;
const sessionEvents = ['admin-session-changed', 'admin-auth-expired', 'storage'] as const;
const actor = () => JSON.stringify([auth.token, auth.userInfo?.id, auth.userInfo?.level, auth.uniqueAuth, getToken(), localStorage.getItem('admin_session')]);
const editable = () => alive && !props.disabled && !!auth.token && auth.token === getToken() && !!auth.userInfo && (auth.userInfo.level === 0 || auth.uniqueAuth.includes('dise.manage'));
const canEdit = computed(() => { void revision.value; return editable() && !awaitingReceipt.value; });
const parsed = computed(() => {
  try { return { value: liveBroadcastDocument(props.modelValue), error: '' }; }
  catch (reason) { return { value: null, error: reason instanceof Error ? reason.message : '装修JSON无效' }; }
});
const document = computed(() => parsed.value.value);
const entries = computed(() => liveBroadcastEntries(document.value ?? []));
const block = computed(() => { const row = record(document.value?.[selected.value]); return row?.name === 'liveBroadcast' ? row : null; });
const view = computed(() => liveBroadcastPresentation(block.value, listSafeColor));
const checks = computed(() => block.value ? liveBroadcastChecks(block.value) : []);
function stamp() {
  return { actor: actor(), editor: props.editorKey, page: props.pageId, published: props.pagePublished, raw: props.modelValue, selected: selected.value, revision: revision.value, context: contextEpoch.value };
}
type Stamp = ReturnType<typeof stamp>;
function current(issued: Stamp) {
  return editable() && !awaitingReceipt.value && issued.actor === actor() && issued.editor === props.editorKey && issued.page === props.pageId && issued.published === props.pagePublished && issued.raw === props.modelValue && issued.selected === selected.value && issued.revision === revision.value && issued.context === contextEpoch.value;
}
type Receipt = { raw: string; source: string; serial: number; keep: boolean; selected: number; issued: Stamp };
let pending: Receipt | null = null;
function invalidate(keep = false) {
  revision.value++;
  request?.abort(); request = null; loading.value = false; error.value = '';
  if (!keep) { rooms.value = []; loaded.value = false; previewError.value = ''; }
}
function context() { pending = null; awaitingReceipt.value = false; contextEpoch.value++; invalidate(); }
function selectExisting(preferred: number) {
  selected.value = entries.value.some(entry => entry.index === preferred) ? preferred : entries.value[0]?.index ?? -1;
}
// Consume one exact parent receipt, including the intended post-add/move/delete
// selection. Never examine the predecessor document to pick the newly-added row.
watch(() => props.modelValue, (raw, previous) => {
  const receipt = pending; pending = null; awaitingReceipt.value = false;
  const own = receipt && receipt.raw === raw && receipt.source === previous &&
    receipt.issued.actor === actor() && receipt.issued.editor === props.editorKey &&
    receipt.issued.page === props.pageId && receipt.issued.published === props.pagePublished &&
    receipt.issued.revision === revision.value && receipt.issued.context === contextEpoch.value;
  contextEpoch.value++;
  invalidate(own && receipt ? receipt.keep : false);
  selectExisting(own && receipt ? receipt.selected : selected.value);
}, { immediate: true, flush: 'sync' });
watch(() => [props.editorKey, props.disabled, props.pageId, props.pagePublished, actor()], () => { context(); selectExisting(selected.value); }, { flush: 'sync' });
onMounted(() => { for (const event of sessionEvents) window.addEventListener(event, context); });
onBeforeUnmount(() => { alive = false; context(); for (const event of sessionEvents) window.removeEventListener(event, context); });

function commit(value: unknown[], keep = false, nextSelected = selected.value): boolean {
  if (!editable() || awaitingReceipt.value) return false;
  try {
    const raw = JSON.stringify(value, null, 2); liveBroadcastDocument(raw);
    if (raw === props.modelValue) return false;
    const source = props.modelValue;
    invalidate(keep);
    const serial = ++receiptSerial;
    pending = { raw, source, serial, keep, selected: nextSelected, issued: stamp() };
    awaitingReceipt.value = true;
    emit('update:modelValue', raw);
    // A later asynchronous parent replacement is an external context change.
    // Expiring the receipt prevents a matching future raw string reviving it.
    void nextTick(() => { if (pending?.serial === serial) { pending = null; awaitingReceipt.value = false; revision.value++; } });
    return true;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '当前配置无法完整保存'; return false; }
}
function edit(change: (row: LiveBroadcastRecord) => unknown): boolean {
  if (!editable() || !document.value || !block.value) return false;
  try {
    const copy = structuredClone(document.value), row = record(copy[selected.value])!;
    change(row);
    if (JSON.stringify(copy) === JSON.stringify(document.value)) return false;
    return commit(copy, liveBroadcastPresentation(row, listSafeColor).limit === view.value.limit);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '当前字段无法修改'; return false; }
}
function select(value: unknown) {
  if (typeof value === 'number' && entries.value.some(entry => entry.index === value) && value !== selected.value) { context(); selected.value = value; }
}
function add() {
  if (!document.value) return;
  try { const next = addLiveBroadcastBlock(document.value); commit(next.value, false, next.selected); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '无法添加直播组件'; }
}
function move(direction: -1 | 1) {
  if (!document.value) return;
  try { const next = moveLiveBroadcastBlock(document.value, selected.value, direction); commit(next.value, false, next.selected); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '无法移动直播组件'; }
}
function remove() {
  if (!document.value) return;
  try { const next = removeLiveBroadcastBlock(document.value, selected.value); commit(next.value, false, next.selected); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '无法删除直播组件'; }
}
const enums = [
  { key: 'setUp', label: '直播编辑分组', options: ['内容', '样式'] },
  { key: 'styleConfig', label: '直播布局', options: ['完整封面', '封面与商品', '横向滑动', '首图与列表'] },
] as const;
const checkFields: Array<{ id: LiveBroadcastCheck; label: string }> = [{ id: 0, label: '直播标题' }, { id: 1, label: '用户名称' }];
const lengths = [
  { key: 'liveConfig', label: '直播间距（设计px）', fallback: 10 },
  { key: 'topConfig', label: '上边距（设计px）', fallback: 0 },
  { key: 'bottomConfig', label: '下边距（设计px）', fallback: 0 },
  { key: 'prConfig', label: '左右边距（设计px）', fallback: 10 },
  { key: 'mbConfig', label: '页面上间距（设计px）', fallback: 0 },
] as const;
const radiusFields = [{ key: 'filletImg', label: '图片圆角', fallback: 8 }, { key: 'fillet', label: '背景圆角', fallback: 8 }] as const;
type RadiusKey = typeof radiusFields[number]['key'];
function radiusPath(key: RadiusKey, index: number): Array<string | number> { return read(block.value, [key, 'type']) ? [key, 'valList', index, 'val'] : [key, 'val']; }
const colours = [
  { key: 'moduleColor', index: 0, label: '组件背景起始色', fallback: '#fff' },
  { key: 'moduleColor', index: 1, label: '组件背景结束色', fallback: '#fff' },
  { key: 'bottomBgColor', index: 0, label: '底部背景颜色', fallback: '#f5f5f5' },
] as const;
type Colour = typeof colours[number];
function colour(field: Colour) { return listSafeColor(read(block.value, [field.key, 'color', field.index, 'item']), field.fallback); }
function setColour(field: Colour, value: unknown) {
  if (typeof value === 'string' && listSafeColor(value, '') === value.trim()) edit(row => liveBroadcastSet(row, [field.key, 'color', field.index, 'item'], value.trim()));
}
function length(field: typeof lengths[number], value: unknown) {
  edit(row => setLiveBroadcastNumber(row, [field.key, 'val'], value, 0, Math.max(100, number(read(row, [field.key, 'val']), field.fallback))));
}
function radius(field: typeof radiusFields[number], index: number, value: unknown) {
  const path = radiusPath(field.key, index);
  edit(row => setLiveBroadcastNumber(row, path, value, 0, Math.max(100, number(read(row, path), field.fallback))));
}
async function preview() {
  if (!block.value || loading.value) return;
  request?.abort(); const controller = new AbortController(), issued = stamp(), limit = view.value.limit;
  request = controller; rooms.value = []; loaded.value = false; previewError.value = ''; loading.value = true;
  try {
    const next = limit > 0 ? await apiDiyLiveBroadcastPreview(limit, controller.signal) : [];
    if (!current(issued) || request !== controller || controller.signal.aborted) return;
    rooms.value = next; loaded.value = true;
  } catch (reason) {
    if (current(issued) && request === controller && !controller.signal.aborted) previewError.value = reason instanceof Error ? reason.message : '直播目录读取失败，请重试';
  } finally { if (request === controller) { request = null; loading.value = false; } }
}
// All child-component listeners receive a closure for the exact complete raw
// document, selected block, actor, page, publication state and monotonic context.
const session = computed(() => {
  const issued = stamp();
  const guard = <T extends unknown[]>(fn: (...args: T) => unknown) => (...args: T) => { if (current(issued)) return fn(...args); };
  return {
    key: `${contextEpoch.value}:${revision.value}`,
    add: guard(add), select: guard(select), up: guard(() => move(-1)), down: guard(() => move(1)), remove: guard(remove),
    visible: guard((value: unknown) => { if (typeof value === 'boolean' && flag(block.value?.isHide) !== !value) edit(row => liveBroadcastSet(row, ['isHide'], !value)); }),
    count: guard((value: unknown) => edit(row => setLiveBroadcastCount(row, value))),
    enums: Object.fromEntries(enums.map(field => [field.key, guard((value: unknown) => edit(row => setLiveBroadcastEnum(row, field.key, value)))])),
    checks: Object.fromEntries(checkFields.map(field => [field.id, guard((value: unknown) => { if (typeof value === 'boolean' && value !== checks.value.includes(field.id)) edit(row => setLiveBroadcastChecks(row, value ? [...checks.value, field.id] : checks.value.filter(id => id !== field.id))); })])),
    lengths: Object.fromEntries(lengths.map(field => [field.key, guard((value: unknown) => length(field, value))])),
    radiusModes: Object.fromEntries(radiusFields.map(field => [field.key, guard((value: unknown) => { if ((value === 0 || value === 1) && !!read(block.value, [field.key, 'type']) !== !!value) edit(row => liveBroadcastSet(row, [field.key, 'type'], value)); })])),
    radii: Object.fromEntries(radiusFields.map(field => [field.key, [0, 1, 2, 3].map(index => guard((value: unknown) => radius(field, index, value)))])),
    colours: Object.fromEntries(colours.map(field => [field.label, guard((value: unknown) => setColour(field, value))])),
    preview: guard(preview),
  };
});
</script>
<style scoped>
.live-broadcast-editor{width:100%;min-width:0;overflow-wrap:anywhere}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.checks{display:flex;gap:12px;flex-wrap:wrap;width:100%;min-width:0}.checks :deep(.el-checkbox){max-width:100%;height:auto;margin-right:0;align-items:flex-start}.checks :deep(.el-checkbox__label){min-width:0;white-space:normal;overflow-wrap:anywhere}.el-form-item{min-width:0}.el-select{max-width:100%}.el-form-item :deep(.el-input-number){max-width:100%}@media(max-width:600px){.fields{grid-template-columns:1fr}}
</style>
