import { computed,ref,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createMerchantRequests,type MerchantRequests } from '@/api/merchantOrders';
import { parseMerchantEnvelope,isMerchantContext,merchantDiagnostic,merchantRequestKey,merchantPendingIntents,retainMerchantIntent,releaseMerchantIntent } from '@/utils/merchantOrders';
import type { MerchantManagementEnvelope,MerchantManagementContext,MerchantPendingIntent,MerchantOperationPlan } from '@/types/merchantOrders';
import { merchantCanonicalJson,merchantIntentHash } from '@/utils/merchantIntentHash';

export interface MerchantControllerOptions {load?:(controller:MerchantController)=>Promise<void>;clear?:()=>void;query?:(query:Record<string,string|undefined>)=>void}
export type MerchantController=ReturnType<typeof useMerchantOrders>;
/** Every page reload first reauthorizes its selected store. No old PII is replayed. */
export function useMerchantOrders(options:MerchantControllerOptions={}){
  const auth=useAuthStore(),context=ref<MerchantManagementEnvelope<MerchantManagementContext>|null>(null),selectedStore=ref<number|null>(null),loading=ref(false),error=ref(''),diagnostic=ref(''),operationError=ref(''),busy=ref(false),pending=ref<MerchantPendingIntent[]>([]),rejected=ref<string[]>([]);
  let visible=false,disposed=false,epoch=0,requests:MerchantRequests|null=null,consistencyKey:string|null=null;
  const recoveryRequests=new Set<MerchantRequests>();
  const current=()=>visible&&!disposed;
  const fence=()=>{const scope=requests;return ()=>!!scope?.active();};
  function updatePending(){pending.value=merchantPendingIntents().filter(intent=>intent.actor_uid===auth.uid);}
  function clear(){epoch++;requests?.abort();requests=null;for(const recovery of recoveryRequests)recovery.abort();recoveryRequests.clear();context.value=null;loading.value=false;error.value='';diagnostic.value='';operationError.value='';busy.value=false;rejected.value=[];consistencyKey=null;options.clear?.();updatePending();}
  async function read<T>(path:string,guard:(data:unknown)=>data is T,data:Record<string,unknown>={}):Promise<MerchantManagementEnvelope<T>>{
    const scope=requests,store=selectedStore.value,authority=context.value;
    if(!scope?.active()||!store||!authority)throw Error('请先选择当前可管理的门店');
    const result=parseMerchantEnvelope(await scope.request(`/store/manager/order/${path}`,'GET',{...data,store_id:store}),scope.owner.uid,store,guard,authority.scope_key);
    if(!scope.active())throw Error('门店或账号已变化');
    if(consistencyKey&&result.consistency_key!==consistencyKey)throw Error('门店数据或权限已变化，请重新读取');
    consistencyKey=result.consistency_key;diagnostic.value=merchantDiagnostic([...authority.issues,...result.issues]);return result;
  }
  async function load(){
    if(!current())return;clear();if(!auth.isLoggedIn){error.value='请登录后查看商家管理';return;}loading.value=true;const version=epoch;
    const scope=createMerchantRequests(()=>current()&&epoch===version);requests=scope;
    try{
      const response=parseMerchantEnvelope(await scope.request('/store/manager/context','GET',selectedStore.value?{store_id:selectedStore.value}:{}),scope.owner.uid,null,isMerchantContext);
      if(!scope.active())return;
      if(response.store_id!==response.data.selected_store_id)throw Error('门店选择响应无效');
      context.value=response;selectedStore.value=response.data.selected_store_id;diagnostic.value=merchantDiagnostic(response.issues);consistencyKey=response.consistency_key;
      if(selectedStore.value)await options.load?.(controller);
    }catch(failure){if(scope.active()){context.value=null;options.clear?.();error.value=failure instanceof Error?failure.message:'商家管理暂不可用，请重新读取';}}
    finally{if(scope.active())loading.value=false;}
  }
  function chooseStore(event:{detail:{value:string|number}}){const store=context.value?.data.stores[Number(event.detail.value)];if(!store||store.store_id===selectedStore.value)return;selectedStore.value=store.store_id;void load();}
  function go(page:'statistics'|'orders'|'orderDetail'|'delivery'|'refund'|'logistics',query:Record<string,string|number>={}){
    if(!current()||!context.value||!selectedStore.value)return;const parts=Object.entries({...query,store_id:selectedStore.value}).map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);uni.navigateTo({url:`/pages/merchant/${page}?${parts.join('&')}`});
  }
  function back(){if(!current())return;uni.navigateBack({fail:()=>uni.switchTab({url:'/pages/user/index'})});}
  function login(){if(current())uni.navigateTo({url:'/pages/auth/login'});}
  const storeName=computed(()=>context.value?.data.stores.find(store=>store.store_id===selectedStore.value)?.name||'请选择门店');
  const unresolved=computed(()=>pending.value);
  function validateReceipt(value:unknown,intent:MerchantPendingIntent):{outcome:string;kind:string;[key:string]:unknown}|null{
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('操作凭据响应无效，原操作仍待确认');
    let row=value as Record<string,unknown>;if(row.receipt===null)return null;if(row.receipt&&typeof row.receipt==='object'&&!Array.isArray(row.receipt))row=row.receipt as Record<string,unknown>;
    const outcomes:Record<string,string[]>={remark:['remark-saved'],manual_delivery:['delivery-recorded'],split_delivery:['delivery-recorded'],change_price:['price-changed'],confirm_offline:['offline-paid'],refund_create:['application-created'],return_approve:['return-approved'],refund_refuse:['refused'],refund_execute:['balance-settled','provider-admitted']};
    if(row.version!=='merchant-order-operation-v1'||row.request_key!==intent.request_key||row.actor_uid!==intent.actor_uid||row.store_id!==intent.store_id||row.kind!==intent.action||typeof row.request_hash!=='string'||!/^[a-f0-9]{64}$/u.test(row.request_hash)||(intent.request_hash&&row.request_hash!==intent.request_hash)||!Number.isSafeInteger(row.order_id)||Number(row.order_id)<1||(intent.body&&row.order_id!==intent.body.order_id)||!Number.isSafeInteger(row.staff_id)||Number(row.staff_id)<0||!row.evidence||typeof row.evidence!=='object'||Array.isArray(row.evidence)||typeof row.outcome!=='string'||!['abandoned','rollback-rejected',...(outcomes[intent.action]||[])].includes(row.outcome))throw Error('原操作凭据不匹配，不能重新提交');
    if(row.outcome==='application-created'){const evidence=row.evidence as Record<string,unknown>;if(!Number.isSafeInteger(evidence.refund_id)||Number(evidence.refund_id)<1||typeof evidence.refund_order_id!=='string'||!/^[-A-Za-z0-9_]{1,100}$/u.test(evidence.refund_order_id))throw Error('申请凭据缺少有效申请编号，原操作仍待确认');}
    return row as {outcome:string;kind:string;[key:string]:unknown};
  }
  function consumeReceipt(value:unknown,intent:MerchantPendingIntent,statusProof=false){const receipt=validateReceipt(value,intent);if(!receipt)return false;
    if(['abandoned','rollback-rejected'].includes(receipt.outcome)){if(!rejected.value.includes(intent.request_key))rejected.value.push(intent.request_key);return receipt;}
    if(receipt.outcome==='provider-admitted'){
      const status=value as {execution?:{completed?:unknown;status?:unknown;refund_id?:unknown}};const execution=status.execution;
      if(statusProof&&(!execution||typeof execution.completed!=='boolean'||typeof execution.status!=='string'||!['SUCCESS','PROCESSING','CLOSED','ABNORMAL','FAILED','UNKNOWN','NOT_FOUND'].includes(execution.status)||!Number.isSafeInteger(execution.refund_id)||Number(execution.refund_id)<1||execution.refund_id!==(intent.body?.payload as {refund_id?:unknown}|undefined)?.refund_id||execution.completed&&execution.status!=='SUCCESS'))throw Error('资金核对响应无效，原操作仍需核对');
      if(statusProof&&execution?.completed===true&&execution.status==='SUCCESS'){releaseMerchantIntent(intent.request_key);updatePending();return {...receipt,funds_confirmed:true};}
      retainMerchantIntent({...intent,funds_pending:true});updatePending();return receipt;
    }
    if(['remark-saved','delivery-recorded','price-changed','offline-paid','application-created','return-approved','refused','balance-settled'].includes(receipt.outcome)){releaseMerchantIntent(intent.request_key);updatePending();return receipt;}return false;
  }
  async function checkIntent(intent:MerchantPendingIntent){
    if(!current()||intent.actor_uid!==auth.uid||busy.value)return;busy.value=true;operationError.value='';const version=epoch,scope=createMerchantRequests(()=>current()&&epoch===version);recoveryRequests.add(scope);
    try{const funds=intent.action==='refund_execute',response=await scope.request(funds?`/store/manager/order/operation/${intent.request_key}/status`:intent.receipt_path,funds?'GET':intent.receipt_method,funds||intent.receipt_method==='GET'?{}:{version:'merchant-order-operation-v1'},!funds&&intent.receipt_method==='POST'?intent.request_key:undefined);if(!scope.active())return;
      if(funds&&(!response||typeof response!=='object'||(response as {version?:unknown}).version!=='merchant-order-operation-v1'))throw Error('资金核对响应无效，原操作仍需核对');
      const receipt=consumeReceipt(response,intent,funds);if(!receipt){operationError.value='原操作尚无最终结果，请稍后再次查询。不要重复提交。';return;}operationError.value=receipt.funds_confirmed===true?'退款资金已确认完成。可以返回列表核对实际履约订单。':receipt.outcome==='provider-admitted'?'渠道已受理退款，资金结果尚未确认，请重新读取退款状态。':receipt.outcome==='application-created'?'退款申请已创建，资金尚未退回，请重新读取并处理申请。':['abandoned','rollback-rejected'].includes(receipt.outcome)?'原操作已确认未执行。请刷新后重新核对。':'原操作已确认完成。请刷新当前数据。';
    }catch(failure){if(scope.active())operationError.value=failure instanceof Error?failure.message:'原操作暂未确认，请继续查询';}finally{scope.abort();recoveryRequests.delete(scope);if(current()&&epoch===version)busy.value=false;}
  }
  async function execute(plan:MerchantOperationPlan){
    const scope=requests,store=selectedStore.value,authority=context.value;
    if(!scope?.active()||!store||!authority||busy.value)throw Error('门店状态已变化，请重新读取');
    const capability=plan.action==='return_approve'||plan.action==='refund_refuse'||plan.action==='refund_execute'?'refund_decide':plan.action;
    if(!Object.hasOwn(authority.data.capabilities,capability)||!authority.data.capabilities[capability as keyof typeof authority.data.capabilities])throw Error('当前门店操作暂未开放，请重新读取权限');
    if(plan.body.version!=='merchant-order-operation-v1'||plan.body.store_id!==store||plan.body.scope_key!==authority.scope_key||!Number.isSafeInteger(plan.body.order_id)||Number(plan.body.order_id)<1||typeof plan.body.expected_order_revision!=='string'||!/^[a-f0-9]{64}$/u.test(plan.body.expected_order_revision))throw Error('操作与当前门店依据不匹配，尚未提交');
    if(unresolved.value.some(intent=>intent.store_id===store&&intent.order_id===plan.order_id))throw Error('该订单已有待确认操作，请先查询原操作结果');
    busy.value=true;operationError.value='';let intent:MerchantPendingIntent|undefined;
    try{
      const key=await merchantRequestKey();if(!scope.active())throw Error('门店或账号已变化，尚未提交');
      const body=JSON.parse(merchantCanonicalJson(plan.body)) as Record<string,unknown>;
      intent={request_key:key,actor_uid:scope.owner.uid,store_id:store,scope_key:authority.scope_key,action:plan.action,order_id:plan.order_id,receipt_path:plan.receipt_path.replace('{requestKey}',key),receipt_method:plan.receipt_method||'GET',created_at:Math.floor(Date.now()/1000),body,endpoint:plan.endpoint,method:plan.method||'POST',abandon_path:plan.abandon_path,request_hash:merchantIntentHash(scope.owner.uid,plan.action,body)};retainMerchantIntent(intent);updatePending();
      const response=await scope.request(plan.endpoint,plan.method||'POST',body,key);if(!scope.active())return null;
      const receipt=consumeReceipt(response,intent);if(!receipt)throw Error('提交结果待确认，请查询原操作结果。不要重复提交。');return receipt;
    }catch(failure){if(scope.active())operationError.value=intent?'原操作结果未确认。请查询原操作结果，不要再次提交。':failure instanceof Error?failure.message:'尚未提交';throw failure;}
    finally{if(scope.active())busy.value=false;}
  }
  function acknowledge(intent:MerchantPendingIntent){if(intent.actor_uid!==auth.uid||!current()||!rejected.value.includes(intent.request_key))return;releaseMerchantIntent(intent.request_key);rejected.value=rejected.value.filter(key=>key!==intent.request_key);updatePending();operationError.value='已确认原操作未执行。请刷新并核对当前订单后继续。';}
  async function restoreIntent(intent:MerchantPendingIntent,abandon=false){
    if(intent.funds_pending){operationError.value='渠道已受理的原退款只能查询资金状态，请继续使用原操作编号核对。';return;}
    if(!current()||intent.actor_uid!==auth.uid||busy.value||!intent.body||!intent.request_hash||!intent.endpoint||rejected.value.includes(intent.request_key))return;
    if(!abandon&&(!context.value||context.value.scope_key!==intent.scope_key||selectedStore.value!==intent.store_id)){operationError.value='当前门店权限与原操作不同，不能恢复提交。可以查询原操作结果。';return;}
    if(merchantIntentHash(intent.actor_uid,intent.action,intent.body)!==intent.request_hash){operationError.value='原操作内容不匹配，只能查询原凭据。';return;}
    if(abandon&&!intent.abandon_path){operationError.value='该原操作只能查询结果，当前没有放弃合同。';return;}
    const version=epoch,scope=createMerchantRequests(()=>current()&&epoch===version);recoveryRequests.add(scope);busy.value=true;
    try{const answer=await new Promise<boolean>(resolve=>uni.showModal({title:abandon?'核对并放弃原操作':'恢复原操作',content:abandon?'将使用原操作编号和原内容核对。如已执行，仍返回原结果。':'使用同一操作编号和同一内容恢复。不会创建第二次操作。',success:result=>resolve(result.confirm),fail:()=>resolve(false)}));if(!answer||!scope.active())return;
      const body=abandon&&intent.abandon_path?.endsWith('/financial/abandon')?{kind:intent.action,input:intent.body}:intent.body;
      const response=await scope.request(abandon?intent.abandon_path!:intent.endpoint,intent.method||'POST',body,intent.request_key);if(!scope.active())return;
      const receipt=consumeReceipt(response,intent);operationError.value=receipt?['abandoned','rollback-rejected'].includes(receipt.outcome)?'原操作已确认未执行，请确认关闭原记录。':receipt.outcome==='provider-admitted'?'渠道已受理，资金结果尚未确认，请重新读取退款状态。':'原操作已确认，请刷新当前数据。':'原操作仍待确认，请继续查询，不要再次提交。';
    }catch(failure){if(scope.active())operationError.value=failure instanceof Error?failure.message:'原操作仍待确认';}finally{scope.abort();recoveryRequests.delete(scope);if(current()&&epoch===version)busy.value=false;}
  }
  async function financialRead<T>(path:string,guard:(value:unknown)=>value is T,body:Record<string,unknown>):Promise<T>{const scope=requests,store=selectedStore.value,authority=context.value;if(!scope?.active()||!store||!authority)throw Error('门店权限已变化');const response=await scope.request(`/store/manager/order/financial/${path}`,'POST',body);if(!scope.active()||selectedStore.value!==store||context.value?.scope_key!==authority.scope_key)throw Error('门店或账号已变化');if(!guard(response))throw Error('财务核对响应无效，请重新读取');return response;}
  const controller={auth,context,selectedStore,loading,error,diagnostic,operationError,busy,pending,unresolved,rejected,storeName,current,fence,read,financialRead,load,chooseStore,go,back,login,execute,checkIntent,acknowledge,restoreIntent};
  onLoad(query=>{const candidate=Number(query?.store_id);if(Number.isSafeInteger(candidate)&&candidate>0)selectedStore.value=candidate;options.query?.(query||{});});
  onShow(()=>{visible=true;void load();});onHide(()=>{visible=false;clear();});onUnload(()=>{disposed=true;visible=false;clear();});
  watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{selectedStore.value=null;clear();if(current())void load();},{flush:'sync'});
  return controller;
}
