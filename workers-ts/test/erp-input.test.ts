import { describe,expect,it } from 'vitest';
import { erpReadJson,erpUniqueJson,parseErpCallback } from '@/services/erp/ErpInput';
describe('bounded ERP callback JSON and exact legacy business selectors',()=>{
  it.each(['{"so_id":"A","so_id":"B"}','{"a":{"x":1,"x":2}}','{"a":[{"x":1,"\\u0078":2}]}','{"__proto__":{}}','{"a":1,}','{"a":-0}','{"x":"\\ud800"}'])('rejects ambiguous JSON %s',raw=>expect(()=>erpUniqueJson(raw)).toThrow());
  it('retains zero and escaped values without accepting duplicate escaped keys',()=>expect(erpUniqueJson('{"qty":0,"text":"雪\\/\\ud83d\\ude00"}')).toEqual({qty:0,text:'雪/😀'}));
  it('rejects an oversized/deep body and missing JSON content type',async()=>{
    expect(()=>erpUniqueJson('['.repeat(21)+'0'+']'.repeat(21))).toThrow();expect(()=>erpUniqueJson(' '.repeat(262145))).toThrow();
    await expect(erpReadJson(new Request('https://erp.invalid',{method:'POST',body:'{}'}))).rejects.toThrow('JSON');
  });
  it('rejects invalid UTF-8 instead of silently replacing signed input bytes',async()=>{
    await expect(erpReadJson(new Request('https://erp.invalid',{method:'POST',body:new Uint8Array([0xff]),headers:{'content-type':'application/json'}}))).rejects.toThrow('UTF-8');
  });
  it('projects inventory by real SKU code and shop with zero valid',()=>expect(parseErpCallback('stock',{datas:[{sku_id:'SKU-A',shop_id:12,qty:0}]})).toEqual({kind:'stock',items:[{code:'SKU-A',shopId:12,quantity:0,modified:'',sourceId:''}]}));
  it.each([{datas:[{sku_id:'SKU-A',shop_id:12,qty:0},{sku_id:'SKU-A',shop_id:12,qty:3}]},{datas:[{sku_id:'SKU-A',shop_id:12,qty:-1}]},{datas:[{sku_id:'SKU-A',shop_id:12,qty:1.5}]},{datas:[],admin_id:1}])('rejects ambiguous or invalid stock rows',value=>expect(()=>parseErpCallback('stock',value)).toThrow());
  it('uses full ERP order string, retaining underscores rather than guessing local base IDs',()=>expect(parseErpCallback('cancel',{so_id:'actual_local_root_2',remark:'取消'})).toEqual({kind:'cancel',orderId:'actual_local_root_2',remark:'取消'}));
  it('projects real express and immutable row selectors',()=>expect(parseErpCallback('deliver',{o_id:11,so_id:'root_2',l_id:'TRACK',lc_id:'SF',logistics_company:'顺丰',items:[{sku_id:'SKU-A',qty:2,outer_oi_id:'row-1'}]})).toMatchObject({kind:'deliver',providerOrderId:11,items:[{code:'SKU-A',quantity:2,externalRowId:'row-1'}]}));
  it('does not silently approve cancel-receive action or caller actor fields',()=>{
    expect(()=>parseErpCallback('refund-receive',{action_name:'取消收货'})).toThrow('尚不支持');expect(()=>parseErpCallback('cancel',{so_id:'A',admin_id:1})).toThrow('未知');
  });
});
