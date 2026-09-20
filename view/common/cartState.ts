import { cartTotal, normalizeCartList, type CartDisplayItem } from './cartPrice';

export interface CartState {
  items: CartDisplayItem[]; selection: number[]; count: number; loading: boolean; ready: boolean; updating: boolean; error: string;
  readVersion: number; writeVersion: number; countVersion: number;
}
export const initialCartState = (): CartState => ({ items: [], selection: [], count: 0, loading: false, ready: false, updating: false, error: '', readVersion: 0, writeVersion: 0, countVersion: 0 });
export const cartGetters = {
  checkedItems: (state: CartState) => state.items.filter(row => row.checked && row.isValid),
  totalPrice: (state: CartState) => state.ready ? cartTotal(state.items) : '0.00',
  totalNum: (state: CartState) => state.items.filter(row => row.checked && row.isValid).reduce((n, row) => n + row.cartNum, 0),
};
interface Transport {
  authenticated(): boolean;
  capture(): () => boolean;
  list(): Promise<unknown>;
  count(): Promise<number>;
  update(id: number, quantity: number): Promise<unknown>;
  remove(ids: number[]): Promise<unknown>;
}
interface Actions {
  fetchList(): Promise<void>;
  fetchCount(): Promise<void>;
  toggleChecked(id: number, checked: boolean): void;
  toggleAll(checked: boolean): void;
  cancelPending(): void;
  updateQuantity(id: number, quantity: number): Promise<void>;
  removeItem(id: number): Promise<void>;
}
type Model = CartState & Actions;
const message = (error: unknown) => error instanceof Error ? error.message : '购物车读取失败，请重试';

/** Per-store epochs plus identity snapshots. Shared by PC and UniApp, no global request state. */
export function createCartActions(io: Transport): Actions {
  async function mutate(model: Model, write: () => Promise<unknown>) {
    const owner = io.capture(), version = ++model.writeVersion;
    const current = () => owner() && model.writeVersion === version;
    model.readVersion++; model.loading = false; model.updating = true; model.ready = false; model.error = '';
    try { await write(); if (current()) await model.fetchList(); }
    catch (error) { if (current()) { model.items = []; model.ready = false; model.error = message(error); } }
    finally { if (current()) model.updating = false; }
  }
  return {
    async fetchList(this: Model): Promise<void> {
      const owner = io.capture(), version = ++this.readVersion;
      const current = () => owner() && version === this.readVersion;
      if (this.items.length) this.selection = this.items.filter(row => row.checked && row.isValid).map(row => row.id);
      const selected = new Set(this.selection);
      this.items = []; this.loading = true; this.ready = false; this.error = '';
      try {
        if (!io.authenticated()) throw Error('请先登录后查看购物车');
        const response = await io.list();
        if (!current()) return;
        const rows = normalizeCartList(response);
        this.items = rows.map(row => ({ ...row, checked: row.isValid && selected.has(row.id) }));
        this.selection = this.items.filter(row => row.checked).map(row => row.id); this.ready = true;
      } catch (error) { if (current()) this.error = message(error); throw error; }
      finally { if (current()) this.loading = false; }
    },
    async fetchCount(this: Model): Promise<void> {
      const owner = io.capture(), version = ++this.countVersion;
      if (!io.authenticated()) return;
      try { const count = await io.count(); if (owner() && version === this.countVersion && Number.isSafeInteger(count) && count >= 0) this.count = count; }
      catch { /* Badge failure must not replace a newer account's count. */ }
    },
    toggleChecked(this: Model, id: number, checked: boolean): void {
      if (!this.ready || this.updating) return;
      const row = this.items.find(row => row.id === id && row.isValid);
      if (row) row.checked = checked;
      this.selection = this.items.filter(row => row.checked && row.isValid).map(row => row.id);
    },
    toggleAll(this: Model, checked: boolean): void {
      if (!this.ready || this.updating) return;
      this.items.forEach(row => { row.checked = row.isValid && checked; });
      this.selection = this.items.filter(row => row.checked).map(row => row.id);
    },
    cancelPending(this: Model): void {
      this.readVersion++; this.writeVersion++; this.loading = false; this.updating = false; this.ready = false;
      // Keep owner-local selection for checkout's next read; hidden pages never render it as a current quote.
    },
    async updateQuantity(this: Model, id: number, quantity: number): Promise<void> {
      if (!this.ready || this.updating || !io.authenticated()) return;
      const row = this.items.find(row => row.id === id && row.isValid);
      if (!row || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > Math.min(row.productInfo?.stock ?? 0, 32767)) return;
      await mutate(this, () => io.update(id, quantity));
    },
    async removeItem(this: Model, id: number): Promise<void> {
      if (!this.ready || this.updating || !io.authenticated() || !this.items.some(row => row.id === id)) return;
      await mutate(this, () => io.remove([id]));
    },
  };
}
