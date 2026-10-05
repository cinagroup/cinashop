<template>
  <section class="preview-area">
    <div class="preview-heading"><strong>商城效果预览</strong><span>点击展开、上下拖动；滚动预览会收起</span></div>
    <div ref="viewport" class="preview-viewport">
      <div class="preview-scroll" @scroll="collapse"><div class="preview-content"><div class="preview-shop-title">商城首页</div><div v-for="n in 7" :key="n" class="preview-card">商品展示区域 {{ n }}</div></div></div>
      <div ref="floating" class="preview-floating" :class="[`preview-style-${index}`, { expanded: opened, 'half-hidden': hidden && index === 2 }]" :style="{ top: centre + 'px' }">
        <div v-if="index === 4 && opened" class="preview-orbit" />
        <div v-show="opened" class="preview-items">
          <button v-for="(item, n) in buttons" :key="item.key" class="preview-item" :style="arc(n)" :aria-label="`预览按钮 ${n + 1}`" @click.stop="selected = item.url || '该按钮尚未配置链接'"><img v-if="item.preview" :src="item.preview" alt="" /><span v-else>{{ n + 1 }}</span></button>
        </div>
        <button class="preview-main" :aria-label="opened ? '收起预览悬浮导航' : '展开预览悬浮导航'" @click.stop="toggle" @pointerdown="start" @pointercancel="end" @lostpointercapture="end"><img v-if="index !== 4 && mainImage" :src="mainImage" alt="" /><span v-else>{{ index === 4 ? opened ? '×' : '···' : '＋' }}</span><span v-if="index === 2 && opened" class="preview-arrow">›</span></button>
      </div>
    </div>
    <p class="preview-caption">{{ selected || '预览按钮展示目标；实际跳转由商城执行。' }}</p>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { FabEditorButton } from '@/api/fabSettings';
const props = defineProps<{ index: number | null; shifting: number; before: string; after: string; buttons: FabEditorButton[] }>();
const viewport = ref<HTMLElement | null>(null), floating = ref<HTMLElement | null>(null), opened = ref(false), hidden = ref(false), selected = ref(''), height = ref(520), floatingHeight = ref(45), dragged = ref<number | null>(null);
let dragging = false, startY = 0, startCentre = 0, moved = false, suppressUntil = 0, observer: ResizeObserver | null = null;
const index = computed(() => props.index ?? 1), buttons = computed(() => props.buttons.slice(0, 5)), mainImage = computed(() => index.value === 3 && opened.value ? props.after : props.before);
const centre = computed(() => { const half = Math.min(height.value, floatingHeight.value) / 2; return Math.max(half, Math.min(height.value - half, dragged.value ?? props.shifting / 100 * height.value)); });
function arc(n: number) { if (index.value < 3) return {}; const points: Record<number, number[][]> = { 3: [[-17.5, -46.5], [-50, 0], [-17.5, 46.5]], 4: [[0, -50], [-45, -25], [-45, 25], [0, 50]], 5: [[0, -55], [-38, -38], [-53, 0], [-38, 38], [0, 55]] }; const point = points[buttons.value.length]?.[n] ?? [0, 0]; return { left: point[0] + 'px', top: `calc(50% + ${point[1]}px)` }; }
function measure() { if (viewport.value) height.value = viewport.value.clientHeight; if (floating.value) floatingHeight.value = floating.value.offsetHeight; }
function toggle() { if (Date.now() < suppressUntil) return; opened.value = !opened.value; hidden.value = false; }
function collapse() { opened.value = false; if (index.value === 2) hidden.value = true; }
function start(event: PointerEvent) { if (event.button !== 0) return; dragging = true; moved = false; startY = event.clientY; startCentre = centre.value; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }
function move(event: PointerEvent) { if (!dragging) return; if (Math.abs(event.clientY - startY) > 5) moved = true; if (moved) { dragged.value = startCentre + event.clientY - startY; hidden.value = false; } }
function end() { if (moved) suppressUntil = Date.now() + 350; dragging = false; }
watch(() => [props.index, props.shifting], () => { dragged.value = null; opened.value = false; hidden.value = false; selected.value = ''; });
watch(() => [props.buttons.length, opened.value], () => { void nextTick(measure); });
onMounted(() => { observer = new ResizeObserver(measure); if (viewport.value) observer.observe(viewport.value); if (floating.value) observer.observe(floating.value); window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); measure(); });
onBeforeUnmount(() => { observer?.disconnect(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); });
</script>
<style scoped>
.preview-area{min-width:0;max-width:375px;width:100%;justify-self:center}.preview-heading{display:flex;flex-direction:column;gap:7px;margin-bottom:12px;font-size:13px}.preview-heading span,.preview-caption{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;overflow-wrap:anywhere}.preview-viewport{position:relative;height:520px;overflow:hidden;background:#f6f6f6;border:1px solid var(--el-border-color);border-radius:12px}.preview-scroll{position:absolute;inset:0;overflow:auto}.preview-content{height:1100px;padding:14px}.preview-shop-title{padding:12px;font-weight:600;color:#e93323}.preview-card{height:100px;margin:14px 0;padding:16px;border-radius:8px;background:#fff;color:#999}.preview-floating{position:absolute;right:0;z-index:2;transform:translateY(-50%);touch-action:none}.preview-main,.preview-item{display:flex;align-items:center;justify-content:center;width:35px;height:35px;border:0;padding:0;border-radius:50%;overflow:hidden;background:#fff;box-shadow:0 2px 9px #0002;color:#e93323;font-size:22px}.preview-main img,.preview-item img{width:100%;height:100%;object-fit:cover}.preview-main{cursor:grab}.preview-style-1{padding:5px;background:#fff;border-radius:25px 0 0 25px}.preview-style-1 .preview-items{display:flex;flex-direction:column;gap:10px;margin-bottom:10px}.preview-style-2{display:flex;gap:10px;padding:5px;background:#fff;border-radius:25px 0 0 25px}.preview-style-2 .preview-items{display:flex;gap:10px}.preview-style-2.half-hidden{transform:translate(22.5px,-50%)}.preview-arrow{position:absolute;right:2px;background:#fffc;border-radius:50%;color:#333}.preview-style-3{height:149px;width:35px}.preview-style-4{height:175px;width:35px}.preview-style-3 .preview-main,.preview-style-4 .preview-main{position:absolute;left:0;top:50%;transform:translateY(-50%)}.preview-style-3 .preview-item,.preview-style-4 .preview-item{position:absolute;transform:translateY(-50%)}.preview-orbit{position:absolute;left:-50px;top:0;width:175px;height:175px;border-radius:50%;background:#5555;backdrop-filter:blur(3px);pointer-events:none}.preview-style-4 .preview-main{background:#555b;color:#fff}.preview-style-4:not(.expanded) .preview-main{width:24px;height:24px;left:5.5px}
</style>

