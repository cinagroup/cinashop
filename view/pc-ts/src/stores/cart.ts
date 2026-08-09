/**
 * 购物车状态 (Pinia)
 */
import { defineStore } from "pinia";
import { apiCartList, apiCartCount } from "@/api/cart";
import type { CartItem } from "@/types/order";

interface CartState {
  items: CartItem[];
  count: number;
  loading: boolean;
}

export const useCartStore = defineStore("cart", {
  state: (): CartState => ({
    items: [],
    count: 0,
    loading: false,
  }),

  getters: {
    /** 选中的购物车项 */
    checkedItems: (state): CartItem[] => state.items.filter((i) => i.checked),
    /** 选中项总价 */
    totalPrice: (state): string => {
      const total = state.items
        .filter((i) => i.checked)
        .reduce((sum, i) => sum + Number(i.sumPrice ?? 0), 0);
      return total.toFixed(2);
    },
    /** 选中数量 */
    totalNum: (state): number =>
      state.items.filter((i) => i.checked).reduce((sum, i) => sum + i.cartNum, 0),
  },

  actions: {
    /** 刷新购物车列表 */
    async fetchList(): Promise<void> {
      this.loading = true;
      try {
        this.items = await apiCartList();
      } finally {
        this.loading = false;
      }
    },

    /** 刷新数量角标 */
    async fetchCount(): Promise<void> {
      try {
        const { count } = await apiCartCount();
        this.count = count;
      } catch {
        // ignore
      }
    },

    /** 设置选中 */
    toggleChecked(id: number, checked: boolean): void {
      const item = this.items.find((i) => i.id === id);
      if (item) item.checked = checked;
    },

    /** 全选/取消全选 */
    toggleAll(checked: boolean): void {
      this.items.forEach((i) => (i.checked = checked));
    },
  },
});
