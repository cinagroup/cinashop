const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), vue = require('vue');
const {runtime,tick}=require('./uni-store-runtime.cjs');
const goods=(extra={})=>({id:80,store_name:'推荐图商品',image:'/main.png',recommend_image:'/recommend.png',price:'19.99',stock:8,sales:3,...extra});
function setup(level=2,index=1){return runtime({component:'pages/goods/cate.vue',send:call=>{
  if(call.url.endsWith('/v2/diy/product_detail'))return {data:{product_category:{level,index,configured:true,issues:[]}}};
  if(call.url.endsWith('/category'))return {data:[{id:1,pid:0,cate_name:'分类',pic:'/category.png',big_pic:'',children:[{id:11,pid:1,cate_name:'子分类',pic:'',big_pic:'',children:[]}]}]};
  if(call.url.endsWith('/products'))return {data:{list:[goods()],count:1}};
  if(call.url.endsWith('/cart/list'))return {data:[]};
  if(call.url.endsWith('/cart/count'))return {data:{count:0}};
  throw Error('Unexpected actual category request: '+call.url);
}});}
function card(r,product=goods(),layout='big'){
  const props=vue.reactive({product,layout,quantity:0,disabled:false}),events=[],scope=vue.effectScope();
  const view=scope.run(()=>r.load(path.resolve(__dirname,'../src/components/category/CategoryProductCard.vue')).default.setup(props,{emit:(...args)=>events.push(args),expose(){}}));
  return {props,view,events,stop:()=>scope.stop()};
}
for(const [level,index,big]of[[2,0,false],[2,1,true],[2,2,false],[2,3,true],[2,4,false],[2,5,false],[3,0,false],[3,1,true],[3,2,false],[3,3,false]])test(`actual category ${level}/${index} preserves recommendation projection and uses ${big?'big recommendation':'main image or tree'}`,async()=>{
  const r=setup(level,index);let c;try{await r.start();assert.equal(r.checkout.bigCards.value,big);const products=r.checkout.products.value;
    if(index===0){assert.equal(products.length,0);assert.equal(r.calls.some(call=>call.url.endsWith('/products')),false);return;}
    assert.equal(products[0].recommend_image,'/recommend.png');assert.equal(products[0].image,'/main.png');
    c=card(r,products[0],big?'big':index===(level===2?5:3)?'grid':'row');assert.equal(c.view.displayedImage.value.src,big?'/recommend.png':'/main.png');assert.equal(c.view.displayedImage.value.recommendation,big);
    if(index===(level===2?5:3))assert.equal(r.calls.find(call=>call.url.endsWith('/products')).data.is_big,1);
    assert.equal(r.calls.some(call=>/\/cart\/(add|num|del)$/.test(call.url)),false);
  }finally{c?.stop();r.stop();}
});
test('actual recommendation image load failure falls back to main and then to the existing missing-image state',()=>{
  const r=setup(),c=card(r);try{const recommendation=c.view.displayedImage.value;recommendation.onError();assert.equal(c.view.displayedImage.value.src,'/main.png');assert.equal(c.view.displayedImage.value.recommendation,false);recommendation.onError();assert.equal(c.view.displayedImage.value.src,'/main.png');c.view.displayedImage.value.onError();assert.equal(c.view.displayedImage.value.src,'');assert.equal(c.events.length,0);}finally{c.stop();r.stop();}
});
test('stale image errors cannot poison a new product or an identity and source ABA',async()=>{
  const r=setup(),c=card(r);try{const old=c.view.displayedImage.value;const original=c.props.product;c.props.product=goods({id:81,recommend_image:'/other.png'});await tick();old.onError();assert.equal(c.view.displayedImage.value.src,'/other.png');c.props.product=original;await tick();old.onError();assert.equal(c.view.displayedImage.value.src,'/recommend.png');c.props.product.recommend_image='/new.png';await tick();assert.equal(c.view.displayedImage.value.src,'/new.png');const detached=c.view.displayedImage.value;c.props.layout='grid';await tick();detached.onError();assert.equal(c.view.displayedImage.value.src,'/main.png');c.props.layout='big';await tick();assert.equal(c.view.displayedImage.value.src,'/new.png');}finally{c.stop();r.stop();}
});
test('quantity and disabled changes preserve image failure state and existing input-event contract',async()=>{
  const r=setup(),c=card(r);try{c.view.displayedImage.value.onError();c.props.quantity=2;await tick();assert.equal(c.view.displayedImage.value.src,'/main.png');c.view.inputQuantity({detail:{value:'3'}});assert.deepEqual(c.events,[['quantity','3']]);c.props.disabled=true;c.view.inputQuantity({detail:{value:'4'}});assert.equal(c.events.length,1);assert.equal(c.view.displayedImage.value.src,'/main.png');}finally{c.stop();r.stop();}
});
test('recommendation parsing accepts the full256 static boundary and preserves a valid signed private ticket separately from main',()=>{
  const r=setup();try{const api=r.load(path.resolve(__dirname,'../../common/categoryCatalog.ts')),boundary='https://images.invalid/'+'x'.repeat(233),expires=Math.floor(Date.now()/1000)+900,ticket=`/api/assets/31?expires=${expires}&signature=${'a'.repeat(43)}`;
    assert.equal(boundary.length,256);assert.equal(api.categoryRecommendationImage(boundary),boundary);assert.equal(api.categoryRecommendationImage(boundary+'x'),'');
    const parsed=api.parseCategoryProducts({list:[goods({recommend_image:ticket})],count:1}).list[0];assert.equal(parsed.recommend_image,ticket);assert.equal(parsed.image,'/main.png');assert.equal(parsed.id,80);assert.equal(parsed.stock,8);assert.equal(parsed.price,'19.99');
    assert.equal(api.parseCategoryProducts({list:[goods({recommend_image:undefined,recommendImage:'/camel.png'})],count:1}).list[0].recommend_image,'/camel.png');
  }finally{r.stop();}
});
for(const value of ['',null,false,{},'javascript:alert(1)','http://unsafe.invalid/a.png','//unsafe.invalid/a.png','https://user:pass@images.invalid/a.png','/api/assets/31','/api/assets/0','/api%2fassets/31',`/api/assets/31?expires=1&signature=${'a'.repeat(43)}`,`/api/assets/31?expires=9999999999&signature=${'a'.repeat(43)}`])test(`unavailable recommendation ${JSON.stringify(value)} uses main without changing purchase metadata`,()=>{
  const r=setup(),c=card(r,goods({recommend_image:value}));try{assert.equal(c.view.displayedImage.value.src,'/main.png');assert.equal(c.view.displayedImage.value.recommendation,false);assert.equal(c.props.product.id,80);assert.equal(c.props.product.price,'19.99');assert.equal(c.props.product.stock,8);assert.equal(c.events.length,0);}finally{c.stop();r.stop();}
});
