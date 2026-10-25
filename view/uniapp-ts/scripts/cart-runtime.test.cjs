const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const row = (id = 1, price = '17.59') => ({ id, productId: 70, cartNum: 2, type: 0, unique: 'red001', isNew: 0, isValid: true,
  productInfo: { price: '19.99', otPrice: '25.00', storeName: '本地商品', image: '', stock: 8, suk: '红色', systemFormId: 0, productType: 0 },
  sumPrice: '39.98', truePrice: price, trueSumPrice: ((Number(price.replace('.', '')) * 2) / 100).toFixed(2), priceType: price === '19.99' ? '' : 'level', levelName: price === '19.99' ? '' : '银卡' });
function setup(override = () => undefined) {
  let cartRows=[];
  return runtime({ component: 'pages/cart/index.vue', send: async call => {
    const overridden=override(call);
    if(overridden!==undefined){const result=await overridden;if(call.url.endsWith('/cart/list')&&Array.isArray(result?.data))cartRows=result.data;return result;}
    if(call.url.endsWith('/cart/list')){cartRows=[row(),{...row(2),isValid:false,productInfo:null}];return {data:cartRows};}
    if(call.url.endsWith('/cart/compute')){
      const ids=call.data.cartId.split(',').map(Number),selected=ids.map(id=>cartRows.find(item=>item.id===id));
      const cents=value=>Number(String(value).replace('.',''));
      const raw=selected.reduce((sum,item)=>sum+cents(item.sumPrice),0),pay=selected.reduce((sum,item)=>sum+cents(item.trueSumPrice),0);
      const promotions=selected.reduce((sum,item)=>sum+(item.promotion?.promotionSavingsCents??0),0);
      return {data:{promotions:[],coupon:[],deduction:{product_type:0,type:0,activity_id:0,sum_price:raw/100,vip_price:(raw-pay-promotions)/100,
        promotions_price:promotions/100,coupon_price:0,first_order_price:0,pay_price:pay/100},svip_status:false,svip_price:0,
        budget:{requiresCouponClaim:false,couponIssueId:0,couponUserId:0,gifts:[],requiredIntegral:0,hypotheticalPaidMemberPayPrice:null,
          selection:selected.map(item=>({id:item.id,productId:item.productId,cartNum:item.cartNum,unique:item.unique,type:item.type,activityId:item.activityId??0})),
          excludes:['shipping','integral','payment'],needsCheckoutRequote:true}}};
    }
    return {data:null};
  } });
}
const promotion = (id = 1) => ({ key: id, productId: 70, quantity: 3, unitPriceCents: null, totalPriceCents: 2900,
  promotionSavingsCents: 100, segments: [
    { quantity: 1, unitPriceCents: 900, totalPriceCents: 900, promotionIds: [41] },
    { quantity: 2, unitPriceCents: 1000, totalPriceCents: 2000, promotionIds: [] },
  ] });
const promotionRow = () => ({ ...row(), cartNum: 3, productInfo: { ...row().productInfo, price: '10.00' },
  sumPrice: '30.00', truePrice: '9.66', trueSumPrice: '29.00', priceType: 'promotions', promotion: promotion() });
test('actual mobile cart selects only valid rows and uses membership totals', async () => {
  const r = setup(); try { await r.start(); const p = r.checkout; p.toggleAll();
    assert.equal(p.cartStore.totalPrice, '35.18'); assert.equal(p.allChecked.value, true);
    p.toggle(2); assert.equal(p.cartStore.items[1].checked, false); await tick(); assert.equal(p.budgetReady.value,true); await p.goCheckout();
    assert.deepEqual(r.navigations, ['/pages/order/confirm']);
    r.hooks.onHide(); assert.deepEqual(p.cartStore.checkedItems.map(row => row.id), [1]);
    assert.equal(p.blocked.value, true); p.goCheckout(); assert.equal(r.navigations.length, 1);
  } finally { r.stop(); }
});
test('partial activity cap displays the exact line total and priced segments, never floor unit times quantity', async () => {
  const r = setup(call => call.url.endsWith('/cart/list') ? { data: [promotionRow()] } : undefined);
  try {
    await r.start(); const p = r.checkout, line = p.cartStore.items[0]; p.toggleAll();
    const pricing = r.load(path.join(path.resolve(__dirname, '..'), '../common/cartPrice.ts'));
    assert.equal(p.cartStore.totalPrice, '29.00');
    assert.equal(pricing.cartUnitPrice(line), '9.66');
    assert.equal(pricing.cartLinePrice(line), '29.00');
    assert.match(pricing.cartPriceLabel(line), /分段计价/);
    assert.equal(pricing.cartPromotionSummary(line), '活动 1 件 ¥9.00，其余 2 件 ¥20.00');
  } finally { r.stop(); }
});
test('cart rejects a fabricated activity total instead of multiplying the display unit', async () => {
  const bad = promotionRow(); bad.promotion.totalPriceCents = 2899;
  const r = setup(call => call.url.endsWith('/cart/list') ? { data: [bad] } : undefined);
  try { await r.start(); assert.equal(r.checkout.cartStore.ready, false); assert.match(r.checkout.cartStore.error, /活动报价/); }
  finally { r.stop(); }
});
test('mobile initial failure is explicit and retry reads without automatically selecting or writing', async () => {
  let fail = true; const r = setup(call => call.url.endsWith('/cart/list') && fail ? { transport: 'offline' } : undefined);
  try { await r.start(); const p = r.checkout; assert.match(p.cartStore.error, /offline/); assert.equal(p.cartStore.ready, false);
    p.goCheckout(); assert.deepEqual(r.navigations, []); fail = false; await p.reload();
    assert.equal(p.cartStore.ready, true); assert.deepEqual(p.cartStore.checkedItems, []);
    assert.equal(r.calls.filter(call => call.url.endsWith('/cart/list')).length, 2);
    assert.deepEqual(r.calls.filter(call => call.url.endsWith('/cart/count')).map(call => call.data), [{ scope: 'cart' }]);
    assert.equal(r.calls.filter(call => /\/(?:cart\/(?:add|num|del)|collect\/add)$/.test(call.url)).length, 0);
  } finally { r.stop(); }
});
test('mobile account replacement clears old rows and requests only after final token publication', async () => {
  const tokens = [], gate = deferred(); let slow = false;
  const r = setup(call => { if (call.url.endsWith('/cart/list')) { tokens.push(call.header['Authori-zation']); return slow ? gate.promise : undefined; } });
  try { await r.start(); const p = r.checkout; p.toggleAll(); slow = true; r.auth.setLogin('new-user', 22);
    assert.deepEqual(p.cartStore.items, []); assert.deepEqual(p.cartStore.selection, []); await tick(); assert.equal(tokens.at(-1), 'Bearer new-user');
    gate.resolve({ data: [row(3, '19.99')] }); await tick(); assert.equal(p.cartStore.items[0].id, 3); assert.deepEqual(p.cartStore.checkedItems, []);
  } finally { gate.resolve({ data: [] }); r.stop(); }
});
test('mobile stale prior-account failure cannot erase a newer successful list', async () => {
  const gate = deferred(); let slow = true;
  const r = setup(call => call.url.endsWith('/cart/list') && slow ? gate.promise : undefined);
  try { await r.start(); slow = false; r.auth.setLogin('second-user', 22); await tick();
    gate.resolve({ transport: 'old failure' }); await tick(); assert.equal(r.checkout.cartStore.ready, true); assert.equal(r.checkout.cartStore.items[0].id, 1); assert.equal(r.checkout.cartStore.error, '');
  } finally { gate.resolve({ data: [] }); r.stop(); }
});
for (const hook of ['onHide', 'onUnload']) test(`mobile pending quantity mutation is ignored after ${hook}`, async () => {
  const gate = deferred(); const r = setup(call => call.url.endsWith('/cart/num') ? gate.promise : undefined);
  try { await r.start(); const p = r.checkout, item = p.cartStore.items[0]; const first = p.changeNum(item, 1); await tick();
    r.hooks[hook](); const calls = r.calls.length; gate.resolve({ data: null }); await first;
    assert.equal(r.calls.length, calls); assert.equal(p.cartStore.ready, false); await p.changeNum(item, 1); assert.equal(r.calls.length, calls); assert.deepEqual(r.toasts, []);
  } finally { gate.resolve({ data: null }); r.stop(); }
});
test('mobile logout immediately removes rows, selection and badge without an unauthenticated cart read', async () => {
  const r = setup(); try { await r.start(); r.checkout.toggleAll(); r.checkout.cartStore.count = 9; const count = r.calls.filter(call => call.url.includes('/cart/')).length;
    r.auth.clear(); assert.deepEqual(r.checkout.cartStore.items, []); assert.equal(r.checkout.cartStore.count, 0); await tick();
    assert.equal(r.calls.filter(call => call.url.includes('/cart/')).length, count); assert.match(r.checkout.cartStore.error, /登录/); assert.equal(r.checkout.blocked.value, true);
  } finally { r.stop(); }
});
test('mobile hidden read cannot replace the refreshed page and returns with a fresh quote', async () => {
  const gate = deferred(); let slow = false;
  const r = setup(call => call.url.endsWith('/cart/list') && slow ? gate.promise : undefined);
  try { await r.start(); slow = true; const first = r.checkout.reload(); r.hooks.onHide(); slow = false; r.hooks.onShow(); await tick();
    gate.resolve({ data: [row(99)] }); await first; assert.equal(r.checkout.cartStore.items[0].id, 1); assert.equal(r.checkout.blocked.value, false);
  } finally { gate.resolve({ data: [] }); r.stop(); }
});

function managementSetup(override = () => undefined, initial = [row(), row(3), { ...row(2), isValid: false, productInfo: null }]) {
  let rows = structuredClone(initial);
  const r = setup(call => {
    const result = override(call, () => rows, value => { rows = value; });
    if (result !== undefined) return result;
    if (call.url.endsWith('/cart/list')) return { data: structuredClone(rows) };
    if (call.url.endsWith('/cart/count')) return { data: { count: rows.length } };
    if (call.url.endsWith('/cart/del')) { rows = rows.filter(item => !call.data.ids.includes(item.id)); return { data: null }; }
    if (call.url.endsWith('/collect/add')) return { data: { count: call.data.id.length } };
  });
  return r;
}
const writes = r => r.calls.filter(call => /\/(?:cart\/del|collect\/add)$/.test(call.url));
test('management selection includes invalid rows, stays independent of checkout and never opens checkout', async () => {
  const r = managementSetup(); try {
    await r.start(); const p = r.checkout; p.toggle(1); await tick(); assert.equal(p.budgetReady.value, true);
    const compute = r.calls.filter(call => call.url.endsWith('/cart/compute')).length;
    p.toggleManagement(); assert.equal(p.managing.value, true); assert.deepEqual(p.managementSelection.value, []); assert.equal(p.budgetReady.value, false);
    p.toggleAll(); assert.deepEqual(p.managementSelection.value, [1, 3, 2]); assert.deepEqual(p.cartStore.selection, [1]); assert.equal(p.allChecked.value, true);
    assert.equal(p.canCollectSelection.value, false); await p.goCheckout(); await tick(); assert.deepEqual(r.navigations, []);
    assert.equal(r.calls.filter(call => call.url.endsWith('/cart/compute')).length, compute);
    p.toggleManagement(); await tick(); assert.deepEqual(p.cartStore.selection, [1]); assert.deepEqual(p.managementSelection.value, []); assert.equal(p.budgetReady.value, true);
  } finally { r.stop(); }
});
test('one batch delete sends exact ordinary cart IDs once and reconciles list, badge, selection and budget', async () => {
  const r = managementSetup(); try {
    await r.start(); const p = r.checkout; p.toggle(1); await tick(); p.toggleManagement(); p.toggle(1); p.toggle(3);
    await p.removeRows(p.managementSelection.value); await tick();
    assert.deepEqual(writes(r).map(call => call.data), [{ ids: [1, 3], scope: 'cart' }]);
    assert.deepEqual(p.cartStore.items.map(item => item.id), [2]); assert.equal(p.cartStore.count, 1); assert.deepEqual(p.managementSelection.value, []);
    assert.deepEqual(p.cartStore.selection, []); assert.equal(p.budgetReady.value, false); assert.equal(p.managementMessage.value, '已删除所选商品');
    assert.deepEqual(r.calls.slice(-2).map(call => [call.url.split('/').at(-1), call.data]), [['list', {scope:'cart'}], ['count', {scope:'cart'}]]);
  } finally { r.stop(); }
});
test('invalid clear deletes only the invalid group with null productInfo and reaches original true empty state', async () => {
  const r = managementSetup(undefined, [{ ...row(2), isValid: false, productInfo: null }]); try {
    await r.start(); const p = r.checkout; assert.equal(p.invalidItems.value.length, 1); await p.clearInvalid();
    assert.deepEqual(writes(r).map(call => call.data), [{ids:[2],scope:'cart'}]); assert.deepEqual(p.cartStore.items, []); assert.equal(p.cartStore.ready, true); assert.equal(p.cartStore.count, 0);
    assert.equal(p.managing.value, false); assert.deepEqual(r.navigations, []);
  } finally { r.stop(); }
});
test('per-row removal keeps another checkout selection and uses one scoped call', async () => {
  const r = managementSetup(); try { await r.start(); const p = r.checkout; p.toggle(3); await tick(); await p.removeRows([1]); await tick();
    assert.deepEqual(p.cartStore.selection, [3]); assert.deepEqual(writes(r).map(call => call.data), [{ids:[1],scope:'cart'}]); assert.equal(p.budgetReady.value,true);
  } finally { r.stop(); }
});
test('bulk collection uses deduplicated PRODUCT IDs and canonical receipt without deleting or quoting', async () => {
  const r = managementSetup(); try {
    await r.start(); const p = r.checkout; p.toggleManagement(); p.toggle(1); p.toggle(3); await p.collectRows(p.managementSelection.value);
    assert.deepEqual(writes(r).map(call => call.data), [{id:[70],category:'product'}]); assert.equal(p.managementMessage.value, '收藏成功');
    assert.deepEqual(p.managementSelection.value, [1,3]); assert.equal(p.cartStore.items.length,3); assert.equal(p.cartStore.ready,true); assert.deepEqual(p.cartStore.selection,[]);
  } finally { r.stop(); }
});
test('single collection is idempotent and rejects invalid rows, forged IDs and malformed receipts', async () => {
  let count = 0; const r = managementSetup(call => call.url.endsWith('/collect/add') ? { data: { count } } : undefined); try {
    await r.start(); const p = r.checkout; await p.collectRows([1]); assert.equal(p.managementMessage.value,'所选商品已收藏');
    await p.collectRows([2]); await p.collectRows([999]); await p.collectRows([1,1]); assert.equal(writes(r).length,1);
    count = 2; await p.collectRows([1]); assert.equal(p.managementMessage.value,'收藏结果未确认，请到我的收藏查看'); assert.equal(writes(r).length,2);
    assert.equal(p.collecting.value,false); assert.deepEqual(r.toasts,[]);
  } finally { r.stop(); }
});
test('double click cannot duplicate a pending collection or submit a cart deletion', async () => {
  const gate = deferred(); const r = managementSetup(call => call.url.endsWith('/collect/add') ? gate.promise : undefined); try {
    await r.start(); const p = r.checkout; const first=p.collectRows([1]); await tick(); await p.collectRows([1]); await p.removeRows([1]); p.toggleManagement();
    assert.equal(writes(r).length,1); assert.equal(p.blocked.value,true); assert.equal(p.managing.value,false);
    gate.resolve({data:{count:1}}); await first; assert.equal(p.collecting.value,false);
  } finally { gate.resolve({data:{count:1}}); r.stop(); }
});
test('a lost delete reply is never replayed and explicit read reconciles the committed cart', async () => {
  const r = managementSetup((call,get,set) => {
    if (call.url.endsWith('/cart/del')) { set(get().filter(item=>!call.data.ids.includes(item.id))); return {transport:'删除结果未确认'}; }
  }); try {
    await r.start(); const p = r.checkout; await p.removeRows([1]); assert.equal(p.cartStore.ready,false); assert.match(p.cartStore.error,/删除结果未确认/);
    await p.removeRows([1]); assert.equal(writes(r).length,1); await p.reload(); assert.deepEqual(p.cartStore.items.map(item=>item.id),[3,2]); assert.equal(writes(r).length,1);
  } finally { r.stop(); }
});
for (const hook of ['onHide','onUnload']) for (const kind of ['delete','collect']) test(`late ${kind} reply is ignored after ${hook}`, async () => {
  const gate=deferred(), endpoint=kind==='delete'?'/cart/del':'/collect/add';
  const r=managementSetup(call=>call.url.endsWith(endpoint)?gate.promise:undefined); try {
    await r.start(); const p=r.checkout; p.toggleManagement(); p.toggle(1);
    const first=kind==='delete'?p.removeRows([1]):p.collectRows([1]); await tick(); r.hooks[hook](); const count=r.calls.length;
    gate.resolve({data:kind==='delete'?null:{count:1}}); await first; assert.equal(r.calls.length,count); assert.equal(p.managementMessage.value,''); assert.equal(p.managing.value,false);
    assert.deepEqual(r.navigations,[]); assert.deepEqual(r.toasts,[]);
  } finally { gate.resolve({data:null}); r.stop(); }
});
for (const kind of ['delete','collect']) test(`prior account ${kind} result cannot replace the new account's cart or status`, async () => {
  const gate=deferred(), endpoint=kind==='delete'?'/cart/del':'/collect/add';
  const r=managementSetup(call=>call.url.endsWith(endpoint)?gate.promise:undefined); try {
    await r.start(); const p=r.checkout; p.toggleManagement(); p.toggle(1);
    const first=kind==='delete'?p.removeRows([1]):p.collectRows([1]); await tick(); r.auth.setLogin('new-account',22); await tick();
    gate.resolve({data:kind==='delete'?null:{count:1}}); await first; assert.equal(p.cartStore.ready,true); assert.equal(p.cartStore.items.length,3);
    assert.equal(p.managementMessage.value,''); assert.deepEqual(p.managementSelection.value,[]); assert.equal(p.managing.value,false); assert.equal(p.collecting.value,false);
  } finally { gate.resolve({data:null}); r.stop(); }
});
test('bounded batches and nonmember IDs never produce partial or sequential writes', async () => {
  const many=Array.from({length:201},(_,i)=>({...row(i+1),productId:i+100})); const r=managementSetup(undefined,many); try {
    await r.start(); const p=r.checkout; p.toggleManagement(); p.toggleAll(); await p.removeRows(p.managementSelection.value); assert.match(p.managementMessage.value,/200/);
    await p.collectRows(p.managementSelection.value); assert.match(p.managementMessage.value,/100/);
    assert.equal(await p.cartStore.removeItems([1,999]),false); assert.equal(await p.cartStore.removeItems([1,1]),false); assert.deepEqual(writes(r),[]);
  } finally { r.stop(); }
});

test('a prior delete count cannot overwrite the badge during a newer delete, then the newer count wins', async () => {
  const oldCount = deferred(), newCount = deferred(), secondDelete = deferred();
  let countRequests = 0, deleteRequests = 0;
  const r = managementSetup((call, get, set) => {
    if (call.url.endsWith('/cart/count')) return ++countRequests === 1 ? oldCount.promise : newCount.promise;
    if (call.url.endsWith('/cart/del')) {
      deleteRequests++;
      if (deleteRequests === 1) { set(get().filter(item => !call.data.ids.includes(item.id))); return { data: null }; }
      return secondDelete.promise.then(result => { set(get().filter(item => !call.data.ids.includes(item.id))); return result; });
    }
  });
  try {
    await r.start(); const p = r.checkout; p.cartStore.count = 99;
    const first = p.removeRows([1]); await tick();
    assert.equal(countRequests, 1); assert.equal(p.cartStore.ready, true); assert.equal(p.cartStore.updating, false);
    const second = p.removeRows([3]); await tick();
    assert.equal(deleteRequests, 2); assert.equal(p.cartStore.updating, true); assert.equal(p.cartStore.ready, false);
    oldCount.resolve({ data: { count: 2 } }); await first; await tick();
    assert.equal(p.cartStore.count, 99, 'the old count must not publish while the next mutation owns the cart');
    assert.equal(p.cartStore.updating, true); assert.equal(countRequests, 1);
    secondDelete.resolve({ data: null }); await tick();
    assert.equal(countRequests, 2); assert.equal(p.cartStore.count, 99);
    newCount.resolve({ data: { count: 1 } }); await second; await tick();
    assert.equal(p.cartStore.count, 1); assert.deepEqual(p.cartStore.items.map(item => item.id), [2]);
    assert.equal(p.cartStore.ready, true); assert.equal(p.managementMessage.value, '已删除所选商品');
    assert.deepEqual(writes(r).map(call => call.data), [{ ids: [1], scope: 'cart' }, { ids: [3], scope: 'cart' }]);
  } finally {
    oldCount.resolve({ data: { count: 2 } }); newCount.resolve({ data: { count: 1 } }); secondDelete.resolve({ data: null }); r.stop();
  }
});


// Mount the real footer badge alongside the actual cart Page in the same
// loader/Pinia/auth/revision module graph; only native network I/O is replaced.
function cartWithFooter(override = () => undefined, initial) {
  const r = managementSetup((call, get, set) => {
    const result = override(call, get, set);
    if (result !== undefined) return result;
    if (call.url.endsWith('/cart/count') && call.data.numType === 0) {
      return { data: { count: get().filter(item => item.isValid).reduce((sum, item) => sum + item.cartNum, 0) } };
    }
  }, initial);
  const scope = vue.effectScope();
  const badge = scope.run(() => r.load(path.join(__dirname, '../src/composables/useDiyFooterBadge.ts')).useDiyFooterBadge(() => r.checkout.footerVisible.value));
  const signals = r.load(path.join(__dirname, '../src/stores/cartMutation.ts'));
  return { ...r, badge, signals, close() { r.stop(); scope.stop(); } };
}
const quantityReads = r => r.calls.filter(call => call.url.endsWith('/cart/count') && call.data.numType === 0);
const rowCountReads = r => r.calls.filter(call => call.url.endsWith('/cart/count') && call.data.numType === undefined);

test('ordinary cart initial, explicit successful reads and onShow do not publish reconciliation or extra quantity reads', async () => {
  const r = cartWithFooter();
  try {
    await r.start(); assert.equal(r.badge.value, 4); assert.equal(quantityReads(r).length, 1); assert.equal(rowCountReads(r).length, 0);
    await r.checkout.reload(); await tick();
    assert.equal(quantityReads(r).length, 1); assert.equal(rowCountReads(r).length, 0);
    r.hooks.onHide(); await tick(); assert.equal(r.badge.value, 0);
    r.hooks.onShow(); await tick();
    assert.equal(r.badge.value, 4); assert.equal(quantityReads(r).length, 2, 'one normal footer activation query per visible Page');
    assert.equal(rowCountReads(r).length, 0); assert.equal(r.signals.cartReconciliationRevision.value, 0); assert.equal(r.signals.cartMutationRevision.value, 0);
  } finally { r.close(); }
});

test('lost committed delete reconciles list, row count and real footer quantity exactly once after explicit retry', async () => {
  const r = cartWithFooter((call, get, set) => {
    if (call.url.endsWith('/cart/del')) { set(get().filter(item => !call.data.ids.includes(item.id))); return { transport: 'delete reply lost after commit' }; }
  });
  try {
    await r.start(); assert.equal(r.badge.value, 4);
    await r.checkout.removeRows([1]); await tick();
    assert.match(r.checkout.cartStore.error, /reply lost/); assert.equal(r.checkout.cartStore.ready, false);
    assert.equal(r.badge.value, 4); assert.equal(r.signals.cartMutationRevision.value, 0); assert.equal(r.signals.cartReconciliationRevision.value, 0);
    assert.equal(quantityReads(r).length, 1); assert.equal(rowCountReads(r).length, 0);
    await r.checkout.reload(); await tick();
    assert.deepEqual(r.checkout.cartStore.items.map(item => item.id), [3, 2]); assert.equal(r.checkout.cartStore.count, 2);
    assert.equal(r.badge.value, 2, 'quantity is valid units, not the ordinary row count');
    assert.equal(quantityReads(r).length, 2); assert.deepEqual(rowCountReads(r).map(call => call.data), [{ scope: 'cart' }]);
    assert.equal(r.signals.cartReconciliationRevision.value, 1); assert.equal(r.signals.cartMutationRevision.value, 0);
    assert.equal(writes(r).length, 1, 'reconciliation never repeats deletion');
    await r.checkout.reload(); await tick();
    assert.equal(quantityReads(r).length, 2); assert.equal(rowCountReads(r).length, 1); assert.equal(r.signals.cartReconciliationRevision.value, 1);
    assert.equal(writes(r).length, 1);
  } finally { r.close(); }
});

test('failed recovery read never refreshes row count or the real footer and never replays deletion', async () => {
  let failRead = false;
  const r = cartWithFooter((call, get, set) => {
    if (call.url.endsWith('/cart/del')) { set(get().filter(item => !call.data.ids.includes(item.id))); return { transport: 'committed delete reply lost' }; }
    if (call.url.endsWith('/cart/list') && failRead) return { transport: 'retry offline' };
  });
  try {
    await r.start(); await r.checkout.removeRows([1]); failRead = true;
    await r.checkout.reload(); await tick();
    assert.match(r.checkout.cartStore.error, /retry offline/); assert.equal(r.checkout.cartStore.ready, false);
    assert.equal(quantityReads(r).length, 1); assert.equal(rowCountReads(r).length, 0); assert.equal(r.badge.value, 4);
    assert.equal(r.signals.cartReconciliationRevision.value, 0); assert.equal(r.signals.cartMutationRevision.value, 0); assert.equal(writes(r).length, 1);
  } finally { r.close(); }
});

for (const transition of ['account', 'hide', 'unload', 'hide-show', 'newer-store-read']) test(`late recovery cannot publish reconciliation after ${transition}`, async () => {
  const gate = deferred(); let delayed = false;
  const r = cartWithFooter((call, get, set) => {
    if (call.url.endsWith('/cart/del')) { set(get().filter(item => !call.data.ids.includes(item.id))); return { transport: 'committed delete reply lost' }; }
    if (call.url.endsWith('/cart/list') && delayed) return gate.promise;
    if (call.header['Authori-zation'] === 'Bearer next-owner') {
      if (call.url.endsWith('/cart/list')) return { data: [row(9)] };
      if (call.url.endsWith('/cart/count')) return { data: { count: 7 } };
    }
  });
  try {
    await r.start(); await r.checkout.removeRows([1]); delayed = true;
    const retry = r.checkout.reload(); await tick(); delayed = false;
    if (transition === 'account') r.auth.setLogin('next-owner', 22);
    if (transition === 'hide' || transition === 'hide-show') r.hooks.onHide();
    if (transition === 'unload') r.hooks.onUnload();
    if (transition === 'hide-show') r.hooks.onShow();
    if (transition === 'newer-store-read') await r.checkout.cartStore.fetchList();
    await tick();
    const before = { quantity: quantityReads(r).length, rows: rowCountReads(r).length, calls: r.calls.length };
    gate.resolve({ data: [row(99)] }); await retry; await tick();
    assert.equal(quantityReads(r).length, before.quantity); assert.equal(rowCountReads(r).length, before.rows); assert.equal(r.calls.length, before.calls);
    assert.equal(r.signals.cartReconciliationRevision.value, 0); assert.equal(r.signals.cartMutationRevision.value, 0); assert.equal(writes(r).length, 1);
    if (transition === 'account') { assert.deepEqual(r.checkout.cartStore.items.map(item => item.id), [9]); assert.equal(r.badge.value, 7); }
    else if (transition === 'hide' || transition === 'unload') { assert.equal(r.checkout.cartStore.ready, false); assert.equal(r.badge.value, 0); }
    else { assert.deepEqual(r.checkout.cartStore.items.map(item => item.id), [3, 2]); assert.equal(r.checkout.cartStore.ready, true); }
  } finally { gate.resolve({ data: [] }); r.close(); }
});


test('a double retry keeps the in-flight recovery intent and refreshes actual footer quantity once', async () => {
  const gate = deferred(); let delayed = false, retryRows;
  const r = cartWithFooter((call, get, set) => {
    if (call.url.endsWith('/cart/del')) { set(get().filter(item => !call.data.ids.includes(item.id))); return { transport: 'committed delete reply lost' }; }
    if (call.url.endsWith('/cart/list') && delayed) { retryRows = structuredClone(get()); return gate.promise; }
  });
  try {
    await r.start(); await r.checkout.removeRows([1]); delayed = true;
    const first = r.checkout.reload(); await tick();
    assert.equal(r.checkout.cartStore.loading, true); assert.equal(r.checkout.cartStore.error, '');
    const generation = r.checkout.cartStore.readVersion, reads = r.calls.filter(call => call.url.endsWith('/cart/list')).length;
    await r.checkout.reload(); await tick();
    assert.equal(r.checkout.cartStore.readVersion, generation); assert.equal(r.calls.filter(call => call.url.endsWith('/cart/list')).length, reads);
    assert.equal(quantityReads(r).length, 1); assert.equal(rowCountReads(r).length, 0); assert.equal(r.signals.cartReconciliationRevision.value, 0);
    gate.resolve({ data: retryRows }); await first; await tick();
    assert.deepEqual(r.checkout.cartStore.items.map(item => item.id), [3, 2]); assert.equal(r.checkout.cartStore.count, 2); assert.equal(r.badge.value, 2);
    assert.equal(quantityReads(r).length, 2); assert.equal(rowCountReads(r).length, 1);
    assert.equal(r.signals.cartReconciliationRevision.value, 1); assert.equal(r.signals.cartMutationRevision.value, 0); assert.equal(writes(r).length, 1);
  } finally { gate.resolve({ data: [] }); r.close(); }
});
