import { describe, expect, it, vi } from "vitest";
import { createAdminTodoLoader, parseAdminPendingCounts, type AdminPendingCounts } from "../../view/admin-ts/src/utils/admin-todos";

const counts = { ordernum: 6, inventory: 2, commentnum: 3, reflectnum: 1, msgcount: 12, sampled_at: 1788580000 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("admin pending-work UI lifecycle", () => {
  it("rejects inconsistent totals, invalid values and old unverified snapshots", () => {
    expect(parseAdminPendingCounts(counts)).toEqual(counts);
    for (const bad of [null, {}, { ...counts, reflectnum: -1 }, { ...counts, msgcount: 4 }, { ...counts, ordernum: "6" }, { ...counts, sampled_at: NaN }]) expect(() => parseAdminPendingCounts(bad)).toThrow();
  });
  it("coalesces open, focus and timer refreshes into one in-flight request", async () => {
    const gate = deferred<AdminPendingCounts>(), publish = vi.fn(), load = vi.fn(() => gate.promise);
    const loader = createAdminTodoLoader(load, publish);
    const first = loader.refresh(), second = loader.refresh();
    expect(second).toBe(first);
    gate.resolve(counts); await first;
    expect(load).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith({ snapshot: counts, loading: false, error: false });
  });
  it("clears stale business counts on failure and can recover without treating failure as zero", async () => {
    const publish = vi.fn(), load = vi.fn().mockResolvedValueOnce(counts).mockRejectedValueOnce(new Error("revoked")).mockResolvedValueOnce({ ...counts, reflectnum: 0, msgcount: 11 });
    const loader = createAdminTodoLoader(load, publish);
    await loader.refresh(); await loader.refresh();
    expect(publish).toHaveBeenLastCalledWith({ snapshot: null, loading: false, error: true });
    await loader.refresh();
    expect(publish).toHaveBeenLastCalledWith({ snapshot: { ...counts, reflectnum: 0, msgcount: 11 }, loading: false, error: false });
  });
  it("does not publish an old user's late response after unmount or logout", async () => {
    const gate = deferred<AdminPendingCounts>(), publish = vi.fn(), load = vi.fn(() => gate.promise);
    const loader = createAdminTodoLoader(load, publish), pending = loader.refresh();
    loader.dispose(); gate.resolve(counts); await pending; await loader.refresh();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
