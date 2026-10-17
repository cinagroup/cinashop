import {ref,watch,type Ref} from 'vue';
import {onHide,onUnload} from '@dcloudio/uni-app';
import {createCustomerFinancialRequests,type CustomerFinancialRequests} from '@/api/customerWorkFinancial';
import {RequestError} from '@/utils/request';
import {parseCustomerFinancialEnvelope} from '@/utils/customerWorkFinancial';
import {parseSupplierRefundSettlement,type SupplierRefundSettlement,type SupplierRefundSettlementTarget} from '../../../common/supplierRefundSettlement';
import type {CustomerWorkController} from './useCustomerWork';

export type CustomerSupplierRefundSettlementTarget=SupplierRefundSettlementTarget&{pay_type:'cash'|'offline'|'yue'};
export interface CustomerSupplierRefundSettlement {
 summary:Ref<SupplierRefundSettlement|null>;busy:Ref<boolean>;error:Ref<string>;
 load:(target:CustomerSupplierRefundSettlementTarget)=>Promise<void>;clear:()=>void;
}

/** Independent read state: the summary cannot become a financial intent,
 * receipt or permission to execute a refund. */
export function useCustomerSupplierRefundSettlement(manager:CustomerWorkController):CustomerSupplierRefundSettlement {
 const summary=ref<SupplierRefundSettlement|null>(null),busy=ref(false),error=ref('');
 let epoch=0,disposed=false,request:CustomerFinancialRequests|null=null;
 function clear(){epoch++;request?.abort();request=null;summary.value=null;busy.value=false;error.value='';}
 async function load(target:CustomerSupplierRefundSettlementTarget){
  clear();
  const context=manager.context.value;
  if(disposed||!manager.current()||!manager.auth.isLoggedIn||!context)return;
  const expected=Object.freeze({...target}),version=epoch,valid=manager.fence();
  const owner=createCustomerFinancialRequests(()=>!disposed&&manager.current()&&epoch===version&&valid()&&manager.context.value===context);
  request=owner;busy.value=true;
  try{
   const value=await owner.request(`/mobile/work/financial/orders/${expected.order_id}/supplier-refund-settlement`,'GET',{
    order_no:expected.order_no,scope_key:context.scope_key,
   });
   if(!owner.active())return;
   try{
    const guard=(data:unknown):data is SupplierRefundSettlement=>{parseSupplierRefundSettlement(data,expected);return true;};
    const response=parseCustomerFinancialEnvelope(value,owner.owner.uid,guard,context);
    const checked=parseSupplierRefundSettlement(response.data,expected);
    if(checked.pay_type!==expected.pay_type)throw Error('原付款渠道不匹配');
    if(owner.active())summary.value=checked;
   }catch{
    manager.invalidate(Error('累计退款核验与当前订单或经营身份不匹配，请重新加载页面'));
   }
  }catch(failure){
   if(!owner.active())return;
   if(failure instanceof RequestError&&(failure.httpStatus===403||[410000,410001,410002].includes(Number(failure.status)))){
    manager.invalidate(Error('当前累计退款读取权限已变化，请重新加载页面'));return;
   }
   error.value='尚未完整核验累计退款。'+(failure instanceof Error?failure.message:'请重新核对后重试');
  }finally{
   if(owner.active())busy.value=false;
   owner.abort();if(request===owner)request=null;
  }
 }
 watch(()=>manager.context.value,clear,{flush:'sync'});
 watch(()=>[manager.auth.uid,manager.auth.token,manager.auth.sessionVersion],clear,{flush:'sync'});
 onHide(clear);onUnload(()=>{disposed=true;clear();});
 return{summary,busy,error,load,clear};
}
