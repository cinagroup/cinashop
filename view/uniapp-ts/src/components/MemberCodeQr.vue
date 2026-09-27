<template>
  <view class="member-qr">
    <canvas v-if="canvasVisible" :id="canvasId" :canvas-id="canvasId"
      :width="canvasSize" :height="canvasSize"
      :style="{ width: `${displaySize}px`, height: `${displaySize}px`, opacity: ready ? 1 : 0 }"
      class="member-qr-canvas" aria-label="会员核销二维码" />
    <text v-if="canvasVisible && !ready" class="member-qr-status">正在生成二维码…</text>
  </view>
</template>

<script setup lang="ts">
import { getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import QRCode from "qrcode-terminal/vendor/QRCode";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel";
import { memberCodeValue } from "@/api/memberCode";

const props = defineProps<{ code: string }>();
const emit = defineEmits<{ error: [code: string] }>();
const instance = getCurrentInstance();
const instanceId = instance?.uid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const canvasId = ref(`member-code-${instanceId}-0`);
const canvasSize = ref(256), displaySize = ref(256);
const canvasVisible = ref(false), ready = ref(false);
let generation = 0;
let mounted = false;
let disposed = false;
let drawingTimeout: ReturnType<typeof setTimeout> | undefined;

function invalidate(): void {
  if (drawingTimeout !== undefined) clearTimeout(drawingTimeout);
  drawingTimeout = undefined;
  generation++;
  ready.value = false;
  canvasVisible.value = false;
}

async function drawCode(): Promise<void> {
  invalidate();
  if (!mounted || disposed || !props.code) return;
  const epoch = generation;
  const original = props.code;
  const current = () => !disposed && mounted && generation === epoch && props.code === original;
  try {
    const code = memberCodeValue(original);
    // QR8bitByte writes low eight bits of each character. Give it UTF-8 bytes,
    // so a valid historical Unicode code is not silently truncated.
    const bytes = encodeURIComponent(code).replace(/%([0-9A-F]{2})/g,
      (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    const qr = new QRCode(0, QRErrorCorrectLevel.M);
    qr.addData(bytes);
    qr.make();
    const count = qr.getModuleCount();
    if (count < 21 || count > 177) throw Error("会员二维码容量无效");
    const quiet = 4, cell = Math.floor(256 / (count + quiet * 2));
    if (cell < 2) throw Error("会员二维码容量无效");
    const size = (count + quiet * 2) * cell;
    canvasSize.value = size;
    // Uni H5 creates its inner canvas from CSS dimensions. The drawing grid
    // and both display axes must match, including on a small phone screen.
    displaySize.value = size;
    // Remove the old canvas before creating a different id. A delayed native
    // draw can only address its detached canvas, never the current display.
    await nextTick();
    if (!current()) return;
    canvasId.value = `member-code-${instanceId}-${epoch}`;
    canvasVisible.value = true;
    await nextTick();
    if (!current()) return;
    const context = uni.createCanvasContext(canvasId.value, instance?.proxy ?? undefined);
    context.setFillStyle("#ffffff");
    context.fillRect(0, 0, size, size);
    context.setFillStyle("#172a42");
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          context.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
        }
      }
    }
    if (current()) {
      // Native canvas has no error callback. A missing completion is a visible
      // failure, with the canvas removed before the user can retry.
      drawingTimeout = setTimeout(() => {
        if (!current()) return;
        invalidate();
        emit("error", original);
      }, 8000);
      context.draw(false, () => {
        if (!current()) return;
        if (drawingTimeout !== undefined) clearTimeout(drawingTimeout);
        drawingTimeout = undefined;
        ready.value = true;
      });
    }
  } catch {
    if (!current()) return;
    invalidate();
    emit("error", original);
  }
}

onMounted(() => { mounted = true; void drawCode(); });
watch(() => props.code, () => { void drawCode(); }, { flush: "sync" });
onUnmounted(() => { disposed = true; mounted = false; invalidate(); });
</script>

<style scoped>
.member-qr { position: relative; display: flex; justify-content: center; min-height: 256px; }
.member-qr-canvas { display: block; max-width: 100%; image-rendering: pixelated; }
.member-qr-status { position: absolute; top: 45%; color: #657184; font-size: 26rpx; }
</style>
