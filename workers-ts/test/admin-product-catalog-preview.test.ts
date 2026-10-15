import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

let api: any;
beforeAll(async () => {
  vi.stubGlobal('window', { location: { search: '?preview=1' } });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Preview must not access a provider'));
  const root = resolve(import.meta.dirname, '../../view/admin-ts');
  const bundle = await build({ absWorkingDir: root, stdin: { contents: `export * from './src/api/product'; export * from './src/api/productCatalogFilters';`, resolveDir: root },
    alias: { '@': resolve(root, 'src') }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['axios'], define: { 'import.meta.env.DEV': 'true' } });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(resolve(root, 'package.json')), module, module.exports);
  api = module.exports;
});
afterAll(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); } });

describe('actual Admin preview catalogue filter consumers', () => {
  it('filters preview products using every displayed candidate dimension and retains state-specific counts and warehouse rows', async () => {
    expect((await api.apiAdminProductList({})).list.map((row: any) => row.id)).toEqual([8,7]);
    const cases = [ [{ cate_id: [11] }, [7]], [{ brand_id: [21] }, [8]], [{ store_label_id: [31] }, [8]], [{ supplier_id: 20 }, [7]] ];
    for (const [query, ids] of cases) expect((await api.apiAdminProductList(query)).list.map((row: any) => row.id)).toEqual(ids);
    expect((await api.apiAdminProductTypeHeader({})).map((row: any) => row.count)).toEqual([2,1,0,0,0,0,0,0]);
    expect((await api.apiAdminProductList({ type: 2, cate_id: [11], brand_id: [21], store_label_id: [31] })).list.map((row: any) => row.id)).toEqual([6]);
    expect(await api.apiCatalogFilterSuppliers()).toEqual([{ id: 20, supplier_name: '预览供应商' }]);
  });

  it('keeps category count/list asymmetry when other preview dimensions contradict and does not fabricate matching rows', async () => {
    const query = { page: 1, limit: 10, cate_id: [11], supplier_id: 20, brand_id: [21], store_label_id: [31] };
    expect(await api.apiAdminProductList(query)).toEqual({ list: [], count: 1 });
    expect((await api.apiAdminProductTypeHeader(query)).map((row: any) => row.count)).toEqual([1,1,0,0,0,0,0,0]);
  });
});
