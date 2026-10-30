/** Platform SKU templates: preserve stored raw JSON unless replacement is explicit. */
export interface RuleDimension { value: string; detail: string[] }
export type RuleOperation = 'create' | 'update' | 'delete';
export interface RuleRow { id: number; type: number; relation_id: number; rule_name: string; rule_value: string | null }
export interface RuleCatalog { list: RuleRow[]; count: number; revision: string; write_ready: boolean; can_create: boolean }
export type RuleValues = { rule_name: string; mode: 'preserve' } | { rule_name: string; mode: 'replace'; spec: RuleDimension[] };
export type RulePayload = RuleValues;
export interface RuleAction { operation_id: string; actor_id: number; operation: RuleOperation; target_id: number; revision: string; payload: Record<string, unknown>; payload_hash: string }
export interface RuleReceipt extends Omit<RuleAction,'payload'> { state: 'committed' | 'not_applied'; result: { id: number; created: number; updated: number; count: number; revision: string } }
export function ruleObject(value: unknown): Record<string,unknown> { if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('规格模板数据须为对象'); return value as Record<string,unknown>; }
export function ruleOnly(value: Record<string,unknown>,keys: readonly string[]) { if (Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))) throw Error('规格模板字段不完整或包含未知字段'); }
export function ruleInteger(value: unknown,min=0,max=2147483647): number { if (typeof value!=='number' || !Number.isSafeInteger(value) || value<min || value>max) throw Error('规格模板整数参数无效'); return value; }
export function ruleText(value: unknown,max=4096): string { if (typeof value!=='string' || [...value].length>max) throw Error('规格模板文本参数无效'); return value; }
export function ruleUuid(value: unknown): string { if (typeof value!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw Error('规格模板操作标识须为小写UUIDv4'); return value; }
export function ruleHash(value: unknown): string { if (typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('规格模板版本或摘要无效'); return value; }
export function ruleOperation(value: unknown): RuleOperation { if (typeof value!=='string' || !['create','update','delete'].includes(value)) throw Error('规格模板操作类型无效'); return value as RuleOperation; }
function text(value: unknown,max: number,label: string): string { const normalized=ruleText(value).trim(); if (!normalized || [...normalized].length>max || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(normalized)) throw Error(`${label}须为${max}个字符以内的有效文字`); return normalized; }
export function ruleName(value: unknown,original?: string): string { const raw=ruleText(value); return original!==undefined && raw===original ? raw : text(raw,32,'模板名称'); }
export function ruleRawSpec(value: unknown): RuleDimension[] {
 if (!Array.isArray(value) || value.length<1 || value.length>3) throw Error('商品规格维度需为1至3项');
 return value.map(item=>{const row=ruleObject(item);ruleOnly(row,['value','detail']);if(!Array.isArray(row.detail)||row.detail.length<1||row.detail.length>50)throw Error('每个维度须包含1至50个规格值');return {value:ruleText(row.value),detail:row.detail.map(item=>ruleText(item))};});
}
export function ruleSpec(value: unknown): RuleDimension[] {
 const dimensions=ruleRawSpec(value).map(row=>{const value=text(row.value,32,'规格名称'),detail=row.detail.map(value=>text(value,64,'规格值'));if(new Set(detail).size!==detail.length)throw Error('同一维度的规格值不能重复');return {value,detail};});
 if(new Set(dimensions.map(row=>row.value)).size!==dimensions.length)throw Error('规格名称不能重复');return dimensions;
}
/** Strict whole-document projection; no filtering, dropping fields or truncation. */
export function ruleProjection(raw: string|null): {spec:RuleDimension[]|null;problem:string} {
 try { if(raw===null)throw Error('原规格为数据库空值');const parsed:unknown=JSON.parse(raw);ruleSpec(parsed);return {spec:ruleRawSpec(parsed),problem:''}; }
 catch(error){return {spec:null,problem:error instanceof Error?error.message:'历史规格格式无法编辑'};}
}
export function rulePayload(operation: RuleOperation,value: unknown): Record<string,unknown> {
 const row=ruleObject(value);if(operation==='delete'){ruleOnly(row,[]);return {};}
 const rule_name=ruleText(row.rule_name);let payload:RuleValues;
 if(row.mode==='preserve' && operation==='update'){ruleOnly(row,['rule_name','mode']);payload={rule_name,mode:'preserve'};}
 else if(row.mode==='replace'){ruleOnly(row,['rule_name','mode','spec']);payload={rule_name,mode:'replace',spec:ruleRawSpec(row.spec)};}
 else throw Error('新模板须填写完整规格；历史规格仅可原样保留或明确替换');
 if(new TextEncoder().encode(JSON.stringify(payload)).length>48*1024)throw Error('完整规格原稿超过48KiB，请精简输入后确认，不能截断');
 return {...payload};
}
export function ruleAction(value: unknown,actor: number): RuleAction {
 const row=ruleObject(value);ruleOnly(row,['operation_id','actor_id','operation','target_id','revision','payload','payload_hash']);const operation=ruleOperation(row.operation),target_id=ruleInteger(row.target_id);
 if(row.actor_id!==actor || operation==='create'&&target_id!==0 || operation!=='create'&&target_id===0)throw Error('原规格模板操作归属或目标不一致');
 return {operation_id:ruleUuid(row.operation_id),actor_id:ruleInteger(row.actor_id,1),operation,target_id,revision:ruleHash(row.revision),payload:rulePayload(operation,row.payload),payload_hash:ruleHash(row.payload_hash)};
}
export function ruleCanonical(action: Omit<RuleAction,'payload_hash'>) { return {domain:'product-rule-author-v1',actor_id:action.actor_id,operation_id:action.operation_id,operation:action.operation,target_id:action.target_id,revision:action.revision,payload:rulePayload(action.operation,action.payload)}; }
export async function rulePayloadHash(action: Omit<RuleAction,'payload_hash'>): Promise<string> { const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(ruleCanonical(action))));return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join(''); }
export function ruleReceipt(value: unknown,action: RuleAction): RuleReceipt {
 const row=ruleObject(value);ruleOnly(row,['operation_id','actor_id','operation','target_id','revision','payload_hash','state','result']);
 for(const key of ['operation_id','actor_id','operation','target_id','revision','payload_hash']as const)if(row[key]!==action[key])throw Error('规格模板回执与原操作不一致');
 if(row.state!=='committed'&&row.state!=='not_applied')throw Error('规格模板操作结果仍未知');
 const result=ruleObject(row.result);ruleOnly(result,['id','created','updated','count','revision']);const checked={id:ruleInteger(result.id),created:ruleInteger(result.created,0,1),updated:ruleInteger(result.updated,0,1),count:ruleInteger(result.count,0,20000),revision:ruleHash(result.revision)};
 if(row.state==='not_applied'?checked.id!==action.target_id||checked.created!==0||checked.updated!==0||checked.count!==0||checked.revision!==action.revision:action.operation==='create'?checked.id<1||checked.created!==1||checked.updated!==0:checked.id!==action.target_id||checked.created!==0||checked.updated!==1)throw Error('规格模板回执终态与原操作矛盾');
 return {operation_id:action.operation_id,actor_id:action.actor_id,operation:action.operation,target_id:action.target_id,revision:action.revision,payload_hash:action.payload_hash,state:row.state,result:checked};
}
export function ruleCatalog(value: unknown): RuleCatalog {
 const row=ruleObject(value);ruleOnly(row,['list','count','revision','write_ready','can_create']);
 if(!Array.isArray(row.list)||row.list.length>20000||row.count!==row.list.length||typeof row.write_ready!=='boolean'||typeof row.can_create!=='boolean'||new TextEncoder().encode(JSON.stringify(row.list)).length>16*1024*1024)throw Error('规格模板完整目录无效或超过完整读取预算');
 const ids=new Set<number>(),list=row.list.map(value=>{const item=ruleObject(value);ruleOnly(item,['id','type','relation_id','rule_name','rule_value']);const id=ruleInteger(item.id,1);if(ids.has(id)||item.type!==0||item.relation_id!==0||item.rule_value!==null&&typeof item.rule_value!=='string')throw Error('规格模板目录重复或归属错误');ids.add(id);return {id,type:0,relation_id:0,rule_name:ruleText(item.rule_name,32),rule_value:item.rule_value as string|null};});
 return {list,count:list.length,revision:ruleHash(row.revision),write_ready:row.write_ready,can_create:row.can_create};
}
