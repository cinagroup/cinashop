<template>
  <view v-if="state.ready() && config" class="diy-customer-service" :style="positionStyle" :data-side="config.right ? 'right' : 'left'">
    <!-- #ifdef MP -->
    <button v-if="state.nativeContact.value" class="customer-service-control" aria-label="打开小程序客服会话" open-type="contact" :disabled="suppressed || !state.ready()" hover-class="none" @tap.stop="handlers.contact"
      @touchstart.stop="handlers.start" @touchmove.stop.prevent="handlers.move" @touchend.stop="handlers.end" @touchcancel.stop="handlers.end">
      <image class="customer-service-image" :src="config.logo" mode="aspectFill" />
    </button>
    <view v-else class="customer-service-control" role="button" aria-label="打开悬浮客服入口" :aria-disabled="suppressed" @tap.stop="handlers.tap"
      @touchstart.stop="handlers.start" @touchmove.stop.prevent="handlers.move" @touchend.stop="handlers.end" @touchcancel.stop="handlers.end">
      <image class="customer-service-image" :src="config.logo" mode="aspectFill" />
    </view>
    <!-- #endif -->
    <!-- #ifndef MP -->
    <view class="customer-service-control" role="button" tabindex="0" aria-label="打开悬浮客服入口" :aria-disabled="suppressed" @tap.stop="handlers.tap" @keydown.enter.stop.prevent="handlers.tap" @keydown.space.stop.prevent="handlers.tap"
      @touchstart.stop="handlers.start" @touchmove.stop.prevent="handlers.move" @touchend.stop="handlers.end" @touchcancel.stop="handlers.end">
      <!-- #ifdef H5 -->
      <div class="customer-service-mouse-target" @mousedown.stop="mouseStart" @dragstart.prevent>
      <!-- #endif -->
      <image class="customer-service-image" :src="config.logo" mode="aspectFill" />
      <!-- #ifdef H5 -->
      </div>
      <!-- #endif -->
    </view>
    <!-- #endif -->
    <view v-if="state.error.value" class="customer-service-message" role="alert">{{state.error.value}}<button v-if="config.service && !state.loading.value" size="mini" @tap.stop="handlers.retry">重新读取客服入口</button></view>
  </view>
  <view v-else-if="active && state.config.value.error" class="customer-service-invalid" role="alert">{{state.config.value.error}}</view>
</template>
<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { DiyComponent } from '@/api/diy';
import { useDiyCustomerService } from '@/composables/useDiyCustomerService';
const props = withDefaults(defineProps<{block: DiyComponent; active?: boolean}>(), {active: true});
const state = useDiyCustomerService(() => props.block, () => props.active);
const config = computed(() => state.config.value.value), dragged = ref<number | null>(null), suppressed = ref(false);
let touching = false, startY = 0, moved = false, mouseLease: (() => boolean) | null = null, releaseTimer: ReturnType<typeof setTimeout> | undefined;
type Touch = {touches?: ArrayLike<{clientY: number}>};
const positionStyle = computed(() => ({top: dragged.value === null ? `${config.value?.topPercent ?? 30}%` : `${dragged.value}px`, left: config.value?.right ? 'auto' : '20rpx', right: config.value?.right ? '20rpx' : 'auto'}));
function begin(y: number) {
  if (!Number.isFinite(y)) return;
  // A previous drag's release must never unlock the gesture now in progress.
  if (releaseTimer !== undefined) { clearTimeout(releaseTimer); releaseTimer = undefined; }
  touching = true; startY = y; moved = false;
}
function move(y: number) {
  if (!touching || !Number.isFinite(y)) return;
  if (Math.abs(y - startY) > 5) { moved = true; suppressed.value = true; }
  // Preserve the PHP component's strict client-coordinate drag corridor.
  if (moved && y > 66 && y < 545) dragged.value = y;
}
function end() {
  touching = false;
  if (releaseTimer !== undefined) clearTimeout(releaseTimer);
  if (moved) releaseTimer = setTimeout(() => { suppressed.value = false; }, 350);
  else suppressed.value = false;
}
const handlers = computed(() => {
  const allowed = state.lease();
  return {
    tap: () => { if (allowed() && !suppressed.value) state.open(allowed); },
    contact: (event: {preventDefault?: () => void}) => { if (!allowed() || suppressed.value) event.preventDefault?.(); },
    start: (event: Touch) => { if (allowed() && event.touches?.[0]) begin(event.touches[0].clientY); },
    move: (event: Touch) => { if (allowed() && event.touches?.[0]) move(event.touches[0].clientY); },
    end: () => { if (allowed()) end(); },
    retry: () => { if (allowed()) void state.loadEntry(); },
  };
});
watch(state.epoch, () => { touching = false; moved = false; mouseLease = null; dragged.value = null; suppressed.value = false; if (releaseTimer !== undefined) clearTimeout(releaseTimer); }, {flush: 'sync'});
function mouseStart(event: MouseEvent) { const allowed = state.lease(); if (event.button !== 0 || !allowed()) return; mouseLease = allowed; begin(event.clientY); }
function mouseMove(event: MouseEvent) { if (mouseLease?.() && touching) { event.preventDefault(); move(event.clientY); } }
function mouseEnd() { if (mouseLease?.()) end(); mouseLease = null; }
onMounted(() => {
  // #ifdef H5
  window.addEventListener('mousemove', mouseMove); window.addEventListener('mouseup', mouseEnd);
  // #endif
});
onScopeDispose(() => { touching = false; mouseLease = null; if (releaseTimer !== undefined) clearTimeout(releaseTimer);
  // #ifdef H5
  window.removeEventListener('mousemove', mouseMove); window.removeEventListener('mouseup', mouseEnd);
  // #endif
});
</script>
<style scoped>
.customer-service-mouse-target{width:100%;height:100%}
.diy-customer-service{position:fixed;z-index:40;touch-action:none;user-select:none}.customer-service-control{display:block;width:86rpx;height:86rpx;padding:0;margin:0;border:0;border-radius:50%;overflow:hidden;background:transparent;line-height:1;box-sizing:border-box;cursor:grab}.customer-service-control::after{border:0}.customer-service-image{display:block;width:100%;height:100%;border-radius:50%}.customer-service-message{position:absolute;top:100%;right:0;min-width:220rpx;max-width:400rpx;padding:12rpx;background:#fff;color:#666;font-size:24rpx;box-shadow:0 2rpx 10rpx #ddd;box-sizing:border-box}.diy-customer-service[data-side=left] .customer-service-message{left:0;right:auto}.customer-service-invalid{padding:20rpx;color:#888;font-size:24rpx}
</style>
