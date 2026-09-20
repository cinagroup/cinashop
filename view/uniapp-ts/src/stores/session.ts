import { watch } from 'vue';
import type { Pinia } from 'pinia';
import { useAuthStore } from './auth';
import { useCartStore } from './cart';

/** Bind once per app, outside the auth -> request -> cart import graph. */
export function bindAuthStores(pinia: Pinia): () => void {
  const auth = useAuthStore(pinia), cart = useCartStore(pinia);
  return watch(() => auth.sessionVersion, () => cart.$reset(), { flush: 'sync' });
}
