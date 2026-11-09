/** Native cancellation fixture only. Owner-authored holds are NOT evidence of
 * an actual payment author, provider request, callback or channel refund. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { user, userBill, userRecharge, storeOrder, otherOrder, systemAdmin, systemRole, systemMenus } from '@/models/schema';
import { runRechargeRefundInstallation, RECHARGE_REFUND_TABLES, type RechargeRefundBinding } from '@/migrations/rechargeRefund';
import { runRechargeRefundRuntimeCommission } from '@/migrations/rechargeRefundRuntimeCommission';
import { signRechargeRefundRecord, authenticateRechargeRefundRecord, type RechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { rechargeRefundDecimal } from '@/services/payment/RechargeRefundMoney';
import { md5 } from '@/utils/jwt';
import { financePostgres, validateFinanceFixtureUrl, ownsFinanceFixtureEndpoint } from './financePostgres';

export const rechargeRefundNativeEnv = Object.freeze({ APP_KEY:'recharge-refund-owner-hold-specimen-only-v1' });
const roleKinds=['app','admin','financial','manager'] as const;
type RoleKind=typeof roleKinds[number];
type Login={db:DbClient;role:string;oid:string;pid:number;exec(statement:string):Promise<unknown>};
const ownedRole=/^rcfr_(app|admin|financial|manager)_[a-f0-9]{32}$/;
const ident=(value:string)=>{if(!ownedRole.test(value))throw Error('Unsafe cancellation fixture role');return '"'+value+'"';};
const clientOptions={max:1,prepare:false,connect_timeout:5,idle_timeout:0,max_lifetime:0,
 connection:{options:'-c search_path=public,pg_temp -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000'}};

/** Only fixture-owned privileges beyond the actual new commissioner:
 * all four LOGINs: CONNECT/USAGE; Admin additionally TEMP in this owned DB,
 * SELECT on user/recharge/bill/admin/role/menu, UPDATE user(now_money),
 * admin(login_count), role(role_name), INSERT bill and USAGE bill_id_seq.
 * No business/source UPDATE, broad table UPDATE, menu UPDATE or provider grant. */
export async function rechargeRefundCancellationFixture() {
 const base=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');
 const f=await financePostgres([storeOrder,userRecharge,otherOrder,user,userBill,systemAdmin,systemRole,systemMenus],{namespace:'public'});
 const clients:Array<ReturnType<typeof postgres>>=[],created:string[]=[];
 const peers={} as Record<RoleKind,Login>;let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{
  const errors:unknown[]=[];
  for(const client of clients)try{await client.end({timeout:5});}catch(error){errors.push(error);}
  try {
   for(const role of [...created].reverse()) {
    if(!ownedRole.test(role))throw Error('Unsafe cancellation role cleanup');
    try {
     await f.exec(`DROP OWNED BY ${ident(role)};DROP ROLE ${ident(role)}`);
     const rows=await f.db.execute(sql`SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${role}`);
     if(rows.length)throw Error('Cancellation fixture role cleanup not confirmed');
    } catch(error){errors.push(error);}
   }
  } finally {try{await f.close();}catch(error){errors.push(error);}}
  if(errors.length)throw new AggregateError(errors,'Cancellation fixture cleanup failed');
 })();
 try {
  const [origin]=await f.db.execute<{database:string;databaseOid:string;role:string;oid:string;schema:string;pid:number;host:string;port:number;version:string}>(sql`SELECT
   current_database() AS database,(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
   current_user AS role,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid,
   current_schema() AS schema,pg_backend_pid() AS pid,host(inet_server_addr()) AS host,inet_server_port() AS port,
   current_setting('server_version_num') AS version`);
  if(!origin||origin.role!=='finance_test'||origin.schema!=='public'||Math.floor(Number(origin.version)/10000)!==16
   ||!ownsFinanceFixtureEndpoint(origin.database,'public',base.href,origin.host,origin.port))throw Error('Owned native PG16 fixture required');
  await runRechargeRefundInstallation(f.db);
  for(const kind of roleKinds) {
   const role='rcfr_'+kind+'_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');
   await f.exec(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
   created.push(role);
   await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO ${ident(role)};GRANT USAGE ON SCHEMA public TO ${ident(role)}`);
   const target=new URL(base.href);target.pathname='/'+origin.database;target.username=role;target.password=password;
   const connection=postgres(target.href,clientOptions);clients.push(connection);
   const [identity]=await connection`SELECT current_user AS role,session_user AS session,current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid,
    pg_backend_pid() AS pid,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num') AS version`;
   if(identity?.role!==role||identity.session!==role||identity.database!==origin.database
    ||Math.floor(Number(identity.version)/10000)!==16||!Number.isSafeInteger(identity.pid)
    ||!ownsFinanceFixtureEndpoint(origin.database,'public',base.href,identity.host,identity.port))throw Error('Independent fixture LOGIN mismatch');
   peers[kind]={db:drizzle(connection) as unknown as DbClient,role,oid:String(identity.oid),pid:Number(identity.pid),exec:s=>connection.unsafe(s)};
  }
  if(new Set([origin.pid,...roleKinds.map(kind=>peers[kind].pid)]).size!==5)throw Error('Five independent backend PIDs required');
  const binding:RechargeRefundBinding={database:origin.database,databaseOid:origin.databaseOid,
   maintenance:origin.role,maintenanceOid:origin.oid,app:peers.app.role,appOid:peers.app.oid,
   admin:peers.admin.role,adminOid:peers.admin.oid,financial:peers.financial.role,financialOid:peers.financial.oid,
   manager:peers.manager.role,managerOid:peers.manager.oid};
  const commission=await runRechargeRefundRuntimeCommission(f.db,binding);
  if(commission.replayed)throw Error('Fresh fixture commissioning unexpectedly replayed');
  const [role]=await f.db.insert(systemRole).values({roleName:'refund specimen role',rules:'recharge_order.refund',status:1,type:0,relationId:0}).returning({id:systemRole.id});
  const passwordRecord='fixture-only-not-login-credential';
  const [admin]=await f.db.insert(systemAdmin).values({account:'refund_hold_specimen',pwd:passwordRecord,adminType:1,
   level:1,roles:String(role.id),status:1,isDel:0}).returning({id:systemAdmin.id});
  await f.exec(`GRANT TEMPORARY ON DATABASE "${origin.database}" TO ${ident(peers.admin.role)};
   GRANT SELECT ON public."user",public.user_recharge,public.user_bill,public.system_admin,public.system_role,public.system_menus TO ${ident(peers.admin.role)};
   GRANT UPDATE(now_money) ON public."user" TO ${ident(peers.admin.role)};
   GRANT UPDATE(login_count) ON public.system_admin TO ${ident(peers.admin.role)};
   GRANT UPDATE(role_name) ON public.system_role TO ${ident(peers.admin.role)};
   GRANT INSERT ON public.user_bill TO ${ident(peers.admin.role)};
   GRANT USAGE ON SEQUENCE public.user_bill_id_seq TO ${ident(peers.admin.role)}`);
  const actor=()=>Object.freeze({id:admin.id,authVersion:md5(passwordRecord),expiresAt:Math.floor(Date.now()/1000)+3600});
  return {owner:f.db,exec:f.exec,peers,binding,roleId:role.id,adminId:admin.id,actor,
   maintenance:{role:origin.role,oid:origin.oid,pid:origin.pid},adminContainer:createContainerFromDb(peers.admin.db),close};
 } catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Cancellation fixture initialization/cleanup failed');}throw error;}
}
export type RechargeRefundCancellationFixture=Awaited<ReturnType<typeof rechargeRefundCancellationFixture>>;

async function insertOwnerRecord(f:RechargeRefundCancellationFixture,table:'recharge_refund_operation'|'recharge_refund_attempt'|'recharge_refund_result',input:unknown) {
 const row=signRechargeRefundRecord(rechargeRefundNativeEnv,f.binding,table,input);
 const columns=RECHARGE_REFUND_TABLES.find(t=>t.name===table)!.columns;
 const rows=await f.owner.execute(sql`INSERT INTO public.${sql.identifier(table)} (${sql.join(columns.map(([name])=>sql.identifier(name)),sql`,`)})
  VALUES (${sql.join(columns.map(([name,type])=>type==='jsonb'&&row[name]!==null?sql`${JSON.stringify(row[name])}::jsonb`:sql`${row[name]}`),sql`,`)}) RETURNING *`);
 if(rows.length!==1)throw Error('Owner specimen insert failed');
 return authenticateRechargeRefundRecord(rechargeRefundNativeEnv,f.binding,table,rows[0]);
}
export interface RechargeRefundHoldSpecimen {
 operation:RechargeRefundRecord;operationId:string;key:string;uid:number;rechargeId:number;orderNo:string;
 principal:number;gift:number;debit:number;before:number;after:number;holdBillId:number;
}
/** Deliberate owner-authored accounting specimen. Its MAC has the real fixture
 * scope; its original marker explicitly supplies NO payment/channel authority. */
export async function seedRechargeRefundHold(f:RechargeRefundCancellationFixture,recoverGift:boolean):Promise<RechargeRefundHoldSpecimen> {
 const operationId=randomUUID(),key=randomUUID(),orderNo='cz'+randomUUID().replaceAll('-','').slice(0,28);
 const principal=5000,gift=1000,debit=principal+(recoverGift?gift:0),before=10000,after=before-debit;
 const [clock]=await f.owner.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`);const now=Number(clock.now);
 const [wallet]=await f.owner.insert(user).values({account:'hold_'+randomUUID().slice(0,20),nowMoney:rechargeRefundDecimal(after),isDel:0}).returning({uid:user.uid});
 const [order]=await f.owner.insert(userRecharge).values({uid:wallet.uid,orderId:orderNo,tradeNo:'owner_hold_'+operationId,
  price:'50.00',givePrice:'10.00',refundPrice:'0.00',paid:1,rechargeType:'weixin',payTime:now,addTime:now}).returning({id:userRecharge.id});
 const [bill]=await f.owner.insert(userBill).values({uid:wallet.uid,linkId:orderNo,eventKey:'recharge_refund_hold:'+operationId,pm:0,
  category:'now_money',type:'recharge_refund',title:'充值退款余额预留',number:rechargeRefundDecimal(debit),balance:rechargeRefundDecimal(after),
  mark:recoverGift?'原路退本金，预留本金及原赠送额':'原路退本金，保留原赠送额',status:1,addTime:now}).returning({id:userBill.id});
 const operation=await insertOwnerRecord(f,'recharge_refund_operation',{
  operation_id:operationId,admin_id:f.adminId,request_key:key,request_hash:'a'.repeat(64),recharge_id:order.id,buyer_uid:wallet.uid,
  order_no:orderNo,provider:'wechat',payment_profile:'routine',transaction_id:'owner_hold_'+operationId,
  payment_source:{original:{specimen:'owner-authored-hold-not-payment-or-provider-evidence'},holdBillId:bill.id},
  payment_signature:'b'.repeat(64),principal_cents:principal,gift_cents:gift,reclaim_gift:recoverGift,
  debit_cents:debit,wallet_before:before,wallet_after:after,admission:'reserved',out_refund_no:'CNSCR'+operationId.replaceAll('-',''),created_at:now});
 await f.owner.execute(sql`INSERT INTO public.recharge_refund_state
  (operation_id,recharge_id,admission,status,wallet_state,version,lease_id,lease_until,provider_refund_id,attempt_count,next_query_at,last_result_id,created_at,updated_at)
  VALUES (${operationId}::uuid,${order.id},'reserved','RESERVED','held',0,NULL,NULL,NULL,0,NULL,NULL,${now},${now})`);
 return {operation,operationId,key,uid:wallet.uid,rechargeId:order.id,orderNo,principal,gift,debit,before,after,holdBillId:bill.id};
}
export async function ownerRequestMarker(f:RechargeRefundCancellationFixture,s:RechargeRefundHoldSpecimen) {
 return insertOwnerRecord(f,'recharge_refund_attempt',{attempt_id:randomUUID(),operation_id:s.operationId,ordinal:1,kind:'request',
  lease_id:randomUUID(),request_hash:'c'.repeat(64),payload:{specimen:'immutable-marker-not-an-actual-POST'},created_at:s.operation.created_at});
}
export async function ownerResultMarker(f:RechargeRefundCancellationFixture,s:RechargeRefundHoldSpecimen) {
 return insertOwnerRecord(f,'recharge_refund_result',{result_id:randomUUID(),operation_id:s.operationId,attempt_id:null,source:'callback',
  source_id:'specimen:'+s.operationId,status:'UNKNOWN',evidence:{specimen:'immutable-marker-not-verified-provider-evidence'},
  created_at:s.operation.created_at,caused_by_result_id:null});
}
/** PostgreSQL's canonical jsonb text gives a literal public-only comparison of
 * wallet/recharge/bills and every operation/state/attempt/result row. */
export async function rechargeRefundPublicSnapshot(f:RechargeRefundCancellationFixture,s:RechargeRefundHoldSpecimen):Promise<string> {
 const [row]=await f.owner.execute<{bytes:string}>(sql`SELECT jsonb_build_object(
  'wallet',(SELECT to_jsonb(u)||jsonb_build_object('now_money',u.now_money::text) FROM public."user" u WHERE u.uid=${s.uid}),
  'recharge',(SELECT to_jsonb(r) FROM public.user_recharge r WHERE r.id=${s.rechargeId}),
  'bills',(SELECT coalesce(jsonb_agg(to_jsonb(b)||jsonb_build_object('number',b.number::text,'balance',b.balance::text) ORDER BY b.id),'[]'::jsonb) FROM public.user_bill b WHERE b.uid=${s.uid}),
  'operation',(SELECT to_jsonb(o) FROM public.recharge_refund_operation o WHERE o.operation_id=${s.operationId}::uuid),
  'state',(SELECT to_jsonb(t) FROM public.recharge_refund_state t WHERE t.operation_id=${s.operationId}::uuid),
  'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.ordinal),'[]'::jsonb) FROM public.recharge_refund_attempt a WHERE a.operation_id=${s.operationId}::uuid),
  'results',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.source,r.source_id),'[]'::jsonb) FROM public.recharge_refund_result r WHERE r.operation_id=${s.operationId}::uuid)
 )::text AS bytes`);
 return row.bytes;
}
export async function revokeSpecimenRule(f:RechargeRefundCancellationFixture,enabled:boolean) {
 await f.owner.update(systemRole).set({rules:enabled?'recharge_order.refund':''}).where(eq(systemRole.id,f.roleId));
}
