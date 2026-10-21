import { computed, onScopeDispose, ref, watch } from 'vue';
import { apiCommunityCommentConfig, apiCommunityList, checkedCommunityPost, communityPreviewMode, type CommunityPost } from '@/api/community';
import { useAuthStore } from '@/stores/auth';
import { useCommunityAvailability } from '@/utils/communityAvailability';
import { normalizeDiyCommunity } from '@/utils/diyCommunity';
import { communitySharePath } from '@/utils/communityShare';
import { openDiyLink, safeDiyImageUrl } from '@/utils/diy';
import { communityVideoSource } from '@/utils/communityMedia';

/** Read-only, per-instance state. The two actual page roots supply visibility;
 * dynamic child instances never register UniApp page lifecycle callbacks. */
export function useDiyCommunity(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), availability = useCommunityAvailability();
  const config = computed(() => normalizeDiyCommunity(block()));
  const fingerprint = computed(() => JSON.stringify(config.value));
  const rows = ref<CommunityPost[]>([]), loading = ref(false), loaded = ref(false), error = ref('');
  let generation = 0, disposed = false;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const visible = () => !disposed && active() && config.value.enabled;
  const ready = () => visible() && availability.allowed.value;
  const current = (revision: number, actor: string, key: string) => ready() && revision === generation && actor === owner() && key === fingerprint.value;
  function invalidate() { generation++; rows.value = []; loading.value = false; loaded.value = false; error.value = ''; }
  async function load() {
    if (!ready() || loading.value) return;
    const revision = ++generation, actor = owner(), key = fingerprint.value, limit = config.value.limit;
    rows.value = []; loading.value = true; loaded.value = false; error.value = '';
    try {
      const flags = await apiCommunityCommentConfig();
      if (!current(revision, actor, key) || flags.community_status !== 1) return;
      const result = await apiCommunityList(1, limit, { is_follow: 0 });
      if (!current(revision, actor, key)) return;
      if (!Array.isArray(result) || result.length > limit) throw Error('社区预览格式错误');
      const checked = result.map(post => {
        checkedCommunityPost(post, post?.id);
        if (post.status !== 1 || !communityPreviewMode && post.is_verify !== 1
          || post.author !== undefined && typeof post.author !== 'string' || post.author_image !== undefined && typeof post.author_image !== 'string') throw Error('社区预览包含不可公开内容');
        return { ...post };
      });
      const ids = new Set<number>(); rows.value = checked.filter(post => !ids.has(post.id) && Boolean(ids.add(post.id))); loaded.value = true;
    } catch (reason) { if (current(revision, actor, key)) error.value = reason instanceof Error ? reason.message : '社区预览加载失败，请重试'; }
    finally { if (current(revision, actor, key)) loading.value = false; }
  }
  async function recover() {
    if (!visible() || loading.value || availability.checking.value) return;
    // Shared checking/closed transitions reload every still-visible widget once.
    await availability.refresh(communityPreviewMode);
  }
  function openPost(post: CommunityPost) {
    if (!ready() || loading.value || error.value || !rows.value.some(row => row.id === post.id && row.contentType === post.contentType)) return;
    const path = communitySharePath(post.id, post.contentType, 0); if (path) openDiyLink(path);
  }
  function openMore() { if (ready() && !loading.value && !error.value) openDiyLink('/pages/discover/index'); }
  const media = (value: unknown) => communityVideoSource(safeDiyImageUrl(value));
  const stop = watch([fingerprint, owner, active, availability.closed, availability.checking], () => {
    invalidate(); if (ready()) void load();
  }, { immediate: true, flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); invalidate(); }
  onScopeDispose(dispose);
  return { config, availability, rows, loading, loaded, error, load, recover, openPost, openMore, media, dispose };
}
