import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, markRaw, nextTick, reactive } from 'vue';

// Compile the actual template AND setup. The host is an in-memory tree: browser
// image decoding, dimensions and HTTP failures require separate rendered QA.
const root = fileURLToPath(new URL('../', import.meta.url));
const moduleId = '/src/components/ProductImage.client-test.ts';
const resolved = `${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId}`;
let server, ProductImage;
before(async () => {
  const filename = `${root}src/components/ProductImage.vue`;
  const { descriptor } = parse(await readFile(filename, 'utf8'), { filename });
  const content = compileScript(descriptor, { id: 'actual-product-image', inlineTemplate: true }).content;
  server = await createServer({ root, configFile: false, envFile: false, logLevel: 'error',
    plugins: [{ name: 'actual-product-image-template', resolveId(id) { if (id === moduleId) return resolved; },
      load(id) { if (id.replaceAll('\\', '/') === resolved) return content; } }],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null } });
  ProductImage = (await server.ssrLoadModule(moduleId)).default;
});
after(async () => { await server?.close(); });
const node = (tag, text = '') => markRaw({ tag, text, props: {}, children: [], parent: null });
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  insert(child, parent, anchor = null) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
  },
  remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  parentNode: child => child.parent,
  nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
  patchProp(el, key, previous, value) { el.props[key] = value; },
  setText(el, text) { el.text = text; }, setElementText(el, text) { el.children = []; el.text = text; },
});
function mount(values) {
  const props = reactive(values), container = node('root');
  const app = renderer.createApp({ render: () => h(ProductImage, props) });
  const warnings = [];
  app.config.warnHandler = message => warnings.push(message);
  app.mount(container);
  const all = (el = container) => [el, ...el.children.flatMap(child => all(child))];
  return { props, warnings, image: () => all().find(el => el.tag === 'img'),
    fallback: () => all().find(el => el.props.role === 'img'),
    root: () => container.children[0], close: () => app.unmount() };
}
async function fail(image) { image.props.onError({ currentTarget: image }); await nextTick(); }

it('shows explicit missing-image text for empty, whitespace, null and absent URLs without making an img request', async () => {
  for (const src of ['', '   ', null, undefined]) {
    const f = mount({ src, alt: '本地商品' });
    try {
      assert.equal(f.image(), undefined);
      assert.equal(f.fallback().props['aria-label'], '本地商品：暂无商品图片');
      assert.equal(f.fallback().children[0].text, '暂无商品图片');
      assert.deepEqual(f.warnings, []);
    } finally { f.close(); }
  }
});
it('preserves the real source, alt, lazy loading, fit and parent geometry classes', () => {
  const f = mount({ src: ' /fixtures/product.svg ', alt: '<商品&名称>', loading: 'lazy', fit: 'contain', class: 'thumb' });
  try {
    assert.equal(f.image().props.src, '/fixtures/product.svg');
    assert.equal(f.image().props.alt, '<商品&名称>');
    assert.equal(f.image().props.loading, 'lazy'); assert.equal(f.image().props.decoding, 'async');
    assert.equal(f.root().props.style['--product-image-fit'], 'contain');
    assert.match(f.root().props.class, /thumb/); assert.equal(f.fallback(), undefined);
  } finally { f.close(); }
});
it('removes a failed image and exposes a named error state without fallback URLs or automatic retries', async () => {
  const f = mount({ src: '/missing.svg', alt: '测试商品' });
  try {
    const image = f.image(); await fail(image);
    assert.equal(f.image(), undefined);
    assert.equal(f.fallback().props['aria-label'], '测试商品：图片加载失败');
    for (let i = 0; i < 3; i++) { await nextTick(); await fail(image); }
    f.props.src = '/missing.svg'; f.props.alt = '更新后的名称'; await nextTick();
    assert.equal(f.fallback().props['aria-label'], '更新后的名称：图片加载失败');
    assert.equal(f.image(), undefined);
  } finally { f.close(); }
});
it('recovers on a new source, with missing and failed states kept distinct', async () => {
  const f = mount({ src: '/bad.svg', alt: '原商品' });
  try {
    await fail(f.image()); f.props.src = '/good.svg'; f.props.alt = '新商品'; await nextTick();
    assert.equal(f.image().props.src, '/good.svg'); assert.equal(f.image().props.alt, '新商品');
    assert.equal(f.fallback(), undefined);
    f.props.src = ''; await nextTick(); assert.equal(f.fallback().props['aria-label'], '新商品：暂无商品图片');
    f.props.src = '/next.svg'; await nextTick(); assert.equal(f.image().props.src, '/next.svg');
  } finally { f.close(); }
});
it('ignores late errors from detached old sources, including an A to B to A switch', async () => {
  const f = mount({ src: '/a.svg' });
  try {
    const oldA = f.image(); f.props.src = '/b.svg'; await nextTick();
    const oldB = f.image(); await fail(oldA); assert.equal(f.image(), oldB);
    f.props.src = '/a.svg'; await nextTick();
    const newA = f.image(); assert.notEqual(newA, oldA);
    await fail(oldA); await fail(oldB); assert.equal(f.image(), newA);
    await fail(newA); assert.equal(f.image(), undefined);
  } finally { f.close(); }
});
it('isolates sibling failures and tolerates detached events after unmount', async () => {
  const first = mount({ src: '/same.svg' }), second = mount({ src: '/same.svg' });
  const old = first.image();
  try {
    await fail(old); assert.ok(second.image()); assert.equal(second.fallback(), undefined);
    first.close(); await fail(old); assert.ok(second.image());
    assert.deepEqual(first.warnings, []); assert.deepEqual(second.warnings, []);
  } finally { second.close(); }
});
it('integrates all 15 product-image pages without changing the source data to placeholder artwork', async () => {
  const pages = ['Home', 'goods/GoodsList', 'goods/GoodsSearch', 'goods/GoodsDetail', 'user/CollectList', 'user/CouponProducts',
    'activity/Seckill', 'activity/SeckillDetail', 'activity/Combination', 'activity/CombinationDetail', 'activity/Bargain',
    'cart/Cart', 'order/Checkout', 'order/OrderList', 'order/OrderDetail'];
  for (const page of pages) {
    const source = await readFile(`${root}src/pages/${page}.vue`, 'utf8');
    assert.match(source, /import ProductImage from "@\/components\/ProductImage.vue";/, page);
    assert.match(source, /<ProductImage\b/, page);
    assert.doesNotMatch(source, /const placeholder\s*=|image\s*\|\|\s*placeholder|\.goods-image img|\.scope-product img|\.review-product img/, page);
    if (page.startsWith('order/') || page.startsWith('cart/')) {
      assert.doesNotMatch(source, /<ProductImage[^>]*:alt="[^"]*store_name/, page);
    }
  }
  const detail = await readFile(`${root}src/pages/goods/GoodsDetail.vue`, 'utf8');
  assert.match(detail, /v-if="detail.slider_image.length"/);
  assert.match(detail, /<ProductImage v-else :src="detail.image"/);
});
