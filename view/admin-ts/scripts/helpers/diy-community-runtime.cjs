const base = require('./diy-navigation-runtime.cjs');
const { getEventListeners, setMaxListeners } = require('node:events');
const { test, assert, fs, path, root, ts, vue, sfc, dom, renderer, node, all, text, elementNames, elementStub, tick, deferred } = base;
const { renderToString } = require('@vue/server-renderer');
const { ElInputNumber, ID_INJECTION_KEY, ZINDEX_INJECTION_KEY } = require('element-plus');
const editorFile = path.join(root, 'components/content/DiyCommunityEditor.vue');
const utilFile = path.join(root, 'utils/diyCommunityEditor.ts');
// Same installed Vue/SFC loader as the navigation suite. This parent's actual
// template contains valid TypeScript non-null assertions; transpile the actual
// compiler-dom output too, as Vite does, before evaluating its render function.
function loader(options = {}) {
  const cache = new Map(), instances = new Map(), notices = [], calls = [], galleryCalls = [], categoryCalls = [], uploadCalls = [];
  const actor = options.actor ?? vue.reactive({ token: 'A', userInfo: { id: 11, level: 0 }, uniqueAuth: [] });
  const storage = new Map([['admin_token', 'A'], ['admin_session', 'session-A']]);
  // A single imported document mounts >10 independent real link pickers.
  // Node's EventTarget warning limit is not a browser listener limit; every
  // parent harness below still asserts all session listeners leave on unmount.
  const window = new EventTarget(); window.location={hostname:'example.invalid',search:''}; setMaxListeners(100, window);
  const gateway = options.gateway ?? { get: async url => { calls.push({ method: 'GET', url }); return { data: [] }; }, post: async (url, body) => { calls.push({ method: 'POST', url, body: clone(body) }); return { data: { id: 2 } }; } };
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let source = fs.readFileSync(file, 'utf8'), descriptor, script;
    // Vite's compile-time DEV define only; all client functions remain actual source.
    source=source.replaceAll('import.meta.env.DEV','false');
    if (file.endsWith('.vue')) { descriptor = sfc.parse(source, { filename: file }).descriptor; script = sfc.compileScript(descriptor, { id: 'navigation-editor-runtime' }); source = script.content; }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', 'window', 'localStorage', output)(name => {
      if (name === 'vue') return vue;
      if (name === 'element-plus') return { ElMessage: { error: value => notices.push(['error', value]), success: value => notices.push(['success', value]), warning: value => notices.push(['warning', value]) }, ElMessageBox: { confirm: async () => {} } };
      if (name === '@/stores/auth') return { useAuthStore: () => actor };
      if (name === '@/utils/auth') return { getToken: () => storage.get('admin_token') ?? null, getAdminSession: () => ({ userInfo: actor.userInfo, uniqueAuth: actor.uniqueAuth }) };
      if (name === '@/utils/request') return { __esModule: true, default: gateway, getData: async promise => (await promise).data };
      if (name === '@/api/attachment') return {
        apiAttachmentCategories: async (signal, params) => { categoryCalls.push({ signal, params }); return (options.categories ?? (async () => ({ list: [] })))(signal, params); },
        apiAttachmentList: async (params, signal) => { galleryCalls.push({ params: clone(params), signal }); return (options.gallery ?? (async () => ({ list: [], count: 0 })))(params, signal); },
        apiAttachmentUpload: async (file, pid, signal) => { uploadCalls.push({ file, pid, signal }); return (options.upload ?? (async () => ({ att_id: 18, url: '/api/assets/18', src: ticket(18) })))(file, pid, signal); },
      };
      // These adjacent editors are not this suite's producer. Keep the footer's
      // real named canonicalizer because actual DiseList.save composes it.
      if (name === '@/components/content/DiyCommunityEditor.vue') return { __esModule: true, ...load(editorFile) };
      if (name === '@/components/content/DiyPresentationEditor.vue') return { __esModule: true, default: vue.defineComponent({ setup: () => () => null }) };
      if (name === '@/components/content/DiyFooterEditor.vue') return { __esModule: true, ...load(path.join(root, name.slice(2))), default: vue.defineComponent({ setup: () => () => null }) };
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return require(name);
    }, exports, window, { getItem: key => storage.get(key) ?? null });
    if (descriptor) {
      const component = exports.default, setup = component.setup;
      component.setup = (props, context) => { const state = setup(props, context); const values = instances.get(file) ?? []; values.push(vue.proxyRefs(state)); instances.set(file, values); return state; };
      component.render = new Function('Vue', ts.transpileModule(dom.compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: script.bindings }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(vue);
    }
    return exports;
  }
  return { load, instances, actor, storage, window, notices, calls, galleryCalls, categoryCalls, uploadCalls, componentOverrides: options.componentOverrides };
}

const clone=value=>JSON.parse(JSON.stringify(value));
const phpDefaults=JSON.parse(fs.readFileSync(path.resolve(root,'../../../workers-ts/test/fixtures/diy-community-author-defaults.json'),'utf8'));
const block=(kind,timestamp=10)=>({...clone(phpDefaults[kind]),timestamp});
const ticketExpires=Math.floor(Date.now()/1000)+900;
const ticket=(id,expires=ticketExpires)=>`/api/assets/${id}?expires=${expires}&signature=${'A'.repeat(43)}`;
const response=data=>({ok:true,json:async()=>({status:200,msg:'',data})});
function harness(value=[block('community')],options={}){
 const l=loader(options),props=vue.reactive({modelValue:JSON.stringify(value),editorKey:'community:2',disabled:false,pageId:2,pagePublished:true,...options.props}),writes=[],tree=node('root'),component=l.load(editorFile).default;
 const app=renderer.createApp({setup:()=>()=>vue.h(component,{...props,'onUpdate:modelValue':value=>{writes.push(value);if(!options.deferEcho)props.modelValue=value;}})});
 for(const name of [...new Set([...elementNames,'el-radio-button','el-checkbox'])])app.component(name,elementStub(name));app.directive('loading',{});app.mount(tree);let alive=true;
 return{...l,tree,props,writes,value:()=>JSON.parse(props.modelValue),get state(){return l.instances.get(editorFile).at(-1);},unmount(){if(alive){alive=false;app.unmount();for(const event of ['admin-session-changed','admin-auth-expired','storage'])assert.equal(getEventListeners(l.window,event).length,0,event+' cleanup');}}};
}
function control(r,label){const field=all(r.tree,n=>n.props['data-element']==='el-form-item'&&n.props['data-label']===label)[0];assert.ok(field,label);const input=all(field,n=>['el-input','el-input-number','el-select','el-color-picker'].includes(n.props['data-element']))[0];assert.ok(input,label);return input;}

module.exports={...base,loader,harness,block,clone,ticket,response,control,editorFile,utilFile,renderToString,ElInputNumber,ID_INJECTION_KEY,ZINDEX_INJECTION_KEY};
