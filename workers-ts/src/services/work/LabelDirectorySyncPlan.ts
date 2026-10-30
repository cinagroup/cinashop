import {checkedCorpTagCreateRequest,type CorpTagCreateRequest} from './EnterpriseWechatProviderClient';

const MAX_GROUPS=5000,MAX_TAGS=10000,INT_MAX=2147483647,UINT_MAX=0xffff_ffff;
const ID=/^[A-Za-z0-9][A-Za-z0-9_@.-]{0,63}$/u;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
export class LabelDirectorySyncPlanError extends Error {
 constructor(readonly code:string){super(code);this.name='LabelDirectorySyncPlanError';}
}
function fail(code:string):never{throw new LabelDirectorySyncPlanError(code);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return fail('label_directory_object_invalid');return value as Record<string,unknown>;}
function only(row:Record<string,unknown>,fields:readonly string[]){if(Object.keys(row).some(key=>!fields.includes(key)))fail('label_directory_unknown_field');}
function integer(value:unknown,min=0,max=INT_MAX):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return fail('label_directory_integer_invalid');return value;}
function text(value:unknown,max:number,nonempty=true):string{if(typeof value!=='string'||[...value].length>max||nonempty&&!value||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value))return fail('label_directory_name_invalid');return value;}
function remoteId(value:unknown):string{if(typeof value!=='string'||!ID.test(value))return fail('label_directory_remote_id_invalid');return value;}
function remoteName(value:unknown):string{const name=text(value,30);if(name!==name.trim())return fail('label_directory_name_invalid');return name;}
function liveFlag(row:Record<string,unknown>){if(Object.hasOwn(row,'deleted')&&row.deleted!==false)fail('label_directory_deleted_or_incomplete');}

export interface LabelDirectoryTag {id:string;name:string;order:number;createTime:number}
export interface LabelDirectoryGroup {id:string;name:string;order:number;createTime:number;tags:LabelDirectoryTag[]}
export interface LabelDirectoryCatalog {groups:LabelDirectoryGroup[]}
export interface LabelDirectoryLocalCategory {id:number;type:number;relationId:number;ownerId:number;group:number;name:string;sort:number;other:string|null}
export interface LabelDirectoryLocalLabel {id:number;type:number;relationId:number;labelCate:number;name:string;tagId:string;sort:number}
/** Pass the complete two local tables, including readonly foreign rows: their
 * existing remote claims must not be silently adopted by the platform author. */
export interface LabelDirectoryLocalSource {categories:LabelDirectoryLocalCategory[];labels:LabelDirectoryLocalLabel[]}
export interface LabelDirectoryMappings {
 categories:Array<{localId:number;remoteId:string}>;
 labels:Array<{localId:number;remoteId:string;groupId:string}>;
}
export interface LabelDirectoryExportRequest {
 categoryId:number;
 groupId:string|null;
 request:CorpTagCreateRequest;
 labels:Array<{localId:number;name:string}>;
}
export interface LabelDirectoryExportPlan {
 requests:LabelDirectoryExportRequest[];
 mappings:LabelDirectoryMappings;
 /** Empty local categories cannot be created by this provider API. */
 emptyCategories:number[];
}
export interface LabelDirectoryCategoryImport {localId:number|null;remoteId:string;name:string;sort:number;createTime:number}
export interface LabelDirectoryLabelImport {localId:number|null;remoteId:string;groupId:string;name:string;sort:number;createTime:number}
export interface LabelDirectoryImportPlan {
 categories:LabelDirectoryCategoryImport[];
 labels:LabelDirectoryLabelImport[];
 mappings:LabelDirectoryMappings;
}

/** Standard, unfiltered corpTagDirectory response only. Unlike C7's targeted
 * callback parser, the official full response may omit deleted=false. No
 * pagination/count/truncation metadata or strategy catalog is silently ignored.
 * Limits are this author's full-response policy; no rows are truncated. */
export function checkedLabelDirectoryCatalog(value:unknown):LabelDirectoryCatalog{
 const row=object(value);only(row,['errcode','errmsg','tag_group']);
 if(row.errcode!==0||Object.hasOwn(row,'errmsg')&&typeof row.errmsg!=='string'||!Array.isArray(row.tag_group)||row.tag_group.length>MAX_GROUPS)fail('label_directory_catalog_invalid');
 const ids=new Set<string>(),names=new Set<string>(),tagIds=new Set<string>();let total=0;
 const groups=row.tag_group.map(value=>{
  const g=object(value);only(g,['group_id','group_name','order','create_time','tag','deleted']);liveFlag(g);
  const id=remoteId(g.group_id),name=remoteName(g.group_name);
  if(ids.has(id)||names.has(name)||!Array.isArray(g.tag)||g.tag.length>MAX_TAGS)fail('label_directory_group_ambiguous');ids.add(id);names.add(name);
  total+=g.tag.length;if(total>MAX_TAGS)fail('label_directory_catalog_capacity');const within=new Set<string>();
  const tags=g.tag.map(value=>{const t=object(value);only(t,['id','name','order','create_time','deleted']);liveFlag(t);const id=remoteId(t.id),name=remoteName(t.name);if(tagIds.has(id)||within.has(name))fail('label_directory_tag_ambiguous');tagIds.add(id);within.add(name);return{id,name,order:integer(t.order,0,UINT_MAX),createTime:integer(t.create_time,0,UINT_MAX)};});
  return{id,name,order:integer(g.order,0,UINT_MAX),createTime:integer(g.create_time,0,UINT_MAX),tags:tags.sort((a,b)=>compare(a.id,b.id))};
 });return{groups:groups.sort((a,b)=>compare(a.id,b.id))};
}

/** Revalidate persisted normalized snapshots too, rather than trusting TS types
 * or accepting a partial raw create ACK as a directory. */
function catalog(value:LabelDirectoryCatalog):LabelDirectoryCatalog{
 const r=object(value);only(r,['groups']);if(!Array.isArray(r.groups)||r.groups.length>MAX_GROUPS)fail('label_directory_catalog_invalid');let total=0;
 return checkedLabelDirectoryCatalog({errcode:0,tag_group:r.groups.map(value=>{const g=object(value);only(g,['id','name','order','createTime','tags']);if(!Array.isArray(g.tags)||g.tags.length>MAX_TAGS)fail('label_directory_catalog_invalid');total+=g.tags.length;if(total>MAX_TAGS)fail('label_directory_catalog_capacity');return{group_id:g.id,group_name:g.name,order:g.order,create_time:g.createTime,tag:g.tags.map(value=>{const t=object(value);only(t,['id','name','order','createTime']);return{id:t.id,name:t.name,order:t.order,create_time:t.createTime};})};})});
}
function local(value:LabelDirectoryLocalSource){
 const r=object(value);only(r,['categories','labels']);if(!Array.isArray(r.categories)||!Array.isArray(r.labels)||r.categories.length>MAX_GROUPS||r.labels.length>MAX_TAGS)fail('label_directory_local_capacity');
 const categoryIds=new Set<number>(),labelIds=new Set<number>();
 const categories=r.categories.map(value=>{const x=object(value),id=integer(x.id,1);if(categoryIds.has(id))fail('label_directory_local_id_duplicate');categoryIds.add(id);if(x.other!==null&&typeof x.other!=='string')fail('label_directory_mapping_invalid');return{id,type:integer(x.type,-32768,32767),relationId:integer(x.relationId),ownerId:integer(x.ownerId),group:integer(x.group,-32768,32767),name:text(x.name,255,false),sort:integer(x.sort,-2147483648),other:x.other as string|null};});
 const labels=r.labels.map(value=>{const x=object(value),id=integer(x.id,1);if(labelIds.has(id))fail('label_directory_local_id_duplicate');labelIds.add(id);if(typeof x.tagId!=='string')fail('label_directory_mapping_invalid');return{id,type:integer(x.type,-32768,32767),relationId:integer(x.relationId),labelCate:integer(x.labelCate),name:text(x.name,255,false),tagId:x.tagId,sort:integer(x.sort,-2147483648)};});
 const ownedCategory=(r:LabelDirectoryLocalCategory)=>r.type===0&&r.relationId===0&&r.ownerId===0&&r.group===0;
 const ownedLabel=(r:LabelDirectoryLocalLabel)=>r.type===0&&r.relationId===0;
 const groups=categories.filter(ownedCategory).sort((a,b)=>a.id-b.id),tags=labels.filter(ownedLabel).sort((a,b)=>a.id-b.id);
 const foreignGroups=new Set(categories.filter(x=>!ownedCategory(x)&&typeof x.other==='string'&&ID.test(x.other)).map(x=>x.other!));
 const foreignTags=new Set(labels.filter(x=>!ownedLabel(x)&&ID.test(x.tagId)).map(x=>x.tagId));
 const ownedCategoryIds=new Set(groups.map(g=>g.id));
 const names=new Set<string>(),groupClaims=new Set<string>(),tagNames=new Set<string>(),tagClaims=new Set<string>();
 for(const g of groups){if(names.has(g.name))fail('label_directory_local_group_ambiguous');names.add(g.name);if(g.other){const id=remoteId(g.other);if(groupClaims.has(id)||foreignGroups.has(id))fail('label_directory_local_group_mapping_ambiguous');groupClaims.add(id);}}
 for(const t of tags){if(!ownedCategoryIds.has(t.labelCate))fail('label_directory_local_category_missing');if(tagNames.has(t.name))fail('label_directory_local_tag_ambiguous');tagNames.add(t.name);if(t.tagId){const id=remoteId(t.tagId);if(tagClaims.has(id)||foreignTags.has(id))fail('label_directory_local_tag_mapping_ambiguous');tagClaims.add(id);}}
 return{groups,tags,foreignGroups,foreignTags,categoryCount:categories.length,labelCount:labels.length};
}

/** No provider call or DB mutation. Existing string IDs win over names. A stale
 * known ID is never recreated or rebound to a same-name replacement. Only
 * absent IDs may match one exact unique name in the exact group. */
export function planLabelDirectoryExport(value:LabelDirectoryLocalSource,remote:LabelDirectoryCatalog):LabelDirectoryExportPlan{
 const source=local(value),snapshot=catalog(remote),groupsById=new Map(snapshot.groups.map(g=>[g.id,g])),groupsByName=new Map(snapshot.groups.map(g=>[g.name,g]));
 const tagsById=new Map(snapshot.groups.flatMap(g=>g.tags.map(t=>[t.id,{group:g,tag:t}] as const)));
 for(const g of snapshot.groups){if(source.foreignGroups.has(g.id)||g.tags.some(t=>source.foreignTags.has(t.id)))fail('label_directory_foreign_mapping');}
 const requests:LabelDirectoryExportRequest[]=[],mappings:LabelDirectoryMappings={categories:[],labels:[]},emptyCategories:number[]=[];
 const usedGroups=new Set<string>(),usedTags=new Set<string>(),tagsByCategory=new Map<number,LabelDirectoryLocalLabel[]>();
 for(const tag of source.tags){const rows=tagsByCategory.get(tag.labelCate)??[];rows.push(tag);tagsByCategory.set(tag.labelCate,rows);}
 for(const category of source.groups){
  const labels=tagsByCategory.get(category.id)??[],known=labels.filter(t=>t.tagId).map(t=>{const row=tagsById.get(t.tagId);if(!row)fail('label_directory_known_tag_missing');return row;});
  let group=category.other?groupsById.get(category.other):undefined;
  if(category.other&&!group)fail('label_directory_known_group_missing');
  if(!group&&known.length){const ids=new Set(known.map(t=>t.group.id));if(ids.size!==1)fail('label_directory_known_group_conflict');group=known[0]!.group;}
  if(!group&&!category.other)group=groupsByName.get(category.name);
  if(group){if(usedGroups.has(group.id))fail('label_directory_group_mapping_duplicate');usedGroups.add(group.id);mappings.categories.push({localId:category.id,remoteId:group.id});}
  const missing:LabelDirectoryLocalLabel[]=[],byName=new Map(group?.tags.map(t=>[t.name,t])??[]);
  for(const label of labels){
   const entry=label.tagId?tagsById.get(label.tagId):undefined;
   if(entry&&entry.group.id!==group?.id)fail('label_directory_known_tag_group_conflict');
   const tag=entry?.tag??byName.get(label.name);
   if(tag){if(usedTags.has(tag.id))fail('label_directory_tag_mapping_duplicate');usedTags.add(tag.id);mappings.labels.push({localId:label.id,remoteId:tag.id,groupId:group!.id});}
   else missing.push(label);
  }
  if(!labels.length&&!group)emptyCategories.push(category.id);
  for(let offset=0;offset<missing.length;offset+=100){const chunk=missing.slice(offset,offset+100);const request=checkedCorpTagCreateRequest({...(group?{group_id:group.id}:{group_name:category.name,order:category.sort}),tag:chunk.map(t=>({name:t.name,order:t.sort}))});requests.push({categoryId:category.id,groupId:group?.id??null,request,labels:chunk.map(t=>({localId:t.id,name:t.name}))});}
 }
 return{requests,mappings,emptyCategories};
}

/** Build the final import only once all local exports are confirmed in a fresh
 * full remote read. A partial create ACK can never authorize an import. The
 * caller allocates IDs for localId=null and preserves every non-listed column. */
export function planLabelDirectoryImport(value:LabelDirectoryLocalSource,remote:LabelDirectoryCatalog):LabelDirectoryImportPlan{
 const snapshot=catalog(remote),source=local(value),plan=planLabelDirectoryExport(value,snapshot);
 if(plan.requests.length)fail('label_directory_export_unconfirmed');
 const categoryByRemote=new Map(plan.mappings.categories.map(x=>[x.remoteId,x.localId])),labelByRemote=new Map(plan.mappings.labels.map(x=>[x.remoteId,x.localId]));
 if(source.categoryCount+snapshot.groups.filter(g=>!categoryByRemote.has(g.id)).length>MAX_GROUPS||source.labelCount+snapshot.groups.reduce((n,g)=>n+g.tags.filter(t=>!labelByRemote.has(t.id)).length,0)>MAX_TAGS)fail('label_directory_local_capacity');
 const categories=snapshot.groups.map(g=>({localId:categoryByRemote.get(g.id)??null,remoteId:g.id,name:g.name,sort:integer(g.order),createTime:integer(g.createTime)}));
 const labels=snapshot.groups.flatMap(g=>g.tags.map(t=>({localId:labelByRemote.get(t.id)??null,remoteId:t.id,groupId:g.id,name:t.name,sort:integer(t.order),createTime:integer(t.createTime)})));
 // The existing platform author has globally unique label names, unlike the
 // provider's per-group rule. Never merge or rename distinct remote identities.
 const names=new Set<string>();for(const label of labels){if(names.has(label.name))fail('label_directory_import_name_ambiguous');names.add(label.name);}
 return{categories,labels,mappings:plan.mappings};
}

function exportRequest(value:LabelDirectoryExportRequest):LabelDirectoryExportRequest{
 const r=object(value);only(r,['categoryId','groupId','request','labels']);const categoryId=integer(r.categoryId,1),request=checkedCorpTagCreateRequest(r.request);
 if(r.groupId!==(request.group_id??null)||!Array.isArray(r.labels)||r.labels.length!==request.tag.length)fail('label_directory_request_mapping_invalid');
 const ids=new Set<number>(),names=new Set<string>();const labels=r.labels.map(value=>{const row=object(value);only(row,['localId','name']);const localId=integer(row.localId,1),name=remoteName(row.name);if(ids.has(localId)||names.has(name)||!request.tag.some(t=>t.name===name))fail('label_directory_request_mapping_invalid');ids.add(localId);names.add(name);return{localId,name};});return{categoryId,groupId:r.groupId as string|null,request,labels};
}

/** Reconcile an already-dispatched exact command, including a lost ACK, with
 * two complete snapshots. No retry is performed or suggested. Only the exact
 * newly identified tags may differ; deletions, renames, unrelated additions,
 * reused IDs or partial visibility leave the durable command unresolved. This
 * proves the desired new identities, not causation or provider idempotency. */
export function recoverLabelDirectoryCreate(beforeValue:LabelDirectoryCatalog,value:LabelDirectoryExportRequest,afterValue:LabelDirectoryCatalog):{groupId:string;labels:Array<{localId:number;remoteId:string}>;evidence:'new-identities-after-exact-request'}{
 const before=catalog(beforeValue),after=catalog(afterValue),command=exportRequest(value),request=command.request;
 const beforeGroup=request.group_id?before.groups.find(g=>g.id===request.group_id):before.groups.find(g=>g.name===request.group_name);
 if(request.group_id&&!beforeGroup)fail('label_directory_recovery_group_missing');
 const group=beforeGroup?after.groups.find(g=>g.id===beforeGroup.id):after.groups.find(g=>g.name===request.group_name);
 if(!group||!beforeGroup&&before.groups.some(g=>g.id===group.id))fail('label_directory_recovery_group_unproven');
 const existingIds=new Set(before.groups.flatMap(g=>g.tags.map(t=>t.id)));
 const labels=command.labels.map(label=>{if(beforeGroup?.tags.some(t=>t.name===label.name))fail('label_directory_recovery_not_new');const tag=group.tags.find(t=>t.name===label.name),requested=request.tag.find(t=>t.name===label.name)!;if(!tag||existingIds.has(tag.id)||requested.order!==undefined&&requested.order!==tag.order)fail('label_directory_recovery_tag_unproven');return{localId:label.localId,remoteId:tag.id};});
 if(!beforeGroup&&request.order!==undefined&&group.order!==request.order)fail('label_directory_recovery_group_unproven');
 const addedIds=new Set(labels.map(t=>t.remoteId));
 const rest=after.groups.map(g=>({...g,tags:g.tags.filter(t=>!addedIds.has(t.id))})).filter(g=>beforeGroup!==undefined||g.id!==group.id);
 if(JSON.stringify(rest)!==JSON.stringify(before.groups)||group.tags.length!==(beforeGroup?.tags.length??0)+labels.length)fail('label_directory_recovery_concurrent_change');
 return{groupId:group.id,labels,evidence:'new-identities-after-exact-request'};
}
