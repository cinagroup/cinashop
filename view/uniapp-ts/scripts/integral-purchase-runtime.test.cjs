const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

// Actual Vue/Pinia, API adapter, request identity fences and shared purchase code.
// Native lifecycle/transport alone is synthetic; this is not SQL or rendered QA.
function catalogue(id = 70) {
  const skus = [
    { id: 201, unique: 'inte0001', suk: '红色,大', image: '/api/assets/42?sig=preview', price: '0.10', otPrice: '1.00', integral: 120, stock: 9, purchasable: true, issues: [] },
    { id: 202, unique: 'inte0002', suk: '蓝色,小', image: 'https://cdn.example/blue.png', price: '12.34', otPrice: '15.00', integral: 200, stock: 2, purchasable: true, issues: [] },
    { id: 203, unique: 'inte0003', suk: '售罄规格', image: '', price: '0.00', otPrice: '0.00', integral: 30, stock: 0, purchasable: false, issues: [] },
  ];
  return { storeInfo: { id, productId: 8, storeName: `积分商品${id}`, unitName: '件', image: '/api/assets/42?sig=preview',
    images: ['/api/assets/42?sig=preview', 'https://cdn.example/gallery.png'], description: '<p>积分详情</p><img src="/api/assets/43?sig=body">',
    productType: 0, sales: 5, onceNum: 5, num: 8, systemFormId: 3, deliveryType: ['1','2'], price: '0.10', otPrice: '1.00', integral: 120,
    storeLabel: [{ id: 1, labelName: '正品', styleType: 1, color: '#fff', bgColor: '#123', borderColor: '', icon: '/label.png' }],
    ensure: [{ id: 1, name: '服务保障', image: '/ensure.png', desc: '凭单售后' }], specs: [{ name: '产地', value: '中国', sort: 1 }], brandName: '真实品牌' },
    skus, productAttr: [{ id: 1, name: '规格', values: ['红色,大', '蓝色,小'] }], productValue: Object.fromEntries(skus.map(s => [s.suk, { ...s }])),
    saleStock: 1, issues: [], siteName: '测试商城', siteUrl: 'https://shop.example', shareQrcode: 0, productPosterTitle: '积分好物' };
}
function setup({ detail = call => ({ data: catalogue(Number(call.url.split('/').at(-1))) }), add = () => ({ data: { id: 91, cartNum: 1 } }), bind = () => ({ data: null }), mall = false, component = true } = {}) {
  return runtime({ feature: 'useIntegralPurchase', component: mall ? 'pages/user/integral.vue' : component ? 'pages/activity/integralDetail.vue' : undefined,
    send: call => {
      if (/\/store_integral\/detail\/\d+$/u.test(call.url)) return detail(call);
      if (call.url === '/api/cart/add') return add(call);
      if (/\/product\/detail\/\d+$/u.test(call.url)) return { data: { id: Number(call.url.split('/').at(-1)), userCollect: false } };
      if (call.url === '/api/collect/add') return { data: { count: 1 } };
      if (call.url === '/api/collect/del') return { data: null };
      if (call.url === '/api/user/spread') return bind(call);
      if (call.url === '/api/store_integral/list') return { data: [{ id: 70, product_id: 8, title: '积分商品', image: '/api/assets/42?sig=preview', integral: 120, price: 0.1, sales: 5, stock: 9 }] };
      if (call.url === '/api/user/info') return { data: { integral: 500 } };
      throw new Error(`Unexpected integral I/O ${call.url}`);
    } });
}
const start = r => r.start({ id: '70' });
const adds = r => r.calls.filter(call => call.url === '/api/cart/add');
const reads = r => r.calls.filter(call => call.url.includes('/store_integral/detail/'));
const contract = r => r.load(path.resolve(__dirname, '../../common/integralPurchase.ts'));

test('actual detail consumes full safe metadata and submits activity SKU through cart to unified confirmation only', async () => {
  const r = setup(); try {
    await start(r); const p = r.checkout;
    assert.equal(p.detail.value.storeInfo.productId, 8); assert.equal(p.detail.value.storeInfo.systemFormId, 3);
    assert.equal(p.detail.value.storeInfo.ensure[0].desc, '凭单售后'); assert.equal(p.detail.value.storeInfo.specs[0].value, '中国');
    assert.equal(p.gallery.value.length, 2); assert.match(p.detail.value.storeInfo.description, /sig=body/u);
    p.setQuantity('3'); assert.deepEqual(p.totals.value, { integral: '360', cash: '0.30' });
    await p.purchase();
    assert.deepEqual(adds(r).map(call => call.data), [{ productId: 8, activityId: 70, unique: 'inte0001', cartNum: 3, type: 4, new: 1 }]);
    assert.deepEqual(r.navigations, ['/pages/order/confirm?mode=buy&cartId=91&type=4']);
    assert.equal(p.prepared.value, 91); assert.ok(r.calls.every(call => !/exchange|order\/create|pay/u.test(call.url)));
  } finally { r.stop(); }
});

test('switching SKU tightens quantity and changes cash, points, image and availability without root price fallback', async () => {
  const r = setup(); try { await start(r); const p = r.checkout;
    p.setQuantity('5'); p.choose('inte0002'); assert.equal(p.quantity.value, 2); assert.equal(contract(r).integralMaxQuantity(p.detail.value, p.selected.value), 2);
    assert.deepEqual(p.totals.value, { integral: '400', cash: '24.68' }); assert.equal(p.gallery.value[0], 'https://cdn.example/blue.png');
    p.choose('inte0003'); assert.equal(p.selected.value, 'inte0002'); p.choose('forged'); assert.equal(p.selected.value, 'inte0002');
    for (const value of ['', '0', '-1', '1.5', '1e1', '03', '3', '32768']) { p.setQuantity(value); assert.equal(p.canBuy.value, false, value); await p.purchase(); }
    assert.equal(adds(r).length, 0); p.setQuantity('2'); assert.equal(p.canBuy.value, true);
  } finally { r.stop(); }
});

test('in-flight add locks all selection controls and permits only one cart mutation', async () => {
  const gate = deferred(), r = setup({ add: () => gate.promise }); try { await start(r); const p = r.checkout;
    p.setQuantity('3'); const write = p.purchase(); await tick(); assert.equal(p.buying.value, true);
    p.choose('inte0002'); p.setQuantity('1'); p.stepQuantity(-1); await p.purchase();
    assert.equal(p.selected.value, 'inte0001'); assert.equal(p.quantity.value, 3); assert.equal(adds(r).length, 1);
    gate.resolve({ data: { id: 91 } }); await write; assert.equal(p.prepared.value, 91);
  } finally { r.stop(); }
});

test('successful add plus failed navigation continues the same cart without a second write', async () => {
  const r = setup(); try { await start(r); const p = r.checkout; r.uni.navigateTo = opts => { r.navigations.push(opts.url); opts.fail?.(); };
    await p.purchase(); assert.equal(p.prepared.value, 91); assert.match(p.error.value, /继续结算/u);
    p.choose('inte0002'); p.setQuantity('2'); await p.load(); await p.purchase();
    assert.equal(adds(r).length, 1); assert.equal(reads(r).length, 1); assert.deepEqual(r.navigations, [contract(r).integralCheckoutUrl(91), contract(r).integralCheckoutUrl(91)]);
  } finally { r.stop(); }
});

test('ambiguous transport or invalid cart response requires explicit reread before another selection', async () => {
  for (const response of [{ transport: 'network timeout' }, { data: { id: '91' } }, { status: 400, msg: '库存已变化' }]) {
    const r = setup({ add: () => response }); try { await start(r); const p = r.checkout; await p.purchase();
      assert.equal(p.prepared.value, null); assert.equal(p.needsRefresh.value, true); assert.equal(p.canBuy.value, false); await p.purchase(); assert.equal(adds(r).length, 1);
      await p.load(); assert.equal(p.needsRefresh.value, false); assert.equal(reads(r).length, 2); assert.equal(adds(r).length, 1);
    } finally { r.stop(); }
  }
});

test('invalid and mismatched IDs, SKU money, saleStock and variant aliases fail closed', async () => {
  for (const id of [undefined, '', '0', '-1', '070', '7e1', '70.0', '2147483648', ['70']]) {
    const r = setup(); try { await r.start({ id }); assert.equal(r.calls.length, 0); assert.equal(r.checkout.detail.value, null); assert.ok(r.checkout.error.value); } finally { r.stop(); }
  }
  for (const change of [d => { d.storeInfo.id = 71; }, d => { d.skus[0].price = 0.1; }, d => { d.saleStock = 0; }, d => { d.productValue[d.skus[0].suk].stock = 8; }]) {
    const r = setup({ detail: () => { const d = catalogue(); change(d); return { data: d }; } }); try { await start(r); assert.equal(r.checkout.detail.value, null); await r.checkout.purchase(); assert.equal(adds(r).length, 0); } finally { r.stop(); }
  }
});

test('sold out and diagnosed historical SKU identity remain browseable without inventing a purchase', async () => {
  const r = setup({ detail: () => { const d = catalogue(); d.skus.forEach(s => { s.stock = 0; s.purchasable = false; });
    d.skus[0].unique = ''; d.skus[0].issues = ['activity_sku_invalid']; d.skus[1].unique = 'same0001'; d.skus[2].unique = 'same0001';
    d.skus[1].issues = d.skus[2].issues = ['activity_sku_ambiguous']; d.productValue = {}; d.saleStock = 0; return { data: d }; } });
  try { await start(r); const p = r.checkout; assert.equal(p.detail.value.skus.length, 3); assert.equal(p.detail.value.storeInfo.storeName, '积分商品70'); assert.equal(p.canBuy.value, false); p.choose('same0001'); await p.purchase(); assert.equal(adds(r).length, 0); } finally { r.stop(); }
});

test('safe signed media and full gallery survive; active HTML and unsafe media do not enter rendering', async () => {
  const r = setup(); try { const c = contract(r);
    for (const url of ['//evil.test/a', 'javascript:alert(1)', 'data:image/svg+xml,a', 'https://u:p@evil.test/a', '/a/%2e%2e//evil.test', '/a%255cb', 'https:evil.test/a']) assert.equal(c.integralImage(url), '', url);
    assert.equal(c.integralImage('/api/assets/42?sig=a&expires=4'), '/api/assets/42?sig=a&expires=4'); assert.equal(c.integralImage('https://cdn.example/a%20b.png'), 'https://cdn.example/a%20b.png');
    const html = c.integralDescription('<p onclick="x()">安全</p><script>alert(1)</script><img src="javascript:alert(1)" onerror="x()"><img src="https://u:p@evil.test/a"><img src="/api/assets/42?sig=ok">');
    assert.ok(!/script|onclick|onerror|javascript|u:p/u.test(html)); assert.match(html, /sig=ok/u);
    const d = catalogue(); d.storeInfo.images = Array.from({ length: 30 }, (_, i) => `/gallery/${i}.png`); assert.equal(c.parseIntegralDetail(d, 70).storeInfo.images.length, 30);
    d.storeInfo.storeName = '🌤'.repeat(255); d.siteName = '🌤'.repeat(255);d.productPosterTitle = '🌤'.repeat(255);
    d.storeInfo.specs[0].sort=-2147483648;
    const rawBody = `<p>${'正'.repeat(160000)}</p>` + Array.from({length:1000},(_,i)=>`<img src="/api/assets/${i+1}">`).join('');
    assert.ok(rawBody.length<=200000);
    d.storeInfo.description = rawBody.replace(/\/api\/assets\/(\d+)/gu, (_match,id)=>`/api/assets/${id}?sig=${'a'.repeat(100)}&expires=2000000000`);
    assert.ok(d.storeInfo.description.length>200000);
    const expanded = c.parseIntegralDetail(d,70); assert.equal(expanded.storeInfo.storeName,d.storeInfo.storeName);assert.equal(expanded.siteName,d.siteName);assert.equal(expanded.storeInfo.specs[0].sort,-2147483648);
    assert.equal((expanded.storeInfo.description.match(/sig=/gu)||[]).length,1000);assert.throws(()=>c.parseIntegralDetail({...d,storeInfo:{...d.storeInfo,description:'a'.repeat(2*1024*1024+1)}},70));
    assert.deepEqual(c.integralSelectionTotals(c.parseIntegralDetail(d, 70), 'inte0001', 3), { integral: '360', cash: '0.30' });
  } finally { r.stop(); }
});

test('late detail after activity switch, hide, unload or identity replacement cannot repopulate old content', async () => {
  for (const boundary of ['route','hide','unload','identity']) {
    const gate = deferred(), r = setup({ detail: call => call.url.endsWith('/70') ? gate.promise : { data: catalogue(71) } });
    try { await start(r); const p = r.checkout;
      if (boundary === 'route') { r.hooks.onLoad({ id: '71' }); await tick(); }
      if (boundary === 'hide') r.hooks.onHide(); if (boundary === 'unload') r.hooks.onUnload(); if (boundary === 'identity') r.auth.setLogin('replacement', 22);
      gate.resolve({ data: catalogue() }); await tick(); assert.equal(p.detail.value?.storeInfo.id ?? null, boundary === 'route' ? 71 : null); assert.equal(adds(r).length, 0);
    } finally { r.stop(); }
  }
});

test('late add after route, hide or actor switch never navigates or publishes a prepared cart', async () => {
  for (const boundary of ['route','hide','identity']) {
    const gate = deferred(), r = setup({ add: () => gate.promise }); try { await start(r); const p = r.checkout;
      const promise = p.purchase(); await tick(); if (boundary === 'route') { r.hooks.onLoad({ id: '71' }); await tick(); }
      if (boundary === 'hide') r.hooks.onHide(); if (boundary === 'identity') r.auth.setLogin('replacement', 22);
      gate.resolve({ data: { id: 91 } }); await promise; await tick(); assert.equal(p.prepared.value, null); assert.deepEqual(r.navigations, []);
    } finally { r.stop(); }
  }
});

test('anonymous and genuinely expired session return restores an explicit selection without automatically adding', async () => {
  for (const expired of [false,true]) {
    const r = setup({ add: () => ({ status: 410002, msg: 'synthetic expiry' }) }); try { if (!expired) r.auth.clear(); await start(r); const p = r.checkout;
      p.choose('inte0002'); p.setQuantity('2'); await p.purchase(); assert.equal(r.navigations.at(-1), '/pages/auth/login');
      r.hooks.onHide(); r.auth.setLogin('fresh', 11); r.hooks.onShow(); await tick();
      assert.equal(p.selected.value, 'inte0002'); assert.equal(p.quantity.value, 2); assert.equal(p.prepared.value, null); assert.equal(adds(r).length, expired ? 1 : 0);
    } finally { r.stop(); }
  }
});

test('MP scene parsing consumes the canonical referrer once while sharing the current actor, anonymous shares omit it', async () => {
  const r = setup(); try { await r.start({ scene: encodeURIComponent('id=70&type=4&spid=19') }); const p = r.checkout;
    assert.equal(p.detail.value.storeInfo.id, 70); assert.equal(p.sharePath.value, '/pages/activity/integralDetail?id=70&spid=11');
    r.auth.clear(); assert.equal(p.sharePath.value, '/pages/activity/integralDetail?id=70');
    const c = contract(r); for (const scene of ['id=70&id=71&type=4','id=70&type=1','id=70&spid=0','id=070&type=4','id=70&spid=19&spid=20','id=%FF&type=4']) assert.throws(() => c.integralRouteQuery({ scene: encodeURIComponent(scene) }));
    assert.deepEqual(r.calls.filter(call=>call.url==='/api/user/spread').map(call=>call.data),[{spread_uid:19}]);
    assert.ok(!r.calls.some(call => /exchange/u.test(call.url)));
  } finally { r.stop(); }
});

test('raw H5 duplicate IDs and referrals fail before fetching, and live route changes fence old responses', async () => {
  const oldWindow = global.window; const events = new Map();
  global.window = { location: { hash: '#/pages/activity/integralDetail?id=70&id=71' }, addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) };
  const r = setup(); try { await start(r); assert.equal(r.calls.length, 0); assert.equal(r.checkout.detail.value, null);
    window.location.hash = '#/pages/activity/integralDetail?id=70&spid=2&spid=3'; events.get('hashchange')(); await tick(); assert.equal(r.calls.length, 0);
    window.location.hash = '#/pages/activity/integralDetail?id=71'; events.get('hashchange')(); await tick(); assert.equal(r.checkout.detail.value.storeInfo.id, 71);
  } finally { r.stop(); global.window = oldWindow; }
});

test('actual mall sheet shares the same SKU and cart logic, retains prepared cart on navigation failure and clears actor-owned points', async () => {
  const r = setup({ mall: true }); try { await r.start(); const p = r.checkout; assert.equal(p.points.value, '500');
    await p.exchange(p.list.value[0]); assert.equal(p.skuVisible.value, true); p.setQuantity('5'); p.choose('inte0002'); assert.equal(p.quantity.value, 2);
    r.uni.navigateTo = opts => { r.navigations.push(opts.url); opts.fail?.(); }; await p.confirmExchange(); p.closeSku(); assert.equal(p.prepared.value, 91); assert.equal(p.skuVisible.value, true);
    await p.confirmExchange(); assert.equal(adds(r).length, 1); r.auth.setLogin('replacement', 22); assert.equal(p.points.value, '待读取'); assert.equal(p.list.value.length, 0); assert.equal(p.pendingDetail.value, null);
  } finally { r.stop(); }
});

test('mall detail cancellation and late list/user responses do not reopen sheets or leak a previous account', async () => {
  const gate = deferred(), r = setup({ mall: true, detail: () => gate.promise }); try { await r.start(); const p = r.checkout;
    const loading = p.exchange(p.list.value[0]); await tick(); p.closeSku(); gate.resolve({ data: catalogue() }); await loading; assert.equal(p.skuVisible.value, false); assert.equal(p.pendingDetail.value, null);
    r.hooks.onHide(); r.hooks.onShow(); await tick(); assert.equal(p.points.value, '500');
    r.auth.clear(); assert.equal(p.list.value.length, 0); assert.equal(p.points.value, '未登录'); assert.equal(adds(r).length, 0);
  } finally { r.stop(); }
});

test('late actor-owned points and mall catalogue cannot replace a new account view', async () => {
  for (const boundary of ['points','list']) {
    const gate = deferred();
    const r = runtime({ component: 'pages/user/integral.vue', send: call => {
      if (call.url.endsWith('/store_integral/list')) return boundary === 'list' ? gate.promise : { data: [] };
      if (call.url.endsWith('/user/info')) return gate.promise;
      throw new Error(`Unexpected I/O ${call.url}`);
    } });
    try { await r.start(); r.auth.setLogin('new-account', 22); gate.resolve({ data: boundary === 'list' ? [{ id:70 }] : { integral:900 } }); await tick();
      assert.equal(r.checkout.list.value.length, 0); assert.equal(r.checkout.points.value, '待读取'); assert.equal(r.checkout.listError.value, '');
    } finally { r.stop(); }
  }
});

test('actual collection toggle uses the related ordinary product id and category, never integral activity id', async () => {
  const r = setup(); try { await start(r); const p = r.checkout;
    assert.equal(p.collected.value, false); await p.toggleCollection(); assert.equal(p.collected.value, true); await p.toggleCollection(); assert.equal(p.collected.value, false);
    assert.deepEqual(r.calls.filter(c => /\/collect\/(?:add|del)$/u.test(c.url)).map(c => ({ url: c.url, data: c.data })), [
      { url: '/api/collect/add', data: { id: [8], category: 'product' } }, { url: '/api/collect/del', data: { id: [8], category: 'product' } }]);
    assert.equal(adds(r).length, 0);
  } finally { r.stop(); }
});

test('collection late reads/writes and uncertain errors do not publish state across account or page boundaries', async () => {
  for (const action of ['read','write','failed']) {
    const gate = deferred(); let detailId = 70;
    const r = runtime({ component: 'pages/activity/integralDetail.vue', send: c => {
      if (c.url.includes('/store_integral/detail/')) return { data: catalogue(detailId) };
      if (c.url.includes('/product/detail/')) return action === 'read' ? gate.promise : { data: { id:8, userCollect:false } };
      if (c.url === '/api/collect/add') return action === 'failed' ? { transport: 'uncertain collection' } : gate.promise;
      throw new Error(`Unexpected I/O ${c.url}`);
    } });
    try { await start(r); const p = r.checkout;
      if (action === 'read') { r.auth.setLogin('other',22); gate.resolve({ data:{ id:8,userCollect:true } }); await tick(); assert.equal(p.collected.value,null); }
      else if (action === 'write') { const pending = p.toggleCollection(); await tick(); detailId=71; r.hooks.onLoad({id:'71'}); await tick(); gate.resolve({data:{count:1}}); await pending; assert.equal(p.collected.value,false); }
      else { await p.toggleCollection(); assert.equal(p.collected.value,null); await p.toggleCollection(); assert.equal(p.collected.value,false); assert.equal(r.calls.filter(c => c.url === '/api/collect/add').length,1); }
    } finally { r.stop(); }
  }
});

test('actual selection template distinguishes invalid diagnostic zeroes from legitimate sold-out prices', async () => {
  const fs = require('node:fs'), vue = require('vue'), compiler = require('@vue/compiler-dom'), { renderToString } = require('@vue/server-renderer');
  const invalidCatalogue=catalogue();invalidCatalogue.skus[0].price='0.00';invalidCatalogue.skus[0].integral=0;invalidCatalogue.skus[0].stock=0;invalidCatalogue.skus[0].purchasable=false;invalidCatalogue.skus[0].issues=['sku_money_invalid','sku_integral_invalid'];
  invalidCatalogue.skus[0].unique='';invalidCatalogue.skus[1].stock=0;invalidCatalogue.skus[1].purchasable=false;invalidCatalogue.saleStock=0;invalidCatalogue.productValue={};invalidCatalogue.issues=['summary_price_invalid'];
  const r = setup({detail:()=>({data:invalidCatalogue})}); try {
    const file = path.resolve(__dirname,'../src/components/IntegralSkuSelection.vue'), component = r.load(file).default;
    const sfc = require('@vue/compiler-sfc'), descriptor = sfc.parse(fs.readFileSync(file,'utf8')).descriptor;
    const bindings = sfc.compileScript(descriptor,{id:'actual-selection-ssr'}).bindings;
    component.render = new Function('Vue',compiler.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:bindings,isCustomElement:tag=>['view','text','image'].includes(tag)}).code)(vue);
    const d = catalogue(); d.skus[0].price='0.00';d.skus[0].integral=0;d.skus[0].stock=0;d.skus[0].purchasable=false;d.skus[0].issues=['sku_money_invalid','sku_integral_invalid'];
    const app=vue.createSSRApp(component,{detail:d,selected:'',quantity:1,disabled:false});const html=await renderToString(app);
    assert.match(html,/规格报价异常，暂不可兑换/u); assert.ok(!html.includes('红色,大 · 0积分 + ¥0.00'));
    assert.match(html,/售罄规格 · 30积分 \+ ¥0\.00/u);assert.match(html,/disabled/u);
    await start(r);assert.equal(r.checkout.selectedSku.value,undefined);assert.equal(r.checkout.canBuy.value,false);
    const pageFile=path.resolve(__dirname,'../src/pages/activity/integralDetail.vue'),pageDescriptor=sfc.parse(fs.readFileSync(pageFile,'utf8')).descriptor;
    const pageBindings=sfc.compileScript(pageDescriptor,{id:'actual-detail-ssr'}).bindings;
    const pageRender=new Function('Vue',compiler.compile(pageDescriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:pageBindings,isCustomElement:tag=>['view','text','image','rich-text','swiper','swiper-item'].includes(tag)}).code)(vue);
    // The runtime loads real SFC setup scripts; SSR must also compile the real
    // host template so its slot renders the detail instead of an empty comment.
    const themeFile=path.resolve(__dirname,'../src/components/ThemePage.vue'),themeDescriptor=sfc.parse(fs.readFileSync(themeFile,'utf8')).descriptor;
    const themeBindings=sfc.compileScript(themeDescriptor,{id:'actual-theme-host-ssr'}).bindings;
    r.load(themeFile).default.render=new Function('Vue',compiler.compile(themeDescriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:themeBindings,isCustomElement:tag=>tag==='view'}).code)(vue);
    const theme=r.load(path.resolve(__dirname,'../src/stores/theme.ts')).useThemeStore();
    const pageApp=vue.createSSRApp({render:pageRender,setup:()=>r.checkout});pageApp.use(require('pinia').getActivePinia());
    const detailHtml=await renderToString(pageApp);
    assert.match(detailHtml,/class="theme-page"/u);for(const [token,value]of Object.entries(theme.variables))assert.ok(detailHtml.includes(`${token}:${value}`),token);
    assert.match(detailHtml,/商品默认报价资料异常/u);assert.match(detailHtml,/规格报价异常，暂不可兑换/u);assert.doesNotMatch(detailHtml,/(?<!\d)0积分 \+ ¥0\.00/u);assert.match(detailHtml,/售罄规格 · 30积分 \+ ¥0\.00/u);assert.equal(adds(r).length,0);
  } finally {r.stop();}
});

test('share links use the actual H5 document or authoritative site origin and APP invokes the real provider with the full activity URL', async () => {
  const oldWindow=global.window, r=setup({component:false});
  try {
    delete global.window;
    const share=r.load(path.resolve(__dirname,'../src/utils/integralShare.ts')), pathValue='/pages/activity/integralDetail?id=70&spid=11';
    assert.equal(share.integralShareUrl(pathValue,'https://shop.example'),`https://shop.example/#${pathValue}`);
    for(const origin of ['', 'https://u:p@shop.example', 'http://shop.example', 'https://127.0.0.1', 'https://shop.example/', 'https://shop.example:444', 'https://LOCALHOST', 'https://shop.example?q=1']) assert.equal(share.integralShareUrl(pathValue,origin),'',origin);
    global.window={location:{href:'https://h5.example/storefront/?external=discarded#/pages/index/index'}};
    assert.equal(share.integralShareUrl(pathValue,'https://api.example'),`https://h5.example/storefront/#${pathValue}`);
    delete global.window;
    const messages=[], invocations=[];
    r.uni.getProvider=options=>{assert.equal(options.service,'share');options.success({provider:['weixin']});};
    r.uni.share=options=>{invocations.push(options);options.success();};
    const url=share.integralShareUrl(pathValue,'https://shop.example');
    share.shareIntegralInApp({url,title:'商品70',image:'/api/assets/42?sig=read',summary:'积分好物'},message=>messages.push(message));
    assert.equal(invocations.length,1);assert.deepEqual(Object.fromEntries(['provider','scene','type','href','title','imageUrl','summary'].map(key=>[key,invocations[0][key]])),{provider:'weixin',scene:'WXSceneSession',type:0,href:url,title:'商品70',imageUrl:'/api/assets/42?sig=read',summary:'积分好物'});
    assert.deepEqual(messages,['已调用微信分享']);
    r.uni.getProvider=options=>options.success({provider:['qq']});share.shareIntegralInApp({url,title:'a',image:'',summary:''},message=>messages.push(message));assert.match(messages.at(-1),/没有可用/u);assert.equal(invocations.length,1);
    share.shareIntegralInApp({url:'',title:'a',image:'',summary:''},message=>messages.push(message));assert.match(messages.at(-1),/尚未配置/u);
    let provider,live=true;r.uni.getProvider=options=>{provider=options;};share.shareIntegralInApp({url,title:'a',image:'',summary:''},message=>messages.push(message),()=>live);
    live=false;provider.success({provider:['weixin']});assert.equal(invocations.length,1);
    assert.equal(adds(r).length,0);
  } finally {r.stop();global.window=oldWindow;}
});

test('incoming integral referral binds only once for its original actor and self referrals do not write', async () => {
  for(const spid of ['19','11']){
    const r=setup();try{await r.start({id:'70',spid});const p=r.checkout;
      assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,spid==='19'?1:0);
      r.hooks.onHide();r.hooks.onShow();await tick();await p.load();await tick();assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,spid==='19'?1:0);
      r.auth.setLogin('replacement',22);await tick();r.hooks.onShow();await tick();assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,spid==='19'?1:0);
      assert.equal(adds(r).length,0);
    }finally{r.stop();}
  }
});

test('a guest integral visit waits for login return, and its first login cannot transfer the referrer to a second actor', async () => {
  for(const replaceImmediately of [false,true]){
    const r=setup();try{r.auth.clear();await r.start({id:'70',spid:'19'});assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,0);
      r.hooks.onHide();r.auth.setLogin('first-login',11);if(replaceImmediately)r.auth.setLogin('second-login',22);await tick();
      assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,0);r.hooks.onShow();await tick();
      assert.deepEqual(r.calls.filter(c=>c.url==='/api/user/spread').map(c=>c.data),replaceImmediately?[]:[{spread_uid:19}]);
      r.auth.clear();r.auth.setLogin('third-login',33);r.hooks.onShow();await tick();assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,replaceImmediately?0:1);
    }finally{r.stop();}
  }
});

test('late, failed and disposed referral responses cannot publish another account notice or retry the binding', async () => {
  for(const boundary of ['identity','unload','failure']){
    const gate=deferred(),r=setup({bind:()=>boundary==='failure'?{transport:'uncertain referral'}:gate.promise});
    try{await r.start({id:'70',spid:'19'});const p=r.checkout;assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,1);
      if(boundary==='identity')r.auth.setLogin('other',22);if(boundary==='unload')r.hooks.onUnload();
      gate.resolve({data:null});await tick();if(boundary!=='failure')assert.equal(p.referralNotice.value,'');else assert.match(p.referralNotice.value,/未能确认/u);
      if(boundary!=='unload'){r.hooks.onHide();r.hooks.onShow();await tick();}assert.equal(r.calls.filter(c=>c.url==='/api/user/spread').length,1);assert.equal(adds(r).length,0);
    }finally{r.stop();}
  }
});

test('actual poster canvas encodes the full plain URL with a quiet border, displays the selected quote and exports the drawn poster', async () => {
  const fs=require('node:fs'),ts=require('typescript'),vue=require('vue'),sfc=require('@vue/compiler-sfc'),oldWindow=global.window,r=setup({component:false});
  const file=path.resolve(__dirname,'../src/components/IntegralSharePoster.vue'),unmounts=[],calls=[],rectangles=[],text=[],exports={};
  try{
    delete global.window;
    const context={setFillStyle(value){calls.push(['fill',value]);},fillRect(...value){rectangles.push(value);},setFontSize(){},fillText(value,x,y){text.push([value,x,y]);},drawImage(...value){calls.push(['image',...value]);},draw(_reserve,callback){callback();}};
    Object.assign(r.uni,{getImageInfo(options){options.success({path:'/temporary/product.png'});},createCanvasContext(id){assert.equal(id,'integral-share-poster');return context;},canvasToTempFilePath(options){calls.push(['export',options.width,options.height,options.destWidth,options.destHeight]);options.success({tempFilePath:'/temporary/poster.png'});},saveImageToPhotosAlbum(options){calls.push(['save',options.filePath]);options.success();}});
    const source=sfc.compileScript(sfc.parse(fs.readFileSync(file,'utf8'),{filename:file}).descriptor,{id:'actual-poster-runtime'}).content;
    const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
    new Function('require','exports','uni',output)(id=>id==='vue'?{...vue,onMounted(){},onUnmounted(fn){unmounts.push(fn);}}:id.startsWith('@/')?r.load(path.resolve(__dirname,'../src',id.slice(2))):id.startsWith('qrcode-terminal/')?require(id):id.startsWith('.')?r.load(path.resolve(path.dirname(file),id)):require(id),exports,r.uni);
    const url='https://shop.example/#/pages/activity/integralDetail?id=70&spid=11';
    const props=vue.reactive({url,title:'积分商品70',image:'/api/assets/42?sig=actual-read',price:'12.34',integral:200,siteName:'商城',tagline:'积分好物'}),scope=vue.effectScope();
    const p=scope.run(()=>exports.default.setup(props,{expose(){}}));await p.draw();
    assert.equal(p.ready.value,true);assert.ok(text.some(([v])=>v==='200积分 + ¥12.34'));assert.ok(text.some(([v])=>v.includes('商城')&&v.includes('积分好物')));
    const QRCode=require('qrcode-terminal/vendor/QRCode'),level=require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel'),qr=new QRCode(0,level.M);qr.addData(url);qr.make();
    const dark=Array.from({length:qr.getModuleCount()},(_,row)=>Array.from({length:qr.getModuleCount()},(_,column)=>qr.isDark(row,column)?1:0).reduce((a,b)=>a+b,0)).reduce((a,b)=>a+b,0);
    assert.equal(rectangles.length,dark+2);assert.deepEqual(rectangles[0],[0,0,320,580]);const quietRect=rectangles[1];
    for(const [x,y,w,h] of rectangles.slice(2)){assert.ok(x>=quietRect[0]+w*4&&y>=quietRect[1]+h*4);assert.ok(x+w<=quietRect[0]+quietRect[2]-w*4&&y+h<=quietRect[1]+quietRect[3]-h*4);}
    p.save();assert.deepEqual(calls.find(v=>v[0]==='export'),['export',320,580,640,1160]);assert.deepEqual(calls.find(v=>v[0]==='save'),['save','/temporary/poster.png']);assert.equal(p.saving.value,false);
    unmounts.forEach(fn=>fn());scope.stop();assert.equal(adds(r).length,0);
  }finally{r.stop();global.window=oldWindow;}
});
