<template>
  <div v-for="panel in [view]" :key="'picker'" class="overlay" @click.self="panel.close">
    <section role="dialog" aria-modal="true" aria-label="选择PC配置图片" class="dialog">
      <header><h3>选择PC配置图片</h3><button type="button" @click="panel.close">关闭图库</button></header>
      <label>图片分类<select aria-label="图片分类" :value="pid" :disabled="loading" @change="panel.category(($event.target as HTMLSelectElement).value)"><option value="0">未分类</option><option v-for="row in categories" :key="row.id" :value="row.id">{{ row.name }}</option></select></label>
      <label>图片名称<input aria-label="图片名称" :value="name" :disabled="loading" @input="panel.name(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="panel.search" /></label><button type="button" :disabled="loading" @click="panel.search">搜索图片</button>
      <p v-if="loading" role="status">正在读取图库…</p><p v-if="error" role="alert">{{ error }}</p>
      <div class="images"><button v-for="row in panel.images" :key="row.id" type="button" :disabled="loading || dirty" @click="row.choose"><img :src="row.preview" :alt="row.name" referrerpolicy="no-referrer" /><span>{{ row.name }}</span></button></div>
      <p v-if="!loading && !images.length">当前分类没有可选的平台图片。</p><footer>共 {{ count }} 张，第 {{ page }} 页 <button type="button" :disabled="loading || dirty || page <= 1" @click="panel.previous">图库上一页</button><button type="button" :disabled="loading || dirty || page * 20 >= count" @click="panel.next">图库下一页</button></footer>
    </section>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { apiPcBaseAttachmentCategories, apiPcBaseAttachmentOptions, checkedPcBaseCategories, checkedPcBaseImages, pcBasePreviewDeadline, type PcBaseCategory, type PcBaseImage } from '@/api/pcBase';
const props = defineProps<{ choose: (image: PcBaseImage) => void; close: () => void }>();
const categories = ref<PcBaseCategory[]>([]), images = ref<PcBaseImage[]>([]), pid = ref(0), page = ref(1), count = ref(0), name = ref('');
const loading = ref(false), dirty = ref(false), error = ref('');
let alive = true, epoch = 0, controller: AbortController | undefined;
function close() { epoch++; controller?.abort(); props.close(); }
async function load() {
  controller?.abort(); controller = new AbortController(); const own = ++epoch, signal = controller.signal;
  const query = { page: page.value, limit: 20, pid: pid.value, name: name.value };
  const current = () => alive && own === epoch && !signal.aborted;
  loading.value = true; dirty.value = false; error.value = ''; images.value = [];
  try {
    const cats = checkedPcBaseCategories(await apiPcBaseAttachmentCategories(signal)); if (!current()) return;
    const result = checkedPcBaseImages(await apiPcBaseAttachmentOptions(query, signal), query); if (!current()) return;
    categories.value = cats; images.value = result.list; count.value = result.count;
  } catch { if (current()) error.value = '图库读取失败，请重新选择分类或搜索。'; }
  finally { if (current()) loading.value = false; }
}
const view = computed(() => {
  const own = epoch, original = images.value, select = props.choose;
  const current = () => alive && own === epoch && !loading.value;
  return { close: () => { if (alive && own === epoch) close(); },
    name: (value: string) => { if (current()) { name.value = value; dirty.value = true; } },
    search: () => { if (current()) { if ([...name.value].length > 80 || /[\u0000-\u001f\u007f]/u.test(name.value)) { error.value = '图片名称须为最多80个字符的文本'; return; } page.value = 1; void load(); } },
    category: (raw: string) => { const id = Number(raw); if (current() && /^(?:0|[1-9]\d*)$/u.test(raw) && (!id || categories.value.some(row => row.id === id))) { pid.value = id; page.value = 1; void load(); } },
    previous: () => { if (current() && !dirty.value && page.value > 1) { page.value--; void load(); } },
    next: () => { if (current() && !dirty.value && page.value * 20 < count.value) { page.value++; void load(); } },
    images: original.map(image => ({ id: image.att_id, name: image.real_name, preview: image.preview, choose: () => {
      if (!current() || dirty.value || images.value !== original) return;
      const deadline = pcBasePreviewDeadline(image.preview);
      if (deadline === null || Date.now() >= deadline) { images.value = []; error.value = '图片预览已过期，请重新搜索。'; return; }
      select(image);
    } })),
  };
});
onMounted(load);
onBeforeUnmount(() => { alive = false; epoch++; controller?.abort(); });
</script>
<style scoped>
.overlay{position:fixed;inset:0;background:#0008;z-index:2200;display:grid;place-items:center;padding:20px}.dialog{background:white;color:#303133;border-radius:8px;width:min(760px,100%);max-height:85vh;overflow:auto;padding:20px;box-sizing:border-box}header,footer{display:flex;align-items:center;gap:12px;justify-content:space-between}label{display:grid;gap:6px;margin:12px 0}input,select,button{padding:8px;font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}.images{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:15px 0}.images button{display:grid;gap:6px;overflow-wrap:anywhere}.images img{width:100%;height:95px;object-fit:contain}footer{flex-wrap:wrap}
</style>
