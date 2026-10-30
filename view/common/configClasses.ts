/** Configuration category metadata only; no system_config values or credentials. */
export interface ConfigClassValues { is_store:number; pid:number; title:string; eng_title:string; status:number; info:number; icon:string; type:number; sort:number }
export interface ConfigClassRow extends ConfigClassValues { id:number }
export interface ConfigClassCatalog {list:ConfigClassRow[];count:number;revision:string}
export type ConfigClassOperation='create'|'update'|'status'|'delete';
export interface ConfigClassAction {operation:ConfigClassOperation;id:number;actor_id:number;input:Partial<ConfigClassValues>&{request_id:string;expected_revision:string};payload_hash:string}
export interface ConfigClassReceipt {operation:ConfigClassOperation;request_id:string|null;actor_id:number;id:number;payload_hash:string;revision:string;verified:true}
export const CONFIG_CLASS_FIELDS=['is_store','pid','title','eng_title','status','info','icon','type','sort'] as const;
const hex=/^[a-f0-9]{64}$/u,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('配置分类响应格式错误');return v as Record<string,unknown>;};
function integer(v:unknown,min=0,max=2147483647):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw Error('配置分类数值无效');return v;}
function text(v:unknown,max:number):string{if(typeof v!=='string'||Array.from(v).length>max||v.includes('\0'))throw Error('配置分类文字无效');return v;}
export function configClassRow(v:unknown):ConfigClassRow{const r=record(v);return {id:integer(r.id,1),is_store:integer(r.is_store,0,1),pid:integer(r.pid),title:text(r.title,255),eng_title:text(r.eng_title,255),status:integer(r.status,0,255),info:integer(r.info,0,255),icon:text(r.icon,30),type:integer(r.type),sort:integer(r.sort)};}
export function configClassCatalog(v:unknown):ConfigClassCatalog{const r=record(v);if(!Array.isArray(r.list)||r.list.length>5000||r.count!==r.list.length||typeof r.revision!=='string'||!hex.test(r.revision))throw Error('配置分类目录不完整');const seen=new Set<number>();const list=Array.from(r.list,item=>{const row=configClassRow(item);if(seen.has(row.id))throw Error('配置分类ID重复');seen.add(row.id);return row;});return {list,count:list.length,revision:r.revision};}
export const newConfigClass=():ConfigClassValues=>({is_store:0,pid:0,title:'',eng_title:'',status:1,info:0,icon:'',type:0,sort:0});
export function configClassValues(v:unknown,original:ConfigClassRow|null):ConfigClassValues{
 const r=record(v),row=configClassRow({...r,id:original?.id??1});
 for(const field of ['title','eng_title','icon'] as const)if(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(row[field]))throw Error('分类文字包含不支持的控制字符');
 row.title=row.title.trim();row.eng_title=row.eng_title.trim();row.icon=row.icon.trim();if(!row.title||!row.eng_title)throw Error('请填写分类名称和分类字段');
 if(row.info!==(original?.info??0))throw Error('历史显示设置已变化，请重新读取');
 if(![1,2].includes(row.status)&&row.status!==original?.status)throw Error('请选择显示或隐藏状态');
 if(![0,3].includes(row.type)&&row.type!==original?.type)throw Error('请选择系统或其它类型');
 return Object.fromEntries(CONFIG_CLASS_FIELDS.map(k=>[k,row[k]])) as unknown as ConfigClassValues;
}
export function configClassCanonical(a:Pick<ConfigClassAction,'operation'|'id'|'input'>):string{
 const r=a.input;const values=a.operation==='create'||a.operation==='update'?{is_store:r.is_store,pid:r.pid,title:r.title,eng_title:r.eng_title,status:r.status,info:r.info,icon:r.icon,type:r.type,sort:r.sort}:null;
 return JSON.stringify({operation:a.operation,id:a.id,expected_revision:r.expected_revision??null,values,status:a.operation==='status'?r.status:null});
}
export async function configClassPayloadHash(a:Pick<ConfigClassAction,'operation'|'id'|'input'>):Promise<string>{const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(configClassCanonical(a)));return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
export function configClassReceipt(v:unknown,a:ConfigClassAction):ConfigClassReceipt{
 const r=record(v);if(r.operation!==a.operation||r.request_id!==a.input.request_id||r.actor_id!==a.actor_id||r.verified!==true||r.payload_hash!==a.payload_hash||typeof r.revision!=='string'||!hex.test(r.revision))throw Error('回执与原配置分类操作不一致');
 const id=integer(r.id,1);if(a.id>0&&id!==a.id)throw Error('回执分类ID与原操作不一致');return {operation:a.operation,request_id:a.input.request_id,actor_id:a.actor_id,id,payload_hash:a.payload_hash,revision:r.revision,verified:true};
}
export function configClassPending(v:unknown,actor:number):ConfigClassAction{
 const r=record(v),input=record(r.input),operation=r.operation;if(!['create','update','status','delete'].includes(String(operation))||r.actor_id!==actor||typeof input.request_id!=='string'||!uuid.test(input.request_id)||typeof input.expected_revision!=='string'||!hex.test(input.expected_revision)||typeof r.payload_hash!=='string'||!hex.test(r.payload_hash))throw Error('未确认操作记录格式错误，请保留并核对原操作');
 const id=integer(r.id,operation==='create'?0:1);if(operation==='create'&&id!==0)throw Error('新增分类记录ID无效');
 if(operation==='create'||operation==='update')configClassRow({...input,id:id||1});else if(operation==='status')integer(input.status,0,1);
 const fields=operation==='create'||operation==='update'?[...CONFIG_CLASS_FIELDS,'request_id','expected_revision']:operation==='status'?['request_id','expected_revision','status']:['request_id','expected_revision'];if(Object.keys(input).some(k=>!fields.includes(k)))throw Error('未确认操作包含未知字段');
 return JSON.parse(JSON.stringify({operation,id,actor_id:actor,input,payload_hash:r.payload_hash})) as ConfigClassAction;
}
export interface ConfigClassNode {row:ConfigClassRow;depth:number;path:string;issue:string;children:number[]}
/** Preserve every flat row, including broken historical graph components. */
export function configClassGraph(rows:ConfigClassRow[]):Map<number,ConfigClassNode>{
 const by=new Map(rows.map(row=>[row.id,row])),children=new Map<number,number[]>();
 for(const row of rows){const ids=children.get(row.pid)??[];ids.push(row.id);children.set(row.pid,ids);}
 // Resolve each ancestor once. Keep four nearby names, rather than copying a
 // full ancestor path for every node in a deep historical directory.
 const resolved=new Map<number,{depth:number;ancestors:string[];issue:string}>();
 const label=(row:ConfigClassRow)=>Array.from(row.title||`#${row.id}`).slice(0,48).join('');
 for(const row of rows){
  if(resolved.has(row.id))continue;
  const trail:ConfigClassRow[]=[],seen=new Set<number>();let cursor=row,broken=0,issue='';
  while(!resolved.has(cursor.id)){
   seen.add(cursor.id);trail.push(cursor);
   if(!cursor.pid)break;
   const parent=by.get(cursor.pid);
   if(!parent){broken=cursor.id;issue='父级记录缺失';break;}
   if(parent.is_store!==cursor.is_store){broken=cursor.id;issue='父级后台范围不一致';break;}
   if(seen.has(parent.id)){broken=cursor.id;issue='历史分类层级存在循环';break;}
   cursor=parent;
  }
  for(const item of trail.reverse()){
   const parent=item.id===broken?undefined:resolved.get(item.pid);
   resolved.set(item.id,{depth:parent?parent.depth+1:0,ancestors:parent?[label(by.get(item.pid)!),...parent.ancestors].slice(0,4):[],issue:item.id===broken?issue:parent?.issue??''});
  }
 }
 return new Map(rows.map(row=>{const item=resolved.get(row.id)!,path=[...(item.depth>4?['…']:[]),...item.ancestors.slice().reverse(),row.title||`#${row.id}`].join(' / ');return [row.id,{row,depth:item.issue?0:Math.min(item.depth,6),path,issue:item.issue,children:children.get(row.id)??[]}];}));
}
export function configClassParents(rows:ConfigClassRow[],id:number,scope:number):Array<{id:number;label:string;disabled?:boolean}>{
 const graph=configClassGraph(rows),blocked=new Set<number>(id?[id]:[]),queue=id?[id]:[];for(let i=0;i<queue.length;i++)for(const child of graph.get(queue[i])?.children??[])if(!blocked.has(child)){blocked.add(child);queue.push(child);}
 return [{id:0,label:'顶级分类'},...rows.filter(r=>r.is_store===scope&&!blocked.has(r.id)&&!graph.get(r.id)!.issue).map(r=>({id:r.id,label:graph.get(r.id)!.path}))];
}
