import { beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let selection: any, useList: any;
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../view/supplier-ts');
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { useShippingTemplateSelection } from './src/utils/shippingTemplateSelection';
    export { useShippingTemplateList } from './src/utils/shippingTemplateList';
  ` }, alias: { '@': resolve(root, 'src') }, bundle: true, write: false, platform: 'browser', format: 'esm' });
  const actual = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  selection = actual.useShippingTemplateSelection; useList = actual.useShippingTemplateList;
});
const detail = (name = '第一页之外', type = 2, id = 201) => ({ id, name, type: ['按件数', '按重量', '按体积'][type - 1] });
function deferred() { let resolve!: (v: unknown) => void, reject!: (v: Error) => void;
  return { promise: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve: (v: unknown) => resolve(v), reject: (v: Error) => reject(v) }; }

describe('Supplier product shipping selection', () => {
  it('hydrates an exact selected ID independently of the browsed page', async () => {
    const fetch = vi.fn().mockResolvedValue(detail()), selected = selection(fetch, () => true);
    const list = useList(vi.fn().mockResolvedValue({ count: 125, data: [{ id: 325, name: '第一页' }] }), () => true);
    await list.load(); await selected.hydrate(201);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(201);
    expect(selected.selected.value).toEqual({ id: 201, name: '第一页之外', type: '按重量' });
    await list.load({ name: '别的查询', page: 1, limit: 20 }); list.reset();
    expect(selected.selected.value.id).toBe(201);
  });
  it('can page through 125 options without loading all of them at once', async () => {
    const fetch = vi.fn(async (q: any) => ({ count: 125, data: Array.from({ length: Math.min(20, 125 - (q.page - 1) * 20) }, (_, i) => ({ id: 325 - (q.page - 1) * 20 - i })) }));
    const list = useList(fetch, () => true), ids: number[] = [];
    for (let page = 1; page <= 7; page++) { await list.load({ name: '', page, limit: 20 }); ids.push(...list.rows.value.map((r: any) => r.id)); }
    expect(ids).toEqual(Array.from({ length: 125 }, (_, i) => 325 - i));
    expect(fetch).toHaveBeenCalledTimes(7); expect(list.rows.value).toHaveLength(5);
  });
  it.each([1, 2, 3])('formats billing type %s without changing selected identity', async type => {
    const state = selection(async () => detail('名称', type), () => true); await state.hydrate(201);
    expect(state.selected.value).toEqual({ id: 201, name: '名称', type: ['按件数', '按重量', '按体积'][type - 1] });
  });
  it.each(['success', 'failure'])('ignores late old %s after a new selected ID resolves', async kind => {
    const old = deferred(), fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail('新选择', 3, 202));
    const state = selection(fetch, () => true), pending = state.hydrate(201);
    await state.hydrate(202);
    if (kind === 'success') old.resolve(detail()); else old.reject(new Error('旧失败'));
    await pending; expect(state.selected.value).toEqual({ id: 202, name: '新选择', type: '按体积' });
    expect(state.error.value).toBe(''); expect(state.loading.value).toBe(false);
  });
  it('clearing the ID prevents an in-flight label from reappearing', async () => {
    const old = deferred(), fetch = vi.fn().mockReturnValue(old.promise), state = selection(fetch, () => true);
    const pending = state.hydrate(201); await state.hydrate(0); old.resolve(detail()); await pending;
    expect(state.selected.value).toBeNull(); expect(state.loading.value).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a failure explicit and can retry the original ID', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('无权读取')).mockResolvedValueOnce(detail());
    const state = selection(fetch, () => true); await state.hydrate(201);
    expect(state.error.value).toContain('未修改商品原模板ID'); expect(state.selected.value).toBeNull();
    await state.hydrate(201); expect(state.selected.value.id).toBe(201); expect(state.error.value).toBe('');
  });
  it('clears private state and ignores pending reads after session invalidation or disposal', async () => {
    let current = true; const old = deferred(), fetch = vi.fn().mockResolvedValueOnce(detail()).mockReturnValueOnce(old.promise);
    const state = selection(fetch, () => current); await state.hydrate(201); const pending = state.hydrate(202);
    current = false; state.reset(); old.resolve(detail('late')); await pending; await state.hydrate(203);
    expect(state.selected.value).toBeNull(); expect(state.loading.value).toBe(false); expect(state.error.value).toBe(''); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([-1, 1.5, 2147483648, NaN])('rejects invalid selected ID %s without dispatch', async id => {
    const fetch = vi.fn(), state = selection(fetch, () => true); await state.hydrate(id);
    expect(fetch).not.toHaveBeenCalled(); expect(state.error.value).toContain('ID无效');
  });
  it.each([null, {}, detail('', 1), detail('x'.repeat(256), 1), detail('name', 4), detail('wrong ID', 1, 202)])('rejects malformed selected detail %j', async value => {
    const state = selection(async () => value, () => true); await state.hydrate(201);
    expect(state.selected.value).toBeNull(); expect(state.error.value).toContain('响应无效');
  });
  it('wires the product picker with paging, explicit selection, retry and mounted-session cancellation', () => {
    const component = readFileSync(resolve(import.meta.dirname, '../../view/supplier-ts/src/components/ShippingTemplatePicker.vue'), 'utf8');
    for (const contract of ['session.signal', 'useShippingTemplateList', 'useShippingTemplateSelection', 'watch(() => props.modelValue',
      'session.dispose()', 'rows.value.some(row => row.id === id)', 'aria-label="商品运费模板分页"', '@click="search"',
      '@click="list.retry"', '@click="selection.hydrate(modelValue)"', 'emit(\'update:modelValue\', id)']) expect(component).toContain(contract);
    const product = readFileSync(resolve(import.meta.dirname, '../../view/supplier-ts/src/pages/ProductForm.vue'), 'utf8');
    expect(product).toContain('<ShippingTemplatePicker v-model="form.temp_id"');
    expect(product).not.toContain('getShippingTemplates({ page: 1, limit: 100 })');
    expect(component).toContain('getProductShippingOptions');
    expect(component).toContain('getProductShippingOption(id, session.signal)');
    expect(component).not.toContain('getShippingTemplate(');
    expect(product).toContain('v-if="auth.can(\'supplier.shipping.view\')" link type="primary" @click="router.push(\'/shipping-templates\')"');
  });
  it('does not label a failed request as a successful empty result', () => {
    const component = readFileSync(resolve(import.meta.dirname, '../../view/supplier-ts/src/components/ShippingTemplatePicker.vue'), 'utf8');
    expect(component).toContain('v-if="!rows.length && !loading && !error"');
    expect(component).toContain('<nav v-if="!error"');
    expect(component).toContain('当前商品模板选择不变');
  });
});
