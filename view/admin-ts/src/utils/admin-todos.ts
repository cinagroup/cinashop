export interface AdminPendingCounts {
  ordernum: number;
  inventory: number;
  commentnum: number;
  reflectnum: number;
  msgcount: number;
  sampled_at: number;
}

export interface AdminTodoState {
  snapshot: AdminPendingCounts | null;
  loading: boolean;
  error: boolean;
}

export function parseAdminPendingCounts(value: unknown): AdminPendingCounts {
  if (!value || typeof value !== "object") throw new Error("待办数据格式错误");
  const count = (key: keyof AdminPendingCounts) => {
    const number = Reflect.get(value, key);
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) throw new Error("待办数据格式错误");
    return number;
  };
  const result = { ordernum: count("ordernum"), inventory: count("inventory"), commentnum: count("commentnum"), reflectnum: count("reflectnum"), msgcount: count("msgcount"), sampled_at: count("sampled_at") };
  if (result.msgcount !== result.ordernum + result.inventory + result.commentnum + result.reflectnum) throw new Error("待办总数不一致");
  return result;
}

/** A single in-flight read; disposed/logged-out views cannot receive late results. */
export function createAdminTodoLoader(load: () => Promise<AdminPendingCounts>, publish: (state: AdminTodoState) => void) {
  let disposed = false;
  let pending: Promise<void> | undefined;
  let snapshot: AdminPendingCounts | null = null;
  return {
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      publish({ snapshot, loading: true, error: false });
      pending = Promise.resolve().then(load).then((result) => {
        if (disposed) return;
        snapshot = parseAdminPendingCounts(result);
        publish({ snapshot, loading: false, error: false });
      }).catch(() => {
        // A failed permission/session refresh must not keep showing older counts.
        snapshot = null;
        if (!disposed) publish({ snapshot, loading: false, error: true });
      }).finally(() => { pending = undefined; });
      return pending;
    },
    dispose() { disposed = true; snapshot = null; },
  };
}
