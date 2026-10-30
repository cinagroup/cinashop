import { computed, onScopeDispose, ref, watch } from 'vue';
import { apiCommunityCommentConfig, apiCommunityList, checkedCommunityPost, communityPreviewMode, type CommunityPost } from '@/api/community';
import { useAuthStore } from '@/stores/auth';
import { useCommunityAvailability } from '@/utils/communityAvailability';
import { normalizeDiyCommunity } from '@/utils/diyCommunity';
import { communitySharePath } from '@/utils/communityShare';
import { openDiyLink, safeDiyImageUrl } from '@/utils/diy';
import { communityVideoSource } from '@/utils/communityMedia';
import { diyAuthoredPageFingerprint, diyEditorialMediaCacheUsable, diyEditorialMediaDeadline } from '@/utils/diyEditorialMediaLease';
import { diyCommunityColumns } from '../../../common/diyCommunityColumns';

/** Per-instance public reads. Page roots own visibility; native callbacks own leases. */
export function useDiyCommunity(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), availability = useCommunityAvailability();
  const config = computed(() => normalizeDiyCommunity(block()));
  // The normalizer omits dormant topic metadata. Only the explicit title-image
  // transport ticket is removed; a different asset or actual visual change stays significant.
  const fingerprint = computed(() => {
    const { titleImage, ...visual } = config.value;
    return diyAuthoredPageFingerprint([{ ...visual, name: 'community', imgConfig: { url: titleImage } }]);
  });
  const rows = ref<CommunityPost[]>([]), loading = ref(false), loaded = ref(false), error = ref('');
  const heights = ref<Map<number, number>>(new Map()), nativeEpoch = ref(0), mediaDeadline = ref(0), clock = ref(Date.now());
  const columns = computed(() => diyCommunityColumns(rows.value, heights.value));
  let generation = 0, disposed = false, mediaAdmittedAt = Date.now(), timer: ReturnType<typeof setTimeout> | undefined;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const visible = () => !disposed && active() && config.value.enabled;
  const ready = () => visible() && availability.allowed.value && mediaDeadline.value > clock.value
    && diyEditorialMediaCacheUsable({ value: [block()] }, mediaAdmittedAt);
  const current = (revision: number, actor: string, key: string) => ready() && revision === generation && actor === owner() && key === fingerprint.value;
  function lease(source?: () => string) {
    const revision = generation, native = nativeEpoch.value, actor = owner(), key = fingerprint.value, original = source?.();
    return () => current(revision, actor, key) && native === nativeEpoch.value && (!source || source() === original);
  }
  function invalidate() { generation++; nativeEpoch.value++; rows.value = []; heights.value = new Map(); loading.value = false; loaded.value = false; error.value = ''; }
  async function load() {
    if (!ready() || loading.value) return;
    const revision = ++generation, actor = owner(), key = fingerprint.value, limit = config.value.limit;
    nativeEpoch.value++; rows.value = []; heights.value = new Map(); loading.value = true; loaded.value = false; error.value = '';
    try {
      const flags = await apiCommunityCommentConfig();
      if (!current(revision, actor, key) || flags.community_status !== 1) return;
      const result = await apiCommunityList(1, limit, { is_follow: 0 });
      if (!current(revision, actor, key)) return;
      if (!Array.isArray(result) || result.length > limit) throw Error('社区预览格式错误');
      const checked = Array.from(result, post => {
        checkedCommunityPost(post, post?.id);
        if (post.status !== 1 || !communityPreviewMode && post.is_verify !== 1
          || !(post.sliderImage === null || Array.isArray(post.sliderImage) && Array.from(post.sliderImage).every(value => typeof value === 'string'))
          || post.author !== undefined && typeof post.author !== 'string' || post.author_image !== undefined && typeof post.author_image !== 'string') throw Error('社区预览包含不可公开内容');
        return { ...post, sliderImage: post.sliderImage === null ? null : [...post.sliderImage] };
      });
      const ids = new Set<number>(); rows.value = checked.filter(post => !ids.has(post.id) && Boolean(ids.add(post.id))); loaded.value = true;
    } catch (reason) { if (current(revision, actor, key)) error.value = reason instanceof Error ? reason.message : '社区预览加载失败，请重试'; }
    finally { if (current(revision, actor, key)) loading.value = false; }
  }
  function scheduleLoad() {
    const revision = generation, actor = owner(), key = fingerprint.value;
    void Promise.resolve().then(() => { if (current(revision, actor, key) && !loaded.value && !loading.value) void load(); });
  }
  function expireMedia() {
    if (disposed) return;
    clock.value = Date.now();
    if (mediaDeadline.value > clock.value) { timer = setTimeout(expireMedia, Math.max(1, mediaDeadline.value - clock.value)); return; }
    generation++; nativeEpoch.value++; loading.value = false; error.value = '';
  }
  function renewMedia() {
    nativeEpoch.value++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined; mediaAdmittedAt = Date.now(); clock.value = mediaAdmittedAt;
    mediaDeadline.value = diyEditorialMediaDeadline({ value: [block()] }, mediaAdmittedAt);
    if (Number.isFinite(mediaDeadline.value) && mediaDeadline.value > clock.value) timer = setTimeout(expireMedia, mediaDeadline.value - clock.value);
    if (ready()) scheduleLoad();
  }
  async function recover() {
    if (!visible() || loading.value || availability.checking.value) return;
    await availability.refresh(communityPreviewMode);
  }
  function openPost(post: CommunityPost) {
    if (!ready() || loading.value || error.value || !rows.value.some(row => row.id === post.id && row.contentType === post.contentType)) return;
    const path = communitySharePath(post.id, post.contentType, 0); if (path) openDiyLink(path);
  }
  function openMore() { if (ready() && !loading.value && !error.value) openDiyLink('/pages/discover/index'); }
  const media = (value: unknown) => ready() ? communityVideoSource(safeDiyImageUrl(value)) : '';
  // Bundled /static title images stay local on App/MP. Managed assets are
  // already mapped to API_BASE by the existing safe image normalizer.
  const mediaTitle = () => ready() ? safeDiyImageUrl(config.value.titleImage) : '';
  function adoptMeasurement(row: { id: number; height: number; current: () => boolean }) {
    if (!row.current() || !ready() || config.value.layout !== 'columns' || !rows.value.some(post => post.id === row.id)
      || !Number.isFinite(row.height) || row.height <= 0 || row.height > 1_000_000) return;
    if (Math.abs((heights.value.get(row.id) ?? 0) - row.height) <= 0.5) return;
    const next = new Map(heights.value); next.set(row.id, row.height); heights.value = next;
  }
  const stop = watch([fingerprint, owner, active, availability.closed, availability.checking], () => {
    invalidate(); if (ready()) scheduleLoad();
  }, { immediate: true, flush: 'sync' });
  // Ticket-only replacement renews native media handlers without refetching a loaded feed.
  const stopMedia = watch(block, renewMedia, { immediate: true, deep: true, flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); stopMedia(); if (timer !== undefined) clearTimeout(timer); invalidate(); }
  onScopeDispose(dispose);
  return { config, fingerprint, availability, rows, columns, heights, nativeEpoch, mediaDeadline, ready, lease, adoptMeasurement,
    loading, loaded, error, load, recover, openPost, openMore, media, mediaTitle, dispose };
}
