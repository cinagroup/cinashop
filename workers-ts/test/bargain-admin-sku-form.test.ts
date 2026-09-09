import { describe, expect, it } from 'vitest';
import { withBargainSku } from '../../view/admin-ts/src/api/bargainSkuEdit';
const options={productId:70,activityId:40,options:[{id:1,unique:'qared001',suk:'红',stock:8,quota:0,price:'10.00',image:''}],
  current:[{id:3,unique:'actred40',suk:'红',stock:6,quota:5,price:'10.00',image:''}]};
describe('actual admin SKU payload',()=>{
  it('keeps renames independent of stale or missing SKU reads',()=>{
    expect(withBargainSku({id:40,storeName:'改名'},null,'','',70)).toEqual({id:40,storeName:'改名'});
  });
  it('attaches exact original SKU inventory for deliberate edits',()=>{
    expect(withBargainSku({id:40,stock:7},options,'qared001','qared001',70)).toEqual({id:40,stock:7,sku:{baseUnique:'qared001',expected:{id:3,unique:'actred40',stock:6,quota:5}}});
  });
  it('requires a selection for creation and rejects another product snapshot',()=>{
    expect(()=>withBargainSku({},null,'','',70)).toThrow('加载');
    expect(()=>withBargainSku({id:40,stock:7},options,'qared001','qared001',71)).toThrow('加载');
    expect(withBargainSku({}, {...options,activityId:0,current:[]},'qared001','',70)).toEqual({sku:{baseUnique:'qared001'}});
  });
});
