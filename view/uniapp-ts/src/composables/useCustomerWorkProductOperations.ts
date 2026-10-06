import { ref,watch,type Ref } from 'vue';
import { onShow,onHide,onUnload } from '@dcloudio/uni-app';
import { createCustomerWorkProductRequests,type CustomerWorkProductRequests } from '@/api/customerWorkProducts';
import { RequestError } from '@/utils/request';
import { customerWorkCanonicalJson,customerWorkProductIntentHash,customerWorkProductEndpoint,isCustomerWorkProductBody,isCustomerWorkProductIntent,parseCustomerWorkProductEnvelope,parseCustomerWorkProductReceipt,customerWorkProductPending,retainCustomerWorkProductIntent,releaseCustomerWorkProductIntent,customerWorkRequestKey } from '@/utils/customerWorkProducts';
import { customerWorkRecord } from '@/utils/customerWork';
import type { CustomerWorkController } from './useCustomerWork';
import type { CustomerWorkProductEnvelope,CustomerWorkProductMeta,CustomerWorkProduct,CustomerWorkProductKind,CustomerWorkProductBody,CustomerWorkProductIntent,CustomerWorkProductReceipt,CustomerWorkProductOperationState } from '../types/customerWorkProducts';
function confirm(title:string,content:string):Promise<boolean>{return new Promise(resolve=>uni.showModal({title,content,success:answer=>resolve(answer.confirm),fail:()=>resolve(false)}));}
export interface CustomerWorkProductOperations{
 manager:CustomerWorkController;authority:Ref<CustomerWorkProductEnvelope<CustomerWorkProductMeta>|null>;busy:Ref<boolean>;error:Ref<string>;pending:Ref<CustomerWorkProductIntent[]>;states:Ref<Record<string,CustomerWorkProductOperationState>>;
 current:()=>boolean;clear:()=>void;
 read:<T extends CustomerWorkProductMeta>(path:string,guard:(value:unknown)=>value is T,data?:Record<string,unknown>)=>Promise<CustomerWorkProductEnvelope<T>>;
 submit:(kind:CustomerWorkProductKind,products:CustomerWorkProduct[],meta:CustomerWorkProductMeta,payload:Record<string,unknown>)=>Promise<CustomerWorkProductReceipt|null>;
 check:(intent:CustomerWorkProductIntent)=>Promise<void>;restore:(intent:CustomerWorkProductIntent)=>Promise<void>;abandon:(intent:CustomerWorkProductIntent)=>Promise<void>;acknowledge:(intent:CustomerWorkProductIntent)=>Promise<void>;canRestore:(intent:CustomerWorkProductIntent)=>boolean;
}
export function useCustomerWorkProductOperations(manager:CustomerWorkController):CustomerWorkProductOperations{
 const authority=ref<CustomerWorkProductEnvelope<CustomerWorkProductMeta>|null>(null),busy=ref(false),error=ref(''),pending=ref<CustomerWorkProductIntent[]>([]),states=ref<Record<string,CustomerWorkProductOperationState>>({});
 const scopes=new Set<CustomerWorkProductRequests>();let epoch=0,disposed=false;
 const current=()=>!disposed&&manager.current()&&manager.auth.isLoggedIn;
 const owns=(intent:CustomerWorkProductIntent)=>current()&&intent.actor_uid===manager.auth.uid;
 const sameOwner=(scope:CustomerWorkProductRequests)=>current()&&manager.auth.uid===scope.owner.uid&&manager.auth.token===scope.owner.token&&manager.auth.sessionVersion===scope.owner.version;
 function refreshPending(){if(!current()){pending.value=[];return;}try{pending.value=customerWorkProductPending().filter(row=>row.actor_uid===manager.auth.uid);}catch(failure){pending.value=[];error.value=failure instanceof Error?failure.message:'商品原操作记录需核对';}}
 function clear(){epoch++;for(const scope of scopes)scope.abort();scopes.clear();authority.value=null;busy.value=false;error.value='';pending.value=[];states.value={};}
 function clearDomain(){epoch++;for(const scope of scopes)scope.abort();scopes.clear();authority.value=null;busy.value=false;error.value='';if(!current()){pending.value=[];states.value={};}else refreshPending();}
 function create(fence?:()=>boolean){const version=epoch,scope=createCustomerWorkProductRequests(()=>current()&&epoch===version&&(!fence||fence()));scopes.add(scope);return scope;}
 function finish(scope:CustomerWorkProductRequests){scope.abort();scopes.delete(scope);}
 function known(intent:CustomerWorkProductIntent){if(!isCustomerWorkProductIntent(intent)||!owns(intent))throw Error('原商品操作不属于当前账号');const saved=customerWorkProductPending().find(row=>row.request_key===intent.request_key);if(!saved||customerWorkCanonicalJson(saved)!==customerWorkCanonicalJson(intent))throw Error('原商品操作内容已变化，请保留记录核对');}
 function state(intent:CustomerWorkProductIntent,errorMessage='',receipt:CustomerWorkProductReceipt|null=null){states.value={...states.value,[intent.request_key]:{receipt,unknown:receipt===null,error:errorMessage}};}
 function consume(response:unknown,intent:CustomerWorkProductIntent,scope:CustomerWorkProductRequests):CustomerWorkProductReceipt|null{
  if(!customerWorkRecord(response)||!Object.hasOwn(response,'receipt'))throw Error('原商品响应格式无效，请继续查询');
  if(response.receipt===null){if(!states.value[intent.request_key]?.receipt)state(intent);return null;}
  const receipt=parseCustomerWorkProductReceipt(response.receipt,intent);
  if(receipt.service_id===0||receipt.outcome==='rollback-rejected'){
   // The manager watcher clears every product/draft before this same ordinary owner receives minimal evidence.
   manager.invalidate(Error('商品管理依据已变化，请重新读取当前权限与商品'));
   if(sameOwner(scope)){refreshPending();state(intent,'',receipt);}return receipt;
  }
  state(intent,'',receipt);return receipt;
 }
 function failedWrite(scope:CustomerWorkProductRequests,intent:CustomerWorkProductIntent,failure:unknown){
  if(!sameOwner(scope))return;const message=failure instanceof Error?failure.message:'原商品结果未确认，请继续查询';
  if(failure instanceof RequestError&&(failure.httpStatus===403||[410000,410001,410002].includes(Number(failure.status))))manager.invalidate(Error('商品管理权限需重新读取'));
  if(sameOwner(scope)){refreshPending();state(intent,message);error.value=message;}
 }
 async function read<T extends CustomerWorkProductMeta>(path:string,guard:(value:unknown)=>value is T,data:Record<string,unknown>={}):Promise<CustomerWorkProductEnvelope<T>>{
  const principal=manager.context.value;if(!current()||!principal||principal.data.capabilities.product_management!==true)throw Error('当前账号没有商品管理权限');
  const scope=create(manager.fence());
  try{const response=parseCustomerWorkProductEnvelope(await scope.request(path,'GET',{...data,scope_key:principal.scope_key}),scope.owner.uid,guard,principal,authority.value?.consistency_key);
   if(!scope.active())throw Error('商品页面或账号已变化');authority.value=response;return response;
  }catch(failure){if(scope.active()){clearDomain();manager.invalidate(failure);}throw failure;}finally{finish(scope);}
 }
 function allowed(kind:CustomerWorkProductKind,products:CustomerWorkProduct[],payload:Record<string,unknown>){
  const key=kind==='set_show'?(payload.is_show===1?'show':'hide'):kind==='replace_categories'?'categories':kind==='replace_labels'?'labels':'skus';
  return products.every(product=>product.actions[key]===true);
 }
 async function submit(kind:CustomerWorkProductKind,products:CustomerWorkProduct[],meta:CustomerWorkProductMeta,payload:Record<string,unknown>):Promise<CustomerWorkProductReceipt|null>{
  if(busy.value||!current())return null;const principal=manager.context.value,domain=authority.value;
  if(!principal||principal.data.capabilities.product_management!==true||!domain||!domain.data.readiness.writes||meta.catalog_revision!==domain.data.catalog_revision||!allowed(kind,products,payload)){error.value='当前商品或操作不可提交，请重新读取';return null;}
  const body:CustomerWorkProductBody=JSON.parse(customerWorkCanonicalJson({version:'customer-work-product-operation-v1',scope_key:principal.scope_key,targets:products.map(product=>({product_id:product.id,expected_product_revision:product.product_revision})).sort((a,b)=>a.product_id-b.product_id),expected_catalog_revision:meta.catalog_revision,payload}));
  if(!isCustomerWorkProductBody(body,kind)){error.value='商品编辑内容无效，尚未提交';return null;}
  refreshPending();if(pending.value.some(intent=>intent.body.targets.some(target=>body.targets.some(row=>row.product_id===target.product_id)))){error.value='所选商品存在待确认原操作，请先查询并确认原结果';return null;}
  const scope=create(manager.fence());busy.value=true;error.value='';let intent:CustomerWorkProductIntent|null=null;
  try{
   const title=kind==='set_show'?(payload.is_show===1?'确认上架':'确认下架'):kind==='update_skus'?'确认价格与库存':'确认替换分类或标签';
   if(!await confirm(title,`按当前核对的版本提交 ${body.targets.length} 个商品。`)||!scope.active())return null;
   const key=await customerWorkRequestKey();if(!scope.active())return null;
   intent=JSON.parse(customerWorkCanonicalJson({version:'customer-work-product-pending-v1',actor_uid:scope.owner.uid,service_id:principal.principal.service_id,scope_key:principal.scope_key,kind,request_key:key,request_hash:customerWorkProductIntentHash(scope.owner.uid,kind,body),body,endpoint:customerWorkProductEndpoint(kind,body.targets.map(row=>row.product_id)),method:'POST',created_at:Math.floor(Date.now()/1000)}));
   retainCustomerWorkProductIntent(intent!);refreshPending();state(intent!);
   const response=await scope.request(intent!.endpoint,'POST',intent!.body as unknown as Record<string,unknown>,intent!.request_key);if(!scope.active())return null;
   if(!customerWorkRecord(response)||typeof response.replayed!=='boolean')throw Error('商品提交回执格式无效，请查询原结果');return consume(response,intent!,scope);
  }catch(failure){if(intent)failedWrite(scope,intent,failure);else if(scope.active())error.value=failure instanceof Error?failure.message:'商品意图尚未提交';return null;}
  finally{if(scope.active())busy.value=false;finish(scope);}
 }
 async function check(intent:CustomerWorkProductIntent){if(busy.value||!owns(intent))return;let scope:CustomerWorkProductRequests|undefined;try{known(intent);scope=create();busy.value=true;error.value='';const response=await scope.request(`/mobile/work/products/operations/${intent.request_key}`);if(scope.active())consume(response,intent,scope);}catch(failure){if(scope)failedWrite(scope,intent,failure);else error.value=failure instanceof Error?failure.message:'原商品结果需核对';}finally{if(scope?.active())busy.value=false;if(scope)finish(scope);}}
 function canRestore(intent:CustomerWorkProductIntent){return owns(intent)&&!busy.value&&!states.value[intent.request_key]?.receipt&&manager.context.value?.data.capabilities.product_management===true&&manager.context.value.principal.service_id===intent.service_id&&manager.context.value.scope_key===intent.scope_key&&authority.value?.data.readiness.writes===true;}
 async function restore(intent:CustomerWorkProductIntent){if(!canRestore(intent))return;const scope=create(manager.fence());busy.value=true;error.value='';try{known(intent);if(!await confirm('重发原商品意图','保持原编号与全部原内容，再核对同一次操作结果。')||!scope.active())return;const response=await scope.request(intent.endpoint,'POST',intent.body as unknown as Record<string,unknown>,intent.request_key);if(scope.active())consume(response,intent,scope);}catch(failure){failedWrite(scope,intent,failure);}finally{if(scope.active())busy.value=false;finish(scope);}}
 async function abandon(intent:CustomerWorkProductIntent){if(busy.value||!owns(intent)||states.value[intent.request_key]?.receipt)return;const scope=create();busy.value=true;error.value='';try{known(intent);if(!await confirm('放弃尚未执行的原意图','查询并阻止这一次尚未执行的请求，保留已确定的实际结果。')||!scope.active())return;const response=await scope.request(`/mobile/work/products/operations/${intent.request_key}/abandon`,'POST',{kind:intent.kind,input:intent.body},intent.request_key);if(scope.active())consume(response,intent,scope);}catch(failure){failedWrite(scope,intent,failure);}finally{if(scope.active())busy.value=false;finish(scope);}}
 async function acknowledge(intent:CustomerWorkProductIntent){if(busy.value||!owns(intent)||!states.value[intent.request_key]?.receipt)return;const scope=create();busy.value=true;try{known(intent);const receipt=states.value[intent.request_key]!.receipt!;if(!await confirm('确认原商品操作结果','已核对当前回执，关闭这条本机待确认记录。')||!scope.active()||customerWorkCanonicalJson(states.value[intent.request_key]?.receipt)!==customerWorkCanonicalJson(receipt))return;releaseCustomerWorkProductIntent(intent.request_key);const next={...states.value};delete next[intent.request_key];states.value=next;refreshPending();}catch(failure){if(scope.active())error.value=failure instanceof Error?failure.message:'原商品记录仍需确认';}finally{if(scope.active())busy.value=false;finish(scope);}}
 onShow(refreshPending);onHide(clear);onUnload(()=>{disposed=true;clear();});
 watch(()=>[manager.auth.uid,manager.auth.token,manager.auth.sessionVersion],()=>{clear();refreshPending();},{flush:'sync'});
 watch(()=>manager.context.value,(value,previous)=>{if(previous&&(!value||value.scope_key!==previous.scope_key||value.principal.service_id!==previous.principal.service_id))clearDomain();},{flush:'sync'});
 return{manager,authority,busy,error,pending,states,current,clear,read,submit,check,restore,abandon,acknowledge,canRestore};
}
