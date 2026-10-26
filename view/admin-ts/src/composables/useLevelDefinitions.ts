import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiAdminLevelPage, apiAdminLevelSave, apiAdminLevelDel, levelImagePreview, normalizeLevelForm,
  normalizeLevelQuery, type LevelForm, type LevelItem, type LevelQuery } from '@/api/level';
import { useLevelDefinitionOwner } from './useLevelDefinitionOwner';

const emptyForm = (): LevelForm => ({ id: 0, name: '', grade: 1, discount: '100.00', exp_num: 1,
  icon: '', image: '', color: '#333333', is_show: 1, explain: '' });
const message = (value: unknown) => value instanceof Error ? value.message : '请求失败';
function rejected(value: unknown): boolean {
  return value instanceof Error && value.name === 'AdminResponseError' && 'status' in value && typeof value.status === 'number'
    && ([400,403,404,409,422].includes(value.status) || value.status >= 410000 && value.status <= 410999);
}
async function deadline<T>(work: Promise<T>, controller: AbortController, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error(`${label}超时`)); controller.abort();
  }, 12000); })]); } finally { clearTimeout(timer); }
}
/** Every request is fenced by persisted ownership and its own generation. Writes never auto-replay. */
export function useLevelDefinitions() {
  const owner = useLevelDefinitionOwner(), list = ref<LevelItem[]>([]), count = ref(0), page = ref(1), loading = ref(false);
  const draft = reactive({ title: '', is_show: '' as '' | '0' | '1' }), applied = ref<Omit<LevelQuery,'page'|'limit'>>({});
  const error = ref(''), notice = ref(''), busy = ref(''), needsReview = ref(false), formVisible = ref(false);
  const form = reactive(emptyForm()), previews = reactive({ icon: '', image: '' }), mediaClock = ref(0);
  const failedImages = ref(new Set<string>());
  const locked = computed(() => loading.value || !!busy.value), canView = owner.canView, canManage = owner.canManage;
  let mounted = false, ownedBy = '', readVersion = 0, writeVersion = 0, editorVersion = 0, editorOwner = '', editorId = 0;
  let baseline: LevelItem | undefined, readAbort: AbortController | undefined, writeAbort: AbortController | undefined;
  let mediaTimer: ReturnType<typeof setTimeout> | undefined;
  function reset() {
    readVersion++; writeVersion++; editorVersion++; readAbort?.abort(); writeAbort?.abort(); readAbort = writeAbort = undefined;
    clearTimeout(mediaTimer); mediaTimer = undefined; ownedBy = editorOwner = ''; editorId = 0; baseline = undefined;
    list.value = []; count.value = 0; page.value = 1; loading.value = false; busy.value = ''; error.value = notice.value = '';
    needsReview.value = formVisible.value = false; Object.assign(form, emptyForm()); previews.icon = previews.image = '';
    draft.title = draft.is_show = ''; applied.value = {}; failedImages.value = new Set(); mediaClock.value++;
  }
  function dropOld(stamp = ownedBy) { if (stamp && ownedBy === stamp && !owner.current(stamp)) reset(); }
  function view() { if (!mounted || !owner.has()) { dropOld(); return false; } dropOld(); return true; }
  function manage() { if (!view() || !owner.has('level.manage')) { dropOld(); return false; } return !locked.value && !needsReview.value; }
  function image(reference: string, resolved = '') { void mediaClock.value; const src = levelImagePreview(reference, resolved); return failedImages.value.has(src) ? '' : src; }
  function imageFailed(source: string) { failedImages.value = new Set([...failedImages.value, source]); }
  function scheduleMedia() {
    clearTimeout(mediaTimer); mediaTimer = undefined;
    if (!mounted || !owner.has()) return;
    const now = Date.now(), events: Array<{ at: number; refresh: boolean }> = [];
    const add = (source: string, renewable: boolean) => { try {
      const expiry = Number(new URL(source, 'https://level-image.invalid').searchParams.get('expires')) * 1000;
      if (expiry <= now || !source) return;
      // Do not loop on an old/short-lived ticket. An unsaved selection can be
      // chosen afresh in the library; expiration never changes its stable value.
      events.push({ at: renewable && expiry - 30000 > now ? expiry - 30000 : expiry + 20,
        refresh: renewable && expiry - 30000 > now });
    } catch { /* No signed lifetime on a neutral/legacy source. */ } };
    for (const row of list.value) { add(image(row.icon, row.icon_preview), true); add(image(row.image, row.image_preview), true); }
    add(image(form.icon, previews.icon), false); add(image(form.image, previews.image), false);
    events.sort((a,b) => a.at - b.at); const next = events[0]; if (!next) return;
    mediaTimer = setTimeout(() => { mediaTimer = undefined; mediaClock.value++;
      if (next.refresh && !locked.value) void load(page.value, true, false); else scheduleMedia();
    }, Math.max(1, Math.min(next.at - now, 2147483647)));
  }
  async function load(target = page.value, fallback = true, review = true): Promise<boolean> {
    if (!view() || busy.value) return false;
    let query: LevelQuery;
    try { query = normalizeLevelQuery({ ...applied.value, page: target, limit: 10 }); } catch (reason) { error.value = message(reason); return false; }
    const stamp = owner.stamp(), version = ++readVersion, controller = new AbortController(); ownedBy = stamp;
    readAbort?.abort(); readAbort = controller; loading.value = true; error.value = ''; page.value = target;
    list.value = []; count.value = 0;
    const valid = () => mounted && version === readVersion && !controller.signal.aborted && owner.current(stamp);
    try {
      const result = await deadline(apiAdminLevelPage(query, controller.signal), controller, '等级读取');
      if (!valid()) { dropOld(stamp); return false; }
      const last = Math.max(1, Math.min(10000, Math.ceil(result.count / 10)));
      if (!result.list.length && target > last && fallback) return await load(last, false, review);
      list.value = result.list; count.value = result.count; page.value = result.count === 0 ? 1 : target; failedImages.value = new Set();
      if (formVisible.value && editorOwner === stamp) for (const slot of ['icon','image'] as const) {
        const row = result.list.find(item => item[slot] === form[slot]); if (row) previews[slot] = row[`${slot}_preview`] ?? '';
      }
      if (review && needsReview.value) { needsReview.value = false; notice.value = '列表已重新读取，请核对原操作和草稿后再决定是否提交。'; }
      scheduleMedia(); return true;
    } catch (reason) {
      if (mounted && version === readVersion && owner.current(stamp)) { error.value = message(reason); scheduleMedia(); }
      else dropOld(stamp);
      return false;
    } finally {
      if (mounted && version === readVersion && owner.current(stamp)) { loading.value = false; if (readAbort === controller) readAbort = undefined; }
      dropOld(stamp);
    }
  }
  function search() {
    if (!view() || busy.value) return;
    try { const query = normalizeLevelQuery({ page: 1, limit: 10, title: draft.title,
      ...(draft.is_show === '' ? {} : { is_show: Number(draft.is_show) as 0 | 1 }) });
      applied.value = { ...(query.title ? { title: query.title } : {}), ...(query.is_show === undefined ? {} : { is_show: query.is_show }) }; void load(1);
    } catch (reason) { error.value = message(reason); }
  }
  function changePage(value: number) {
    if (view() && !locked.value && Number.isSafeInteger(value) && value >= 1 && value <= 10000 && value !== page.value) void load(value);
  }
  function resetFilters() { if (view() && !busy.value) { draft.title = draft.is_show = ''; applied.value = {}; void load(1); } }
  function openForm(row?: LevelItem) {
    if (!manage() || row && !list.value.includes(row)) return;
    editorVersion++; editorOwner = owner.stamp(); editorId = row?.id ?? 0; baseline = row ? { ...row } : undefined;
    Object.assign(form, row ? { id: row.id, name: row.name, grade: row.grade, discount: row.discount, exp_num: row.expNum,
      icon: row.icon, image: row.image, color: row.color, is_show: row.isShow, explain: row.explain ?? '' } : emptyForm());
    previews.icon = row?.icon_preview ?? ''; previews.image = row?.image_preview ?? ''; formVisible.value = true; error.value = ''; scheduleMedia();
  }
  function closeForm() { if (!busy.value) { editorVersion++; editorOwner = ''; baseline = undefined; formVisible.value = false; Object.assign(form, emptyForm()); previews.icon = previews.image = ''; scheduleMedia(); } }
  function editorCurrent() { return formVisible.value && manage() && editorOwner === owner.stamp() && form.id === editorId; }
  function setMedia(slot: 'icon'|'image', reference: string, resolved = '') { if (editorCurrent()) { form[slot] = reference; previews[slot] = resolved; scheduleMedia(); } }
  function updateField(field: Exclude<keyof LevelForm,'id'>, value: unknown) {
    if (!editorCurrent() || typeof value !== typeof form[field]) return;
    if (field === 'icon' || field === 'image') setMedia(field, value as string);
    else (form as unknown as Record<string,unknown>)[field] = value;
  }
  const editorKey = () => `${owner.stamp()}:${editorVersion}`;
  async function write(label: string, submit: (signal: AbortSignal) => Promise<unknown>, accept: (value: unknown) => void, confirmation?: string): Promise<boolean> {
    if (!manage()) return false;
    const stamp = owner.stamp(), version = ++writeVersion, controller = new AbortController(), returnPage = page.value;
    ownedBy = stamp; writeAbort = controller; busy.value = label; error.value = ''; notice.value = ''; let dispatched = false, success = false;
    const valid = () => mounted && version === writeVersion && owner.current(stamp) && owner.has('level.manage');
    try {
      if (confirmation) await ElMessageBox.confirm(confirmation, '删除等级', { type: 'warning' });
      if (!valid()) { dropOld(stamp); return false; }
      dispatched = true; const result = await deadline(submit(controller.signal), controller, label);
      if (!valid()) { dropOld(stamp); return false; }
      accept(result); needsReview.value = false; notice.value = `${label}已确认`; ElMessage.success(notice.value); success = true;
    } catch (reason) {
      if (valid() && reason !== 'cancel' && reason !== 'close') {
        needsReview.value = dispatched && !rejected(reason);
        error.value = needsReview.value ? `${label}结果未确认：${message(reason)}。请重新读取列表核对；不会自动重试。` : message(reason);
      } else dropOld(stamp);
    } finally {
      if (valid()) { busy.value = ''; if (writeAbort === controller) writeAbort = undefined; scheduleMedia(); }
      dropOld(stamp);
    }
    if (success && valid()) await load(returnPage, true, false);
    return success && valid();
  }
  async function save() {
    if (!editorCurrent()) return false;
    let input: ReturnType<typeof normalizeLevelForm>;
    try { input = normalizeLevelForm({ ...form }, baseline); } catch (reason) { error.value = message(reason); return false; }
    const revision = editorVersion, id = editorId;
    return write('保存等级', signal => apiAdminLevelSave(input, signal), value => {
      const row = value as { id?: unknown };
      if (!row || !Number.isSafeInteger(row.id) || Number(row.id) < 1 || id > 0 && row.id !== id) throw Error('保存响应与原等级不一致');
      if (revision === editorVersion) { formVisible.value = false; editorVersion++; baseline = undefined; }
    });
  }
  async function toggle(row: LevelItem, value: unknown) {
    if (!manage() || !list.value.includes(row) || value !== 0 && value !== 1 || row.isShow === value) return false;
    const id = row.id;
    return write('修改显示状态', signal => apiAdminLevelSave({ id, is_show: value }, signal), result => {
      if (!result || typeof result !== 'object' || !('id' in result) || result.id !== id) throw Error('显示状态响应与原等级不一致');
    });
  }
  async function remove(row: LevelItem) {
    if (!manage() || !list.value.includes(row)) return false;
    const id = row.id;
    return write('删除等级', signal => apiAdminLevelDel(id, signal), result => { if (result !== null) throw Error('删除响应格式错误'); }, `确认删除等级“${row.name}”？正在使用的等级无法删除。`);
  }
  watch(owner.identity, () => { reset(); if (mounted && owner.has()) void load(1); }, { flush: 'sync' });
  onMounted(() => { mounted = true; if (owner.has()) void load(1); });
  onBeforeUnmount(() => { mounted = false; reset(); });
  return { owner, canView, canManage, list, count, page, loading, draft, applied, error, notice, busy, needsReview,
    formVisible, form, previews, locked, image, imageFailed, load, search, changePage, resetFilters, openForm, closeForm, setMedia, updateField, editorKey, save, toggle, remove };
}
