import { ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { communityPageQuery } from '@/utils/communityShare';
import { resolveCommunityLegacyPageEntry } from '@/utils/communityEntry';

/** A registered page bridge; all identity parsing precedes routing and business I/O. */
export function useCommunityLegacyEntry(path: string) {
  const target = ref(''), error = ref('');
  let generation = 0, disposed = false;
  function open() {
    if (disposed || !target.value) return;
    const revision = ++generation;
    uni.redirectTo({ url: target.value, fail: () => {
      if (!disposed && revision === generation) error.value = '社区页面暂时无法打开，请重试';
    } });
  }
  onLoad(input => {
    try {
      const query = communityPageQuery(input ?? {}), route = resolveCommunityLegacyPageEntry(path, query);
      if (!route) throw Error('社区地址参数无效');
      target.value = route; open();
    } catch (reason) { error.value = '社区地址无效：' + (reason instanceof Error ? reason.message : '参数错误'); }
  });
  onUnload(() => { disposed = true; generation++; });
  return { target, error, open };
}
