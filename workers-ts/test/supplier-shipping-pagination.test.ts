import { beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let useList: any;
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../view/supplier-ts');
  const output = await build({ absWorkingDir: root, entryPoints: ['src/utils/shippingTemplateList.ts'],
    alias: { '@': resolve(root, 'src') }, bundle: true, write: false, platform: 'browser', format: 'esm' });
  useList = (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)).useShippingTemplateList;
});
function result(count = 45, page = 1, limit = 20) {
  return { count, data: Array.from({ length: Math.max(0, Math.min(limit, count - (page - 1) * limit)) }, (_, n) => ({ id: count - (page - 1) * limit - n, name: 'fixture' })) };
}
function deferred() { let finish!: (value: any) => void, fail!: (error: Error) => void;
  return { promise: new Promise((resolve, reject) => { finish = resolve; fail = reject; }), finish: (v: any) => finish(v), fail: (v: Error) => fail(v) }; }

describe('actual Supplier shipping list pagination state', () => {
  it('reaches all three pages and commits each query with its rows', async () => {
    const fetcher = vi.fn(async (q: any) => result(45, q.page, q.limit)); const list = useList(fetcher, () => true);
    const seen: number[] = [];
    for (const page of [1, 2, 3]) {
      await list.load({ name: '', page, limit: 20 }); seen.push(...list.rows.value.map((r: any) => r.id));
      expect(list.applied.value.page).toBe(page); expect(list.pages.value).toBe(3);
    }
    expect(seen).toEqual(Array.from({ length: 45 }, (_, n) => 45 - n));
    expect(new Set(seen).size).toBe(45); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('search and page size use explicit first-page queries, not unsent search input', async () => {
    const fetcher = vi.fn(async (q: any) => result(q.name ? 1 : 45, q.page, q.limit)), list = useList(fetcher, () => true);
    await list.load({ name: '', page: 3, limit: 20 });
    await list.load({ name: '  target  ', page: 1, limit: 20 });
    expect(list.applied.value).toEqual({ name: 'target', page: 1, limit: 20 });
    await list.load({ ...list.applied.value, page: 1, limit: 10 });
    expect(fetcher.mock.calls.at(-1)?.[0]).toEqual({ name: 'target', page: 1, limit: 10 });
  });
  it('failed navigation preserves displayed query/count/rows and retries the failed query', async () => {
    const fetcher = vi.fn(async (q: any) => result(45, q.page, q.limit)), list = useList(fetcher, () => true);
    await list.load(); const previous = [...list.rows.value];
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await list.load({ name: 'target', page: 2, limit: 10 });
    expect(list.error.value).toBe('offline'); expect(list.loading.value).toBe(false);
    expect(list.rows.value).toEqual(previous); expect(list.applied.value).toEqual({ name: '', page: 1, limit: 20 }); expect(list.count.value).toBe(45);
    await list.retry(); expect(fetcher.mock.calls.at(-1)?.[0]).toEqual({ name: 'target', page: 2, limit: 10 });
    expect(list.applied.value.page).toBe(2); expect(list.error.value).toBe('');
  });
  it.each(['success', 'failure'])('late old %s cannot replace a newer successful search', async kind => {
    const old = deferred(), fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(result(1));
    const list = useList(fetcher, () => true); const first = list.load();
    await list.load({ name: 'new', page: 1, limit: 20 });
    if (kind === 'success') old.finish(result()); else old.fail(new Error('late failure'));
    await first;
    expect(list.applied.value.name).toBe('new'); expect(list.count.value).toBe(1); expect(list.error.value).toBe(''); expect(list.loading.value).toBe(false);
  });
  it('late response cannot finish the currently loading newer request', async () => {
    const first = deferred(), second = deferred(); const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const list = useList(fetcher, () => true), a = list.load(), b = list.load({ name: 'new', page: 1, limit: 20 });
    first.finish(result()); await a; expect(list.loading.value).toBe(true); expect(list.rows.value).toEqual([]);
    second.finish(result(1)); await b; expect(list.loading.value).toBe(false); expect(list.count.value).toBe(1);
  });
  it('session invalidation/reset clears private data and ignores late reads', async () => {
    let current = true; const pending = deferred(); const fetcher = vi.fn().mockResolvedValueOnce(result()).mockReturnValueOnce(pending.promise);
    const list = useList(fetcher, () => current); await list.load(); const reading = list.load();
    current = false; list.reset(); pending.finish(result()); await reading; await list.retry();
    expect(list.rows.value).toEqual([]); expect(list.count.value).toBe(0); expect(list.loading.value).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('deleting the last page re-reads the new final page once', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(result(40, 3)).mockResolvedValueOnce(result(40, 2));
    const list = useList(fetcher, () => true); await list.load({ name: '', page: 3, limit: 20 });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[1][0].page).toBe(2);
    expect(list.applied.value.page).toBe(2); expect(list.rows.value[0].id).toBe(20);
  });
  it('empty results settle on page one after one bounded correction', async () => {
    const fetcher = vi.fn().mockResolvedValue(result(0)); const list = useList(fetcher, () => true);
    await list.load({ name: '', page: 3, limit: 20 }); expect(list.applied.value.page).toBe(1); expect(list.pages.value).toBe(1);
    expect(list.rows.value).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('a changing count cannot cause an unbounded page correction loop', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result(40, 3)).mockResolvedValueOnce(result(0));
    const list = useList(fetcher, () => true); await list.load(); const rows = [...list.rows.value];
    await list.load({ name: '', page: 3, limit: 20 }); expect(fetcher).toHaveBeenCalledTimes(3);
    expect(list.error.value).toContain('正在变化'); expect(list.rows.value).toEqual(rows); expect(list.applied.value.page).toBe(1);
  });
  it.each([{ page: 0 }, { page: 1.5 }, { page: 1_000_001 }, { limit: 0 }, { limit: 101 }, { name: 'x'.repeat(256) }])('invalid query cannot dispatch: %j', async bad => {
    const fetcher = vi.fn(), list = useList(fetcher, () => true);
    await list.load({ name: '', page: 1, limit: 20, ...bad }); expect(fetcher).not.toHaveBeenCalled(); expect(list.error.value).toContain('参数');
  });
  it.each([null, { count: -1, data: [] }, { count: '45', data: [] }, { count: 45, data: [{ id: 0 }] }, result(45, 1, 21)])('malformed list cannot replace the displayed page: %j', async bad => {
    const fetcher = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(bad), list = useList(fetcher, () => true);
    await list.load(); const before = [...list.rows.value]; await list.load({ name: '', page: 2, limit: 20 });
    expect(list.rows.value).toEqual(before); expect(list.applied.value.page).toBe(1); expect(list.error.value).toContain('响应无效');
  });
  it('the actual page wires navigation, committed-query refresh, retry and session reset', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../view/supplier-ts/src/pages/ShippingTemplates.vue'), 'utf8');
    for (const contract of ['useShippingTemplateList', 'aria-label="运费模板分页"', 'changePage(applied.page - 1)', 'changePage(applied.page + 1)',
      '@change="changePageSize"', '@change="jumpPage"', '@click="search"', '@keyup.enter="search"', '@click="list.retry"', 'list.reset()']) expect(source).toContain(contract);
  });
});
