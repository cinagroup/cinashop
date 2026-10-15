import {describe,expect,it} from 'vitest';
import {parseOrdinaryCashierDraft,parseOrdinaryCashierIntent,parseOrdinaryCashierAddRows,parseOrdinaryCashierPayment} from '../src/services/customer-work/CustomerOrdinaryCashierContract';

const scope='a'.repeat(64),key='11111111-1111-4111-8111-111111111111';
const draft={version:'customer-cashier-ordinary-v1',scope_key:scope,buyer_uid:11,tourist_key:'',rows:[{product_id:70,sku_unique:'blue',quantity:2},{product_id:70,sku_unique:'red',quantity:3}]};
const intent={version:draft.version,scope_key:scope,draft_key:key,draft_hash:'b'.repeat(64),buyer_uid:11,tourist_key:'',coupon_id:8,use_integral:true,
 shipping_type:1,store_id:0,address_id:11,manual_address:null,real_name:'',user_phone:'',mark:'已确认实际购买人',custom_form:[]};
describe('ordinary cashier external input authority',()=>{
 it('keeps all real SKU selections and member coupon/points/address choices',()=>{
  expect(parseOrdinaryCashierDraft(draft).rows).toHaveLength(2);
  expect(parseOrdinaryCashierIntent(intent)).toMatchObject({buyer_uid:11,coupon_id:8,use_integral:true,address_id:11,real_name:'',user_phone:''});
 });
 it('rejects a client principal, price, cart identity or provider capability hidden in the body',()=>{
  for(const extra of [{actor_uid:101},{staff_id:101},{price:'0.00'},{creator:true},{provider_ready:true}])expect(()=>parseOrdinaryCashierDraft({...draft,...extra})).toThrow();
  expect(()=>parseOrdinaryCashierDraft({...draft,rows:[{...draft.rows[0],cart_id:9}]})).toThrow();
  expect(()=>parseOrdinaryCashierIntent({...intent,pay_type:'weixin'})).toThrow();
 });
 it('rejects mixed guest accounts and every account-based guest entitlement',()=>{
  const guest={...intent,buyer_uid:0,tourist_key:'actual-guest',coupon_id:0,use_integral:false,address_id:0,shipping_type:2};
  expect(parseOrdinaryCashierIntent(guest)).toMatchObject({buyer_uid:0,tourist_key:'actual-guest'});
  for(const extra of [{tourist_key:''},{coupon_id:8},{use_integral:true},{address_id:11}])expect(()=>parseOrdinaryCashierIntent({...guest,...extra})).toThrow();
  expect(()=>parseOrdinaryCashierIntent({...intent,tourist_key:'other-guest'})).toThrow();
 });
 it('requires a complete sole delivery source and does not mix pickup with an address',()=>{
  const manual={realName:'实际购买人',phone:'00000000000',province:'省',city:'市',district:'区',street:'',detail:'真实门牌',cityId:101};
  expect(parseOrdinaryCashierIntent({...intent,address_id:0,manual_address:manual})).toMatchObject({manual_address:manual});
  expect(()=>parseOrdinaryCashierIntent({...intent,manual_address:manual})).toThrow();
  expect(()=>parseOrdinaryCashierIntent({...intent,address_id:0})).toThrow();
  expect(()=>parseOrdinaryCashierIntent({...intent,shipping_type:2})).toThrow();
  expect(()=>parseOrdinaryCashierIntent({...intent,address_id:0,manual_address:{...manual,cityId:0}})).toThrow();
 });
 it('snapshots untrusted rows instead of retaining references; append validates rows without a synthetic buyer',()=>{
  const input=structuredClone(draft),frozen=parseOrdinaryCashierDraft(input);
  input.rows[0].quantity=99;expect(frozen.rows[0].quantity).toBe(2);expect(Object.isFrozen(frozen.rows[0])).toBe(true);
  expect(parseOrdinaryCashierAddRows({version:draft.version,scope_key:scope,draft_key:key,draft_hash:'b'.repeat(64),rows:draft.rows}).rows).toHaveLength(2);
  expect(()=>parseOrdinaryCashierDraft({...draft,rows:[draft.rows[0],draft.rows[0]]})).toThrow();
  expect(()=>parseOrdinaryCashierDraft({...draft,rows:[{...draft.rows[0],quantity:'2'}]})).toThrow();
 });
 it('binds cash/true zero to the exact physical order and fixed decimal amount',()=>{
  const payment={version:'customer-cashier-ordinary-payment-v1',scope_key:scope,order_id:101,order_no:'ORDINARY-101',expected_amount:'0.00'};
  expect(parseOrdinaryCashierPayment(payment).expected_amount).toBe('0.00');
  for(const amount of ['0','0.0','00.00','-1.00','1e3','NaN'])expect(()=>parseOrdinaryCashierPayment({...payment,expected_amount:amount})).toThrow();
  expect(()=>parseOrdinaryCashierPayment({...payment,payer_uid:11})).toThrow();
 });
});
