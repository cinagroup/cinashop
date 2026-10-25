import { onScopeDispose, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { cartMutationRevision, cartReconciliationRevision } from '@/stores/cartMutation';
import { http } from '@/utils/request';

export function useDiyFooterBadge(active: () => boolean) {
  const auth = useAuthStore(), count = ref(0);
  let epoch = 0, disposed = false;
  const owner = () => `${auth.uid}:${auth.token}:${auth.sessionVersion}`;
  const stop = watch([active, owner, cartMutationRevision, cartReconciliationRevision], async () => {
    const generation = ++epoch, actor = owner(); count.value = 0;
    if (disposed || !active() || !auth.isLoggedIn) return;
    // Login updates uid/token/epoch synchronously. Clear immediately, then issue
    // only the final owner's read once that transaction has finished.
    await Promise.resolve();
    if (disposed || generation !== epoch || actor !== owner() || !active() || !auth.isLoggedIn) return;
    try {
      const result = await http.get<{ count: number }>('cart/count', { scope: 'cart', numType: 0 });
      if (disposed || generation !== epoch || actor !== owner() || !active() || !auth.isLoggedIn) return;
      if (Number.isSafeInteger(result.count) && result.count >= 0) count.value = result.count;
    } catch { /* Badge uncertainty never substitutes the public row count. */ }
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(() => { disposed = true; epoch++; count.value = 0; stop(); });
  return count;
}
