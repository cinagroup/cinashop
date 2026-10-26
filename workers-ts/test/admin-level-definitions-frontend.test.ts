import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root,'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, storage: Map<string,string>;
const grants = ['level.view','level.manage','attachment.view'];
const ownerEvent = (name:string) => (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event(name));
function session(id = 9611, permissions = grants, dispatch = true) {
  storage.set('admin_token', `owned-level-admin-${id}`);
  storage.set('admin_session', JSON.stringify({ userInfo: { id, account: `level-admin-${id}`, head_pic: '', real_name: '等级管理员', level: 1, roles: '1' }, menus: [], uniqueAuth: permissions }));
  if (dispatch) ownerEvent('admin-session-changed');
}
function globals() {
  storage = new Map();
  vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)});
  vi.stubGlobal('window',Object.assign(new EventTarget(),{location:{pathname:'/level',href:''}}));
}
beforeAll(async()=>{
  globals();session(9611,grants,false);
  const result = await build({ absWorkingDir:root,stdin:{resolveDir:root,contents:`
    export {default as Page} from './src/pages/level/LevelList.vue';
    export {default as Picker} from './src/pages/activity/SeckillActivityImagePicker.vue';
    export * as api from './src/api/level'; export {default as request} from './src/utils/request';
    export {useAuthStore} from './src/stores/auth';
    export {createRenderer,defineComponent,h,nextTick} from 'vue'; export {createPinia} from 'pinia';
    export * as messages from 'element-plus';
  `},alias:{'@':resolve(root,'src')},define:{'import.meta.env.DEV':'false','__VUE_OPTIONS_API__':'true','__VUE_PROD_DEVTOOLS__':'false','__VUE_PROD_HYDRATION_MISMATCH_DETAILS__':'false'},bundle:true,write:false,platform:'browser',format:'esm',plugins:[{name:'actual-level-SFCs',setup(builder){
    builder.onLoad({filter:/\.vue$/},({path})=>{
      const descriptor=parse(readFileSync(path,'utf8'),{filename:path}).descriptor,script=compileScript(descriptor,{id:'level-definition-runtime'});
      const template=compileTemplate({source:descriptor.template.content,filename:path,id:'level-definition-runtime',compilerOptions:{bindingMetadata:script.bindings}});
      if(template.errors.length)throw Error(JSON.stringify(template.errors));
      return {contents:script.content.replace('export default','const __component =')+'\n'+template.code+'\n__component.render=render;export default __component;',loader:'ts'};
    });
    builder.onResolve({filter:/^element-plus$/},()=>({path:'elements',namespace:'owned'}));
    builder.onLoad({filter:/.*/,namespace:'owned'},()=>({resolveDir:root,contents:`
      export {default as RealPagination} from ${JSON.stringify(resolve(root,'node_modules/element-plus/es/components/pagination/src/pagination.mjs'))};
      export const state={notices:[],confirm:()=>Promise.resolve()};
      export const ElMessage={error:v=>state.notices.push(['error',v]),success:v=>state.notices.push(['success',v]),warning:v=>state.notices.push(['warning',v])};
      export const ElMessageBox={confirm:(...args)=>state.confirm(...args)};
    `}));
  }}]});
  runtime=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(()=>{globals();session(9611,grants,false);runtime.messages.state.notices=[];runtime.messages.state.confirm=()=>Promise.resolve();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const flush=async()=>{for(let i=0;i<8;i++){await runtime.nextTick();await new Promise(setImmediate);}};
const deferred=()=>{let resolve!:(v?:any)=>void,reject!:(e:unknown)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
const ticket=(id:number)=>`/api/assets/${id}?expires=${Math.floor(Date.now()/1000)+900}&signature=${'A'.repeat(43)}`;
const row=(n:number)=>({id:7100+n,name:`会员等级${n}`,grade:n,discount:'95.25',expNum:n*100,isShow:n%3===0?0:1,isDel:0,
  icon:'/api/assets/4',image:'/api/assets/5',color:'#987333',explain:`等级${n}说明`,merId:9,money:'12.50',validDate:30,isForever:0,isPay:1,addTime:1700000000});
type Tree={tag:string;props:any;children:Tree[];parent?:Tree;text:string};
const node=(tag:string):Tree=>({tag,props:{},children:[],text:''});
const text=(n:Tree):string=>n.text+n.children.map(text).join('');
const all=(n:Tree,predicate:(v:Tree)=>boolean):Tree[]=>[...(predicate(n)?[n]:[]),...n.children.flatMap(child=>all(child,predicate))];
async function mount(){
  const data=Array.from({length:25},(_,i)=>row(i+1)),calls:any[]=[],hooks:{read?:(c:any)=>Promise<any>;write?:(c:any)=>Promise<any>}={};
  const base=(c:any)=>{
    if(c.url==='/file/category')return {list:[]};
    if(c.url==='/file/file')return {list:[4,5].map(id=>({att_id:id,canonical_url:`/api/assets/${id}`,att_dir:ticket(id),satt_dir:ticket(id),real_name:`素材${id}.png`,att_type:'image/png',att_size:'32 B',raw_size:32,pid:0,time:'2026-10-26',type:1,file_type:1,module_type:1,relation_id:0})),count:2};
    if(c.url!=='/level/list')throw Error('Unexpected GET '+c.url);
    const q=c.params??{},rows=data.filter(v=>(!q.title||v.name.includes(q.title))&&(q.is_show===undefined||v.isShow===q.is_show)).sort((a,b)=>a.grade-b.grade||a.id-b.id);
    if(q.paged!==1)return clone(rows);
    return {list:clone(rows.slice((q.page-1)*q.limit,q.page*q.limit)).map((v:any)=>({...v,icon_preview:ticket(4),image_preview:ticket(5)})),count:rows.length,page:q.page,limit:q.limit};
  };
  runtime.request.defaults.adapter=async(c:any)=>{
    calls.push(c);let result:any;
    if(c.method==='get')result=hooks.read?await hooks.read(c):base(c);
    else if(hooks.write)result=await hooks.write(c);
    else if(c.method==='delete'){const id=Number(c.url.split('/').at(-1)),index=data.findIndex(v=>v.id===id);if(index>=0)data.splice(index,1);result=null;}
    else{const input=JSON.parse(c.data),id=input.id??Math.max(...data.map(v=>v.id))+1;let target=data.find(v=>v.id===id);
      if(!target){target={...row(id-7100),id};data.push(target);}
      const mapping:any={exp_num:'expNum',is_show:'isShow'};
      for(const[key,value]of Object.entries(input))if(key!=='id')(target as any)[mapping[key]??key]=value;
      result={id};}
    return {config:c,data:result?._envelope??{status:200,msg:'ok',data:result},status:200,statusText:'owned frontend transport',headers:{}};
  };
  const renderer=runtime.createRenderer({createElement:node,createText:(t:string)=>({...node('#text'),text:t}),createComment:(t:string)=>({...node('#comment'),text:t}),
    insert(n:Tree,parent:Tree,anchor?:Tree){if(n.parent){const i=n.parent.children.indexOf(n);if(i>=0)n.parent.children.splice(i,1);}n.parent=parent;const i=anchor?parent.children.indexOf(anchor):-1;if(i<0)parent.children.push(n);else parent.children.splice(i,0,n);},
    remove(n:Tree){if(n.parent){const i=n.parent.children.indexOf(n);if(i>=0)n.parent.children.splice(i,1);n.parent=undefined;}},parentNode:(n:Tree)=>n.parent,nextSibling:()=>null,
    patchProp:(n:Tree,key:string,_old:unknown,v:unknown)=>n.props[key]=v,setText:(n:Tree,t:string)=>n.text=t,setElementText:(n:Tree,t:string)=>{n.text=t;n.children=[];}});
  const elements=['el-alert','el-button','el-card','el-form','el-form-item','el-input','el-input-number','el-select','el-option','el-table','el-table-column','el-image','el-switch','el-tag','el-divider','el-pagination','el-dialog','el-color-picker','el-upload'];
  const stub=(name:string)=>runtime.defineComponent({inheritAttrs:false,props:['modelValue','disabled','label','title'],emits:['update:modelValue'],setup(p:any,{attrs,slots,emit}:any){return()=>{
    if(name==='el-table-column'||name==='el-dialog'&&!p.modelValue)return null;const tag=name==='el-button'?'button':name==='el-input'||name==='el-input-number'?'input':'section';
    return runtime.h(tag,{...attrs,disabled:p.disabled,'data-element':name,'data-label':p.label,modelValue:p.modelValue,'onUpdate:modelValue':(v:unknown)=>emit('update:modelValue',v)},tag==='input'?null:[slots.default?.(),slots.footer?.()]);
  };}});
  let view:any;const pickerStates:any[]=[],originalPage=runtime.Page.setup,originalPicker=runtime.Picker.setup;
  runtime.Page.setup=(props:any,context:any)=>{view=originalPage(props,context);return view;};
  runtime.Picker.setup=(props:any,context:any)=>{const state=originalPicker(props,context);pickerStates.push({props,state});return state;};
  const tree=node('root'),app=renderer.createApp(runtime.Page);app.use(runtime.createPinia());
  for(const name of elements)app.component(name,name==='el-pagination'?{...runtime.messages.RealPagination,setup(props:any,context:any){runtime.messages.RealPagination.setup(props,context);return()=>runtime.h('section',{'data-element':'el-pagination'});}}:stub(name));app.directive('loading',{});try{app.mount(tree);await flush();}catch(reason){app.unmount();runtime.Page.setup=originalPage;runtime.Picker.setup=originalPicker;throw reason;}
  const get=(name:string)=>view[name]?.value??view[name];
  return {data,calls,hooks,tree,view,pickerStates,get,base,reads:()=>calls.filter(c=>c.url==='/level/list'),writes:()=>calls.filter(c=>c.method!=='get'),
    close(){app.unmount();runtime.Page.setup=originalPage;runtime.Picker.setup=originalPicker;}};
}
async function button(f:any,label:string){const b=all(f.tree,(n:Tree)=>n.tag==='button'&&text(n)===label)[0];expect(b,'actual template button '+label).toBeTruthy();await b.props.onClick();await flush();}

it('actual SFC/Vue/Pinia/Axios reads PHP page10/count and uses applied filters including explicit hidden0',async()=>{
  const f=await mount();try{expect(f.get('list')).toHaveLength(10);expect(f.get('count')).toBe(25);expect(f.reads()[0].params).toEqual({paged:1,page:1,limit:10});expect(f.reads()[0].headers['Authori-zation']).toBe('Bearer owned-level-admin-9611');
    f.get('draft').title='会员等级2';f.get('draft').is_show='0';await button(f,'查询');expect(f.reads().at(-1).params).toEqual({paged:1,page:1,limit:10,title:'会员等级2',is_show:0});expect(f.get('list').every((v:any)=>v.isShow===0)).toBe(true);
    f.get('draft').title='unsubmitted';await f.view.load(2);expect(f.reads().at(-1).params.title).toBe('会员等级2');await button(f,'重置');expect(f.get('draft').title).toBe('');expect(f.reads().at(-1).params).toEqual({paged:1,page:1,limit:10});
  }finally{f.close();}
});
it('last-page deletion performs one authoritative fallback and stale row handlers cannot edit another page',async()=>{
  const f=await mount();try{await f.view.load(3);const stale=f.get('list')[0];f.data.splice(20,4);await f.view.load(3);expect(f.get('list')).toHaveLength(1);await f.view.remove(f.get('list')[0]);expect(f.get('page')).toBe(2);expect(f.get('count')).toBe(20);expect(f.reads().slice(-2).map(c=>c.params.page)).toEqual([3,2]);f.view.openForm(stale);await f.view.toggle(stale,0);expect(f.get('formVisible')).toBe(false);expect(f.writes()).toHaveLength(1);}finally{f.close();}
});
it('real form preserves distinct media and latent stored fields; editing exact discount uses a string',async()=>{
  const f=await mount();try{await button(f,'添加会员等级');expect(f.get('formVisible')).toBe(true);expect(text(f.tree)).toContain('656 × 300');expect(text(f.tree)).toContain('750 × 990');f.view.closeForm();
    f.view.openForm(f.get('list')[0]);f.view.updateField('name','更新等级');f.view.updateField('discount','90.25');await f.view.save();const body=JSON.parse(f.writes()[0].data);expect(body).toMatchObject({id:7101,name:'更新等级',discount:'90.25',icon:'/api/assets/4',image:'/api/assets/5'});for(const key of ['money','valid_date','validDate','is_forever','isForever','is_pay','isPay','merId'])expect(body).not.toHaveProperty(key);expect(f.data[0]).toMatchObject({merId:9,money:'12.50',validDate:30,isForever:0,isPay:1});expect(f.get('formVisible')).toBe(false);
  }finally{f.close();}
});
it('two actual embedded library instances choose stable references into only their own slots',async()=>{
  const f=await mount();try{f.view.openForm(f.get('list')[0]);await flush();expect(f.pickerStates).toHaveLength(2);const icon=f.pickerStates.find(v=>v.props.title==='选择等级图标').state,image=f.pickerStates.find(v=>v.props.title==='选择会员背景').state;
    await icon.open();await flush();icon.choose(icon.items.value.find((v:any)=>v.att_id===5));await flush();expect(f.get('form').icon).toBe('/api/assets/5');expect(f.get('form').image).toBe('/api/assets/5');
    await image.open();await flush();image.choose(image.items.value.find((v:any)=>v.att_id===4));await flush();expect(f.get('form').icon).toBe('/api/assets/5');expect(f.get('form').image).toBe('/api/assets/4');await f.view.save();expect(JSON.parse(f.writes()[0].data)).toMatchObject({icon:'/api/assets/5',image:'/api/assets/4'});
  }finally{f.close();}
});
it('view-only grants render reads and reject all retained write/form handlers',async()=>{
  session(9611,['level.view'],false);const f=await mount();try{expect(f.get('list')).toHaveLength(10);expect(all(f.tree,n=>n.tag==='button'&&text(n)==='添加会员等级')).toHaveLength(0);f.view.openForm(f.get('list')[0]);await f.view.toggle(f.get('list')[0],0);await f.view.remove(f.get('list')[0]);expect(f.writes()).toHaveLength(0);expect(f.get('formVisible')).toBe(false);}finally{f.close();}
});
it('persisted permission replacement fences controls synchronously before any event',async()=>{
  const f=await mount();try{f.view.openForm(f.get('list')[0]);const old=f.get('form').name;session(9611,['level.view'],false);f.view.updateField('name','stale');f.view.setMedia('icon','/api/assets/5',ticket(5));await f.view.save();expect(f.writes()).toHaveLength(0);expect(f.get('formVisible')).toBe(false);expect(f.get('form').name).not.toBe(old);ownerEvent('focus');await flush();expect(f.get('list')).toHaveLength(10);expect(f.get('canManage')).toBe(false);}finally{f.close();}
});
it('late old owner completion neither clears a replacement editor nor publishes success',async()=>{
  const f=await mount(),gate=deferred();try{f.view.openForm(f.get('list')[0]);f.hooks.write=()=>gate.promise;const pending=f.view.save();await flush();session(9622);await flush();f.view.openForm(f.get('list')[1]);const name=f.get('form').name;gate.resolve({id:7101});await pending;expect(f.get('formVisible')).toBe(true);expect(f.get('form').name).toBe(name);expect(runtime.messages.state.notices.filter((v:any)=>v[0]==='success')).toEqual([]);}finally{gate.resolve({id:7101});f.close();}
});
it('lost committed response locks writes without retry, preserves draft, then explicit reread adopts real state',async()=>{
  const f=await mount();try{f.view.openForm(f.get('list')[0]);f.view.updateField('name','已提交但丢失响应');f.hooks.write=async c=>{f.data[0].name=JSON.parse(c.data).name;throw Error('network-lost');};const reads=f.reads().length;await f.view.save();expect(f.writes()).toHaveLength(1);expect(f.reads()).toHaveLength(reads);expect(f.get('needsReview')).toBe(true);expect(f.get('formVisible')).toBe(true);expect(f.get('form').name).toBe('已提交但丢失响应');await f.view.save();await f.view.toggle(f.get('list')[0],0);expect(f.writes()).toHaveLength(1);await f.view.load();expect(f.get('needsReview')).toBe(false);expect(f.get('list')[0].name).toBe('已提交但丢失响应');expect(f.get('form').name).toBe('已提交但丢失响应');}finally{f.close();}
});
it('actual business rejection keeps editable draft without claiming a successful save',async()=>{
  const f=await mount();try{f.view.openForm(f.get('list')[0]);f.hooks.write=async()=>({_envelope:{status:400,msg:'等级已存在',data:null}});await f.view.save();expect(f.get('needsReview')).toBe(false);expect(f.get('error')).toBe('等级已存在');expect(f.get('formVisible')).toBe(true);await flush();expect(all(f.tree,(n:Tree)=>n.props['data-element']==='el-pagination')).toHaveLength(1);expect(runtime.messages.state.notices.filter((v:any)=>v[0]==='success')).toEqual([]);}finally{f.close();}
});
it('duplicate mutation, page movement and delayed delete confirmation are fenced',async()=>{
  const f=await mount(),gate=deferred();try{const selected=f.get('list')[0];runtime.messages.state.confirm=()=>gate.promise;const pending=f.view.remove(selected);await flush();await f.view.toggle(selected,0);await f.view.load(2);expect(f.writes()).toHaveLength(0);session(9622);await flush();gate.resolve();await pending;expect(f.writes()).toHaveLength(0);expect(f.get('page')).toBe(1);}finally{gate.resolve();f.close();}
});
it('obsolete read errors and late authentication rejection cannot erase a new session',async()=>{
  const f=await mount(),gate=deferred();try{f.hooks.read=c=>c.params?.page===2?gate.promise:Promise.resolve(f.base(c));const pending=f.view.load(2);await flush();const old=f.reads().at(-1);session(9622);await flush();expect(old.signal.aborted).toBe(true);gate.resolve({_envelope:{status:410001,msg:'old expired',data:null}});await pending;expect(storage.get('admin_token')).toBe('owned-level-admin-9622');expect(f.get('list')).toHaveLength(10);expect(f.get('loading')).toBe(false);}finally{gate.resolve({list:[],count:0,page:2,limit:10});f.close();}
});
it('malformed page receipts are rejected, and unsupported query/decimal/changed zero values never submit',async()=>{
  const f=await mount();try{const api=runtime.api,q={page:1,limit:10},valid=f.base({url:'/level/list',params:{paged:1,...q}});expect(()=>api.parseLevelPage({...valid,count:1},q)).toThrow();expect(api.parseLevelPage({...valid,count:100},q).count).toBe(100);expect(()=>api.parseLevelPage({...valid,list:[valid.list[0],...valid.list.slice(0,9)]},q)).toThrow();
    const base=f.get('list')[0],input={id:base.id,name:base.name,grade:base.grade,discount:'100.00',exp_num:base.expNum,icon:base.icon,image:base.image,color:base.color,is_show:1,explain:base.explain};
    for(const values of [{grade:0},{exp_num:0},{discount:'100.01'},{discount:'1e2'},{icon:ticket(4)},{image:'javascript:alert(1)'},{color:'url(https://bad.invalid)'}])expect(()=>api.normalizeLevelForm({...input,...values},base)).toThrow();
    expect(api.normalizeLevelForm({...input,grade:0,exp_num:0,icon:'',image:''},{...base,grade:0,expNum:0,icon:'',image:''})).toMatchObject({grade:0,exp_num:0,icon:'',image:''});
    expect(api.normalizeLevelForm({...input,explain:''},{...base,explain:null})).not.toHaveProperty('explain');expect(()=>api.normalizeLevelQuery({page:10000,limit:100})).toThrow();
  }finally{f.close();}
});
it('canonical identity never adopts another image ticket or stores signatures, while one failed slot is isolated',async()=>{
  const f=await mount();try{const api=runtime.api,a=ticket(4),b=ticket(5);expect(api.levelImagePreview('/api/assets/4',a)).toBe(a);for(const value of [b,a+'&extra=1',a.replace('expires=','expires=0'),`https://other.invalid${a}`,`https://level-image.invalid${a}`,`//level-image.invalid${a}`])expect(api.levelImagePreview('/api/assets/4',value)).toBe('');f.view.imageFailed(a);expect(f.view.image('/api/assets/4',a)).toBe('');expect(f.view.image('/api/assets/5',b)).toBe(b);expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
it('real write deadline becomes unknown and a late response never closes the preserved editor',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});vi.setSystemTime(new Date('2026-10-26T20:00:00Z'));const f=await mount(),gate=deferred();try{f.view.openForm(f.get('list')[0]);f.hooks.write=()=>gate.promise;const pending=f.view.save();await flush();await vi.advanceTimersByTimeAsync(12001);await pending;expect(f.get('needsReview')).toBe(true);expect(f.get('busy')).toBe('');expect(f.get('formVisible')).toBe(true);gate.resolve({id:7101});await flush();expect(f.get('formVisible')).toBe(true);expect(f.writes()).toHaveLength(1);}finally{gate.resolve({id:7101});f.close();}
});
it('failed signed-media renewal retains draft, expires its preview, and does not poll or replay a write',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});vi.setSystemTime(new Date('2026-10-26T20:00:00Z'));const f=await mount();try{f.view.openForm(f.get('list')[0]);f.view.updateField('name','尚未保存');const source=f.get('previews').icon;f.hooks.read=async()=>{throw Error('renewal-failed');};const n=f.reads().length;await vi.advanceTimersByTimeAsync(870001);await flush();expect(f.reads()).toHaveLength(n+1);expect(f.get('error')).toBe('renewal-failed');expect(f.get('form').name).toBe('尚未保存');await vi.advanceTimersByTimeAsync(31000);await flush();expect(f.view.image('/api/assets/4',source)).toBe('');expect(f.reads()).toHaveLength(n+1);expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
it('unmount aborts native requests and clears private forms before late callbacks',async()=>{
  const f=await mount(),gate=deferred();f.view.openForm(f.get('list')[0]);f.hooks.write=()=>gate.promise;const pending=f.view.save();await flush();const call=f.writes()[0];f.close();expect(call.signal.aborted).toBe(true);gate.resolve({id:7101});await pending;expect(f.get('list')).toEqual([]);expect(f.get('formVisible')).toBe(false);expect(runtime.messages.state.notices).toEqual([]);
});

it('real Element pagination watchers never cancel a pending requested page when total is cleared',async()=>{
  const f=await mount(),gate=deferred();try{const before=f.reads().length;f.hooks.read=c=>c.params?.page===2?gate.promise:Promise.resolve(f.base(c));
    const pending=f.view.load(2);await flush();expect(f.reads().slice(before).map(c=>c.params.page)).toEqual([2]);expect(f.get('loading')).toBe(true);expect(f.get('page')).toBe(2);
    gate.resolve(f.base({url:'/level/list',params:{paged:1,page:2,limit:10}}));await pending;await flush();expect(f.get('page')).toBe(2);expect(f.get('count')).toBe(25);expect(f.get('list')[0].id).toBe(7111);
    delete f.hooks.read;await f.view.load(3);await flush();expect(f.get('page')).toBe(3);expect(f.get('list')).toHaveLength(5);expect(f.writes()).toHaveLength(0);
  }finally{gate.resolve({list:[],count:0,page:2,limit:10});f.close();}
});
