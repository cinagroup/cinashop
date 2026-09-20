import { it } from 'node:test';
import assert from 'node:assert/strict';
const row = (id = 1, price = '17.59') => ({ id, productId: 70, cartNum: 2, type: 0, unique: 'red001', isNew: 0, isValid: true,
  productInfo: { price: '19.99', otPrice: '25.00', storeName: '本地商品', image: '', stock: 8, suk: '红色', systemFormId: 0, productType: 0 },
  sumPrice: '39.98', truePrice: price, trueSumPrice: ((Number(price.replace('.', '')) * 2) / 100).toFixed(2), priceType: price === '19.99' ? '' : 'level', levelName: price === '19.99' ? '' : '银卡' });
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
export function registerCartStateTests(context) {
  function fixture(override = () => undefined) {
    const { api, response, cart } = context(); const calls = []; cart.$reset();
    api.defaults.adapter = async config => { calls.push(config); const custom = await override(config);
      return response(config, custom ?? { status: 200, data: config.url === '/cart/list' ? [row(), { ...row(2), isValid: false, productInfo: null }] : null }); };
    return { cart, calls };
  }
  it('cart actual store uses membership totals and excludes invalid selected rows', async () => {
    const { cart, calls } = fixture(); await cart.fetchList(); cart.toggleAll(true);
    assert.deepEqual(cart.checkedItems.map(r => r.id), [1]); assert.equal(cart.totalPrice, '35.18'); assert.equal(cart.totalNum, 2);
    assert.deepEqual(calls[0].params, { scope: 'cart' });
    cart.toggleChecked(2, true); assert.equal(cart.items[1].checked, false);
  });
  it('cart loading and failure are not an empty successful list; retry preserves explicit selection', async () => {
    let fail = false; const { cart } = fixture(config => fail && config.url === '/cart/list' ? { status: 400, msg: 'offline' } : undefined);
    await cart.fetchList(); cart.toggleChecked(1, true); fail = true;
    const pending = cart.fetchList(); assert.deepEqual(cart.items, []); assert.equal(cart.totalPrice, '0.00');
    await assert.rejects(pending, /offline/); assert.equal(cart.ready, false); assert.match(cart.error, /offline/);
    fail = false; await cart.fetchList(); assert.equal(cart.totalPrice, '35.18');
  });
  for (const failed of [false, true]) it(`cart later read owns the view after an old ${failed ? 'failure' : 'success'}`, async () => {
    const wait = gate(); let reads = 0; const { cart } = fixture(config => config.url === '/cart/list' && ++reads === 1 ? wait.promise : undefined);
    const first = cart.fetchList().catch(() => {}); await cart.fetchList();
    wait.release(failed ? { status: 400, msg: 'old failed' } : { status: 200, data: [row(99)] }); await first;
    assert.equal(cart.items[0].id, 1); assert.equal(cart.ready, true); assert.equal(cart.error, '');
  });
  it('cart session renewal clears loaded quotes, counts and selections synchronously', async () => {
    const { authUtils } = context(), { cart } = fixture(); await cart.fetchList(); cart.toggleAll(true); cart.count = 9;
    authUtils.setAuth('session-a', 11); assert.deepEqual(cart.items, []); assert.deepEqual(cart.selection, []); assert.equal(cart.count, 0);
  });
  it('cart mutation serializes clicks, binds identity and refreshes before enabling checkout', async () => {
    const wait = gate(); const { cart, calls } = fixture(config => config.url === '/cart/num' ? wait.promise : undefined);
    await cart.fetchList(); cart.toggleAll(true); const first = cart.updateQuantity(1, 3); const second = cart.updateQuantity(1, 4);
    assert.equal(cart.updating, true); assert.equal(cart.ready, false); wait.release({ status: 200, data: null }); await Promise.all([first, second]);
    const writes = calls.filter(c => c.url === '/cart/num'); assert.equal(writes.length, 1); assert.equal(writes[0].headers.get('Authori-zation'), 'Bearer session-a');
    assert.deepEqual(JSON.parse(writes[0].data), { id: 1, cartNum: 3 }); assert.equal(cart.ready, true); assert.equal(cart.updating, false);
  });
  for (const ending of ['hide', 'account']) it(`cart late mutation cannot refresh after ${ending}`, async () => {
    const wait = gate(); const { cart, calls } = fixture(config => config.url === '/cart/num' ? wait.promise : undefined);
    await cart.fetchList(); const pending = cart.updateQuantity(1, 3);
    if (ending === 'hide') cart.cancelPending(); else context().authUtils.setAuth('new', 22);
    const count = calls.length; wait.release({ status: 200, data: null }); await pending;
    assert.equal(calls.length, count); assert.equal(cart.ready, false); assert.equal(cart.updating, false);
  });
  it('cart refuses invalid quantities and detached row IDs without network writes', async () => {
    const { cart, calls } = fixture(); await cart.fetchList();
    for (const [id, quantity] of [[1, 0], [1, 9], [1, 1.5], [2, 1], [99, 1]]) await cart.updateQuantity(id, quantity);
    await cart.removeItem(99); assert.equal(calls.length, 1);
  });
  it('cart uncertain mutation exposes a read-only retry without replaying its write', async () => {
    const { cart, calls } = fixture(config => config.url === '/cart/num' ? { status: 400, msg: 'uncertain' } : undefined);
    await cart.fetchList(); await cart.updateQuantity(1, 3); assert.match(cart.error, /uncertain/); assert.equal(cart.ready, false);
    await cart.fetchList(); assert.equal(calls.filter(c => c.url === '/cart/num').length, 1); assert.equal(cart.ready, true);
  });
}
