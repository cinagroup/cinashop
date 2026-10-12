import {describe,expect,it} from 'vitest';
import {LEGACY_PHP_REFUND_LINE_VERSION,projectLegacyPhpRefundLine} from '../src/services/order/LegacyPhpRefundLineFinance';
import {planOrderFinancialSplit} from '../src/services/order/OrderSplitFinance';

const order={id:7,uid:11,payPostage:'0.00',totalPostage:'0.00',divisionStaffBrokerage:'0.00',divisionAgentBrokerage:'0.00',divisionBrokerage:'0.00',promotionsPrice:'0.00',gainIntegral:'2.00'};
const row={oid:7,uid:11,cartId:'php-original-cart',cartNum:3,productId:70,skuUnique:'original-sku',isGift:0,writeTimes:6,promotionsId:''};
const original={id:'php-original-cart',cart_num:3,sum_price:'5.00',costPrice:'1.00',sum_true_price:'12.00',coupon_price:'2.00',integral_price:'1.00',first_order_price:'0.00',one_brokerage:'0.30',two_brokerage:'0.00',use_integral:10,integral:0,
 productInfo:{id:70,store_name:'原PHP商品',give_integral:'0.90',attrInfo:{id:71,unique:'original-sku',price:'5.00',cost:'1.00',write_times:2}}};
describe('immutable original PHP refund financial projection',()=>{
 it('projects original facts with a distinct version and preserves the entire source',()=>{
  const before=JSON.stringify(original),projected=projectLegacyPhpRefundLine(order,row,original,true);
  expect(projected).toMatchObject({financial_version:LEGACY_PHP_REFUND_LINE_VERSION,legacy_php_financial_source:'original-php-purchase-facts-v1',sum_true_price:'12.00',raw_postage_price:'0.00',gain_integral:'2',sku:{id:71,unique:'original-sku',write_times:2},product:{storeName:'原PHP商品',giveIntegral:'0.90'}});
  expect(JSON.stringify(original)).toBe(before);expect(projected?.financial_version).not.toBe('checkout-line-finance-v1');
 });
 it('assigns an existing whole amount to its sole actual paying line, never by weights',()=>{
  const projected=projectLegacyPhpRefundLine({...order,payPostage:'3.00',totalPostage:'4.00',divisionBrokerage:'1.50'},row,original,true);
  expect(projected).toMatchObject({postage_price:'3.00',raw_postage_price:'4.00',division_brokerage:'1.50'});
  expect(projectLegacyPhpRefundLine({...order,totalPostage:'4.00'},row,original,false)).toBeNull();
 });
 it('proves zero missing line allocations from exact nonnegative order totals',()=>{
  expect(projectLegacyPhpRefundLine(order,row,original,false)).toMatchObject({postage_price:'0.00',raw_postage_price:'0.00',division_brokerage:'0.00'});
 });
 it('admits the actual nullable promotions_id only when original order and price facts prove no promotion',()=>{
  const nullable={...row,promotionsId:null};expect(projectLegacyPhpRefundLine(order,nullable,original,true)).toMatchObject({promotions_true_price:'0.00'});
  expect(projectLegacyPhpRefundLine({...order,promotionsPrice:'0.01'},nullable,original,true)).toBeNull();
  expect(projectLegacyPhpRefundLine(order,nullable,{...original,price_type:'promotions'},true)).toBeNull();
  expect(projectLegacyPhpRefundLine(order,{...nullable,promotionsId:'1'},original,true)).toBeNull();
 });
 it('does not reinterpret a mature minimal versionless nonmaterialized source as original PHP financial evidence',()=>{
  expect(projectLegacyPhpRefundLine(order,row,{product:{storeName:'旧成熟商品'},sku:{price:'5.00',suk:'Red'}},true)).toBeNull();
 });
 const minimal={product:{storeName:'旧成熟商品'},sku:{price:'5.00',suk:'Red'}};
 const planningOrder={id:order.id,uid:order.uid} as Parameters<typeof planOrderFinancialSplit>[0];
 const planningCart=(info:Record<string,unknown>)=>({...row,id:1,cartInfo:JSON.stringify(info)}) as Parameters<typeof planOrderFinancialSplit>[1][number];
 const completeOrder={...order,totalNum:3,payIntegral:0,totalPrice:'15.00',payPrice:'12.00',changePrice:'0.00',cost:'3.00',couponPrice:'2.00',deductionPrice:'1.00',firstOrderPrice:'0.00',oneBrokerage:'0.30',twoBrokerage:'0.00',useIntegral:'10.00',refundPrice:'0.00',backIntegral:'0.00'} as Parameters<typeof planOrderFinancialSplit>[0];
 const completeCart=(info:Record<string,unknown>)=>({...planningCart(info),refundNum:0,splitStatus:0,splitSurplusNum:3,writeSurplusTimes:6,writeoffTime:0,isWriteoff:0});
 it('derives original PHP provenance only after complete reconciliation and retains it on a parsed successor',()=>{
  const plan=planOrderFinancialSplit(completeOrder,[completeCart(original)],new Map([[row.cartId,1]]));expect(plan?.legacyPhpProjection).toBe('original-purchase');
  const remaining=JSON.parse(plan!.carts.get(row.cartId)!.remaining!);remaining.financial_version='refund-order-line-finance-v1';remaining.refund_order_generation={refundId:10,role:'remaining'};
  const successor={...completeCart(remaining),cartNum:2,writeTimes:4,writeSurplusTimes:4,splitSurplusNum:2};
  expect(planOrderFinancialSplit({...completeOrder,...plan!.remaining},[successor],new Map([[row.cartId,1]]))?.legacyPhpProjection).toBe('refund-generation');
 });
 it('keeps a complete modern zero-promotion plan outside the extra PHP ledger gate and rejects a forged PHP tag',()=>{
  const projected=projectLegacyPhpRefundLine(order,row,original,true)!;const modern:Record<string,unknown>={...projected,financial_version:'checkout-line-finance-v1'};delete modern.legacy_php_financial_source;
  expect(planOrderFinancialSplit(completeOrder,[completeCart(modern)],new Map([[row.cartId,1]]))?.legacyPhpProjection).toBeNull();
  expect(()=>planOrderFinancialSplit(completeOrder,[completeCart({...modern,legacy_php_financial_source:'original-php-purchase-facts-v1'})],new Map([[row.cartId,1]]))).toThrow('拆单财务快照不一致');
 });
 it('preserves actual plan null fallback for a wholly minimal old source without any protocol metadata',()=>{
  expect(planOrderFinancialSplit(planningOrder,[planningCart(minimal)],new Map([[row.cartId,1]]))).toBeNull();
 });
 it.each(['refund_order_generation','promotion_quote_version','member_savings_version','legacy_php_financial_source','raw_postage_price','gain_integral'])('actual plan rejects torn protocol metadata %s instead of nullable legacy fallback',key=>{
  expect(()=>planOrderFinancialSplit(planningOrder,[planningCart({...minimal,[key]:'incomplete'})],new Map([[row.cartId,1]]))).toThrow('拆单财务快照不一致');
 });
 it.each([0,'0',null,undefined])('uses original PHP max/default single-use rule for attr write_times=%s while preserving raw facts',raw=>{
  const productInfo={...original.productInfo,attrInfo:{...original.productInfo.attrInfo,write_times:raw}},source={...original,productInfo},before=JSON.stringify(source);
  expect(projectLegacyPhpRefundLine(order,{...row,writeTimes:3},source,true)).toMatchObject({sku:{write_times:1}});expect(JSON.stringify(source)).toBe(before);
 });
 it.each([-1,0.5,true,'01','1.0'])('rejects noncanonical raw PHP write_times=%s instead of coercing it',raw=>{
  const source={...original,productInfo:{...original.productInfo,attrInfo:{...original.productInfo.attrInfo,write_times:raw}}};
  expect(()=>projectLegacyPhpRefundLine(order,{...row,writeTimes:3},source,true)).toThrow();
 });
 it.each(['costPrice','sum_true_price','coupon_price','one_brokerage','use_integral'] as const)('never reconstructs missing original %s from current product data',async key=>{
  const source:Record<string,unknown>={...original};delete source[key];expect(projectLegacyPhpRefundLine(order,row,source,true)).toBeNull();
 });
 it.each(['financial_version','refund_order_generation','promotion_quote_version','member_savings_version','legacy_php_financial_source','product','sku'] as const)('rejects mixed or forged modern metadata %s rather than falling back',key=>{
  expect(()=>projectLegacyPhpRefundLine(order,row,{...original,[key]:'invalid'},true)).toThrow();
 });
 it.each([{uid:0},{cartNum:2},{skuUnique:'another-sku'},{productId:71},{writeTimes:5}])('rejects contradictory original physical identity %j',patch=>{
  expect(()=>projectLegacyPhpRefundLine(order,{...row,...patch},original,true)).toThrow();
 });
 it('retains PHP bcmul scale 0 for fractional per-unit gifts and rejects a changed grant',()=>{
  expect(projectLegacyPhpRefundLine(order,row,original,true)?.gain_integral).toBe('2');
  expect(()=>projectLegacyPhpRefundLine(order,row,{...original,gain_integral:'3'},true)).toThrow();
 });
 it('does not invent absent historical promotion allocation or a positive gift grant',()=>{
  expect(projectLegacyPhpRefundLine({...order,promotionsPrice:'1.00'},row,original,true)).toBeNull();
  const productInfo={...original.productInfo};delete (productInfo as {give_integral?:string}).give_integral;
  expect(projectLegacyPhpRefundLine(order,row,{...original,productInfo},true)).toBeNull();
 });
});
