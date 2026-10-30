const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const common = path.resolve(__dirname, '../../common/searchHotwords.ts');
const word = (id=1,extra={}) => ({id,name:'茶叶',keyword:'茶叶',color:'',bg_color:'',border_color:'',icon:'',...extra});
const product = (id=7,extra={}) => ({id,store_name:'会员茶',price:'19.9',...extra});
function setup(options={}) {
 const sent=[];
 const r=runtime({feature:'useGoodsSearch',storage:options.storage,authenticated:options.authenticated??true,send:call=>{
  sent.push({url:call.url,data:call.data,header:call.header});
  if(options.send){const v=options.send(call);if(v!==undefined)return v;}
  if(call.url.endsWith('/search/hot_keyword'))return {data:[word()]};
  if(call.url.endsWith('/products'))return {data:{list:[product()],count:1}};
  throw Error(`Unexpected ${call.url}`);
 }});return {...r,sent,c:r.load(common)};
}
for(const n of [1,15,16,100,128])test(`historical ${n} Unicode codepoint hotword is displayed complete without author-limit truncation`,()=>{
 const r=setup();try{for(const name of ['茶'.repeat(n),'🍵'.repeat(n)]){const row=r.c.parseSearchHotwords([word(1,{name,keyword:name})])[0];assert.equal(row.name,name);}}finally{r.stop();}
});
for(const [label,value] of Object.entries({notArray:{},null:null,tooMany:Array.from({length:21},(_,i)=>word(i+1)),duplicate:[word(),word()],badTail:[word(),null],sparse:Array(2),alias:[word(1,{keyword:'other'})],fraction:[word(1.5)],stringID:[word('1')],zero:[word(0)],long:[word(1,{name:'茶'.repeat(129),keyword:'茶'.repeat(129)})],control:[word(1,{name:'茶\n',keyword:'茶\n'})],badColor:[word(1,{color:'url(https://evil.invalid)'})],nonStringIcon:[word(1,{icon:{url:'/x.png'}})]}))test(`public hotwords reject the entire malformed response: ${label}`,()=>{
 const r=setup();try{assert.throws(()=>r.c.parseSearchHotwords(value));}finally{r.stop();}
});
for(const color of ['', '#abc','#abcd','#abcdef','#ABCDEF12','transparent','rgb(0, 255, 8)','rgba(12, 25, 0, .5)','rgba(1,2,3,1)'])test(`all three producer color fields accept ${JSON.stringify(color)}`,()=>{
 const r=setup();try{const p=r.c.parseSearchHotwords([word(1,{color,bg_color:color,border_color:color})])[0];assert.equal(p.color,color);assert.equal(p.bg_color,color);assert.equal(p.border_color,color);}finally{r.stop();}
});
for(const color of ['red','#ab','#12345','rgb(256,0,0)','rgba(1,2,3,1.1)','var(--evil)','expression(x)','url(/x)','inherit'])test(`CSS payload cannot enter hotword styles: ${color}`,()=>{
 const r=setup();try{for(const field of ['color','bg_color','border_color'])assert.throws(()=>r.c.parseSearchHotwords([word(1,{[field]:color})]));}finally{r.stop();}
});
for(const [source,safe] of [
 ['/static/tea.png',true],['https://cdn.example.test/tea.png?x=1#y',true],['/api/assets/9',true],['/api/assets/9?expires=1&signature=old',true],
 ['//evil.test/x',false],['http://evil.test/x',false],['https://u:p@evil.test/x',false],['javascript:alert(1)',false],['data:image/png;base64,AA==',false],['/a/..//evil.test',false],['/%2f/evil.test',false],['/%252f/evil.test',false],['/a\\x',false],['https://evil.test/\nx',false],['https://evil.test/a b',false],
])test(`business icon projection preserves text and has no URL global dependency: ${JSON.stringify(source)}`,()=>{
 const r=setup();const prior=global.URL;try{global.URL=undefined;const row=r.c.parseSearchHotwords([word(1,{icon:source})])[0];assert.equal(row.name,'茶叶');assert.equal(row.icon,safe?source:'');}finally{global.URL=prior;r.stop();}
});
for(const raw of ['null','{}','5','"tea"','[null]','[1]','["tea",{}]','[" "]','[" tea"]','["tea\\n"]','[','["'+ 'a'.repeat(256)+'"]',JSON.stringify(Array(11).fill('tea'))])test(`invalid local history cannot overwrite durable bytes: ${raw.slice(0,22)}`,async()=>{
 const storage=new Map([['h5_search_history',raw]]),r=setup({storage});try{await r.start({});const p=r.checkout;assert.match(p.historyError.value,/格式无效/);assert.deepEqual(p.history.value,[]);p.controls.value[0].input({detail:{value:'新词'}});p.controls.value[0].search();await tick();assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).length,1);assert.equal(storage.get('h5_search_history'),raw);p.controls.value[0].clear();assert.equal(storage.has('h5_search_history'),false);assert.equal(p.historyError.value,'');}finally{r.stop();}
});
test('route query loads valid existing browser history first and submits the complete query exactly once',async()=>{
 const original=Array.from({length:10},(_,i)=>`旧词${i}`),storage=new Map([['h5_search_history',JSON.stringify(original)]]),name='茶'.repeat(128),r=setup({storage});try{
 await r.start({searchVal:name});const p=r.checkout;assert.equal(r.sent.filter(c=>c.url.endsWith('/products')).length,1);assert.equal(r.sent.find(c=>c.url.endsWith('/products')).data.keyword,name);assert.equal(p.keyword.value,name);assert.deepEqual(JSON.parse(storage.get('h5_search_history')),[name,...original.slice(0,9)]);assert.equal(p.results.value[0].store_name,'会员茶');assert.equal(p.results.value[0].price,'19.90');
 r.hooks.onShow();await tick();assert.equal(r.sent.length,2);
 p.controls.value[0].input({detail:{value:'旧词2'}});p.controls.value[0].search();await tick();assert.deepEqual(p.history.value,['旧词2',name,...original.filter(v=>v!=='旧词2').slice(0,8)]);
 }finally{r.stop();}
});
test('hotword request is anonymous; product request keeps shopper bearer and existing page contract',async()=>{
 const r=setup();try{await r.start({keyword:'会员茶'});const hot=r.sent.find(c=>c.url.endsWith('/search/hot_keyword')),goods=r.sent.find(c=>c.url.endsWith('/products'));assert.equal(hot.header['Authori-zation'],undefined);assert.equal(goods.header['Authori-zation'],'Bearer synthetic-local-token');assert.deepEqual(goods.data,{keyword:'会员茶',page:1,limit:20});}finally{r.stop();}
});
test('hotword 410000 cannot clear shopper or navigate to login; retry recovers real public rows',async()=>{
 let fail=true;const r=setup({send:c=>c.url.endsWith('/search/hot_keyword')&&fail?{status:410000,msg:'public hotword unavailable'}:undefined});try{await r.start({});assert.equal(r.auth.uid,11);assert.equal(r.auth.token,'synthetic-local-token');assert.equal(r.navigations.length,0);assert.match(r.checkout.hotError.value,/unavailable/);fail=false;r.checkout.controls.value[0].refresh();await tick();assert.equal(r.checkout.hotWords.value[0].name,'茶叶');assert.equal(r.checkout.hotError.value,'');}finally{r.stop();}
});
for(const value of ['', 'a'.repeat(256), '🍵'.repeat(128), 'bad\nword', ['tea'], {}])test(`invalid route query is explicit and never silently truncated: ${String(value).slice(0,14)}`,async()=>{
 const r=setup();try{await r.start({keyword:value});assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).length,0);if(value!=='')assert.ok(r.checkout.searchError.value);}finally{r.stop();}
});
test('historical 128-emoji hotword renders intact but clicking reports the Worker query bound without I/O',async()=>{
 const name='🍵'.repeat(128),r=setup({send:c=>c.url.endsWith('/search/hot_keyword')?{data:[word(1,{name,keyword:name})]}:undefined});try{await r.start({});assert.equal(r.checkout.hotWords.value[0].name,name);r.checkout.hotEntries.value[0].tap();await tick();assert.equal(r.checkout.keyword.value,name);assert.match(r.checkout.searchError.value,/255/);assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).length,0);assert.equal(r.storage.has('h5_search_history'),false);}finally{r.stop();}
});
for(const [label,list] of [['duplicate',[product(),product()]],['bad tail',[product(),null]],['sparse',Array(2)],['excess',Array.from({length:21},(_,i)=>product(i+1))],['malformed money',[product(7,{price:'NaN'})]]])test(`search cannot publish a partially malformed product list: ${label}`,async()=>{
 const r=setup({send:c=>c.url.endsWith('/products')?{data:{list,count:list.length}}:undefined});try{await r.start({keyword:'茶'});assert.deepEqual(r.checkout.results.value,[]);assert.ok(r.checkout.searchError.value);assert.equal(r.checkout.searchLoading.value,false);}finally{r.stop();}
});
test('returning from detail does not add a second product search/history side effect',async()=>{
 const r=setup();try{await r.start({keyword:'茶'});const p=r.checkout;const old=p.resultEntries.value[0].tap;old();assert.equal(r.navigations.at(-1),'/pages/goods/detail?id=7');r.hooks.onHide();r.hooks.onShow();await tick();assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).length,1);assert.equal(p.keyword.value,'茶');assert.equal(p.searched.value,false);old();assert.equal(r.navigations.length,1);p.controls.value[0].search();await tick();assert.equal(r.calls.filter(c=>c.url.endsWith('/products')).length,2);}finally{r.stop();}
});
test('late first product finally cannot dismiss a newer search spinner or publish A after A-B-A',async()=>{
 const first=deferred(),second=deferred();let n=0;const r=setup({send:c=>c.url.endsWith('/products')?(++n===1?first.promise:second.promise):undefined});try{await r.start({keyword:'A'});const p=r.checkout;p.controls.value[0].input({detail:{value:'B'}});p.controls.value[0].input({detail:{value:'A'}});p.controls.value[0].search();await tick();assert.equal(p.searchLoading.value,true);first.resolve({data:{list:[product(90,{store_name:'旧A'})],count:1}});await tick();assert.equal(p.searchLoading.value,true);assert.deepEqual(p.results.value,[]);second.resolve({data:{list:[product(91,{store_name:'新A'})],count:1}});await tick();assert.equal(p.results.value[0].store_name,'新A');assert.equal(p.searchLoading.value,false);}finally{first.resolve({data:{list:[],count:0}});second.resolve({data:{list:[],count:0}});r.stop();}
});
