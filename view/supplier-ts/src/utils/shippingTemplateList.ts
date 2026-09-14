import { computed, ref } from 'vue';
import type { ShippingTemplateListResult, ShippingTemplateRow } from '@/types';

export interface ShippingListQuery { name: string; page: number; limit: number }

/** Commit rows and their query together; failed/late reads never relabel old rows. */
export function useShippingTemplateList(fetchPage: (query: ShippingListQuery) => Promise<ShippingTemplateListResult>, current: () => boolean) {
  const rows = ref<ShippingTemplateRow[]>([]), count = ref(0), loading = ref(false), error = ref('');
  const applied = ref<ShippingListQuery>({ name: '', page: 1, limit: 20 });
  const pages = computed(() => Math.max(1, Math.ceil(count.value / applied.value.limit)));
  let generation = 0, attempted = { ...applied.value };

  function reset() {
    generation++; rows.value = []; count.value = 0; loading.value = false; error.value = '';
    applied.value = { name: '', page: 1, limit: 20 }; attempted = { ...applied.value };
  }
  function validate(result: ShippingTemplateListResult, query: ShippingListQuery) {
    if (!result || !Number.isSafeInteger(result.count) || result.count < 0 || !Array.isArray(result.data)
      || result.data.length > query.limit || result.data.some(row => !row || !Number.isSafeInteger(row.id) || row.id <= 0)) {
      throw new Error('运费列表响应无效，请重试');
    }
  }
  async function load(target: ShippingListQuery = applied.value) {
    if (!current()) return;
    const id = ++generation;
    const query = { name: target.name.trim(), page: target.page, limit: target.limit };
    if (query.name.length > 255 || !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 1_000_000
      || ![10, 20, 50, 100].includes(query.limit)) {
      error.value = '分页或搜索参数错误'; loading.value = false; return;
    }
    attempted = { ...query }; loading.value = true; error.value = '';
    try {
      let result = await fetchPage({ ...query });
      if (!current() || id !== generation) return;
      validate(result, query);
      const lastPage = Math.max(1, Math.ceil(result.count / query.limit));
      if (query.page > lastPage) {
        // A deletion can empty the last page. Re-read once, never loop on a changing count.
        query.page = lastPage;
        result = await fetchPage({ ...query });
        if (!current() || id !== generation) return;
        validate(result, query);
        if (query.page > Math.max(1, Math.ceil(result.count / query.limit))) throw new Error('模板列表正在变化，请重试');
      }
      rows.value = result.data; count.value = result.count; applied.value = { ...query };
    } catch (failure) {
      if (current() && id === generation) error.value = failure instanceof Error ? failure.message : '运费模板加载失败';
    } finally { if (current() && id === generation) loading.value = false; }
  }
  return { rows, count, loading, error, applied, pages, load, reset, retry: () => load(attempted) };
}
