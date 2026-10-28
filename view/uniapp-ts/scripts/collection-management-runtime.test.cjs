const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {runtime:baseRuntime,tick,deferred}=require('./uni-store-runtime.cjs');
const product=id=>({id,store_name:`收藏商品${id}`,image:'/images/product.png',price:'10.50',is_show:1,is_fail:0,is_presale_product:0,activity:'0,1,2,3',recommendation_target:{version:1,product_id:id,kind:'product',id,ends_at:null}});
const video=(id,available=true)=>({id,video_id:id,image:available?'/images/video.png':'',site_name:'店铺',wap_login_logo:'',desc:`视频${id}`,video_url:available?`/video-${id}.mp4`:'',like_num:2,available,is_fail:available?0:1});
const hot=id=>({...product(id),image_source:'/images/product.png',brand_name:'真实品牌',vip_price:'8.50',is_vip:1,price_type:'member',store_label:[{id:1,label_name:'热卖',icon:'/images/label.png',color:'#aa0000',bg_color:'#ffffff',border_color:'#aa0000'}],activity_frame:{id:8,name:'活动框',image_source:'/images/frame.png',image:'/images/frame.png'}});
const emptyHot=(c,rows=[])=>({data:{owner_uid:c.header['Authori-zation']==='Bearer replacement'?22:11,page:c.data.page,limit:10,list:rows}});
const writes=r=>r.calls.filter(c=>c.method==='POST');
const reads=r=>r.calls.filter(c=>c.url.endsWith('/collect/user'));
const recommendations=r=>r.calls.filter(c=>c.url.endsWith('/product/hot'));
const setup=(send,platform='H5')=>{const traces=[];const r=baseRuntime({component:'pages/user/collect.vue',platform,send:c=>{traces.push({url:c.url,method:c.method,data:JSON.parse(JSON.stringify(c.data)),header:{...c.header}});return send(c)??(c.url.endsWith('/product/hot')?emptyHot(c):{data:{list:[],count:0}});}});return{...r,page:r.checkout,calls:traces};};

test('management selects loaded product identities including unavailable rows, then performs one exact bulk cancellation and fresh read',async()=>{
 let removed=false;const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:removed?[product(3)]:[product(1),{...product(2),is_fail:1,available:false},product(3)],count:removed?1:3}}:c.url.endsWith('/collect/del')?(removed=true,{data:null}):undefined);
 try{await r.start();r.page.toggleManage();r.page.openProduct(2);r.page.toggleSelection(1);assert.deepEqual(r.page.selected.value,[2,1]);assert.deepEqual(r.navigations,[]);assert.equal(writes(r).length,0);await r.page.removeSelected();assert.deepEqual(writes(r).map(c=>c.data),[{id:[2,1],category:'product'}]);assert.equal(reads(r).length,2);assert.deepEqual(r.page.products.value.map(x=>x.id),[3]);assert.equal(r.page.count.value,1);assert.equal(r.page.managing.value,false);assert.deepEqual(r.page.selected.value,[]);assert.equal(reads(r).at(-1).data.page,1);assert.equal(recommendations(r).length,0);}finally{r.stop();}
});
test('video management retains exact video category and cannot play while selecting missing or usable video rows',async()=>{
 let removed=false;const r=setup(c=>c.url.endsWith('/collect/user')?{data:{actor_uid:11,list:removed?[]:[video(71),video(72,false)],count:removed?0:2}}:c.url.endsWith('/collect/del')?(removed=true,{data:null}):undefined);
 try{await r.start({active:'1'});r.page.openVideo(71);assert.ok(r.page.playing.value);r.page.toggleManage();assert.equal(r.page.playing.value,null);r.page.openVideo(72);r.page.toggleSelection(71);await r.page.removeSelected();assert.deepEqual(writes(r)[0].data,{id:[72,71],category:'video'});assert.equal(r.page.videos.value.length,0);assert.equal(r.page.playing.value,null);}finally{r.stop();}
});
test('select-all means loaded rows only, preserves selection on append, and newly appended rows are not silently selected',async()=>{
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:Array.from({length:c.data.page===1?20:3},(_,i)=>product((c.data.page-1)*20+i+1)),count:23}}:undefined);
 try{await r.start();r.page.toggleManage();r.page.toggleAll();assert.equal(r.page.selected.value.length,20);assert.equal(r.page.allSelected.value,true);await r.page.load();assert.equal(r.page.products.value.length,23);assert.equal(r.page.selected.value.length,20);assert.equal(r.page.allSelected.value,false);r.page.toggleAll();assert.deepEqual(r.page.selected.value,Array.from({length:23},(_,i)=>i+1));r.page.toggleAll();assert.deepEqual(r.page.selected.value,[]);assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('the existing100-ID backend bound also caps manual and select-all management',async()=>{
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:Array.from({length:20},(_,i)=>product((c.data.page-1)*20+i+1)),count:120}}:undefined);
 try{await r.start();for(let i=0;i<5;i++)await r.page.load();r.page.toggleManage();r.page.toggleAll();assert.equal(r.page.selected.value.length,100);assert.equal(r.page.selected.value.at(-1),100);r.page.toggleSelection(120);assert.equal(r.page.selected.value.length,100);assert.ok(r.toasts.some(t=>/最多选择100/.test(t.title)));r.page.toggleSelection(1);r.page.toggleSelection(120);assert.equal(r.page.selected.value.length,100);assert.ok(r.page.selected.value.includes(120));assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('empty, forged, duplicate and out-of-bound selections never issue a mutation',async()=>{
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:[product(1),product(2)],count:2}}:undefined);
 try{await r.start();r.page.toggleManage();await r.page.removeSelected();for(const ids of [[1,999],[1,1],[-1],[0],Array(101).fill(1)]){r.page.selected.value=ids;await r.page.removeSelected();}assert.deepEqual(writes(r),[]);assert.deepEqual(r.page.products.value.map(x=>x.id),[1,2]);assert.ok(r.toasts.some(t=>/请选择/.test(t.title)));}finally{r.stop();}
});
test('pending bulk cancellation blocks double-submit, category changes, refreshes and individual actions',async()=>{
 const held=deferred();let removed=false;const r=setup(c=>c.url.endsWith('/collect/del')?(removed=true,held.promise):c.url.endsWith('/collect/user')?{data:{list:removed?[]:[product(1),product(2)],count:removed?0:2}}:undefined);
 try{await r.start();r.page.toggleManage();r.page.toggleAll();const action=r.page.removeSelected();await tick();await r.page.removeSelected();await r.page.remove(1);await r.page.load(true);r.page.select('video');r.page.toggleManage();r.page.toggleSelection(1);assert.equal(writes(r).length,1);assert.equal(reads(r).length,1);assert.equal(r.page.kind.value,'product');assert.equal(r.page.selected.value.length,2);assert.equal(r.page.bulkDeleting.value,true);held.resolve({data:null});await action;assert.equal(r.page.bulkDeleting.value,false);assert.equal(reads(r).length,2);}finally{r.stop();}
});
for(const reply of [{transport:'lost response'},{data:{deleted:2}}])test('ambiguous bulk receipt keeps accepted rows and prevents any mutation replay until explicit refresh '+JSON.stringify(reply),async()=>{
 let serverRemoved=false;const r=setup(c=>c.url.endsWith('/collect/del')?(serverRemoved=true,reply):c.url.endsWith('/collect/user')?{data:{list:serverRemoved?[]:[product(1),product(2)],count:serverRemoved?0:2}}:undefined);
 try{await r.start();r.page.toggleManage();r.page.toggleAll();await r.page.removeSelected();assert.equal(r.page.products.value.length,2);assert.equal(r.page.count.value,2);assert.match(r.page.mutationError.value,/未确认/);await r.page.removeSelected();await r.page.remove(1);r.page.toggleManage();assert.equal(writes(r).length,1);assert.equal(r.page.managing.value,true);await r.page.load(true);assert.equal(r.page.products.value.length,0);assert.equal(r.page.mutationError.value,'');assert.equal(r.page.managing.value,false);assert.equal(writes(r).length,1);}finally{r.stop();}
});
for(const hook of ['onHide','onUnload'])test('late bulk reply after '+hook+' cannot restore rows, selection, playback or notifications',async()=>{
 const held=deferred(),r=setup(c=>c.url.endsWith('/collect/del')?held.promise:c.url.endsWith('/collect/user')?{data:{list:[product(1)],count:1}}:undefined);
 try{await r.start();r.page.toggleManage();r.page.toggleAll();const action=r.page.removeSelected();await tick();r.hooks[hook]();held.resolve({data:null});await action;assert.deepEqual(r.page.products.value,[]);assert.deepEqual(r.page.selected.value,[]);assert.equal(r.page.managing.value,false);assert.equal(r.toasts.length,0);assert.equal(reads(r).length,1);}finally{r.stop();}
});
test('late old auth-error cancellation cannot clear the replacement account or its collection',async()=>{
 const held=deferred(),r=setup(c=>c.url.endsWith('/collect/del')?held.promise:c.url.endsWith('/collect/user')?{data:{list:[product(c.header['Authori-zation']==='Bearer replacement'?22:1)],count:1}}:undefined);
 try{await r.start();r.page.toggleManage();r.page.toggleAll();const action=r.page.removeSelected();await tick();r.auth.setLogin('replacement',22);await tick();held.resolve({status:410001,msg:'Old credentials revoked'});await action;assert.equal(r.auth.uid,22);assert.equal(r.auth.token,'replacement');assert.equal(r.uni.getStorageSync('uni_uid'),22);assert.deepEqual(r.page.products.value.map(x=>x.id),[22]);assert.deepEqual(r.page.selected.value,[]);assert.equal(r.toasts.length,0);}finally{r.stop();}
});
test('persisted account replacement fences late auth errors and synchronizes on return',async()=>{
 const held=deferred(),r=setup(c=>c.url.endsWith('/collect/del')?held.promise:c.url.endsWith('/collect/user')?{data:{list:[product(c.header['Authori-zation']==='Bearer replacement'?22:1)],count:1}}:undefined);
 try{await r.start();r.page.toggleManage();r.page.toggleAll();const action=r.page.removeSelected();await tick();r.uni.setStorageSync('uni_token','replacement');r.uni.setStorageSync('uni_uid',22);held.resolve({status:410001});await action;assert.equal(r.uni.getStorageSync('uni_token'),'replacement');assert.equal(r.uni.getStorageSync('uni_uid'),22);r.hooks.onHide();r.hooks.onShow();await tick();assert.equal(r.auth.uid,22);assert.deepEqual(r.page.products.value.map(x=>x.id),[22]);assert.equal(reads(r).at(-1).header['Authori-zation'],'Bearer replacement');}finally{r.stop();}
});
test('leaving management or switching category clears selections without any write',async()=>{
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:c.data.category==='video'?{actor_uid:11,list:[video(7)],count:1}:{list:[product(1)],count:1}}:undefined);
 try{await r.start();r.page.toggleManage();r.page.toggleAll();r.page.toggleManage();assert.deepEqual(r.page.selected.value,[]);r.page.toggleManage();r.page.toggleAll();r.page.select('video');await tick();assert.equal(r.page.managing.value,false);assert.deepEqual(r.page.selected.value,[]);assert.equal(r.page.videos.value[0].id,7);assert.deepEqual(writes(r),[]);}finally{r.stop();}
});
test('only a confirmed zero-count empty collection enables the existing owner-bound real hot catalogue',async()=>{
 for(const [list,count,expected]of [[[],0,1],[[product(1)],1,0],[[],25,0]]){
  const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list,count}}:undefined);
  try{await r.start();assert.equal(recommendations(r).length,expected);if(expected){assert.deepEqual(recommendations(r)[0].data,{view:'member_level',page:1,limit:10});assert.equal(recommendations(r)[0].method,'GET');assert.equal(recommendations(r)[0].header['Authori-zation'],'Bearer synthetic-local-token');assert.equal(r.page.recommendationState.page.value,1);assert.equal(r.page.recommendationState.hasMore.value,false);}assert.equal(writes(r).length,0);}finally{r.stop();}
 }
});
test('hot pagination preserves accepted first10 on a failed append, retries that exact page manually and terminates after2',async()=>{
 let fail=true;const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:[],count:0}}:c.url.endsWith('/product/hot')?c.data.page===2&&fail?{transport:'offline'}:emptyHot(c,Array.from({length:c.data.page===1?10:2},(_,i)=>hot((c.data.page-1)*10+i+1))):undefined);
 try{await r.start();const rec=r.page.recommendationState;assert.equal(rec.items.value.length,10);r.hooks.onReachBottom();await tick();assert.equal(rec.items.value.length,10);assert.ok(rec.error.value);r.hooks.onReachBottom();await tick();assert.equal(recommendations(r).length,2);fail=false;await rec.retry();assert.equal(rec.items.value.length,12);assert.equal(rec.hasMore.value,false);assert.deepEqual(recommendations(r).map(c=>c.data.page),[1,2,2]);assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('duplicate append and malformed owner/page/limit hot projections are rejected without speculative navigation',async()=>{
 for(const change of ['owner','page','limit','duplicate']){
  const r=setup(c=>{if(c.url.endsWith('/collect/user'))return{data:{list:[],count:0}};if(c.url.endsWith('/product/hot')){const v=emptyHot(c,[hot(1)]);if(change==='owner')v.data.owner_uid=22;if(change==='page')v.data.page=2;if(change==='limit')v.data.limit=20;if(change==='duplicate')v.data.list.push(hot(1));return v;}});
  try{await r.start();assert.deepEqual(r.page.recommendationState.items.value,[]);assert.ok(r.page.recommendationState.error.value);r.page.recommendationState.openProduct(1);assert.deepEqual(r.navigations,[]);}finally{r.stop();}
 }
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:[],count:0}}:c.url.endsWith('/product/hot')?emptyHot(c,c.data.page===1?Array.from({length:10},(_,i)=>hot(i+1)):[hot(1)]):undefined);
 try{await r.start();await r.page.recommendationState.load(true);assert.equal(r.page.recommendationState.items.value.length,10);assert.equal(r.page.recommendationState.page.value,1);assert.match(r.page.recommendationState.error.value,/分页已变化/);}finally{r.stop();}
});
test('ordinary, presale and current activity recommendation targets use actual authority while expired/foreign targets never fall back',async()=>{
 const cases=[{row:hot(1),url:'/pages/goods/detail?id=1'},{row:{...hot(1),is_presale_product:1,recommendation_target:{version:1,product_id:1,kind:'presale',id:1,ends_at:null}},url:'/pages/activity/presaleDetail?id=1'},{row:{...hot(1),activity:'1,0,2,3',recommendation_target:{version:1,product_id:1,kind:'seckill',id:901,ends_at:'2099-01-01T00:00:00.000Z'}},url:'/pages/activity/seckillDetail?id=901'},{row:{...hot(1),recommendation_target:{version:1,product_id:1,kind:'seckill',id:901,ends_at:'2099-01-01T00:00:00.000Z'}},url:null},{row:{...hot(1),activity:'1,0,2,3',recommendation_target:{version:1,product_id:1,kind:'seckill',id:901,ends_at:'2020-01-01T00:00:00.000Z'}},url:null},{row:{...hot(1),recommendation_target:{version:1,product_id:2,kind:'product',id:2,ends_at:null}},url:null}];
 for(const item of cases){const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:[],count:0}}:c.url.endsWith('/product/hot')?emptyHot(c,[item.row]):undefined);try{await r.start();r.page.recommendationState.openProduct(999);r.page.recommendationState.openProduct(1);assert.deepEqual(r.navigations,item.url?[item.url]:[]);assert.equal(writes(r).length,0);}finally{r.stop();}}
});
test('recommendation image previews must match metadata source and expired, unsafe or malformed capabilities remain unavailable',async()=>{
 const signed=id=>'/api/assets/'+id+'?expires='+(Math.floor(Date.now()/1000)+3600)+'&signature='+'a'.repeat(43);
 const rows=[{...hot(1),image_source:'/api/assets/10',image:signed(10)},{...hot(2),image_source:'/api/assets/10',image:signed(11)},{...hot(3),image_source:'/api/assets/10',image:'/api/assets/10'},{...hot(4),image_source:'javascript:bad',image:'javascript:bad'},{...hot(5),image_source:'/api/assets/10',image:'/api/assets/10?expires=1&signature='+'a'.repeat(43)}];
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:[],count:0}}:c.url.endsWith('/product/hot')?emptyHot(c,rows):undefined);
 try{await r.start();const items=r.page.recommendationState.items.value;assert.match(items[0].image.src,/^\/api\/assets\/10\?expires=/);assert.ok(items.slice(1).every(x=>x.image.src===''));assert.equal(items[0].labels[0].image.src,'/images/label.png');assert.equal(items[0].frameImage.src,'/images/frame.png');assert.equal(items[0].brand,'真实品牌');assert.equal(items[0].vipOffer,true);assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('late old image errors cannot poison a refreshed recommendation using the same URL',async()=>{
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:[],count:0}}:c.url.endsWith('/product/hot')?emptyHot(c,[hot(1)]):undefined);
 try{await r.start();const rec=r.page.recommendationState,old=rec.items.value[0].image;await rec.refresh();old.error();assert.equal(rec.items.value[0].image.src,'/images/product.png');rec.items.value[0].image.error();assert.equal(rec.items.value[0].image.src,'');assert.equal(rec.items.value[0].frameImage.src,'/images/frame.png');}finally{r.stop();}
});
for(const event of ['onHide','onUnload','owner','refresh'])test('held empty-state recommendations are fenced after '+event,async()=>{
 const held=deferred();let old=true;const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:event==='refresh'&&!old?[product(22)]:[],count:event==='refresh'&&!old?1:0}}:c.url.endsWith('/product/hot')?old?(old=false,held.promise):emptyHot(c,[hot(22)]):undefined);
 try{await r.start();if(event==='owner')r.auth.setLogin('replacement',22);else if(event==='refresh')await r.page.load(true);else r.hooks[event]();await tick();held.resolve(emptyHot({header:{'Authori-zation':'Bearer synthetic-local-token'},data:{page:1}},[hot(1)]));await tick();assert.ok(!r.page.recommendationState.items.value.some(row=>row.id===1));if(event==='owner')assert.deepEqual(r.page.recommendationState.items.value.map(x=>x.id),[22]);else assert.equal(r.page.recommendationState.items.value.length,0);assert.equal(writes(r).length,0);}finally{r.stop();}
});
test('actual collection template exposes management and empty-state recommendation controls and compiles without injected HTML',()=>{
 const {parse,compileTemplate}=require('@vue/compiler-sfc'),file=path.resolve(__dirname,'../src/pages/user/collect.vue'),source=fs.readFileSync(file,'utf8');assert.deepEqual(compileTemplate({source:parse(source).descriptor.template.content,filename:file,id:'collection-management'}).errors,[]);assert.match(source,/data-collection-bulk/);assert.match(source,/data-recommendation-id/);assert.doesNotMatch(source,/v-html/);
});

for(const platform of ['H5','MP-WEIXIN','APP-PLUS'])test(platform+' recommendation uses real platform origin and form headers without any mutation or level check',async()=>{
 const expires=Math.floor(Date.now()/1000)+3600,src='/api/assets/10?expires='+expires+'&signature='+'a'.repeat(43);
 const r=setup(c=>c.url.endsWith('/collect/user')?{data:{list:[],count:0}}:c.url.endsWith('/product/hot')?emptyHot(c,[{...hot(1),image_source:'/api/assets/10',image:src}]):undefined,platform);
 try{await r.start();assert.equal(r.page.recommendationState.items.value[0].image.src,(platform==='H5'?'':'https://cinashop-api.cinagroup.workers.dev')+src);assert.equal(recommendations(r)[0].header['Form-type'],platform==='H5'?'h5':platform==='MP-WEIXIN'?'routine':'app');assert.ok(r.calls.every(c=>c.method==='GET'&&(c.url.endsWith('/collect/user')||c.url.endsWith('/product/hot'))));}finally{r.stop();}
});

test('nonempty refresh and failed refresh never expose a transient confirmed empty state to synchronous recommendation watchers',async()=>{
 let fail=false;const r=setup(c=>c.url.endsWith('/collect/user')?fail?{transport:'offline'}:{data:{list:[product(1)],count:1}}:undefined);
 try{await r.start();await r.page.load(true);assert.deepEqual(r.page.products.value.map(row=>row.id),[1]);assert.equal(recommendations(r).length,0);fail=true;await r.page.load(true);assert.equal(r.page.products.value.length,0);assert.equal(r.page.ready.value,false);assert.ok(r.page.error.value);assert.equal(recommendations(r).length,0);assert.equal(writes(r).length,0);}finally{r.stop();}
});
