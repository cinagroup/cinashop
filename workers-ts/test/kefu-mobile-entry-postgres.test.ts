import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { eq,sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeService,systemDise,user } from '../src/models/schema';
import { userCenterDesignFixture,observeUserCenterDb,userCenterEnv } from './helpers/userCenterDesignFixture';
import { UserCenterPublicReadService } from '../src/services/content/UserCenterPublicReadService';
const origin='https://kefu.example.com';
const entryEnv={...userCenterEnv,PUBLIC_KEFU_ORIGIN:origin,KEFU_AUTH_ALLOWED_ORIGINS:origin,ALLOWED_ORIGINS:origin};
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native LOGIN user-center Kefu mobile entry contract',()=>{
 let f:Awaited<ReturnType<typeof userCenterDesignFixture>>;
 beforeEach(async()=>{f=await userCenterDesignFixture();await f.db.insert(storeService).values({id:7,uid:11,status:1,accountStatus:1,isDel:0,customer:0,account:'entry-agent',password:'owned-fixture-password',nickname:'真实客服'});const [row]=await f.db.select().from(systemDise).where(eq(systemDise.id,88));const design=JSON.parse(row.value!);for(const group of['poster','menu','merMenu'])design[group].list=[{name:'客服工作台',pic:'/api/assets/41',url:'/kefu/mobile_list',...(group==='poster'?{}:{type:group==='menu'?1:2})}];await f.db.update(systemDise).set({value:JSON.stringify(design)}).where(eq(systemDise.id,88));},30000);
 afterEach(async()=>{await f?.close();},30000);
 const role=(run:(app:Parameters<Parameters<typeof f.withRuntimeRole>[0]>[0])=>Promise<void>)=>f.withRuntimeRole(async app=>{await f.installSelectSlice(app,'app');await run(app);});
 it('exposes the real bound active Kefu entry across all menu placements without private credentials or read-side DML',async()=>{await role(async app=>{
  const before=await f.snapshot(),commands:string[]=[],db=observeUserCenterDb(app.db,async(_tx,command)=>{commands.push(command);}),service=new UserCenterPublicReadService(createContainerFromDb(db),entryEnv),menu=await service.menu(11);
  expect(menu.capabilities.kefu).toBe(true);expect(menu.kefu_workbench_url).toBe(`${origin}/mobile_list`);
  for(const group of['poster','menu','merMenu'] as const)expect(menu.diy_data[group].list).toMatchObject([{name:'客服工作台',url:`${origin}/mobile_list`}]);
  expect(JSON.stringify(menu)).not.toMatch(/owned-fixture-password|entry-agent|token=|sourceId/);
  expect(commands.filter(command=>/^\s*(?:insert|update|delete|merge|grant|alter|create|drop)\b/iu.test(command))).toEqual([]);expect(await f.snapshot()).toEqual(before);
 });});
 it('keeps customer mobile-order privilege distinct and filters inactive deleted and foreign service identities',async()=>{await role(async app=>{
  for(const patch of[{status:0,customer:1},{accountStatus:0},{isDel:1},{uid:22}]){
   await f.db.update(storeService).set({uid:11,status:1,accountStatus:1,isDel:0,customer:0,...patch}).where(eq(storeService.id,7));
   const menu=await new UserCenterPublicReadService(createContainerFromDb(app.db),entryEnv).menu(11);expect(menu.capabilities.kefu).toBe(false);expect(menu.kefu_workbench_url).toBe('');for(const group of['poster','menu','merMenu'] as const)expect(menu.diy_data[group].list).toEqual([]);
  }
  const anonymous=await new UserCenterPublicReadService(createContainerFromDb(app.db),entryEnv).menu(0);expect(anonymous.capabilities.kefu).toBe(false);expect(anonymous.kefu_workbench_url).toBe('');
 });});
 it('preserves qualification but hides an uncommissioned destination rather than falling back to auth or API origins',async()=>{await role(async app=>{
  for(const patch of[{PUBLIC_KEFU_ORIGIN:undefined},{KEFU_AUTH_ALLOWED_ORIGINS:''},{ALLOWED_ORIGINS:'https://shop.example.com'},{PUBLIC_KEFU_ORIGIN:`${origin}/login`}]){
   const menu=await new UserCenterPublicReadService(createContainerFromDb(app.db),{...entryEnv,...patch}).menu(11);expect(menu.capabilities.kefu).toBe(true);expect(menu.kefu_workbench_url).toBe('');for(const group of['poster','menu','merMenu'] as const){expect(menu.diy_data[group].list).toEqual([]);expect(menu.user_center_design_state.issues).toContain(`user_center_${group}_kefu_entry_unavailable`);}
  }
 });});
 it('filters equivalent absolute destinations by actual Kefu authority regardless of historical item type',async()=>{await role(async app=>{
  const [row]=await f.db.select().from(systemDise).where(eq(systemDise.id,88));const design=JSON.parse(row.value!);for(const group of['poster','menu','merMenu'])design[group].list[0].url=`${origin}/workbench`;await f.db.update(systemDise).set({value:JSON.stringify(design)}).where(eq(systemDise.id,88));await f.db.update(storeService).set({status:0}).where(eq(storeService.id,7));
  const menu=await new UserCenterPublicReadService(createContainerFromDb(app.db),entryEnv).menu(11);for(const group of['poster','menu','merMenu'] as const)expect(menu.diy_data[group].list).toEqual([]);
  await f.db.update(storeService).set({status:1}).where(eq(storeService.id,7));
  for(const status of[0,1])for(const patch of[{ALLOWED_ORIGINS:''},{PUBLIC_KEFU_ORIGIN:undefined},{PUBLIC_KEFU_ORIGIN:`${origin}/`},{PUBLIC_KEFU_ORIGIN:`${origin}/login`}]){
   await f.db.update(storeService).set({status}).where(eq(storeService.id,7));
   const uncommissioned=await new UserCenterPublicReadService(createContainerFromDb(app.db),{...entryEnv,...patch}).menu(11);expect(uncommissioned.capabilities.kefu).toBe(status===1);expect(uncommissioned.kefu_workbench_url).toBe('');for(const group of['poster','menu','merMenu'] as const)expect(uncommissioned.diy_data[group].list).toEqual([]);
  }
 });});
 it('binds role changes into the authority snapshot while preserving repeatable read during a concurrent disable',async()=>{await role(async app=>{
  let changed=false;const db=observeUserCenterDb(app.db,async(tx,command)=>{if(!changed&&command.includes('from "store_service"')){changed=true;expect((await tx.execute<{isolation:string;readonly:string}>(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly`))[0]).toEqual({isolation:'repeatable read',readonly:'on'});await f.db.update(storeService).set({status:0}).where(eq(storeService.id,7));}});
  const first=await new UserCenterPublicReadService(createContainerFromDb(db),entryEnv).menu(11),laterService=new UserCenterPublicReadService(createContainerFromDb(app.db),entryEnv),later=await laterService.menu(11),stats=await laterService.data(11);
  expect(changed).toBe(true);expect(first.capabilities.kefu).toBe(true);expect(later.capabilities.kefu).toBe(false);expect(first.consistency_key).not.toBe(later.consistency_key);expect(stats.consistency_key).toBe(later.consistency_key);
 });});
 it('rejects inactive deleted and soft-deleted bound users before publishing a Kefu entry',async()=>{await role(async app=>{
  for(const patch of[{status:0},{isDel:1},{deleteTime:new Date()}]){await f.db.update(user).set({status:1,isDel:0,deleteTime:null,...patch}).where(eq(user.uid,11));const before=await f.snapshot();await expect(new UserCenterPublicReadService(createContainerFromDb(app.db),entryEnv).menu(11)).rejects.toThrow('请重新登录');expect(await f.snapshot()).toEqual(before);}
 });});
});
