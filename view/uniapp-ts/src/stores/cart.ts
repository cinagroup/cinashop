/**
 * 购物车状态 (Pinia)
 */
import { defineStore } from "pinia";
import { http } from "@/utils/request";
import type { CartItem } from "@/types/order";

interface CartState {
  items: CartItem[];
  count: number;
}

export const useCartStore = defineStore("cart", {
  state: (): CartState => ({
    items: [],
    count: 0,
  }),

  getters: {
    checkedItems: (state): CartItem[] => state.items.filter((i) => i.checked),
    totalPrice: (state): string =>
      state.items
        .filter((i) => i.checked)
        .reduce((sum, i) => sum + Number(i.sumPrice ?? 0), 0)
        .toFixed(2),
  },

  actions: {
    async fetchList(): Promise<void> {
      try {
        const list = await http.get<CartItem[]>("/cart/list", undefined, { noAuth: false });
        // 保留已选中状态 (按 id 合并 checked, 避免跳转后选中丢失)
        const prevChecked = new Set(this.items.filter((i) => i.checked).map((i) => i.id));
        this.items = list.map((item) => ({ ...item, checked: prevChecked.has(item.id) }));
      } catch {
        this.items = [];
      }
    },

    async fetchCount(): Promise<void> {
      try {
        const { count } = await http.get<{ count: number }>("/cart/count");
        this.count = count;
      } catch {
        // ignore
      }
    },

    toggleChecked(id: number, checked: boolean): void {
      const item = this.items.find((i) => i.id === id);
      if (item) item.checked = checked;
    },

    toggleAll(checked: boolean): void {
      this.items.forEach((i) => (i.checked = checked));
    },
  },
});
