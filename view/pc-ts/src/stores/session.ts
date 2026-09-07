import type { Pinia } from "pinia";
import { getToken, getUid, onAuthChange } from "@/utils/auth";
import { useAuthStore } from "./auth";
import { useCartStore } from "./cart";

/** Registered once at app startup, outside the request/auth-store import cycle. */
export function bindAuthStores(pinia: Pinia): () => void {
  const auth = useAuthStore(pinia);
  const cart = useCartStore(pinia);
  return onAuthChange(() => {
    auth.$patch({ token: getToken() ?? "", uid: getUid() });
    cart.$reset();
  });
}
