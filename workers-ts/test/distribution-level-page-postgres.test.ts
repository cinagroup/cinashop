/** Additive complete-schema proof of the PHP-compatible GET upgrade boundary.
 * Existing ten-table consumer tests retain concurrency/financial regressions. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { distributionLevelFixture, DISTRIBUTOR as ids, assertDistributionEvaluation, assertDistributionVisit } from './helpers/distributionLevelFixture';
const wiring=vi.hoisted(()=>({context:undefined as AsyncLocalStorage<Container>|undefined}));
vi.mock('@/lib/di',async original=>({...await original<typeof import('@/lib/di')>(),createContainer:()=>{const c=wiring.context?.getStore();if(!c)throw Error('Owned distribution App LOGIN required');return c;}}));
const native=describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL));
native('distribution-level full283tables229sequences actual registered JWT GET',()=>{
 let f:Awaited<ReturnType<typeof distributionLevelFixture>>;
 beforeAll(async()=>{f=await distributionLevelFixture();wiring.context=new AsyncLocalStorage<Container>();},60000);
 afterAll(async()=>{wiring.context=undefined;await f?.close();vi.restoreAllMocks();},30000);
 it('accounts independently for natural upgrade, partial progress, history, readonly recommendations and rollback serial gaps',async()=>{
  const app=createApp(),forbiddenFetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('No external provider'));
  await f.withApplication(async runtime=>{
   const request=async(path:string,uid:number=ids.a,token?:string)=>{const headers=new Headers({'Form-type':'h5'});if(uid)headers.set('Authori-zation','Bearer '+(token??f.tokens.get(uid)));
    const jobs:Promise<unknown>[]=[];const response=await wiring.context!.run(runtime.container,()=>app.fetch(new Request('https://distribution-proof.test'+path,{headers}),runtime.env,{waitUntil:(job:Promise<unknown>)=>jobs.push(job),passThroughOnException:()=>{}}as never));
    const body=await response.json() as Record<string,any>;expect((await Promise.allSettled(jobs)).every(r=>r.status==='fulfilled')).toBe(true);return{response,body,jobs:jobs.length};};
   const evaluate=async(path:string,uid:number=ids.a)=>{const before=await f.snapshot(),resources=f.resources(),start=Date.now(),result=await request(path,uid),end=Date.now(),after=await f.snapshot();
    const delta=assertDistributionEvaluation(before,after,uid,start,end);expect(result.body.status).toBe(delta.failure?400:200);expect(f.resources()).toEqual(resources);
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');return{...result,delta,after};};
   const initial=await evaluate('/api/v2/agent/level_list');expect(initial.body.data).toMatchObject({user:{uid:ids.a,agent_level:ids.first},current_grade:1,next_level:{id:ids.next}});
   expect(initial.delta.evaluated_users).toEqual([ids.a,ids.parent,ids.grand]);expect(initial.delta.new_records).toHaveLength(9);
   expect(initial.delta.expected_upgrades).toEqual([{uid:ids.a,level:ids.first}]);
   for(const path of['/api/v2/agent/level_list','/api/agent/level_list','/api/v2/agent/level_task_list?id='+ids.next,'/api/agent/level_task_list?id='+ids.next]){
    const result=await evaluate(path);expect(result.delta.new_records).toEqual([]);expect(result.delta.attempted_record_allocations).toBe(0);
    if(path.includes('task_list'))expect(result.body.data).toMatchObject({speedAll:82.5,list:[{type:2,finish:0,speed:99,task_type_title:'还需自身消费满1.00元',new_number:100},{type:1,finish:0,speed:66,task_type_title:'还需邀请好友1人成为下级',new_number:2}]});
   }
   for(const scenario of['hidden','deleted','max','zero']as const){await f.control(scenario);const result=await evaluate('/api/v2/agent/level_list',ids.b);expect(result.delta.new_records).toEqual([]);
    expect(result.body.data.user.agent_level).toBe(scenario==='zero'?ids.empty:ids.gift);
    if(scenario==='hidden')expect(result.body.data.level_info).toMatchObject({id:ids.gift,status:0});
    if(scenario==='deleted')expect(result.body.data.level_info).toEqual({sum_task:0,finish_task:0});
    if(scenario==='zero'){const task=await evaluate('/api/v2/agent/level_task_list?id='+ids.empty,ids.b);expect(task.body.data).toEqual({list:[],speedAll:0});}
   }
   for(const path of['/api/product/hot?view=member_level&page=1&limit=10','/api/product/hot?view=member_level&page=2&limit=10','/api/product/hot?view=member_level&page=3&limit=10']){
    const before=await f.snapshot(),resources=f.resources(),reads=f.assetReads.length,result=await request(path);
    expect(result.body.status).toBe(200);expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    const page=Number(new URL('https://proof.test'+path).searchParams.get('page')),expected=f.productIds.slice().sort((a,b)=>b-a).slice((page-1)*10,page*10);
    expect(result.body.data).toMatchObject({owner_uid:ids.a,page,limit:10});expect(result.body.data.list.map((r:any)=>r.id)).toEqual(expected);
    expect(result.body.data.list.map((r:any)=>r.price)).toEqual(expected.map(()=>'12.30'));expect(result.body.data.list.every((r:any)=>/^\/api\/assets\/660201\?expires=\d+&signature=/.test(r.image))).toBe(true);
    expect(await f.snapshot()).toEqual(before);expect(f.resources()).toEqual(resources);expect(f.assetReads).toHaveLength(reads);
    if(page===1)expect(result.body.data.list.find((r:any)=>r.id===ids.product+21).recommendation_target).toMatchObject({kind:'bargain',id:ids.bargain,product_id:ids.product+21});
   }
   {
    const before=await f.snapshot(),resources=f.resources(),start=Date.now(),detail=await request('/api/product/detail/'+(ids.product+22)),end=Date.now();
    expect(detail.body.status).toBe(200);expect(detail.jobs).toBe(1);assertDistributionVisit(before,await f.snapshot(),ids.a,ids.product+22,start,end);expect(f.resources()).toEqual(resources);
   }
   {
    const before=await f.snapshot(),resources=f.resources(),activity=await request('/api/bargain/detail/'+ids.bargain+'?view=skus');
    expect(activity.body.status,JSON.stringify(activity.body)).toBe(200);expect(activity.body.data).toMatchObject({bargain_id:ids.bargain,product_id:ids.product+21,title:'PHP分销推荐砍价',skus:[{unique:'db660401',base_unique:'dd'+(ids.product+21)}]});expect(activity.jobs).toBe(0);expect(await f.snapshot()).toEqual(before);expect(f.resources()).toEqual(resources);
   }
   const before=await f.snapshot();for(const token of['invalid','']){const result=await request('/api/v2/agent/level_list',token?ids.a:0,token);expect(result.body.status).toBe(token?410001:410000);expect(await f.snapshot()).toEqual(before);}
   await f.control('rollback');const rollback=await evaluate('/api/v2/agent/level_list');expect(rollback.delta.failure).toBe(true);expect(rollback.delta.attempted_record_allocations).toBe(1);expect(rollback.delta.new_records).toEqual([]);
   await f.control('disabled');const disabled=await evaluate('/api/v2/agent/level_list');expect(disabled.body.data).toEqual([]);expect(disabled.delta.attempted_record_allocations).toBe(0);
   expect(f.forbidden).not.toHaveBeenCalled();expect(forbiddenFetch).not.toHaveBeenCalled();
  });
 },120000);
});

