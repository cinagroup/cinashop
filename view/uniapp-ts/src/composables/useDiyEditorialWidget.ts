import { computed, onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';
import { normalizeDiyEditorial } from '@/utils/diyEditorialConfig';
import { apiFollowPoster } from '@/api/legacyShare';
import { readableShareImage } from '@/utils/shareImage';
import { openDiyLink } from '@/utils/diy';
import { diyEditorialMediaCacheUsable } from '@/utils/diyEditorialMediaLease';

export function useDiyEditorialWidget(block: () => unknown, active: () => boolean) {
  const auth = useAuthStore(), theme = useThemeStore();
  const config = computed(() => normalizeDiyEditorial(block(), theme.preset)), fingerprint = computed(() => JSON.stringify(config.value));
  const actor = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const epoch = ref(0), followCodeOpen = ref(false), followDismissed = ref(false), followPosterLoading = ref(false), followPosterError = ref('');
  let disposed = false, dialogEpoch = 0, mediaAdmittedAt=Date.now();
  const releases = new Set<() => void>();
  const ready = () => !disposed && active() && config.value.enabled && diyEditorialMediaCacheUsable({value:[block()]},mediaAdmittedAt);
  const followReady = () => ready() && config.value.kind === 'follow' && !followDismissed.value;
  function lease(dialog = false) {
    const generation = epoch.value, owner = actor(), key = fingerprint.value, opening = dialogEpoch;
    return () => ready() && epoch.value === generation && actor() === owner && fingerprint.value === key
      && (!dialog || followReady() && followCodeOpen.value && dialogEpoch === opening);
  }
  function closeFollow() { followCodeOpen.value = false; }
  const stopDialog = watch(followCodeOpen, value => { if (!value) { dialogEpoch++; followPosterLoading.value = false; } }, { flush: 'sync' });
  function reset() {
    epoch.value++; dialogEpoch++; mediaAdmittedAt=Date.now(); followCodeOpen.value = false; followDismissed.value = false; followPosterLoading.value = false; followPosterError.value = '';
    for (const release of [...releases]) release();
  }
  function open(value: string) { if (ready() && value) openDiyLink(value); }
  function showFollowCode() {
    if (!followReady()) return;
    if (!config.value.followCode) { uni.showToast({ title: '暂未配置公众号二维码', icon: 'none' }); return; }
    followPosterError.value = ''; followCodeOpen.value = true;
  }
  function dismissFollow() { if (!followReady()) return; closeFollow(); followDismissed.value = true; }
  function ownFile(file: { path: string; release(): void }) {
    let released = false;
    const release = () => { if (released) return; released = true; releases.delete(release); file.release(); };
    releases.add(release); return { path: file.path, release };
  }
  let web = false;
  // #ifdef H5
  web = true;
  // #endif
  async function imageAction(poster: boolean) {
    if (!followReady() || !followCodeOpen.value || followPosterLoading.value) return;
    const current = lease(true), ownerCurrent=lease(), code = config.value.followCode;
    followPosterLoading.value = true; followPosterError.value = '';
    try {
      const source = poster ? await apiFollowPoster() : code;
      // Do not start secondary image/file work after any owner/config/hide/close change.
      if (!current()) return;
      const file = ownFile(await readableShareImage(source));
      if (!current()) { file.release(); return; }
      try {
        if (poster || web) {
          closeFollow();
          if(!ownerCurrent()){file.release();return;}
          uni.previewImage({ urls: [file.path], current: file.path, complete: file.release });
        }
        else await new Promise<void>(resolve=>uni.saveImageToPhotosAlbum({ filePath: file.path,
          success: () => { if (current()) uni.showToast({ title: '图片已保存', icon: 'success' }); },
          fail: () => { if (current()) followPosterError.value = '保存失败，请允许相册权限后重试'; },
          complete: () => { file.release();resolve(); } }));
      } catch (reason) { file.release(); throw reason; }
    } catch (reason) { if (current()) followPosterError.value = reason instanceof Error ? reason.message : '图片处理失败，请重试'; }
    finally { if (current()) followPosterLoading.value = false; }
  }
  const stop = watch([fingerprint, actor, active], reset, { immediate: true, flush: 'sync' });
  function dispose() { if (disposed) return; disposed = true; stop(); stopDialog(); reset(); }
  onScopeDispose(dispose);
  return { config, fingerprint, epoch, ready, followCodeOpen, followDismissed, followPosterLoading, followPosterError, open,
    showFollowCode, closeFollow, dismissFollow, previewFollowPoster: () => imageAction(true), saveFollowCode: () => imageAction(false), lease, dispose };
}
