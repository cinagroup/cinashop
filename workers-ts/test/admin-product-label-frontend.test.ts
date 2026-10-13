import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {productLabelCatalogState} from '../../view/admin-ts/src/utils/productLabelCatalogState';
import type {ProductLabelCatalogDependencies} from '../../view/admin-ts/src/utils/productLabelCatalogState';
import type {ProductLabelItem} from '../../view/admin-ts/src/types/productLabelCatalog';
const label=(id=10):ProductLabelItem=>({id,type:0,relation_id:0,label_cate:2,label_name:'新品',style_type:1,color:'#123',bg_color:'#fff',border_color:'',icon:'',icon_preview:'',is_show:1,status:1,sort:0,add_time:''});
const group={id:2,name:'常用',sort:0,group:2,type:0,relation_id:0,product_label:[label()]};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function harness(override:Partial<ProductLabelCatalogDependencies>={}){
  let identity='actor-a',manage=true;const mutate=vi.fn(async()=>({id:10}));
  const deps:ProductLabelCatalogDependencies={identity:()=>identity,manage:()=>manage,categories:async()=>({list:[group],count:1}),labels:async()=>({list:[label()],count:1}),mutate,proof:async()=>false,...override};
  return {workflow:productLabelCatalogState(deps),mutate,actor:(value:string)=>{identity=value;},grant:(value:boolean)=>{manage=value;}};
}
describe('product label state request and mutation boundaries',()=>{
  it('discards replaced-account and stale-page replies',async()=>{
    const slow=deferred<{list:ProductLabelItem[];count:number}>();const h=harness({labels:()=>slow.promise});
    const request=h.workflow.loadLabels();h.actor('actor-b');h.workflow.reset();slow.resolve({list:[label()],count:1});await request;expect(h.workflow.state.labels).toEqual([]);
    const first=deferred<{list:ProductLabelItem[];count:number}>(),second=deferred<{list:ProductLabelItem[];count:number}>();let calls=0;
    const current=harness({labels:()=>++calls===1?first.promise:second.promise});const old=current.workflow.loadLabels();current.workflow.selectPage(2);
    second.resolve({list:[label(12)],count:2});await second.promise;await Promise.resolve();first.resolve({list:[label(11)],count:2});await old;expect(current.workflow.state.labels.map(row=>row.id)).toEqual([12]);
  });
  it('clears current-page selections before changing a group or page',async()=>{
    const h=harness();await h.workflow.loadLabels();h.workflow.state.selected=[10];h.workflow.selectCategory(3);expect(h.workflow.state.selected).toEqual([]);
    await Promise.resolve();h.workflow.state.selected=[10];h.workflow.selectPage(2);expect(h.workflow.state.selected).toEqual([]);
  });
  it('retains selection and input after business rejection and freezes unknown results',async()=>{
    const fail=vi.fn(async()=>{throw Object.assign(Error('被商品引用'),{status:400});});const h=harness({mutate:fail});h.workflow.state.selected=[10];
    await h.workflow.run({kind:'label-batch',ids:[10]});expect(h.workflow.state.selected).toEqual([10]);expect(h.workflow.state.pending).toBeNull();
    fail.mockImplementation(async()=>{throw Error('reply lost');});await h.workflow.run({kind:'label-batch',ids:[10]});
    expect(h.workflow.state.pending).toEqual({kind:'label-batch',ids:[10]});expect(h.workflow.writable()).toBe(false);
    h.workflow.selectCategory(7);expect(h.workflow.state.category).toBe(0);
  });
  it('keeps original mutation content for retry and clears it only after positive reconciliation',async()=>{
    const sent:any[]=[],action={kind:'label-batch' as const,ids:[10]};let consistent=false;
    const h=harness({mutate:async value=>{sent.push(value);throw Error('network unknown');},proof:async()=>consistent});
    await h.workflow.run(action);action.ids.push(11);await h.workflow.retry();expect(sent).toEqual([{kind:'label-batch',ids:[10]},{kind:'label-batch',ids:[10]}]);
    expect(await h.workflow.reconcile()).toBe(false);expect(h.workflow.state.pending).not.toBeNull();consistent=true;
    expect(await h.workflow.reconcile()).toBe(true);expect(h.workflow.state.pending).toBeNull();
  });
  it('requires complete batch ACKs and preserves pending actions on a malformed success',async()=>{
    const h=harness({mutate:async()=>({ids:[10],protected_ids:[],count:1})});
    expect(await h.workflow.run({kind:'label-batch',ids:[10,11]})).toBe(false);expect(h.workflow.state.pending).not.toBeNull();
  });
  it('withdraws successful late replies after revocation or identity replacement',async()=>{
    const result=deferred<unknown>(),h=harness({mutate:()=>result.promise});const request=h.workflow.run({kind:'label-flag',id:10,field:'status',value:0});h.grant(false);result.resolve({id:10,status:0});
    expect(await request).toBe(false);expect(h.workflow.state.labels).toEqual([]);expect(h.workflow.writable()).toBe(false);
    const replaced=deferred<unknown>(),other=harness({mutate:()=>replaced.promise});const old=other.workflow.run({kind:'label-flag',id:10,field:'status',value:0});other.actor('replacement');other.workflow.reset();replaced.resolve({id:10,status:0});expect(await old).toBe(false);expect(other.workflow.state.pending).toBeNull();
  });
  it('latches server authority rejection across read, write and unchanged-session refreshes',async()=>{
    const h=harness({mutate:async()=>{throw Object.assign(Error('暂无权限访问'),{status:400011});}});
    await h.workflow.loadLabels();h.workflow.state.selected=[10];
    expect(await h.workflow.run({kind:'label-flag',id:10,field:'status',value:0})).toBe(false);
    expect(h.workflow.state.revoked).toBe(true);expect(h.workflow.state.labels).toEqual([]);expect(h.workflow.state.selected).toEqual([]);expect(h.workflow.state.pending).toBeNull();
    h.workflow.reset();await h.workflow.loadLabels();expect(h.workflow.state.labels).toEqual([]);expect(h.workflow.writable()).toBe(false);
    await h.workflow.run({kind:'label-delete',id:10});expect(h.workflow.state.pending).toBeNull();
    h.actor('refreshed-authority');h.workflow.reset();expect(h.workflow.writable()).toBe(true);
    const reader=harness({labels:async()=>{throw Object.assign(Error('已撤回读取'),{status:400011});}});
    await reader.workflow.loadLabels();expect(reader.workflow.state.revoked).toBe(true);expect(reader.workflow.writable()).toBe(false);
  });
});

let runtime:any,storage:Map<string,string>,browser:EventTarget;
const closes:Array<()=>void>=[];
beforeAll(async()=>{
  const root=resolve(import.meta.dirname,'../../view/admin-ts'),require=createRequire(resolve(root,'package.json'));
  const {parse,compileScript,compileTemplate}=require('@vue/compiler-sfc');
  const filename=resolve(root,'src/pages/label/ProductLabelCatalog.vue'),descriptor=parse(readFileSync(filename,'utf8'),{filename}).descriptor;
  expect(compileTemplate({source:descriptor.template.content,filename,id:'product-label-page'}).errors).toEqual([]);
  vi.stubGlobal('window',Object.assign(new EventTarget(),{location:{pathname:'/label/products',href:''}}));
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem(){},removeItem(){}});
  const result=await build({absWorkingDir:root,stdin:{resolveDir:root,contents:`export {default as Page} from './src/pages/label/ProductLabelCatalog.vue';export {default as request} from './src/utils/request';export {createRenderer,nextTick,h,defineComponent} from 'vue';`},
    alias:{'@':resolve(root,'src')},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'product-label-sfc',setup(builder){
      builder.onLoad({filter:/\.vue$/},({path})=>({contents:compileScript(parse(readFileSync(path,'utf8'),{filename:path}).descriptor,{id:'product-label-page',inlineTemplate:true}).content,loader:'ts'}));
      builder.onResolve({filter:/^element-plus$/},()=>({path:'messages',namespace:'label-fixture'}));
      builder.onLoad({filter:/.*/,namespace:'label-fixture'},()=>({contents:`export const ElMessageBox={confirm:async()=>true};`}));
    }}]});
  runtime=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
},30000);
beforeEach(()=>{
  storage=new Map();browser=Object.assign(new EventTarget(),{location:{pathname:'/label/products',href:''}});
  vi.stubGlobal('window',browser);vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});
});
afterEach(()=>{for(const close of closes.splice(0))close();vi.unstubAllGlobals();});
function session(permissions=['label.view','label.manage']){storage.set('admin_token','label-browser-token');storage.set('admin_session',JSON.stringify({userInfo:{id:101,level:1,account:'operator'},uniqueAuth:permissions,menus:[]}));}
async function flush(){for(let i=0;i<6;i++){await new Promise(done=>setTimeout(done,1));await runtime.nextTick();}}
async function mount(respond?:(config:any)=>any){
  session();const calls:any[]=[];runtime.request.defaults.adapter=async(config:any)=>{
    calls.push(config);const data=respond?await respond(config):config.url==='/product/label_cate'?{list:[group],count:1}:config.url==='/product/label/form'?{rules:[{field:'label_cate',options:[{value:2,label:'常用'}]}]}:{list:[label()],count:1};
    return {config,data:{status:200,msg:'ok',data},status:200,statusText:'fixture',headers:{}};
  };
  const renderer=runtime.createRenderer({patchProp(){},insert(){},remove(){},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null});
  const app=renderer.createApp({...runtime.Page,setup(props:unknown,context:unknown){runtime.Page.setup(props,context);return ()=>null;}}),vm=app.mount({});closes.push(()=>app.unmount());await flush();return {vm,calls};
}
interface LabelUiNode {type:string;text:string;props:Record<string,unknown>;children:LabelUiNode[];parent:LabelUiNode|null}
const uiNode=(type:string,text=''):LabelUiNode=>({type,text,props:{},children:[],parent:null});
const uiDescendants=(node:LabelUiNode):LabelUiNode[]=>[node,...node.children.flatMap(uiDescendants)];
const uiText=(node:LabelUiNode):string=>node.text+node.children.map(uiText).join('');
async function mountRendered(){
  session();const root=uiNode('root');
  const renderer=runtime.createRenderer({
    patchProp(node:LabelUiNode,key:string,_old:unknown,value:unknown){node.props[key]=value;},
    insert(node:LabelUiNode,parent:LabelUiNode,anchor:LabelUiNode|null){if(node.parent){const old=node.parent.children.indexOf(node);if(old>=0)node.parent.children.splice(old,1);}const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,node);node.parent=parent;},
    remove(node:LabelUiNode){if(node.parent){const index=node.parent.children.indexOf(node);if(index>=0)node.parent.children.splice(index,1);}node.parent=null;},
    createElement:(type:string)=>uiNode(type),createText:(text:string)=>uiNode('#text',text),createComment:(text:string)=>uiNode('#comment',text),
    setText(node:LabelUiNode,text:string){node.text=text;},setElementText(node:LabelUiNode,text:string){node.text=text;node.children=[];},parentNode:(node:LabelUiNode)=>node.parent,
    nextSibling:(node:LabelUiNode)=>node.parent?.children[node.parent.children.indexOf(node)+1]??null,
  });
  const app=renderer.createApp(runtime.Page);
  const wrapper=runtime.defineComponent({setup(_props:unknown,{slots}:any){return ()=>runtime.h('fixture-wrapper',{},slots.default?.());}});
  for(const name of ['el-form','el-form-item','el-input','el-input-number','el-select','el-option','el-radio-group','el-radio','el-color-picker','el-switch','el-empty','el-table-column','el-pagination','router-link'])app.component(name,wrapper);
  app.component('el-table',runtime.defineComponent({setup(){return ()=>runtime.h('fixture-table');}}));
  app.component('el-alert',runtime.defineComponent({props:['title'],setup(props:any,{slots}:any){return ()=>runtime.h('fixture-alert',{title:props.title},slots.default?.());}}));
  app.component('el-button',runtime.defineComponent({props:['disabled'],setup(props:any,{slots,attrs}:any){return ()=>runtime.h('fixture-button',{...attrs,disabled:!!props.disabled},slots.default?.());}}));
  app.component('el-dialog',runtime.defineComponent({props:['modelValue','title'],setup(props:any,{slots}:any){return ()=>props.modelValue?runtime.h('fixture-dialog',{title:props.title},[slots.default?.(),slots.footer?.()]):null;}}));
  app.directive('loading',{});const vm=app.mount(root);closes.push(()=>app.unmount());await flush();return {vm,root};
}
describe('real compiled Vue label page setup and API wiring',()=>{
  it('renders and activates retry or proof inside the retained label and category modals',async()=>{
    for(const kind of ['label','category'] as const)for(const recovery of ['retry','proof'] as const){
      const calls:any[]=[];let malformed=true,body:Record<string,unknown>={};
      runtime.request.defaults.adapter=async(config:any)=>{
        calls.push(config);let data:unknown;
        if(config.method==='post'){body=JSON.parse(config.data);data={id:malformed?0:100};}
        else if(config.url==='/product_label/list')data=[{id:100,labelCate:body.label_cate,labelName:body.label_name,styleType:body.style_type,color:body.color,bgColor:body.bg_color,borderColor:body.border_color,icon:body.icon,isShow:body.is_show,status:body.status,sort:body.sort}];
        else if(config.url==='/product/label_cate'){const categories=kind==='category'&&body.name?[group,{...group,id:100,name:body.name,sort:body.sort}]:[group];data={list:categories,count:categories.length};}
        else if(config.url==='/product/label/form')data={rules:[{field:'label_cate',options:[{value:2,label:'常用'}]}]};
        else data={list:[label()],count:1};
        return {config,data:{status:200,msg:'ok',data},status:200,statusText:'fixture',headers:{}};
      };
      const {vm,root}=await mountRendered();
      if(kind==='label'){await vm.openLabel();Object.assign(vm.labelForm,{label_cate:2,label_name:'模板标签恢复'});await vm.saveLabel();}
      else{vm.openCategory();vm.categoryForm.name='模板分组恢复';await vm.saveCategory();}
      await flush();expect(vm.state.pending?.kind).toBe(kind==='label'?'label-save':'category-save');
      const modals=uiDescendants(root).filter(node=>node.type==='fixture-dialog');expect(modals).toHaveLength(1);expect(modals[0].props.title).toBe(kind==='label'?'新增商品标签':'新增标签分组');
      const name=recovery==='retry'?'重试原操作':'核对服务器状态',buttons=uiDescendants(modals[0]).filter(node=>node.type==='fixture-button'&&uiText(node)===name);
      expect(buttons).toHaveLength(1);expect(uiDescendants(root).filter(node=>node.type==='fixture-button'&&uiText(node)===name)).toHaveLength(1);expect(buttons[0].props.disabled).toBe(false);
      const before=calls.filter(config=>config.method==='post');malformed=false;await (buttons[0].props.onClick as ()=>Promise<unknown>)();await flush();
      expect(vm.state.pending).toBeNull();expect(vm.labelDialog).toBe(false);expect(vm.categoryDialog).toBe(false);expect(uiDescendants(root).filter(node=>node.type==='fixture-dialog')).toHaveLength(0);
      const after=calls.filter(config=>config.method==='post');expect(after).toHaveLength(recovery==='retry'?before.length+1:before.length);if(recovery==='retry')expect(JSON.parse(after.at(-1).data)).toEqual(JSON.parse(before.at(-1).data));
    }
  });
  it('can retry and reconcile the original mutation held inside the actual Vue reactive state',async()=>{
    const {vm,calls}=await mount();await vm.openLabel(label());Object.assign(vm.labelForm,{label_name:'原输入冻结'});
    const reader=runtime.request.defaults.adapter;let writes=0;
    runtime.request.defaults.adapter=async(config:any)=>{
      if(config.method==='post'){calls.push(config);writes++;throw Error('connection lost after dispatch');}
      return reader(config);
    };
    await vm.saveLabel();expect(vm.state.pending?.kind).toBe('label-save');expect(vm.labelDialog).toBe(true);
    vm.labelForm.label_name='迟到修改不得替换原内容';
    expect(await vm.workflow.retry()).toBe(false);expect(writes).toBe(2);
    const sent=calls.filter(row=>row.method==='post').map(row=>JSON.parse(row.data));
    expect(sent[0]).toEqual(sent[1]);expect(sent[1].label_name).toBe('原输入冻结');
    // A failed proof retains the exact original action without a clone exception.
    expect(await vm.workflow.reconcile()).toBe(false);expect(vm.state.pending?.body.label_name).toBe('原输入冻结');
  });
  it('closes the original dialog only after complete server proof of the reactive pending write',async()=>{
    const {vm,calls}=await mount();await vm.openLabel(label());vm.labelForm.label_name='已落盘原输入';
    const reader=runtime.request.defaults.adapter;
    runtime.request.defaults.adapter=async(config:any)=>{
      if(config.method==='post'){calls.push(config);throw Error('reply lost');}
      if(config.url==='/product_label/list')return {config,data:{status:200,msg:'ok',data:[{
        id:10,labelCate:2,labelName:'已落盘原输入',styleType:1,color:'#123',bgColor:'#fff',borderColor:'',icon:'',isShow:1,status:1,sort:0,
      }]},status:200,statusText:'fixture',headers:{}};
      return reader(config);
    };
    await vm.saveLabel();expect(vm.labelDialog).toBe(true);expect(vm.state.pending).not.toBeNull();
    await vm.recoverPending();expect(vm.state.pending).toBeNull();expect(vm.labelDialog).toBe(false);
    expect(calls.filter(row=>row.method==='post')).toHaveLength(1);
  });
  it('loads real reactive groups and labels and writes full presentation fields through the old route',async()=>{
    const {vm,calls}=await mount(config=>config.method==='post'?{id:1000}:config.url==='/product/label_cate'?{list:[group],count:1}:config.url==='/product/label/form'?{rules:[{field:'label_cate',options:[{value:2,label:'常用'}]}]}:{list:[label()],count:1});
    expect(vm.state.labels[0].id).toBe(10);await vm.openLabel();Object.assign(vm.labelForm,{label_cate:2,label_name:'SFC图片',style_type:2,icon:'https://static.example.test/tag.png',is_show:0,status:1});await vm.saveLabel();
    const saved=calls.find(row=>row.url==='/product/label/0');expect(JSON.parse(saved.data)).toMatchObject({label_cate:2,label_name:'SFC图片',style_type:2,icon:'https://static.example.test/tag.png',is_show:0,status:1,border_color:''});expect(vm.labelDialog).toBe(false);
  });
  it('retains the real dialog draft on backend conflict',async()=>{
    const {vm}=await mount(config=>{if(config.method==='post')throw Object.assign(Error('标签已存在'),{status:400});return config.url==='/product/label_cate'?{list:[group],count:1}:config.url==='/product/label/form'?{rules:[{field:'label_cate',options:[{value:2,label:'常用'}]}]}:{list:[label()],count:1};});
    await vm.openLabel();Object.assign(vm.labelForm,{label_cate:2,label_name:'输入保留'});await vm.saveLabel();expect(vm.labelDialog).toBe(true);expect(vm.labelForm.label_name).toBe('输入保留');expect(vm.state.pending).toBeNull();
  });
  it('clears actual dialogs, rows and drafts when session grants change',async()=>{
    const {vm}=await mount();await vm.openLabel(label());vm.state.selected=[10];session(['user.view']);browser.dispatchEvent(new Event('admin-session-changed'));await flush();
    expect(vm.labelDialog).toBe(false);expect(vm.labelForm.label_name).toBe('');expect(vm.state.selected).toEqual([]);
  });
  it('clears the actual draft and disables further writes on a real permission-error envelope',async()=>{
    const {vm,calls}=await mount();await vm.openLabel(label());vm.state.selected=[10];
    const original=runtime.request.defaults.adapter;
    runtime.request.defaults.adapter=async(config:any)=>{
      if(config.method==='post'){calls.push(config);return {config,data:{status:400011,msg:'暂无权限访问',data:null},status:200,statusText:'fixture',headers:{}};}
      return original(config);
    };
    vm.labelForm.label_name='撤权前草稿';await vm.saveLabel();await flush();
    expect(vm.state.revoked).toBe(true);expect(vm.labelDialog).toBe(false);expect(vm.categoryDialog).toBe(false);expect(vm.labelForm.label_name).toBe('');
    expect(vm.state.labels).toEqual([]);expect(vm.state.selected).toEqual([]);expect(vm.workflow.writable()).toBe(false);
    const writes=calls.filter(row=>['post','put','delete'].includes(row.method)).length;await vm.openLabel();await vm.workflow.run({kind:'label-delete',id:10});
    expect(vm.labelDialog).toBe(false);expect(calls.filter(row=>['post','put','delete'].includes(row.method)).length).toBe(writes);
    browser.dispatchEvent(new Event('admin-session-changed'));await flush();expect(vm.workflow.writable()).toBe(false);
    storage.set('admin_token','replacement-token');browser.dispatchEvent(new Event('admin-session-changed'));await flush();expect(vm.workflow.writable()).toBe(true);
  });
});
