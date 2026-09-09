import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { storeBargain, storeProduct } from '../src/models/schema';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';

describe('bargain admin source product contract', () => {
  let f: Awaited<ReturnType<typeof createBargainSelectionFixture>>;
  beforeEach(async () => { f = await createBargainSelectionFixture(); }, 30_000);
  afterEach(async () => { await f?.close(); });
  const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined });
  const body = () => ({ productId:70, storeName:'商品资格', price:'10.00', minPrice:'2.00', people:2,stock:8,quota:8,sku:{baseUnique:'qared001'},
    startTime:f.startTime.toISOString(), stopTime:f.stopTime.toISOString() });
  for (const mode of ['create','edit'] as const) {
    it.each([
      [{ isVipProduct:1 }, 'SVIP'], [{ isPresaleProduct:1 }, '预售'],
      [{ isDel:1 }, '不可用'], [{ isVerify:0 }, '不可用'],
    ] as const)(`rejects ${mode} for source product %j`, async (patch, message) => {
      await f.db.update(storeProduct).set(patch).where(eq(storeProduct.id,70));
      const before=await snapshot();
      await expect(saveBargain(f.container,mode==='create'?body():{id:40,storeName:'不能绕过'})).rejects.toThrow(message);
      expect(await snapshot()).toEqual(before);
    });
  }
  it.each([0,1,2,3,4])('inherits trusted product type %s and its PHP delivery normalization', async productType => {
    const derived={type:2,relationId:88,productType,customForm:'[{"label":"备注"}]',systemFormId:7,storeLabelId:'3,4',ensureId:'6',specs:'[{"name":"产地","value":"上海"}]'};
    await f.db.update(storeProduct).set(derived).where(eq(storeProduct.id,70));
    const id=await saveBargain(f.container,{...body(),type:'bargain',relationId:999,productType:99,customForm:'forged',systemFormId:999,storeLabelId:'999',ensureId:'999',specs:'forged'});
    const [created]=await f.db.select().from(storeBargain).where(eq(storeBargain.id,id));
    expect(created).toMatchObject(derived);
    if(productType!==0) expect(created.deliveryType).toBe('2');
    if([1,2,3].includes(productType)) expect(created).toMatchObject({freight:2,tempId:0,postage:'0.00'});
  });
  it('refreshes only changed derived fields on edit without replaying inventory or pricing', async () => {
    const derived={type:1,relationId:9,productType:3,customForm:'[]',systemFormId:5,storeLabelId:'1',ensureId:'2',specs:'[]'};
    await f.db.update(storeProduct).set(derived).where(eq(storeProduct.id,70));
    const before=await snapshot();
    await saveBargain(f.container,{id:40,storeName:'合格改名'});
    expect(await snapshot()).toEqual({...before,bargains:before.bargains.map(row=>({...row,...derived,storeName:'合格改名',deliveryType:'2',freight:2,tempId:0,postage:'0.00'}))});
  });
  it('clears stale inherited fields when the source fields were removed', async () => {
    await f.db.update(storeBargain).set({customForm:'old',systemFormId:9,storeLabelId:'1',ensureId:'2',specs:'old'});
    await saveBargain(f.container,{id:40});
    expect((await snapshot()).bargains[0]).toMatchObject({customForm:null,systemFormId:0,storeLabelId:null,ensureId:null,specs:null});
  });
  it('keeps PHP save eligibility distinct from public on-sale visibility', async () => {
    await f.db.update(storeProduct).set({isShow:0}).where(eq(storeProduct.id,70));
    await expect(saveBargain(f.container,{id:40,storeName:'尚未上架可配置'})).resolves.toBe(40);
  });
  it('rejects rebinding an existing activity to another product', async () => {
    await f.db.insert(storeProduct).values({id:71,storeName:'新原商品',isVerify:1,isVipProduct:1});
    const before=await snapshot();
    await expect(saveBargain(f.container,{id:40,productId:71})).rejects.toThrow('不能更换原商品');
    expect(await snapshot()).toEqual(before);
  });
});
