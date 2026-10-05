import { ref,watch,type Ref } from 'vue';
import { onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { createCustomerWorkOperationRequests,type CustomerWorkOperationRequests } from '@/api/customerWorkOperations';
import { parseCustomerWorkEnvelope,customerWorkRecord } from '@/utils/customerWork';
import { isCustomerWorkFulfillment,isCustomerWorkRemark,isCustomerWorkPendingIntent,isCustomerWorkWaybillJob,isCustomerWorkCityJob,customerWorkCanonicalJson,customerWorkIntentHash,customerWorkWriteEndpoint,customerWorkPendingIntents,retainCustomerWorkIntent,releaseCustomerWorkIntent,customerWorkRequestKey,parseCustomerWorkReceipt,customerWorkOperationLabel } from '@/utils/customerWorkFulfillment';
import type { CustomerWorkController } from './useCustomerWork';
import type { CustomerWorkEnvelope } from '@/types/customerWork';
import type { CustomerWorkFulfillment,CustomerWorkRemarkTarget,CustomerWorkOperationKind,CustomerWorkOperationReceipt,CustomerWorkOperationBody,CustomerWorkPendingIntent,CustomerWorkWaybillJob,CustomerWorkWaybillOperation,CustomerWorkCityJob } from '@/types/customerWorkFulfillment';
import { customerWorkInteger,customerWorkHash } from '@/utils/customerWorkFulfillment';
export interface CustomerWorkOperationState { receipt:CustomerWorkOperationReceipt|null;waybill?:CustomerWorkWaybillJob;city?:CustomerWorkCityJob;terminal?:boolean }
export interface CustomerWorkOperations {
  manager:CustomerWorkController;bootstrap:Ref<CustomerWorkEnvelope<CustomerWorkFulfillment>|null>;remark:Ref<CustomerWorkEnvelope<{remark_target:CustomerWorkRemarkTarget}>|null>;busy:Ref<boolean>;error:Ref<string>;pending:Ref<CustomerWorkPendingIntent[]>;states:Ref<Record<string,CustomerWorkOperationState>>;
  current:()=>boolean;clear:()=>void;load:(orderNo:string)=>Promise<void>;
  loadRemark:(orderNo:string)=>Promise<void>;
  read:<T>(path:string,guard:(data:unknown)=>data is T,query?:Record<string,unknown>)=>Promise<CustomerWorkEnvelope<T>>;
  submit:(kind:CustomerWorkOperationKind,payload:Record<string,unknown>,title?:string)=>Promise<CustomerWorkOperationReceipt|null>;
  check:(intent:CustomerWorkPendingIntent)=>Promise<void>;restore:(intent:CustomerWorkPendingIntent,abandon?:boolean)=>Promise<void>;acknowledge:(intent:CustomerWorkPendingIntent)=>void;
  canRestore:(intent:CustomerWorkPendingIntent)=>boolean;
  canRecoverCity:(intent:CustomerWorkPendingIntent)=>boolean;recoverCity:(intent:CustomerWorkPendingIntent)=>Promise<void>;
  refreshJob:(jobId:number)=>Promise<CustomerWorkEnvelope<{job:CustomerWorkWaybillJob;operation:CustomerWorkWaybillOperation}>>;
}
export function useCustomerWorkOperations(manager:CustomerWorkController):CustomerWorkOperations {
  const bootstrap=ref<CustomerWorkEnvelope<CustomerWorkFulfillment>|null>(null),remark=ref<CustomerWorkEnvelope<{remark_target:CustomerWorkRemarkTarget}>|null>(null),busy=ref(false),error=ref(''),pending=ref<CustomerWorkPendingIntent[]>([]),states=ref<Record<string,CustomerWorkOperationState>>({});
  const scopes=new Set<CustomerWorkOperationRequests>();let epoch=0,disposed=false;
  const jobAuthorities=new Map<number,CustomerWorkEnvelope<{job:CustomerWorkWaybillJob;operation:CustomerWorkWaybillOperation}>>();
  const current=()=>!disposed&&manager.current()&&manager.auth.isLoggedIn;
  function clear(){epoch++;for(const scope of scopes)scope.abort();scopes.clear();jobAuthorities.clear();bootstrap.value=null;remark.value=null;busy.value=false;error.value='';pending.value=[];states.value={};}
  function updatePending(){if(!current()){pending.value=[];return;}try{pending.value=customerWorkPendingIntents().filter(row=>row.actor_uid===manager.auth.uid);}catch(failure){pending.value=[];error.value=failure instanceof Error?failure.message:'原操作记录需核对';}}
  function newScope(){const version=epoch,scope=createCustomerWorkOperationRequests(()=>current()&&epoch===version);scopes.add(scope);return scope;}
  function close(scope:CustomerWorkOperationRequests){scope.abort();scopes.delete(scope);}
  function matches(authority:CustomerWorkEnvelope<unknown>){return current()&&manager.context.value?.actor_uid===authority.actor_uid&&manager.context.value?.scope_key===authority.scope_key&&manager.context.value?.principal.service_id===authority.principal.service_id;}
  function parse<T>(value:unknown,scope:CustomerWorkOperationRequests,guard:(data:unknown)=>data is T,authority=bootstrap.value){
    const response=parseCustomerWorkEnvelope(value,scope.owner.uid,guard);
    const expected=authority??manager.context.value;
    if(!scope.active()||!expected||response.scope_key!==expected.scope_key||response.principal.service_id!==expected.principal.service_id)throw Error('当前手机订单管理身份已变化');return response;
  }
  async function load(orderNo:string){
    updatePending();const authority=manager.context.value;if(!current()||!authority)throw Error('请重新读取当前手机订单身份');
    const scope=newScope();try{const response=parse(await scope.request(`/mobile/work/orders/${encodeURIComponent(orderNo)}/fulfillment`,'GET',{scope_key:authority.scope_key}),scope,isCustomerWorkFulfillment,null);
      if(!scope.active())return;if(response.data.requested_order_no!==orderNo)throw Error('发货业务编号响应不匹配');
      if(response.data.jobs?.some(job=>job.actor_id!==scope.owner.uid||job.service_id!==response.principal.service_id||job.root_order_id!==response.data.order.root_order_id))throw Error('电子面单任务不属于当前账号与订单');
      const jobs=parse(await scope.request('/mobile/work/fulfillment/waybills','GET',{scope_key:response.scope_key,order_id:response.data.order.id}),scope,(data):data is {list:CustomerWorkWaybillJob[];next_cursor:number|null}=>customerWorkRecord(data)&&Array.isArray(data.list)&&data.list.length<=100&&data.list.every(isCustomerWorkWaybillJob)&&(data.next_cursor===null||customerWorkInteger(data.next_cursor,1)),response);
      if(!scope.active())return;if(jobs.data.list.some(job=>job.actor_id!==scope.owner.uid||job.service_id!==response.principal.service_id||job.root_order_id!==response.data.order.root_order_id)||new Set(jobs.data.list.map(job=>job.id)).size!==jobs.data.list.length)throw Error('电子面单任务归属响应不匹配');
      bootstrap.value={...response,data:{...response.data,jobs:jobs.data.list}};error.value='';
    }catch(failure){if(scope.active()){bootstrap.value=null;throw failure;}}finally{close(scope);}
  }
  async function loadRemark(orderNo:string){
    updatePending();const scope=newScope();try{const response=parse(await scope.request(`/mobile/work/orders/${encodeURIComponent(orderNo)}/remark`,'GET',{scope_key:manager.context.value?.scope_key}),scope,isCustomerWorkRemark,null);if(!scope.active())return;if(response.data.remark_target.order_id!==orderNo)throw Error('原订单备注实体响应不匹配');remark.value=response;}catch(failure){if(scope.active()){remark.value=null;throw failure;}}finally{close(scope);}
  }
  async function read<T>(path:string,guard:(data:unknown)=>data is T,query:Record<string,unknown>={}):Promise<CustomerWorkEnvelope<T>>{
    const authority=bootstrap.value;if(!authority||!matches(authority))throw Error('发货依据已变化，请重新读取');const scope=newScope();
    try{return parse(await scope.request(path,'GET',{...query,scope_key:authority.scope_key}),scope,guard,authority);}catch(failure){const code=failure as {status?:unknown;httpStatus?:unknown};if(scope.active()&&(code.status===403||code.httpStatus===403))manager.invalidate(failure);throw failure;}finally{close(scope);}
  }
  function allowed(kind:CustomerWorkOperationKind,authority:CustomerWorkEnvelope<unknown>){
    if(!matches(authority))return false;
    if(kind==='remark')return isCustomerWorkRemark(authority.data)&&authority.data.remark_target.available;
    if(!isCustomerWorkFulfillment(authority.data)||!authority.data.readiness.operations.ready)return false;
    if(kind.startsWith('waybill_'))return true;
    const action=kind.startsWith('electronic')?'electronic_waybill':kind.startsWith('city')?'city_delivery':kind==='split_delivery'?'split_delivery':'manual_delivery';
    return authority.data.actions[action].available&&(!kind.includes('split')||authority.data.actions.split_delivery.available);
  }
  async function refreshJob(jobId:number){
    const response=await read(`/mobile/work/fulfillment/waybills/${jobId}`,(data):data is {job:CustomerWorkWaybillJob;operation:CustomerWorkWaybillOperation}=>customerWorkRecord(data)&&isCustomerWorkWaybillJob(data.job)&&customerWorkRecord(data.operation)&&customerWorkInteger(data.operation.order_id,1)&&customerWorkInteger(data.operation.root_order_id,1)&&customerWorkHash(data.operation.order_revision)&&customerWorkHash(data.operation.fulfillment_revision));
    const job=response.data.job,authority=bootstrap.value;if(!authority||job.id!==jobId||job.actor_id!==manager.auth.uid||job.service_id!==authority.principal.service_id||job.root_order_id!==authority.data.order.root_order_id||response.data.operation.root_order_id!==job.root_order_id)throw Error('原面单任务恢复依据不匹配');jobAuthorities.set(jobId,response);return response;
  }
  function body(authority:CustomerWorkEnvelope<unknown>,payload:Record<string,unknown>,basis:CustomerWorkWaybillOperation):CustomerWorkOperationBody{
    return JSON.parse(customerWorkCanonicalJson({version:'customer-work-operation-v1',scope_key:authority.scope_key,order_id:basis.order_id,expected_order_revision:basis.order_revision,expected_fulfillment_revision:basis.fulfillment_revision,payload}));
  }
  function ownIntent(intent:CustomerWorkPendingIntent){try{return current()&&intent.actor_uid===manager.auth.uid&&isCustomerWorkPendingIntent(intent)&&customerWorkPendingIntents().some(row=>customerWorkCanonicalJson(row)===customerWorkCanonicalJson(intent));}catch(failure){error.value=failure instanceof Error?failure.message:'原操作记录需核对';return false;}}
  function consume(value:unknown,intent:CustomerWorkPendingIntent){const receipt=parseCustomerWorkReceipt(value,intent);
    if(receipt?.outcome==='rollback-rejected'){manager.invalidate(Error('原操作已确认未执行，请重新读取当前订单依据'));updatePending();}
    states.value={...states.value,[intent.request_key]:{receipt}};
    if(receipt&&['remark-saved','delivery-recorded','job-updated'].includes(receipt.outcome)){releaseCustomerWorkIntent(intent.request_key);updatePending();}
    return receipt;
  }
  function receiptMessage(receipt:CustomerWorkOperationReceipt|null){return !receipt?'原操作尚无确定回执，请继续使用原编号查询。':receipt.outcome==='provider-admitted'?'渠道任务已受理，尚未确认最终履约结果。':receipt.outcome==='remark-saved'?'备注已保存，请刷新订单核对。':receipt.outcome==='delivery-recorded'?'发货已记录，请刷新订单核对。':receipt.outcome==='job-updated'?'任务恢复决定已记录，请查询原任务最新状态。':'原操作已确认未执行，请确认关闭原记录后重新核对。';}
  async function confirm(title:string,content:string){return new Promise<boolean>(resolve=>uni.showModal({title,content,success:answer=>resolve(answer.confirm),fail:()=>resolve(false)}));}
  async function submit(kind:CustomerWorkOperationKind,payload:Record<string,unknown>,title='核对订单操作'){
    const authority=kind==='remark'?remark.value:bootstrap.value,fulfillment=bootstrap.value?.data,target=kind==='remark'?remark.value?.data.remark_target:fulfillment?.order;
    if(!authority||!target||busy.value||!allowed(kind,authority))throw Error('当前订单操作不可用，请重新读取');
    const rootId=fulfillment?.order.root_order_id??target.id,orderNo=kind==='remark'?target.order_id:fulfillment!.requested_order_no;
    const sameAuthority=()=>kind==='remark'?remark.value===authority:bootstrap.value===authority;
    updatePending();if(!kind.startsWith('waybill_')&&pending.value.some(row=>row.root_order_id===rootId))throw Error('此订单存在待确认原操作，请先查询并确认原结果');
    if(kind.startsWith('waybill_')&&pending.value.some(row=>row.kind.startsWith('waybill_')&&row.body.payload.job_id===payload.job_id))throw Error('此任务存在待确认恢复决定，请先查询原决定结果');
    const jobAuthority=kind.startsWith('waybill_')?jobAuthorities.get(payload.job_id as number):undefined;
    if(kind.startsWith('waybill_')){
      const job=jobAuthority?.data.job;
      if(!job||job.actor_id!==manager.auth.uid||job.service_id!==authority.principal.service_id||!['UNKNOWN','DEAD'].includes(job.status))throw Error('原面单任务状态已变化');
      if(payload.expected_job_revision!==job.job_revision||jobAuthority?.scope_key!==authority.scope_key)throw Error('原面单任务版本已变化');
      if((kind==='waybill_apply_existing'||kind==='waybill_confirm_issued')&&job.status!=='UNKNOWN'||kind==='waybill_apply_existing'&&!job.tracking_number||kind==='waybill_confirm_retry'&&(!!job.tracking_number||job.replay_count>=20))throw Error('当前任务不能进行此恢复操作');
    }
    const basis=jobAuthority?.data.operation??{order_id:target.id,root_order_id:rootId,order_revision:target.order_revision,fulfillment_revision:target.fulfillment_revision};
    const wire=body(authority,payload,basis),route=customerWorkWriteEndpoint(kind,wire.order_id,wire.payload.job_id as number|undefined),scope=newScope(),version=epoch;let intent:CustomerWorkPendingIntent|undefined;busy.value=true;error.value='';
    try{
      const answer=await confirm(title,`订单 ${target.order_id} · ${customerWorkOperationLabel(kind)}。请核对本次内容后提交。`);
      if(!answer||!scope.active()||!sameAuthority()||!allowed(kind,authority))return null;
      const key=await customerWorkRequestKey();if(!scope.active()||!sameAuthority()||!allowed(kind,authority))return null;
      intent=JSON.parse(customerWorkCanonicalJson({version:'customer-work-pending-v1',request_key:key,request_hash:customerWorkIntentHash(scope.owner.uid,kind,wire),actor_uid:scope.owner.uid,service_id:authority.principal.service_id,scope_key:authority.scope_key,order_no:orderNo,root_order_id:rootId,kind,body:wire,endpoint:route.endpoint,method:route.method,created_at:Math.floor(Date.now()/1000)}));
      retainCustomerWorkIntent(intent!);updatePending();
      const response=await scope.request(route.endpoint,route.method,wire,key);if(!scope.active())return null;
      const receipt=consume(response,intent!);error.value=receiptMessage(receipt);return receipt;
    }catch(failure){if(scope.active()){error.value=intent?'原操作结果未确认，请查询原操作，暂勿再次提交。':failure instanceof Error?failure.message:'尚未提交';const code=failure as {httpStatus?:unknown;status?:unknown};if(code.httpStatus===403||code.status===403){manager.invalidate(failure);updatePending();}}throw failure;}
    finally{close(scope);if(current()&&epoch===version)busy.value=false;}
  }
  async function check(intent:CustomerWorkPendingIntent){
    if(busy.value||!ownIntent(intent))return;const scope=newScope(),version=epoch;busy.value=true;error.value='';
    try{const response=await scope.request(`/mobile/work/operations/${intent.request_key}`);if(!scope.active())return;const receipt=consume(response,intent);error.value=receiptMessage(receipt);
      if(!receipt||receipt.outcome!=='provider-admitted')return;
      if(intent.kind.startsWith('city'))cityResult(response,intent,receipt);
      if(intent.kind.startsWith('electronic')&&bootstrap.value&&matches(bootstrap.value)&&bootstrap.value.scope_key===intent.scope_key&&bootstrap.value.principal.service_id===intent.service_id){
        const id=receipt.evidence.waybill_job_id as number,result=parse(await scope.request(`/mobile/work/fulfillment/waybills/${id}`,'GET',{scope_key:intent.scope_key}),scope,(data):data is {job:CustomerWorkWaybillJob}=>customerWorkRecord(data)&&isCustomerWorkWaybillJob(data.job));
        const job=result.data.job;if(job.id!==id||job.request_key!==intent.request_key||job.request_hash!==receipt.evidence.waybill_request_hash||job.actor_id!==intent.actor_uid||job.service_id!==intent.service_id||job.root_order_id!==intent.root_order_id||job.order_id!==intent.body.order_id)throw Error('电子面单原任务身份或内容不匹配');
        states.value={...states.value,[intent.request_key]:{receipt,waybill:job,terminal:job.status==='CLOSED'}};
        error.value=job.status==='SENT'?'电子面单发货已确认，单号 '+job.tracking_number:job.status==='UNKNOWN'?'面单签发结果未知，请核对原任务后选择明确的恢复动作。':job.status==='CLOSED'?'原面单任务已明确关闭。':job.status==='DEAD'?'原面单任务失败，需要明确恢复决定。':'面单任务处理中，尚未确认发货。';
        if(job.status==='SENT'){releaseCustomerWorkIntent(intent.request_key);updatePending();}
      }
    }catch(failure){if(scope.active()){const code=failure as {status?:unknown;httpStatus?:unknown};if(code.status===403||code.httpStatus===403)manager.invalidate(failure);else error.value=failure instanceof Error?failure.message:'原操作暂未确认';}}
    finally{close(scope);if(current()&&epoch===version)busy.value=false;}
  }
  function cityResult(response:unknown,intent:CustomerWorkPendingIntent,receipt:CustomerWorkOperationReceipt){
    if(!customerWorkRecord(response)||response.city_job===undefined||response.city_job===null)return;
    const job=response.city_job;if(!isCustomerWorkCityJob(job)||job.request_key!==intent.request_key||job.job_id!==receipt.evidence.city_job_id||job.provider!==receipt.evidence.provider)throw Error('同城原任务状态响应不匹配');
    states.value={...states.value,[intent.request_key]:{receipt,city:job,terminal:['REJECTED','REVOKED','CANCELLED'].includes(job.status)}};
    error.value=job.status==='DELIVERED'?'同城配送已确认送达。':job.status==='ADMITTED'?'同城渠道已受理，等待配送结果。':['UNKNOWN','REJECTED','REVOKED','CANCELLED'].includes(job.status)?'原同城任务需核对，不能创建第二次配送。':'同城任务处理中，请查询原结果。';
    if(job.status==='DELIVERED'){releaseCustomerWorkIntent(intent.request_key);updatePending();}
  }
  function canRecoverCity(intent:CustomerWorkPendingIntent){const authority=bootstrap.value,state=states.value[intent.request_key];return !!authority&&matches(authority)&&intent.kind.startsWith('city')&&intent.service_id===authority.principal.service_id&&intent.scope_key===authority.scope_key&&state?.receipt?.outcome==='provider-admitted'&&state.city?.status==='UNKNOWN';}
  async function recoverCity(intent:CustomerWorkPendingIntent){
    if(busy.value||!ownIntent(intent)||!canRecoverCity(intent))return;const scope=newScope(),version=epoch;busy.value=true;
    try{const answer=await confirm('核对原同城任务','按原请求查询渠道真实结果，不创建第二次配送。');if(!answer||!scope.active()||!canRecoverCity(intent))return;const id=states.value[intent.request_key]!.city!.job_id,response=await scope.request(`/mobile/work/operations/city-jobs/${id}/recover`,'POST',{request_key:intent.request_key},intent.request_key);if(!scope.active())return;const receipt=consume(response,intent);if(receipt?.outcome!=='provider-admitted')throw Error('原同城受理回执不匹配');cityResult(response,intent,receipt);
    }catch(failure){if(scope.active()){const code=failure as {status?:unknown;httpStatus?:unknown};if(code.status===403||code.httpStatus===403)manager.invalidate(failure);else error.value=failure instanceof Error?failure.message:'原同城任务仍需核对';}}finally{close(scope);if(current()&&epoch===version)busy.value=false;}
  }
  function canRestore(intent:CustomerWorkPendingIntent){const authority=intent.kind==='remark'?remark.value:bootstrap.value,basis=intent.kind==='remark'?remark.value?.data.remark_target:intent.kind.startsWith('waybill_')?jobAuthorities.get(intent.body.payload.job_id as number)?.data.operation:bootstrap.value?.data.order;const id=basis&&('id' in basis?basis.id:basis.order_id);return !!authority&&!!basis&&matches(authority)&&intent.actor_uid===manager.auth.uid&&authority.principal.service_id===intent.service_id&&authority.scope_key===intent.scope_key&&id===intent.body.order_id&&basis.order_revision===intent.body.expected_order_revision&&basis.fulfillment_revision===intent.body.expected_fulfillment_revision&&allowed(intent.kind,authority)&&!states.value[intent.request_key]?.receipt;}
  async function restore(intent:CustomerWorkPendingIntent,abandon=false){
    if(busy.value||!ownIntent(intent))return;if(!abandon&&!canRestore(intent)){error.value='当前身份、订单或配置与原操作不同，只能继续查询原结果。';return;}
    if(states.value[intent.request_key]?.receipt?.outcome==='provider-admitted'){error.value='原渠道任务已经受理，请查询任务结果并核对恢复动作。';return;}
    const scope=newScope(),version=epoch;busy.value=true;error.value='';
    try{const answer=await confirm(abandon?'核对并放弃原操作':'恢复原操作',abandon?'使用原编号和原内容核对。如已受理，保留原结果且不会取消渠道任务。':'使用相同原编号和相同内容恢复，仍须当前身份与依据有效。');
      if(!answer||!scope.active()||!ownIntent(intent)||!abandon&&!canRestore(intent))return;
      const response=await scope.request(abandon?`/mobile/work/operations/${intent.request_key}/abandon`:intent.endpoint,abandon?'POST':intent.method,abandon?{kind:intent.kind,input:intent.body}:intent.body,intent.request_key);if(!scope.active())return;error.value=receiptMessage(consume(response,intent));
    }catch(failure){if(scope.active())error.value=failure instanceof Error?failure.message:'原操作仍需核对';}finally{close(scope);if(current()&&epoch===version)busy.value=false;}
  }
  function acknowledge(intent:CustomerWorkPendingIntent){if(busy.value||!ownIntent(intent))return;const state=states.value[intent.request_key];if(!state?.terminal&&!['abandoned','rollback-rejected'].includes(state?.receipt?.outcome??''))return;releaseCustomerWorkIntent(intent.request_key);updatePending();error.value='已确认关闭原记录，请重新读取当前订单后继续。';}
  onShow(()=>updatePending());onHide(clear);onUnload(()=>{disposed=true;clear();});
  watch(()=>[manager.auth.uid,manager.auth.token,manager.auth.sessionVersion],()=>{clear();updatePending();},{flush:'sync'});
  watch(()=>manager.context.value,(value,previous)=>{if(previous&&(!value||value.scope_key!==previous.scope_key||value.principal.service_id!==previous.principal.service_id)){clear();updatePending();}},{flush:'sync'});
  return {manager,bootstrap,remark,busy,error,pending,states,current,clear,load,loadRemark,read,submit,check,restore,acknowledge,canRestore,refreshJob,canRecoverCity,recoverCity};
}
