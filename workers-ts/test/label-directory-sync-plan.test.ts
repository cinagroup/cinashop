import {describe,expect,it} from 'vitest';
import {checkedLabelDirectoryCatalog,planLabelDirectoryExport,planLabelDirectoryImport,recoverLabelDirectoryCreate,type LabelDirectoryCatalog,type LabelDirectoryLocalCategory,type LabelDirectoryLocalLabel,type LabelDirectoryLocalSource} from '@/services/work/LabelDirectorySyncPlan';

const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
function category(id=1,name='Customers',other:string|null=''):LabelDirectoryLocalCategory{return{id,type:0,relationId:0,ownerId:0,group:0,name,sort:5,other};}
function label(id=1,labelCate=1,name='VIP',tagId=''):LabelDirectoryLocalLabel{return{id,type:0,relationId:0,labelCate,name,tagId,sort:9};}
function source(categories=[category()],labels=[label()]):LabelDirectoryLocalSource{return{categories,labels};}
function tag(id='et-vip',name='VIP',other:Record<string,unknown>={}){return{id,name,order:9,create_time:1788000000,...other};}
function group(id='et-customers',name='Customers',tags=[tag()],other:Record<string,unknown>={}){return{group_id:id,group_name:name,order:5,create_time:1788000000,tag:tags,...other};}
function raw(groups=[group()]){return{errcode:0,errmsg:'ok',tag_group:groups};}
const catalog=(groups=[group()])=>checkedLabelDirectoryCatalog(raw(groups));
function freeze(value:unknown){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}}

describe('complete corporate label directory parser, independent of C7 targeted callbacks',()=>{
 it('accepts documented absent deleted flags and explicit false without normalizing IDs or input',()=>{const input=raw([group('et-B','B',[tag('et-b','B')]),group('et-A','A',[tag('et-a','A',{deleted:false})],{deleted:false})]),before=clone(input);expect(checkedLabelDirectoryCatalog(input).groups.map(g=>g.id)).toEqual(['et-A','et-B']);expect(input).toEqual(before);});
 it('keeps remote uint32 ordering intact instead of silently clipping to local signed columns',()=>{expect(catalog([group('et-group','G',[tag('et-tag','T',{order:0xffff_ffff})],{order:0xffff_ffff})]).groups[0]!.order).toBe(0xffff_ffff);});
 it.each([
  ['non-object',null],['business failure',{errcode:40013,tag_group:[]}],['string status',{errcode:'0',tag_group:[]}],['missing array',{errcode:0}],
  ['create ACK is not a catalog',{errcode:0,tag_group:group()}],['pagination',{...raw(),has_more:false}],['unknown cursor',{...raw(),next_cursor:''}],
  ['duplicate group ID',raw([group(),group('et-customers','Other')])],['duplicate group name',raw([group(),group('et-other')])],
  ['duplicate tag ID across groups',raw([group(),group('et-other','Other',[tag()])])],['duplicate name in a group',raw([group('et-g','G',[tag(),tag('et-2')])])],
  ['deleted group',raw([group('et-g','G',[],{deleted:true})])],['deleted tag',raw([group('et-g','G',[tag('et-t','T',{deleted:true})])])],
  ['string deleted',raw([group('et-g','G',[],{deleted:'false'})])],['strategy scope',raw([group('et-g','G',[],{strategy_id:1})])],
  ['ID exceeds local storage',raw([group('x'.repeat(65))])],['name exceeds provider contract',raw([group('et-g','x'.repeat(31))])],
  ['unsafe name',raw([group('et-g','G\n')])],['string order',raw([group('et-g','G',[],{order:'1'})])],['overflow order',raw([group('et-g','G',[],{order:0x1_0000_0000})])],
  ['missing tag metadata',raw([group('et-g','G',[{id:'et-t',name:'T',order:1} as ReturnType<typeof tag>])])],
 ] as const)('rejects %s as one complete response failure',(_name,value)=>{expect(()=>checkedLabelDirectoryCatalog(value)).toThrow();});
 it('rejects a bad tail rather than returning its valid prefix',()=>{const rows=[tag('et-1','One'),tag('et-2','Two'),tag('et-3','Three',{create_time:-1})];expect(()=>catalog([group('et-g','G',rows)])).toThrow();});
 it('accepts 10000 remote identities and rejects a 10001st tail without truncation',()=>{const tags=Array.from({length:10000},(_,i)=>tag(`et-${i}`,`Tag ${i}`));expect(catalog([group('et-g','G',tags)]).groups[0]!.tags).toHaveLength(10000);expect(()=>catalog([group('et-g','G',[...tags,tag('et-over','Overflow')])])).toThrow();});
 it('rejects a 5001st group even when every group is otherwise complete',()=>{const rows=Array.from({length:5001},(_,i)=>group(`et-g-${i}`,`G ${i}`,[]));expect(()=>catalog(rows)).toThrow();});
});

describe('pure local export and authoritative remote import plans',()=>{
 it('matches existing group and tag IDs before conflicting old display names',()=>{const local=source([category(1,'Old group','et-customers')],[label(1,1,'Old tag','et-vip')]);expect(planLabelDirectoryExport(local,catalog())).toEqual({requests:[],mappings:{categories:[{localId:1,remoteId:'et-customers'}],labels:[{localId:1,remoteId:'et-vip',groupId:'et-customers'}]},emptyCategories:[]});expect(planLabelDirectoryImport(local,catalog())).toMatchObject({categories:[{localId:1,name:'Customers'}],labels:[{localId:1,name:'VIP'}]});});
 it('binds unique existing names only when local remote identities are absent',()=>{expect(planLabelDirectoryExport(source(),catalog()).mappings).toEqual({categories:[{localId:1,remoteId:'et-customers'}],labels:[{localId:1,remoteId:'et-vip',groupId:'et-customers'}]});});
 it('uses mapped tag identity to recover an unmapped renamed group without a name-based new group',()=>{const plan=planLabelDirectoryExport(source([category(1,'Old group')],[label(1,1,'Old tag','et-vip')]),catalog());expect(plan.requests).toEqual([]);expect(plan.mappings.categories).toEqual([{localId:1,remoteId:'et-customers'}]);});
 it('plans all 201 missing labels in explicit batches of 100 without dropping overflow',()=>{const local=source([category()],Array.from({length:201},(_,i)=>label(i+1,1,`T ${i}`)));const plan=planLabelDirectoryExport(local,catalog([]));expect(plan.requests.map(x=>x.request.tag.length)).toEqual([100,100,1]);expect(plan.requests.flatMap(x=>x.labels.map(t=>t.localId))).toEqual(local.labels.map(t=>t.id));expect(plan.requests.every(x=>x.request.group_name==='Customers'&&x.groupId===null)).toBe(true);});
 it('adds to an exact existing group ID and does not send ignored group-name/order fields',()=>{const plan=planLabelDirectoryExport(source(),catalog([group('et-customers','Customers',[])]));expect(plan.requests[0]!.request).toEqual({group_id:'et-customers',tag:[{name:'VIP',order:9}]});});
 it('does not manufacture empty remote categories or silently forget them',()=>{expect(planLabelDirectoryExport(source([category()],[]),catalog([]))).toEqual({requests:[],mappings:{categories:[],labels:[]},emptyCategories:[1]});});
 it('imports new remote group/tag identities as unallocated local IDs, without provider data becoming a write',()=>{const plan=planLabelDirectoryImport(source([],[]),catalog());expect(plan.categories).toEqual([{localId:null,remoteId:'et-customers',name:'Customers',sort:5,createTime:1788000000}]);expect(plan.labels).toEqual([{localId:null,remoteId:'et-vip',groupId:'et-customers',name:'VIP',sort:9,createTime:1788000000}]);expect(plan.mappings).toEqual({categories:[],labels:[]});});
 it('requires all pending local exports to be observed before producing the final import',()=>{expect(()=>planLabelDirectoryImport(source(),catalog([]))).toThrow('label_directory_export_unconfirmed');});
 it.each([
  ['stale known group',source([category(1,'Customers','et-gone')])],
  ['stale known tag',source([category()],[label(1,1,'VIP','et-gone')])],
  ['foreign category identity',source([category(),{...category(2,'Foreign','et-customers'),ownerId:12}],[])],
  ['foreign tag identity',source([category()],[label(),{...label(2,1,'Foreign','et-vip'),type:1,relationId:12}])],
  ['duplicate local category name',source([category(),category(2)],[])],
  ['duplicate local tag name',source([category()],[label(),label(2)])],
  ['duplicate local group mapping',source([category(1,'A','et-customers'),category(2,'B','et-customers')],[])],
  ['duplicate local tag mapping',source([category()],[label(1,1,'A','et-vip'),label(2,1,'B','et-vip')])],
  ['orphan local category',source([category()],[label(1,0)])],
  ['numeric string scope',source([{...category(),type:'0' as unknown as number}],[])],
  ['invalid stored group mapping',source([category(1,'Customers','id with space')],[])],
 ] as const)('refuses %s without partial plans',(_name,local)=>{expect(()=>planLabelDirectoryExport(local,catalog())).toThrow();});
 it('refuses a known tag moved to a different remote group instead of rebinding it by name',()=>{const local=source([category(1,'Customers','et-customers')],[label(1,1,'VIP','et-vip')]);expect(()=>planLabelDirectoryExport(local,catalog([group('et-customers','Customers',[]),group('et-other','Other',[tag()])]))).toThrow('label_directory_known_tag_group_conflict');});
 it('refuses remote tag names that would collapse distinct IDs into one global local name',()=>{const remote=catalog([group('et-a','A',[tag('et-a1','Same')]),group('et-b','B',[tag('et-b1','Same')])]);expect(()=>planLabelDirectoryImport(source([],[]),remote)).toThrow('label_directory_import_name_ambiguous');});
 it('rejects remote uint32 values that cannot fit local signed order columns, without coercing the snapshot',()=>{const remote=catalog([group('et-g','G',[],{order:0xffff_ffff})]);expect(()=>planLabelDirectoryImport(source([],[]),remote)).toThrow('label_directory_integer_invalid');expect(remote.groups[0]!.order).toBe(0xffff_ffff);});
 it('counts readonly foreign rows in the final local capacity budget',()=>{const categories=Array.from({length:5000},(_,i)=>({...category(i+1,`Foreign ${i}`),ownerId:9,other:null}));expect(()=>planLabelDirectoryImport(source(categories,[]),catalog())).toThrow('label_directory_local_capacity');});
 it('never mutates local/remote snapshots or unknown local metadata',()=>{const local={...source(),unknown:'rejected top-level'};expect(()=>planLabelDirectoryExport(local,catalog())).toThrow();const plain=source(),remote=catalog();Object.assign(plain.categories[0]!,{otherLegacy:{raw:['kept']}});Object.assign(plain.labels[0]!,{color:'bad-old-value',status:0});const before=clone({plain,remote});freeze(plain);freeze(remote);planLabelDirectoryExport(plain,remote);const imported=planLabelDirectoryImport(plain,remote);imported.labels[0]!.name='Changed result';expect({plain,remote}).toEqual(before);});
 it('revalidates normalized persisted snapshots and rejects a forged partial shape',()=>{expect(()=>planLabelDirectoryExport(source(),{groups:[{id:'et-g'}]} as LabelDirectoryCatalog)).toThrow();});
});

describe('fresh-read confirmation after a durable exact create dispatch',()=>{
 function fixture(existing=false){const local=source(),before=catalog(existing?[group('et-customers','Customers',[])]:[]),request=planLabelDirectoryExport(local,before).requests[0]!,after=catalog();return{local,before,request,after};}
 it.each([false,true])('confirms newly observed identities after a lost ACK (existing group %s)',existing=>{const{before,request,after}=fixture(existing),frozen=clone({before,request,after});expect(recoverLabelDirectoryCreate(before,request,after)).toEqual({groupId:'et-customers',labels:[{localId:1,remoteId:'et-vip'}],evidence:'new-identities-after-exact-request'});expect({before,request,after}).toEqual(frozen);});
 it('confirms a later name-addressed batch after the first batch created that group',()=>{const{request}=fixture(false),before=catalog([group('et-customers','Customers',[tag('et-old','Old')])]),after=catalog([group('et-customers','Customers',[tag('et-old','Old'),tag()])]);expect(recoverLabelDirectoryCreate(before,request,after).groupId).toBe('et-customers');});
 it.each([
  ['missing desired tag',(x:ReturnType<typeof fixture>)=>{x.after=catalog([group('et-customers','Customers',[])]);}],
  ['unrelated new group',(x:ReturnType<typeof fixture>)=>{x.after=catalog([group(),group('et-other','Other',[])]);}],
  ['unrequested tag',(x:ReturnType<typeof fixture>)=>{x.after=catalog([group('et-customers','Customers',[tag(),tag('et-extra','Extra')])]);}],
  ['changed requested order',(x:ReturnType<typeof fixture>)=>{x.after=catalog([group('et-customers','Customers',[tag('et-vip','VIP',{order:8})])]);}],
  ['changed group order',(x:ReturnType<typeof fixture>)=>{x.after=catalog([group('et-customers','Customers',[tag()],{order:8})]);}],
  ['altered local mapping',(x:ReturnType<typeof fixture>)=>{x.request.labels=[{localId:1,name:'Other'}];}],
  ['wrong declared group',(x:ReturnType<typeof fixture>)=>{x.request.groupId='et-unproven';}],
 ] as const)('keeps %s unresolved instead of suggesting another POST',(_name,change)=>{const x=fixture();change(x);expect(()=>recoverLabelDirectoryCreate(x.before,x.request,x.after)).toThrow();});
 it('does not claim an already-existing same-name tag as newly created',()=>{const x=fixture();x.before=catalog();expect(()=>recoverLabelDirectoryCreate(x.before,x.request,x.after)).toThrow('label_directory_recovery_not_new');});
 it('does not re-use an existing remote ID from another group',()=>{const x=fixture();x.before=catalog([group('et-other','Other',[tag()])]);expect(()=>recoverLabelDirectoryCreate(x.before,x.request,x.after)).toThrow('label_directory_recovery_tag_unproven');});
 it('rejects before-entity renames or deletion while the provider write was in flight',()=>{const x=fixture(true);x.before.groups[0]!.tags.push({id:'et-old',name:'Old',order:1,createTime:1});x.after.groups[0]!.tags.push({id:'et-old',name:'Renamed',order:1,createTime:1});expect(()=>recoverLabelDirectoryCreate(x.before,x.request,x.after)).toThrow('label_directory_recovery_concurrent_change');});
 it('refuses an explicit group-ID dispatch whose group was absent from its before snapshot',()=>{const x=fixture(true);expect(()=>recoverLabelDirectoryCreate(catalog([]),x.request,x.after)).toThrow('label_directory_recovery_group_missing');});
});
