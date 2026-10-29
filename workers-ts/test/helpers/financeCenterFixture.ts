/** Complete-schema fixture; all synthetic authority remains local. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {expect,vi} from 'vitest';
import type {Env} from '@/env';
import {createContainerFromDb} from '@/lib/di';
import {user,userBrokerage,systemConfig,agentLevel,agentLevelTask,agentLevelTaskRecord,luckLottery} from '@/models/schema';
import {runRuntimeBusinessCommissioning} from '@/migrations/runRuntimeBusinessCommissioning';
import {auditRuntimeBusinessPrivileges} from '@/migrations/auditRuntimeBusinessPrivileges';
import {createToken,md5} from '@/utils/jwt';
import {normalizeConfigScalar} from '@/utils/config';
import {refundRuntimeFixture} from './refundRuntimeFixture';
import {sortedDiyState,type DiyStateSnapshot,type DiyStateRow as Row} from './diyStateFixture';
export const FINANCE_CENTER={a:667011,b:667012,parent:667021} as const;
const ids=FINANCE_CENTER;
export function assertFinanceBinding(before:DiyStateSnapshot,after:DiyStateSnapshot,start:number,end:number){
 const expected=structuredClone(before),owner=expected.user.find(r=>r.uid===ids.a)!,parent=expected.user.find(r=>r.uid===ids.parent)!;
 expect(owner.spread_uid).toBe(0);const at=after.user.find(r=>r.uid===ids.a)!.spread_time;expect(at).toBeGreaterThanOrEqual(Math.floor(start/1000));expect(at).toBeLessThanOrEqual(Math.floor(end/1000));
 owner.spread_uid=ids.parent;owner.spread_time=at;parent.spread_count++;
 const allocation=(name:string)=>{const r=expected.__sequences.find(r=>r.name===name)!;const next=BigInt(r.last)+(r.called?1n:0n);r.last=String(next);r.called=true;return Number(next);};
 const spreadId=allocation('user_spread_id_seq'),friendId=allocation('user_friends_id_seq');
 const spread={id:spreadId,store_id:0,uid:ids.a,staff_id:0,spread_uid:ids.parent,spread_time:at,admin_id:0};
 const friend={id:friendId,uid:ids.a,friends_uid:ids.parent,add_time:at};
 expected.user_spread.push(spread);expected.user_friends.push(friend);
 expect(after).toEqual(sortedDiyState(expected));return{kind:'explicit-permanent-binding',owner:ids.a,parent:ids.parent,at,spread,friend,sequence_allocations:['user_spread_id_seq','user_friends_id_seq']};
}
export async function financeCenterFixture(){
 const f=await refundRuntimeFixture();try{
 const tables=(await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(r=>String(r.name)),sequences=(await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(r=>String(r.name));expect(tables).toHaveLength(283);expect(sequences).toHaveLength(229);
 const snapshot=async()=>{const s:DiyStateSnapshot={};for(const r of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))s[r.name]=r.rows;s.__sequences=await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return sortedDiyState(s);};
 const now=Math.floor(Date.now()/1000),password=md5('synthetic-finance-center-'+randomUUID()),appKey=randomUUID()+randomUUID();
 await f.db.insert(user).values([ids.a,ids.b,ids.parent].map(uid=>({uid,pwd:password,status:1,isDel:0,nickname:'分销中心'+uid,brokeragePrice:uid===ids.a?'123.45':'8.88',spreadUid:0,spreadTime:0,spreadCount:0,agentLevel:0,isPromoter:1})));
 await f.db.delete(userBrokerage);await f.db.delete(agentLevelTaskRecord);await f.db.delete(agentLevelTask);await f.db.delete(agentLevel);await f.db.delete(luckLottery);
 await f.db.insert(userBrokerage).values([...Array.from({length:21},(_,i)=>({id:667101+i,uid:ids.a,title:'真实一级佣金'+(i+1),type:'one_brokerage',number:'1.01',pm:1,status:1,addTime:now-60})),{id:667122,uid:ids.a,title:'真实冻结佣金',type:'one_brokerage',number:'20.01',pm:1,status:1,frozenTime:now+86400,addTime:now-60},{id:667123,uid:ids.a,title:'真实退款退佣',type:'refund',number:'2.02',pm:0,status:1,addTime:now-60},{id:667124,uid:ids.b,title:'另一账号佣金',type:'one_brokerage',number:'9.99',pm:1,status:1,addTime:now-60}].map(row=>({...row,linkId:String(row.id)})));
 for(const[menuName,value]of Object.entries({station_open:'1',site_name:'"分销中心真实验收"',brokerage_func_status:'1',member_func_status:'0',member_card_status:'0',division_status:'0',user_extract_balance_status:'1',user_extract_min_price:'1.00',user_extract_max_price:'5000.00'})){const rows=await f.db.update(systemConfig).set({value,sort:30000,isStore:0}).where(eq(systemConfig.menuName,menuName)).returning();if(!rows.length)await f.db.insert(systemConfig).values({menuName,value,sort:30000,isStore:0});}
 const tokens=new Map<number,string>();for(const uid of[ids.a,ids.b])tokens.set(uid,(await createToken(uid,'api',md5(password),appKey)).token);
 const forbidden=vi.fn(()=>{throw Error('Finance center forbids external providers and resource writes');});
 async function withApplication<T>(run:(runtime:{env:Env;container:ReturnType<typeof createContainerFromDb>;identity:Row;roles:Row})=>Promise<T>){return f.withRuntimeRole!(application=>f.withRuntimeRole!(async admin=>{
  const[db]=await f.exec('SELECT current_database() AS name');const roles={app:application.role,admin:admin.role,maintenance:'finance_test',database:String(db.name),pricingOwner:f.pricingOwner};await runRuntimeBusinessCommissioning(f.db,roles);expect(await auditRuntimeBusinessPrivileges(application.db,'app',roles)).toMatchObject({ready:true,failures:[]});
  const[identity]=await application.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user");expect(identity.role).toBe(application.role);expect(identity.session).toBe(application.role);expect(identity.pid).toBe(application.pid);expect(identity.rolcanlogin).toBe(true);expect(Math.floor(Number(identity.version)/10000)).toBe(16);for(const key of['rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])expect(identity[key]).toBe(false);
  const configs=new Map<string,string>();for(const row of await f.db.select({key:systemConfig.menuName}).from(systemConfig))configs.set('cfg_'+row.key,normalizeConfigScalar(await createContainerFromDb(f.db).systemConfigDao.getValue(row.key)));
  const env={...f.env,APP_KEY:appKey,NODE_ENV:'test',UPSTASH_REDIS_URL:'',UPSTASH_REDIS_TOKEN:'',HYPERDRIVE:{connectionString:application.connectionString},HYPERDRIVE_ADMIN:{connectionString:admin.connectionString},CONFIG_KV:{get:async(key:string)=>key.startsWith('cfg_')?(configs.get(key)??''):null,put:forbidden,delete:forbidden,list:forbidden},ORDER_QUEUE:{send:forbidden,sendBatch:forbidden},SEQUENCE:{idFromName:forbidden,get:forbidden},ASSETS_BUCKET:{get:async()=>null,put:forbidden,delete:forbidden,head:forbidden,list:forbidden}}as unknown as Env;
  return run({env,container:createContainerFromDb(application.db),identity,roles});
 }));}
 return{...f,tables,sequences,tokens,forbidden,snapshot,withApplication,setup:{now,expected:{[ids.a]:{withdrawable:'103.44',totalCommission:'39.20',frozenCommission:'20.01',spreadCount:0},[ids.b]:{withdrawable:'8.88',totalCommission:'9.99',frozenCommission:'0.00',spreadCount:0}}}};
 }catch(error){await f.close();throw error;}
}
