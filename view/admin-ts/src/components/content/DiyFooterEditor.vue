<template>
  <section class="footer-editor" aria-label="底部导航编辑器">
    <div class="heading"><strong>底部导航</strong><span class="hint">与下方装修 JSON 同步，保存页面后生效。</span></div>
    <el-alert v-if="parseError" :title="parseError" type="warning" :closable="false" />
    <template v-else-if="documentValue">
      <el-button v-if="!footers.length" :disabled="disabled" @click="addFooter">添加底部导航</el-button>
      <template v-else>
        <el-select v-if="footers.length > 1" :model-value="selectedIndex" aria-label="选择底部导航组件" @update:model-value="selectFooter">
          <el-option v-for="entry in footers" :key="entry.index" :value="entry.index" :label="`第 ${entry.index + 1} 个组件 · ${entry.name}`" />
        </el-select>
        <p v-if="footers.length > 1" class="hint">导入页面含多个页脚；仅编辑当前项，不合并或删除其它组件。</p>
        <el-alert v-if="menuError" :title="menuError" type="warning" :closable="false" />
        <el-form v-if="footer" label-position="top" :disabled="disabled">
          <div class="field-grid">
            <el-form-item label="显示底部导航"><el-select :model-value="tab('effectConfig', 0)" @update:model-value="setTab('effectConfig', $event)"><el-option label="系统默认" :value="0" /><el-option label="自定义" :value="1" /></el-select></el-form-item>
            <el-form-item label="导航形状"><el-select :model-value="tab('navConfig', 0)" @update:model-value="setTab('navConfig', $event)"><el-option label="通栏" :value="0" /><el-option label="浮动" :value="1" /></el-select></el-form-item>
            <el-form-item label="内容样式"><el-select :model-value="tab('navStyleConfig', 0)" @update:model-value="setTab('navStyleConfig', $event)"><el-option label="图标和文字" :value="0" /><el-option label="仅文字" :value="1" /><el-option label="仅图标" :value="2" /></el-select></el-form-item>
            <el-form-item label="文字配色"><el-select :model-value="tab('toneConfig', 0)" @update:model-value="setTab('toneConfig', $event)"><el-option label="跟随主题" :value="0" /><el-option label="自定义" :value="1" /></el-select></el-form-item>
            <el-form-item v-for="field in colorFields" :key="field.key" :label="field.label"><el-color-picker :model-value="colour(field.key, field.fallback)" show-alpha @update:model-value="setColour(field.key, $event)" /><el-input :model-value="colour(field.key, field.fallback)" :aria-label="field.label" @update:model-value="setColour(field.key, $event)" /></el-form-item>
            <el-form-item v-for="field in spacingFields" :key="field.key" :label="field.label + '（px）'"><el-input-number :model-value="spacing(field.key)" :min="0" :max="100" controls-position="right" @update:model-value="setSpacing(field.key, $event)" /></el-form-item>
            <el-form-item label="圆角设置"><el-select :model-value="radiusType" @update:model-value="setRadiusType"><el-option label="统一圆角" :value="0" /><el-option label="分别设置" :value="1" /></el-select></el-form-item>
            <el-form-item v-if="!radiusType" label="圆角（px）"><el-input-number :model-value="radius(0)" :min="0" :max="100" @update:model-value="setRadius(0, $event)" /></el-form-item>
            <template v-else><el-form-item v-for="(label, index) in ['左上', '右上', '左下', '右下']" :key="label" :label="label + '圆角（px）'"><el-input-number :model-value="radius(index)" :min="0" :max="100" @update:model-value="setRadius(index, $event)" /></el-form-item></template>
          </div>
          <template v-if="!menuError">
            <p class="hint">选中图标为 imgList[0]，未选中图标为 imgList[1]。正常添加最多 5 项；导入的 {{ menus.length }} 项全部保留，可逐页编辑。</p>
            <div class="menu-actions"><el-button :disabled="disabled || menus.length >= 5" @click="addMenu">添加菜单</el-button><el-pagination v-if="menus.length > pageSize" :current-page="menuPage" :page-size="pageSize" :total="menus.length" layout="total, prev, pager, next" @current-change="menuPage = $event" /></div>
            <article v-for="entry in visibleMenus" :key="entry.index" class="menu-card">
              <div class="heading"><strong>菜单 {{ entry.index + 1 }}</strong><div class="menu-actions"><el-button :disabled="disabled || entry.index === 0" @click="moveMenu(entry.index, -1)">上移</el-button><el-button :disabled="disabled || entry.index === menus.length - 1" @click="moveMenu(entry.index, 1)">下移</el-button><el-button :disabled="disabled" type="danger" @click="removeMenu(entry.index)">删除</el-button></div></div>
              <template v-if="entry.item">
                <div class="field-grid"><el-form-item label="菜单名称"><el-input :model-value="text(entry.item.name)" @update:model-value="setMenuText(entry.index, 'name', $event)" /></el-form-item><el-form-item label="跳转链接"><el-input :model-value="text(entry.item.link)" @update:model-value="setMenuText(entry.index, 'link', $event)" /></el-form-item></div>
                <div class="icon-grid"><el-form-item v-for="(label, slot) in ['选中图标', '未选中图标']" :key="slot" :label="label"><div class="icon-field"><el-image v-if="iconPreview(entry.index, slot)" :src="iconPreview(entry.index, slot)" fit="contain" /><el-input :model-value="iconReference(entry.index, slot)" :aria-label="`菜单${entry.index + 1}${label}稳定地址`" placeholder="图库图片或稳定 HTTPS / 站内路径" @update:model-value="setIcon(entry.index, slot, $event)" /><SeckillActivityImagePicker :disabled="disabled" :editor-key="`${editorKey}:${revision}:${selectedIndex}:${entry.index}:${slot}`" :title="`选择${label}`" @choose="(reference, preview) => chooseIcon(entry.index, slot, reference, preview)" /></div></el-form-item></div>
              </template>
              <p v-else class="hint">此导入项不是菜单对象。原值保持不变，可在 JSON 中修复或明确删除。</p>
            </article>
            <div class="menu-actions"><el-button :disabled="disabled || !pageId || !pagePublished || previewLoading" :loading="previewLoading" @click="loadSavedPreviews">读取已保存图片预览</el-button><span class="hint">仅已发布且公开可读的已保存页脚可读取；未发布页面请从图库预览。</span></div>
            <el-alert v-if="previewError" :title="previewError" type="warning" :closable="false" />
            <div class="preview-label">当前菜单页预览 · {{ previewSelected ? '选中' : '未选中' }}状态 <el-switch v-model="previewSelected" /></div>
            <div class="preview-outer" :style="outerStyle"><div class="preview-bar" :style="barStyle"><div v-for="entry in visibleMenus" :key="entry.index" class="preview-item" :style="{ color: previewTextColour }"><img v-if="tab('navStyleConfig', 0) !== 1 && iconPreview(entry.index, previewSelected ? 0 : 1)" :src="iconPreview(entry.index, previewSelected ? 0 : 1)" alt="" /><span v-if="tab('navStyleConfig', 0) !== 2">{{ text(entry.item?.name) }}</span></div></div></div>
            <p class="hint">此处预览当前菜单页的形状和自定义配色；安全区、主题颜色、真实路由和购物车角标以客户端为准。关闭显示也可继续编辑预览。</p>
          </template>
        </el-form>
      </template>
    </template>
  </section>
</template>

<script lang="ts">
type FooterRecord = Record<string, unknown>;
function asRecord(value: unknown): FooterRecord | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as FooterRecord : null; }
export function canonicalFooterIcon(value: string): string {
  const trimmed = value.trim(), match = /^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/u.exec(trimmed);
  return match ? `/api/assets/${match[1]}` : trimmed;
}
/** Only the real two icon slots acquire canonical storage. Foreign URLs,
 * links, later array elements and every other component remain unchanged. */
export function canonicalFooterValue(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(parsed)) for (const candidate of parsed) {
    const footer = asRecord(candidate);
    if (typeof footer?.name !== 'string' || footer.name.toLowerCase() !== 'pagefoot' || !Array.isArray(footer.menuList)) continue;
    for (const row of footer.menuList) {
      const icons = asRecord(row)?.imgList;
      if (Array.isArray(icons)) for (const index of [0, 1]) if (typeof icons[index] === 'string') icons[index] = canonicalFooterIcon(icons[index]);
    }
  }
  return JSON.stringify(parsed);
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';
import SeckillActivityImagePicker from '@/pages/activity/SeckillActivityImagePicker.vue';
const props = withDefaults(defineProps<{ modelValue: string; editorKey: string; pageId?: number; pagePublished?: boolean; disabled?: boolean }>(), { disabled: false, pageId: 0, pagePublished: false });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const selectedIndex = ref(-1), menuPage = ref(1), previewSelected = ref(true), revision = ref(0), previews = ref<Record<string, { reference: string; preview: string }>>({});
const previewLoading = ref(false), previewError = ref('');
let previewAbort: AbortController | null = null, alive = true;
function cancelPreview() { previewAbort?.abort(); previewAbort = null; previewLoading.value = false; }
const pageSize = 10, maxMenus = 10_000;
const colorFields = [{ key: 'activeTxtColor', label: '选中文字颜色', fallback: '#e93323' }, { key: 'txtColor', label: '未选中文字颜色', fallback: '#666666' }, { key: 'bgColor', label: '通栏背景颜色', fallback: '#ffffff' }, { key: 'bgColor2', label: '浮动背景颜色', fallback: '#ffffff' }];
const spacingFields = [{ key: 'topConfig', label: '上内边距' }, { key: 'bottomConfig', label: '下内边距' }, { key: 'prConfig', label: '浮动左右间距' }, { key: 'mbConfig', label: '浮动底部间距' }];
const documentValue = computed<unknown[] | null>(() => {
  try { const parsed: unknown = JSON.parse(props.modelValue); if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 2_000_000) return null; return Array.isArray(parsed) ? parsed : null; } catch { return null; }
});
const parseError = computed(() => documentValue.value ? '' : '页脚编辑器需要有效、压缩后 2 MB 以内的组件 JSON 数组；可在下方修复原 JSON。');
const footers = computed(() => (documentValue.value ?? []).flatMap((value, index) => { const row = asRecord(value); return typeof row?.name === 'string' && row.name.toLowerCase() === 'pagefoot' ? [{ index, name: row.name }] : []; }));
const footer = computed(() => asRecord(documentValue.value?.[selectedIndex.value]));
const menus = computed<unknown[]>(() => Array.isArray(footer.value?.menuList) ? footer.value.menuList : []);
const menuError = computed(() => footer.value && !Array.isArray(footer.value.menuList) ? 'menuList 不是数组，请先在 JSON 中修复；原值未被替换。' : menus.value.length > maxMenus ? '菜单超过完整编辑容量 10000 项；不会截断或丢弃，请在 JSON 中明确调整。' : '');
const visibleMenus = computed(() => menus.value.slice((menuPage.value - 1) * pageSize, menuPage.value * pageSize).map((item, offset) => ({ index: (menuPage.value - 1) * pageSize + offset, item: asRecord(item) })));
watch(footers, entries => { if (!entries.some(entry => entry.index === selectedIndex.value)) selectedIndex.value = entries[0]?.index ?? -1; }, { immediate: true, flush: 'sync' });
watch(() => menus.value.length, length => { menuPage.value = Math.max(1, Math.min(menuPage.value, Math.ceil(length / pageSize) || 1)); }, { flush: 'sync' });
watch(() => props.modelValue, () => { revision.value++; cancelPreview(); }, { flush: 'sync' });
watch(() => props.editorKey, () => { cancelPreview(); revision.value++; previews.value = {}; previewError.value = ''; menuPage.value = 1; selectedIndex.value = footers.value[0]?.index ?? -1; }, { flush: 'sync' });
watch(() => props.disabled, value => { if (value) cancelPreview(); }, { flush: 'sync' });
onBeforeUnmount(() => { alive = false; cancelPreview(); previews.value = {}; });
const text = (value: unknown) => typeof value === 'string' ? value : '';
function selectFooter(value: unknown) { if (typeof value === 'number' && footers.value.some(entry => entry.index === value)) { cancelPreview(); selectedIndex.value = value; revision.value++; previews.value = {}; menuPage.value = 1; } }
function edit(change: (value: FooterRecord) => void): boolean {
  if (props.disabled || !documentValue.value || !footer.value || menuError.value) return false;
  const copy = structuredClone(documentValue.value), target = asRecord(copy[selectedIndex.value]); if (!target) return false;
  change(target); emit('update:modelValue', JSON.stringify(copy, null, 2)); return true;
}
function addFooter() {
  if (props.disabled || !documentValue.value || footers.value.length) return;
  const initial = { name: 'pageFoot', timestamp: Date.now(), effectConfig: { tabVal: 1 }, navConfig: { tabVal: 0 }, navStyleConfig: { tabVal: 0 }, toneConfig: { tabVal: 0 }, menuList: [],
    activeTxtColor: { color: [{ item: '#e93323' }] }, txtColor: { color: [{ item: '#666666' }] }, bgColor: { color: [{ item: '#ffffff' }] }, bgColor2: { color: [{ item: '#ffffff' }] },
    topConfig: { val: 0 }, bottomConfig: { val: 0 }, prConfig: { val: 0 }, mbConfig: { val: 0 }, fillet: { type: 0, val: 0, valList: [0, 0, 0, 0].map(val => ({ val })) } };
  emit('update:modelValue', JSON.stringify([...documentValue.value, initial], null, 2));
}
function tab(key: string, fallback: number) { const value = asRecord(footer.value?.[key])?.tabVal; return value === 0 || value === 1 || value === 2 ? value : value === '0' || value === '1' || value === '2' ? Number(value) : fallback; }
function setTab(key: string, value: unknown) { if (!['effectConfig', 'navConfig', 'navStyleConfig', 'toneConfig'].includes(key) || typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > (key === 'navStyleConfig' ? 2 : 1)) return; edit(row => { row[key] = { ...asRecord(row[key]), tabVal: value }; }); }
function colour(key: string, fallback: string) { const colors = asRecord(footer.value?.[key])?.color; return Array.isArray(colors) ? text(asRecord(colors[0])?.item) || fallback : fallback; }
function setColour(key: string, value: unknown) { if (!colorFields.some(field => field.key === key) || typeof value !== 'string' || !/^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/iu.test(value)) return; edit(row => { const current = asRecord(row[key]), colors = Array.isArray(current?.color) ? [...current.color] : []; colors[0] = { ...asRecord(colors[0]), item: value }; row[key] = { ...current, color: colors }; }); }
function spacing(key: string) { const value = asRecord(footer.value?.[key])?.val; return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function setSpacing(key: string, value: unknown) { if (!spacingFields.some(field => field.key === key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return; edit(row => { row[key] = { ...asRecord(row[key]), val: value }; }); }
const radiusType = computed(() => asRecord(footer.value?.fillet)?.type === 1 || asRecord(footer.value?.fillet)?.type === '1' ? 1 : 0);
function radius(index: number) { const f = asRecord(footer.value?.fillet), values = f?.valList, value = radiusType.value && Array.isArray(values) ? asRecord(values[index])?.val : f?.val; return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function setRadiusType(value: unknown) { if (value !== 0 && value !== 1) return; edit(row => { row.fillet = { ...asRecord(row.fillet), type: value }; }); }
function setRadius(index: number, value: unknown) { if (![0, 1, 2, 3].includes(index) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return; edit(row => { const f = asRecord(row.fillet); if (radiusType.value) { const values = Array.isArray(f?.valList) ? [...f.valList] : []; values[index] = { ...asRecord(values[index]), val: value }; row.fillet = { ...f, valList: values }; } else row.fillet = { ...f, val: value }; }); }
function addMenu() { if (!Array.isArray(footer.value?.menuList) || menus.value.length >= 5) return; if (edit(row => { (row.menuList as unknown[]).push({ name: '自定义', link: '', imgList: ['', ''] }); })) { revision.value++; previews.value = {}; } }
function setMenuText(index: number, key: 'name' | 'link', value: unknown) { if (!Number.isSafeInteger(index) || index < 0 || index >= menus.value.length || !['name', 'link'].includes(key) || typeof value !== 'string') return; edit(row => { const entry = asRecord((row.menuList as unknown[])[index]); if (entry) entry[key] = value; }); }
function moveMenu(index: number, direction: number) { if (!Number.isSafeInteger(index) || ![-1, 1].includes(direction) || index < 0 || index + direction < 0 || index + direction >= menus.value.length) return; if (edit(row => { const rows = row.menuList as unknown[]; [rows[index], rows[index + direction]] = [rows[index + direction], rows[index]]; })) { revision.value++; previews.value = {}; } }
function removeMenu(index: number) { if (!Number.isSafeInteger(index) || index < 0 || index >= menus.value.length) return; if (edit(row => { (row.menuList as unknown[]).splice(index, 1); })) { revision.value++; previews.value = {}; } }
function iconReference(index: number, slot: number) { const icons = asRecord(menus.value[index])?.imgList; return Array.isArray(icons) ? text(icons[slot]) : ''; }
function safePreview(value: string) {
  if (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value)) return '';
  if (value.startsWith('/api/assets/')) {
    const url = new URL(value, 'https://preview.invalid'), expires = url.searchParams.get('expires');
    if (!/^\/api\/assets\/[1-9]\d*$/u.test(url.pathname) || !expires || !/^\d+$/u.test(expires) || Number(expires) * 1000 <= Date.now() || !url.searchParams.get('signature')) return '';
  }
  return value;
}
function iconPreview(index: number, slot: number) { const reference = iconReference(index, slot), preview = previews.value[`${selectedIndex.value}:${index}:${slot}`]; return safePreview(preview?.reference === reference ? preview.preview : reference); }
function setIcon(index: number, slot: number, value: unknown) { if (!Number.isSafeInteger(index) || index < 0 || index >= menus.value.length || !asRecord(menus.value[index]) || ![0, 1].includes(slot) || typeof value !== 'string') return false; const reference = canonicalFooterIcon(value); return edit(row => { const item = asRecord((row.menuList as unknown[])[index]); if (!item) return; const images = Array.isArray(item.imgList) ? [...item.imgList] : []; images[slot] = reference; item.imgList = images; }); }
function chooseIcon(index: number, slot: number, reference: string, preview: string) { if (setIcon(index, slot, reference)) previews.value[`${selectedIndex.value}:${index}:${slot}`] = { reference: canonicalFooterIcon(reference), preview }; }
async function loadSavedPreviews() {
  if (!alive || props.disabled || previewLoading.value || !Number.isSafeInteger(props.pageId) || props.pageId < 1 || !props.pagePublished || menuError.value) return;
  cancelPreview(); const controller = new AbortController(), key = props.editorKey, raw = props.modelValue, selected = selectedIndex.value, pageId = props.pageId;
  previewAbort = controller; previewLoading.value = true; previewError.value = ''; previews.value = {};
  const current = () => alive && !props.disabled && previewAbort === controller && !controller.signal.aborted && props.editorKey === key && props.modelValue === raw && selectedIndex.value === selected && props.pageId === pageId && props.pagePublished;
  try {
    const response = await fetch(`/api/diy/get_diy/${pageId}`, { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
    const body = asRecord(await response.json()), data = asRecord(body?.data);
    if (!response.ok || body?.status !== 200 || !Array.isArray(data?.value)) throw Error('公开图片预览暂不可用，请核对页面发布状态或图库素材。');
    if (!current()) return;
    const references = new Map<string, string>(); let matched = false;
    const expected = canonicalFooterValue(JSON.stringify([footer.value]));
    for (const candidate of data.value) {
      const row = asRecord(candidate);
      if (typeof row?.name !== 'string' || row.name.toLowerCase() !== 'pagefoot' || !Array.isArray(row.menuList) || canonicalFooterValue(JSON.stringify([row])) !== expected) continue;
      matched = true;
      for (const item of row.menuList) { const images = asRecord(item)?.imgList; if (Array.isArray(images)) for (const slot of [0, 1]) if (typeof images[slot] === 'string' && safePreview(images[slot])) references.set(canonicalFooterIcon(images[slot]), images[slot]); }
    }
    if (!matched) throw Error('当前页脚与已保存的公开配置不一致；请保存后重新读取，或从图库选择预览。');
    const next = { ...previews.value };
    menus.value.forEach((item, index) => { const images = asRecord(item)?.imgList; if (Array.isArray(images)) for (const slot of [0, 1]) { const reference = text(images[slot]), preview = references.get(canonicalFooterIcon(reference)); if (preview) next[`${selected}:${index}:${slot}`] = { reference, preview }; } });
    previews.value = next;
  } catch (reason) { if (current()) previewError.value = reason instanceof Error ? reason.message : '公开图片预览读取失败'; }
  finally { if (previewAbort === controller) { previewAbort = null; previewLoading.value = false; } }
}
const previewTextColour = computed(() => tab('toneConfig', 0) ? colour(previewSelected.value ? 'activeTxtColor' : 'txtColor', '#666666') : '#666666');
const outerStyle = computed<CSSProperties>(() => ({ padding: tab('navConfig', 0) ? `0 ${spacing('prConfig')}px ${spacing('mbConfig')}px` : '0', background: '#f1f3f5' }));
const barStyle = computed<CSSProperties>(() => ({ background: colour(tab('navConfig', 0) ? 'bgColor2' : 'bgColor', '#ffffff'), paddingTop: `${spacing('topConfig')}px`, paddingBottom: `${spacing('bottomConfig')}px`, borderRadius: tab('navConfig', 0) ? (radiusType.value ? `${radius(0)}px ${radius(1)}px ${radius(3)}px ${radius(2)}px` : `${radius(0)}px`) : '0' }));
</script>

<style scoped>
.footer-editor{display:grid;gap:14px;width:100%;padding:16px;border:1px solid var(--el-border-color);border-radius:8px}.heading,.menu-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.hint{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:0}.field-grid,.icon-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.field-grid :deep(.el-select),.field-grid :deep(.el-input-number){width:100%}.menu-card{padding:14px;border:1px solid var(--el-border-color-lighter);border-radius:6px;margin-top:14px}.menu-card>.heading{margin-bottom:14px}.icon-field{display:grid;gap:8px;width:100%;min-width:0}.icon-field :deep(.el-image){width:58px;height:58px;background:var(--el-fill-color-light)}.preview-label{margin:18px 0 10px;display:flex;align-items:center;gap:12px;font-size:13px}.preview-outer{padding-top:14px!important;overflow:hidden;border:1px solid var(--el-border-color-lighter)}.preview-bar{display:flex;align-items:center;min-height:48px}.preview-item{flex:1;min-width:0;display:flex;align-items:center;flex-direction:column;gap:3px;font-size:12px;overflow-wrap:anywhere;padding:0 3px}.preview-item img{width:25px;height:25px;object-fit:contain}.footer-editor :deep(.el-form-item){margin-bottom:14px}@media(max-width:620px){.field-grid,.icon-grid{grid-template-columns:1fr}.footer-editor{padding:12px}.menu-actions :deep(.el-button+.el-button){margin-left:0}}
</style>
