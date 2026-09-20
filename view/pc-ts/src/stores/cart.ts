import { defineStore } from 'pinia';
import { apiCartList, apiCartCount, apiCartNum, apiCartDel } from '@/api/cart';
import { captureAuthSession, isCurrentAuthSession, isLoggedIn } from '@/utils/auth';
import { initialCartState, cartGetters, createCartActions } from '../../../common/cartState';

export const useCartStore = defineStore('cart', {
  state: initialCartState,
  getters: cartGetters,
  actions: createCartActions({
    authenticated: isLoggedIn,
    capture: () => { const owner = captureAuthSession(); return () => isCurrentAuthSession(owner); },
    list: apiCartList,
    count: async () => (await apiCartCount()).count,
    update: apiCartNum,
    remove: apiCartDel,
  }),
});
