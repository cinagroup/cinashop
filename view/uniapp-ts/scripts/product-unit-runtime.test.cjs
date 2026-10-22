const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),vue=require('vue');
const {runtime}=require('./uni-store-runtime.cjs');
const dir=path.resolve(__dirname,'../src');
function compile(r,file){
  const sfc=require('@vue/compiler-sfc'),compiler=require('@vue/compiler-dom'),p=path.join(dir,file);
  const descriptor=sfc.parse(fs.readFileSync(p,'utf8'),{filename:p}).descriptor,bindings=sfc.compileScript(descriptor,{id:'actual-unit-display'}).bindings;
  const render=new Function('Vue',compiler.compile(descriptor.template.content,{mode:'function',prefixIdentifiers:true,bindingMetadata:bindings,isCustomElement:tag=>['view','text','image','rich-text','swiper','swiper-item','video','scroll-view'].includes(tag)}).code)(vue);
  r.load(p).default.render=render;return render;
}
async function detail(unit,isOpen=[1,2]){
  let product;
  const r=runtime({component:'pages/goods/detail.vue',send:c=>c.url.endsWith('/product/detail/70')?{data:product}:c.url.endsWith('/cart/count')?{data:{count:0}}:{data:[]}});
  const value=r.load(path.resolve(__dirname,'../../common/productDetailDesign.ts')).cloneProductDetailDesign();
  Object.assign(value,{isOpen,showService:[],showReply:0,showMatch:0,showRecommend:0,showCommunity:0,showRank:0,openShare:0});
  product={id:70,store_name:'计量单位商品',store_info:'普通商品',image:'/product.png',slider_image:['/product.png'],price:'10.00',stock:17,sales:20,fsales:23,unit_name:unit,spec_type:1,product_type:0,system_form_id:0,cart_button:1,
    productAttr:[{attr_name:'规格',attr_values:['甲','乙']}],attr_value:[{unique:'unit0001',suk:'甲',price:'10.00',ot_price:'12.00',stock:8},{unique:'unit0002',suk:'乙',price:'20.00',ot_price:'22.00',stock:2}],
    product_detail_design:{value,revision:'a'.repeat(64),configured:true,issues:[]}};
  const quote=price=>({enabled:false,price,price_type:'',level_name:'',vip_price:'',level_price:''});
  product.display_price=quote(product.price);
  for(const sku of product.attr_value)sku.display_price=quote(sku.price);
  await r.start({id:'70'});assert.ok(r.checkout.detail.value,r.checkout.loadError.value);
  compile(r,'components/ThemePage.vue');
  const render=compile(r,'pages/goods/detail.vue');
  return {r,view:r.checkout,async html(){const app=vue.createSSRApp({render,setup:()=>r.checkout});app.use(require('pinia').getActivePinia());return (await require('@vue/server-renderer').renderToString(app)).replace(/<!--[\s\S]*?-->/gu,'');}};
}
for(const unit of ['箱','历史自由名','',undefined])test(`ordinary real detail retains unit ${JSON.stringify(unit)} on selected stock and sales without changing quantities`,async()=>{
  const f=await detail(unit);try{const suffix=unit||'';let html=await f.html();assert.match(html,new RegExp(`已售 23${suffix}`));assert.match(html,new RegExp(`库存 8${suffix}`));f.view.pickSku(f.view.skuList.value[1]);html=await f.html();assert.match(html,new RegExp(`库存 2${suffix}`));assert.equal(f.view.selectedSku.value.unique,'unit0002');assert.equal(f.view.selectedSku.value.price,'20.00');assert.equal(f.view.num.value,1);assert.equal(f.r.calls.some(c=>/\/cart\/(add|num|del)$/.test(c.url)),false);}finally{f.r.stop();}
});
for(const [isOpen,sales,stock]of[[[],false,false],[[1],true,false],[[2],false,true]])test(`ordinary design gates ${JSON.stringify(isOpen)} still control unit-bearing quantities`,async()=>{
  const f=await detail('专用单位',isOpen);try{const html=await f.html();assert.equal(html.includes('已售 23专用单位'),sales);assert.equal(html.includes('库存 8专用单位'),stock);if(!sales&&!stock)assert.equal(html.includes('专用单位'),false);}finally{f.r.stop();}
});
test('ordinary unit text is escaped by the real detail template',async()=>{
  const f=await detail('<img onerror=x>');try{const html=await f.html();assert.match(html,/已售 23&lt;img onerror=x&gt;/);assert.equal(html.includes('<img onerror=x>'),false);}finally{f.r.stop();}
});
for(const layout of ['big','row','grid'])test(`actual category ${layout} card preserves PHP sales wording independently of its unit DTO`,async()=>{
  const r=runtime({send:()=>({data:[]})});try{const api=r.load(path.resolve(__dirname,'../../common/categoryCatalog.ts'));
    const product=api.parseCategoryProducts({list:[{id:70,store_name:'单位分类商品',image:'/main.png',price:'19.99',stock:8,sales:23,unit_name:'箱'}],count:1}).list[0];
    compile(r,'components/category/CategoryProductCard.vue');const c=r.load(path.join(dir,'components/category/CategoryProductCard.vue')).default;
    const app=vue.createSSRApp(c,{product,layout,quantity:2,disabled:false});const html=await require('@vue/server-renderer').renderToString(app);assert.match(html,/已售 23/);assert.equal(html.includes("23箱"),false);assert.equal(product.id,70);assert.equal(product.price,'19.99');assert.equal(product.stock,8);assert.equal(r.calls.length,0);
  }finally{r.stop();}
});
test('category camel-case and absent unit DTOs preserve readable legacy counts and safe text rendering',async()=>{
  const r=runtime({send:()=>({data:[]})});try{const api=r.load(path.resolve(__dirname,'../../common/categoryCatalog.ts'));compile(r,'components/category/CategoryProductCard.vue');const c=r.load(path.join(dir,'components/category/CategoryProductCard.vue')).default;
    for(const extra of [{unitName:'袋'},{},{unit_name:'<b>箱</b>'}]){const product=api.parseCategoryProducts({list:[{id:70,store_name:'旧商品',image:'/main.png',price:'19.99',stock:8,sales:3,...extra}],count:1}).list[0];const html=await require('@vue/server-renderer').renderToString(vue.createSSRApp(c,{product,layout:'row',quantity:0,disabled:true}));assert.match(html,/已售 3/);assert.equal(html.includes('3袋'),false);assert.equal(html.includes('3&lt;b&gt;'),false);assert.equal(html.includes('<b>箱</b>'),false);}
  }finally{r.stop();}
});
for(const unit of ['箱','',undefined])test(`real goods grid consumes directory-authored unit ${JSON.stringify(unit)} through its actual route and API`,async()=>{
  const r=runtime({component:'pages/goods/list.vue',send:c=>c.url.endsWith('/products')?{data:{list:[{id:70,store_name:'瀑布流商品',image:'/main.png',price:'19.99',stock:8,sales:23,unit_name:unit}],count:1}}:c.url.endsWith('/category')?{data:[{id:100,pid:0,cate_name:'平台分类',children:[]}]}:{data:[]}});
  try{await r.start({cid:'100'});assert.equal(r.checkout.goods.value.length,1,r.checkout.error.value);compile(r,'components/ThemePage.vue');const render=compile(r,'pages/goods/list.vue');const app=vue.createSSRApp({render,setup:()=>r.checkout});app.use(require('pinia').getActivePinia());const html=await require('@vue/server-renderer').renderToString(app);assert.ok(html.includes('已售 23'+(unit||'')));const call=r.calls.find(c=>c.url.endsWith('/products'));assert.equal(call.data.cid,100);assert.equal(call.data.ids,undefined);assert.equal(r.checkout.goods.value[0].price,'19.99');assert.equal(r.calls.some(c=>/\/cart\/(add|num|del)$/.test(c.url)),false);}finally{r.stop();}
});
for(const [choices,visible]of [[undefined,true],[[3],true],[[],false],[[0,1,2],false],[['3'],false]])test(`real DIY goodList respects PHP checkboxInfo.type ${JSON.stringify(choices)} for the unit-bearing sales row`,async()=>{
  const F=require('./diy-editorial-fixture.cjs'),r=F.setupList('goodList',{block:{goodsList:{ids:[70]},...(choices===undefined?{checkboxInfo:undefined}:{checkboxInfo:{type:choices}})},send:c=>c.url.endsWith('/products')?{data:{list:[F.product(70,{store_name:'DIY单位商品',image:'/main.png',price:'19.99',stock:8,sales:23,unit_name:'箱'})],count:1}}:{data:[]}});
  try{await F.tick();assert.equal(r.c.products.value.length,1,r.c.error.value);compile(r,'components/diy/DiyListProductCard.vue');const component=r.load(path.join(dir,'components/diy/DiyListProductCard.vue')).default;const app=vue.createSSRApp(component,{product:r.c.products.value[0],config:r.c.config.value,disabled:true,allowed:r.c.lease()});app.use(require('pinia').getActivePinia());const html=await require('@vue/server-renderer').renderToString(app);assert.equal(html.replace(/\s+/g,'').includes('已售23箱'),visible);assert.equal(html.includes('DIY单位商品'),choices===undefined||choices.includes(0));assert.equal(html.includes('19.99'),choices===undefined||choices.includes(2));assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).length,1);assert.equal(r.calls.some(c=>/\/cart\/(add|num|del)$/.test(c.url)),false);}finally{r.stop();}
});
