import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, toRaw, watch } from 'vue';
import { apiAdminExtractDirectory, apiAdminExtractDirectoryMedia, extractDirectoryDefaults,
  extractDirectoryDateInput, extractDirectoryShanghaiTime, normalizeExtractDirectoryQuery,
  type ExtractDirectoryQuery, type ExtractDirectoryReport, type ExtractDirectoryRow } from '@/api/extractDirectory';
import { useExtractDirectoryOwner } from './useExtractDirectoryOwner';

type Draft = { status: '' | '-1' | '0' | '1'; extract_type: ExtractDirectoryQuery['extract_type']; keyword: string; dates: string[] };
type MediaState = { id: number; revision: string; nickname: string; state: 'loading' | 'ready' | 'unavailable' | 'error' | 'expired'; preview: string; expires: number | null; message: string };
const emptyDraft = (): Draft => ({status:'',extract_type:'',keyword:'',dates:[]});
const message = (error: unknown) => error instanceof Error ? error.message : '读取失败，请重试';
const denied = (error: unknown) => error instanceof Error && 'status' in error
  && [401,403,400011,410000,410001,410002].includes(Number(error.status));
const cancelled = (error: unknown) => error instanceof Error && error.name === 'AbortError';
export type ExtractDirectoryShortcut = 'today' | 'yesterday' | 'recent7' | 'recent30' | 'month' | 'last-month' | 'year';
/** PHP DatePicker shortcuts select calendar wall minutes, then the API applies
 * its explicit endpoint rules. Workstation timezone never changes these dates. */
export function extractDirectoryShortcut(kind: ExtractDirectoryShortcut, now = Math.floor(Date.now()/1000)): string[] {
  const wall = extractDirectoryShanghaiTime(now), [day] = wall.split(' ');
  const [year,month,date] = day!.split('/').map(Number);
  const calendar = (y: number,m: number,d: number) => new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10).replaceAll('-','/')+' 00:00';
  if (kind === 'yesterday') { const value = calendar(year!,month!,date!-1); return [value,value]; }
  if (kind === 'last-month') return [calendar(year!,month!-1,1),calendar(year!,month!,0)];
  const start = kind === 'today' ? calendar(year!,month!,date!) : kind === 'recent7' ? calendar(year!,month!,date!-6)
    : kind === 'recent30' ? calendar(year!,month!,date!-29) : kind === 'month' ? calendar(year!,month!,1) : calendar(year!,1,1);
  return [start,wall];
}

/** Read-only workflow. Every response and retained handler has an immutable
 * owner/session fence plus independent list and media generations. */
export function useExtractDirectory(initialStatus: ExtractDirectoryQuery['status'] = null) {
  const owner = useExtractDirectoryOwner(), draft = reactive<Draft>(emptyDraft());
  const report = shallowRef<ExtractDirectoryReport | null>(null), accepted = shallowRef<ExtractDirectoryQuery | null>(null);
  const loading = ref(false), error = ref(''), blocked = ref(false), media = ref<MediaState | null>(null);
  const canView = computed(() => owner.canView.value && !blocked.value);
  let mounted = false, generation = 0, mediaGeneration = 0, retainedOwner = '';
  let readAbort: AbortController | undefined, mediaAbort: AbortController | undefined;
  let mediaTimer: ReturnType<typeof setTimeout> | undefined, lastAttempt: ExtractDirectoryQuery | undefined;
  const initial = () => ({...extractDirectoryDefaults(),status:initialStatus});
  const copy = (query: ExtractDirectoryQuery) => ({...query});

  function closeMedia() {
    mediaGeneration++; mediaAbort?.abort(); mediaAbort = undefined;
    clearTimeout(mediaTimer); mediaTimer = undefined; media.value = null;
  }
  function clear() {
    generation++; readAbort?.abort(); readAbort = undefined; closeMedia();
    report.value = accepted.value = null; retainedOwner = ''; lastAttempt = undefined;
    loading.value = false; error.value = ''; blocked.value = false; Object.assign(draft,emptyDraft());
  }
  function dropOld(stamp: string) { if (retainedOwner === stamp && !owner.current(stamp)) clear(); }
  function view(): boolean {
    if (!mounted || !owner.has() || blocked.value || retainedOwner && !owner.current(retainedOwner)) {
      if (retainedOwner && !owner.current(retainedOwner)) clear();
      return false;
    }
    return true;
  }
  function draftQuery(): ExtractDirectoryQuery {
    if (draft.dates.length !== 0 && draft.dates.length !== 2) throw Error('请选择完整的开始与结束时间');
    const start = draft.dates.length ? extractDirectoryDateInput(draft.dates[0]!) : 0;
    const stop = draft.dates.length ? extractDirectoryDateInput(draft.dates[1]!) : 0;
    return normalizeExtractDirectoryQuery({page:1,limit:20,status:draft.status === '' ? null : Number(draft.status),
      extract_type:draft.extract_type,keyword:draft.keyword,start,stop});
  }
  const dirty = computed(() => {
    if (!accepted.value) return false;
    try { const query = draftQuery(); return Object.keys(query).some(key => key !== 'page'
      && query[key as keyof ExtractDirectoryQuery] !== accepted.value![key as keyof ExtractDirectoryQuery]); }
    catch { return true; }
  });
  async function load(query: ExtractDirectoryQuery): Promise<boolean> {
    if (!view()) return false;
    let requested: ExtractDirectoryQuery;
    try { requested = normalizeExtractDirectoryQuery(query); } catch (reason) { error.value = message(reason); return false; }
    const actor = owner.capture(); if (!actor) { clear(); return false; }
    const stamp = owner.stamp(), version = ++generation, controller = new AbortController();
    readAbort?.abort(); closeMedia(); readAbort = controller; retainedOwner = stamp;
    lastAttempt = copy(requested); loading.value = true; error.value = '';
    const current = () => mounted && generation === version && !controller.signal.aborted && actor.current() && owner.current(stamp);
    try {
      const value = await apiAdminExtractDirectory(requested,actor,controller.signal);
      if (!current()) { dropOld(stamp); return false; }
      report.value = value; accepted.value = copy(value.query); return true;
    } catch (reason) {
      if (!current()) { dropOld(stamp); return false; }
      if (denied(reason)) { clear(); blocked.value = true; error.value = '查看权限已变化，请重新登录后再试'; }
      else if (!cancelled(reason)) error.value = message(reason);
      return false;
    } finally {
      if (current()) { loading.value = false; if (readAbort === controller) readAbort = undefined; }
    }
  }
  function search() {
    if (!view()) return Promise.resolve(false);
    try { return load(draftQuery()); } catch (reason) { error.value = message(reason); return Promise.resolve(false); }
  }
  function resetFilters() {
    if (!view()) return Promise.resolve(false);
    Object.assign(draft,emptyDraft()); return load(extractDirectoryDefaults());
  }
  function setShortcut(kind: ExtractDirectoryShortcut) { if (view()) draft.dates = extractDirectoryShortcut(kind); }
  function changePage(page: number) {
    if (!view() || loading.value || !accepted.value || !Number.isSafeInteger(page) || page < 1 || page > 1000
      || page === accepted.value.page || page > Math.max(1,Math.ceil((report.value?.count ?? 0)/20))) return Promise.resolve(false);
    return load({...accepted.value,page});
  }
  function retry() { return view() && !loading.value ? load(lastAttempt ?? accepted.value ?? initial()) : Promise.resolve(false); }
  function selected(row: Pick<ExtractDirectoryRow,'id'|'revision'>) {
    return report.value?.list.find(item => item.id === row.id && item.revision === row.revision);
  }
  async function openMedia(row: ExtractDirectoryRow): Promise<boolean> {
    if (!view() || loading.value || !report.value?.list.some(item => toRaw(item) === toRaw(row))
      || !selected(row) || !row.media_available || row.id <= 0) return false;
    const actor = owner.capture(); if (!actor) { clear(); return false; }
    const stamp = owner.stamp(); closeMedia(); const version = mediaGeneration, controller = new AbortController(); mediaAbort = controller;
    const source = Object.freeze({id:row.id,uid:row.uid,revision:row.revision,extract_type:row.extract_type,media_available:row.media_available});
    media.value = {...source,nickname:row.nickname,state:'loading',preview:'',expires:null,message:''};
    const current = () => mounted && version === mediaGeneration && !controller.signal.aborted && actor.current()
      && owner.current(stamp) && !!selected(source) && media.value?.id === source.id && media.value.revision === source.revision;
    try {
      const value = await apiAdminExtractDirectoryMedia(source,actor,controller.signal);
      if (!current()) { dropOld(stamp); return false; }
      if (!value.available) { media.value = {...media.value!,state:'unavailable',message:'该记录暂无可读取的收款码'}; return true; }
      media.value = {...media.value!,state:'ready',preview:value.preview,expires:value.expires,message:''};
      mediaTimer = setTimeout(() => {
        if (!current()) { dropOld(stamp); if (version === mediaGeneration) closeMedia(); return; }
        media.value = {...media.value!,state:'expired',preview:'',expires:null,message:'收款码已过期，请重新读取'};
      },Math.max(1,value.expires*1000-Date.now()));
      return true;
    } catch (reason) {
      if (!current()) { dropOld(stamp); return false; }
      if (denied(reason)) { clear(); blocked.value = true; error.value = '查看权限已变化，请重新登录后再试'; }
      else if (reason instanceof Error && 'status' in reason && reason.status === 409) {
        closeMedia(); report.value = null; error.value = '记录已变化，请重新查询列表';
      }
      else if (!cancelled(reason)) media.value = {...media.value!,state:'error',preview:'',expires:null,
        message:message(reason)};
      return false;
    } finally { if (mediaAbort === controller) mediaAbort = undefined; }
  }
  function retryMedia() {
    const row = media.value && selected(media.value); return row ? openMedia(row) : Promise.resolve(false);
  }
  const mediaImage = computed(() => media.value?.state === 'ready' ? {src:media.value.preview,
    key:JSON.stringify([mediaGeneration,media.value.id,media.value.revision,media.value.preview])} : null);
  function imageFailed(preview: string, key: string) {
    if (!view() || mediaImage.value?.key !== key || media.value?.preview !== preview || !preview) return;
    clearTimeout(mediaTimer); mediaTimer = undefined;
    media.value = {...media.value,state:'error',preview:'',expires:null,message:'收款码加载失败，请重新读取'};
  }
  function applyStatus(value: ExtractDirectoryQuery['status']) {
    if (!view()) return;
    if (value !== null && ![-1,0,1].includes(value)) return;
    draft.status = value === null ? '' : String(value) as Draft['status']; void search();
  }
  watch(owner.identity, () => {
    clear();
    // Wait until all fields of the Pinia/session patch agree. A replacement
    // owner starts with empty filters, and no retained old handler is reused.
    const identity = owner.stamp();
    if (mounted) void Promise.resolve().then(() => { if (mounted && owner.current(identity)) void load(extractDirectoryDefaults()); });
  },{flush:'sync'});
  onMounted(() => { mounted = true; draft.status = initialStatus === null ? '' : String(initialStatus) as Draft['status']; if (owner.has()) void load(initial()); });
  onBeforeUnmount(() => { mounted = false; clear(); });
  return {owner,canView,draft,accepted,report,loading,error,blocked,dirty,media,mediaImage,
    list:computed(() => report.value?.list ?? []),count:computed(() => report.value?.count ?? 0),page:computed(() => accepted.value?.page ?? 1),
    search,resetFilters,setShortcut,changePage,retry,openMedia,closeMedia,retryMedia,imageFailed,applyStatus,extractDirectoryShanghaiTime};
}
