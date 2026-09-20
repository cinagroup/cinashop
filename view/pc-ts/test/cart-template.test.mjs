import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, provide, inject, nextTick } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';

const moduleId = '/src/pages/cart/Cart.template-test.ts';
export function cartTemplatePlugin(root) {
  const resolved = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId}`;
  return { name: 'actual-cart-template', resolveId(id) { if (id === moduleId) return resolved; }, async load(id) {
    if (id.replaceAll('\\', '/') !== resolved) return;
    const filename = `${root}/src/pages/cart/Cart.vue`;
    // Compile the real template/setup; image decoding and Element Plus behavior
    // are verified separately in the browser, not simulated by this renderer.
    return compileScript(parse(await readFile(filename, 'utf8'), { filename }).descriptor, { id: 'actual-cart-template', inlineTemplate: true }).content
      .replace(/import ProductImage from ["']@\/components\/ProductImage.vue["'];/, 'const ProductImage = { render: () => null };');
  } };
}
const node = (tag, text = '') => ({ tag, text, children: [], props: {}, parent: null });
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(child, parent, anchor = null) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, child); },
  remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  patchProp(el, key, old, value) { el.props[key] = value; }, setText(el, text) { el.text = text; }, setElementText(el, text) { el.children = []; el.text = text; },
});
const valid = () => ({ id: 1, productId: 70, cartNum: 2, type: 0, unique: 'red001', isNew: 0, isValid: true,
  productInfo: { price: '19.99', otPrice: '25.00', storeName: '模板商品', image: '', stock: 8, suk: '红色', systemFormId: 0, productType: 0 },
  sumPrice: '39.98', truePrice: '17.59', trueSumPrice: '35.18', priceType: 'level', levelName: '银卡' });
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick(); } };
export function registerCartTemplateTests(context) {
  async function mount() {
    const { server, cart, api, response } = context(); cart.$reset();
    api.defaults.adapter = async config => response(config, { status: 200, data: [valid(), { ...valid(), id: 2, isValid: false, productInfo: null }] });
    const component = (await server.ssrLoadModule(moduleId)).default;
    const router = createRouter({ history: createMemoryHistory(), routes: [{path:'/cart',component:{render:()=>null}},{path:'/checkout',component:{render:()=>null}}] });
    const app = renderer.createApp(component), root = node('root'), errors = [];
    app.use(router); app.config.errorHandler = error => errors.push(error);
    app.component('ElTable', { props: ['data'], setup(props, { slots }) { provide('rows', () => props.data); return () => h('table', slots.default?.()); } });
    app.component('ElTableColumn', { setup(props, { slots }) { const rows = inject('rows'); return () => h('column', [slots.header?.(), ...rows().map(row => slots.default?.({ row }))]); } });
    app.component('ElInputNumber', { props: ['min', 'max', 'modelValue', 'disabled'], setup(props) { return () => {
      if (props.min > props.max) throw Error('Invalid input-number bounds'); return h('quantity', { ...props }); }; } });
    for (const [name, tag] of [['ElCheckbox','check'],['ElButton','button'],['ElEmpty','empty']]) app.component(name, { setup(props, {attrs,slots}) { return () => h(tag, attrs, slots.default?.()); } });
    await router.push('/cart'); app.mount(root); await flush();
    const all = (el = root) => [el, ...el.children.flatMap(child => all(child))];
    return { cart, router, errors, all, close() { app.unmount(); } };
  }
  it('cart actual template never mounts quantity controls for invalid rows', async () => {
    const f = await mount(); try {
      assert.deepEqual(f.errors, []); const inputs = f.all().filter(n => n.tag === 'quantity');
      assert.equal(inputs.length, 1); assert.equal(inputs[0].props.modelValue, 2);
      assert.equal(f.all().filter(n => n.tag === 'button' && n.children.some(c => c.text === '删除')).length, 2);
    } finally { f.close(); }
  });
  it('cart actual template binds all-selection, membership totals and checkout navigation', async () => {
    const f = await mount(); try {
      f.all().find(n => n.tag === 'check' && n.props['aria-label'] === '全选有效商品').props.onChange(true); await flush();
      assert.equal(f.cart.totalPrice, '35.18'); assert.deepEqual(f.cart.checkedItems.map(row => row.id), [1]);
      const submit = f.all().find(n => n.tag === 'button' && typeof n.props.onClick === 'function' && n.children.some(c => /去结算/.test(c.text)));
      assert.equal(submit.props.disabled, false); submit.props.onClick(); await flush();
      assert.equal(f.router.currentRoute.value.path, '/checkout'); assert.deepEqual(f.errors, []);
    } finally { f.close(); }
  });
}
