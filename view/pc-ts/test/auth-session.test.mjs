import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { createPinia } from "pinia";
import { AxiosError } from "axios";
import { seckillComponentPlugin, registerSeckillPurchaseTests } from "./seckill-purchase.test.mjs";
import { combinationComponentPlugin, registerCombinationPurchaseTests } from './combination-purchase.test.mjs';
import { bargainComponentPlugin, registerBargainPurchaseTests } from './bargain-purchase.test.mjs';
import { checkoutShippingPlugin, registerCheckoutShippingTests } from './bargain-checkout-shipping.test.mjs';

// Load the actual PC request layer and Pinia stores with Vite's existing TS/alias support.
// No HTTP listener, API proxy, external request, new dependency or browser-global mutation in production.
const root = fileURLToPath(new URL("../", import.meta.url));
const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), clear: () => values.clear() };
};
let server, authUtils, auth, cart, api, unbind;
const navigation = [];
const descriptors = new Map();
const location = { origin: "https://shop.example.test", pathname: "/checkout", search: "?mode=buy&cartIds=2", hash: "#details", replace: (url) => navigation.push(url) };
before(async () => {
  for (const [key, value] of Object.entries({ sessionStorage: memoryStorage(), localStorage: memoryStorage(), window: { location } })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  localStorage.setItem("pc_token", "obsolete-persistent-token");
  localStorage.setItem("pc_uid", "99");
  server = await createServer({ configFile: false, root, envFile: false, logLevel: "error",
    plugins: [vue(), seckillComponentPlugin(root), combinationComponentPlugin(root), bargainComponentPlugin(root), checkoutShippingPlugin(root)],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
    server: { middlewareMode: true, hmr: false, watch: null } });
  authUtils = await server.ssrLoadModule("/src/utils/auth.ts");
  api = (await server.ssrLoadModule("/src/utils/request.ts")).default;
  const pinia = createPinia();
  auth = (await server.ssrLoadModule("/src/stores/auth.ts")).useAuthStore(pinia);
  cart = (await server.ssrLoadModule("/src/stores/cart.ts")).useCartStore(pinia);
  unbind = (await server.ssrLoadModule("/src/stores/session.ts")).bindAuthStores(pinia);
});
after(async () => {
  unbind?.();
  await server?.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});
beforeEach(() => {
  navigation.length = 0;
  location.pathname = "/checkout";
  authUtils.setAuth("session-a", 11);
  cart.items = [{ id: 1, isValid: true, checked: true }];
  cart.count = 1;
});
const response = (config, data, status = 200) => ({ data, status, statusText: "fixture", headers: {}, config });
function delayed() {
  let config, resolve, reject, signal;
  const started = new Promise((yes) => { signal = yes; });
  api.defaults.adapter = (current) => {
    config = current;
    signal(current);
    return new Promise((yes, no) => { resolve = yes; reject = no; });
  };
  return { started, success: (data) => resolve(response(config, data)), fail: (error) => reject(error) };
}

describe("actual Axios + storage + Pinia auth-session isolation", { concurrency: false }, () => {
  registerSeckillPurchaseTests(() => ({ server, authUtils, api, location, navigation, response }));
  registerCombinationPurchaseTests(() => ({ server, authUtils, api, location, navigation, response }));
  registerBargainPurchaseTests(() => ({ server, authUtils, api, location, navigation, response }));
  registerCheckoutShippingTests(() => ({ server, authUtils, api, response }));
  const walletRow = (change = {}) => ({ id: 60, coupon_title: '九折品类券', coupon_price: '90.00', use_min_price: '10.00', coupon_type: 2, applicable_type: 1,
    start_time: null, end_time: null, availability: 'available', availability_message: '可使用', rule: '第一行\n<script>literal only</script>', rule_truncated: true, ...change });
  const counts = { not_used: 3, used: 1, expired: 2, reserved: 1 };
  const walletResponse = (config, list = [walletRow()], cursor, quantity = counts) => ({ ...response(config, { status: 200, data: list }),
    headers: { ...(cursor ? { 'x-coupon-next-cursor': cursor } : {}), ...(quantity === undefined ? {} : { 'x-coupon-counts': JSON.stringify(quantity) }) } });
  it('reads filtered wallet counts and literal rules through actual Axios, requesting counts only on refresh', async () => {
    const { apiMyCoupons } = await server.ssrLoadModule('/src/api/user.ts');
    const calls = [];
    api.defaults.adapter = async config => { calls.push(config); return walletResponse(config); };
    for (const filter of [null, -1, 0, 1, 2, 3]) {
      const page = await apiMyCoupons(0, undefined, filter);
      assert.deepEqual(calls.at(-1).params, { limit: 20, include_counts: 1, ...(filter !== null ? { type: filter } : {}) });
      assert.deepEqual(page.counts, counts); assert.equal(page.list[0].benefit, '9折');
      assert.equal(page.list[0].rule, '第一行\n<script>literal only</script>'); assert.equal(page.list[0].ruleTruncated, true);
    }
    await apiMyCoupons(3, 70, 0); assert.equal(calls.at(-1).url, '/coupons/user/3'); assert.deepEqual(calls.at(-1).params, { limit: 20, before: 70, type: 0 });
  });
  it('rejects invalid wallet inputs before I/O and malformed counts without inventing zero counts', async () => {
    const { apiMyCoupons } = await server.ssrLoadModule('/src/api/user.ts'); let calls = 0;
    api.defaults.adapter = async config => { calls++; return { ...response(config, { status: 200, data: [] }), headers: {} }; };
    for (const args of [[4], ['0'], [NaN], [0, 0], [0, -1], [0, 1.5], [0, undefined, 4], [0, undefined, '1']]) await assert.rejects(apiMyCoupons(...args));
    assert.equal(calls, 0); assert.equal((await apiMyCoupons()).counts, undefined);
    for (const header of ['oops', '{}', JSON.stringify({ ...counts, used: -1 }), 'x'.repeat(513), 3]) {
      api.defaults.adapter = async config => ({ ...response(config, { status: 200, data: [] }), headers: { 'x-coupon-counts': header } });
      await assert.rejects(apiMyCoupons());
    }
    authUtils.clearAuth(); const previous = calls; await assert.rejects(apiMyCoupons(), /请先登录/); assert.equal(calls, previous);
  });
  it('preserves wallet counts and exact cursor on append failure but closes details and blocks stale actions', async () => {
    const { createCouponWalletView } = await server.ssrLoadModule('/src/composables/couponWalletView.ts');
    const view = createCouponWalletView(url => navigation.push(url)); const cursors = []; let fail = true;
    api.defaults.adapter = async config => {
      cursors.push(config.params.before);
      if (config.params.before && fail) { fail = false; throw new Error('offline'); }
      return { ...response(config, { status: 200, data: [walletRow({ id: config.params.before ? 59 : 60 })] }),
        headers: config.params.before ? {} : { 'x-coupon-next-cursor': '60', 'x-coupon-counts': JSON.stringify(counts) } };
    };
    try {
      await view.load(); view.openDetail(60); assert.equal(view.detail.value.id, 60);
      await view.load(true); assert.equal(view.detail.value, null); assert.match(view.state.value.error, /offline/); assert.deepEqual(view.state.value.counts, counts);
      view.openDetail(60); view.browse(60); assert.equal(view.detail.value, null); assert.deepEqual(navigation, []);
      await view.load(true); assert.deepEqual(cursors, [undefined, 60, 60]); assert.deepEqual(view.state.value.list.map(c => c.id), [60, 59]); assert.deepEqual(view.state.value.counts, counts);
      view.browse(59); assert.deepEqual(navigation, ['/user/coupon/59/products']);
      view.openDetail(60); api.defaults.adapter = async () => { throw new Error('refresh failed'); }; await view.load();
      assert.equal(view.detail.value, null); assert.deepEqual(view.state.value.list, []); assert.equal(view.state.value.counts, undefined);
    } finally { view.dispose(); }
  });
  it('switches wallet filter and status with fresh counts, discarding late prior-filter success and failure', async () => {
    const { createCouponWalletView } = await server.ssrLoadModule('/src/composables/couponWalletView.ts');
    const view = createCouponWalletView(url => navigation.push(url));
    try {
      const old = delayed(), first = view.load(); await old.started;
      api.defaults.adapter = async config => { assert.equal(config.params.type, 3); assert.equal(config.params.before, undefined); return walletResponse(config, [walletRow({ id: 61, applicable_type: 3 })], undefined, { ...counts, not_used: 1 }); };
      await view.switchFilter(3); old.success({ status: 200, data: [walletRow()] }); await first;
      assert.deepEqual(view.state.value.list.map(c => c.id), [61]); assert.equal(view.state.value.counts.not_used, 1);
      view.openDetail(61); const pending = delayed(), refresh = view.load(); await pending.started;
      assert.equal(view.detail.value, null); assert.equal(view.state.value.counts, undefined);
      api.defaults.adapter = async config => { assert.equal(config.url, '/coupons/user/3'); assert.equal(config.params.type, 3); return walletResponse(config, [walletRow({ availability: 'reserved' })]); };
      await view.switchTab(3); pending.fail(new Error('old transport error')); await refresh;
      assert.equal(view.state.value.error, ''); assert.equal(view.state.value.list[0].availability, 'reserved');
    } finally { view.dispose(); }
  });
  it('removes wallet rows, counts and rules across identical-token session renewals and disposal', async () => {
    const { createCouponWalletView } = await server.ssrLoadModule('/src/composables/couponWalletView.ts');
    const view = createCouponWalletView(url => navigation.push(url));
    api.defaults.adapter = async config => walletResponse(config); await view.load(); view.openDetail(60);
    authUtils.clearAuth(); assert.equal(view.blocked.value, true); assert.equal(view.detail.value, null);
    authUtils.setAuth('session-a', 11); await view.load(); assert.equal(view.blocked.value, false); view.openDetail(60); assert.equal(view.detail.value.id, 60);
    authUtils.setAuth('session-a', 11); assert.deepEqual(view.state.value.list, []); assert.equal(view.state.value.counts, undefined); assert.equal(view.detail.value, null);
    const pending = delayed(), refresh = view.load(); await pending.started; view.dispose();
    pending.success({ status: 200, data: [walletRow()] }); await refresh;
    assert.deepEqual(view.state.value.list, []); assert.equal(view.detail.value, null); view.browse(60); assert.deepEqual(navigation, []);
    api.defaults.adapter = async () => { throw new Error('disposed view must not request'); }; await view.load();
  });
  it('shows rules for unavailable coupons without letting them navigate or silently changing invalid filters', async () => {
    const { createCouponWalletView } = await server.ssrLoadModule('/src/composables/couponWalletView.ts');
    const view = createCouponWalletView(url => navigation.push(url)); let calls = 0;
    api.defaults.adapter = async config => { calls++; return walletResponse(config, ['future', 'used', 'expired', 'invalid', 'reserved'].map((availability, i) => walletRow({ id: 60 - i, availability }))); };
    try {
      await view.load(); for (const coupon of view.state.value.list) { view.openDetail(coupon.id); assert.equal(view.detail.value.id, coupon.id); view.browse(coupon.id); }
      assert.deepEqual(navigation, []); const count = calls; await view.switchTab(4); await view.switchFilter(4); assert.equal(calls, count);
      view.closeDetail(); assert.equal(view.detail.value, null); view.openDetail(999); assert.equal(view.detail.value, null);
    } finally { view.dispose(); }
  });
  it("loads scope products through actual Axios and retries an empty scan at the same cursor", async () => {
    const { createCouponProductsView } = await server.ssrLoadModule("/src/composables/couponProductsView.ts");
    const view = createCouponProductsView(url => navigation.push(url));
    const calls = []; let fail = true;
    const product = { id: 70, store_name: "范围商品", image: "/image.svg", catalog_price: "10.00" };
    api.defaults.adapter = async config => {
      calls.push(config.params.cursor); assert.equal(config.url, "/coupons/user/42/products"); assert.equal(config.params.view, 'search'); assert.equal(config.params.before, undefined);
      if (config.params.cursor && fail) { fail = false; throw new Error("offline"); }
      return response(config, { status: 200, data: { coupon_id: 42, coupon_title: "范围券", scope_type: 2, scope_only: true,
        keyword: '', sort: 'recommended', scanned_count: config.params.cursor ? 1 : 500, scan_limit_reached: !config.params.cursor,
        list: config.params.cursor ? [product] : [], next_cursor: config.params.cursor ? null : 'cursor100' } });
    };
    try {
      await view.setCouponId("42"); assert.equal(view.state.value.nextCursor, 'cursor100'); assert.deepEqual(view.state.value.list, []);
      assert.equal(view.state.value.totalScanned, 500); assert.equal(view.state.value.scanLimitReached, true);
      await view.load(true); assert.match(view.error.value, /offline/); await view.load(true);
      assert.deepEqual(calls, [undefined, 'cursor100', 'cursor100']); assert.equal(view.state.value.totalScanned, 501); view.openProduct(999); view.openProduct(70); assert.deepEqual(navigation, ["/goods/70"]);
      await view.setRoute("goods-detail", "70"); assert.equal(calls.length, 3); assert.deepEqual(view.state.value.list, []);
    } finally { view.dispose(); }
  });
  it("clears the scope view on identity change and ignores pending old success after disposal", async () => {
    const { createCouponProductsView } = await server.ssrLoadModule("/src/composables/couponProductsView.ts");
    const view = createCouponProductsView(url => navigation.push(url)), pending = delayed();
    const result = view.setCouponId("42"); await pending.started; authUtils.setAuth("session-b", 22);
    assert.deepEqual(view.state.value.list, []); assert.match(view.error.value, /登录状态已变化/);
    view.dispose(); pending.success({ status: 200, data: { coupon_id: 42, coupon_title: "旧券", scope_type: 0, scope_only: true, list: [], next_cursor: null } });
    await result; assert.deepEqual(view.state.value.list, []); view.openProduct(70); assert.deepEqual(navigation, []);
  });
  it("does not send invalid scope IDs or turn a failed refresh into stale navigable goods", async () => {
    const { createCouponProductsView } = await server.ssrLoadModule("/src/composables/couponProductsView.ts");
    const view = createCouponProductsView(url => navigation.push(url)); let count = 0;
    api.defaults.adapter = async config => { count++; return response(config, { status: 400, msg: "范围配置冲突" }); };
    try {
      for (const id of [undefined, "0", "NaN", ["42", "43"]]) await view.setCouponId(id);
      assert.equal(count, 0); await view.setCouponId("42"); assert.match(view.error.value, /范围配置冲突/);
      view.openProduct(70); assert.deepEqual(navigation, []); assert.deepEqual(view.state.value.list, []);
    } finally { view.dispose(); }
  });
  it("removes persistent legacy credentials and atomically publishes the current identity", () => {
    assert.equal(localStorage.getItem("pc_token"), null);
    assert.equal(localStorage.getItem("pc_uid"), null);
    authUtils.setAuth("session-b", 22);
    assert.equal(sessionStorage.getItem("pc_token"), "session-b");
    assert.deepEqual([auth.token, auth.uid, auth.isLoggedIn], ["session-b", 22, true]);
    assert.equal(cart.items.length, 0);
    assert.equal(cart.count, 0);
  });
  const scopeEntry = (id = 222) => ({ id, name: '叶<script>literal</script>', ancestors: [{ id: 1, name: '根' }, { id: 2, name: null }], hierarchy_complete: false });
  const scopePage = (entries = [scopeEntry()], next_cursor = null, total_count = 1) => ({ coupon_id: 42, coupon_title: '范围券', scope_type: 1, scope_only: true, entries, next_cursor, total_count, scope_version: 'a'.repeat(64) });
  const catalog = { coupon_id: 42, coupon_title: '范围券', scope_type: 1, scope_only: true, list: [], next_cursor: 'cursor100', keyword: '', sort: 'recommended', scanned_count: 500, scan_limit_reached: true };
  const searchProduct = (id = 70) => ({ id, store_name: `商品${id}<script>literal</script>`, image: '/image.svg', catalog_price: '10.00' });
  const searchPage = (params = {}, changes = {}) => ({ ...catalog, keyword: params.keyword ?? '', sort: params.sort ?? 'recommended',
    list: [searchProduct()], next_cursor: null, scanned_count: 1, scan_limit_reached: false, ...changes });
  it('sends all seven server-side sorts and normalized keywords without sorting the returned page by ID', async () => {
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts'); const view = createCouponProductsView(() => {}), calls = [];
    api.defaults.adapter = async config => { calls.push(config.params); return response(config, { status: 200, data: searchPage(config.params, { list: [searchProduct(70), searchProduct(90)], scanned_count: 2 }) }); };
    try {
      await view.setCouponId('42'); view.keyword.value = '  中文%_\\  ';
      for (const option of view.sorts) {
        await view.applySearch(option.value); assert.equal(view.error.value, '');
        assert.deepEqual(calls.at(-1), { view: 'search', limit: 20, keyword: '中文%_\\', sort: option.value });
        assert.deepEqual(view.state.value.list.map(row => row.id), [70, 90]);
      }
      await view.clearSearch(); assert.equal(calls.at(-1).keyword, ''); assert.equal(view.filters.value.sort, 'sales_asc');
    } finally { view.dispose(); }
  });
  it('switches search during pending success or failure, clearing old cursors and scope metadata', async () => {
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts'); const view = createCouponProductsView(() => {});
    try {
      api.defaults.adapter = async config => response(config, { status: 200, data: config.params.view === 'scope' ? scopePage() : searchPage(config.params) });
      await view.setCouponId('42'); await view.loadScope(); assert.equal(view.scopeState.value.loaded, true);
      for (const outcome of ['success', 'failure']) {
        const late = delayed(); view.keyword.value = 'old'; const pending = view.applySearch(); await late.started;
        api.defaults.adapter = async config => { assert.equal(config.params.cursor, undefined); return response(config, { status: 200, data: searchPage(config.params, { list: [searchProduct(90)] }) }); };
        view.keyword.value = 'new'; await view.applySearch('price_asc'); assert.equal(view.scopeState.value.loaded, false);
        if (outcome === 'success') late.success({ status: 200, data: searchPage({ keyword: 'old', sort: 'price_asc' }) }); else late.fail(Error('stale offline'));
        await pending; assert.equal(view.state.value.keyword, 'new'); assert.equal(view.state.value.sort, 'price_asc'); assert.equal(view.error.value, '');
        assert.deepEqual(view.state.value.list.map(row => row.id), [90]);
      }
      authUtils.setAuth('session-a', 11); assert.deepEqual(view.filters.value, { keyword: '', sort: 'recommended' }); assert.equal(view.keyword.value, '');
    } finally { view.dispose(); }
  });
  it('retries the exact cursor with applied filters, not unsubmitted draft text, and refuses duplicate catalogue pages', async () => {
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts'); const view = createCouponProductsView(url => navigation.push(url)), calls = []; let fail = true, duplicate = false;
    api.defaults.adapter = async config => {
      calls.push(config.params);
      if (config.params.cursor && fail) { fail = false; throw Error('offline search'); }
      return response(config, { status: 200, data: searchPage(config.params, config.params.cursor
        ? { list: [searchProduct(duplicate ? 70 : 90)] } : { next_cursor: 'cursorA' }) });
    };
    try {
      await view.setCouponId('42'); view.keyword.value = '提交词'; await view.applySearch('price_desc'); view.keyword.value = '未提交词';
      await view.load(true); assert.match(view.error.value, /offline/); assert.equal(view.blocked.value, true);
      await view.load(true); assert.deepEqual(calls.at(-1), calls.at(-2)); assert.equal(calls.at(-1).keyword, '提交词');
      assert.deepEqual(view.state.value.list.map(row => row.id), [70, 90]);
      duplicate = true; await view.load(); await view.load(true); assert.match(view.error.value, /已变化/);
      assert.deepEqual(view.state.value.list.map(row => row.id), [70]); view.openProduct(70); assert.deepEqual(navigation, []);
    } finally { view.dispose(); }
  });
  it('validates search adapters before I/O and rejects wrong echoes, impossible scan counters and cursor cycles', async () => {
    const { apiCouponProductSearch } = await server.ssrLoadModule('/src/api/couponProducts.ts'); let calls = 0;
    api.defaults.adapter = async config => { calls++; return response(config, { status: 200, data: searchPage(config.params) }); };
    for (const options of [{ keyword: 'x'.repeat(101), sort: 'newest' }, { keyword: 'x\n', sort: 'newest' }, { keyword: '', sort: 'raw SQL' }]) await assert.rejects(apiCouponProductSearch(42, options));
    for (const cursor of [0, '', 'x'.repeat(513), '+/']) await assert.rejects(apiCouponProductSearch(42, { keyword: '', sort: 'recommended' }, cursor));
    assert.equal(calls, 0);
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts'); const view = createCouponProductsView(() => {}); let change = {};
    api.defaults.adapter = async config => response(config, { status: 200, data: searchPage(config.params, change) });
    try {
      await view.setCouponId('42');
      for (const bad of [{ keyword: 'wrong' }, { sort: 'newest' }, { scanned_count: 501 }, { scanned_count: 0 }, { scan_limit_reached: true }, { next_cursor: 100 }]) {
        change = bad; await view.load(); assert.ok(view.error.value); assert.deepEqual(view.state.value.list, []);
      }
      change = { list: [], scanned_count: 500, scan_limit_reached: true, next_cursor: 'cursorA' }; await view.load();
      change = { ...change, next_cursor: 'cursorB' }; await view.load(true);
      change = { ...change, next_cursor: 'cursorA' }; await view.load(true); assert.match(view.error.value, /游标已变化/);
      assert.equal(view.state.value.totalScanned, 1000);
      authUtils.clearAuth(); await assert.rejects(apiCouponProductSearch(42, { keyword: '', sort: 'recommended' }), /请先登录/);
    } finally { view.dispose(); }
  });
  it('loads complete scope configuration separately and retries exact configuration cursors, not product cursors', async () => {
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts');
    const view = createCouponProductsView(url => navigation.push(url)), calls = []; let fail = true;
    api.defaults.adapter = async config => {
      calls.push(config.params);
      if (config.params.view === 'search') return response(config, { status: 200, data: catalog });
      assert.equal(config.params.view, 'scope');
      if (config.params.before && fail) { fail = false; throw Error('scope offline'); }
      return response(config, { status: 200, data: config.params.before ? scopePage([scopeEntry(221)], null, 2) : scopePage([scopeEntry()], 222, 2) });
    };
    try {
      await view.setCouponId('42'); assert.equal(calls.length, 1); await view.loadScope();
      assert.equal(view.scopeState.value.entries[0].name, '叶<script>literal</script>'); assert.equal(view.scopeState.value.entries[0].ancestors[1].name, null);
      await view.loadScope(true); assert.match(view.scopeState.value.error, /offline/); assert.equal(view.scopeState.value.entries.length, 1); assert.equal(view.blocked.value, true);
      await view.loadScope(true); assert.deepEqual(calls.map(call => call.before), [undefined, undefined, 222, 222]);
      assert.equal(view.scopeState.value.entries.length, 2); assert.equal(view.state.value.nextCursor, 'cursor100'); assert.equal(view.scopeState.value.nextCursor, null);
      await view.loadScope(true); assert.equal(calls.length, 4); await view.load(); assert.equal(view.scopeState.value.loaded, false);
    } finally { view.dispose(); }
  });
  it('rejects malformed scope names, hierarchy, metadata and cursors rather than displaying unvalidated configuration', async () => {
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts'); const view = createCouponProductsView(() => {}); let data = scopePage();
    api.defaults.adapter = async config => response(config, { status: 200, data: config.params.view === 'scope' ? data : catalog });
    try {
      await view.setCouponId('42');
      for (const bad of [{ ...scopePage(), coupon_id: 99 }, { ...scopePage(), scope_type: 3 }, { ...scopePage(), scope_only: false },
        { ...scopePage(), total_count: -1 }, { ...scopePage(), total_count: '1' }, scopePage([], 222, 2), scopePage([scopeEntry()], 223, 2),
        scopePage([scopeEntry(), scopeEntry()], null, 2), scopePage([{ ...scopeEntry(), name: 'x'.repeat(1001) }]),
        scopePage([{ ...scopeEntry(), ancestors: [{ id: 222, name: 'self' }] }]), scopePage([{ ...scopeEntry(), hierarchy_complete: 'true' }])]) {
        data = bad; await view.loadScope(); assert.ok(view.scopeState.value.error); assert.deepEqual(view.scopeState.value.entries, []);
      }
    } finally { view.dispose(); }
  });
  it('clears scope metadata on renewal and route disposal, ignoring late successes and failures', async () => {
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts'); const view = createCouponProductsView(() => {});
    api.defaults.adapter = async config => response(config, { status: 200, data: catalog }); await view.setCouponId('42');
    const old = delayed(), loading = view.loadScope(); await old.started; authUtils.setAuth('session-a', 11);
    old.success({ status: 200, data: scopePage() }); await loading; assert.deepEqual(view.scopeState.value.entries, []);
    api.defaults.adapter = async config => response(config, { status: 200, data: catalog }); await view.load();
    const pending = delayed(), loading2 = view.loadScope(); await pending.started; await view.setRoute('goods-detail', '70');
    pending.fail(Error('old failure')); await loading2; assert.deepEqual(view.scopeState.value.entries, []); assert.equal(view.scopeState.value.error, '');
  });
  it('rejects invalid scope requests before I/O and invalidates pending metadata on product refresh', async () => {
    const { apiCouponScopeDescription } = await server.ssrLoadModule('/src/api/couponProducts.ts');
    api.defaults.adapter = async () => { throw Error('must not request'); };
    for (const args of [[0], [42, -1], [42, 1.5]]) await assert.rejects(apiCouponScopeDescription(...args), /标识/);
    authUtils.clearAuth(); await assert.rejects(apiCouponScopeDescription(42), /请先登录/); authUtils.setAuth('session-a', 11);
    const { createCouponProductsView } = await server.ssrLoadModule('/src/composables/couponProductsView.ts'); const view = createCouponProductsView(() => {});
    api.defaults.adapter = async config => response(config, { status: 200, data: catalog }); await view.setCouponId('42');
    const late = delayed(), pending = view.loadScope(); await late.started;
    api.defaults.adapter = async config => response(config, { status: 200, data: catalog }); await view.load();
    late.success({ status: 200, data: scopePage() }); await pending; assert.deepEqual(view.scopeState.value.entries, []); view.dispose();
  });
  it("clears all current client state and preserves the full checkout return URL on expiration", async () => {
    api.defaults.adapter = async (config) => {
      assert.equal(config.headers.get("Authori-zation"), "Bearer session-a");
      return response(config, { status: 410000, msg: "expired" });
    };
    await assert.rejects(api.get("/private"), /expired/);
    assert.equal(authUtils.getToken(), null);
    assert.deepEqual([auth.token, auth.uid, auth.isLoggedIn], ["", 0, false]);
    assert.equal(cart.items.length, 0);
    assert.equal(cart.count, 0);
    assert.equal(navigation.length, 1);
    assert.equal(new URL(navigation[0], location.origin).searchParams.get("redirect"), "/checkout?mode=buy&cartIds=2#details");
  });
  it("does not let a late old-token expiration log out the new session", async () => {
    const pending = delayed();
    const result = assert.rejects(api.get("/private"), /登录状态已变化/);
    await pending.started;
    authUtils.setAuth("session-b", 22);
    pending.success({ status: 410001, msg: "old expiry" });
    await result;
    assert.deepEqual([auth.token, auth.uid], ["session-b", 22]);
    assert.equal(navigation.length, 0);
  });
  it("isolates a renewed session even if the server reuses the same token string", async () => {
    const pending = delayed();
    const result = assert.rejects(api.get("/private"), /登录状态已变化/);
    await pending.started;
    authUtils.setAuth("session-a", 11);
    pending.success({ status: 410002, msg: "older generation" });
    await result;
    assert.equal(authUtils.getToken(), "session-a");
    assert.equal(navigation.length, 0);
  });
  it("rejects stale successful cart data and preserves the new user's loading state", async () => {
    const pending = delayed();
    const result = assert.rejects(cart.fetchList(), /登录状态已变化/);
    await pending.started;
    authUtils.setAuth("session-b", 22);
    cart.items = [{ id: 22, isValid: true }];
    cart.loading = true;
    pending.success({ status: 200, data: [{ id: 11, isValid: true }] });
    await result;
    assert.deepEqual(cart.items.map((item) => item.id), [22]);
    assert.equal(cart.loading, true);
  });
  it("does not overwrite the new cart count with an old-session badge response", async () => {
    const pending = delayed();
    const result = cart.fetchCount();
    await pending.started;
    authUtils.setAuth("session-b", 22);
    cart.count = 22;
    pending.success({ status: 200, data: { count: 99 } });
    await result;
    assert.equal(cart.count, 22);
  });
  it("does not clear or redirect a new login when the previous logout completes late", async () => {
    const pending = delayed();
    const result = auth.logout();
    await pending.started;
    authUtils.setAuth("session-b", 22);
    pending.success({ status: 200, data: null });
    assert.equal((await result).clearedCurrentSession, false);
    assert.deepEqual([auth.token, auth.uid], ["session-b", 22]);
    assert.equal(navigation.length, 0);
  });
  it("still clears the current local session if server logout cannot be confirmed", async () => {
    api.defaults.adapter = async () => { throw new Error("offline"); };
    assert.deepEqual(await auth.logout(), { serverRevoked: false, clearedCurrentSession: true });
    assert.deepEqual([auth.token, auth.uid], ["", 0]);
    assert.equal(cart.items.length, 0);
  });
  it("handles an expired business envelope on an HTTP error but never clears on a transport-only failure", async () => {
    api.defaults.adapter = async () => { throw new Error("timeout"); };
    await assert.rejects(api.get("/private"), /timeout/);
    assert.equal(auth.token, "session-a");
    api.defaults.adapter = async (config) => { throw new AxiosError("HTTP error", "ERR_BAD_RESPONSE", config, null, response(config, { status: 410001 }, 401)); };
    await assert.rejects(api.get("/private"), /HTTP error/);
    assert.equal(auth.token, "");
    assert.equal(navigation.length, 1);
  });
  it("does not nest login redirects or clear a new identity for an anonymous request", async () => {
    location.pathname = "/login";
    api.defaults.adapter = async (config) => response(config, { status: 410000, msg: "expired on login" });
    await assert.rejects(api.get("/private"), /expired on login/);
    assert.equal(auth.token, "");
    assert.equal(navigation.length, 0);
    const pending = delayed();
    const result = assert.rejects(api.get("/public"), /登录状态已变化/);
    const config = await pending.started;
    assert.equal(config.headers.get("Authori-zation"), undefined);
    authUtils.setAuth("session-b", 22);
    pending.success({ status: 410000, msg: "anonymous failure" });
    await result;
    assert.equal(auth.token, "session-b");
    assert.equal(navigation.length, 0);
  });
});
