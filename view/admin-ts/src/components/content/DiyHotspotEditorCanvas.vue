<template>
  <section class="hotspot-author" aria-label="热区框选画布">
    <div class="toolbar"><el-button :disabled="disabled || !size" @click="mode = mode === 'draw' ? 'move' : 'draw'">{{ mode === 'draw' ? '结束框选' : '框选新热区' }}</el-button><span class="hint">750 设计宽度；拖动区域可移动，拖动右下角可缩放。</span></div>
    <p v-if="items.length > 30" class="hint">保留全部 {{ items.length }} 区域，客户端仅显示前 30 项。选中的超量区域可编辑。</p>
    <p v-if="!image" class="hint">请先选择热区图片。</p>
    <p v-else-if="imageState === 'error'" role="alert">热区图片读取失败，请重新选择或刷新素材预览。</p>
    <div v-if="image" class="canvas-scroll">
      <div ref="surface" class="canvas" :class="{ drawing: mode === 'draw' }" @pointerdown="beginDraw" @pointermove="pointerMove" @pointerup="pointerEnd" @pointercancel="cancel" @lostpointercapture="cancel" @keydown.esc="cancel">
        <img :key="imageSession.key" :src="image" alt="热区编辑底图" draggable="false" @load="imageSession.load" @error="imageSession.error" />
        <button v-for="area in areas" :key="area.index" type="button" class="area" :class="{ selected: selected === area.index, overflow: area.index >= 30 }" :style="area.style" :aria-label="`移动热区 ${area.index + 1}`" :disabled="disabled" @pointerdown.stop="beginMove($event, area.index, false)" @click.stop="emit('select', area.index)">
          <span>{{ area.index + 1 }}</span><span v-if="selected === area.index" class="resize" :aria-label="`缩放热区 ${area.index + 1}`" @pointerdown.stop="beginMove($event, area.index, true)" />
        </button>
        <div v-if="draft" class="draft" :style="styleFor(draft)" />
      </div>
    </div>
    <p class="hint">{{ size ? `图片自然尺寸 ${size.width}×${size.height}；设计尺寸 750×${designHeight}` : '实际图片加载完成后才能框选或修改几何位置。' }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { navRead, navigationRecord } from '@/utils/diyNavigationEditor';
import { editorialItems, validHotspotGeometry, type HotspotGeometry } from '@/utils/diyEditorialEditor';
import { editorialMediaPreview } from '@/utils/diyEditorialProjection';
const props = withDefaults(defineProps<{ block: unknown; previews?: Record<string, string>; selected: number; disabled: boolean; editorKey: string }>(), { previews: () => ({}) });
const emit = defineEmits<{ select: [index: number]; geometry: [index: number, rectangle: HotspotGeometry]; size: [size: { width: number; height: number; reference: string } | null] }>();
const surface = ref<HTMLElement | null>(null), size = ref<{ width: number; height: number } | null>(null), imageState = ref('loading'), mode = ref<'move' | 'draw'>('move'), epoch = ref(0), draft = ref<HotspotGeometry | null>(null);
let alive = true;
interface Gesture { pointer: number; index: number; operation: 'draw' | 'move' | 'resize'; x: number; y: number; original: HotspotGeometry; stamp: string }
let gesture: Gesture | null = null;
const reference = computed(() => navRead(props.block, ['picStyle', 'url'])), image = computed(() => editorialMediaPreview(reference.value, props.previews));
const items = computed(() => editorialItems(props.block)), designHeight = computed(() => size.value ? 750 * size.value.height / size.value.width : 0);
const stamp = () => `${props.editorKey}:${epoch.value}:${image.value}:${JSON.stringify(props.block)}`;
function rectangle(raw: unknown): HotspotGeometry | null { const r = navigationRecord(raw); if (!r) return null; const values = [r.starX, r.starY, r.areaWidth, r.areaHeight].map(value => typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN); return values.every(Number.isFinite) && values[0] >= 0 && values[1] >= 0 && values[2] > 0 && values[3] > 0 ? { left: values[0], top: values[1], width: values[2], height: values[3] } : null; }
function styleFor(r: HotspotGeometry) { return { left: `${r.left / 750 * 100}%`, top: `${r.top / designHeight.value * 100}%`, width: `${Math.min(r.width, 750 - r.left) / 750 * 100}%`, height: `${Math.min(r.height, designHeight.value - r.top) / designHeight.value * 100}%` }; }
const areas = computed(() => !size.value ? [] : items.value.flatMap((raw, index) => { const r = rectangle(raw); return r && (index < 30 || index === props.selected) && r.left < 750 && r.top < designHeight.value && Object.values(r).every(n => n <= 1e6) ? [{ index, style: styleFor(index === gesture?.index && draft.value ? draft.value : r) }] : []; }));
function cancel() { gesture = null; draft.value = null; }
function resetImage() { epoch.value++; cancel(); size.value = null; imageState.value = 'loading'; emit('size', null); }
watch(() => [image.value, props.editorKey, props.disabled], resetImage, { flush: 'sync' });
watch(() => JSON.stringify(props.block), cancel, { flush: 'sync' });
watch(() => props.selected, value => { if (gesture && value !== gesture.index) cancel(); }, { flush: 'sync' });
onBeforeUnmount(() => { alive = false; epoch.value++; cancel(); });
const imageSession = computed(() => {
  const generation = epoch.value, src = image.value, owner = props.editorKey;
  const current = () => alive && generation === epoch.value && src === image.value && owner === props.editorKey;
  const error = () => { if (current()) { size.value = null; imageState.value = 'error'; cancel(); emit('size', null); } };
  return { key: `${owner}:${generation}:${src}`, error, load: (event: Event) => {
    if (!current()) return; const target = event.currentTarget as HTMLImageElement | null, width = target?.naturalWidth, height = target?.naturalHeight;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) { error(); return; }
    size.value = { width, height }; imageState.value = 'ready'; emit('size', { width, height, reference: String(reference.value ?? '') });
  } };
});
function point(event: PointerEvent) { const box = surface.value?.getBoundingClientRect(); if (!box || box.width <= 0 || !size.value) return null; return { x: Math.max(0, Math.min(750, (event.clientX - box.left) * 750 / box.width)), y: Math.max(0, Math.min(designHeight.value, (event.clientY - box.top) * 750 / box.width)) }; }
function start(event: PointerEvent, operation: Gesture['operation'], index: number, original: HotspotGeometry) { if (!alive || props.disabled || !size.value || event.button !== 0 || gesture) return; const p = point(event); if (!p) return; gesture = { operation, index, original, x: p.x, y: p.y, pointer: event.pointerId, stamp: stamp() }; draft.value = original; surface.value?.setPointerCapture?.(event.pointerId); event.preventDefault(); }
function beginDraw(event: PointerEvent) { if (mode.value !== 'draw' || items.value.length >= 30) return; const p = point(event); if (p) start(event, 'draw', -1, { left: p.x, top: p.y, width: 0, height: 0 }); }
function beginMove(event: PointerEvent, index: number, resize: boolean) { const r = rectangle(items.value[index]); if (!r || !size.value || !validHotspotGeometry(r, size.value.width, size.value.height)) return; emit('select', index); start(event, resize ? 'resize' : 'move', index, r); }
function pointerMove(event: PointerEvent) {
  const g = gesture, p = point(event); if (!g || !p || g.pointer !== event.pointerId) return;
  if (!alive || props.disabled || g.stamp !== stamp()) { cancel(); return; }
  const dx = p.x - g.x, dy = p.y - g.y, r = g.original;
  draft.value = g.operation === 'draw' ? { left: Math.min(g.x, p.x), top: Math.min(g.y, p.y), width: Math.abs(dx), height: Math.abs(dy) }
    : g.operation === 'move' ? { ...r, left: Math.max(0, Math.min(750 - r.width, r.left + dx)), top: Math.max(0, Math.min(designHeight.value - r.height, r.top + dy)) }
      : { ...r, width: Math.max(.1, Math.min(750 - r.left, r.width + dx)), height: Math.max(.1, Math.min(designHeight.value - r.top, r.height + dy)) };
  event.preventDefault();
}
function pointerEnd(event: PointerEvent) { const g = gesture; if (!g || g.pointer !== event.pointerId) return; pointerMove(event); const value = draft.value, allowed = alive && !props.disabled && g.stamp === stamp() && size.value && value && validHotspotGeometry(value, size.value.width, size.value.height); cancel(); surface.value?.releasePointerCapture?.(event.pointerId); if (allowed && value) emit('geometry', g.index, value); }
</script>
<style scoped>
.hotspot-author{width:100%;min-width:0}.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}.hint{font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.canvas-scroll{max-height:70vh;overflow:auto}.canvas{position:relative;width:min(375px,100%);touch-action:none;line-height:0;user-select:none}.canvas.drawing{cursor:crosshair}.canvas img{display:block;width:100%;height:auto;pointer-events:none}.area,.draft{position:absolute;box-sizing:border-box;border:1px dashed #1677ff;background:#1677ff1a;padding:0;margin:0;min-width:0;min-height:0;cursor:move;line-height:1;font-size:12px;color:#1254a4}.area.selected{border:2px solid #1677ff}.area.overflow{border-color:#be7410;background:#be74101a}.area>span:first-child{position:absolute;left:0;top:0;background:#fff}.draft{pointer-events:none}.resize{position:absolute;right:-4px;bottom:-4px;width:12px;height:12px;background:#1677ff;border:1px solid #fff;cursor:nwse-resize}
</style>
