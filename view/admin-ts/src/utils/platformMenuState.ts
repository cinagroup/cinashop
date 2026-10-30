import {platformMenuCatalog,platformMenuValues,platformMenuPending,platformMenuReceipt,platformMenuPayloadHash,platformMenuParents,newPlatformMenu,type PlatformMenuAction,type PlatformMenuCatalog,type PlatformMenuRow,type PlatformMenuValues,type PlatformMenuOperation,PLATFORM_MENU_FIELDS,type PlatformMenuApi} from '../../../common/platformMenuRules';
export interface PlatformMenuDependencies {
 identity():string;actor():number;view():boolean;manage():boolean;
 read(signal:AbortSignal):Promise<unknown>;write(action:PlatformMenuAction,signal:AbortSignal):Promise<unknown>;receipt(action:PlatformMenuAction,signal:AbortSignal):Promise<unknown>;
 readPending(actor:number):unknown;persist(actor:number,action:PlatformMenuAction|null,expected?:PlatformMenuAction):void;
}
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
const message=(e:unknown)=>e instanceof Error?e.message:'权限规则请求失败';
const status=(e:unknown)=>{const r=e as {status?:unknown;response?:{data?:{status?:unknown};status?:unknown}};return Number(r?.status??r?.response?.data?.status??r?.response?.status);};
function notApplied(e:unknown,a:PlatformMenuAction){const p=(e as {platformMenuNotApplied?:Record<string,unknown>})?.platformMenuNotApplied;return !!p&&p.code==='PLATFORM_MENU_NOT_APPLIED'&&p.operation===a.operation&&p.id===a.id&&p.request_id===a.input.request_id&&p.payload_hash===a.payload_hash;}
export function platformMenuState(deps:PlatformMenuDependencies,wrap:<T extends object>(v:T)=>T=v=>v){
 const state=wrap({epoch:0,sourceVersion:0,snapshot:null as PlatformMenuCatalog|null,ready:false,loading:false,busy:false,error:'',notice:'',revoked:false,pending:null as PlatformMenuAction|null,pendingError:'',retryReady:false,needsReread:false,
  editor:null as {serial:number;revision:number;branch:number;original:PlatformMenuRow|null;draft:PlatformMenuValues;apiSearch:string;iconSearch:string}|null,confirmation:null as {serial:number;row:PlatformMenuRow}|null});
 let active=false,serial=0,readSerial=0;const requests=new Set<AbortController>();
 const stamp=()=>({identity:deps.identity(),epoch:state.epoch,actor:deps.actor()});
 const ownerCurrent=(s:ReturnType<typeof stamp>)=>active&&s.identity===deps.identity()&&s.epoch===state.epoch&&s.actor===deps.actor()&&s.actor>0;
 const current=(s:ReturnType<typeof stamp>)=>ownerCurrent(s)&&deps.view()&&!state.revoked;
 const controller=()=>{const c=new AbortController();requests.add(c);return c;};
 function retire(){state.epoch++;readSerial++;for(const c of requests)c.abort();requests.clear();state.snapshot=null;state.ready=state.loading=state.busy=false;state.editor=null;state.confirmation=null;state.pending=null;state.pendingError='';state.error='';state.notice='';state.revoked=false;state.retryReady=false;state.needsReread=false;}
 function reject(e:unknown){state.error=message(e);if([400011,410000,410001,410002,401,403].includes(status(e))){state.revoked=true;state.ready=false;state.busy=state.loading=false;state.snapshot=null;state.editor=null;state.confirmation=null;state.epoch++;for(const c of requests)c.abort();requests.clear();}}
 const writable=()=>active&&deps.view()&&deps.manage()&&!state.revoked&&state.ready&&!state.loading&&!state.busy&&!state.pending&&!state.pendingError&&!state.needsReread&&!!state.snapshot&&state.snapshot.write_ready;
 async function restore(s:ReturnType<typeof stamp>){
  try{const raw=deps.readPending(s.actor);if(raw===null||raw===undefined||raw==='')return;const a=platformMenuPending(raw,s.actor);if(await platformMenuPayloadHash(a)!==a.payload_hash)throw Error('未确认操作摘要不一致，请保留并核对原操作');if(ownerCurrent(s)){state.pending=a;state.retryReady=false;state.notice='检测到未确认的权限规则操作，请先读取原请求回执';}}
  catch(e){if(ownerCurrent(s))state.pendingError=message(e);}
 }
 async function load(){const s=stamp();if(!current(s)||state.busy)return;const request=++readSerial,c=controller();state.loading=true;state.ready=false;state.error='';state.editor=null;state.confirmation=null;
  try{const result=platformMenuCatalog(await deps.read(c.signal));if(!current(s)||request!==readSerial)return;state.snapshot=result;state.sourceVersion++;state.ready=true;state.needsReread=false;}
  catch(e){if(current(s)&&request===readSerial)reject(e);}finally{requests.delete(c);if(current(s)&&request===readSerial)state.loading=false;}
 }
 async function activate(){active=true;retire();const s=stamp();if(!ownerCurrent(s))return;await restore(s);if(current(s))await load();}
 function dispose(){active=false;retire();}
 function retireView(){if(!active||state.busy||state.loading||state.pending||state.pendingError||!state.ready)return false;state.sourceVersion++;state.editor=null;state.confirmation=null;return true;}
 function open(id:number){if(!writable())return;if(!id&&state.snapshot!.count>=5000){state.error='权限规则目录已达到5000项上限，请编辑现有规则或删除无引用规则后再添加';return;}const original=id?state.snapshot!.list.find(r=>r.id===id):null;if(id&&!original)return;state.confirmation=null;state.editor={serial:++serial,revision:0,branch:0,original:original?clone(original):null,draft:original?clone(original):newPlatformMenu(),apiSearch:'',iconSearch:''};state.error='';state.notice='';}
 function validParent(values:PlatformMenuValues,id:number){if(!platformMenuParents(state.snapshot!.list,id).some(r=>r.id===values.pid))throw Error('请选择有效的菜单父级');}
 async function prepare(operation:PlatformMenuOperation,id:number,values:Partial<PlatformMenuValues>,guard:()=>boolean){
  if(!writable()||!guard())return;state.notice='';const s=stamp(),revision=state.snapshot!.revision,source=state.sourceVersion;
  try{
   const request_id=crypto.randomUUID(),input={...values,request_id,expected_revision:revision};
   const a:PlatformMenuAction={operation,id,actor_id:s.actor,input,payload_hash:''};a.payload_hash=await platformMenuPayloadHash(a);
   if(!current(s)||!writable()||!guard()||source!==state.sourceVersion||revision!==state.snapshot?.revision)return;
   // Persistence precedes dispatch; a failed storage write cannot create an
   // untraceable server mutation. The stored record contains no token/config values.
   deps.persist(s.actor,clone(a));state.pending=clone(a);state.retryReady=false;await run(a,false);
  }catch(e){if(current(s)){await restore(s);if(current(s))reject(e);}}
 }
 async function run(action:PlatformMenuAction,retry:boolean){
  const s=stamp();if(!current(s)||!deps.manage()||state.busy||!state.pending||JSON.stringify(state.pending)!==JSON.stringify(action)||retry&&!state.retryReady)return false;
  const a=clone(action),c=controller();state.busy=true;state.error='';state.notice='';state.retryReady=false;
  try{const raw=await deps.write(a,c.signal);if(!current(s))return false;if(!deps.manage())throw Error('权限规则管理权限已变化，请重新读取会话');platformMenuReceipt(raw,a);
   deps.persist(s.actor,null,a);state.pending=null;state.editor=null;state.confirmation=null;state.notice='权限规则操作已完成';state.busy=false;await restore(s);if(current(s))await load();return current(s);
  }catch(e){if(current(s)){if(notApplied(e,a)){try{deps.persist(s.actor,null,a);state.pending=null;state.needsReread=true;state.notice='服务端已确认本次操作未应用，草稿已保留。请重新读取完整目录并核对后再编辑';await restore(s);}catch{if(current(s))state.pendingError='本机未确认操作记录暂时无法更新';}}if(current(s))reject(e);}return false;}
  finally{requests.delete(c);if(current(s))state.busy=false;}
 }
 async function readReceipt(){const s=stamp();if(!ownerCurrent(s)||state.busy||!state.pending)return;const a=clone(state.pending),c=controller();state.busy=true;state.error='';state.retryReady=false;
  try{const raw=await deps.receipt(a,c.signal);if(!ownerCurrent(s))return;platformMenuReceipt(raw,a);deps.persist(s.actor,null,a);state.pending=null;state.editor=null;state.confirmation=null;state.notice='原权限规则操作已确认完成';state.busy=false;await restore(s);if(current(s))await load();}
  catch(e){if(ownerCurrent(s)){if(status(e)===404){state.retryReady=deps.manage();state.error='尚未找到原请求回执；可由你主动原样重试，系统不会另建请求';}else reject(e);}}
  finally{requests.delete(c);if(ownerCurrent(s))state.busy=false;}
 }
 function pageControls(){const s=stamp(),source=state.sourceVersion,pending=state.pending?JSON.stringify(state.pending):null;const admitted=()=>current(s)&&source===state.sourceVersion;
  return [{key:state.epoch,refresh:()=>{if(admitted()&&!state.busy)void load();},create:()=>{if(admitted()&&!state.editor&&!state.confirmation)open(0);},receipt:()=>{if(ownerCurrent(s)&&source===state.sourceVersion&&pending===JSON.stringify(state.pending))void readReceipt();},retry:()=>{if(admitted()&&pending===JSON.stringify(state.pending)&&state.pending)void run(clone(state.pending),true);}}];
 }
 function rowControls(row:PlatformMenuRow){const s=stamp(),source=state.sourceVersion,raw=JSON.stringify(row);const admitted=()=>current(s)&&!state.editor&&!state.confirmation&&source===state.sourceVersion&&!!state.snapshot?.list.includes(row)&&JSON.stringify(row)===raw;
  return {key:`${state.epoch}:${source}:${row.id}`,row,edit:()=>{if(admitted())open(row.id);},child:()=>{if(admitted()&&row.auth_type===1){open(0);if(state.editor)state.editor.draft.pid=row.id;}},show:()=>{if(admitted()&&row.auth_type===1)void prepare('show',row.id,{is_show:1},admitted);},hide:()=>{if(admitted()&&row.auth_type===1)void prepare('show',row.id,{is_show:0},admitted);},remove:()=>{if(admitted()&&writable()){state.editor=null;state.confirmation={serial:++serial,row:clone(row)};}}};
 }
 function editorControls(){const editor=state.editor;if(!editor)return [];const s=stamp(),source=state.sourceVersion,revision=editor.revision,branch=editor.branch,raw=JSON.stringify(editor.draft);const admitted=()=>current(s)&&source===state.sourceVersion&&state.editor===editor&&editor.branch===branch;
  const fields=PLATFORM_MENU_FIELDS.map(field=>({key:`${state.epoch}:${editor.serial}:${field}`,field,value:editor.draft[field],set:(value:unknown)=>{if(admitted()&&writable()&&!state.busy&&!Object.is(editor.draft[field],value)){(editor.draft as unknown as Record<string,unknown>)[field]=value;editor.revision++;if(field==='auth_type')editor.branch++;}}}));
  const parents=platformMenuParents(state.snapshot?.list??[],editor.original?.id??0);if(!parents.some(r=>r.id===editor.draft.pid))parents.push({id:editor.draft.pid,label:`当前父级 #${editor.draft.pid}（需重新选择）`,disabled:true});
  return [{key:`${state.epoch}:${editor.serial}`,fields,parents,apiSearch:editor.apiSearch,iconSearch:editor.iconSearch,searchApi:(v:unknown)=>{if(admitted()&&writable()&&typeof v==='string')editor.apiSearch=v;},searchIcon:(v:unknown)=>{if(admitted()&&writable()&&typeof v==='string')editor.iconSearch=v;},chooseApi:(api:PlatformMenuApi)=>{if(admitted()&&writable()&&editor.revision===revision&&editor.draft.auth_type===2&&state.snapshot?.apis.includes(api)){editor.draft.menu_name=Array.from(api.real_name).slice(0,64).join('');editor.draft.methods=api.method;editor.draft.api_url=api.rule;editor.revision++;}},close:()=>{if(admitted()&&!state.busy&&!state.pending)state.editor=null;},submit:()=>{if(!admitted()||editor.revision!==revision||JSON.stringify(editor.draft)!==raw)return;try{const values=platformMenuValues(editor.draft,editor.original);validParent(values,editor.original?.id??0);void prepare(editor.original?'update':'create',editor.original?.id??0,values,()=>admitted()&&editor.revision===revision&&JSON.stringify(editor.draft)===raw);}catch(e){state.error=message(e);}}}];
 }
 function confirmationControls(){const confirmation=state.confirmation;if(!confirmation)return [];const s=stamp(),source=state.sourceVersion;const admitted=()=>current(s)&&source===state.sourceVersion&&state.confirmation===confirmation;
  return [{key:`${state.epoch}:${confirmation.serial}`,row:confirmation.row,cancel:()=>{if(admitted()&&!state.busy&&!state.pending)state.confirmation=null;},confirm:()=>{if(admitted())void prepare('delete',confirmation.row.id,{},admitted);}}];
 }
 return {state,writable,activate,dispose,retireView,load,pageControls,rowControls,editorControls,confirmationControls};
}
