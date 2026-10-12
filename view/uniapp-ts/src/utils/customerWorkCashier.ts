import {customerWorkCanonicalJson,customerWorkSha256} from '../../../common/customerWorkIntent';
import {customerWorkRequestKey} from './customerWorkFulfillment';
import {customerWorkRecord,customerWorkDate} from './customerWork';
import {customerCashierOrderNo,isCustomerCashierRecordDetail} from './customerWorkCashierRead';
import {isCustomerCashierSystemForm} from './customerWorkCashierCatalog';
import type {CustomerCashierInput,CustomerCashierIntent,CustomerCashierCreationIntent,CustomerCashierPaymentInput,CustomerCashierQuote,CustomerCashierReceipt,CustomerCashierCard,CustomerCashierAbandonDecision} from '@/types/customerWorkCashier';
import type {CustomerCashierRecordDetail} from '@/types/customerWorkCashierRead';
export {customerWorkCanonicalJson,customerWorkRequestKey};
export const CUSTOMER_CASHIER_STORAGE='customer_cashier_pending_v1';
export const CUSTOMER_CASHIER_ABANDON_STORAGE='customer_cashier_abandon_pending_v1';
export const cashierId=(v:unknown,zero=false):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=(zero?0:1)&&v<=2147483647;
export const cashierHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
export const cashierUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&v.length<=max&&(empty||v.length>0)&&v.trim()===v&&!/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/gu,''));
const money=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,9})\.\d{2}$/u.test(v);
function exact(v:Record<string,unknown>,keys:string[]){return Object.keys(v).sort().join('|')===keys.sort().join('|');}
function json(v:unknown){try{return customerWorkCanonicalJson(v).length<=65536;}catch{return false;}}
export const cashierIntentHash=(body:unknown)=>customerWorkSha256(customerWorkCanonicalJson(body));
export function isCustomerCashierInput(v:unknown):v is CustomerCashierInput {
  return customerWorkRecord(v)&&exact(v,['version','scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity','real_name','user_phone','mark','custom_form','coupon_id','use_integral'])
    &&v.version==='customer-cashier-second-card-v1'&&cashierHash(v.scope_key)&&cashierId(v.buyer_uid,true)
    &&text(v.tourist_key,50,true)&&(v.buyer_uid===0?/^[A-Za-z0-9_-]{1,50}$/u.test(v.tourist_key):v.tourist_key==='')
    &&cashierId(v.product_id)&&text(v.sku_unique,16)&&cashierId(v.quantity)&&v.quantity<=32767
    &&text(v.real_name,32)&&text(v.user_phone,20)&&text(v.mark,512,true)&&json(v.custom_form)&&cashierId(v.coupon_id,true)&&typeof v.use_integral==='boolean';
}
export function isCustomerCashierPaymentInput(v:unknown):v is CustomerCashierPaymentInput {
  return customerWorkRecord(v)&&exact(v,['version','scope_key','order_id','order_no','expected_amount'])&&v.version==='customer-cashier-second-card-payment-v1'
    &&cashierHash(v.scope_key)&&cashierId(v.order_id)&&customerCashierOrderNo(v.order_no)&&money(v.expected_amount);
}
export function isCustomerCashierIntent(v:unknown):v is CustomerCashierIntent {
  if(!customerWorkRecord(v)||v.version!=='customer-cashier-pending-v1'||!cashierId(v.actor_uid)||!cashierId(v.service_id)||!cashierUuid(v.request_key)||!cashierHash(v.request_hash)||!cashierId(v.created_at))return false;
  if(v.kind==='creation')return exact(v,['version','actor_uid','service_id','request_key','request_hash','created_at','kind','body'])&&isCustomerCashierInput(v.body)&&cashierIntentHash(v.body)===v.request_hash;
  return v.kind==='payment'&&exact(v,['version','actor_uid','service_id','request_key','request_hash','created_at','kind','body','buyer_uid','origin_hash','creation_key'])
    &&isCustomerCashierPaymentInput(v.body)&&cashierId(v.buyer_uid,true)&&cashierHash(v.origin_hash)&&cashierUuid(v.creation_key)&&cashierIntentHash(v.body)===v.request_hash;
}
function assert(v:unknown,message:string):asserts v{if(!v)throw Error(message);}
function financialPending():CustomerCashierIntent[]{const v=uni.getStorageSync(CUSTOMER_CASHIER_STORAGE);if(v===undefined||v===null||v==='')return[];
  assert(Array.isArray(v)&&v.length<=100&&v.every(isCustomerCashierIntent)&&new Set(v.map(row=>row.request_key)).size===v.length,'本机原收银记录损坏，请保留并核对');return JSON.parse(customerWorkCanonicalJson(v));}
export function customerCashierAbandonPending():CustomerCashierAbandonDecision[]{const v=uni.getStorageSync(CUSTOMER_CASHIER_ABANDON_STORAGE);if(v===undefined||v===null||v==='')return[];
  assert(Array.isArray(v)&&v.length<=100&&v.every(row=>customerWorkRecord(row)&&exact(row,['version','actor_uid','request_key','kind','request_hash','intent'])
    &&row.version==='customer-cashier-abandon-pending-v1'&&isCustomerCashierIntent(row.intent)&&row.actor_uid===row.intent.actor_uid
    &&row.request_key===row.intent.request_key&&row.kind===row.intent.kind&&row.request_hash===row.intent.request_hash)
    &&new Set(v.map(row=>row.request_key)).size===v.length,'本机原放弃决定损坏，请保留并核对');return JSON.parse(customerWorkCanonicalJson(v));}
/** An interrupted two-storage close remains recoverable from the complete abandonment decision. */
export function customerCashierPending():CustomerCashierIntent[]{const pending=financialPending();for(const decision of customerCashierAbandonPending()){
  const prior=pending.find(row=>row.request_key===decision.request_key);assert(!prior||customerWorkCanonicalJson(prior)===customerWorkCanonicalJson(decision.intent),'原放弃决定与收银内容不匹配');
  if(!prior)pending.push(decision.intent);
}assert(pending.length<=100,'待核对收银记录过多，请保留并核对');return pending;}
export function customerCashierAbandonRequested(intent:CustomerCashierIntent):boolean {
  const decision=customerCashierAbandonPending().find(row=>row.request_key===intent.request_key);
  assert(!decision||customerWorkCanonicalJson(decision.intent)===customerWorkCanonicalJson(intent),'原放弃决定与收银内容不匹配');return!!decision;
}
export function retainCustomerCashierAbandonDecision(intent:CustomerCashierIntent){assert(isCustomerCashierIntent(intent)&&customerCashierPending().some(row=>customerWorkCanonicalJson(row)===customerWorkCanonicalJson(intent)),'完整原收银内容尚未保存，不能放弃');
  const prior=customerCashierAbandonPending();if(customerCashierAbandonRequested(intent))return;
  assert(prior.length<100,'待核对放弃决定过多，请先查询原结果');const next=[...prior,{version:'customer-cashier-abandon-pending-v1',actor_uid:intent.actor_uid,request_key:intent.request_key,kind:intent.kind,request_hash:intent.request_hash,intent}];
  uni.setStorageSync(CUSTOMER_CASHIER_ABANDON_STORAGE,JSON.parse(customerWorkCanonicalJson(next)));assert(customerWorkCanonicalJson(customerCashierAbandonPending())===customerWorkCanonicalJson(next),'本机放弃决定保存未确认，尚未提交');}
export function retainCustomerCashierIntent(intent:CustomerCashierIntent){assert(isCustomerCashierIntent(intent),'原收银意图无效，尚未提交');const prior=customerCashierPending(),known=prior.find(row=>row.request_key===intent.request_key);
  if(known){assert(customerWorkCanonicalJson(known)===customerWorkCanonicalJson(intent),'同一收银编号不能替换内容');return;}assert(prior.length<100,'待核对收银记录过多，请先查询原结果');
  const next=JSON.parse(customerWorkCanonicalJson([...prior,intent]));uni.setStorageSync(CUSTOMER_CASHIER_STORAGE,next);assert(customerWorkCanonicalJson(customerCashierPending())===customerWorkCanonicalJson(next),'本机原收银记录保存未确认，尚未提交');}
export function releaseCustomerCashierIntent(key:string){assert(cashierUuid(key),'原收银编号无效');const next=financialPending().filter(row=>row.request_key!==key);uni.setStorageSync(CUSTOMER_CASHIER_STORAGE,next);assert(customerWorkCanonicalJson(financialPending())===customerWorkCanonicalJson(next),'本机原收银记录关闭失败');
  const decisions=customerCashierAbandonPending(),remaining=decisions.filter(row=>row.request_key!==key);if(remaining.length!==decisions.length){uni.setStorageSync(CUSTOMER_CASHIER_ABANDON_STORAGE,remaining);assert(customerWorkCanonicalJson(customerCashierAbandonPending())===customerWorkCanonicalJson(remaining),'本机原放弃决定关闭失败，请保留原编号');}}
export function cashierCardValidityText(card:CustomerCashierCard):string{return card.write_valid===1?'长期有效':card.write_valid===2?`付款后 ${card.write_days} 天`:`${customerWorkDate(card.write_start)} 至 ${customerWorkDate(card.write_end)}`;}
export function parseCustomerCashierQuote(v:unknown,intent:CustomerCashierCreationIntent,cartId:number):CustomerCashierQuote {
  assert(customerWorkRecord(v)&&typeof v.quote_token==='string'&&/^[a-f0-9]{32}$/u.test(v.quote_token)&&customerWorkRecord(v.quote),'次卡收银报价不完整');const q=v.quote;
  assert(cashierHash(q.confirmationFingerprint)&&cashierId(q.systemFormId,true)&&q.totalNum===intent.body.quantity&&Array.isArray(q.items)&&q.items.length===1,'报价选品或数量不匹配');
  for(const key of ['rawTotalCents','totalCents','payCents','couponPriceCents','firstOrderPriceCents','deductionCents','usedIntegralPoints','surplusIntegralPoints','memberDiscountCents','promotionSavingsCents'])assert(typeof q[key]==='number'&&Number.isSafeInteger(q[key])&&Number(q[key])>=0&&Number(q[key])<=999999999999,'实际报价金额或积分无效');
  assert(customerWorkRecord(q.items[0])&&q.items[0].cartId===cartId&&typeof q.items[0].totalPriceCents==='number'&&Number.isSafeInteger(q.items[0].totalPriceCents)&&q.items[0].totalPriceCents>=0,'报价购物行不匹配');
  assert(customerWorkRecord(v.pricing)&&v.pricing.amount===cashierCents(Number(q.payCents))&&v.pricing.total===cashierCents(Number(q.totalCents))&&v.pricing.quantity===intent.body.quantity,'实际报价总额投影不匹配');
  const card=v.card;assert(customerWorkRecord(card)&&exact(card,['product_id','sku_unique','quantity','unit_write_times','total_write_times','write_valid','write_days','write_start','write_end'])
    &&card.product_id===intent.body.product_id&&card.sku_unique===intent.body.sku_unique&&card.quantity===intent.body.quantity
    &&cashierId(card.unit_write_times)&&cashierId(card.total_write_times)&&card.total_write_times===card.unit_write_times*intent.body.quantity
    &&[1,2,3].includes(Number(card.write_valid))&&typeof card.write_valid==='number'&&cashierId(card.write_days,true)&&cashierId(card.write_start,true)&&cashierId(card.write_end,true)
    &&(card.write_valid!==2||card.write_days>0)&&(card.write_valid!==3||card.write_start>0&&card.write_end>card.write_start),'实际次卡次数或有效期无法核对');
  assert(customerWorkRecord(q.card)&&customerWorkCanonicalJson(q.card)===customerWorkCanonicalJson(card),'实际次卡权益投影不匹配');
  assert(v.system_form===null?q.systemFormId===0:isCustomerCashierSystemForm(v.system_form)&&v.system_form.id===q.systemFormId,'实际报价系统表单不匹配');
  return JSON.parse(customerWorkCanonicalJson(v));
}
export function parseCustomerCashierReceipt(v:unknown,intent:CustomerCashierIntent):CustomerCashierReceipt {
  assert(customerWorkRecord(v)&&v.version==='customer-cashier-receipt-v1'&&v.actor_uid===intent.actor_uid&&v.kind===intent.kind&&v.request_key===intent.request_key,'原收银回执身份或编号不匹配');
  const abandonment=v.abandonment===undefined?null:v.abandonment;
  if(abandonment!==null){assert(v.receipt===null&&customerWorkRecord(abandonment)&&exact(abandonment,['version','actor_uid','request_key','kind','request_hash','scope_key','intent','created_at'])
    &&abandonment.version==='customer-cashier-abandon-v1'&&abandonment.actor_uid===intent.actor_uid&&abandonment.request_key===intent.request_key
    &&abandonment.kind===intent.kind&&abandonment.request_hash===intent.request_hash&&abandonment.scope_key===intent.body.scope_key
    &&customerWorkCanonicalJson(abandonment.intent)===customerWorkCanonicalJson(intent.body)&&cashierIntentHash(abandonment.intent)===intent.request_hash
    &&typeof abandonment.created_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(abandonment.created_at)&&Number.isFinite(Date.parse(abandonment.created_at)),'原永久放弃事实无法核对');}
  if(v.receipt===null)return JSON.parse(customerWorkCanonicalJson({...v,abandonment}));
  const row=v.receipt;assert(customerWorkRecord(row)&&cashierId(row.order_id)&&row.request_hash===intent.request_hash&&customerWorkRecord(row.evidence),'原收银回执内容不匹配');const e=row.evidence;
  if(intent.kind==='creation'){
    assert(e.version==='cashier-second-card-origin-v1'&&e.creator_kind==='customer'&&e.creator_uid===intent.actor_uid&&e.service_id===intent.service_id&&e.buyer_uid===intent.body.buyer_uid&&e.scope_key===intent.body.scope_key&&e.root_order_id===row.order_id&&customerCashierOrderNo(e.root_order_no)&&e.creation_key===intent.request_key&&e.creation_hash===intent.request_hash&&cashierHash(e.quote_fingerprint)&&cashierId(e.creation_status_id)&&Array.isArray(e.cart_facts)&&e.cart_facts.length===1&&cashierHash(row.origin_hash)&&cashierIntentHash(e)===row.origin_hash,'原次卡创建事实无法核对');
    const c=e.cart_facts[0];assert(customerWorkRecord(c)&&cashierId(c.cart_row_id)&&text(c.opaque_cart_id,64)&&c.product_id===intent.body.product_id&&c.product_type===4&&cashierId(c.owner_type,true)&&[0,1,2].includes(c.owner_type)&&cashierId(c.owner_id,true)&&c.sku_unique===intent.body.sku_unique&&c.purchase_quantity===intent.body.quantity&&cashierId(c.write_times)&&c.write_times%intent.body.quantity===0&&cashierHash(c.snapshot_hash),'原次卡购买数量或商品无法核对');
  }else assert(e.version==='cashier-second-card-payment-v1'&&row.order_id===intent.body.order_id&&e.order_id===intent.body.order_id&&e.order_no===intent.body.order_no&&e.buyer_uid===intent.buyer_uid&&e.creator_uid===intent.actor_uid&&e.paid===1&&e.pay_type==='cash'&&cashierId(e.pay_time)&&e.amount===intent.body.expected_amount&&e.trade_no===''&&cashierId(e.status_id)&&cashierId(e.outbox_id)&&e.event_key===`order.paid:${intent.body.order_id}`&&cashierHash(e.payload_hash)&&e.origin_hash===intent.origin_hash,'原现金付款事实无法核对');
  return JSON.parse(customerWorkCanonicalJson({...v,abandonment}));
}
export function cashierReceiptTarget(receipt:CustomerCashierReceipt){assert(receipt.receipt,'原收银结果尚未确认');const e=receipt.receipt.evidence;return{id:receipt.receipt.order_id,no:String(receipt.kind==='creation'?e.root_order_no:e.order_no)};}
export function verifyCustomerCashierDetail(d:CustomerCashierRecordDetail,intent:CustomerCashierIntent){assert(isCustomerCashierRecordDetail(d)&&d.record.creator_uid===intent.actor_uid,'本人真实收银订单无法核对');
  if(intent.kind==='creation'){
    assert(d.creation.request_key===intent.request_key&&d.creation.request_hash===intent.request_hash&&d.creation.service_id===intent.service_id&&d.record.buyer_uid===intent.body.buyer_uid&&d.items[0]?.product_id===intent.body.product_id&&d.items[0]?.sku_unique===intent.body.sku_unique&&d.items[0]?.quantity===intent.body.quantity,'真实次卡订单与原创建内容不符');
    let answers:unknown=intent.body.custom_form;
    if(typeof answers==='string'){try{answers=JSON.parse(answers);}catch{throw Error('原收银表单内容无效');}}
    if(Array.isArray(answers))for(let index=0;index<answers.length;index++){
      const original=answers[index];
      if(!customerWorkRecord(original)||original.name!=='uploadPicture'||!Array.isArray(original.value)||original.value.length===0)continue;
      assert(original.value.every(v=>typeof v==='string'&&/^\/api\/assets\/[1-9]\d{0,9}$/u.test(v)),'原收银图片引用无效');
      assert(d.form&&d.form.session_key===intent.request_key,'真实次卡订单缺少原图片消费证明');
      const actual=typeof original.id==='number'||typeof original.id==='string'
        ?d.form.components.find(v=>typeof v.id===typeof original.id&&v.id===original.id):d.form.components[index];
      assert(actual?.name==='uploadPicture'&&customerWorkCanonicalJson(actual.value)===customerWorkCanonicalJson(original.value),'真实次卡订单图片与原创建内容不符');
    }
  }
  else assert(d.record.id===intent.body.order_id&&d.record.order_no===intent.body.order_no&&d.record.buyer_uid===intent.buyer_uid&&d.creation.request_key===intent.creation_key&&d.record.origin_hash===intent.origin_hash&&d.record.amount===intent.body.expected_amount&&d.payment?.request_key===intent.request_key,'真实现金订单与原付款回执不符');
}
export const cashierCents=(cents:number)=>(cents/100).toFixed(2);
