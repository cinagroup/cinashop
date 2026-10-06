import {customerWorkRequestKey} from './customerWorkFulfillment';
import {customerWorkCanonicalJson,isCustomerFinancialIntent,financialUuid,financialText,customerFinancialTerminal,type CustomerFinancialIntent,type CustomerFinancialResult} from '../../../common/customerWorkFinancial';
export * from '../../../common/customerWorkFinancial';
export {customerWorkRequestKey};
export const CUSTOMER_FINANCIAL_STORAGE='customer_work_financial_pending_v1';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export function customerFinancialPending():CustomerFinancialIntent[]{const value=uni.getStorageSync(CUSTOMER_FINANCIAL_STORAGE);if(value===undefined||value===null||value==='')return[];assert(Array.isArray(value)&&value.length<=100&&value.every(isCustomerFinancialIntent)&&new Set(value.map(intent=>intent.request_key)).size===value.length,'原财务操作记录损坏，请保留记录并核对');return JSON.parse(customerWorkCanonicalJson(value));}
export function retainCustomerFinancialIntent(intent:CustomerFinancialIntent){assert(isCustomerFinancialIntent(intent),'原财务意图无效，尚未提交');const prior=customerFinancialPending(),known=prior.find(row=>row.request_key===intent.request_key);if(known){assert(customerWorkCanonicalJson(known)===customerWorkCanonicalJson(intent),'同一财务请求编号不能替换内容');return;}assert(prior.length<100,'待核对财务操作过多，请先查询原结果');const next=JSON.parse(customerWorkCanonicalJson([...prior,intent]));uni.setStorageSync(CUSTOMER_FINANCIAL_STORAGE,next);assert(customerWorkCanonicalJson(customerFinancialPending())===customerWorkCanonicalJson(next),'原财务意图保存未确认，尚未提交');}
export function releaseCustomerFinancialIntent(key:string){assert(financialUuid(key),'原财务操作编号无效');const next=customerFinancialPending().filter(row=>row.request_key!==key);uni.setStorageSync(CUSTOMER_FINANCIAL_STORAGE,next);assert(customerWorkCanonicalJson(customerFinancialPending())===customerWorkCanonicalJson(next),'关闭原财务记录失败，请继续核对');}
export function customerFinancialNotice(code:string):string{
 if(!code)return'';
 const messages:Record<string,string>={customer_financial_operation_not_ready:'财务操作尚未完成验收，当前仅可查看。',customer_financial_operation_catalog_incompatible:'财务台账暂不可用，请核对后再处理。',customer_financial_not_ready:'财务操作暂不可用，请稍后重新读取。',provider_amount_out_of_range:'当前支付渠道最多支持 21,474,836.47 元，无法执行此次退款。',provider_not_ready:'当前退款渠道尚未准备好，请核对支付配置。',refund_received_confirmation_required:'请先实际收到并验收退货，再确认资金退款。',refund_already_processed:'当前退款申请已处理，请查询原结果。',payment_claim_started:'原支付渠道已开始处理，请先核对原支付结果。'};
 if(Object.hasOwn(messages,code))return messages[code]!;
 if(financialText(code,500)&&/[\u3400-\u9fff]/u.test(code)&&!/[\r\n]/u.test(code))return code;
 return'当前无法执行此财务操作，请重新读取并核对订单和原结果。';
}
export function customerFinancialResultMessage(result:CustomerFinancialResult|null):string{
 const receipt=result?.receipt;if(!receipt)return'原操作结果尚未确认，请继续查询原编号。';
 if(receipt.outcome==='balance-settled')return customerFinancialTerminal(result!)?'退款资金已核验完成。':'原退款账务尚未核验完成，请保留原编号继续核对。';
 if(receipt.outcome==='provider-admitted'){
  if(customerFinancialTerminal(result!))return'退款资金已核验完成，请核对原申请和订单。';
  const status=result?.execution?.status;
  if(status==='UNKNOWN')return'原退款渠道结果未知，请按原编号核对渠道结果，勿重新发起退款。';
  if(['FAILED','CLOSED','ABNORMAL'].includes(status??''))return'原退款渠道未确认成功，请保留原记录并核对，不能新建第二次退款。';
  return'退款渠道已受理，资金尚未确认完成，请继续查询原结果。';
 }
 return({ 'price-changed':'订单价格已核验修改。','offline-paid':'线下收款已核验确认。','refund-created':'退款申请已创建，资金尚未退回。请核对新申请后另行确认退款。','return-approved':'已同意退货，实际收货并验收后再确认资金退款。','refused':'退款申请已拒绝。','balance-settled':'退款资金已核验完成。','refund-remark-saved':'退款备注已核验保存。','abandoned':'尚未执行的原意图已放弃。','rollback-rejected':'原意图未执行，请重新核对当前权限与订单。'} as Record<string,string>)[receipt.outcome]??'原结果需进一步核对。';
}
