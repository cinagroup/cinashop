import {configClassCatalog,configClassValues,configClassPending,configClassReceipt,configClassPayloadHash,configClassParents,newConfigClass,type ConfigClassAction,type ConfigClassCatalog,type ConfigClassRow,type ConfigClassValues,type ConfigClassOperation} from '../../../common/configClasses';
export interface ConfigClassDependencies {
 identity():string;actor():number;view():boolean;manage():boolean;
 read(signal:AbortSignal):Promise<unknown>;write(action:ConfigClassAction,signal:AbortSignal):Promise<unknown>;receipt(action:ConfigClassAction,signal:AbortSignal):Promise<unknown>;
 readPending(actor:number):unknown;persist(actor:number,action:ConfigClassAction|null,expected?:ConfigClassAction):void;
}
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
const message=(e:unknown)=>e instanceof Error?e.message:'配置分类请求失败';
const status=(e:unknown)=>{const r=e as {status?:unknown;response?:{data?:{status?:unknown};status?:unknown}};return Number(r?.status??r?.response?.data?.status??r?.response?.status);};
function notApplied(e:unknown,a:ConfigClassAction){const p=(e as {configClassNotApplied?:Record<string,unknown>})?.configClassNotApplied;return !!p&&p.code==='CONFIG_CLASS_NOT_APPLIED'&&p.operation===a.operation&&p.id===a.id&&p.request_id===a.input.request_id&&p.payload_hash===a.payload_hash;}
export function configClassState(deps:ConfigClassDependencies,wrap:<T extends object>(v:T)=>T=v=>v){
 const state=wrap({epoch:0,sourceVersion:0,snapshot:null as ConfigClassCatalog|null,ready:false,loading:false,busy:false,error:'',notice:'',revoked:false,pending:null as ConfigClassAction|null,pendingError:'',retryReady:false,needsReread:false,
  editor:null as {serial:number;revision:number;original:ConfigClassRow|null;draft:ConfigClassValues}|null,confirmation:null as {serial:number;row:ConfigClassRow}|null});
 let active=false,serial=0,readSerial=0;const requests=new Set<AbortController>();
 const stamp=()=>({identity:deps.identity(),epoch:state.epoch,actor:deps.actor()});
 const current=(s:ReturnType<typeof stamp>)=>active&&s.identity===deps.identity()&&s.epoch===state.epoch&&s.actor===deps.actor()&&deps.view()&&!state.revoked;
 const controller=()=>{const c=new AbortController();requests.add(c);return c;};
 function retire(){state.epoch++;readSerial++;for(const c of requests)c.abort();requests.clear();state.snapshot=null;state.ready=state.loading=state.busy=false;state.editor=null;state.confirmation=null;state.pending=null;state.pendingError='';state.error='';state.notice='';state.revoked=false;state.retryReady=false;state.needsReread=false;}
 function reject(e:unknown){state.error=message(e);if([400011,410000,410001,410002,401,403].includes(status(e))){state.revoked=true;state.ready=false;state.busy=state.loading=false;state.snapshot=null;state.editor=null;state.confirmation=null;state.epoch++;for(const c of requests)c.abort();requests.clear();}}
 const writable=()=>active&&deps.view()&&deps.manage()&&!state.revoked&&state.ready&&!state.loading&&!state.busy&&!state.pending&&!state.pendingError&&!state.needsReread&&!!state.snapshot;
 async function restore(s:ReturnType<typeof stamp>){
  try{const raw=deps.readPending(s.actor);if(raw===null||raw===undefined||raw==='')return;const a=configClassPending(raw,s.actor);if(await configClassPayloadHash(a)!==a.payload_hash)throw Error('未确认操作摘要不一致，请保留并核对原操作');if(current(s)){state.pending=a;state.retryReady=false;state.notice='检测到未确认的分类操作，请先读取原请求回执';}}
  catch(e){if(current(s))state.pendingError=message(e);}
 }
 async function load(){const s=stamp();if(!current(s)||state.busy)return;const request=++readSerial,c=controller();state.loading=true;state.ready=false;state.error='';state.editor=null;state.confirmation=null;
  try{const result=configClassCatalog(await deps.read(c.signal));if(!current(s)||request!==readSerial)return;state.snapshot=result;state.sourceVersion++;state.ready=true;state.needsReread=false;}
  catch(e){if(current(s)&&request===readSerial)reject(e);}finally{requests.delete(c);if(current(s)&&request===readSerial)state.loading=false;}
 }
 async function activate(){active=true;retire();const s=stamp();if(!current(s))return;await restore(s);if(current(s))await load();}
 function dispose(){active=false;retire();}
 function retireView(){if(!active||state.busy||state.loading||state.pending||state.pendingError||!state.ready)return false;state.sourceVersion++;state.editor=null;state.confirmation=null;return true;}
 function open(id:number){if(!writable())return;if(!id&&state.snapshot!.count>=5000){state.error='分类目录已达到5000项上限，请编辑现有分类或删除无引用分类后再添加';return;}const original=id?state.snapshot!.list.find(r=>r.id===id):null;if(id&&!original)return;state.confirmation=null;state.editor={serial:++serial,revision:0,original:original?clone(original):null,draft:original?clone(original):newConfigClass()};state.error='';state.notice='';}
 function validParent(values:ConfigClassValues,id:number){if(!configClassParents(state.snapshot!.list,id,values.is_store).some(r=>r.id===values.pid))throw Error('请选择同一后台范围内有效的父级分类');}
 async function prepare(operation:ConfigClassOperation,id:number,values:Partial<ConfigClassValues>,guard:()=>boolean){
  if(!writable()||!guard())return;state.notice='';const s=stamp(),revision=state.snapshot!.revision,source=state.sourceVersion;
  try{
   const request_id=crypto.randomUUID(),input={...values,request_id,expected_revision:revision};
   const a:ConfigClassAction={operation,id,actor_id:s.actor,input,payload_hash:''};a.payload_hash=await configClassPayloadHash(a);
   if(!current(s)||!writable()||!guard()||source!==state.sourceVersion||revision!==state.snapshot?.revision)return;
   // Persistence precedes dispatch; a failed storage write cannot create an
   // untraceable server mutation. The stored record contains no token/config values.
   deps.persist(s.actor,clone(a));state.pending=clone(a);state.retryReady=false;await run(a,false);
  }catch(e){if(current(s)){await restore(s);if(current(s))reject(e);}}
 }
 async function run(action:ConfigClassAction,retry:boolean){
  const s=stamp();if(!current(s)||!deps.manage()||state.busy||!state.pending||JSON.stringify(state.pending)!==JSON.stringify(action)||retry&&!state.retryReady)return false;
  const a=clone(action),c=controller();state.busy=true;state.error='';state.notice='';state.retryReady=false;
  try{const raw=await deps.write(a,c.signal);if(!current(s))return false;if(!deps.manage())throw Error('配置管理权限已变化，请重新读取会话');configClassReceipt(raw,a);
   deps.persist(s.actor,null,a);state.pending=null;state.editor=null;state.confirmation=null;state.notice='分类操作已完成';state.busy=false;await restore(s);if(current(s))await load();return current(s);
  }catch(e){if(current(s)){if(notApplied(e,a)){try{deps.persist(s.actor,null,a);state.pending=null;state.needsReread=true;state.notice='服务端已确认本次操作未应用，草稿已保留。请重新读取完整目录并核对后再编辑';await restore(s);}catch{if(current(s))state.pendingError='本机未确认操作记录暂时无法更新';}}if(current(s))reject(e);}return false;}
  finally{requests.delete(c);if(current(s))state.busy=false;}
 }
 async function readReceipt(){const s=stamp();if(!current(s)||state.busy||!state.pending)return;const a=clone(state.pending),c=controller();state.busy=true;state.error='';state.retryReady=false;
  try{const raw=await deps.receipt(a,c.signal);if(!current(s))return;configClassReceipt(raw,a);deps.persist(s.actor,null,a);state.pending=null;state.editor=null;state.confirmation=null;state.notice='原分类操作已确认完成';state.busy=false;await restore(s);if(current(s))await load();}
  catch(e){if(current(s)){if(status(e)===404){state.retryReady=deps.manage();state.error='尚未找到原请求回执；可由你主动原样重试，系统不会另建请求';}else reject(e);}}
  finally{requests.delete(c);if(current(s))state.busy=false;}
 }
 function pageControls(){const s=stamp(),source=state.sourceVersion,pending=state.pending?JSON.stringify(state.pending):null;const admitted=()=>current(s)&&source===state.sourceVersion;
  return [{key:state.epoch,refresh:()=>{if(admitted()&&!state.busy)void load();},create:()=>{if(admitted()&&!state.editor&&!state.confirmation)open(0);},receipt:()=>{if(admitted()&&pending===JSON.stringify(state.pending))void readReceipt();},retry:()=>{if(admitted()&&pending===JSON.stringify(state.pending)&&state.pending)void run(clone(state.pending),true);}}];
 }
 function rowControls(row:ConfigClassRow){const s=stamp(),source=state.sourceVersion,raw=JSON.stringify(row);const admitted=()=>current(s)&&!state.editor&&!state.confirmation&&source===state.sourceVersion&&!!state.snapshot?.list.includes(row)&&JSON.stringify(row)===raw;
  return {key:`${state.epoch}:${source}:${row.id}`,row,edit:()=>{if(admitted())open(row.id);},show:()=>{if(admitted())void prepare('status',row.id,{status:1},admitted);},hide:()=>{if(admitted())void prepare('status',row.id,{status:0},admitted);},remove:()=>{if(admitted()&&writable()){state.editor=null;state.confirmation={serial:++serial,row:clone(row)};}}};
 }
 function editorControls(){const editor=state.editor;if(!editor)return [];const s=stamp(),source=state.sourceVersion,revision=editor.revision,raw=JSON.stringify(editor.draft);const admitted=()=>current(s)&&source===state.sourceVersion&&state.editor===editor;
  const fields=(['is_store','pid','title','eng_title','status','icon','type','sort'] as const).map(field=>({key:`${state.epoch}:${editor.serial}:${field}`,field,value:editor.draft[field],set:(value:unknown)=>{if(admitted()&&writable()&&!state.busy&&!Object.is(editor.draft[field],value)){(editor.draft as unknown as Record<string,unknown>)[field]=value;editor.revision++;}}}));
  const parents=configClassParents(state.snapshot?.list??[],editor.original?.id??0,editor.draft.is_store);if(!parents.some(r=>r.id===editor.draft.pid))parents.push({id:editor.draft.pid,label:`当前父级 #${editor.draft.pid}（需重新选择）`,disabled:true});
  return [{key:`${state.epoch}:${editor.serial}`,fields,parents,close:()=>{if(admitted()&&!state.busy&&!state.pending)state.editor=null;},submit:()=>{if(!admitted()||editor.revision!==revision||JSON.stringify(editor.draft)!==raw)return;try{const values=configClassValues(editor.draft,editor.original);validParent(values,editor.original?.id??0);void prepare(editor.original?'update':'create',editor.original?.id??0,values,()=>admitted()&&editor.revision===revision&&JSON.stringify(editor.draft)===raw);}catch(e){state.error=message(e);}}}];
 }
 function confirmationControls(){const confirmation=state.confirmation;if(!confirmation)return [];const s=stamp(),source=state.sourceVersion;const admitted=()=>current(s)&&source===state.sourceVersion&&state.confirmation===confirmation;
  return [{key:`${state.epoch}:${confirmation.serial}`,row:confirmation.row,cancel:()=>{if(admitted()&&!state.busy&&!state.pending)state.confirmation=null;},confirm:()=>{if(admitted())void prepare('delete',confirmation.row.id,{},admitted);}}];
 }
 return {state,writable,activate,dispose,retireView,load,pageControls,rowControls,editorControls,confirmationControls};
}
