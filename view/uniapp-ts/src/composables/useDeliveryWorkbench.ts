import { computed,ref,shallowRef,watch } from 'vue';
import { onLoad,onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { useAuthStore } from '@/stores/auth';
import { createDeliveryRequests,type DeliveryRequests } from '@/api/deliveryWorkbench';
import { merchantRequestKey } from '@/utils/merchantOrders';
import { merchantCanonicalJson } from '@/utils/merchantIntentHash';
import { parseDeliveryEnvelope,isDeliveryContext,deliverySameScope,deliverySelectionQuery,deliveryDiagnostic,isDeliverySelection,isDeliveryInput,deliveryIntentHash,deliveryPendingIntents,retainDeliveryIntent,releaseDeliveryIntent,parseDeliveryReceipt,deliveryRecord } from '@/utils/deliveryWorkbench';
import type {DeliveryWorkbenchEnvelope,DeliveryWorkbenchContext,DeliveryContextSelection,DeliveryPendingIntent,DeliveryOperationInput,DeliveryAvailability} from '@/types/deliveryWorkbench';

export interface DeliveryControllerOptions {load?:(controller:DeliveryController)=>Promise<void>;clear?:()=>void;query?:(query:Record<string,string|undefined>)=>void}
export type DeliveryController=ReturnType<typeof useDeliveryWorkbench>;
export function useDeliveryWorkbench(options:DeliveryControllerOptions={}){
  const auth=useAuthStore(),context=ref<DeliveryWorkbenchEnvelope<DeliveryWorkbenchContext>|null>(null),selected=ref<DeliveryContextSelection|null>(null),loading=ref(false),error=ref(''),diagnostic=ref(''),operationError=ref(''),busy=ref(false),pending=shallowRef<DeliveryPendingIntent[]>([]),rejected=ref<string[]>([]);
  let visible=false,disposed=false,epoch=0,requests:DeliveryRequests|null=null,consistencyKey:string|null=null;
  const recoveries=new Set<DeliveryRequests>(),current=()=>visible&&!disposed;
  const fence=()=>{const scope=requests;return ()=>!!scope?.active();};
  function updatePending(){try{pending.value=deliveryPendingIntents().filter(row=>row.actor_uid===auth.uid);}catch(failure){pending.value=[];operationError.value=failure instanceof Error?failure.message:'原操作记录暂不可读，请勿重复提交';}}
  function clear(){epoch++;requests?.abort();requests=null;for(const scope of recoveries)scope.abort();recoveries.clear();context.value=null;loading.value=false;error.value='';diagnostic.value='';operationError.value='';busy.value=false;rejected.value=[];consistencyKey=null;options.clear?.();updatePending();}
  function scopeQuery(){const authority=context.value,selection=selected.value;if(!authority||!selection||!deliverySameScope(authority.scope,selection))throw Error('请先选择当前配送身份');return {...deliverySelectionQuery(selection),scope_key:authority.scope_key};}
  async function read<T>(path:string,guard:(value:unknown)=>value is T,data:Record<string,unknown>={},method:'GET'|'POST'='GET'){
    const scope=requests,authority=context.value,selection=selected.value;
    if(!scope?.active()||!authority||!selection)throw Error('配送身份已变化，请重新读取');
    try{const response=parseDeliveryEnvelope(await scope.request(`/delivery/workbench/${path}`,method,{...data,...scopeQuery()}),scope.owner.uid,guard,selection,authority.scope_key);
      if(!scope.active())throw Error('账号或配送身份已变化');
      if(consistencyKey!==response.consistency_key)throw Error('配送订单或权限已变化，请刷新后核对');
      if(path==='orders'||/^orders\/\d+$/u.test(path)||path==='writeoff/info'){const data=response.data as unknown,rows=deliveryRecord(data)&&Array.isArray(data.list)?data.list:[data];if(rows.some(row=>!deliveryRecord(row)||(selection.kind==='store'&&row.store_id!==selection.store_id)||(path!=='writeoff/info'&&row.delivery_uid!==scope.owner.uid)))throw Error('订单不属于当前配送范围，请重新读取');}
      diagnostic.value=deliveryDiagnostic([...authority.issues,...response.issues]);return response;
    }catch(failure){if(scope.active()){options.clear?.();context.value=null;loading.value=false;consistencyKey=null;error.value=failure instanceof Error?failure.message:'配送读取失败，请重新核对';scope.abort();}throw failure;}
  }
  async function load(){if(!current())return;clear();if(!auth.isLoggedIn){error.value='请登录后查看配送工作台';return;}loading.value=true;const version=epoch,scope=createDeliveryRequests(()=>current()&&epoch===version);requests=scope;
    try{const response=parseDeliveryEnvelope(await scope.request('/delivery/workbench/context','GET',selected.value?deliverySelectionQuery(selected.value):{}),scope.owner.uid,isDeliveryContext);if(!scope.active())return;if(!deliverySameScope(response.scope,response.data.selected)||!deliverySameScope(selected.value,response.scope))throw Error('配送身份选择响应不匹配');context.value=response;selected.value=response.data.selected;consistencyKey=response.consistency_key;diagnostic.value=deliveryDiagnostic(response.issues);if(selected.value)await options.load?.(controller);}
    catch(failure){if(scope.active()){context.value=null;options.clear?.();error.value=failure instanceof Error?failure.message:'配送工作台暂不可用，请重新读取';}}
    finally{if(scope.active())loading.value=false;}
  }
  function chooseScope(event:{detail:{value:string|number}}){const selection=context.value?.data.contexts[Number(event.detail.value)];if(!selection||deliverySameScope(selection,selected.value))return;selected.value={kind:selection.kind,store_id:selection.store_id,delivery_id:selection.delivery_id};void load();}
  function go(page:'index'|'orderDetail'|'scanning'|'scanDetail',query:Record<string,string|number>={}){if(!current()||!context.value||!selected.value)return;const parts=Object.entries({...query,...deliverySelectionQuery(selected.value)}).map(([key,value])=>`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);uni.navigateTo({url:`/pages/delivery/${page}?${parts.join('&')}`});}
  function back(){if(current())uni.navigateBack({fail:()=>uni.switchTab({url:'/pages/user/index'})});}
  function login(){if(current())uni.navigateTo({url:'/pages/auth/login'});}
  const scopeName=computed(()=>{const selection=selected.value,row=context.value?.data.contexts.find(row=>deliverySameScope(row,selection));return row?`${row.kind==='platform'?'平台配送':'门店配送'} · ${row.name}`:'请选择配送身份';});
  function consumeReceipt(value:unknown,intent:DeliveryPendingIntent){const receipt=parseDeliveryReceipt(value,intent);if(!receipt)return null;if(['abandoned','rollback-rejected'].includes(receipt.outcome)){if(!rejected.value.includes(intent.request_key))rejected.value.push(intent.request_key);}else{releaseDeliveryIntent(intent.request_key);updatePending();}return receipt;}
  function receiptMessage(outcome:string){return outcome==='delivered'?'送达已确认完成，请刷新订单。':outcome==='partial-delivered'?'本次部分送达已确认。请重新读取剩余商品后继续。':outcome==='abandoned'?'原操作已确认放弃，请确认关闭记录。':'原操作未执行，请确认关闭记录并重新核对订单。';}
  async function checkIntent(intent:DeliveryPendingIntent){if(!current()||intent.actor_uid!==auth.uid||busy.value)return;busy.value=true;operationError.value='';const version=epoch,scope=createDeliveryRequests(()=>current()&&epoch===version);recoveries.add(scope);
    try{const response=await scope.request(`/delivery/workbench/operation/${intent.request_key}`);if(!scope.active())return;const receipt=consumeReceipt(response,intent);operationError.value=receipt?receiptMessage(receipt.outcome):'原操作尚无可确认结果，请稍后核对。不要重复提交。';}
    catch(failure){if(scope.active())operationError.value=failure instanceof Error?failure.message:'原操作仍待确认';}finally{scope.abort();recoveries.delete(scope);if(current()&&epoch===version)busy.value=false;}
  }
  async function execute(body:DeliveryOperationInput,availability:DeliveryAvailability){const scope=requests,authority=context.value,selection=selected.value;if(!scope?.active()||!authority||!selection||busy.value||!availability.available)throw Error(availability.reason||'当前订单不能确认送达');if(!isDeliveryInput(body)||!deliverySameScope(selection,{kind:body.scope_kind,store_id:body.store_id,delivery_id:body.delivery_id})||body.scope_key!==authority.scope_key)throw Error('送达操作与当前配送身份不匹配');if(deliveryPendingIntents().some(row=>row.actor_uid===auth.uid&&row.body.order_id===body.order_id))throw Error('该订单已有待核对操作，请先查询原结果');busy.value=true;operationError.value='';let intent:DeliveryPendingIntent|undefined;
    try{const frozen=JSON.parse(merchantCanonicalJson(body)) as DeliveryOperationInput;const confirmed=await new Promise<boolean>(resolve=>uni.showModal({title:'确认本次送达',content:'请核对所选商品与数量。本次确认会记录送达数量，全部送达时完成订单结算。',success:answer=>resolve(answer.confirm),fail:()=>resolve(false)}));if(!confirmed||!scope.active())return null;
      const key=await merchantRequestKey();if(!scope.active())return null;intent={request_key:key,request_hash:deliveryIntentHash(scope.owner.uid,frozen),actor_uid:scope.owner.uid,created_at:Math.floor(Date.now()/1000),body:frozen};retainDeliveryIntent(intent);updatePending();const response=await scope.request('/delivery/workbench/writeoff','POST',frozen as unknown as Record<string,unknown>,key);if(!scope.active())return null;const receipt=consumeReceipt(response,intent);if(!receipt)throw Error('提交结果尚未确认');operationError.value=receiptMessage(receipt.outcome);return receipt;
    }catch(failure){if(scope.active())operationError.value=intent?'原送达结果待确认，请查询原操作。不要再次提交。':failure instanceof Error?failure.message:'尚未提交';throw failure;}
    finally{if(scope.active())busy.value=false;}
  }
  function acknowledge(intent:DeliveryPendingIntent){if(!current()||intent.actor_uid!==auth.uid||!rejected.value.includes(intent.request_key))return;releaseDeliveryIntent(intent.request_key);rejected.value=rejected.value.filter(key=>key!==intent.request_key);updatePending();operationError.value='已关闭确认未执行的记录，请刷新订单后继续。';}
  async function restoreIntent(intent:DeliveryPendingIntent,abandon=false){if(!current()||intent.actor_uid!==auth.uid||busy.value||rejected.value.includes(intent.request_key))return;if(deliveryIntentHash(intent.actor_uid,intent.body)!==intent.request_hash){operationError.value='原操作内容不匹配，只能核对原凭据';return;}if(!abandon&&(!context.value||context.value.scope_key!==intent.body.scope_key||!deliverySameScope(selected.value,{kind:intent.body.scope_kind,store_id:intent.body.store_id,delivery_id:intent.body.delivery_id}))){operationError.value='当前配送权限已变化，只能查询或放弃原操作';return;}busy.value=true;const version=epoch,scope=createDeliveryRequests(()=>current()&&epoch===version);recoveries.add(scope);
    try{const confirmed=await new Promise<boolean>(resolve=>uni.showModal({title:abandon?'核对并放弃原操作':'恢复同一送达操作',content:'将使用原编号与原内容核对；如已执行，仍返回原结果。不会创建第二次操作。',success:answer=>resolve(answer.confirm),fail:()=>resolve(false)}));if(!confirmed||!scope.active())return;const response=await scope.request(abandon?'/delivery/workbench/operation/abandon':'/delivery/workbench/writeoff','POST',intent.body as unknown as Record<string,unknown>,intent.request_key);if(!scope.active())return;const receipt=consumeReceipt(response,intent);operationError.value=receipt?receiptMessage(receipt.outcome):'原操作仍待确认，请继续核对，不要再次提交。';}
    catch(failure){if(scope.active())operationError.value=failure instanceof Error?failure.message:'原操作仍待确认';}finally{scope.abort();recoveries.delete(scope);if(current()&&epoch===version)busy.value=false;}
  }
  const controller={auth,context,selected,loading,error,diagnostic,operationError,busy,pending,rejected,current,fence,scopeQuery,scopeName,read,load,chooseScope,go,back,login,execute,checkIntent,acknowledge,restoreIntent};
  onLoad(query=>{const candidate={kind:query?.scope_kind,store_id:Number(query?.store_id),delivery_id:Number(query?.delivery_id)};if(isDeliverySelection(candidate))selected.value=candidate;options.query?.(query||{});});
  onShow(()=>{visible=true;void load();});onHide(()=>{visible=false;clear();});onUnload(()=>{disposed=true;visible=false;clear();});watch(()=>[auth.uid,auth.token,auth.sessionVersion],()=>{selected.value=null;clear();if(current())void load();},{flush:'sync'});
  return controller;
}
