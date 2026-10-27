import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { user, userBrokerage, userExtract, userMoney } from '@/models/schema';
import { V2UserCompatibilityService } from '@/services/user/V2UserCompatibilityService';
import { legacyDistributionLedgerPeriod } from '@/services/user/DistributionLedgerRead';
import { financeMemoryPostgres } from './helpers/financePostgres';

const day=Date.parse('2026-09-30T16:00:00Z')/1000;
let f:Awaited<ReturnType<typeof financeMemoryPostgres>>,service:V2UserCompatibilityService;
beforeAll(async()=>{f=await financeMemoryPostgres([user,userBrokerage,userExtract,userMoney]);service=new V2UserCompatibilityService(createContainerFromDb(f.db));},30000);
afterAll(async()=>{await f?.close();});
beforeEach(async()=>{await f.reset();await f.db.insert(user).values([{uid:7,nickname:'当前推广人',account:'owner',phone:'13811111117'},{uid:8,nickname:'订单买家'}]);});
describe('distribution ledger3/4 targeted PHP compatibility',()=>{
 it('expands only equal or Shanghai-midnight stops and retains closed zero-ended arrays',()=>{
  expect(legacyDistributionLedgerPeriod(0,0)).toBeNull();
  expect(legacyDistributionLedgerPeriod(day,day)).toEqual({start:day,stop:day+86400});
  expect(legacyDistributionLedgerPeriod(day+100,day+100)).toEqual({start:day+100,stop:day+86500});
  expect(legacyDistributionLedgerPeriod(day-1,day)).toEqual({start:day-1,stop:day+86400});
  expect(legacyDistributionLedgerPeriod(day,day+86399)).toEqual({start:day,stop:day+86399});
  expect(legacyDistributionLedgerPeriod(day,0)).toEqual({start:day,stop:0});
 });
 it('restores inclusive day expansion in brokerage and withdrawal but leaves balance ledger0 unexpanded',async()=>{
  const times=[day-1,day,day+86399,day+86400,day+86401];
  await f.db.insert(userBrokerage).values(times.map((addTime,i)=>({id:i+1,uid:7,type:'extract',title:'提现',number:'1.00',addTime})));
  await f.db.insert(userMoney).values(times.map((addTime,i)=>({id:i+1,uid:7,type:'system_add',number:'1.00',addTime})));
  for(const result of [await service.brokerageList(7,{start:day,stop:day}),await service.extractList(7,{start:day,stop:day,keyword:'ignored'})])expect(result.list.map(row=>row.id)).toEqual([4,3,2]);
  expect((await service.moneyList(7,0,{start:day,stop:day})).list.map(row=>row.id)).toEqual([2]);
  expect((await service.brokerageList(7,{start:day,stop:0})).list).toEqual([]);
  expect((await service.extractList(7,{start:0,stop:day})).list.map(row=>row.id)).toEqual([4,3,2,1]);
  for(const result of [await service.brokerageList(7,{start:2147483647,stop:2147483647}),await service.extractList(7,{start:2147483647,stop:2147483647})])expect(result.list).toEqual([]);
 });
 it('keeps full sums beyond numeric14,2 and excludes only extract_fail from pm1 income',async()=>{
  await f.db.insert(userBrokerage).values(Array.from({length:101},(_,i)=>({uid:7,type:'custom_history',linkId:String(i),pm:1,status:i%3-1,number:'9999999999.99'})));
  await f.db.insert(userBrokerage).values([{uid:7,type:'extract_fail',pm:1,number:'123.45'},{uid:7,type:'refund',pm:0,number:'-0.25'},{uid:8,type:'custom_history',pm:1,number:'999.00'}]);
  expect(await service.brokerageList(7,{limit:1})).toMatchObject({income:'1009999999998.99',expend:'-0.25'});
 });
 it('never resolves another owners withdrawal reason through a copied link, while preserving legacy default labels',async()=>{
  await f.db.insert(userExtract).values([{id:11,uid:7,status:-1,failMsg:'本人拒绝原因'},{id:12,uid:8,status:-1,failMsg:'外属拒绝原因'}]);
  await f.db.insert(userBrokerage).values([{id:1,uid:7,type:'extract',linkId:'0011'},{id:2,uid:7,type:'extract_fail',linkId:'12'},{id:3,uid:7,type:'extract_money',linkId:'12'},{id:4,uid:7,type:'extract',linkId:'2147483648'}]);
  const result=await service.brokerageList(7,{});
  expect(result.list).toMatchObject([{id:4,extract_status:0,extract_msg:''},{id:3,extract_status:1,extract_msg:''},{id:2,extract_status:0,extract_msg:''},{id:1,extract_status:-1,extract_msg:'本人拒绝原因'}]);
  expect(JSON.stringify(result)).not.toContain('外属拒绝原因');
 });
 it('searches string zero and PHP wildcard patterns, using the ledger title or current owner profile rather than buyer names',async()=>{
  await f.db.insert(userBrokerage).values([{id:1,uid:7,type:'custom',title:'记录0',pm:1,number:'1.00'},{id:2,uid:7,type:'custom',title:'别的记录',pm:0,number:'2.00'}]);
  expect((await service.brokerageList(7,{keyword:'0'})).list.map(row=>row.id)).toEqual([1]);
  for(const keyword of ['%','_','7','owner','当前推广人','13811111117'])expect((await service.brokerageList(7,{keyword})).list.map(row=>row.id)).toEqual([2,1]);
  expect((await service.brokerageList(7,{keyword:'订单买家'})).list).toEqual([]);
 });
 it('retains every commission type/status while withdrawal is exactly three types and ignores keyword',async()=>{
  await f.db.insert(userBrokerage).values(['extract','extract_money','extract_fail','division_brokerage','refund','unknown'].map((type,i)=>({id:i+1,uid:7,type,pm:i%2,status:i-2,number:'1.00'})));
  expect((await service.brokerageList(7,{})).list.map(row=>row.id)).toEqual([6,5,4,3,2,1]);
  const result=await service.extractList(7,{keyword:'NO-MATCH'});expect(result.list.map(row=>row.id)).toEqual([3,2,1]);
  for(const row of result.list){expect(row).not.toHaveProperty('extract_status');expect(row).not.toHaveProperty('extract_msg');}
 });
});
