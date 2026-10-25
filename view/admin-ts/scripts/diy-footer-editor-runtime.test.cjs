const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const sfc = require('@vue/compiler-sfc');
const root = path.resolve(__dirname, '../src');
const editorFile = path.join(root, 'components/content/DiyFooterEditor.vue'), pageFile = path.join(root, 'pages/content/DiseList.vue');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return { promise,resolve,reject }; }
function hostNode(tag) { return { tag,children:[],parent:null }; }
const renderer = vue.createRenderer({
  createElement:hostNode,createText:text => ({ text }),createComment:text => ({ text }),setText:(node,text) => { node.text=text; },setElementText:(node,text) => { node.text=text; },
  parentNode:node => node.parent,nextSibling:() => null,patchProp:() => {},insert:(node,parent) => { node.parent=parent; parent.children.push(node); },remove:() => {},
});
function loader(overrides = {}) {
  const cache = new Map();
  const notices = [], actor = overrides.actor ?? vue.reactive({ token:'ownerA',userInfo:{ id:11,level:0 },uniqueAuth:[] });
  const storage = new Map([['admin_token','ownerA'],['admin_session','sessionA']]);
  const env = { window: new EventTarget(), localStorage:{ getItem:key => storage.get(key) ?? null } };
  const gateway = overrides.gateway ?? { get:async () => ({ data:[] }),post:async () => ({ data:{ id:2,version:'fresh' } }) };
  function load(file) {
    file=path.resolve(file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);
    const exports={};cache.set(file,exports);
    let source=fs.readFileSync(file,'utf8');if(file.endsWith('.vue'))source=sfc.compileScript(sfc.parse(source,{ filename:file }).descriptor,{ id:'footer-editor-runtime' }).content;
    const output=ts.transpileModule(source,{ compilerOptions:{ target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true } }).outputText;
    new Function('require','exports','window','localStorage',output)(name => {
      if(name==='vue')return vue;
      if(name==='element-plus')return { ElMessage:{ error:msg => notices.push(['error',msg]),success:msg => notices.push(['success',msg]),warning:msg => notices.push(['warning',msg]) },ElMessageBox:{ confirm:async()=>{} } };
      if(name==='@/stores/auth')return { useAuthStore:() => actor };
      if(name==='@/utils/auth')return { getToken:() => storage.get('admin_token') ?? null };
      if(name==='@/utils/request')return { __esModule:true,default:gateway,getData:async p => (await p).data };
      // Isolate the adjacent view; DiseList still imports the real editorial canonicalizer separately.
      if(name==='@/components/content/DiyEditorialEditor.vue')return { __esModule:true,default:vue.defineComponent({ setup:()=>()=>null }) };
      if(name==='@/components/content/DiyPresentationEditor.vue')return { __esModule:true,default:vue.defineComponent({ setup:()=>()=>null }) };
      if(name==='@/pages/activity/SeckillActivityImagePicker.vue')return { __esModule:true,default:vue.defineComponent({ setup:()=>()=>null }) };
      if(name.startsWith('@/'))return load(path.join(root,name.slice(2)));
      if(name.startsWith('.'))return load(path.resolve(path.dirname(file),name));
      return require(name);
    },exports,env.window,env.localStorage);
    return exports;
  }
  return { load,actor,storage,notices,env,loadedFiles:()=>[...cache.keys()] };
}
function mount(component, props = {}, emit = () => {}) {
  let state; const app=renderer.createApp({ setup() { state=vue.proxyRefs(component.setup(props,{ emit,expose:()=>{} }));return()=>null; } });
  app.mount(hostNode('root'));return { state,unmount:()=>app.unmount() };
}
function footer(length = 2) { return { name:'pageFoot',timestamp:900,custom:'untouched',effectConfig:{ tabVal:1,annotation:'keep' },navConfig:{ tabVal:0 },navStyleConfig:{ tabVal:0 },toneConfig:{ tabVal:1 },
  activeTxtColor:{ color:[{ item:'#aa0000',extra:'keep' },{ item:'#bbbbbb' }],extra:4 },txtColor:{ color:[{ item:'#555555' }] },bgColor:{ color:[{ item:'#ffffff' }] },bgColor2:{ color:[{ item:'#eeeeee' }] },
  topConfig:{ val:6,extra:7 },bottomConfig:{ val:8 },prConfig:{ val:10 },mbConfig:{ val:7 },fillet:{ type:1,val:5,valList:[2,4,6,8].map(val=>({ val,extra:true })),extra:'keep' },
  menuList:Array.from({ length },(_,index)=>({ name:'菜单'+index,link:'/pages/index/index?item='+index,imgList:['/api/assets/7','/static/logo.png','bystander'],extra:{ original:index } })) }; }
function harness(blocks = [{ name:'titles',title:'other',url:'/api/assets/7?expires=1&signature=keep' },footer()], changes = {}) {
  const l=loader(), props=vue.reactive({ modelValue:JSON.stringify(blocks),editorKey:'ownerA:row2',pageId:2,pagePublished:true,disabled:false,...changes }),emits=[];
  const m=mount(l.load(editorFile).default,props,(name,value)=>{emits.push({name,value});props.modelValue=value;});
  return { ...l,...m,props,emits,value:()=>JSON.parse(props.modelValue) };
}

test('real SFC scripts and templates compile, and picker uses existing attachment selection/upload component',()=>{
  for(const file of [editorFile,pageFile]){const parsed=sfc.parse(fs.readFileSync(file,'utf8'),{ filename:file });assert.deepEqual(parsed.errors,[]);const script=sfc.compileScript(parsed.descriptor,{ id:'footer-syntax' });assert.deepEqual(sfc.compileTemplate({ source:parsed.descriptor.template.content,filename:file,id:'footer-syntax',compilerOptions:{ bindingMetadata:script.bindings } }).errors,[]);}
  const source=fs.readFileSync(editorFile,'utf8');assert.match(source,/from '@\/pages\/activity\/SeckillActivityImagePicker.vue'/);assert.match(source,/:editor-key=/);assert.match(source,/:disabled="disabled"/);
});
test('canonical save changes only real two footer image slots, keeping foreign links and unrelated JSON',()=>{
  const l=loader(),ticket='/api/assets/7?expires=1&signature=old',foreign='https://foreign.test'+ticket,blocks=[{ name:'menus',img:ticket },{ ...footer(),name:'PAGEFOOT',link:ticket,menuList:[{ imgList:[ticket,ticket,ticket],link:ticket,preview:ticket },{ imgList:{0:ticket,1:ticket} },{ imgList:[foreign,'/static/logo.png'] }] }];
  const result=JSON.parse(l.load(editorFile).canonicalFooterValue(JSON.stringify(blocks))),expected=clone(blocks);expected[1].menuList[0].imgList=[ '/api/assets/7','/api/assets/7',ticket ];assert.deepEqual(result,expected);assert.throws(()=>l.load(editorFile).canonicalFooterValue('null'));assert.throws(()=>l.load(editorFile).canonicalFooterValue('broken'));
});
test('actual value edits preserve all other components and unknown nested footer properties',()=>{
  const r=harness(),before=r.value();r.state.setTab('effectConfig',0);r.state.setColour('activeTxtColor','#123456');r.state.setSpacing('topConfig',12);r.state.setRadius(2,14);r.state.setMenuText(1,'link','/pages/user/index');
  const after=r.value(),expected=clone(before);expected[1].effectConfig.tabVal=0;expected[1].activeTxtColor.color[0].item='#123456';expected[1].topConfig.val=12;expected[1].fillet.valList[2].val=14;expected[1].menuList[1].link='/pages/user/index';assert.deepEqual(after,expected);r.unmount();
});
test('styles retain the PHP fixed/floating spacing and four-corner0,1,3,2 geometry',()=>{
  const r=harness();r.state.setTab('navConfig',1);assert.deepEqual(clone(r.state.outerStyle),{padding:'0 10px 7px',background:'#f1f3f5'});assert.equal(r.state.barStyle.borderRadius,'2px 4px 8px 6px');assert.equal(r.state.barStyle.paddingTop,'6px');assert.equal(r.state.barStyle.paddingBottom,'8px');r.state.setRadiusType(0);r.state.setRadius(0,16);assert.equal(r.state.barStyle.borderRadius,'16px');r.state.setTab('navStyleConfig',2);assert.equal(r.state.tab('navStyleConfig',0),2);r.unmount();
});
test('all imported menus remain editable beyond5, including paged tail, and move/delete keep complete rows',()=>{
  const r=harness([footer(13)]);assert.equal(r.state.menus.length,13);r.state.addMenu();assert.equal(r.value()[0].menuList.length,13);r.state.menuPage=2;assert.deepEqual(r.state.visibleMenus.map(x=>x.index),[10,11,12]);r.state.setMenuText(12,'name','尾菜单');const moved=clone(r.value()[0].menuList[12]);r.state.moveMenu(12,-1);assert.deepEqual(r.value()[0].menuList[11],moved);r.state.removeMenu(0);assert.equal(r.value()[0].menuList.length,12);assert.equal(r.value()[0].menuList[10].name,'尾菜单');r.unmount();
});
test('normal add limit5 and explicit new footer leave the original body intact',()=>{
  const r=harness([{name:'titles',custom:{important:1}}]);r.state.addFooter();for(let n=0;n<7;n++)r.state.addMenu();assert.equal(r.state.menus.length,5);assert.deepEqual(r.value()[0],{name:'titles',custom:{important:1}});r.state.removeMenu(4);r.state.addMenu();assert.equal(r.state.menus.length,5);r.unmount();
});
test('duplicate imported footers select independently without merging or clipping',()=>{
  const a=footer(),b={...footer(),name:'PageFoot',custom:'second'},r=harness([a,{name:'blankPage'},b]);r.state.selectFooter(2);r.state.setMenuText(0,'name','第二个');assert.deepEqual(r.value()[0],a);assert.equal(r.value()[2].menuList[0].name,'第二个');r.unmount();
});
test('picker canonical reference and signed preview remain separate and never enter serialized JSON',()=>{
  const r=harness(),ticket='/api/assets/17?expires='+Math.ceil(Date.now()/1000+900)+'&signature=real-picker-preview';r.state.chooseIcon(0,0,'/api/assets/17',ticket);assert.equal(r.value()[1].menuList[0].imgList[0],'/api/assets/17');assert.equal(r.state.iconPreview(0,0),ticket);assert.ok(r.value()[1].menuList.every(row=>row.imgList.slice(0,2).every(value=>!value.includes('signature='))));assert.equal(r.value()[0].url,'/api/assets/7?expires=1&signature=keep');r.state.setIcon(0,1,ticket);assert.equal(r.value()[1].menuList[0].imgList[1],'/api/assets/17');assert.equal(r.value()[1].menuList[0].imgList[2],'bystander');r.unmount();
});
test('disabled editor invalid field domains and malformed imported rows cannot silently rewrite JSON',()=>{
  const r=harness(),before=r.props.modelValue;r.props.disabled=true;r.state.setMenuText(0,'name','blocked');r.state.chooseIcon(0,0,'/api/assets/3','/static/logo.png');r.state.addMenu();assert.equal(r.props.modelValue,before);r.props.disabled=false;
  r.state.setTab('effectConfig',2);r.state.setTab('effectConfig',false);r.state.setSpacing('topConfig',NaN);r.state.setColour('bgColor','url(javascript:1)');r.state.setMenuText(0,'__proto__','bad');r.state.setIcon(-1,0,'/static/x.png');assert.equal(r.props.modelValue,before);r.props.modelValue=JSON.stringify([{name:'pageFoot',menuList:{0:'bad'}}]);r.state.setTab('effectConfig',1);assert.ok(r.state.menuError);assert.equal(r.emits.length,0);r.unmount();
});
test('over10000 items refuse structured editing explicitly instead of silently losing tail',()=>{
  const r=harness([footer(10001)]),before=r.props.modelValue;assert.match(r.state.menuError,/10000/);r.state.removeMenu(0);assert.equal(r.props.modelValue,before);assert.equal(r.state.menus.length,10001);r.unmount();
});
test('pretty JSON exceeding2MB still edits when its actual compact saved value fits2MB',()=>{
  const value=[{name:'blankPage',padding:''},footer()];value[0].padding='x'.repeat(2_000_000-Buffer.byteLength(JSON.stringify(value)));const r=harness(value,{modelValue:JSON.stringify(value,null,2)});assert.ok(Buffer.byteLength(r.props.modelValue)>2_000_000);assert.equal(r.state.parseError,'');assert.equal(r.state.menus.length,2);r.unmount();
});
test('explicit saved preview uses real public read shape withoutid and never mutates canonical JSON',async()=>{
  const r=harness(),before=r.props.modelValue,ticket='/api/assets/7?expires='+Math.ceil(Date.now()/1000+900)+'&signature=public-preview',saved=footer();saved.menuList.forEach(row=>row.imgList[0]=ticket);const calls=[],original=global.fetch;
  global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({status:200,data:{title:'published',value:[saved]}})};};
  try{await r.state.loadSavedPreviews();assert.equal(r.state.previewError,'');assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/diy/get_diy/2');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.cache,'no-store');assert.equal(r.state.iconPreview(0,0),ticket);assert.equal(r.props.modelValue,before);}finally{global.fetch=original;r.unmount();}
});
test('unpublished closed mismatched or failed public preview cannot grant status/edit authority or alter JSON',async()=>{
  const original=global.fetch;
  try{for(const channel of ['unpublished','closed','changed','failed']){const r=harness(),before=r.props.modelValue,calls=[];if(channel==='unpublished')r.props.pagePublished=false;
    global.fetch=async()=>{calls.push(1);if(channel==='failed')throw Error('network');return {ok:true,json:async()=>channel==='closed'?{status:410010,data:null}:{status:200,data:{value:[{...footer(),custom:'different'}]}}};};await r.state.loadSavedPreviews();assert.equal(calls.length,channel==='unpublished'?0:1);if(channel!=='unpublished')assert.ok(r.state.previewError);assert.equal(r.props.modelValue,before);assert.equal(r.emits.length,0);assert.equal(r.state.iconPreview(0,0),'');r.unmount();}}finally{global.fetch=original;}
});
test('JSON editor owner disabled and unload transitions revoke late preview results',async()=>{
  const original=global.fetch;
  try{for(const channel of ['json','owner','disabled','unmount']){const r=harness(),gate=deferred(),ticket='/api/assets/7?expires='+Math.ceil(Date.now()/1000+900)+'&signature=late';let signal;global.fetch=async(_url,options)=>{signal=options.signal;return gate.promise;};const task=r.state.loadSavedPreviews();await tick();if(channel==='json')r.props.modelValue=JSON.stringify([footer(1)]);if(channel==='owner')r.props.editorKey='ownerB:row2';if(channel==='disabled')r.props.disabled=true;if(channel==='unmount')r.unmount();assert.equal(signal.aborted,true);const saved=footer();saved.menuList.forEach(row=>row.imgList[0]=ticket);gate.resolve({ok:true,json:async()=>({status:200,data:{value:[saved]}})});await task;assert.ok(!Object.values(r.state.previews).some(x=>x.preview===ticket));if(channel!=='unmount')r.unmount();}}finally{global.fetch=original;}
});
test('actual page save sends canonical footer only alongside independent content and immutable metadata stays out',async()=>{
  const writes=[],l=loader({gateway:{get:async()=>({data:[]}),post:async(url,body)=>{writes.push({url,body:clone(body)});return {data:{id:2,version:'changed',update_time:2}};}}}),m=mount(l.load(pageFile).default),source=footer();source.menuList[0].imgList[0]='/api/assets/7?expires=1&signature=old';m.state.openForm({id:2,name:'页面',title:'标题',value:JSON.stringify([{name:'unknown',extension:4},source]),content:'independent-content',status:1,type:1,template_name:'default',is_diy:1});await m.state.save();assert.equal(writes.length,1);assert.equal(writes[0].url,'/dise/save');assert.deepEqual(Object.keys(writes[0].body).sort(),['content','id','name','status','title','value']);assert.equal(writes[0].body.content,'independent-content');assert.ok(!writes[0].body.value.includes('signature='));assert.deepEqual(JSON.parse(writes[0].body.value)[0],{name:'unknown',extension:4});assert.equal(m.state.form.type,1);assert.equal(m.state.form.templateName,'default');assert.equal(m.state.form.isDiy,1);m.unmount();
});
test('new page preserves dormant DIY creation contract and validation never submits malformed/null/equal-content',async()=>{
  for(const channel of ['new','broken','null','equal']){const writes=[],l=loader({gateway:{get:async()=>({data:[]}),post:async(url,body)=>{writes.push({url,body});return{data:{id:3}};}}}),m=mount(l.load(pageFile).default);m.state.openForm();m.state.form.name='新页面';if(channel==='broken')m.state.form.value='broken';if(channel==='null')m.state.form.value='null';if(channel==='equal')m.state.form.content='[]';await m.state.save();assert.equal(writes.length,channel==='new'?1:0);if(channel==='new'){assert.equal(writes[0].body.create_kind,'diy_page');assert.equal(writes[0].body.status,0);assert.ok(!('type'in writes[0].body));}m.unmount();}
});
test('late page write cannot close or notify a replacement editor/account and duplicate save is suppressed',async()=>{
  const gate=deferred(),writes=[],l=loader({gateway:{get:async()=>({data:[]}),post:async(url,body)=>{writes.push({url,body});return gate.promise;}}}),m=mount(l.load(pageFile).default);m.state.openForm({id:2,name:'页面',title:'标题',value:JSON.stringify([footer()]),content:'separate',status:1,type:1,template_name:'default',is_diy:1});const task=m.state.save();await tick();await m.state.save();assert.equal(writes.length,1);l.storage.set('admin_token','ownerB');l.actor.token='ownerB';l.actor.userInfo={id:22,level:0};assert.equal(m.state.formVisible,false);gate.resolve({data:{id:2}});await task;assert.ok(!l.notices.some(([kind])=>kind==='success'));assert.equal(m.state.formVisible,false);m.unmount();
  const stale=loader(),fresh=mount(stale.load(pageFile).default);assert.equal(fresh.state.sessionReady,true);stale.storage.set('admin_token','foreign-stored');fresh.state.storedChanged(new Event('storage'));assert.equal(fresh.state.sessionReady,false);fresh.state.openForm();assert.equal(fresh.state.formVisible,false);fresh.unmount();
});


test('legacy page-save harness isolates the adjacent editorial view and retains its real canonical media save chain',async()=>{
  const writes=[],l=loader({gateway:{get:async()=>({data:[]}),post:async(url,body)=>{writes.push({url,body:clone(body)});return{data:{id:2}};}}}),m=mount(l.load(pageFile).default);
  const signed=id=>`/api/assets/${id}?expires=1&signature=old-canonical-only`,value=[
    {name:'news',imgConfig:{url:signed(31),meta:{keep:[]}},link:signed(31)},
    {name:'hotspot',picStyle:{url:signed(32),list:[{link:signed(32),opaque:0}]}},
    {name:'activeParty',titleConfig:{place:'retain-author-title',max:30},desConfig:{place:'retain-author-description',max:40},menuConfig:{list:Array.from({length:6},(_,i)=>({img:signed(33+i),link:signed(33+i),opaque:{i}}))}}
  ];
  try{m.state.openForm({id:2,name:'旧suite实际保存',title:'标题',value:JSON.stringify(value),content:'independent-content',status:1,type:1,template_name:'default',is_diy:1});await m.state.save();
    assert.equal(writes.length,1);assert.equal(writes[0].url,'/dise/save');assert.equal(writes[0].body.content,'independent-content');
    const expected=clone(value);expected[0].imgConfig.url='/api/assets/31';expected[1].picStyle.url='/api/assets/32';for(let i=0;i<4;i++)expected[2].menuConfig.list[i].img=`/api/assets/${33+i}`;
    assert.deepEqual(JSON.parse(writes[0].body.value),expected);
    assert.ok(l.loadedFiles().includes(path.join(root,'utils/diyEditorialEditor.ts')));
    assert.ok(!l.loadedFiles().includes(path.join(root,'components/content/DiyEditorialEditor.vue')));
  }finally{m.unmount();}
});
