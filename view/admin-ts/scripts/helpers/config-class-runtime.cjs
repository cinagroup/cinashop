const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'../..');
const cryptos=new Set(),nativeCrypto=globalThis.crypto;
const observedCrypto={randomUUID:()=>nativeCrypto.randomUUID(),subtle:{digest:(...args)=>{const promise=nativeCrypto.subtle.digest(...args);cryptos.add(promise);promise.then(()=>cryptos.delete(promise),()=>cryptos.delete(promise));return promise;}}};
function loadModel(){const cache=new Map();function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file);const out={};cache.set(file,out);const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;new Function('require','exports','crypto',source)(name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)):require(name),out,observedCrypto);return out;}return {...load(path.join(root,'../common/configClasses.ts')),...load(path.join(root,'src/utils/configClassState.ts'))};}
const clone=v=>structuredClone(v),revision='a'.repeat(64);
const row=(id=1,extra={})=>({id,is_store:0,pid:0,title:`分类${id}`,eng_title:`config_${id}`,status:1,info:0,icon:'',type:0,sort:0,...extra});
const catalog=(list=[row()],rev=revision)=>({list:clone(list),count:list.length,revision:rev});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
// Observe the real native digest promises; event-loop turns alone are not a crypto completion barrier.
const tick=async()=>{for(let i=0;i<20;i++){await Promise.allSettled([...cryptos]);await new Promise(setImmediate);if(!cryptos.size)return;}throw Error('native crypto tasks did not settle');};
const receipt=a=>({operation:a.operation,request_id:a.input.request_id,actor_id:a.actor_id,id:a.id||9,payload_hash:a.payload_hash,revision:'b'.repeat(64),verified:true});
const failure=(status,message='本地验证拒绝')=>Object.assign(new Error(message),{status});
function harness(options={}){const u=loadModel(),actor={id:7,identity:'A',view:true,manage:true},journal=new Map(options.journal??[]),calls=[],persisted=[];
const deps={identity:()=>actor.identity,actor:()=>actor.id,view:()=>actor.view,manage:()=>actor.manage,
read:async signal=>{calls.push({method:'read',signal});return (options.read??(()=>catalog()))(signal);},
write:async(a,signal)=>{calls.push({method:'write',action:clone(a),signal});return (options.write??receipt)(a,signal);},
receipt:async(a,signal)=>{calls.push({method:'receipt',action:clone(a),signal});return (options.receipt??receipt)(a,signal);},
readPending:id=>clone(journal.get(id)),persist:(id,a)=>{if(options.persist)options.persist(id,a);persisted.push([id,clone(a)]);if(a)journal.set(id,clone(a));else journal.delete(id);}};
const model=u.configClassState(deps);return {u,actor,journal,calls,persisted,model,state:model.state,writes:()=>calls.filter(c=>c.method==='write'),async edit(id=1){model.rowControls(model.state.snapshot.list.find(r=>r.id===id)).edit();await tick();},async submit(){model.editorControls()[0].submit();await tick();},async field(name,value){model.editorControls()[0].fields.find(f=>f.field===name).set(value);await tick();},async create(){model.pageControls()[0].create();await tick();}};}
module.exports={loadModel,clone,revision,row,catalog,deferred,tick,receipt,failure,harness};
