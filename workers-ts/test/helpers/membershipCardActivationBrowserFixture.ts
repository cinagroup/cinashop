import {vi,expect} from 'vitest';
import {eq,sql,SQL} from 'drizzle-orm';
import {PgDialect,getTableConfig} from 'drizzle-orm/pg-core';
import {createHash} from 'node:crypto';
import {agreement,legacyCache,memberCard,memberCardBatch,memberRight,memberShip,otherOrder,otherOrderStatus,storeCouponIssue,storeCouponUser,storeOrderEconomize,systemConfig,systemDise,user} from '@/models/schema';
import type {Env} from '@/env';
import {createToken,md5} from '@/utils/jwt';
import {diyFooterBrowserFixture} from './diyFooterBrowserFixture';
import {sortedDiyState,type DiyStateSnapshot,type DiyStateRow as Row} from './diyStateFixture';

/** Browser-only owned setup. Sequence allocation is observable infrastructure,
 * not a fake membership response. Every redemption uses the registered app. */
export async function membershipCardActivationBrowserFixture(){
 const f=await diyFooterBrowserFixture({namespace:'public'});
 try{
  const dialect=new PgDialect();
  for(const table of [agreement,legacyCache,memberCard,memberCardBatch,memberRight,memberShip,otherOrder,otherOrderStatus,storeCouponIssue,storeCouponUser,storeOrderEconomize]){
   const def=getTableConfig(table);if((await f.db.execute(sql`SELECT to_regclass(${def.name}) AS name`))[0]?.name)continue;
   const columns=def.columns.map(c=>{const v=c.default,initial=v===undefined?'':` default ${v instanceof SQL?dialect.sqlToQuery(v).sql:dialect.sqlToQuery(sql`${v}`.inlineParams()).sql}`;return `"${c.name}" ${c.getSQLType()}${initial}${c.notNull?' not null':''}${c.primary?' primary key':''}`;});
   await f.exec(`CREATE TABLE "${def.name}" (${columns.join(',')})`);
  }
  const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(r=>r.name);
  const sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(r=>r.name);
  async function snapshot():Promise<DiyStateSnapshot>{
   const state:DiyStateSnapshot={};for(const v of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(name=>sql`SELECT ${name}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`),sql` UNION ALL `)))state[v.name]=v.rows;
   state.__sequences=await f.db.execute(sql.join(sequences.map(name=>sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`),sql` UNION ALL `));return sortedDiyState(state);
  }
  const resource=()=>({puts:f.bucket.put.mock.calls.length,deletes:f.bucket.delete.mock.calls.length,queue:vi.mocked(f.env.ORDER_QUEUE.send).mock.calls.length,objects:[...f.objects].map(([key,v])=>({key,type:v.type,bytes:v.bytes.length,sha256:createHash('sha256').update(v.bytes).digest('hex')})).sort((a,b)=>a.key.localeCompare(b.key))});
  const before=await snapshot(),resourcesBefore=resource();
  await f.db.insert(memberCardBatch).values({id:9810,title:'原版卡密激活验收批次',totalNum:3,useNum:0,useDay:30,status:1});
  const cards=[1,2,3].map(n=>({id:9810+n,cardBatchId:9810,cardNumber:'86000000000'+n,cardPassword:'ABCD1234EFGH',status:1,useUid:0,useTime:0}));
  await f.db.insert(memberCard).values(cards);
  await f.db.insert(memberRight).values([{id:9811,rightType:'integral',title:'积分礼遇',showTitle:'双倍积分',explain:'双倍积分礼遇',number:2,image:f.platformImage.url,status:1,sort:2,content:`<p style="color:#966a32;font-size:20px">原版会员权益</p><img src="${f.platformImage.url}" alt="会员权益图标">`},{id:9812,rightType:'express',title:'运费八折',showTitle:'运费八折',explain:'全场运费八折',number:80,image:f.platformImage.url,status:1,sort:1,content:'<p>运费优惠，以结算为准。</p>'}]);
  for(const uid of [11,22])await f.db.update(user).set({nickname:'原版激活测试'+uid,isMoneyLevel:0,isEverLevel:0,overdueTime:0}).where(eq(user.uid,uid));
  for(const key of ['site_url','site_logo','site_logo_square','login_logo','ico_path','admin_login_slide'])await f.db.update(systemConfig).set({value:'""'}).where(eq(systemConfig.menuName,key));
  if((await f.db.select().from(systemConfig).where(eq(systemConfig.menuName,'member_card_status'))).length)await f.db.update(systemConfig).set({value:'1'}).where(eq(systemConfig.menuName,'member_card_status'));
  else await f.db.insert(systemConfig).values({menuName:'member_card_status',value:'1'});
  const blocks=structuredClone(f.blocks),footer=blocks.find(v=>v.name==='pageFoot')!;
  footer.menuList=[{name:'激活会员卡',link:'/pages/annex/vip_paid_active/index',imgList:[f.platformImage.url,f.platformImage.url]},{name:'我的',link:'/pages/user/index',imgList:[f.platformImage.url,f.platformImage.url]}];
  for(const id of [1,2])await f.db.update(systemDise).set({value:JSON.stringify(blocks),version:'owned-activation-entry-1'}).where(eq(systemDise.id,id));
  f.cache.clear();const tokens=new Map<number,string>();
  for(const uid of [11,22]){const [row]=await f.db.select().from(user).where(eq(user.uid,uid));tokens.set(uid,(await createToken(uid,'api',md5(row!.pwd),f.env.APP_KEY)).token);}
  const sequenceCalls:Row[]=[];let next=0;const sequenceIdentity={toString:()=> 'owned-activation-sequence'};
  f.env.SEQUENCE={idFromName:(name:string)=>{expect(name).toBe('seq');sequenceCalls.push({kind:'idFromName',name});return sequenceIdentity;},get:(id:unknown)=>{expect(id).toBe(sequenceIdentity);sequenceCalls.push({kind:'get'});return{fetch:async(input:Request|string|URL)=>{const url=String(input instanceof Request?input.url:input);expect(url).toBe('https://internal/next-order-id?prefix=hy');const value='hy_activation_'+(++next);sequenceCalls.push({kind:'allocate',url,value});return new Response(value);}};}} as unknown as Env['SEQUENCE'];
  return{...f,tables,sequences,snapshot,resources:resource,tokens,cards,sequenceCalls,sequence:()=>({allocated:next,calls:structuredClone(sequenceCalls)}),setup:{before,after:await snapshot(),resources_before:resourcesBefore,resources_after:resource(),legacy_entry:'/pages/annex/vip_paid_active/index',target:'/pages/annex/vip_active/index'}};
 }catch(error){await f.close();throw error;}
}
