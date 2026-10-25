const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { setup, answer, product, calls, writes, root, component } = require('./diy-commerce-fixture.cjs');
const { tick } = require('./uni-store-runtime.cjs');
const kinds = ['seckill', 'combination', 'bargain', 'presale', 'pointsMall', 'promotionList'];
const origin = Date.UTC(2026, 9, 25, 4), signature = 's'.repeat(43);
const asset = (expires = origin + 900000, id = 7) => `/api/assets/${id}?expires=${Math.floor(expires / 1000)}&signature=${signature}`;
const fields = kind => kind === 'pointsMall' ? ['imgBgConfig', 'imgConfig', 'imgConfig2'] : ['imgBgConfig', 'imgConfig', 'imgColorConfig'];
function block(kind, image = asset()) {
  const b = { name: kind, timestamp: 19, isHide: true, extra: { empty: [], image: asset() }, productList: { list: [{ image: asset() }] } };
  if (kind === 'promotionList') b.tabConfig = { list: Array.from({ length: 33 }, (_, i) => ({ image, chiild: [{ val: `组${i}` }], link: asset(), extra: { i } })) };
  else for (const key of fields(kind)) b[key] = { url: image, link: asset(), extra: { empty: [] } };
  return b;
}
function slots(b) { return b.name === 'promotionList' ? b.tabConfig.list.map(row => [row, 'image']) : fields(b.name).map(key => [b[key], 'url']); }
function host() { const r = setup('coupon', answer, { props: { active: false } }); return { ...r, m: r.load(path.join(root, 'src/utils/diyEditorialMediaLease.ts')) }; }
async function clock(fn) { const old = Date.now; Date.now = () => origin; try { await fn(); } finally { Date.now = old; } }
for (const kind of kinds) test(`${kind} all exact dormant author slots and imported tail apply the earliest lease without source mutation`, () => clock(async () => {
  const r = host(); try { const b = block(kind), value = { value: [b] }, before = JSON.stringify(value); assert.equal(r.m.diyEditorialMediaDeadline(value, origin, origin), origin + 840000);
    const selected = slots(b); selected.at(-1)[0][selected.at(-1)[1]] = asset(origin + 100000); assert.equal(r.m.diyEditorialMediaDeadline(value, origin, origin), origin + 40000);
    selected.at(-1)[0][selected.at(-1)[1]] = asset(origin - 1); assert.equal(r.m.diyEditorialMediaCacheUsable(value, origin, origin), false);
    selected.at(-1)[0][selected.at(-1)[1]] = asset(); assert.equal(JSON.stringify(value), before); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));
for (const kind of kinds) test(`${kind} only author ticket renewal preserves fingerprint; image/link/preview/schema changes retain exact identity`, () => clock(async () => {
  const r = host(); try { const b = block(kind), before = JSON.stringify(b), fp = r.m.diyAuthoredPageFingerprint([b]);
    for (const [holder,key] of slots(b)) holder[key] = asset(origin + 800000); assert.equal(r.m.diyAuthoredPageFingerprint([b]), fp);
    const renewed = structuredClone(b); for (const mutate of [v => { slots(v).at(-1)[0][slots(v).at(-1)[1]] = asset(origin + 800000, 8); }, v => { v.productList.list[0].image = asset(origin + 800000); }, v => { v.extra.image = asset(origin + 800000); }, v => { if (kind === 'promotionList') v.tabConfig.list.at(-1).link = asset(origin + 800000); else v.imgConfig.link = asset(origin + 800000); }]) {
      const copy = structuredClone(renewed); mutate(copy); assert.notEqual(r.m.diyAuthoredPageFingerprint([copy]), fp);
    }
    assert.notEqual(JSON.stringify(b), before); assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
}));
for (const kind of kinds) test(`${kind} unsigned/malformed/duplicate/expired actual-slot capabilities reject cache reuse`, () => clock(async () => {
  const r = host(); try { for (const ref of ['/api/assets/7', asset(origin - 1), asset(origin + 60000), asset().replace('&signature='+signature,''), asset()+'&expires=1', asset()+'&%65xpires=1', asset()+'&signature='+signature, asset()+'&%73ignature='+signature]) {
    const page = { value: [block(kind, ref)] }, before = JSON.stringify(page); assert.equal(r.m.diyEditorialMediaCacheUsable(page, origin, origin), false, ref); assert.equal(JSON.stringify(page), before);
  } } finally { r.stop(); }
}));
test('commerce lease does not authorize data API images, unknown/case variants, wrong slots, nested objects or object-like lists', () => clock(async () => {
  const r = host(); try { const value = ['coupon','liveBroadcast','Community','Seckill','pointsmall','unknown'].map(name => ({ name, imgConfig: { url: asset(origin-1) }, imgBgConfig: { url: asset(origin-1) }, tabConfig: { list: [{ image: asset(origin-1) }] }, productList: { list: [{ image: asset(origin-1) }] } }));
    value.push({ name:'promotionList', tabConfig:{list:{0:{image:asset(origin-1)}}} }, { name:'pointsMall', imgColorConfig:{url:asset(origin-1)} }, { name:'seckill', imgConfig2:{url:asset(origin-1)} });
    const before=JSON.stringify(value); assert.equal(r.m.diyEditorialMediaDeadline({value}, origin, origin), Infinity); assert.equal(JSON.stringify(value),before);
    const copy=structuredClone(value); copy[0].productList.list[0].image=asset(); assert.notEqual(r.m.diyAuthoredPageFingerprint(copy),r.m.diyAuthoredPageFingerprint(value)); assert.deepEqual(r.calls,[]);
  } finally { r.stop(); }
}));
test('all promotion tabs beyond12 remain rendered, selectable and tied to their own exact product scope without writes', async () => {
  const list=Array.from({length:33},(_,i)=>({chiild:[{val:`完整分组${i}`},{val:`说明${i}`}],image:`/static/tab-${i}.png`,tabVal:1,goodsList:{ids:[601+i]},numConfig:{val:4},extra:{i}})),before=JSON.stringify(list);
  const r=setup('promotionList',c=>c.url.endsWith('/products')?{data:{list:[product(Number(c.data.ids))],count:1}}:answer(c),{block:{styleConfig:{tabVal:4},tabConfig:{list}}});
  try{await tick();assert.equal(r.c.config.value.tabs.length,33);r.c.selectPromotion(32);await tick();assert.equal(r.c.selectedTab.value,32);assert.equal(calls(r,/\/products$/).at(-1).data.ids,'633');assert.equal(calls(r,/\/products$/).at(-1).data.limit,4);
    const fs=require('node:fs'),sfc=require('@vue/compiler-sfc'),compiler=require('@vue/compiler-dom'),vue=require('vue'),p=path.join(root,'src',component),descriptor=sfc.parse(fs.readFileSync(p,'utf8'),{filename:p}).descriptor,bindings=sfc.compileScript(descriptor,{id:'commerce-full-tabs'}).bindings;
    const render=new Function('Vue',compiler.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:bindings,isCustomElement:tag=>['view','text','image','scroll-view'].includes(tag)}).code)(vue),app=vue.createSSRApp({render,setup:()=>r.checkout});app.use(require('pinia').getActivePinia());const markup=await require('@vue/server-renderer').renderToString(app);
    assert.match(markup,/完整分组32/u);assert.match(markup,/src="\/static\/tab-32.png"/u);assert.equal(writes(r).length,0);assert.equal(JSON.stringify(r.props.block.tabConfig.list),before);
  }finally{r.stop();}
});
test('invalid imported promotion rows before the former12 cutoff do not erase a later valid configured group', async () => {
  const list=[...Array.from({length:14},()=>null),{chiild:[{val:'保留有效尾组'}],tabVal:2,brandConfig:{brandVal:[19]},numConfig:{val:7},extra:{keep:[]}}],r=setup('promotionList',answer,{props:{active:false},block:{tabConfig:{list}}});
  try{assert.equal(r.c.config.value.tabs.length,1);assert.equal(r.c.config.value.tabs[0].label,'保留有效尾组');assert.equal(r.c.config.value.tabs[0].query.brand_id,'19');assert.equal(r.props.block.tabConfig.list.length,15);assert.deepEqual(r.calls,[]);}finally{r.stop();}
});
