import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createPinia } from "pinia";
import { AxiosError } from "axios";

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
      calls.push(config.params.before); assert.equal(config.url, "/coupons/user/42/products");
      if (config.params.before && fail) { fail = false; throw new Error("offline"); }
      return response(config, { status: 200, data: { coupon_id: 42, coupon_title: "范围券", scope_type: 2, scope_only: true,
        list: config.params.before ? [product] : [], next_cursor: config.params.before ? null : 100 } });
    };
    try {
      await view.setCouponId("42"); assert.equal(view.state.value.nextCursor, 100); assert.deepEqual(view.state.value.list, []);
      await view.load(true); assert.match(view.error.value, /offline/); await view.load(true);
      assert.deepEqual(calls, [undefined, 100, 100]); view.openProduct(999); view.openProduct(70); assert.deepEqual(navigation, ["/goods/70"]);
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
