import { onScopeDispose, ref, watch } from 'vue';
import { onHide, onShow, onUnload } from '@dcloudio/uni-app';
import { apiCommunityFollowHighlights, apiCommunityList, apiCommunityTopics, communityPreviewMode,
  type CommunityPost, type CommunityTopic } from '@/api/community';
import { useAuthStore } from '@/stores/auth';
import { useCommunityEngagement } from '@/composables/useCommunityEngagement';

/** Main-list generations include catch/finally and the personalized highlight strip. */
export function useCommunityHomeFeed(engagement = useCommunityEngagement(), enabled: () => boolean = () => true) {
  const auth = useAuthStore(), posts = ref<CommunityPost[]>([]), topics = ref<CommunityTopic[]>([]);
  const highlights = ref<Awaited<ReturnType<typeof apiCommunityFollowHighlights>>>([]), loading = ref(false), error = ref('');
  let visible = true, disposed = false, generation = 0;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  async function load() {
    if (disposed || !visible || !enabled()) return;
    const actor = owner(), revision = ++generation, ticket = engagement.nextTicket(); loading.value = true; error.value = '';
    const current = () => !disposed && visible && enabled() && actor === owner() && revision === generation;
    const results = await Promise.allSettled([apiCommunityList(), apiCommunityTopics(),
      auth.isLoggedIn || communityPreviewMode ? apiCommunityFollowHighlights() : Promise.resolve([])]);
    if (!current()) return;
    try {
      if (results[0].status === 'rejected') throw results[0].reason;
      if (!Array.isArray(results[0].value)) throw Error('帖子列表格式错误');
      posts.value = engagement.adopt(results[0].value, ticket);
    } catch (reason) { error.value = reason instanceof Error ? reason.message : '帖子加载失败，请重试'; }
    topics.value = results[1].status === 'fulfilled' && Array.isArray(results[1].value) ? results[1].value : [];
    highlights.value = results[2].status === 'fulfilled' && Array.isArray(results[2].value) ? results[2].value : [];
    loading.value = false;
  }
  function clear() { generation++; posts.value = []; topics.value = []; highlights.value = []; error.value = ''; loading.value = false; }
  const stopOwner = watch(owner, () => { clear(); if (!disposed && visible && enabled()) void load(); }, { flush: 'sync' });
  function hide() { visible = false; clear(); }
  function show() { if (!disposed) visible = true; }
  function dispose() { if (disposed) return; hide(); disposed = true; stopOwner(); }
  onHide(hide); onShow(show); onUnload(dispose); onScopeDispose(dispose);
  return { posts, topics, highlights, loading, error, load, show, hide, dispose };
}
