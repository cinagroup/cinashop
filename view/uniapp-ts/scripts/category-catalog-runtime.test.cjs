const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const node = (id, pid, children = []) => ({ id, pid, cate_name: `分类${id}`, pic: '/category.png', big_pic: '/large.png', children });
const tree = () => [node(1,0,[node(11,1,[node(111,11),node(112,11)]),node(12,1,[node(121,12)])]),node(2,0,[node(21,2,[node(211,21)])])];
const product = (id = 70, spec = 0) => ({ id,store_name:`商品${id}`,image:'/product.png',price:'19.99',ot_price:'25.00',vip_price:'',sales:8,stock:8,is_vip:0,is_vip_product:0,cart_button:1,unit_name:'件',star:'5',brand_name:'品牌',spec_type:spec,is_presale_product:0,cart_num:0 });
const detail = (id = 70) => ({ id,storeName:`商品${id}`,image:'/product.png',price:'19.99',stock:8,isVip:1,cart_button:1,specType:1,productType:0,systemFormId:0,
  productAttr:[{attr_name:'颜色',attr_values:['红','蓝']}],attr_value:[
    {unique:'red001',suk:'红',image:'/red.png',price:'19.99',stock:8,member_price:'17.59',price_type:'level',level_name:'银卡',vip_price:'18.00'},
    {unique:'blue001',suk:'蓝',image:'/blue.png',price:'29.99',stock:2,member_price:'26.39',price_type:'level',level_name:'银卡',vip_price:'28.00'},
    {unique:'empty001',suk:'售罄',image:'/empty.png',price:'30.00',stock:0},
  ] });
const decimal = cents => `${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
const cartRow = (quantity=2,id=91) => ({id,productId:70,cartNum:quantity,type:0,unique:'red001',isNew:0,isValid:true,
  productInfo:{price:'19.99',otPrice:'25.00',storeName:'商品70',image:'/red.png',stock:8,suk:'红',systemFormId:0,productType:0},
  sumPrice:decimal(1999n*BigInt(quantity)),truePrice:'17.59',trueSumPrice:decimal(1759n*BigInt(quantity)),priceType:'level',levelName:'银卡'});
function setup({level=2,index=1,component='pages/goods/cate.vue',storage=new Map(),override=()=>undefined,rows=[]}={}) {
  const state={level,index,rows,goods:detail(),pageCount:12};
  const r=runtime({component,storage,send:call=>{
    const special=override(call,state); if(special!==undefined)return special;
    if(call.url.endsWith('/v2/diy/product_detail'))return {data:{product_category:{level:state.level,index:state.index,configured:true,issues:[]}}};
    if(call.url.endsWith('/category'))return {data:tree()};
    if(call.url.endsWith('/products')){const start=(call.data.page-1)*10;return {data:{list:Array.from({length:Math.max(0,Math.min(10,state.pageCount-start))},(_,i)=>product(70+start+i)),count:state.pageCount}};}
    if(call.url.includes('/product/detail/'))return {data:{...state.goods,id:Number(call.url.split('/').at(-1))}};
    if(call.url.endsWith('/cart/list'))return {data:state.rows};
    if(call.url.endsWith('/cart/count'))return {data:{count:state.rows.reduce((n,row)=>n+row.cartNum,0)}};
    if(call.url.endsWith('/cart/add')){if(!call.data.new)state.rows=[cartRow(call.data.cartNum)];return {data:{id:91,cartNum:call.data.cartNum}};}
    if(call.url.endsWith('/cart/num')){state.rows=state.rows.map(row=>row.id===call.data.id?cartRow(call.data.cartNum,row.id):row);return {data:null};}
    if(call.url.endsWith('/cart/del')){state.rows=state.rows.filter(row=>!call.data.ids.includes(row.id));return {data:null};}
    if(call.url.includes('/reply/config/'))return {data:{total:0,avgScore:'0',goodRate:0}};
    if(call.url.includes('/reply/list/')||call.url.includes('/store_discounts/list/'))return {data:[]};
    throw Error(`Unexpected I/O ${call.url}`);
  }});
  return {...r,state};
}
const writes = r => r.calls.filter(call=>/\/cart\/(add|num|del)$/.test(call.url));
test('all ten actual category page configurations select the legacy tree/top/side/filter matrix and real product reads',async()=>{
  const matrix=[[2,0,'tree',false],[2,1,'side-products',true],[2,2,'top-products',false],[2,3,'top-products',true],[2,4,'side-products',false],[2,5,'filter-products',false],[3,0,'tree',false],[3,1,'top-products',true],[3,2,'top-products',false],[3,3,'filter-products',false]];
  for(const [level,index,expected,big] of matrix){const r=setup({level,index});try{await r.start();const p=r.checkout;assert.equal(p.template.value,expected);assert.equal(p.bigCards.value,big);assert.equal(p.miniCart.value,['top-products','side-products'].includes(expected));assert.equal(p.style.value.configured,true);const reads=r.calls.filter(c=>c.url.endsWith('/products'));assert.equal(reads.length,expected==='tree'?0:1);if(reads.length){assert.equal(reads[0].data.cid,1);assert.equal(reads[0].data.is_big,big||expected==='filter-products'?1:0);assert.equal(p.products.value.length,10);}assert.equal(writes(r).length,0);}finally{r.stop();}}
});
test('public category DTO validates configured/issues, exact ordinals and safe recursive hierarchy/media',()=>{
  const r=setup();try{const c=r.load(path.resolve(__dirname,'../../common/categoryCatalog.ts'));
    assert.deepEqual(c.parseCategoryStyle({product_category:{level:2,index:1,configured:false,issues:['category_missing']}}),{level:2,index:1,configured:false,issues:['category_missing']});
    for(const bad of [{level:2,index:6,configured:true,issues:[]},{level:3,index:4,configured:true,issues:[]},{level:2,index:1,configured:'false',issues:[]},{level:2,index:1,configured:true,issues:Array(21).fill('bad')}])assert.throws(()=>c.parseCategoryStyle({product_category:bad}));
    assert.deepEqual(c.categoryScopeForPath(c.categoryPath(c.parseCategoryTree(tree()),112)),{cid:1,sid:11,tid:112});assert.equal(c.parseCategoryTree(tree())[0].big_pic,'/large.png');
    assert.throws(()=>c.parseCategoryTree([node(1,0,[node(2,7)])]));assert.throws(()=>c.parseCategoryTree([node(1,0),node(1,0)]));assert.equal(c.categoryImage('/a/..//evil.test'),'');assert.equal(c.categoryImage('javascript:alert(1)'),'');
    assert.equal(c.parseCategoryProducts({list:[product()],count:1}).list[0].vip_price,'');assert.equal(c.categoryListUrl({cid:1,sid:11,tid:111}),'/pages/goods/list?cid=1&sid=11&tid=111');for(const bad of ['01','0','1e2', ['1','2']])assert.throws(()=>c.categoryQuery({tid:bad}));
  }finally{r.stop();}
});
test('layout failures and missing configuration display an explicit old 2/1 fallback without any write',async()=>{
  const r=setup({override:c=>c.url.endsWith('/v2/diy/product_detail')?{transport:'offline'}:undefined});try{await r.start();assert.equal(r.checkout.template.value,'side-products');assert.equal(r.checkout.style.value.configured,false);assert.match(r.checkout.styleError.value,/默认/);assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('home category selection locates a third-level path and tree links preserve distinct cid/sid/tid',async()=>{
  const storage=new Map([['cate_selected',111]]),r=setup({level:3,index:0,storage});try{await r.start();const p=r.checkout;assert.deepEqual(p.scope.value,{cid:1,sid:11,tid:111});assert.equal(storage.has('cate_selected'),false);p.navigateScope({cid:1,sid:11,tid:112});assert.equal(r.navigations.at(-1),'/pages/goods/list?cid=1&sid=11&tid=112');assert.equal(writes(r).length,0);}finally{r.stop();}
  const two=setup({level:2,index:0,storage:new Map([['cate_selected',21]])});try{await two.start();assert.equal(two.checkout.primary.value.id,2);assert.equal(two.checkout.scrollTarget.value,'cate-section-2');assert.equal(writes(two).length,0);}finally{two.stop();}
});
test('three-level product selection resets downstream filters/page and discards a late old-filter page',async()=>{
  const gate=deferred();let slow=false;const r=setup({level:3,index:1,override:c=>c.url.endsWith('/products')&&slow?gate.promise:undefined});try{await r.start();const p=r.checkout;slow=true;p.selectSecondary(11);await tick();slow=false;p.selectThird(112);await tick();assert.equal(p.scope.value.tid,112);const latest=r.calls.filter(c=>c.url.endsWith('/products')).at(-1);assert.deepEqual(latest.data,{cid:1,sid:11,tid:112,page:1,limit:10,is_big:1});gate.resolve({data:{list:[product(999)],count:1}});await tick();assert.equal(p.products.value.some(item=>item.id===999),false);p.openMore('third');assert.deepEqual(p.drawerChoices.value.map(item=>item.id),[111,112]);p.openMore('primary');assert.deepEqual(p.drawerChoices.value.map(item=>item.id),[1,2]);p.chooseMore(2);await tick();assert.deepEqual(p.scope.value,{cid:2});p.openMore('secondary');assert.deepEqual(p.drawerChoices.value.map(item=>item.id),[21]);}finally{gate.resolve({data:{list:[],count:0}});r.stop();}
});

test('tree scroll synchronizes the left selection from measured section offsets and ignores stale measurement callbacks',async()=>{
  const r=setup({level:2,index:0});const callbacks=[];
  r.uni.createSelectorQuery=()=>{const query={in(){return query;},selectAll(){return {boundingClientRect(){return query;}};},select(){return {boundingClientRect(){return query;},scrollOffset(){return query;}};},exec(fn){callbacks.push(fn);}};return query;};
  try{await r.start();const p=r.checkout;assert.ok(callbacks.length);const publish=callbacks.at(-1);publish([[{top:20},{top:220}],{top:20},{scrollTop:0}]);p.treeScroll({detail:{scrollTop:0}});p.treeScroll({detail:{scrollTop:210}});assert.equal(p.primary.value.id,2);p.choosePrimary(1);await tick();assert.equal(p.scrollTarget.value,'cate-section-1');p.treeScroll({detail:{scrollTop:0}});assert.equal(p.primary.value.id,1);r.hooks.onHide();publish([[{top:20},{top:220}],{top:20},{scrollTop:0}]);p.treeScroll({detail:{scrollTop:210}});assert.equal(p.primary.value.id,1);}finally{r.stop();}
});
test('filter drawer edits a draft with expand/reset and requests only on explicit confirm; hide restores tabbar',async()=>{
  const r=setup({level:3,index:3}),platform=[],callbacks=[];let autoSuccess=true;
  const native=(mode,options)=>{platform.push(mode);callbacks.push({mode,options});assert.equal(typeof options.fail,'function');assert.equal(typeof options.success,'function');if(autoSuccess)options.success({errMsg:mode+'TabBar:ok'});};
  r.uni.hideTabBar=options=>native('hide',options);r.uni.showTabBar=options=>native('show',options);try{await r.start();const p=r.checkout,reads=r.calls.filter(c=>c.url.endsWith('/products')).length;p.openDrawer('filter');p.selectThird(112,true,11);p.toggleExpanded(11);assert.deepEqual(p.expanded.value,[11]);assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).length,reads);assert.deepEqual(p.scope.value,{cid:1});p.applyFilter();await tick();assert.deepEqual(p.scope.value,{cid:1,sid:11,tid:112});assert.equal(platform.join(','),'hide,show');
    await p.purchase.open(product(70,1));assert.equal(platform.at(-1),'hide');p.purchase.cartOpen.value=true;p.purchase.close();assert.equal(platform.at(-1),'hide');p.purchase.cartOpen.value=false;assert.equal(platform.at(-1),'show');p.openMore('primary');assert.equal(platform.at(-1),'hide');p.closeDrawer();assert.equal(platform.at(-1),'show');
    p.openDrawer('filter');p.selectPrimary(2,true);p.resetFilter();assert.deepEqual(p.draft.value,{cid:1});r.hooks.onHide();assert.equal(p.drawer.value,null);assert.equal(platform.at(-1),'show');r.hooks.onShow();await tick();await p.purchase.open(product(70,1));assert.equal(platform.at(-1),'hide');r.auth.setLogin('actor22',22);assert.equal(p.purchase.opened.value,false);assert.equal(platform.at(-1),'show');await tick();
    const journal=JSON.stringify({version:1,actor:22,state:'unknown',mode:'cart',productId:70,unique:'red001',quantity:1,cartId:null});r.storage.set('cinashop_category_purchase_v1_22',journal);autoSuccess=false;
    p.openDrawer('filter');const failedHide=callbacks.at(-1).options;failedHide.fail({errMsg:'hideTabBar:fail current platform error'});assert.match(p.tabbarError.value,/暂未收起/);assert.equal(p.tabbarPending.value,false);p.retryNativeTabbar();const retryHide=callbacks.at(-1).options;assert.equal(p.tabbarPending.value,true);retryHide.success({errMsg:'hideTabBar:ok'});assert.equal(p.tabbarError.value,'');failedHide.fail({errMsg:'old hide failure'});assert.equal(p.tabbarError.value,'');
    p.closeDrawer();callbacks.at(-1).options.fail({errMsg:'showTabBar:fail current platform error'});assert.match(p.tabbarError.value,/暂未恢复/);p.retryNativeTabbar();callbacks.at(-1).options.success({errMsg:'showTabBar:ok'});assert.equal(p.tabbarError.value,'');
    p.openDrawer('filter');const lateHide=callbacks.at(-1).options;r.hooks.onHide();const offPageShow=callbacks.at(-1).options;assert.equal(platform.at(-1),'show');lateHide.fail({errMsg:'old hide failure'});offPageShow.fail({errMsg:'showTabBar:fail not TabBar page'});assert.equal(p.tabbarError.value,'');assert.equal(p.tabbarPending.value,false);assert.equal(r.storage.get('cinashop_category_purchase_v1_22'),journal);
    r.hooks.onShow();await tick();lateHide.success({errMsg:'old hide success'});assert.equal(p.tabbarError.value,'');p.openDrawer('filter');assert.equal(platform.at(-1),'hide');const oldActorHide=callbacks.at(-1).options;r.auth.setLogin('actor33',33);oldActorHide.fail({errMsg:'old actor failure'});assert.equal(p.tabbarError.value,'');assert.equal(r.storage.get('cinashop_category_purchase_v1_22'),journal);await tick();p.purchase.cartOpen.value=true;assert.equal(platform.at(-1),'hide');r.hooks.onUnload();assert.equal(platform.at(-1),'show');callbacks.at(-1).options.fail({errMsg:'showTabBar:fail not TabBar page'});assert.equal(p.tabbarError.value,'');assert.equal(r.storage.get('cinashop_category_purchase_v1_22'),journal);
  }finally{r.stop();}
});
test('product pagination and sorting preserve current scope, retry a failed page, and never append a stale page',async()=>{
  let fail=true;const r=setup({override:c=>c.url.endsWith('/products')&&c.data.page===2&&fail?{transport:'page two offline'}:undefined});try{await r.start();const p=r.checkout;await p.readProducts();assert.equal(p.products.value.length,10);assert.equal(p.catalog.page.value,2);assert.match(p.productError.value,/offline/);fail=false;await p.readProducts();assert.equal(p.products.value.length,12);assert.equal(p.hasMore.value,false);p.setSort('price_desc');await tick();assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).at(-1).data.priceOrder,'desc');assert.equal(p.catalog.page.value,2);}finally{r.stop();}
});
test('late catalogue reads after hiding or account switch cannot publish an old actor tree/products',async()=>{
  const gate=deferred();let slow=true;const r=setup({override:c=>c.url.endsWith('/category')&&slow?gate.promise:undefined});try{await r.start();r.hooks.onHide();slow=false;r.auth.setLogin('actor22',22);r.hooks.onShow();await tick();gate.resolve({data:[node(9,0)]});await tick();assert.equal(r.checkout.tree.value[0].id,1);assert.equal(r.checkout.products.value[0].id,70);assert.equal(writes(r).length,0);}finally{gate.resolve({data:tree()});r.stop();}
});
test('ordinary multi-SKU selection consumes actual images/member quotes and clamps quantity on a smaller SKU',async()=>{
  const r=setup();try{await r.start();const p=r.checkout.purchase;await p.open(product(70,1));assert.equal(p.sku.value.image,'/red.png');assert.equal(p.price.value,'17.59');p.setQuantity('7');p.choose('blue001');assert.equal(p.quantity.value,2);assert.equal(p.maximum.value,2);assert.equal(p.price.value,'26.39');p.choose('empty001');assert.equal(p.maximum.value,0);await p.purchase();assert.equal(writes(r).length,0);p.choose('red001');p.setQuantity('1e2');await p.purchase();assert.match(p.error.value,/整数/);assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('single SKU quick add uses actual unique and type0/new0, then reads authoritative cart/count',async()=>{
  const r=setup();r.state.goods={...detail(),specType:0,productAttr:[],attr_value:[detail().attr_value[0]]};try{await r.start();await r.checkout.purchase.open(product(),'cart',true);const post=writes(r).find(c=>c.url.endsWith('/cart/add'));assert.deepEqual(post.data,{productId:70,unique:'red001',cartNum:1,type:0,new:0});assert.equal(r.checkout.purchase.quantityInCart(70),1);assert.equal(r.checkout.cartSubtotal.value,'17.59');assert.equal(r.checkout.purchase.locked.value,false);assert.equal(r.storage.has('cinashop_category_purchase_v1_11'),false);}finally{r.stop();}
});
test('mini cart uses exact server totals, updates quantity, deletes zero and excludes invalid lines from checkout',async()=>{
  const r=setup({rows:[cartRow(),{...cartRow(1,92),isValid:false,productInfo:null}]});try{await r.start();const p=r.checkout;assert.equal(p.cartSubtotal.value,'35.18');await p.purchase.changeCard(product(),1);assert.equal(p.cartSubtotal.value,'52.77');await p.purchase.changeCard(product(),-1,'0');assert.deepEqual(r.state.rows.map(item=>item.id),[92]);assert.equal(p.cartSubtotal.value,'0.00');await p.purchase.checkoutCart();assert.equal(r.navigations.length,0);assert.match(p.purchase.error.value,/可结算/);r.state.rows=[cartRow()];await p.purchase.checkoutCart();assert.equal(r.navigations.at(-1),'/pages/order/confirm');assert.deepEqual(p.cart.checkedItems.map(item=>item.id),[91]);}finally{r.stop();}
});
test('cart clear waits for an actor-owned confirmation and removes all actual row IDs',async()=>{
  const r=setup({rows:[cartRow(),{...cartRow(1,92),isValid:false,productInfo:null}]});let callback;r.uni.showModal=options=>{callback=options.success;};try{await r.start();r.checkout.confirmClear();assert.equal(writes(r).length,0);callback({confirm:true});await tick();assert.deepEqual(writes(r).at(-1).data,{ids:[91,92]});assert.equal(r.checkout.cart.items.length,0);r.state.rows=[cartRow()];await r.checkout.cart.fetchList();r.checkout.confirmClear();r.auth.setLogin('new',22);callback({confirm:true});await tick();assert.equal(writes(r).length,1);}finally{r.stop();}
});
test('anonymous, presale and custom-form cards cannot bypass the real detail/login gates',async()=>{
  const r=setup();try{await r.start();const p=r.checkout.purchase;r.auth.clear();await tick();await p.open(product(),'cart',true);assert.equal(r.navigations.at(-1),'/pages/auth/login');r.auth.setLogin('logged',11);await tick();await p.open({...product(),is_presale_product:1});assert.equal(r.navigations.at(-1),'/pages/activity/presaleDetail?id=70');r.state.goods={...detail(),cart_button:0};await p.open(product());assert.equal(r.navigations.at(-1),'/pages/goods/detail?id=70');assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('unknown category add survives failed/successful cart reads, hide/show and app refresh without a second POST',async()=>{
  let cartFails=false;const storage=new Map(),r=setup({storage,override:c=>c.url.endsWith('/cart/add')?{transport:'unknown submit'}:c.url.endsWith('/cart/list')&&cartFails?{transport:'cart offline'}:undefined});try{await r.start();const p=r.checkout.purchase;await p.open(product(70,1));await p.purchase();assert.equal(p.recovery.value.state,'unknown');assert.equal(p.locked.value,true);cartFails=true;await p.reread();assert.equal(p.locked.value,true);cartFails=false;await p.reread();assert.equal(p.locked.value,true);r.hooks.onHide();r.hooks.onShow();await tick();await p.open(product(71,1));await p.purchase();assert.equal(writes(r).length,1);assert.match(p.error.value,/尚未确认/);}finally{r.stop();}
  const next=setup({storage});try{await next.start();await next.checkout.purchase.open(product());await next.checkout.purchase.purchase();assert.equal(writes(next).length,0);assert.equal(next.checkout.purchase.locked.value,true);assert.equal(next.storage.has('cinashop_category_purchase_v1_11'),true);}finally{next.stop();}
});
test('late SKU/add responses after actor replacement do not navigate, toast or overwrite the old actor journal',async()=>{
  const gate=deferred();const r=setup({override:c=>c.url.endsWith('/cart/add')?gate.promise:undefined});try{await r.start();const p=r.checkout.purchase;await p.open(product(70,1));const pending=p.purchase();await tick();r.auth.setLogin('actor22',22);await tick();gate.resolve({data:{id:91}});await pending;assert.equal(r.navigations.length,0);assert.equal(r.toasts.length,0);assert.equal(JSON.parse(r.storage.get('cinashop_category_purchase_v1_11')).state,'unknown');assert.equal(r.storage.has('cinashop_category_purchase_v1_22'),false);assert.equal(p.recovery.value,null);}finally{gate.resolve({data:{id:91}});r.stop();}
});
test('category unknown protection is enforced by the actual ordinary detail page after navigation and refresh',async()=>{
  const unknown={version:1,actor:11,state:'unknown',mode:'cart',productId:70,unique:'red001',quantity:1,cartId:null};
  const storage=new Map([['cinashop_category_purchase_v1_11',JSON.stringify(unknown)]]),r=setup({component:'pages/goods/detail.vue',storage});try{await r.start({id:'70'});const p=r.checkout;assert.equal(p.ordinaryLocked.value,true);p.openSku('buy');await p.confirmSku();p.restartPurchase();await tick();assert.equal(writes(r).length,0);assert.equal(storage.get('cinashop_category_purchase_v1_11'),JSON.stringify(unknown));assert.equal(r.navigations.at(-1),'/pages/cart/index');}finally{r.stop();}
});
test('acknowledged ordinary buy persists its same cart across navigation failure and page refresh without another add',async()=>{
  const storage=new Map(),r=setup({component:'pages/goods/detail.vue',storage});r.uni.navigateTo=options=>options.fail?.();try{await r.start({id:'70'});r.checkout.openSku('buy');await r.checkout.confirmSku();assert.equal(JSON.parse(storage.get('cinashop_category_purchase_v1_11')).cartId,91);await r.checkout.confirmSku();assert.equal(writes(r).length,1);}finally{r.stop();}
  const next=setup({component:'pages/goods/detail.vue',storage});try{await next.start({id:'70'});assert.equal(next.checkout.preparedCart.value.ids[0],91);next.checkout.resumeCheckout();assert.equal(next.navigations.at(-1),'/pages/order/confirm?mode=buy&cartId=91&from=sku');assert.equal(writes(next).length,0);}finally{next.stop();}
});
test('goods-list actual route consumes sid/tid, recursively highlights its parent and rejects duplicate/invalid IDs',async()=>{
  const r=setup({component:'pages/goods/list.vue'});try{await r.start({cid:'1',sid:'11',tid:'111'});const call=r.calls.find(c=>c.url.endsWith('/products'));assert.equal(call.data.sid,11);assert.equal(call.data.tid,111);assert.equal(r.checkout.activeCateId.value,1);r.checkout.switchCate(2);await tick();const changed=r.calls.filter(c=>c.url.endsWith('/products')).at(-1);assert.equal(changed.data.cid,2);assert.equal(changed.data.sid,undefined);assert.equal(changed.data.tid,undefined);r.checkout.setRoute({tid:['111','112']});await r.checkout.fetch(true);assert.match(r.checkout.error.value,/标识/);}finally{r.stop();}
});
