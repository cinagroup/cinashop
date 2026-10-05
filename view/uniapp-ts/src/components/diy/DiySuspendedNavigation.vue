<template>
  <view v-if="config?.is_show === 1" :id="instanceId" class="fab-shell" :class="[`fab-style-${config.index}`, { expanded: opened, 'half-hidden': hidden && config.index === 2 }]" :style="positionStyle">
    <view v-if="config.index === 4" class="fab-orbit-background" />
    <view v-show="opened" class="fab-items">
      <view v-for="(item, index) in config.button" :key="index" class="fab-item" :class="{ unavailable: !item.url }" :style="childStyle(index)" role="button" :aria-disabled="!item.url" :aria-label="`悬浮按钮 ${index + 1}${item.url ? '' : '，链接暂不可用'}`" @tap.stop="follow(item.url)">
        <image v-if="item.img" :src="item.img" class="fab-image" mode="aspectFill" /><text v-else class="fab-fallback">?</text><text v-if="!item.url" class="fab-unavailable-label">!</text>
      </view>
    </view>
    <view class="fab-main" role="button" :aria-label="opened ? '收起悬浮导航' : '展开悬浮导航'" @tap.stop="toggle" @touchstart.stop="touchStart" @touchmove.stop.prevent="touchMove" @touchend.stop="touchEnd" @touchcancel.stop="touchEnd" @mousedown.stop="mouseStart">
      <image v-if="config.index !== 4" :src="mainImage" class="fab-image" mode="aspectFill" />
      <text v-else class="fab-symbol">{{ opened ? '×' : '···' }}</text>
      <text v-if="opened && config.index === 2" class="fab-close-arrow">›</text>
    </view>
  </view>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onPageScroll } from '@dcloudio/uni-app';
import { fabArc, fabCentre, openFabLink, type FabConfig } from '@/utils/fab';
import { loadDiySuspendedConfig } from '@/utils/diySuspended';
const config = ref<FabConfig | null>(null), opened = ref(false), hidden = ref(false), viewport = ref(0), topInset = ref(0), measured = ref(0), dragged = ref<number | null>(null), width = ref(375);
const instanceId = `fab-${Math.random().toString(36).slice(2, 10)}`;
let alive = false, epoch = 0, touchY = 0, touchCentre = 0, touching = false, moved = false, suppressTapUntil = 0;
const unit = computed(() => width.value / 750);
const estimatedHeight = computed(() => !config.value ? 0 : config.value.index >= 3 ? (config.value.index === 4 ? 350 : 298) * unit.value : config.value.index === 1 && opened.value ? (70 + config.value.button.length * 90 + 20) * unit.value : 90 * unit.value);
const centre = computed(() => fabCentre(config.value?.shifting ?? 0, viewport.value, measured.value || estimatedHeight.value, dragged.value));
const positionStyle = computed(() => ({ top: `${topInset.value + centre.value}px` }));
const mainImage = computed(() => config.value?.index === 3 && opened.value ? config.value.main_after_image : config.value?.main_ago_image ?? '');
function childStyle(index: number) { if (!config.value || config.value.index < 3) return {}; const point = fabArc(config.value.button.length, index); return { left: `${point.left * unit.value}px`, top: `calc(50% + ${point.top * unit.value}px)` }; }
async function measure() { await nextTick(); if (!alive || !config.value) return; const version = epoch; uni.createSelectorQuery().select(`#${instanceId}`).boundingClientRect(value => { const rect = Array.isArray(value) ? value[0] : value; if (alive && epoch === version && rect && typeof rect.height === 'number' && rect.height > 0) measured.value = rect.height; }).exec(); }
function resize() { const info = uni.getSystemInfoSync(); viewport.value = info.windowHeight; width.value = Math.min(info.windowWidth, 750);
  // H5 windowHeight already excludes the fixed page header and tabbar, while fixed top is viewport-relative.
  // #ifdef H5
  topInset.value = Number.isFinite(info.windowTop) ? Math.max(0, info.windowTop) : 0;
  // #endif
  measured.value = 0; void measure(); }
function toggle() { if (Date.now() < suppressTapUntil || !alive) return; opened.value = !opened.value; hidden.value = false; }
function collapse() { if (!alive || touching) return; opened.value = false; if (config.value?.index === 2) hidden.value = true; }
function follow(url: string) { if (!alive || Date.now() < suppressTapUntil) return; opened.value = false; if (!url) uni.showToast({ title: '此链接暂不可用，请联系管理员修复', icon: 'none' }); else openFabLink(url); }
function begin(y: number) { touching = true; moved = false; touchY = y; touchCentre = centre.value; }
function move(y: number) { if (!touching || !alive) return; if (Math.abs(y - touchY) > 5) moved = true; if (moved) { hidden.value = false; dragged.value = fabCentre(config.value?.shifting ?? 0, viewport.value, measured.value || estimatedHeight.value, touchCentre + y - touchY); } }
function end() { if (moved) suppressTapUntil = Date.now() + 350; touching = false; }
function touchStart(event: { touches?: ArrayLike<{ clientY: number }> }) { if (event.touches?.[0]) begin(event.touches[0].clientY); }
function touchMove(event: { touches?: ArrayLike<{ clientY: number }> }) { if (event.touches?.[0]) move(event.touches[0].clientY); }
function touchEnd() { end(); }
function mouseStart(event: MouseEvent) { if (event.button === 0) begin(event.clientY); }
function mouseMove(event: MouseEvent) { if (touching) { event.preventDefault(); move(event.clientY); } }
function mouseEnd() { end(); }
watch(opened, () => { measured.value = 0; void measure(); });
onPageScroll(collapse);
onMounted(async () => {
  alive = true; const version = ++epoch; resize(); uni.$on('scroll', collapse); uni.onWindowResize(resize);
  // #ifdef H5
  window.addEventListener('scroll', collapse, true); window.addEventListener('mousemove', mouseMove); window.addEventListener('mouseup', mouseEnd);
  // #endif
  try { const loaded = await loadDiySuspendedConfig(); if (alive && epoch === version) { config.value = loaded; void measure(); } } catch { /* Optional configuration never prevents the underlying page from rendering. */ }
});
onBeforeUnmount(() => { alive = false; epoch++; uni.$off('scroll', collapse); uni.offWindowResize(resize);
  // #ifdef H5
  window.removeEventListener('scroll', collapse, true); window.removeEventListener('mousemove', mouseMove); window.removeEventListener('mouseup', mouseEnd);
  // #endif
});
</script>
<style scoped>
.fab-shell{position:fixed;right:0;z-index:900;transform:translateY(-50%);touch-action:none;user-select:none;box-sizing:border-box}.fab-main,.fab-item{display:flex;align-items:center;justify-content:center;width:70rpx;height:70rpx;border-radius:50%;overflow:hidden;background:#fff;box-shadow:0 4rpx 18rpx rgba(0,0,0,.16);box-sizing:border-box}.fab-item{position:relative}.fab-item.unavailable{opacity:.65}.fab-fallback{font-size:30rpx;color:#777}.fab-unavailable-label{position:absolute;right:0;bottom:0;background:#a66;color:#fff;font-size:20rpx;border-radius:50%;width:24rpx;height:24rpx;line-height:24rpx;text-align:center}.fab-image{width:100%;height:100%;border-radius:50%}.fab-main{cursor:grab}.fab-style-1{padding:10rpx;background:#fff;border-radius:50rpx 0 0 50rpx}.fab-style-1 .fab-items{display:flex;flex-direction:column;gap:20rpx;margin-bottom:20rpx}.fab-style-2{display:flex;align-items:center;gap:20rpx;padding:10rpx;border-radius:50rpx 0 0 50rpx;background:#fff;transition:right .15s ease}.fab-style-2 .fab-items{display:flex;gap:20rpx}.fab-style-2.half-hidden{right:-45rpx}.fab-close-arrow{position:absolute;right:5rpx;color:#333;font-size:32rpx;background:rgba(255,255,255,.8);border-radius:50%}.fab-style-3{height:298rpx;width:70rpx}.fab-style-3 .fab-main,.fab-style-4 .fab-main{position:absolute;top:50%;transform:translateY(-50%);left:0}.fab-style-3 .fab-item,.fab-style-4 .fab-item{position:absolute;transform:translateY(-50%)}.fab-style-4{height:350rpx;width:70rpx}.fab-orbit-background{display:none;position:absolute;top:0;left:-100rpx;width:350rpx;height:350rpx;background:rgba(80,80,80,.3);backdrop-filter:blur(5px);border-radius:50%;pointer-events:none}.fab-style-4.expanded .fab-orbit-background{display:block}.fab-style-4 .fab-main{background:rgba(90,90,90,.75);color:#fff}.fab-style-4:not(.expanded) .fab-main{width:48rpx;height:48rpx;left:11rpx}.fab-symbol{font-size:48rpx;line-height:1}
</style>
