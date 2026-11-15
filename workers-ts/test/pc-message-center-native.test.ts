/** Actual App/JWT and independently authenticated restricted PG16 LOGIN.
 * Every consuming response is checked against the independent all-table oracle. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createApp} from '@/app';
import {createContainerFromDb,createDbFromConnectionString,type Container} from '@/lib/di';
import {systemMessage} from '@/models/schema';
import {MessageCenterService} from '@/services/message/MessageCenterService';
import {MESSAGE_READ_LOCK_NAMESPACE,USER_MESSAGE_READ_SIGNATURE} from '@/migrations/userMessageReadCapability';
import {IDS,messageCenterFixture,messageFixturePassword,messageVisibleRows,messageUnreadCount,assertMessageReadConsumption} from './helpers/messageCenterFixture';

const wiring=vi.hoisted(()=>({scope:undefined as AsyncLocalStorage<Container>|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{
 const value=wiring.scope?.getStore();if(!value)throw Error('Owned PC message App LOGIN required');return value;
}}));
type Fixture=Awaited<ReturnType<typeof messageCenterFixture>>;
type Runtime=Parameters<Parameters<Fixture['withApplication']>[0]>[0];
const summary='/api/user/message?view=pc_message_summary';
const page=(n=1)=>'/api/user/message_system/list?view=pc_system_messages&limit=7&page='+n;
const detail=(id:number)=>'/api/user/message_system/detail/'+id+'?view=system_message_detail';
async function owned(run:(f:Fixture,r:Runtime,request:(path:string,uid?:number|null)=>Promise<any>)=>Promise<void>){
 let f:Fixture|undefined;const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('PC message native prohibits external fetch');});
 try{
  f=await messageCenterFixture();const fixture=f,app=createApp();wiring.scope=new AsyncLocalStorage<Container>();
  await fixture.withApplication(async runtime=>{
   const request=async(path:string,uid:number|null=IDS.a)=>{
    const headers=new Headers();if(uid)headers.set('Authorization','Bearer '+fixture.tokens.get(uid));
    const tasks:Promise<unknown>[]=[];
    const response=await wiring.scope!.run(runtime.container,()=>app.fetch(new Request('http://127.0.0.1'+path,{headers}),runtime.env,
     {waitUntil:(task:Promise<unknown>)=>tasks.push(task),passThroughOnException(){},props:{}}));
    await Promise.all(tasks);expect(tasks).toEqual([]);expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    return await response.json();
   };
   await run(fixture,runtime,request);expect(network).not.toHaveBeenCalled();expect(fixture.forbidden).not.toHaveBeenCalled();expect(fixture.assetReads).toEqual([]);
  });
 }finally{wiring.scope=undefined;network.mockRestore();await f?.close();}
}
it('restores the complete PC seven-row inbox and authoritative system-only badge with private exact receipt accounting',async()=>owned(async(f,_r,request)=>{
 let expected=await f.snapshot();
 expect((await request(summary)).data).toEqual({version:1,owner_uid:IDS.a,unread:21});
 expect((await request(summary,IDS.b)).data).toEqual({version:1,owner_uid:IDS.b,unread:2});
 expect(await f.snapshot()).toEqual(expected); // 103 unread chat messages are not system messages.
 const all=messageVisibleRows(expected,IDS.a);expect(all).toHaveLength(23);
 for(const n of[1,2,3,4]){
  const before=expected,selected=all.slice((n-1)*7,n*7),start=Math.floor(Date.now()/1000),response=await request(page(n));
  expect(response.status,response.msg).toBe(200);const dto=response.data;expected=await f.snapshot();
  expect(dto).toMatchObject({version:1,owner_uid:IDS.a,query:{page:n,limit:7},count:23,page_count:4,
   unread_before:messageUnreadCount(before,IDS.a),unread_after:messageUnreadCount(expected,IDS.a)});
  expect(dto.list.map((row:any)=>row.id)).toEqual(selected.map(row=>row.id));
  expect(dto.list.map((row:any)=>row.read_before)).toEqual(selected.map(row=>row.look===1||before.user_message.some(receipt=>receipt.uid===IDS.a&&receipt.message_id===row.id&&receipt.is_read===1)));
  expect(dto.list.map((row:any)=>row.content)).toEqual(selected.map(row=>row.content??''));
  assertMessageReadConsumption(before,expected,IDS.a,selected.map(row=>row.id),start,Math.floor(Date.now()/1000));
  const replay=await request(page(n));expect(replay.status,replay.msg).toBe(200);expect(replay.data.list.every((row:any)=>row.read_before)).toBe(true);
  expect(await f.snapshot()).toEqual(expected); // Re-reading allocates no second receipt or serial.
  expect((await request(summary)).data.unread).toBe(messageUnreadCount(expected,IDS.a));expect(await f.snapshot()).toEqual(expected);
 }
 expect(messageUnreadCount(expected,IDS.a)).toBe(0);
 const huge=await request(page(2147483647));expect(huge.status,huge.msg).toBe(200);expect(huge.data).toMatchObject({list:[],count:23,page_count:4,unread_before:0,unread_after:0});
 const legacy=await request('/api/user/message_system/list?page=1&limit=7');expect(legacy.status,legacy.msg).toBe(200);expect(legacy.data.list).toHaveLength(7);
 expect(legacy.data.list.every((row:any)=>row.look===1&&typeof row.add_time==='string')).toBe(true);expect(await f.snapshot()).toEqual(expected);
 for(const id of[IDS.foreignMessage,IDS.staffMessage,IDS.hiddenMessage,IDS.deletedMessage]){
  const response=await request(detail(id));expect(response.status,response.msg).toBe(200);expect(response.data).toEqual({owner_uid:IDS.a,id,message:null,service_num:0});
 }
 expect(await f.snapshot()).toEqual(expected);
 const start=Math.floor(Date.now()/1000),broadcast=await request(detail(IDS.broadcast),IDS.b),after=await f.snapshot();
 expect(broadcast.data).toMatchObject({owner_uid:IDS.b,id:IDS.broadcast,message:{id:IDS.broadcast},service_num:1});
 assertMessageReadConsumption(expected,after,IDS.b,[IDS.broadcast],start,Math.floor(Date.now()/1000));expected=after;
 expect(expected.system_message.find(row=>row.id===IDS.broadcast)!.look).toBe(0);
 for(const path of[page()+'&uid=22',page()+'&page=2',page().replace('limit=7','limit=20'),page().replace('page=1','page=01'),summary+'&page=1',
  '/api/user/message_system/list?view=pc_message_summary',detail(IDS.ownMessage)+'&owner_uid=22']){
  expect((await request(path)).status).not.toBe(200);expect(await f.snapshot()).toEqual(expected);
 }
 for(const path of[summary,page(),detail(IDS.ownMessage)])expect((await request(path,null)).status).not.toBe(200);
 expect(await f.snapshot()).toEqual(expected);
 await f.control('hide-broadcast');expected=await f.snapshot();
 expect((await request(summary,IDS.empty)).data).toEqual({version:1,owner_uid:IDS.empty,unread:0});
 expect((await request(page(),IDS.empty)).data).toEqual({version:1,owner_uid:IDS.empty,query:{page:1,limit:7},list:[],count:0,page_count:0,unread_before:0,unread_after:0});
 expect(await f.snapshot()).toEqual(expected);
 await f.control('passwd-revoke');expected=await f.snapshot();
 for(const path of[summary,page(),detail(IDS.ownMessage)])expect((await request(path)).status).not.toBe(200);
 expect(await f.snapshot()).toEqual(expected);
}),180000);

it('rolls back invalid PC bodies before writes, fails closed on capability drift and serializes PC readers with the existing UID lock',async()=>owned(async(f,r,request)=>{
 const original=(await f.snapshot()).system_message.find(row=>row.id===IDS.ownMessage)!.content;
 await f.db.update(systemMessage).set({content:'x'.repeat(65537)}).where(eq(systemMessage.id,IDS.ownMessage));let expected=await f.snapshot();
 expect((await request(page())).status).not.toBe(200);expect(await f.snapshot()).toEqual(expected);
 await f.db.update(systemMessage).set({content:original}).where(eq(systemMessage.id,IDS.ownMessage));
 await f.exec('REVOKE EXECUTE ON FUNCTION '+USER_MESSAGE_READ_SIGNATURE+' FROM "'+r.role+'"');expected=await f.snapshot();
 expect((await request(page())).status).not.toBe(200);expect(await f.snapshot()).toEqual(expected);
 expect((await request(summary)).data.unread).toBe(21);expect(await f.snapshot()).toEqual(expected);
 await f.exec('GRANT EXECUTE ON FUNCTION '+USER_MESSAGE_READ_SIGNATURE+' TO "'+r.role+'"');
 const peer=createDbFromConnectionString(r.app.connectionString,1,{searchPath:'public,pg_temp'}),gate=createDbFromConnectionString(r.app.connectionString,1,{searchPath:'public,pg_temp'});
 const actor={uid:IDS.a,pwd:messageFixturePassword},q={modern:true,pc:true as const,page:1,limit:7},before=await f.snapshot(),start=Math.floor(Date.now()/1000);
 let settled:Promise<PromiseSettledResult<Awaited<ReturnType<MessageCenterService['pcList']>>>[]>|undefined;
 try{
  await gate.transaction(async tx=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(${MESSAGE_READ_LOCK_NAMESPACE},${IDS.a})`);
   settled=Promise.allSettled([new MessageCenterService(r.container,r.env).pcList(actor,q),new MessageCenterService(createContainerFromDb(peer),r.env).pcList(actor,q)]);
   const end=Date.now()+3000;let waiting=0;
   while(Date.now()<end){const[row]=await f.exec('SELECT count(*)::integer AS n FROM pg_locks WHERE locktype=\'advisory\' AND classid='+MESSAGE_READ_LOCK_NAMESPACE+' AND objid='+IDS.a+' AND NOT granted');waiting=Number(row.n);if(waiting===2)break;await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(2);
  });
  const responses=await settled!;expect(responses.every(row=>row.status==='fulfilled')).toBe(true);
  expect(responses.map(row=>row.status==='fulfilled'?row.value.unread_before:-1).sort((a,b)=>a-b)).toEqual([16,21]);
  expect(responses.map(row=>row.status==='fulfilled'?row.value.unread_after:-1)).toEqual([16,16]);
  const after=await f.snapshot();assertMessageReadConsumption(before,after,IDS.a,messageVisibleRows(before,IDS.a).slice(0,7).map(row=>row.id),start,Math.floor(Date.now()/1000));
  const duplicate=after.user_message.filter(row=>row.uid===IDS.a&&row.message_id===IDS.duplicateUnread);expect(duplicate).toHaveLength(2);expect(duplicate.every(row=>row.is_read===1)).toBe(true);
  expect(after.user_message.filter(row=>row.message_id===IDS.mixedRead)).toEqual(before.user_message.filter(row=>row.message_id===IDS.mixedRead));
 }finally{await settled;await peer.$client.end({timeout:5});await gate.$client.end({timeout:5});}
}),180000);
