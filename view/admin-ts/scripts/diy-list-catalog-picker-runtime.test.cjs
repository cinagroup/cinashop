const {test,assert,path,root,vue,clone,tick,deferred,all,text,loader,mount}=require('./helpers/diy-list-runtime.cjs');
const apiFile=path.join(root,'api/diyListAuthor.ts'),pickerFile=path.join(root,'components/content/DiyListSelectionPicker.vue');
const kinds=['product','brand','label','article_category'];
const route={product:'list-products',brand:'list-brands',label:'list-labels',article_category:'list-article-categories',category:'tab-targets'};
function target(kind,id=23,parent=0){
  const selection={kind,id,name:kind+' target '+id};
  if(kind==='product'||kind==='category')return{id,name:selection.name,kind:kind==='product'?'product':'product_category',url:kind==='product'?'/pages/goods_details/index?id='+id:'/pages/goods/goods_list/index?sid='+id+'&title='+encodeURIComponent(selection.name),selectable:true,partial:false,issues:[],selection,...(kind==='category'?{parent_id:parent,has_children:false}:{price:'9.50',image_preview:'/static/catalog.png'})};
  return{id,name:selection.name,selection,...(kind==='brand'?{parent_id:parent,has_children:false}:{}),...(kind==='article_category'?{aggregate:id===0}:{})};
}
function page(kind,params={},id=23){return{list:[target(kind,id,params.parent_id??0)],count:1,page:params.page??1,limit:params.limit??15,issues:[]};}
function gateway(read){const calls=[];return{calls,get:async(url,options={})=>{calls.push({url,params:clone(options.params??{}),signal:options.signal});const kind=Object.keys(route).find(k=>url.endsWith('/'+route[k]));assert.ok(kind,url);return{data:await(read?read(kind,options.params??{},url,options.signal):page(kind,options.params))};}};}
function apiHarness(read){const g=gateway(read),l=loader({gateway:g});return{...l,g,api:l.load(apiFile)};}
function pickerHarness(kind='product',read,options={}){const g=gateway(read),l=loader({...options,gateway:g}),choices=[],props=vue.reactive({kind,editorKey:'list:2:scope',disabled:false,onChoose:value=>{assert.equal(vue.isProxy(value),false);assert.doesNotThrow(()=>structuredClone(value));choices.push(value);}}),m=mount(l,pickerFile,props);return{...l,...m,g,props,choices};}
for(const kind of kinds)test('actual API '+kind+' uses only its exact scoped GET and projects the complete typed identity',async()=>{
  const r=apiHarness(),controller=new AbortController(),result=await r.api.apiDiyListCatalog(kind,{page:1,limit:15},controller.signal);
  assert.equal(r.g.calls.length,1);assert.equal(r.g.calls[0].url,'/dise/author-options/'+route[kind]);assert.equal(r.g.calls[0].signal,controller.signal);
  assert.deepEqual(r.g.calls[0].params,{page:1,limit:15,...(['product','brand'].includes(kind)?{parent_id:0}:{})});
  assert.deepEqual(result.list[0].selection,{kind,id:23,name:kind+' target 23'});assert.equal(result.count,1);assert.equal(result.page,1);assert.equal(result.limit,15);
});
for(const kind of kinds)test('actual API '+kind+' rejects duplicate, unknown identity, inconsistent count and malformed page DTOs',async()=>{
  let response;const r=apiHarness(()=>response);
  const mutations=[['null',()=>null],['nonlist',p=>({...p,list:{}})],['duplicate',p=>({...p,list:[...p.list,clone(p.list[0])],count:2})],['over-count',p=>({...p,count:0})],['fraction count',p=>({...p,count:1.5})],['wrong page',p=>({...p,page:2})],['wrong limit',p=>({...p,limit:14})],['nonstring issue',p=>({...p,issues:[{}]})],['unknown identity kind',p=>{p.list[0].selection.kind='supplier';return p;}],['identity ID',p=>{p.list[0].selection.id=99;return p;}],['identity name',p=>{p.list[0].selection.name='substituted';return p;}],['missing selection',p=>{delete p.list[0].selection;return p;}],['zero ID',p=>{p.list[0].id=0;p.list[0].selection.id=0;return p;}],['negative ID',p=>{p.list[0].id=-1;p.list[0].selection.id=-1;return p;}],['control name',p=>{p.list[0].name='bad\u0000name';p.list[0].selection.name=p.list[0].name;return p;}]];
  for(const[name,mutate]of mutations){response=mutate(page(kind));await assert.rejects(()=>r.api.apiDiyListCatalog(kind,{page:1,limit:15}),undefined,name);}
});
test('actual API rejects product transport kinds and unsafe selectable URLs while preserving explicitly unavailable public identities',async()=>{
  let response=page('product'),r=apiHarness(()=>response);response.list[0].kind='news';await assert.rejects(()=>r.api.apiDiyListCatalog('product',{page:1,limit:15}));response=page('product');response.list[0].url='javascript:alert(1)';await assert.rejects(()=>r.api.apiDiyListCatalog('product',{page:1,limit:15}));
  response=page('product');response.list[0].selectable=false;response.list[0].selection=null;const result=await r.api.apiDiyListCatalog('product',{page:1,limit:15});assert.equal(result.list[0].selectable,false);assert.equal(result.list[0].selection,null);
  response.list[0].selection={kind:'product',id:23,name:response.list[0].name};await assert.rejects(()=>r.api.apiDiyListCatalog('product',{page:1,limit:15}));
});
test('actual brand API binds child parent, boolean ancestry and positive platform identities',async()=>{
  let response=page('brand',{parent_id:17}),r=apiHarness(()=>response);assert.equal((await r.api.apiDiyListCatalog('brand',{page:1,limit:15,parent_id:17})).list[0].parent_id,17);
  for(const patch of[{parent_id:18},{has_children:'true'},{id:0,selection:{kind:'brand',id:0,name:'brand target 23'}}]){response=page('brand',{parent_id:17});Object.assign(response.list[0],patch);await assert.rejects(()=>r.api.apiDiyListCatalog('brand',{page:1,limit:15,parent_id:17}));}
});
test('article category zero requires an explicit aggregate with matching identity and does not accept persistent-row confusion',async()=>{
  let response=page('article_category',{},0),r=apiHarness(()=>response),result=await r.api.apiDiyListCatalog('article_category',{page:1,limit:15});assert.deepEqual(result.list[0].selection,{kind:'article_category',id:0,name:'article_category target 0'});
  response.list[0].aggregate=false;await assert.rejects(()=>r.api.apiDiyListCatalog('article_category',{page:1,limit:15}));response=page('article_category');response.list[0].aggregate=true;await assert.rejects(()=>r.api.apiDiyListCatalog('article_category',{page:1,limit:15}));
  response=page('label',{},0);const bad=apiHarness(()=>response);await assert.rejects(()=>bad.api.apiDiyListCatalog('label',{page:1,limit:15}));
});
test('actual typed category API delegates the existing dedicated route with exact parent and never converts URL text into an identity',async()=>{
  let response=page('category',{parent_id:17}),r=apiHarness(()=>response);const result=await r.api.apiDiyListCatalog('category',{page:1,limit:15,parent_id:17});assert.equal(r.g.calls[0].url,'/dise/author-options/tab-targets');assert.deepEqual(r.g.calls[0].params,{kind:'product_category',page:1,limit:15,parent_id:17});assert.deepEqual(result.list[0].selection,{kind:'category',id:23,name:'category target 23'});
  response.list[0].selection.id=999;await assert.rejects(()=>r.api.apiDiyListCatalog('category',{page:1,limit:15,parent_id:17}));response=page('category');response.list[0].id=0;response.list[0].selection.id=0;await assert.rejects(()=>r.api.apiDiyListCatalog('category',{page:1,limit:15}));
});
for(const kind of kinds)test('actual '+kind+' query accepts100Unicode codepoints and rejects101 before the request',async()=>{
  const r=apiHarness();await r.api.apiDiyListCatalog(kind,{page:1,limit:15,search:'  '+'😀'.repeat(100)+'  '});assert.equal(r.g.calls[0].params.search,'😀'.repeat(100));const before=r.g.calls.length;
  for(const search of['😀'.repeat(101),'中'.repeat(101),'bad\u0000text'])await assert.rejects(()=>r.api.apiDiyListCatalog(kind,{page:1,limit:15,search}));assert.equal(r.g.calls.length,before);
});
test('actual API rejects malformed paging and hierarchy before touching a scoped endpoint',async()=>{
  const r=apiHarness();for(const[kind,query]of[['brand',{parent_id:-1}],['brand',{parent_id:'01'}],['product',{parent_id:2147483648}],['label',{parent_id:1}],['article_category',{parent_id:1}],['brand',{page:0}],['brand',{page:1.5}],['brand',{limit:101}],['brand',{page:102,limit:100}]])await assert.rejects(()=>r.api.apiDiyListCatalog(kind,{page:1,limit:15,...query}));assert.deepEqual(r.g.calls,[]);
});
for(const kind of [...kinds,'category'])test('compiled picker '+kind+' opens its actual API and emits a plain primitive-only choice from a Vue-proxied row',async()=>{
  const r=pickerHarness(kind);try{await r.state.open();await tick();assert.equal(r.state.ready,true);assert.equal(r.g.calls[0].url,'/dise/author-options/'+route[kind]);assert.equal(vue.isProxy(r.state.result.list[0]),true);assert.equal(vue.isProxy(r.state.result.list[0].selection),true);const choose=all(r.tree,n=>n.tag==='button'&&text(n)==='选择')[0];assert.ok(choose);assert.equal(choose.props.disabled,false);choose.props.onClick();await tick();assert.deepEqual(r.choices,[{kind,id:23,name:kind+' target 23'}]);assert.equal(r.state.visible,false);assert.deepEqual(Object.keys(r.choices[0]).sort(),['id','kind','name']);}finally{r.unmount();}
});
test('compiled brand picker disables ancestors and descends through current membership before selecting the real leaf',async()=>{
  const r=pickerHarness('brand',(kind,params)=>{const p=page(kind,params,params.parent_id?24:23);p.list[0].has_children=!params.parent_id;return p;});try{await r.state.open();await tick();const parent=r.state.result.list[0];r.state.choose(parent);assert.deepEqual(r.choices,[]);const choose=all(r.tree,n=>n.tag==='button'&&text(n)==='选择')[0];assert.equal(choose.props.disabled,true);r.state.descend(parent);await tick();assert.equal(r.g.calls.at(-1).params.parent_id,23);assert.equal(r.state.result.list[0].id,24);r.state.choose(r.state.result.list[0]);assert.equal(r.choices[0].id,24);}finally{r.unmount();}
});
test('compiled product picker uses typed category identity only as its actual product filter and never emits that category as a product',async()=>{
  const r=pickerHarness();try{await r.state.open();r.state.browseCategories();await tick();assert.equal(r.state.catalogKind,'category');const category=r.state.result.list[0];r.state.choose(category);await tick();assert.deepEqual(r.choices,[]);assert.equal(r.state.catalogKind,'product');assert.equal(r.g.calls.at(-1).params.parent_id,23);r.state.choose(r.state.result.list[0]);assert.deepEqual(r.choices,[{kind:'product',id:23,name:'product target 23'}]);}finally{r.unmount();}
});
test('compiled picker has no UTF16 maxlength truncation and its actual search passes100codepoints while101 remains an error without another HTTP read',async()=>{
  const r=pickerHarness('label');try{await r.state.open();await tick();const input=all(r.tree,n=>n.tag==='input'&&n.props['aria-label']==='列表目录搜索')[0];assert.ok(input);assert.equal(input.props.maxlength,undefined);input.props['onUpdate:modelValue']('😀'.repeat(100));r.state.query();await tick();assert.equal(r.g.calls.at(-1).params.search,'😀'.repeat(100));const count=r.g.calls.length;input.props['onUpdate:modelValue']('😀'.repeat(101));r.state.query();await tick();assert.equal(r.g.calls.length,count);assert.match(r.state.error,/100/);assert.equal(r.state.ready,false);assert.deepEqual(r.choices,[]);}finally{r.unmount();}
});
test('compiled picker close immediately invalidates an abort-ignoring actual catalog response',async()=>{
  const pending=deferred(),r=pickerHarness('product',()=>pending.promise);try{const job=r.state.open();await tick();assert.equal(r.state.loading,true);r.state.visible=false;await tick();pending.resolve(page('product'));await job;await tick();assert.equal(r.state.ready,false);assert.equal(r.state.result,null);assert.equal(r.state.loading,false);assert.equal(r.g.calls[0].signal.aborted,true);assert.deepEqual(r.choices,[]);}finally{r.unmount();}
});
test('compiled picker close and reopen never lends the old response the new current identity',async()=>{
  const first=deferred(),second=deferred();let reads=0;const r=pickerHarness('label',()=>++reads===1?first.promise:second.promise);try{const old=r.state.open();await tick();r.state.visible=false;const current=r.state.open();await tick();first.resolve(page('label',{},23));await old;await tick();assert.equal(r.state.result,null);assert.equal(r.state.ready,false);second.resolve(page('label',{},24));await current;await tick();assert.equal(r.state.result.list[0].id,24);r.state.choose(r.state.result.list[0]);assert.deepEqual(r.choices,[{kind:'label',id:24,name:'label target 24'}]);}finally{r.unmount();}
});
for(const change of ['actor','permission','token','session','disabled','page','kind','unmount'])test('compiled picker rejects stale callback and late response after '+change,async()=>{
  let pending;const r=pickerHarness('product',kind=>pending?pending.promise:page(kind));try{await r.state.open();await tick();const stale=r.state.result.list[0],choose=r.state.choose;pending=deferred();const job=r.state.load(2);await tick();
    if(change==='actor')r.actor.userInfo.id=99;if(change==='permission'){r.actor.userInfo.level=1;r.actor.uniqueAuth=[];}if(change==='token')r.storage.set('admin_token','B');if(change==='session'){r.storage.set('admin_session','B');r.window.dispatchEvent(new Event('storage'));}if(change==='disabled')r.props.disabled=true;if(change==='page')r.props.editorKey='other-page';if(change==='kind')r.props.kind='label';if(change==='unmount')r.unmount();
    choose(stale);await tick();pending.resolve(page('product',{page:2}));await job;await tick();assert.deepEqual(r.choices,[]);assert.equal(r.state.ready,false);assert.equal(r.state.result,null);
  }finally{r.unmount();}
});
test('compiled picker refuses detached objects and prior-page rows even with an identical typed identity',async()=>{
  const r=pickerHarness('product',(kind,params)=>page(kind,params,params.page===2?24:23));try{await r.state.open();await tick();const previous=r.state.result.list[0];r.state.choose(clone(previous));assert.deepEqual(r.choices,[]);await r.state.load(2);await tick();r.state.choose(previous);assert.deepEqual(r.choices,[]);assert.equal(r.state.visible,true);r.state.choose(r.state.result.list[0]);assert.equal(r.choices[0].id,24);}finally{r.unmount();}
});
test('compiled readonly picker exposes its actual disabled control and cannot initiate any catalog read',async()=>{
  const actor=vue.reactive({token:'A',userInfo:{id:11,level:1},uniqueAuth:['dise.view']}),r=pickerHarness('brand',undefined,{actor});try{await tick();const open=all(r.tree,n=>n.tag==='button'&&text(n)==='从真实目录选择')[0];assert.equal(open.props.disabled,true);await r.state.open();assert.deepEqual(r.g.calls,[]);assert.equal(r.state.visible,false);assert.deepEqual(r.choices,[]);}finally{r.unmount();}
});
