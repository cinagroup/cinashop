<template>
  <canvas id="assisted-payment-code" canvas-id="assisted-payment-code" :width="canvasSize" :height="canvasSize"
    :style="{ width: `${displaySize}px`, height: `${displaySize}px` }"
    class="payment-code" aria-label="本机生成的支付二维码" />
</template>

<script setup lang="ts">
import { getCurrentInstance, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode-terminal/vendor/QRCode';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel';

const props = defineProps<{ code: string }>();
const instance = getCurrentInstance();
const canvasSize = ref(256), displaySize = ref(256);
let generation = 0;
let disposed = false;

async function drawCode() {
  const epoch = ++generation;
  if (!props.code) return;
  // The QR payload is drawn locally. It is never sent to an image-generation host.
  const qr = new QRCode(0, QRErrorCorrectLevel.M);
  qr.addData(props.code);
  qr.make();
  const count = qr.getModuleCount();
  if (count < 21 || count > 177) throw Error('支付二维码容量无效');
  // Every module owns an exact integer pixel rectangle. Rounded fractional
  // edges can blacken the centre of adjacent white modules on dense codes.
  const quiet = 4, cell = Math.max(2, Math.ceil(256 / (count + quiet * 2)));
  const size = (count + quiet * 2) * cell;
  canvasSize.value = size;
  displaySize.value = Math.min(size, 320);
  await nextTick();
  if (disposed || epoch !== generation) return;
  const context = uni.createCanvasContext('assisted-payment-code', instance?.proxy ?? undefined);
  context.setFillStyle('#ffffff');
  context.fillRect(0, 0, size, size);
  context.setFillStyle('#172a42');
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        context.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
      }
    }
  }
  if (!disposed && epoch === generation) context.draw(false);
}

onMounted(() => { void drawCode(); });
watch(() => props.code, () => { void drawCode(); });
onUnmounted(() => { disposed = true; generation++; });
</script>

<style scoped>
.payment-code { max-width: 100%; display: block; margin: 0 auto; image-rendering: pixelated; }
</style>
