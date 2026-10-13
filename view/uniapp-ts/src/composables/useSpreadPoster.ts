import { ref, watch, onUnmounted } from 'vue';
import { onShow, onHide } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { apiLegacyShareCode, apiSpreadPosterData, type SpreadPosterData } from '@/api/legacyShare';
import { getFormType } from '@/utils/request';
export function useSpreadPoster() {
  const auth = useAuthStore(), data = ref<SpreadPosterData | null>(null), selected = ref(0), code = ref(''), loading = ref(false), error = ref(''), visible = ref(true), ownerUid = ref(0), ownerVersion = ref(0);
  let generation = 0, disposed = false;
  function clear() { generation++; data.value = null; selected.value = 0; code.value = ''; loading.value = false; error.value = ''; ownerUid.value = 0; ownerVersion.value = 0; }
  async function load() {
    if (!visible.value || disposed || loading.value) return;
    clear(); if (!auth.isLoggedIn || auth.uid < 1) { error.value = '登录后生成自己的推广海报'; return; }
    const epoch = generation, actor = { uid: auth.uid, token: auth.token, version: auth.sessionVersion };
    const current = () => !disposed && visible.value && epoch === generation && actor.uid === auth.uid && actor.token === auth.token && actor.version === auth.sessionVersion;
    loading.value = true;
    try {
      const [poster, qr] = await Promise.all([apiSpreadPosterData(), apiLegacyShareCode(-1, actor.uid)]);
      if (!current()) return;
      const image = getFormType() === 'routine' ? qr.routineUrl : qr.wechatUrl;
      if (!image) throw Error(getFormType() === 'routine' ? '小程序推广码尚未配置或发布，请联系商家后重试' : '推广二维码暂不可用，请重试');
      if (!poster.spread.length) throw Error('商家尚未配置推广海报模板');
      if (poster.nickname !== qr.nickname || poster.site_name !== qr.site_name) throw Error('推广身份或站点资料已变化，请重新读取');
      ownerUid.value = actor.uid; ownerVersion.value = actor.version; data.value = poster; code.value = image;
    } catch(e) { if (current()) error.value = e instanceof Error ? e.message : '推广海报读取失败，请重试'; }
    finally { if (current()) loading.value = false; }
  }
  watch(() => [auth.uid, auth.token, auth.sessionVersion], () => { clear(); }, { flush: 'sync' });
  onShow(() => { visible.value = true; void load(); }); onHide(() => { visible.value = false; clear(); }); onUnmounted(() => { disposed = true; clear(); });
  function choose(index: number) { if (!data.value || !Number.isSafeInteger(index) || index < 0 || index >= data.value.spread.length) return; selected.value = index; }
  return { auth, data, selected, code, loading, error, visible, ownerUid, ownerVersion, load, choose };
}
