const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {runtime,tick,deferred}=require('./uni-store-runtime.cjs');
const row=(id,extra={})=>({id,store_name:'推荐商品'+id,brand_name:'原版品牌',price:'12.30',is_vip:1,vip_price:'9.90',price_type:'member',
 image_source:'https://images.example/item-'+id+'.png',image:'https://images.example/item-'+id+'.png',
 activity_frame:[],store_label:[],is_presale_product:0,activity:'0,1,2,3',
 recommendation_target:{version:1,product_id:id,kind:'product',id,ends_at:null},...extra});
const rows=(page,n=10)=>Array.from({length:n},(_,i)=>row(100+(page-1)*10+i));
const envelope=(owner,page,list=rows(page))=>({owner_uid:owner,page,limit:10,list});
const overview=(owner=11,enabled=true)=>({actor_uid:owner,enabled,level_active:true,preview_only:false,current_level_id:0,current_grade:null,exp:'42.75',levels:[],task:{sign_count:0,sign:'1',order:'1.25',invite:'25',sign_enabled:enabled}});
async function start(options={}){
 const traces=[];const r=runtime({feature:'useMemberLevelRecommendations',component:options.component,authenticated:options.authenticated??true,platform:options.platform,navigationFails:options.navigationFails,
 send:c=>{const url=new URL(c.url,'https://local.invalid'),owner=c.header['Authori-zation']==='Bearer other'?22:11;
  const trace={path:url.pathname,method:c.method,data:structuredClone(c.data),auth:c.header['Authori-zation'],form:c.header['Form-type']};traces.push(trace);
  assert.equal(c.method,'GET');
  const result=options.send?.(c,owner);if(result!==undefined)return result;
  if(url.pathname.endsWith('/level/detection'))return{data:true};
  if(url.pathname.endsWith('/level/info'))return{data:{overview:overview(owner,options.enabled??true)}};
  assert.equal(url.pathname,'/api/product/hot');assert.deepEqual(c.data,{view:'member_level',page:c.data.page,limit:10});
  return{data:envelope(owner,c.data.page,options.rows?.(c.data.page)??rows(c.data.page,c.data.page===3?2:10))};
 }});await r.start();return{...r,traces};
}
const hot=r=>r.traces.filter(t=>t.path==='/api/product/hot');
test('entry reads the real hot contract10 at a time, fences overlapping scrolls, appends10/10/2 and stops',async()=>{
 const pending=deferred();let block=true;const r=await start({send:c=>c.data.page===2&&block?pending.promise:undefined}),s=r.checkout;
 assert.equal(s.products.value.length,10);assert.equal(s.page.value,1);assert.deepEqual(hot(r).map(v=>v.data.page),[1]);
 const read=s.load(true);r.hooks.onReachBottom();await s.load(true);await tick();assert.deepEqual(hot(r).map(v=>v.data.page),[1,2]);
 block=false;pending.resolve({data:envelope(11,2)});await read;assert.equal(s.products.value.length,20);
 r.hooks.onReachBottom();await tick();assert.equal(s.products.value.length,22);assert.equal(s.page.value,3);assert.equal(s.hasMore.value,false);
 r.hooks.onReachBottom();await s.load(true);assert.deepEqual(hot(r).map(v=>v.data.page),[1,2,3]);assert.deepEqual(r.modals,[]);r.stop();
});
test('append transport refusal retains the first page and retries exactly the failed next page',async()=>{
 let fail=true;const r=await start({send:c=>c.data.page===2&&fail?{transport:'offline'}:undefined}),s=r.checkout;
 await s.load(true);assert.equal(s.products.value.length,10);assert.equal(s.page.value,1);assert.match(s.error.value,/offline/);
 r.hooks.onReachBottom();await tick();assert.deepEqual(hot(r).map(v=>v.data.page),[1,2]);
 fail=false;await s.retry();assert.equal(s.products.value.length,20);assert.equal(s.page.value,2);assert.equal(s.error.value,'');assert.deepEqual(hot(r).map(v=>v.data.page),[1,2,2]);r.stop();
});
test('cross-page duplicates reject the complete response without silently skipping products or advancing',async()=>{
 const r=await start({rows:p=>p===2?[...rows(2).slice(0,9),row(100)]:rows(p)}),s=r.checkout;
 await s.load(true);assert.equal(s.page.value,1);assert.equal(s.products.value.length,10);assert.match(s.error.value,/分页已变化/);
 await s.refresh();assert.equal(s.page.value,1);assert.equal(s.error.value,'');assert.deepEqual(hot(r).map(v=>v.data.page),[1,2,1]);r.stop();
});
test('empty recommendation response omits all cards and makes no implicit follow-up reads',async()=>{
 const r=await start({rows:()=>[]});assert.deepEqual(r.checkout.items.value,[]);assert.equal(r.checkout.hasMore.value,false);r.hooks.onReachBottom();await tick();assert.equal(hot(r).length,1);r.stop();
});
test('guest makes no request, navigation or confirmation dialog',async()=>{
 const r=await start({authenticated:false});await r.checkout.load();await r.checkout.retry();r.checkout.openProduct(100);r.hooks.onReachBottom();await tick();assert.deepEqual(r.traces,[]);assert.deepEqual(r.navigations,[]);assert.deepEqual(r.modals,[]);r.stop();
});
for(const event of ['onHide','onUnload','owner','logout','renew'])test('late old page response cannot repopulate the feed after '+event,async()=>{
 const pending=deferred();let first=true;const r=await start({send:c=>c.data.view==='member_level'&&first?(first=false,pending.promise):undefined}),s=r.checkout;
 assert.equal(s.loading.value,true);
 if(event==='owner')r.auth.setLogin('other',22);else if(event==='logout')r.auth.clear();else if(event==='renew')r.auth.setLogin(r.auth.token,11);else r.hooks[event]();
 pending.resolve({data:envelope(11,1,[row(999)])});await tick();assert.ok(!s.products.value.some(v=>v.id===999));
 if(['onHide','onUnload','logout'].includes(event))assert.equal(s.products.value.length,0);
 if(event==='owner')assert.equal(hot(r).at(-1).auth,'Bearer other');
 assert.deepEqual(r.modals,[]);r.stop();
});
for(const variant of ['wrong-owner','wrong-page','wrong-limit','extra-envelope','numeric-price','duplicate-id','over-page','invalid-id','invalid-frame','duplicate-label'])test('strict real response rejects '+variant,async()=>{
 const data=envelope(11,1);
 if(variant==='wrong-owner')data.owner_uid=22;if(variant==='wrong-page')data.page=2;if(variant==='wrong-limit')data.limit=15;if(variant==='extra-envelope')data.next=2;
 if(variant==='numeric-price')data.list[0].price=12.3;if(variant==='duplicate-id')data.list[1].id=data.list[0].id;if(variant==='over-page')data.list.push(row(999));if(variant==='invalid-id')data.list[0].id=0;
 if(variant==='invalid-frame')data.list[0].activity_frame=[{id:1}];if(variant==='duplicate-label')data.list[0].store_label=Array.from({length:2},()=>({id:1,label_name:'标签',color:'#333',bg_color:'#fff',border_color:'',icon:''}));
 const r=await start({send:()=>({data})});assert.equal(r.checkout.page.value,0);assert.equal(r.checkout.products.value.length,0);assert.match(r.checkout.error.value,/不完整/);r.stop();
});
test('ordinary and activity routes use actual projected IDs, preserve exact prices, and never cart or award growth',async()=>{
 const end=new Date(Date.now()+3600000).toISOString();const list=[row(100),row(101,{activity:'1,0,2,3',recommendation_target:{version:1,product_id:101,kind:'seckill',id:7001,ends_at:end}})];
 const r=await start({rows:()=>list}),s=r.checkout;assert.equal(s.items.value[0].price,'12.30');assert.equal(s.items.value[0].vipPrice,'9.90');assert.equal(s.items.value[0].vipOffer,true);
 s.openProduct(100);s.openProduct(101);assert.deepEqual(r.navigations,['/pages/goods/detail?id=100']);
 r.hooks.onHide();r.hooks.onShow();await tick();s.openProduct(101);assert.equal(r.navigations.at(-1),'/pages/activity/seckillDetail?id=7001');assert.ok(r.traces.every(v=>v.path==='/api/product/hot'&&v.method==='GET'));r.stop();
});
test('ordinary level offers never acquire an SVIP label when the paid price right is disabled',async()=>{
 const r=await start({rows:()=>[row(100,{price_type:'level',vip_price:'11.07'}),row(101,{price_type:'',vip_price:'0.00'}),row(102,{is_vip:0,price_type:'level',vip_price:'11.07'})]});
 const [level,none,plain]=r.checkout.items.value;assert.equal(level.price,'12.30');assert.equal(level.vipPrice,'11.07');assert.equal(level.vipOffer,false);assert.equal(level.levelOffer,true);assert.equal(none.vipOffer,false);assert.equal(none.levelOffer,false);assert.equal(plain.vipOffer,false);assert.equal(plain.levelOffer,true);r.stop();
});
test('expired or malformed activity authority never falls back to an invented product/activity ID',async()=>{
 const list=[row(100,{activity:'1,0,2,3',recommendation_target:{version:1,product_id:100,kind:'seckill',id:7001,ends_at:'2020-01-01T00:00:00.000Z'}}),row(101,{recommendation_target:{version:1,product_id:999,kind:'product',id:101,ends_at:null}})];
 const r=await start({rows:()=>list});r.checkout.openProduct(100);r.checkout.openProduct(101);assert.deepEqual(r.navigations,[]);assert.match(r.toasts[0].title,/活动已结束/);assert.match(r.toasts[1].title,/待确认/);r.stop();
});
test('native navigation failure is explicit and can retry without rereading or writing',async()=>{
 const r=await start({navigationFails:true});r.checkout.openProduct(100);assert.equal(r.checkout.navigating.value,false);r.checkout.openProduct(100);assert.equal(r.navigations.length,2);assert.equal(hot(r).length,1);assert.match(r.toasts[0].title,/打开失败/);r.stop();
});
test('signed main/frame/label media map the native API origin, and a failed slot immediately falls back',async()=>{
 for(const platform of ['H5','MP-WEIXIN','APP-PLUS']){
  const expires=Math.floor(Date.now()/1000)+3600,src=id=>'/api/assets/'+id+'?expires='+expires+'&signature='+'a'.repeat(43);
  const list=[row(100,{image_source:'/api/assets/1',image:src(1),activity_frame:{id:71,name:'活动边框',image_source:'/api/assets/2',image:src(2)},store_label:[{id:1,label_name:'精选',icon:src(3),color:'#123456',bg_color:'#fff',border_color:'#123456'}]})];
  const r=await start({platform,rows:()=>list}),s=r.checkout,prefix=platform==='H5'?'':'https://cinashop-api.cinagroup.workers.dev';
  assert.equal(s.items.value[0].image.src,prefix+src(1));assert.equal(s.items.value[0].frameImage.src,prefix+src(2));assert.equal(s.items.value[0].labels[0].image.src,prefix+src(3));
  s.items.value[0].frameImage.error();assert.equal(s.items.value[0].frameImage.src,'');assert.equal(s.items.value[0].image.src,prefix+src(1));assert.equal(hot(r).length,1);r.stop();
 }
});
test('media mismatch, hostile URL and unsafe label colors do not become image or style authority',async()=>{
 const expiry=Math.floor(Date.now()/1000)+3600,src='/api/assets/2?expires='+expiry+'&signature='+'a'.repeat(43);
 const r=await start({rows:()=>[row(100,{image_source:'/api/assets/1',image:src,activity_frame:{id:1,name:'frame',image_source:'javascript:x',image:'javascript:x'},store_label:[{id:1,label_name:'<img>',icon:'//evil.invalid/a',color:'red;position:fixed',bg_color:'url(x)',border_color:''}]})]});
 const item=r.checkout.items.value[0];assert.equal(item.image.src,'');assert.equal(item.frameImage.src,'');assert.equal(item.labels[0].image.src,'');assert.equal(item.labels[0].color,'');assert.equal(item.labels[0].background,'');r.stop();
});
test('image callbacks from an old document cannot hide a refreshed image with the same URL',async()=>{
 const r=await start(),old=r.checkout.items.value[0].image;await r.checkout.refresh();old.error();assert.equal(r.checkout.items.value[0].image.src,'https://images.example/item-100.png');r.stop();
});
test('image expiry during a pending append hides the old ticket; renewal refreshes only hot reads',async()=>{
 const savedTimeout=global.setTimeout,savedNow=Date.now,timers=[],pending=deferred();let now=savedNow(),block=true,r;
 const expires=Math.floor(now/1000)+3600,signed='/api/assets/1?expires='+expires+'&signature='+'a'.repeat(43);
 global.setTimeout=(fn,ms,...args)=>ms>12000?(timers.push({fn,ms}),{media:true}):savedTimeout(fn,ms,...args);Date.now=()=>now;
 try{r=await start({rows:page=>page===1?[row(100,{image_source:'/api/assets/1',image:signed}),...rows(1).slice(1)]:rows(page),send:c=>c.data.page===2&&block?pending.promise:undefined});
  const s=r.checkout;assert.equal(timers.length,1);const append=s.load(true);await tick();now=expires*1000+1;timers[0].fn();assert.equal(s.mediaExpired.value,true);assert.equal(s.items.value[0].image.src,'');
  block=false;pending.resolve({transport:'offline'});await append;assert.equal(s.items.value[0].image.src,'');await s.refresh();assert.ok(r.traces.every(t=>t.path==='/api/product/hot'));assert.deepEqual(r.modals,[]);
 }finally{r?.stop();global.setTimeout=savedTimeout;Date.now=savedNow;}
});
test('actual page keeps detection once, reads recommendations independently, and respects disabled levels',async()=>{
 const r=await start({component:'pages/user/level.vue'}),s=r.checkout;
 assert.equal(s.s.overview.actor_uid,11);assert.equal(s.recommendations.items.length,10);assert.deepEqual(r.traces.map(t=>t.path),['/api/user/level/detection','/api/user/level/info','/api/product/hot']);
 await s.recommendations.load(true);await s.recommendations.refresh();assert.equal(r.traces.filter(t=>t.path.endsWith('/detection')).length,1);
 await s.s.load();assert.equal(hot(r).length,3);r.hooks.onHide();r.hooks.onShow();await tick();assert.equal(r.traces.filter(t=>t.path.endsWith('/detection')).length,1);assert.equal(s.recommendations.items.length,10);r.stop();
 const disabled=await start({component:'pages/user/level.vue',enabled:false});assert.equal(hot(disabled).length,0);disabled.stop();
});
test('actual original-style template compiles, uses exact existing decoration and omits cart actions',()=>{
 const file=path.resolve(__dirname,'../src/pages/user/level.vue'),source=fs.readFileSync(file,'utf8'),{parse,compileTemplate}=require('@vue/compiler-sfc');
 assert.deepEqual(compileTemplate({source:parse(source).descriptor.template.content,filename:file,id:'member-level-recommendations'}).errors,[]);
 for(const text of ['商品推荐','recommendation-grid','345rpx','42rpx','recommendations.load(true)','recommendations.openProduct(item.id)','recommendations.retry'])assert.ok(source.includes(text),text);
 assert.equal((source.match(/src="\/static\/php-assets\/images\/recommend_zs.png"/g)||[]).length,2);
 const bytes=fs.readFileSync(path.resolve(__dirname,'../src/static/php-assets/images/recommend_zs.png'));assert.equal(bytes.length,1619);assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'),'ea7291eb21857a4178478ff5c34a606bdd0240aabea8a1d8392e52733b859a5b');
 assert.doesNotMatch(source,/加入购物车|addCart|groom\/list\/5/);
});
