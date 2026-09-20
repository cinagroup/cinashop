import { defineStore } from 'pinia';
import { http } from '@/utils/request';
import { useAuthStore } from './auth';
import { initialCartState, cartGetters, createCartActions } from '../../../common/cartState';

export const useCartStore = defineStore('cart', {
  state: initialCartState,
  getters: cartGetters,
  actions: createCartActions({
    authenticated: () => useAuthStore().isLoggedIn,
    capture: () => {
      const auth = useAuthStore(), version = auth.sessionVersion, token = auth.token, uid = auth.uid;
      return () => version === auth.sessionVersion && token === auth.token && uid === auth.uid;
    },
    list: () => http.get('/cart/list', { scope: 'cart' }),
    count: async () => (await http.get<{ count: number }>('/cart/count', { scope: 'cart' })).count,
    update: (id, cartNum) => http.post('/cart/num', { id, cartNum }),
    remove: ids => http.post('/cart/del', { ids }),
  }),
});
