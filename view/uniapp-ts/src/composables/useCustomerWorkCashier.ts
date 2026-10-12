import {ref,watch} from 'vue';
import {onShow,onHide,onUnload} from '@dcloudio/uni-app';
import {RequestError} from '@/utils/request';
import {createCustomerCashierRequests,type CustomerCashierRequests} from '@/api/customerWorkCashier';
import {parseCustomerCashierReadEnvelope,isCustomerCashierRecordDetail} from '@/utils/customerWorkCashierRead';
import {customerCashierPending,customerCashierAbandonRequested,retainCustomerCashierAbandonDecision,retainCustomerCashierIntent,releaseCustomerCashierIntent,isCustomerCashierInput,isCustomerCashierIntent,cashierIntentHash,cashierId,cashierUuid,cashierCents,cashierCardValidityText,parseCustomerCashierQuote,parseCustomerCashierReceipt,cashierReceiptTarget,verifyCustomerCashierDetail,customerWorkCanonicalJson,customerWorkRequestKey} from '@/utils/customerWorkCashier';
import type {CustomerCashierInput,CustomerCashierIntent,CustomerCashierCreationIntent,CustomerCashierPaymentIntent,CustomerCashierQuote,CustomerCashierReceipt,CustomerCashierState} from '@/types/customerWorkCashier';
import type {CustomerCashierRecordDetail} from '@/types/customerWorkCashierRead';
import type {CustomerWorkController} from './useCustomerWork';
const base='/mobile/work/cashier/second-card';
const confirm=(title:string,content:string)=>new Promise<boolean>(resolve=>uni.showModal({title,content,success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
export interface CustomerCashierImageCoordinator {
  assertCanPrepare:(parentKey?:string)=>void;
  assertReadyForFreeze:(body:CustomerCashierInput,parentKey:string)=>void|Promise<void>;
  markFinancialIntent:(intent:CustomerCashierCreationIntent)=>void|Promise<void>;
  releaseAbandonedIntent:(intent:CustomerCashierCreationIntent,receipt:CustomerCashierReceipt)=>void|Promise<void>;
}
export function useCustomerWorkCashier(manager:CustomerWorkController,images?:CustomerCashierImageCoordinator){
  const busy=ref(false),error=ref(''),pending=ref<CustomerCashierIntent[]>([]),states=ref<Record<string,CustomerCashierState>>({});
  const activeIntent=ref<CustomerCashierCreationIntent|null>(null),quote=ref<CustomerCashierQuote|null>(null),detail=ref<CustomerCashierRecordDetail|null>(null);
  const requests=new Set<CustomerCashierRequests>();let epoch=0,disposed=false,quoteOwner='';
  const current=()=>!disposed&&manager.current()&&manager.auth.isLoggedIn;
  const sameAccount=(r:CustomerCashierRequests)=>current()&&manager.auth.uid===r.owner.uid&&manager.auth.token===r.owner.token&&manager.auth.sessionVersion===r.owner.version;
  const authFailure=(failure:unknown)=>failure instanceof RequestError&&(failure.httpStatus===403||[410000,410001,410002].includes(Number(failure.status)));
  const owns=(intent:CustomerCashierIntent)=>current()&&intent.actor_uid===manager.auth.uid;
  function refreshPending(){if(!current()){pending.value=[];return;}try{pending.value=customerCashierPending().filter(v=>v.actor_uid===manager.auth.uid);}catch(failure){pending.value=[];error.value=failure instanceof Error?failure.message:'原收银记录需要核对';}}
  function clear(){epoch++;for(const r of requests)r.abort();requests.clear();busy.value=false;error.value='';activeIntent.value=null;quote.value=null;quoteOwner='';detail.value=null;pending.value=[];states.value={};}
  function clearDomain(){clear();refreshPending();}
  function scope(fence?:()=>boolean){const version=epoch,r=createCustomerCashierRequests(()=>current()&&epoch===version&&(!fence||fence()));requests.add(r);return r;}
  function close(r:CustomerCashierRequests){r.abort();requests.delete(r);}
  function known(intent:CustomerCashierIntent){if(!owns(intent)||!isCustomerCashierIntent(intent)||!customerCashierPending().some(v=>v.request_key===intent.request_key&&customerWorkCanonicalJson(v)===customerWorkCanonicalJson(intent)))throw Error('本机原收银内容或当前账号已变化');}
  function abandonRequested(intent:CustomerCashierIntent){try{return customerCashierAbandonRequested(intent);}catch{return true;}}
  function submittable(intent:CustomerCashierIntent){known(intent);if(customerCashierAbandonRequested(intent)||states.value[intent.request_key]?.receipt?.abandonment)throw Error('原编号已请求永久放弃，只能查询或继续核对放弃结果');}
  function allowed(intent?:CustomerCashierIntent){const c=manager.context.value;if(!current()||!c||c.data.capabilities.cashier_second_card!==true)throw Error('当前账号没有可用的次卡收银权限');if(intent&&(intent.actor_uid!==manager.auth.uid||intent.service_id!==c.principal.service_id||intent.body.scope_key!==c.scope_key))throw Error('原收银资格已变化，只能查询原结果');return c;}
  function failed(r:CustomerCashierRequests,failure:unknown,intent?:CustomerCashierIntent){if(!r.active())return;const message=failure instanceof Error?failure.message:'原收银结果未确认，请查询原编号';
    if(intent)states.value={...states.value,[intent.request_key]:{...(states.value[intent.request_key]??{checked:false,receipt:null,detail:null}),error:message}};
    error.value=message;refreshPending();if(authFailure(failure))manager.invalidate(Error('当前收银资格已变化，请重新读取并查询原编号'));
  }
  async function loadDetail(r:CustomerCashierRequests,intent:CustomerCashierIntent,id:number,no:string,originHash:string){const context=manager.context.value;if(!context)throw Error('当前资格暂不可读订单，请保留原回执');
    const raw=await r.request(`${base}/records/${id}`,'GET',{scope_key:context.scope_key,order_no:no});if(!r.active())throw Error('原收银页面已变化');
    try{const response=parseCustomerCashierReadEnvelope(raw,r.owner.uid,isCustomerCashierRecordDetail,context);if(response.data.record.id!==id||response.data.record.order_no!==no||response.data.record.origin_hash!==originHash)throw Error('原收银物理订单、单号或来源不匹配');verifyCustomerCashierDetail(response.data,intent);return response.data;}
    catch(failure){if(r.active())manager.invalidate(Error('原收银订单与当前身份或回执不匹配'));throw failure;}
  }
  async function query(r:CustomerCashierRequests,intent:CustomerCashierIntent){known(intent);const raw=await r.request(`${base}/${intent.kind==='creation'?'creations':'payments'}/${intent.request_key}`,'GET');let response:CustomerCashierReceipt;
    try{response=parseCustomerCashierReceipt(raw,intent);}catch(failure){if(r.active())manager.invalidate(Error('原收银回执不匹配，请保留原编号核对'));throw failure;}
    if(!r.active())throw Error('原收银账号已变化');known(intent);const state:CustomerCashierState={checked:true,receipt:response,detail:null,error:''};states.value={...states.value,[intent.request_key]:state};
    if(response.receipt&&manager.context.value?.data.capabilities.cashier_records){const target=cashierReceiptTarget(response),originHash=intent.kind==='creation'?response.receipt.origin_hash!:intent.origin_hash;try{state.detail=await loadDetail(r,intent,target.id,target.no,originHash);}catch(failure){if(!r.active())throw failure;state.error=failure instanceof Error?failure.message:'真实收银订单暂不能读取';
      if(authFailure(failure)){manager.invalidate(Error('当前收银资格已撤回，可继续查询本人原回执'));if(sameAccount(r)){refreshPending();states.value={...states.value,[intent.request_key]:state};error.value=state.error;}return response;}
    }}
    if(!r.active())throw Error('原收银账号已变化');states.value={...states.value,[intent.request_key]:{...state}};
    if(intent.kind==='creation'&&response.receipt){activeIntent.value=intent;detail.value=state.detail;quote.value=null;quoteOwner='';}
    if(intent.kind==='creation'&&response.abandonment){if(activeIntent.value?.request_key===intent.request_key){activeIntent.value=null;detail.value=null;}quote.value=null;quoteOwner='';}
    if(intent.kind==='payment'&&state.detail){detail.value=state.detail;const parent=states.value[intent.creation_key];if(parent?.receipt?.receipt)states.value={...states.value,[intent.creation_key]:{...parent,detail:state.detail}};}
    error.value=response.abandonment?'原编号已永久放弃，可以关闭已核对的本机记录。':response.receipt?(intent.kind==='creation'?'原订单已创建，请核对真实金额及付款状态。':'原现金付款已确认。'):abandonRequested(intent)?'放弃结果尚未确认，请保留原编号；只能查询或重试原放弃请求。':'没有已提交的原回执，请保留原编号；恢复仍使用完整原内容。';return response;
  }
  async function draftQuote(r:CustomerCashierRequests,intent:CustomerCashierCreationIntent){allowed(intent);submittable(intent);
    const draft=await r.request<{cart_id:number;request_hash:string;replayed:boolean}>(`${base}/drafts`,'POST',intent.body as unknown as Record<string,unknown>,intent.request_key);
    if(!r.active())throw Error('当前收银页面已变化');submittable(intent);if(!cashierId(draft?.cart_id)||draft.request_hash!==intent.request_hash||typeof draft.replayed!=='boolean')throw Error('原购物草稿与选品内容不匹配');
    const value=parseCustomerCashierQuote(await r.request(`${base}/quote`,'POST',{request_key:intent.request_key,intent:intent.body}),intent,draft.cart_id);
    if(!r.active())throw Error('当前收银页面已变化');submittable(intent);allowed(intent);activeIntent.value=intent;quote.value=value;quoteOwner=customerWorkCanonicalJson(intent);detail.value=null;error.value='已取得实际报价，请核对后明确创建订单。';return intent;
  }
  async function prepare(value:CustomerCashierInput,originalCreationKey?:string){if(busy.value||!current())return null;let intent:CustomerCashierCreationIntent|undefined;const r=scope(manager.fence());busy.value=true;error.value='';try{
    const c=allowed(),body=JSON.parse(customerWorkCanonicalJson(value)) as CustomerCashierInput;if(!isCustomerCashierInput(body)||body.scope_key!==c.scope_key)throw Error('收银选品、购买人或联系资料无效');refreshPending();
    images?.assertCanPrepare(originalCreationKey);
    if(originalCreationKey!==undefined&&(!cashierUuid(originalCreationKey)||!images))throw Error('原图片收银编号尚未核对，尚未保存购物草稿');
    if(pending.value.some(v=>v.kind==='creation'&&!states.value[v.request_key]?.receipt?.receipt))throw Error('还有未确认的原创建请求，请先查询或恢复原编号');
    if(!await confirm('核对次卡收银选品',`购买 ${body.quantity} 份次卡，将保存真实购物草稿并取得实际报价。请核对购买人与联系资料。`)||!r.active())return null;
    if(originalCreationKey!==undefined){await images!.assertReadyForFreeze(body,originalCreationKey);if(!r.active())return null;allowed();refreshPending();if(pending.value.some(v=>v.request_key===originalCreationKey))throw Error('原编号已有收银意图，请查询或恢复原结果');}
    allowed();intent={version:'customer-cashier-pending-v1',kind:'creation',actor_uid:r.owner.uid,service_id:c.principal.service_id,request_key:originalCreationKey??await customerWorkRequestKey(),request_hash:cashierIntentHash(body),created_at:Math.floor(Date.now()/1000),body};
    if(!r.active())return null;allowed(intent);images?.assertCanPrepare(originalCreationKey);retainCustomerCashierIntent(intent);refreshPending();if(originalCreationKey!==undefined){await images!.markFinancialIntent(intent);if(!r.active())return null;allowed(intent);known(intent);}return await draftQuote(r,intent);
  }catch(failure){failed(r,failure,intent);return null;}finally{if(r.active())busy.value=false;close(r);}}
  async function create(intent=activeIntent.value){if(busy.value||!current()||!intent)return;const r=scope(manager.fence());busy.value=true;error.value='';try{submittable(intent);allowed(intent);const q=quote.value;
    if(!q||quoteOwner!==customerWorkCanonicalJson(intent)||activeIntent.value?.request_key!==intent.request_key)throw Error('请用原编号重新取得并核对实际报价');
    const frozen=customerWorkCanonicalJson(q);if(!await confirm('确认创建次卡订单',`购买 ${intent.body.quantity} 份次卡，每份 ${q.card.unit_write_times} 次，共 ${q.card.total_write_times} 次，有效期：${cashierCardValidityText(q.card)}，实际应付 ¥${cashierCents(q.quote.payCents)}。创建订单会扣减实际库存；付款另行确认。`)||!r.active())return;
    submittable(intent);allowed(intent);if(customerWorkCanonicalJson(quote.value)!==frozen)throw Error('实际报价已变化，请重新核对');
    // A response is only transport feedback; the original immutable receipt proves creation.
    await r.request(`${base}/orders`,'POST',{intent:intent.body,quote_token:q.quote_token},intent.request_key);if(!r.active())return;await query(r,intent);
  }catch(failure){quote.value=null;quoteOwner='';failed(r,failure,intent);}finally{if(r.active())busy.value=false;close(r);}}
  function paymentAllowed(d:CustomerCashierRecordDetail){if(d.record.paid!==0||d.record.status!==0||d.record.refund_status!==0||d.record.root_retired||d.payment)throw Error('原订单已付款、退回或状态变化，请查询真实原结果');}
  async function sendPayment(r:CustomerCashierRequests,intent:CustomerCashierPaymentIntent,newIntent=false){if(!newIntent)submittable(intent);allowed(intent);const before=await loadDetailForPayment(r,intent);paymentAllowed(before);
    if(!await confirm(intent.body.expected_amount==='0.00'?'确认零元次卡':'确认现金已收款',intent.body.expected_amount==='0.00'?'已核对真实零元订单，确认记录本次零金额付款。':`订单 ${intent.body.order_no} 应付 ¥${intent.body.expected_amount}。确认已经收到现金后记录付款。`)||!r.active())return;
    allowed(intent);if(newIntent){retainCustomerCashierIntent(intent);refreshPending();}submittable(intent);await r.request(`${base}/orders/${intent.body.order_id}/cash`,'POST',intent.body as unknown as Record<string,unknown>,intent.request_key);if(r.active())await query(r,intent);
  }
  async function loadDetailForPayment(r:CustomerCashierRequests,intent:CustomerCashierPaymentIntent){const c=allowed(intent),raw=await r.request(`${base}/records/${intent.body.order_id}`,'GET',{scope_key:c.scope_key,order_no:intent.body.order_no});
    if(!r.active())throw Error('收银付款页面已变化');try{const response=parseCustomerCashierReadEnvelope(raw,r.owner.uid,isCustomerCashierRecordDetail,c),d=response.data;if(d.record.id!==intent.body.order_id||d.record.order_no!==intent.body.order_no||d.record.creator_uid!==intent.actor_uid||d.record.buyer_uid!==intent.buyer_uid||d.record.amount!==intent.body.expected_amount||d.record.origin_hash!==intent.origin_hash||d.creation.request_key!==intent.creation_key)throw Error('现金付款原订单或真实金额已变化');return d;}
    catch(failure){if(r.active())manager.invalidate(Error('原付款订单或实际金额已变化，请查询原编号并重新读取'));throw failure;}
  }
  async function pay(){if(busy.value||!current()||!activeIntent.value||!detail.value)return;const r=scope(manager.fence());let intent:CustomerCashierPaymentIntent|undefined;busy.value=true;error.value='';try{const creation=activeIntent.value,c=allowed(creation);known(creation);const d=detail.value;verifyCustomerCashierDetail(d,creation);paymentAllowed(d);refreshPending();
    if(pending.value.some(v=>v.kind==='payment'&&v.body.order_id===d.record.id&&!states.value[v.request_key]?.receipt?.receipt))throw Error('该订单还有待确认的原付款请求，请先查询原编号');
    const body={version:'customer-cashier-second-card-payment-v1' as const,scope_key:c.scope_key,order_id:d.record.id,order_no:d.record.order_no,expected_amount:d.record.amount};
    intent={version:'customer-cashier-pending-v1',kind:'payment',actor_uid:r.owner.uid,service_id:c.principal.service_id,request_key:await customerWorkRequestKey(),request_hash:cashierIntentHash(body),created_at:Math.floor(Date.now()/1000),body,buyer_uid:d.record.buyer_uid,origin_hash:d.record.origin_hash,creation_key:creation.request_key};
    if(!r.active())return;allowed(intent);await sendPayment(r,intent,true);
  }catch(failure){failed(r,failure,intent);}finally{if(r.active())busy.value=false;close(r);}}
  async function check(intent:CustomerCashierIntent){if(busy.value||!owns(intent))return;const r=scope();busy.value=true;try{await query(r,intent);}catch(failure){failed(r,failure,intent);}finally{if(r.active())busy.value=false;close(r);}}
  async function restore(intent:CustomerCashierIntent){if(busy.value||!owns(intent))return;const r=scope(manager.fence());busy.value=true;error.value='';try{const receipt=await query(r,intent);if(!r.active()||receipt.receipt||receipt.abandonment)return;allowed(intent);submittable(intent);
    if(intent.kind==='creation'){if(!await confirm('恢复原次卡选品',`继续原创建编号 ${intent.request_key}，完整原选品和购买人保持。重新取得报价后仍须确认创建。`)||!r.active())return;await draftQuote(r,intent);}else await sendPayment(r,intent);
  }catch(failure){failed(r,failure,intent);}finally{if(r.active())busy.value=false;close(r);}}
  async function abandon(intent:CustomerCashierIntent){if(busy.value||!owns(intent))return;const r=scope();busy.value=true;error.value='';try{known(intent);const prior=await query(r,intent);if(!r.active()||prior.receipt||prior.abandonment)return;
    const decided=customerCashierAbandonRequested(intent);if(!await confirm(decided?'重试原永久放弃请求':'永久放弃原收银请求',intent.kind==='creation'?`永久停用原创建编号 ${intent.request_key}。一旦服务器确认，该编号不能再下单，原图片不能用于另一笔创建。若订单已提交，将展示真实订单。`:`永久停用原付款编号 ${intent.request_key}。这不会取消订单、退款或确认现金收款；原订单仍需核对。若付款已提交，将展示真实付款。`)||!r.active())return;
    known(intent);retainCustomerCashierAbandonDecision(intent);refreshPending();if(intent.kind==='creation'){quote.value=null;quoteOwner='';}
    await r.request(`${base}/${intent.kind==='creation'?'creations':'payments'}/${intent.request_key}/abandon`,'POST',{version:'customer-cashier-abandon-v1',kind:intent.kind,intent:intent.body},intent.request_key);
    if(!r.active())return;await query(r,intent);
  }catch(failure){failed(r,failure,intent);}finally{if(r.active())busy.value=false;close(r);}}
  async function acknowledge(intent:CustomerCashierIntent){if(busy.value||!owns(intent))return;const r=scope();busy.value=true;try{known(intent);const result=states.value[intent.request_key]?.receipt;if(!result?.receipt&&!result?.abandonment)throw Error('只有已经核对的真实原回执或永久放弃事实才可关闭本机记录');
    if(result.receipt&&intent.kind==='creation'&&states.value[intent.request_key]?.detail?.record.paid!==1)throw Error('原创建请求仍用于付款恢复，请在核对付款后关闭本机记录');const snapshot=customerWorkCanonicalJson(result);
    if(!await confirm('关闭已核对的本机记录',result.abandonment?'已核对原编号永久放弃事实。关闭本机记录后，服务器保留原事实；下一笔必须使用新编号和新图片准备。':'已核对真实原回执。关闭本机待核对记录后，订单及付款凭据仍保留在收银记录中。')||!r.active())return;known(intent);if(customerWorkCanonicalJson(states.value[intent.request_key]?.receipt)!==snapshot)throw Error('原回执已变化，请重新查询');
    // Re-read terminal abandonment after confirmation; POST transport or a local decision is never proof.
    if(result.abandonment){const terminal=await query(r,intent);if(!r.active())return;if(customerWorkCanonicalJson(terminal)!==snapshot||!terminal.abandonment)throw Error('原放弃事实已变化，请保留原编号核对');if(intent.kind==='creation')await images?.releaseAbandonedIntent(intent,terminal);if(!r.active())return;known(intent);}
    releaseCustomerCashierIntent(intent.request_key);const next={...states.value};delete next[intent.request_key];states.value=next;refreshPending();
  }catch(failure){failed(r,failure,intent);}finally{if(r.active())busy.value=false;close(r);}}
  function canRestore(intent:CustomerCashierIntent){try{allowed(intent);return!busy.value&&owns(intent)&&!customerCashierAbandonRequested(intent)&&states.value[intent.request_key]?.checked===true&&states.value[intent.request_key]?.receipt?.receipt===null&&!states.value[intent.request_key]?.receipt?.abandonment;}catch{return false;}}
  function canAbandon(intent:CustomerCashierIntent){try{known(intent);const state=states.value[intent.request_key];return!busy.value&&state?.checked===true&&state.receipt?.receipt===null&&!state.receipt.abandonment;}catch{return false;}}
  onShow(refreshPending);onHide(()=>{if(!manager.suspendLeaseActive?.())clear();});onUnload(()=>{disposed=true;clear();});watch(()=>[manager.auth.uid,manager.auth.token,manager.auth.sessionVersion],clearDomain,{flush:'sync'});
  watch(()=>manager.context.value,(c,prior)=>{if(prior&&(!c||c.scope_key!==prior.scope_key||c.principal.service_id!==prior.principal.service_id||c.consistency_key!==prior.consistency_key))clearDomain();},{flush:'sync'});
  return{manager,busy,error,pending,states,activeIntent,quote,detail,current,clear,clearDomain,refreshPending,prepare,create,pay,check,restore,canRestore,canAbandon,abandon,abandonRequested,acknowledge};
}
