const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { runtime } = require('./user-center-runtime.cjs');
const root = path.resolve(__dirname, '..'), clone = value => structuredClone(value);
function fixture(component = 'pages/customer-work/cashierRecords.vue') {
  const r = runtime({ component, send: () => ({ data: {} }) });
  const guards = r.load(path.join(root, 'src/utils/customerWorkOrdinaryCashierRead.ts'));
  return { r, guards, stop() { r.stop(); } };
}
test('ordinary catalog preserves all SKU choices and rejects foreign product types or duplicate identities', () => {
  const f = fixture(); try {
    const detail = { product: { id: 70, store_name: '实物商品', image: '', product_type: 0, system_form_id: 0 }, system_form: null,
      readiness: { writes: true, reason: 'ready' }, skus: [{ sku_unique: 'sku-a', sku: '红色', image: '', price: '10.00', stock: 2 },
        { sku_unique: 'sku-b', sku: '蓝色', image: '', price: '12.00', stock: 3 }] };
    assert.equal(f.guards.isOrdinaryCatalogSelection(detail), true);
    for (const mutate of [v => { v.product.product_type = 4; }, v => { v.skus[1].sku_unique = 'sku-a'; },
      v => { v.skus[0].price = 10; }, v => { v.skus[0].stock = '2'; }, v => { v.skus[0].stock = 32768; }]) {
      const bad = clone(detail); mutate(bad); assert.equal(f.guards.isOrdinaryCatalogSelection(bad), false);
    }
    const list = { list: [{ ...detail.product, sku_count: 2 }], page: 1, limit: 20, has_more: false, readiness: detail.readiness };
    assert.equal(f.guards.isOrdinaryCatalogList(list), true);
    assert.equal(f.guards.isOrdinaryCatalogList({ ...list, list: [list.list[0], list.list[0]] }), false);
  } finally { f.stop(); }
});
test('buyer and address selections require real positive members and bounded complete address rows', () => {
  const f = fixture(); try {
    const users = { list: [{ uid: 42, nickname: '会员', phone: '12345678', integral: 100, now_money: '50.00' }], page: 1, limit: 20, has_more: false };
    assert.equal(f.guards.isOrdinaryBuyerList(users), true);
    const guest = clone(users); guest.list[0].uid = 0; assert.equal(f.guards.isOrdinaryBuyerList(guest), false);
    const leaked = clone(users); leaked.list[0].pwd = 'not permitted'; assert.equal(f.guards.isOrdinaryBuyerList(leaked), false);
    const address = { buyer_uid: 42, list: [{ id: 5, real_name: '收件人', phone: '12345678', province: '省', city: '市', district: '区', street: '', detail: '完整收货地址', city_id: 3, is_default: true }] };
    assert.equal(f.guards.isOrdinaryAddressList(address), true);
    assert.equal(f.guards.isOrdinaryAddressList({ ...address, buyer_uid: 0 }), false);
    assert.equal(f.guards.isOrdinaryAddressList({ ...address, list: [address.list[0], address.list[0]] }), false);
  } finally { f.stop(); }
});
test('coupon pagination preserves a cursor after an empty scanned page and rejects raw private extras', () => {
  const f = fixture(); try {
    assert.equal(f.guards.isOrdinaryCouponPage({ list: [], next_cursor: 90 }), true);
    const coupon = { id: 10, cid: 11, title: '实际优惠券', discount_type: 1, scope_type: 0, coupon_price: '2.00', use_min_price: '10.00',
      start_time: null, end_time: null, availability: 'available', availability_message: '', rule: '{}', rule_truncated: false, estimated_discount: '2.00', eligible_subtotal: '30.00' };
    assert.equal(f.guards.isOrdinaryCouponPage({ list: [coupon], next_cursor: null }), true);
    for (const changed of [{ uid: 42 }, { discount_type: '1' }, { rule: 'x'.repeat(8001) }, { estimated_discount: -2 }]) {
      assert.equal(f.guards.isOrdinaryCouponPage({ list: [{ ...coupon, ...changed }], next_cursor: null }), false);
    }
    assert.equal(f.guards.isOrdinaryCouponPage({ list: [coupon, coupon], next_cursor: null }), false);
  } finally { f.stop(); }
});
test('pricing distinguishes product and promotion rewards and rejects inconsistent totals or non-CNY financial values', () => {
  const f = fixture(); try {
    const p = { currency: 'CNY', amount: '30.00', total: '30.00', raw_total: '30.00', quantity: 3, postage: '0.00', raw_postage: '0.00',
      coupon_discount: '0.00', integral_discount: '0.00', first_order_discount: '0.00', membership_discount: '0.00', promotion_discount: '0.00',
      used_integral: 0, remaining_integral: 0, integral_policy: { enabled: true, ratio: 100 }, gives_integral: 7, product_gives_integral: 2, promotion_gives_integral: 5 };
    assert.equal(f.guards.isOrdinaryPricing(p), true);
    for (const changed of [{ currency: 'USD' }, { gives_integral: 5 }, { amount: '30' }, { used_integral: '0' }, { remaining_integral: -1 }]) {
      assert.equal(f.guards.isOrdinaryPricing({ ...p, ...changed }), false);
    }
  } finally { f.stop(); }
});
test('promotion gifts preserve separate stock, coupon and integral facts without duplicate opaque cart identities', () => {
  const f = fixture(); try {
    const gifts = { integral: 5, coupons: [{ issue_id: 20, title: '赠券', price: '2.00', min_price: '10.00' }],
      products: [{ cart_id: 'gift-real-90', product_id: 90, sku_unique: 'gift-sku', quantity: 2, promotion_id: 2 }],
      promotions: [{ id: 2, tier_id: 3, name: '实际活动', threshold: '20.00', threshold_type: 1, repetitions: 1 }] };
    assert.equal(f.guards.isOrdinaryPromotionGifts(gifts), true);
    assert.equal(f.guards.isOrdinaryPromotionGifts({ ...gifts, products: [gifts.products[0], gifts.products[0]] }), false);
    const bad = clone(gifts); bad.coupons[0].issue_id = 0; assert.equal(f.guards.isOrdinaryPromotionGifts(bad), false);
  } finally { f.stop(); }
});
test('actual quote page uses the reported amount or quantity threshold and refuses missing or foreign units', async () => {
  const f = fixture('pages/customer-work/ordinaryCashier.vue'); try {
    const promotions = [
      { id: 2, tier_id: 3, name: '金额活动', threshold: '20.00', threshold_type: 1, repetitions: 2 },
      { id: 4, tier_id: 5, name: '件数活动', threshold: '3.00', threshold_type: 2, repetitions: 1 },
    ];
    const gifts = { integral: 0, coupons: [], products: [], promotions };
    assert.equal(f.guards.isOrdinaryPromotionGifts(gifts), true);
    for (const value of [undefined, null, '1', 0, 3]) {
      const bad = clone(gifts);
      if (value === undefined) delete bad.promotions[0].threshold_type;
      else bad.promotions[0].threshold_type = value;
      assert.equal(f.guards.isOrdinaryPromotionGifts(bad), false);
    }
    const quote = { request_key: '11111111-1111-4111-8111-111111111111', request_hash: 'a'.repeat(64),
      draft_key: '22222222-2222-4222-8222-222222222222', draft_hash: 'b'.repeat(64), quote_token: 'c'.repeat(32),
      quote_fingerprint: 'd'.repeat(64), expires_at: 1_800_000_000,
      pricing: { currency: 'CNY', amount: '45.00', total: '45.00', raw_total: '45.00', quantity: 3,
        postage: '0.00', raw_postage: '0.00', coupon_discount: '0.00', integral_discount: '0.00',
        first_order_discount: '0.00', membership_discount: '0.00', promotion_discount: '0.00',
        used_integral: 0, remaining_integral: 0, integral_policy: { enabled: false, ratio: 0 },
        gives_integral: 0, product_gives_integral: 0, promotion_gives_integral: 0 },
      items: [{ cart_id: 11, raw_unit_price: '15.00', unit_price: '15.00', total_price: '45.00', discount: '0.00', price_type: 'normal' }],
      system_form: null, coupons: { list: [], next_cursor: null }, promotion_gifts: gifts };
    assert.equal(f.guards.isOrdinaryQuoteData(quote), true);
    f.r.page.manager.context.value = { actor_uid: 11, principal: { kind: 'customer-order-manager', service_id: 1, scope: 'global' },
      scope_key: 'e'.repeat(64), consistency_key: 'f'.repeat(64), data: {
        profile: { uid: 11, nickname: '经营账号', phone: '12345678', avatar: '' },
        capabilities: { cashier_ordinary: false }, cashier_ordinary_readiness: { writes: false, reason: 'closed' } } };
    // Only the accepted read presentation is exercised; no order or payment is submitted.
    f.r.page.operations.quotation.value = { quote: { read: { data: quote } } };
    const { render } = require('./user-center-runtime.cjs');
    for (const file of ['components/ThemePage.vue', 'components/customerWork/CustomerWorkShell.vue']) await render(f.r, file);
    const vue = require('vue'), pinia = require('pinia'), sfc = require('@vue/compiler-sfc'), dom = require('@vue/compiler-dom'), fs = require('node:fs');
    const file = path.join(root, 'src/pages/customer-work/ordinaryCashier.vue');
    const descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
    const bindings = sfc.compileScript(descriptor, { id: 'actual-threshold-presentation' }).bindings;
    const renderFn = new Function('Vue', dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true,
      bindingMetadata: bindings, isCustomElement: tag => ['view', 'text', 'image', 'scroll-view', 'picker'].includes(tag) }).code)(vue);
    const app = vue.createSSRApp({ render: renderFn, setup: () => f.r.page }); app.use(pinia.getActivePinia());
    const html = await require('@vue/server-renderer').renderToString(app);
    assert.ok(html.includes('活动：金额活动 · 门槛 ¥20.00 · 本次 2 次'));
    assert.ok(html.includes('活动：件数活动 · 门槛 3.00 件 · 本次 1 次'));
    assert.equal(html.includes('门槛 ¥3.00'), false);
    const invalidQuote = clone(quote); invalidQuote.promotion_gifts.promotions[1].threshold_type = 3;
    assert.equal(f.guards.isOrdinaryQuoteData(invalidQuote), false);
    f.r.page.operations.quotation.value = { quote: { read: { data: invalidQuote } } };
    assert.equal(f.r.page.quote.value, null);
    assert.equal(f.r.calls.length, 0);
  } finally { f.stop(); }
});
