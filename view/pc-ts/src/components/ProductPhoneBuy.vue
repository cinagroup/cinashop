<template>
  <section class="phone-buy" aria-label="手机购买">
    <button type="button" :aria-expanded="open" @click="toggle">手机购买</button>
    <div v-if="open" class="phone-panel">
      <p v-if="loading" role="status">正在读取手机购买入口…</p>
      <p v-else-if="error" role="alert">手机购买入口暂时无法读取，请稍后重试。</p>
      <template v-else-if="image"><img :src="image" alt="手机购买二维码" /><p>使用微信扫一扫打开商品</p><a v-if="mobileUrl" :href="mobileUrl" rel="noopener noreferrer">打开手机商品页</a></template>
      <p v-else>暂无可用的手机购买入口。</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { apiPcProductCode } from '@/api/pcBase';
import { captureAuthSession, isCurrentAuthSession, onAuthChange } from '@/utils/auth';
const props = defineProps<{ productId: number }>();
const open = ref(false), loading = ref(false), error = ref(false), image = ref(''), mobileUrl = ref('');
let alive = true, epoch = 0, controller: AbortController | undefined;
function retire() { epoch++; controller?.abort(); open.value = false; loading.value = false; image.value = mobileUrl.value = ''; error.value = false; }
async function toggle() {
  if (open.value) { retire(); return; }
  retire(); open.value = true; loading.value = true;
  const id = props.productId, own = epoch, session = captureAuthSession(); controller = new AbortController(); const signal = controller.signal;
  const current = () => alive && open.value && own === epoch && id === props.productId && !signal.aborted && isCurrentAuthSession(session);
  try {
    const result = await apiPcProductCode(id, signal); if (!current()) return;
    const qr = result.routineCode || (result.mobileUrl ? await QRCode.toDataURL(result.mobileUrl, { width: 240, margin: 2 }) : '');
    if (current()) { image.value = qr; mobileUrl.value = result.routineCode ? '' : result.mobileUrl; }
  } catch { if (current()) error.value = true; }
  finally { if (current()) loading.value = false; }
}
const stopAuth = onAuthChange(retire);
watch(() => props.productId, retire, { flush: 'sync' });
onBeforeUnmount(() => { alive = false; retire(); stopAuth(); });
</script>
<style scoped>
.phone-buy{margin:16px 0;position:relative}.phone-buy button{border:1px solid #ddd;background:white;border-radius:5px;padding:9px 16px;cursor:pointer}.phone-panel{background:#fff;border:1px solid #ddd;padding:16px;width:min(280px,100%);box-sizing:border-box;text-align:center;margin-top:8px}.phone-panel img{width:240px;max-width:100%;height:auto}.phone-panel p{font-size:13px;line-height:1.6}.phone-panel a{font-size:13px}
</style>
