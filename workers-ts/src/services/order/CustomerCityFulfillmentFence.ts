import { eq,sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { customerCityDeliveryJob,customerCityDeliveryBinding } from '@/models/schema/customer_city_delivery';
import { assertCustomerCityDeliveryReady, CUSTOMER_CITY_CATALOG } from '@/migrations/customerCityDelivery';
import { FULFILLMENT_CITY_CONFLICT_GATE, inspectFulfillmentCityConflictReader } from '@/migrations/fulfillmentCityConflictReader';
import { ServiceUnavailableException, ValidateException } from '@/utils/errors';

/** Shared fulfillment must honor admitted third-party city effects. All-absent
 * historical installations keep their former semantics; partial/drifted
 * catalogs reject. Caller already owns the financial root lock. NOWAIT avoids
 * reversing the legacy callback's delivery-table -> root lock graph. */
export async function assertNoConflictingCustomerCityJob(tx:DbClient,rootOrderId:number,allowedJobId?:number) {
  if(!Number.isSafeInteger(rootOrderId)||rootOrderId<=0||rootOrderId>2147483647)throw new ValidateException('同城配送订单标识无效');
  const names=CUSTOMER_CITY_CATALOG.map(t=>t.table),relations=[...names,...names.map(n=>n+'_pkey'),
    ...CUSTOMER_CITY_CATALOG.flatMap(t=>t.indexes.map(i=>i.name)),...names.slice(0,2).map(n=>n+'_id_seq')];
  const [catalog]=await tx.execute<{installed:number;cityPresent:boolean;closed:boolean;readerPresent:boolean}>(sql`SELECT
    (SELECT pg_catalog.count(*)::int FROM pg_catalog.pg_class WHERE oid IN(pg_catalog.to_regclass('public.customer_city_delivery_job'),
      pg_catalog.to_regclass('public.customer_city_delivery_attempt'),pg_catalog.to_regclass('public.customer_city_delivery_binding'))) AS installed,
    EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname ~ '^(customer_city_delivery_|ccdjob_|ccdattempt_|ccdbinding_)')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace AND typname ~ '^_?(customer_city_delivery_|ccdjob_|ccdattempt_|ccdbinding_)')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname ~ '^(customer_city_delivery_|ccdjob_|ccdattempt_|ccdbinding_)') AS "cityPresent",
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relname ~ '^(customer_city_delivery_|ccdjob_|ccdattempt_|ccdbinding_)'
      AND relname NOT IN (${sql.join(relations.map(n=>sql`${n}`),sql`, `)}))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
      AND typname ~ '^_?(customer_city_delivery_|ccdjob_|ccdattempt_|ccdbinding_)'
      AND typname NOT IN (${sql.join([...names,...names.map(n=>'_'+n)].map(n=>sql`${n}`),sql`, `)}))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname ~ '^(customer_city_delivery_|ccdjob_|ccdattempt_|ccdbinding_)') AS closed,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND pg_catalog.starts_with(p.proname,'fulfillment_city_conflict_'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND pg_catalog.starts_with(c.relname,'fulfillment_city_conflict_'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND t.typname ~ '^_?fulfillment_city_conflict_') AS "readerPresent"`);
  if(catalog?.closed!==true)throw new ValidateException('同城配送合同存在未核对对象');
  if(catalog.installed===0){if(catalog.cityPresent||catalog.readerPresent)throw new ValidateException('同城配送合同安装不完整，请先核对');return;}
  if(catalog?.installed!==3)throw new ValidateException('同城配送合同安装不完整，请先核对');
  // The manual reader supplies no same-job exemption. The actual city writer
  // keeps its complete immutable-write contract and real same-root job proof.
  if(allowedJobId!==undefined){
    if(!Number.isSafeInteger(allowedJobId)||allowedJobId<=0)throw new ValidateException('同城配送任务标识无效');
    await assertCustomerCityDeliveryReady(tx,true);
    const [own]=await tx.select({id:customerCityDeliveryJob.id,rootOrderId:customerCityDeliveryJob.rootOrderId,status:customerCityDeliveryJob.status})
      .from(customerCityDeliveryJob).where(eq(customerCityDeliveryJob.id,allowedJobId)).limit(1).for('update',{noWait:true});
    if(!own||own.rootOrderId!==rootOrderId||!['PROCESSING','UNKNOWN'].includes(own.status))throw new ValidateException('同城配送任务与当前履约不匹配');
  }else{
    // A maintenance forward must never wait behind a root-first runtime. The
    // late shared gate is try-only and remains held until the business commit.
    const [gate]=await tx.execute<{locked:boolean}>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${FULFILLMENT_CITY_CONFLICT_GATE[0]},${FULFILLMENT_CITY_CONFLICT_GATE[1]}) AS locked`);
    if(gate?.locked!==true)throw new ServiceUnavailableException('同城配送读取合同正在维护，请稍后重试');
    const reader=await inspectFulfillmentCityConflictReader(tx);
    if(reader.present){
      if(!reader.ready||!reader.binding||!reader.functionOid)throw new ServiceUnavailableException('同城配送读取合同尚未完整验收');
      const b=reader.binding;
      const [actual]=await tx.execute<{role:string;roleOid:string}>(sql`SELECT r.rolname AS role,r.oid::text AS "roleOid"
        FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_stat_activity a ON a.usesysid=r.oid
        WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=current_user AND current_user=session_user
          AND pg_catalog.current_setting('role')='none' AND pg_catalog.current_schema()='public'
          AND pg_catalog.current_setting('transaction_isolation')='read committed' AND pg_catalog.current_setting('transaction_read_only')='off'
          AND pg_catalog.current_setting('session_replication_role')='origin'
          AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
          AND pg_catalog.has_function_privilege(r.oid,${reader.functionOid}::oid,'EXECUTE')
          AND NOT pg_catalog.has_function_privilege(r.oid,${reader.functionOid}::oid,'EXECUTE WITH GRANT OPTION')`);
      if(!actual||!(['app','admin','manager'] as const).some(actor=>b.actors[actor]&&b[actor]===actual.role&&b[`${actor}Oid`]===actual.roleOid))
        throw new ServiceUnavailableException('同城配送读取需要正式运行账号');
      await tx.execute(sql`SELECT
        pg_catalog.set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        pg_catalog.set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true)`);
      try{
        const [result]=await tx.execute<{ready:boolean}>(sql`SELECT public.fulfillment_city_conflict_v1(${rootOrderId}::integer) AS ready`);
        if(result?.ready!==true)throw new ValidateException('同城配送读取合同未返回完整证明');
      }catch(error){
        let value:unknown=error,code:unknown;
        for(let i=0;i<3&&value&&typeof value==='object';i++){
          const e=value as {code?:unknown;cause?:unknown};if(typeof e.code==='string'){code=e.code;break;}value=e.cause;
        }
        if(code==='P2131')throw new ValidateException('订单已有未结同城配送任务，请先核对原配送结果');
        if(code==='P2132')throw new ServiceUnavailableException('同城配送读取合同正在维护，请稍后重试');
        throw error;
      }
      return;
    }
  }
  // A historical installation without this addon retains its existing writer
  // path. No new grant or guessed runtime is used to make its SQL succeed.
  await assertCustomerCityDeliveryReady(tx,false);
  await tx.execute(sql`LOCK TABLE public.store_delivery_order IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const rows=await tx.select({id:customerCityDeliveryJob.id,status:customerCityDeliveryJob.status,active:customerCityDeliveryBinding.active})
    .from(customerCityDeliveryJob).leftJoin(customerCityDeliveryBinding,eq(customerCityDeliveryBinding.jobId,customerCityDeliveryJob.id))
    .where(eq(customerCityDeliveryJob.rootOrderId,rootOrderId)).limit(501);
  if(rows.length>500)throw new ValidateException('同城配送历史超过核对容量');
  if(rows.some(row=>row.id!==allowedJobId&&(['PENDING','PROCESSING','UNKNOWN'].includes(row.status)||row.status==='ADMITTED'&&row.active===1)))
    throw new ValidateException('订单已有未结同城配送任务，请先恢复原配送结果');
}
