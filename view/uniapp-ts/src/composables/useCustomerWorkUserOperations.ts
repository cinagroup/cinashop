import { ref,watch,type Ref } from 'vue';
import { onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { createCustomerWorkUserRequests,type CustomerWorkUserRequests } from '@/api/customerWorkUsers';
import { RequestError } from '@/utils/request';
import { customerWorkCanonicalJson,customerWorkUserIntentHash,customerWorkUserEndpoint,isCustomerWorkUserBody,isCustomerWorkUserIntent,parseCustomerWorkUserEnvelope,parseCustomerWorkUserReceipt,customerWorkUserPending,retainCustomerWorkUserIntent,releaseCustomerWorkUserIntent,customerWorkRequestKey } from '@/utils/customerWorkUsers';
import { customerWorkRecord } from '@/utils/customerWork';
import type { CustomerWorkController } from './useCustomerWork';
import type { CustomerWorkUserEnvelope,CustomerWorkUserMeta,CustomerWorkUser,CustomerWorkUserKind,CustomerWorkUserBody,CustomerWorkUserIntent,CustomerWorkUserReceipt,CustomerWorkUserOperationState } from '../types/customerWorkUsers';
import { isCustomerWorkUserGroups,isCustomerWorkUserLevels,isCustomerWorkUserLabels } from '@/utils/customerWorkUsersContract';
import type { CustomerWorkUserGroups,CustomerWorkUserLevels,CustomerWorkUserLabels,CustomerWorkUserCouponCandidate } from '../types/customerWorkUsers';
function confirm(title:string,content:string):Promise<boolean>{return new Promise(resolve=>uni.showModal({title,content,success:answer=>resolve(answer.confirm),fail:()=>resolve(false)}));}
export interface CustomerWorkUserOperations{
 manager:CustomerWorkController;authority:Ref<CustomerWorkUserEnvelope<CustomerWorkUserMeta>|null>;busy:Ref<boolean>;error:Ref<string>;pending:Ref<CustomerWorkUserIntent[]>;states:Ref<Record<string,CustomerWorkUserOperationState>>;
 current:()=>boolean;clear:()=>void;
 read:<T extends CustomerWorkUserMeta>(path:string,guard:(value:unknown)=>value is T,data?:Record<string,unknown>)=>Promise<CustomerWorkUserEnvelope<T>>;
 submit:(kind:CustomerWorkUserKind,users:CustomerWorkUser[],meta:CustomerWorkUserMeta,payload:Record<string,unknown>)=>Promise<CustomerWorkUserReceipt|null>;
 check:(intent:CustomerWorkUserIntent)=>Promise<void>;restore:(intent:CustomerWorkUserIntent)=>Promise<void>;abandon:(intent:CustomerWorkUserIntent)=>Promise<void>;acknowledge:(intent:CustomerWorkUserIntent)=>Promise<void>;canRestore:(intent:CustomerWorkUserIntent)=>boolean;
}

/** Page-owned modal snapshots never share a live selection with an immutable write. */
export function useCustomerWorkUserEditor(manager:CustomerWorkController,operations:CustomerWorkUserOperations){
 const kind=ref<CustomerWorkUserKind>('replace_group'),users=ref<CustomerWorkUser[]>([]),meta=ref<CustomerWorkUserMeta|null>(null),assignmentVisible=ref(false),membershipVisible=ref(false),financeVisible=ref(false),couponVisible=ref(false),couponMode=ref<'grant'|'wallet'>('grant'),walletUid=ref(0),loading=ref(false),error=ref(''),selected=ref<number[]>([]),groups=ref<CustomerWorkUserGroups['list']>([]),levels=ref<CustomerWorkUserLevels['list']>([]),labels=ref<CustomerWorkUserLabels['list']>([]);let epoch=0;
 function clear(){epoch++;kind.value='replace_group';users.value=[];meta.value=null;assignmentVisible.value=false;membershipVisible.value=false;financeVisible.value=false;couponVisible.value=false;walletUid.value=0;loading.value=false;error.value='';selected.value=[];groups.value=[];levels.value=[];labels.value=[];}
 async function open(value:CustomerWorkUserKind,targets:CustomerWorkUser[],metadata:CustomerWorkUserMeta){if(operations.busy.value||!targets.length||targets.length>100||!metadata.readiness.writes||targets.some(user=>!user.actions[value].available))return;clear();kind.value=value;users.value=JSON.parse(customerWorkCanonicalJson(targets));meta.value=JSON.parse(customerWorkCanonicalJson(metadata));const version=epoch,valid=manager.fence();if(value==='grant_coupons'){couponMode.value='grant';couponVisible.value=true;return;}if(value==='adjust_membership'){membershipVisible.value=true;return;}if(value==='adjust_money'||value==='adjust_integral'){financeVisible.value=true;return;}assignmentVisible.value=true;loading.value=true;selected.value=targets.length===1?(value==='replace_labels'?targets[0]!.labels.map(label=>label.id):[value==='replace_level'?targets[0]!.level:targets[0]!.group_id].filter(Boolean)):[];
  try{if(value==='replace_group'){const result=await operations.read('/mobile/work/users/groups',isCustomerWorkUserGroups);if(valid()&&epoch===version){groups.value=result.data.list;meta.value=result.data;}}else if(value==='replace_level'){const result=await operations.read('/mobile/work/users/levels',isCustomerWorkUserLevels);if(valid()&&epoch===version){levels.value=result.data.list;meta.value=result.data;}}else{const result=await operations.read('/mobile/work/users/labels',isCustomerWorkUserLabels,{uid:targets.length===1?targets[0]!.uid:0});if(valid()&&epoch===version){if(result.data.uid!==(targets.length===1?targets[0]!.uid:0))throw Error('标签目录归属用户已变化');labels.value=result.data.list;meta.value=result.data;}}}catch(failure){if(valid()&&epoch===version)error.value=failure instanceof Error?failure.message:'用户目录读取失败';}finally{if(valid()&&epoch===version)loading.value=false;}
 }
 function wallet(uid:number){if(operations.busy.value||!manager.context.value)return;clear();walletUid.value=uid;couponMode.value='wallet';couponVisible.value=true;}
 async function save(payload:Record<string,unknown>){if(!meta.value)return;const receipt=await operations.submit(kind.value,users.value,meta.value,payload);if(receipt&&!['rollback-rejected','abandoned'].includes(receipt.outcome)){clear();await manager.load();}}
 async function grant(row:CustomerWorkUserCouponCandidate,metadata:CustomerWorkUserMeta){if(couponMode.value!=='grant'||kind.value!=='grant_coupons')return;meta.value=metadata;await save({issue_id:row.id,expected_issue_revision:row.issue_revision});}
 return{kind,users,meta,assignmentVisible,membershipVisible,financeVisible,couponVisible,couponMode,walletUid,loading,error,selected,groups,levels,labels,clear,open,wallet,save,grant};
}
export function useCustomerWorkUserOperations(manager:CustomerWorkController):CustomerWorkUserOperations{
 const authority=ref<CustomerWorkUserEnvelope<CustomerWorkUserMeta>|null>(null),busy=ref(false),error=ref(''),pending=ref<CustomerWorkUserIntent[]>([]),states=ref<Record<string,CustomerWorkUserOperationState>>({});
 const scopes=new Set<CustomerWorkUserRequests>();let epoch=0,disposed=false;
 const current=()=>!disposed&&manager.current()&&manager.auth.isLoggedIn;
 const owns=(intent:CustomerWorkUserIntent)=>current()&&intent.actor_uid===manager.auth.uid;
 const sameOwner=(scope:CustomerWorkUserRequests)=>current()&&manager.auth.uid===scope.owner.uid&&manager.auth.token===scope.owner.token&&manager.auth.sessionVersion===scope.owner.version;
 function refreshPending(){if(!current()){pending.value=[];return;}try{pending.value=customerWorkUserPending().filter(row=>row.actor_uid===manager.auth.uid);}catch(failure){pending.value=[];error.value=failure instanceof Error?failure.message:'用户原操作记录需核对';}}
 function clear(){epoch++;for(const scope of scopes)scope.abort();scopes.clear();authority.value=null;busy.value=false;error.value='';pending.value=[];states.value={};}
 function clearDomain(){epoch++;for(const scope of scopes)scope.abort();scopes.clear();authority.value=null;busy.value=false;error.value='';if(!current()){pending.value=[];states.value={};}else refreshPending();}
 function create(fence?:()=>boolean){const version=epoch,scope=createCustomerWorkUserRequests(()=>current()&&epoch===version&&(!fence||fence()));scopes.add(scope);return scope;}
 function finish(scope:CustomerWorkUserRequests){scope.abort();scopes.delete(scope);}
 function known(intent:CustomerWorkUserIntent){if(!isCustomerWorkUserIntent(intent)||!owns(intent))throw Error('原用户操作不属于当前账号');const saved=customerWorkUserPending().find(row=>row.request_key===intent.request_key);if(!saved||customerWorkCanonicalJson(saved)!==customerWorkCanonicalJson(intent))throw Error('原用户操作内容已变化，请保留记录核对');}
 function state(intent:CustomerWorkUserIntent,errorMessage='',receipt:CustomerWorkUserReceipt|null=null){states.value={...states.value,[intent.request_key]:{receipt,unknown:receipt===null,error:errorMessage}};}
 function consume(response:unknown,intent:CustomerWorkUserIntent,scope:CustomerWorkUserRequests):CustomerWorkUserReceipt|null{
  if(!customerWorkRecord(response)||!Object.hasOwn(response,'receipt'))throw Error('原用户响应格式无效，请继续查询');
  if(response.receipt===null){if(!states.value[intent.request_key]?.receipt)state(intent);return null;}
  const receipt=parseCustomerWorkUserReceipt(response.receipt,intent);
  if(receipt.service_id===0||receipt.outcome==='rollback-rejected'){
   // The manager watcher clears every user/draft before this same ordinary owner receives minimal evidence.
   manager.invalidate(Error('用户管理依据已变化，请重新读取当前权限与用户'));
   if(sameOwner(scope)){refreshPending();state(intent,'',receipt);}return receipt;
  }
  state(intent,'',receipt);return receipt;
 }
 function failedWrite(scope:CustomerWorkUserRequests,intent:CustomerWorkUserIntent,failure:unknown){
  if(!sameOwner(scope))return;const message=failure instanceof Error?failure.message:'原用户结果未确认，请继续查询';
  if(failure instanceof RequestError&&(failure.httpStatus===403||[410000,410001,410002].includes(Number(failure.status))))manager.invalidate(Error('用户管理权限需重新读取'));
  if(sameOwner(scope)){refreshPending();state(intent,message);error.value=message;}
 }
 async function read<T extends CustomerWorkUserMeta>(path:string,guard:(value:unknown)=>value is T,data:Record<string,unknown>={}):Promise<CustomerWorkUserEnvelope<T>>{
  const principal=manager.context.value;if(!current()||!principal||principal.data.capabilities.user_management!==true)throw Error('当前账号没有用户管理权限');
  const scope=create(manager.fence());
  try{const response=parseCustomerWorkUserEnvelope(await scope.request(path,'GET',{...data,scope_key:principal.scope_key}),scope.owner.uid,guard,principal,authority.value?.consistency_key);
   if(!scope.active())throw Error('用户页面或账号已变化');authority.value=response;return response;
  }catch(failure){if(scope.active()){clearDomain();manager.invalidate(failure);}throw failure;}finally{finish(scope);}
 }
 function allowed(kind:CustomerWorkUserKind,users:CustomerWorkUser[],payload:Record<string,unknown>){
  return users.every(user=>user.actions[kind]?.available===true);
 }
 async function submit(kind:CustomerWorkUserKind,users:CustomerWorkUser[],meta:CustomerWorkUserMeta,payload:Record<string,unknown>):Promise<CustomerWorkUserReceipt|null>{
  if(busy.value||!current())return null;const principal=manager.context.value,domain=authority.value;
  if(!principal||principal.data.capabilities.user_management!==true||!domain||!domain.data.readiness.writes||meta.catalog_revision!==domain.data.catalog_revision||!allowed(kind,users,payload)){error.value='当前用户或操作不可提交，请重新读取';return null;}
  const body:CustomerWorkUserBody=JSON.parse(customerWorkCanonicalJson({version:'customer-work-user-operation-v1',scope_key:principal.scope_key,targets:users.map(user=>({uid:user.uid,expected_user_revision:user.user_revision})).sort((a,b)=>a.uid-b.uid),expected_catalog_revision:meta.catalog_revision,payload}));
  if(!isCustomerWorkUserBody(body,kind)){error.value='用户编辑内容无效，尚未提交';return null;}
  refreshPending();if(pending.value.some(intent=>intent.body.targets.some(target=>body.targets.some(row=>row.uid===target.uid)))){error.value='所选用户存在待确认原操作，请先查询并确认原结果';return null;}
  const scope=create(manager.fence());busy.value=true;error.value='';let intent:CustomerWorkUserIntent|null=null;
  try{
   const title=({replace_level:'确认修改等级',replace_group:'确认修改分组',replace_labels:'确认替换平台标签',grant_coupons:'确认赠送优惠券',adjust_membership:'确认调整会员时长',adjust_money:'确认调整余额',adjust_integral:'确认调整积分'} as const)[kind];
   if(!await confirm(title,`按当前核对的版本提交 ${body.targets.length} 个用户。`)||!scope.active())return null;
   const key=await customerWorkRequestKey();if(!scope.active())return null;
   intent=JSON.parse(customerWorkCanonicalJson({version:'customer-work-user-pending-v1',actor_uid:scope.owner.uid,service_id:principal.principal.service_id,scope_key:principal.scope_key,kind,request_key:key,request_hash:customerWorkUserIntentHash(scope.owner.uid,kind,body),body,endpoint:customerWorkUserEndpoint(kind,body.targets.map(row=>row.uid)),method:'POST',created_at:Math.floor(Date.now()/1000)}));
   retainCustomerWorkUserIntent(intent!);refreshPending();state(intent!);
   const response=await scope.request(intent!.endpoint,'POST',intent!.body as unknown as Record<string,unknown>,intent!.request_key);if(!scope.active())return null;
   if(!customerWorkRecord(response)||typeof response.replayed!=='boolean')throw Error('用户提交回执格式无效，请查询原结果');return consume(response,intent!,scope);
  }catch(failure){if(intent)failedWrite(scope,intent,failure);else if(scope.active())error.value=failure instanceof Error?failure.message:'用户意图尚未提交';return null;}
  finally{if(scope.active())busy.value=false;finish(scope);}
 }
 async function check(intent:CustomerWorkUserIntent){if(busy.value||!owns(intent))return;let scope:CustomerWorkUserRequests|undefined;try{known(intent);scope=create();busy.value=true;error.value='';const response=await scope.request(`/mobile/work/users/operations/${intent.request_key}`);if(scope.active())consume(response,intent,scope);}catch(failure){if(scope)failedWrite(scope,intent,failure);else error.value=failure instanceof Error?failure.message:'原用户结果需核对';}finally{if(scope?.active())busy.value=false;if(scope)finish(scope);}}
 function canRestore(intent:CustomerWorkUserIntent){return owns(intent)&&!busy.value&&!states.value[intent.request_key]?.receipt&&manager.context.value?.data.capabilities.user_management===true&&manager.context.value.principal.service_id===intent.service_id&&manager.context.value.scope_key===intent.scope_key&&authority.value?.data.readiness.writes===true;}
 async function restore(intent:CustomerWorkUserIntent){if(!canRestore(intent))return;const scope=create(manager.fence());busy.value=true;error.value='';try{known(intent);if(!await confirm('重发原用户意图','保持原编号与全部原内容，再核对同一次操作结果。')||!scope.active())return;const response=await scope.request(intent.endpoint,'POST',intent.body as unknown as Record<string,unknown>,intent.request_key);if(scope.active())consume(response,intent,scope);}catch(failure){failedWrite(scope,intent,failure);}finally{if(scope.active())busy.value=false;finish(scope);}}
 async function abandon(intent:CustomerWorkUserIntent){if(busy.value||!owns(intent)||states.value[intent.request_key]?.receipt)return;const scope=create();busy.value=true;error.value='';try{known(intent);if(!await confirm('放弃尚未执行的原意图','查询并阻止这一次尚未执行的请求，保留已确定的实际结果。')||!scope.active())return;const response=await scope.request(`/mobile/work/users/operations/${intent.request_key}/abandon`,'POST',{kind:intent.kind,input:intent.body},intent.request_key);if(scope.active())consume(response,intent,scope);}catch(failure){failedWrite(scope,intent,failure);}finally{if(scope.active())busy.value=false;finish(scope);}}
 async function acknowledge(intent:CustomerWorkUserIntent){if(busy.value||!owns(intent)||!states.value[intent.request_key]?.receipt)return;const scope=create();busy.value=true;try{known(intent);const receipt=states.value[intent.request_key]!.receipt!;if(!await confirm('确认原用户操作结果','已核对当前回执，关闭这条本机待确认记录。')||!scope.active()||customerWorkCanonicalJson(states.value[intent.request_key]?.receipt)!==customerWorkCanonicalJson(receipt))return;releaseCustomerWorkUserIntent(intent.request_key);const next={...states.value};delete next[intent.request_key];states.value=next;refreshPending();}catch(failure){if(scope.active())error.value=failure instanceof Error?failure.message:'原用户记录仍需确认';}finally{if(scope.active())busy.value=false;finish(scope);}}
 onShow(refreshPending);onHide(clear);onUnload(()=>{disposed=true;clear();});
 watch(()=>[manager.auth.uid,manager.auth.token,manager.auth.sessionVersion],()=>{clear();refreshPending();},{flush:'sync'});
 watch(()=>manager.context.value,(value,previous)=>{if(previous&&(!value||value.scope_key!==previous.scope_key||value.principal.service_id!==previous.principal.service_id))clearDomain();},{flush:'sync'});
 return{manager,authority,busy,error,pending,states,current,clear,read,submit,check,restore,abandon,acknowledge,canRestore};
}
