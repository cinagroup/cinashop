/** Platform type=1 metadata. Icons and paths are text, never remote resources. */
export const PLATFORM_MENU_FIELDS=['pid','auth_type','menu_name','menu_path','unique_auth','api_url','methods','icon','sort','is_show','is_show_path'] as const;
export interface PlatformMenuValues {pid:number;auth_type:number;menu_name:string;menu_path:string;unique_auth:string;api_url:string;methods:string;icon:string;sort:number;is_show:number;is_show_path:number}
export interface PlatformMenuRow extends PlatformMenuValues {id:number;access:number;revision:string;role_reference_ids:number[]}
export interface PlatformMenuApi {method:string;rule:string;real_name:string;permission:string}
export interface PlatformMenuCatalog {list:PlatformMenuRow[];count:number;revision:string;write_ready:boolean;apis:PlatformMenuApi[];pages:Array<{path:string;name:string}>}
export type PlatformMenuOperation='create'|'update'|'show'|'delete';
export interface PlatformMenuAction {operation:PlatformMenuOperation;id:number;actor_id:number;input:Partial<PlatformMenuValues>&{request_id:string;expected_revision:string};payload_hash:string}
export interface PlatformMenuReceipt {operation:PlatformMenuOperation;request_id:string;actor_id:number;id:number;payload_hash:string;revision:string;verified:true}
import {PLATFORM_MENU_ICONS} from './platformMenuIcons';
export {PLATFORM_MENU_ICONS};
const hash=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function platformMenuObject(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('权限规则数据必须是对象');return v as Record<string,unknown>;}
export function platformMenuInteger(v:unknown,min=0,max=2147483647):number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw Error('权限规则数值超出范围');return v;}
function text(v:unknown,max:number):string{if(typeof v!=='string'||[...v].length>max||/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(v))throw Error('权限规则文字无效或超出长度');return v;}
export function platformMenuRow(v:unknown):PlatformMenuRow{const r=platformMenuObject(v);if(!Array.isArray(r.role_reference_ids)||r.role_reference_ids.length>10000||typeof r.revision!=='string'||!/^\d{1,10}$/.test(r.revision))throw Error('权限规则引用或版本无效');return {id:platformMenuInteger(r.id,1),pid:platformMenuInteger(r.pid),auth_type:platformMenuInteger(r.auth_type,0,2),menu_name:text(r.menu_name,64),menu_path:text(r.menu_path,255),unique_auth:text(r.unique_auth,150),api_url:text(r.api_url,255),methods:text(r.methods,32),icon:text(r.icon,50),sort:platformMenuInteger(r.sort,-2147483648),is_show:platformMenuInteger(r.is_show,0,1),is_show_path:platformMenuInteger(r.is_show_path,0,1),access:platformMenuInteger(r.access,0,1),revision:r.revision,role_reference_ids:r.role_reference_ids.map(v=>platformMenuInteger(v,1))};}
export const newPlatformMenu=():PlatformMenuValues=>({pid:0,auth_type:1,menu_name:'',menu_path:'',unique_auth:'',api_url:'',methods:'',icon:'',sort:0,is_show:0,is_show_path:0});
export function platformMenuValues(v:unknown,prior:PlatformMenuRow|null):PlatformMenuValues{
 const r=platformMenuObject(v),row=platformMenuRow({...r,id:prior?.id??1,access:prior?.access??1,revision:prior?.revision??'1',role_reference_ids:prior?.role_reference_ids??[]});
 if((![1,2].includes(row.auth_type)&&row.auth_type!==prior?.auth_type)||!row.menu_name.trim())throw Error('请选择菜单或接口并填写名称');
 if(row.auth_type===1&&(!prior||row.menu_path!==prior.menu_path||row.auth_type!==prior.auth_type)&&(!row.menu_path||!/^\/(?!\/)/.test(row.menu_path)||/[?#\\\s]/u.test(row.menu_path)))throw Error('请选择本地页面路由');
 if(row.auth_type===2){if(!row.api_url)throw Error('请选择接口地址');if(!['GET','POST','PUT','DELETE'].includes(row.methods)&&(!prior||row.api_url!==prior.api_url||row.methods!==prior.methods||row.auth_type!==prior.auth_type))throw Error('请选择接口请求方式');row.is_show=1;}
 if(row.sort<0&&row.sort!==prior?.sort)throw Error('排序不能为负数');
 if(row.unique_auth!==prior?.unique_auth&&row.unique_auth&&!/^[A-Za-z0-9_.-]+$/.test(row.unique_auth))throw Error('前端权限标识仅接受字母、数字、下划线、点或横线');
 if(row.icon!==prior?.icon&&!(PLATFORM_MENU_ICONS as readonly string[]).includes(row.icon))throw Error('请选择图标目录中的符号');
 return Object.fromEntries(PLATFORM_MENU_FIELDS.map(k=>[k,row[k]])) as unknown as PlatformMenuValues;
}
export function platformMenuCanonical(a:Pick<PlatformMenuAction,'operation'|'id'|'input'>):string {const r=a.input;return JSON.stringify({operation:a.operation,id:a.id,expected_revision:r.expected_revision,values:a.operation==='create'||a.operation==='update'?Object.fromEntries(PLATFORM_MENU_FIELDS.map(k=>[k,r[k]])):null,is_show:a.operation==='show'?r.is_show:null});}
export async function platformMenuPayloadHash(a:Pick<PlatformMenuAction,'operation'|'id'|'input'>){const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(platformMenuCanonical(a)));return Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');}
export function platformMenuCatalog(v:unknown):PlatformMenuCatalog{const r=platformMenuObject(v);if(!Array.isArray(r.list)||r.list.length>5000||r.count!==r.list.length||typeof r.revision!=='string'||!hash.test(r.revision)||typeof r.write_ready!=='boolean'||!Array.isArray(r.apis)||r.apis.length>20000||!Array.isArray(r.pages))throw Error('权限规则完整目录无效');const list=r.list.map(platformMenuRow);if(new Set(list.map(x=>x.id)).size!==list.length)throw Error('权限规则ID重复');return {list,count:list.length,revision:r.revision,write_ready:r.write_ready,apis:r.apis.map(v=>{const a=platformMenuObject(v);return {method:text(a.method,12),rule:text(a.rule,255),real_name:text(a.real_name,255),permission:text(a.permission,150)};}),pages:r.pages.map(v=>{const p=platformMenuObject(v);return {path:text(p.path,255),name:text(p.name,100)};})};}
export function platformMenuReceipt(v:unknown,a:PlatformMenuAction):PlatformMenuReceipt{const r=platformMenuObject(v),id=platformMenuInteger(r.id,1);if(r.request_id!==a.input.request_id||r.actor_id!==a.actor_id||r.operation!==a.operation||r.payload_hash!==a.payload_hash||r.verified!==true||a.id>0&&id!==a.id||typeof r.revision!=='string'||!hash.test(r.revision))throw Error('回执与原权限规则操作不一致');return {request_id:a.input.request_id,actor_id:a.actor_id,operation:a.operation,id,payload_hash:a.payload_hash,revision:r.revision,verified:true};}
export function platformMenuPending(v:unknown,actor:number):PlatformMenuAction{const r=platformMenuObject(v),input=platformMenuObject(r.input),op=r.operation;if(!['create','update','show','delete'].includes(String(op))||r.actor_id!==actor||typeof input.request_id!=='string'||!uuid.test(input.request_id)||typeof input.expected_revision!=='string'||!hash.test(input.expected_revision)||typeof r.payload_hash!=='string'||!hash.test(r.payload_hash))throw Error('未确认权限规则记录异常，请保留并核对');const id=platformMenuInteger(r.id,op==='create'?0:1);if(op==='create'&&id!==0)throw Error('新增权限规则ID无效');const fields=[...(op==='create'||op==='update'?PLATFORM_MENU_FIELDS:op==='show'?['is_show']:[]),'request_id','expected_revision'];if(Object.keys(input).length!==fields.length||fields.some(k=>!Object.hasOwn(input,k)))throw Error('未确认权限规则字段异常');return JSON.parse(JSON.stringify(r)) as PlatformMenuAction;}
export function platformMenuParents(rows:PlatformMenuRow[],id:number):Array<{id:number;label:string;disabled?:boolean}>{const graph=platformMenuGraph(rows),blocked=new Set(id?[id]:[]),queue=id?[id]:[];for(let i=0;i<queue.length;i++)for(const c of graph.get(queue[i])?.children??[])if(!blocked.has(c)){blocked.add(c);queue.push(c);}return [{id:0,label:'顶级菜单'},...rows.filter(r=>r.auth_type===1&&!blocked.has(r.id)&&!graph.get(r.id)!.issue).map(r=>({id:r.id,label:`#${r.id} ${graph.get(r.id)!.path}`}))];}

export interface PlatformMenuNode {row:PlatformMenuRow;depth:number;path:string;issue:string;children:number[]}
/** Preserve every flat row, including broken historical graph components. */
export function platformMenuGraph(rows:PlatformMenuRow[]):Map<number,PlatformMenuNode>{
 const by=new Map(rows.map(row=>[row.id,row])),children=new Map<number,number[]>();
 for(const row of rows){const ids=children.get(row.pid)??[];ids.push(row.id);children.set(row.pid,ids);}
 // Resolve each ancestor once. Keep four nearby names, rather than copying a
 // full ancestor path for every node in a deep historical directory.
 const resolved=new Map<number,{depth:number;ancestors:string[];issue:string}>();
 const label=(row:PlatformMenuRow)=>Array.from(row.menu_name||`#${row.id}`).slice(0,48).join('');
 for(const row of rows){
  if(resolved.has(row.id))continue;
  const trail:PlatformMenuRow[]=[],seen=new Set<number>();let cursor=row,broken=0,issue='';
  while(!resolved.has(cursor.id)){
   seen.add(cursor.id);trail.push(cursor);
   if(!cursor.pid)break;
   const parent=by.get(cursor.pid);
   if(!parent){broken=cursor.id;issue='父级记录缺失';break;}
   if(parent.auth_type!==1){broken=cursor.id;issue='父级不是菜单';break;}
   if(seen.has(parent.id)){broken=cursor.id;issue='历史规则层级存在循环';break;}
   cursor=parent;
  }
  for(const item of trail.reverse()){
   const parent=item.id===broken?undefined:resolved.get(item.pid);
   resolved.set(item.id,{depth:parent?parent.depth+1:0,ancestors:parent?[label(by.get(item.pid)!),...parent.ancestors].slice(0,4):[],issue:item.id===broken?issue:parent?.issue??''});
  }
 }
 return new Map(rows.map(row=>{const item=resolved.get(row.id)!,path=[...(item.depth>4?['…']:[]),...item.ancestors.slice().reverse(),row.menu_name||`#${row.id}`].join(' / ');return [row.id,{row,depth:item.issue?0:Math.min(item.depth,6),path,issue:item.issue,children:children.get(row.id)??[]}];}));
}
