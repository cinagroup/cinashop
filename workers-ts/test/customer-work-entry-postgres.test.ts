import { afterEach,beforeEach,describe,it,expect } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeService,systemDise,systemStoreStaff,user } from '../src/models/schema';
import { UserCenterPublicReadService } from '../src/services/content/UserCenterPublicReadService';
import { customerWorkEntryFixture,observeUserCenterDb,userCenterEnv } from './helpers/userCenterDesignFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary LOGIN customer work user-center entry',()=>{
  let f:Awaited<ReturnType<typeof customerWorkEntryFixture>>;
  beforeEach(async()=>{f=await customerWorkEntryFixture();},30000);
  afterEach(async()=>{await f?.close();},30000);
  const role=(run:(app:Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0])=>Promise<void>)=>f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');await run(app);});
  it('publishes the customer-only entry with chat disabled across all placements and keeps merchant aggregates independently scoped',async()=>{await role(async app=>{
    const before=await f.snapshot(),commands:string[]=[],db=observeUserCenterDb(app.db,async(_tx,command)=>{commands.push(command);}),service=new UserCenterPublicReadService(createContainerFromDb(db),userCenterEnv);
    const menu=await service.menu(11),stats=await service.data(11);
    expect(menu.capabilities).toMatchObject({work:true,kefu:false,merchant:false,writeoff:false});
    for(const group of ['poster','menu','merMenu'] as const)expect(menu.diy_data[group].list).toMatchObject([{url:'/pages/customer-work/index'}]);
    expect(stats.order).toEqual({user_order:false});expect(stats.consistency_key).toBe(menu.consistency_key);
    expect(JSON.stringify(menu)).not.toMatch(/customer-entry|customer-password|scope_key|store_service|sourceId/);
    expect(commands.filter(command=>/^\s*(?:insert|update|delete|merge|grant|alter|create|drop)\b/iu.test(command))).toEqual([]);
    expect(await f.snapshot()).toEqual(before);
    await expect(app.db.execute(sql`UPDATE store_service SET customer=1 WHERE id=7`)).rejects.toMatchObject({cause:{code:'42501'}});
  });});
  it('does not infer work from a chat, manager, writeoff or foreign role and rejects duplicate active customer identities',async()=>{await role(async app=>{
    for(const patch of [{customer:0,status:1},{accountStatus:0},{isDel:1},{uid:22}]){
      await f.db.update(storeService).set({uid:11,status:0,accountStatus:1,isDel:0,customer:1,...patch}).where(eq(storeService.id,7));
      const menu=await f.publicFor(app.db).menu(11);expect(menu.capabilities.work).toBe(false);
      for(const group of ['poster','menu','merMenu'] as const)expect(menu.diy_data[group].list).toEqual([]);
    }
    await f.db.update(systemStoreStaff).set({isManager:1,orderStatus:1,verifyStatus:1}).where(eq(systemStoreStaff.id,1));
    expect((await f.publicFor(app.db).menu(11)).capabilities).toMatchObject({merchant:true,work:false});
    await f.db.update(storeService).set({uid:11,accountStatus:1,isDel:0,customer:1}).where(eq(storeService.id,7));
    await f.db.insert(storeService).values({id:8,uid:11,customer:1,accountStatus:1,status:1,isDel:0});
    expect((await f.publicFor(app.db).menu(11)).capabilities.work).toBe(false);
    await f.db.update(storeService).set({accountStatus:0}).where(eq(storeService.id,8));
    expect((await f.publicFor(app.db).menu(11)).capabilities.work).toBe(true);
    expect((await f.publicFor(app.db).menu(0)).capabilities.work).toBe(false);
  });});
  it('filters the seven real read destinations by their actual target and leaves merchant targets subject to their own role',async()=>{await role(async app=>{
    const urls=['/pages/admin/work/index','/pages/admin/order/index?type=7','/pages/admin/orderList/index?types=1','/pages/admin/orderDetail/index?id=owned-paid','/pages/admin/refundOrderList/index?refundTypes=5','/pages/admin/refundOrderDetail/index?id=refund-007','/pages/admin/logistics/index?orderId=refund-007&type=refund','/pages/merchant/statistics'];
    const [row]=await f.db.select().from(systemDise).where(eq(systemDise.id,88)),design=JSON.parse(row.value!);
    for(const group of ['poster','menu','merMenu'])design[group].list=urls.map((url,i)=>({name:`读页${i}`,pic:'/api/assets/41',url,...(group==='poster'?{}:{type:1})}));
    await f.db.update(systemDise).set({value:JSON.stringify(design)}).where(eq(systemDise.id,88));
    const menu=await f.publicFor(app.db).menu(11);for(const group of ['poster','menu','merMenu'] as const)expect(menu.diy_data[group].list).toHaveLength(7);
    await f.db.update(storeService).set({customer:0}).where(eq(storeService.id,7));
    const denied=await f.publicFor(app.db).menu(11);for(const group of ['poster','menu','merMenu'] as const)expect(denied.diy_data[group].list).toEqual([]);
  });});
  it('binds the customer identity into the two-read join and catches an actual concurrent revocation after a read-only snapshot',async()=>{await role(async app=>{
    const original=await f.publicFor(app.db).menu(11);let changed=false;
    const db=observeUserCenterDb(app.db,async(tx,command)=>{if(!changed&&command.includes('from "store_service"')){
      changed=true;expect((await tx.execute<{readonly:string;isolation:string}>(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`))[0]).toEqual({readonly:'on',isolation:'repeatable read'});
      await f.db.update(storeService).set({customer:0}).where(eq(storeService.id,7));
    }});
    await expect(new UserCenterPublicReadService(createContainerFromDb(db),userCenterEnv).menu(11)).rejects.toThrow('手机经营权限已变化');
    expect(changed).toBe(true);const later=await f.publicFor(app.db).data(11);expect(later.consistency_key).not.toBe(original.consistency_key);
  });});
  it('rejects inactive or soft-deleted current accounts and never publishes an anonymous global-work capability',async()=>{await role(async app=>{
    for(const patch of [{status:0},{isDel:1},{deleteTime:new Date()}]){
      await f.db.update(user).set({status:1,isDel:0,deleteTime:null,...patch}).where(eq(user.uid,11));const before=await f.snapshot();
      await expect(f.publicFor(app.db).menu(11)).rejects.toThrow('请重新登录');expect(await f.snapshot()).toEqual(before);
    }
    expect((await f.publicFor(app.db).menu(0)).capabilities.work).toBe(false);
  });});
});
