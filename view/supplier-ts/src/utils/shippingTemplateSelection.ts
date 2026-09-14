import { ref } from 'vue';
import type { ShippingTemplateDetail } from '@/types';

/** Selected identity is independent of the currently browsed/search-result page. */
export function useShippingTemplateSelection(read: (id: number) => Promise<ShippingTemplateDetail>, current: () => boolean) {
  const selected = ref<{ id: number; name: string; type: string } | null>(null);
  const loading = ref(false), error = ref('');
  let generation = 0;
  function reset() { generation++; selected.value = null; loading.value = false; error.value = ''; }
  async function hydrate(id: number) {
    const request = ++generation;
    selected.value = null; loading.value = false; error.value = '';
    if (!current() || id === 0) return;
    if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) { error.value = '当前模板ID无效，未修改商品原值'; return; }
    loading.value = true;
    try {
      const detail = await read(id);
      if (!current() || request !== generation) return;
      const data = detail?.formData;
      if (!data || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 255 || ![1, 2, 3].includes(data.type)) {
        throw new Error('当前模板响应无效');
      }
      selected.value = { id, name: data.name, type: { 1: '按件数', 2: '按重量', 3: '按体积' }[data.type] };
    } catch (failure) {
      if (current() && request === generation) error.value = `${failure instanceof Error ? failure.message : '当前模板读取失败'}；未修改商品原模板ID`;
    } finally { if (current() && request === generation) loading.value = false; }
  }
  return { selected, loading, error, hydrate, reset };
}
