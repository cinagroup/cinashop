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
