import {eq,sql,SQL} from 'drizzle-orm';
import {PgDialect,getTableConfig} from 'drizzle-orm/pg-core';
import {user,userBill,userMoney,userLevel,storeCouponUser,storeCouponIssueUser,storeCouponIssue,systemCity,systemDise} from '@/models/schema';
import {membershipHomeFixture} from './membershipHomeFixture';
import {sortedDiyState,type DiyStateSnapshot as Snapshot,type DiyStateRow as Row} from './diyStateFixture';
export const MEMBER_LEVEL_ISSUES=[24001,24002];
export const MEMBER_LEVEL_FIELDS=[
 {info:'姓名',param:'real_name',format:'text',required:1,tip:'请填写真实姓名'},
 {info:'性别',param:'sex',format:'radio',required:1,tip:'请选择性别',singlearr:['男','女','保密']},
 {info:'生日',param:'birthday',format:'date',required:1,tip:'请选择出生日期'},
 {info:'所在地区',param:'address',format:'address',required:1,tip:'请选择省市区'},
 {info:'联系邮箱',param:'',format:'mail',required:1,tip:'请填写邮箱'},
 {info:'联系电话',param:'',format:'phone',required:1,tip:'请填写手机号'},
 {info:'常用数字',param:'',format:'num',required:0,tip:'请填写数字'},
 {info:'身份证',param:'card_id',format:'id',required:0,tip:'可选身份证资料'},
];
export const memberLevelValues=(uid=11)=>[{info:'姓名',value:'合成会员'+uid},{info:'性别',value:'1'},{info:'生日',value:'2000-02-29'},{info:'所在地区',value:'310100'},{info:'联系邮箱',value:'synthetic'+uid+'@example.invalid'},{info:'联系电话',value:'13800138000'},{info:'常用数字',value:'8'},{info:'身份证',value:''}];
/** Additive owned fixture. Published parent fixture bytes remain immutable. */
export async function memberLevelActivationFixture(){
 const f=await membershipHomeFixture();
 try{
  const dialect=new PgDialect();
  for(const table of[userBill,userMoney,userLevel,storeCouponIssueUser,systemCity]){const def=getTableConfig(table);if((await f.db.execute(sql`SELECT to_regclass(${def.name}) AS name`))[0]?.name)continue;const columns=def.columns.map(c=>{const d=c.default,initial=d===undefined?'':` default ${d instanceof SQL?dialect.sqlToQuery(d).sql:dialect.sqlToQuery(sql`${d}`.inlineParams()).sql}`;return`"${c.name}" ${c.getSQLType()}${initial}${c.notNull?' not null':''}${c.primary?' primary key':''}`;});await f.exec(`CREATE TABLE "${def.name}" (${columns.join(',')})`);}
  const tables=(await f.db.execute<{name:string}>(sql`SELECT tablename AS name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename`)).map(v=>v.name),sequences=(await f.db.execute<{name:string}>(sql`SELECT sequencename AS name FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename`)).map(v=>v.name);
  async function snapshot():Promise<Snapshot>{const v:Snapshot={};for(const r of await f.db.execute<{name:string;rows:Row[]}>(sql.join(tables.map(n=>sql`SELECT ${n}::text AS name,COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(n)} t`),sql` UNION ALL `)))v[r.name]=r.rows;v.__sequences=await f.db.execute(sql.join(sequences.map(n=>sql`SELECT ${n}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(n)}`),sql` UNION ALL `));return sortedDiyState(v);}
  const before=await snapshot(),resourcesBefore=f.resources();
  const config={member_func_status:'1',level_activate_status:'1',level_extend_info:JSON.stringify(MEMBER_LEVEL_FIELDS),level_integral_status:'1',level_give_integral:'7',level_money_status:'1',level_give_money:'3',level_coupon_status:'1',level_give_coupon:JSON.stringify(MEMBER_LEVEL_ISSUES)};
  for(const[key,value]of Object.entries(config))await f.config(key,value);
  for(const uid of[11,22])await f.db.update(user).set({levelStatus:0,level:0,integral:uid===11?10:20,realName:'',birthday:0,sex:0,addres:'',cardId:'',levelExtendInfo:'[]'}).where(eq(user.uid,uid));
  await f.db.insert(storeCouponIssue).values(MEMBER_LEVEL_ISSUES.map((id,i)=>({id,title:i?'激活八折礼':'激活五元礼',couponTitle:i?'激活八折礼':'激活五元礼',type:i?2:1,receiveType:3,category:0,appType:0,couponType:0,couponPrice:i?'80.00':'5.00',useMinPrice:'0.00',status:1,isDel:0,day:7,totalCount:i?0:10,remainCount:i?0:10,isPermanent:i?1:0})));
  await f.db.insert(userBill).values({id:22001,uid:0});await f.db.insert(userMoney).values({id:22001,uid:0});await f.db.insert(storeCouponUser).values({id:22001,uid:0,issueCouponId:0});
  for(const table of['user_bill','user_money','store_coupon_user'])await f.exec(`SELECT setval(pg_get_serial_sequence('${table}','id'),(SELECT max(id) FROM "${table}"),true)`);
  await f.db.insert(systemCity).values([{id:24001,cityId:310000,level:1,parentId:0,name:'合成省'},{id:24002,cityId:310100,level:2,parentId:310000,name:'合成市'},{id:24003,cityId:310101,level:3,parentId:310100,name:'合成区'}]);
  const blocks=structuredClone(f.blocks),footer=blocks.find(v=>v.name==='pageFoot')!;footer.menuList=[{name:'激活普通会员',link:'/pages/annex/vip_grade_active/index',imgList:[f.platformImage.url,f.platformImage.url]},{name:'我的',link:'/pages/user/index',imgList:[f.platformImage.url,f.platformImage.url]}];for(const id of[1,2])await f.db.update(systemDise).set({value:JSON.stringify(blocks),version:'owned-level-activation-1'}).where(eq(systemDise.id,id));f.cache.clear();
  const baseline=await snapshot();
  async function restore(){await f.exec('TRUNCATE '+tables.map(n=>'"'+n+'"').join(',')+' RESTART IDENTITY');await f.db.transaction(async tx=>{for(const n of tables)if(baseline[n].length)await tx.execute(sql`INSERT INTO ${sql.identifier(n)} SELECT * FROM jsonb_populate_recordset(NULL::${sql.identifier(n)},${JSON.stringify(baseline[n])}::jsonb)`);for(const s of baseline.__sequences)await tx.execute(sql`SELECT setval(${String(s.name)}::regclass,${String(s.last)}::bigint,${Boolean(s.called)})`);});f.cache.clear();}
  return{...f,tables,sequences,snapshot,restore,baseline,blocks,fields:MEMBER_LEVEL_FIELDS,values:memberLevelValues,issues:MEMBER_LEVEL_ISSUES,setup:{before,after:baseline,resources_before:resourcesBefore,resources_after:f.resources(),config,fields:MEMBER_LEVEL_FIELDS,issues:MEMBER_LEVEL_ISSUES,legacy_entry:'/pages/annex/vip_grade_active/index',target:'/pages/user/levelActivation',parent_setup:f.setup}};
 }catch(e){await f.close();throw e;}
}
/** Independent golden for this synthetic7-point/3-yuan/two-coupon scenario.
 * Default row templates are explicit fixture sentinel rows, not actual outputs. */
export function expectedMemberLevelActivation(before:Snapshot,uid:number,values:Array<{info:string;value:string}>,issuedAt:number):Snapshot{
 const s=structuredClone(before),one=(table:string,id:number)=>{const rows=s[table].filter(v=>v[table==='user'?'uid':'id']===id);if(rows.length!==1)throw Error('Missing golden row '+table+id);return rows[0]!;},account=one('user',uid),byName=new Map(values.map(v=>[v.info,v.value.trim()]));
 account.level_status=1;account.integral+=7;account.now_money=Number((Number(account.now_money)+3).toFixed(2));account.real_name=byName.get('姓名');account.sex=byName.get('性别')==='0'?1:byName.get('性别')==='1'?2:0;account.birthday=Math.floor(Date.UTC(2000,1,29)/1000)-28800;account.addres=byName.get('所在地区');if(byName.get('身份证'))account.card_id=byName.get('身份证');account.level_extend_info=JSON.stringify(MEMBER_LEVEL_FIELDS.map(v=>({...v,value:byName.get(v.info)??''})));
 const next=(table:string)=>{const q=s.__sequences.filter(v=>v.name===table+'_id_seq');if(q.length!==1)throw Error('Missing golden sequence '+table);const r=q[0]!,id=Number(r.last)+(r.called?1:0);r.last=String(id);r.called=true;return id;};
 s.user_bill.push({...one('user_bill',22001),id:next('user_bill'),uid,link_id:'0',pm:1,title:'会员卡激活赠送积分',category:'integral',type:'level_add',event_key:'level_give_integral',number:7,balance:account.integral,mark:'会员卡激活赠送7积分',status:1,add_time:issuedAt});
 s.user_money.push({...one('user_money',22001),id:next('user_money'),uid,link_id:'0',type:'level_add',title:'会员卡激活赠送余额',number:3,balance:account.now_money,pm:1,mark:'会员卡激活赠送3.00余额',status:1,add_time:issuedAt});
 const date=(seconds:number)=>new Date(seconds*1000).toISOString().replace('.000Z','');
 for(const issueId of MEMBER_LEVEL_ISSUES){const issue=one('store_coupon_issue',issueId);if(issue.is_permanent!==1)issue.remain_count--;s.store_coupon_user.push({...one('store_coupon_user',22001),id:next('store_coupon_user'),uid,issue_coupon_id:issueId,coupon_title:issue.title||issue.coupon_title,coupon_price:issue.coupon_price,use_min_price:issue.use_min_price,status:0,start_time:date(issuedAt),end_time:date(issuedAt+7*86400),use_time:null,type:issue.type,receive_time:issuedAt,receive_source:'activate_level',is_fail:0});s.store_coupon_issue_user.push({uid,issue_coupon_id:issueId,add_time:issuedAt});}
 return sortedDiyState(s);
}
