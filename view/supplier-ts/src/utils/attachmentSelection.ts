import { computed, ref, shallowRef } from 'vue';
import {
  currentSupplierAttachmentOwner, getSupplierAttachments, getSupplierAttachmentCategories, normalizeAttachmentQuery,
  type AttachmentQuery, type AttachmentCategory, type SupplierAttachment,
} from '@/api/attachments';
import { createSupplierSessionScope } from '@/utils/supplierSession';

export function useAttachmentSelection(options: { supplierId: number; limit: number }) {
  if (!Number.isSafeInteger(options.supplierId) || options.supplierId <= 0 || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) {
    throw new Error('图片选择数量或供应商参数无效');
  }
  const rows = shallowRef<SupplierAttachment[]>([]), categories = shallowRef<AttachmentCategory[]>([]);
  const selected = shallowRef<SupplierAttachment[]>([]), count = ref(0), loading = ref(false), error = ref('');
  const categoriesLoading = ref(false), categoriesError = ref(''), invalidated = ref(false);
  const initial = (): AttachmentQuery => ({ pid: 0, name: '', page: 1 });
  const applied = ref<AttachmentQuery>(initial());
  let attempted = initial(), categoryAttempted = 0, categoryApplied: number | null = null;
  let generation = 0, categoryGeneration = 0, disposed = false;
  let reading: AbortController | undefined, categoryReading: AbortController | undefined;
  function clear() {
    generation++; categoryGeneration++; reading?.abort(); categoryReading?.abort();
    reading = categoryReading = undefined;
    rows.value = []; categories.value = []; selected.value = []; count.value = 0;
    loading.value = categoriesLoading.value = false; error.value = categoriesError.value = '';
    applied.value = initial(); attempted = initial(); categoryAttempted = 0; categoryApplied = null;
  }
  const session = createSupplierSessionScope(() => { invalidated.value = true; clear(); });
  function current() {
    if (disposed || invalidated.value || !session.isCurrent()) return false;
    try { if (currentSupplierAttachmentOwner() === options.supplierId) return true; } catch { /* invalidate below */ }
    invalidated.value = true; clear(); session.dispose(); return false;
  }
  current();
  const pages = computed(() => Math.max(1, Math.ceil(count.value / 20)));
  function usable() {
    return current() && !loading.value && !error.value && !categoriesLoading.value && !categoriesError.value
      && (categoryApplied === null || categoryApplied === applied.value.pid);
  }
  const canConfirm = computed(() => usable() && selected.value.length > 0 && selected.value.length <= options.limit);

  async function load(target: AttachmentQuery = applied.value) {
    if (!current()) return;
    const id = ++generation; reading?.abort(); reading = new AbortController();
    const controller = reading;
    // Old results cannot remain selectable under a new query or after a failed read.
    rows.value = []; count.value = 0; error.value = ''; loading.value = true;
    try {
      const query = normalizeAttachmentQuery(target); attempted = { ...query };
      const result = await getSupplierAttachments(query, controller.signal);
      if (!current() || id !== generation || controller.signal.aborted) return;
      // Previously chosen rows whose reference changed must be chosen again explicitly.
      const changed = new Set(result.list.filter(row => selected.value.some(old => old.id === row.id && old.canonicalUrl !== row.canonicalUrl)).map(row => row.id));
      selected.value = selected.value.filter(row => !changed.has(row.id));
      rows.value = result.list; count.value = result.count; applied.value = { ...query };
    } catch (failure) {
      if (current() && id === generation && !controller.signal.aborted) error.value = failure instanceof Error ? failure.message : '图片加载失败，请重试';
    } finally { if (current() && id === generation) loading.value = false; }
  }
  async function loadCategories(pid = applied.value.pid) {
    if (!current()) return;
    const id = ++categoryGeneration; categoryReading?.abort(); categoryReading = new AbortController();
    const controller = categoryReading;
    categories.value = []; categoriesError.value = ''; categoriesLoading.value = true; categoryAttempted = pid;
    if (attempted.pid !== pid) { generation++; reading?.abort(); rows.value = []; count.value = 0; loading.value = false; error.value = ''; }
    try {
      const result = await getSupplierAttachmentCategories(pid, controller.signal);
      if (!current() || id !== categoryGeneration || controller.signal.aborted) return;
      categories.value = result; categoryApplied = pid;
    } catch (failure) {
      if (current() && id === categoryGeneration && !controller.signal.aborted) categoriesError.value = failure instanceof Error ? failure.message : '图片目录加载失败，请重试';
    } finally { if (current() && id === categoryGeneration) categoriesLoading.value = false; }
  }
  function toggle(id: number): boolean {
    if (!usable()) return false;
    const row = rows.value.find(row => row.id === id);
    if (!row) return false;
    if (selected.value.some(item => item.id === id)) { remove(id); return true; }
    if (selected.value.length >= options.limit || selected.value.some(item => item.canonicalUrl === row.canonicalUrl)) return false;
    selected.value = [...selected.value, row]; return true;
  }
  function remove(id: number) { if (current()) selected.value = selected.value.filter(item => item.id !== id); }
  function confirm(): SupplierAttachment[] | null {
    if (!usable() || !selected.value.length || selected.value.length > options.limit) return null;
    return selected.value.map(row => ({ ...row }));
  }
  function reset() { clear(); current(); }
  function dispose() { disposed = true; invalidated.value = true; clear(); session.dispose(); }
  return {
    rows, categories, selected, count, pages, loading, error, applied, categoriesLoading, categoriesError, invalidated, canConfirm,
    load, loadCategories, retry: () => load(attempted), retryCategories: () => loadCategories(categoryAttempted), toggle, remove, confirm, reset, dispose,
  };
}
