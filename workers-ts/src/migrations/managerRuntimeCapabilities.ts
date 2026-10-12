import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectCustomerManualRefund } from './runCustomerManualRefund';

type Query = Pick<DbClient, 'execute'>;
export const MANAGER_SCOPE_CONTEXT = 'cinashop.manager_authorized_operation_v1';
export const MANAGER_WAYBILL_OWNER = 'cinashop_manager_waybill_owner_v1';
export const MANAGER_PROMOTION_OWNER = 'cinashop_manager_promotion_owner_v1';
const promotionReads = ['manager_order_operation_request','store_order','store_order_promotions','system_store','system_store_staff','user'];
const manualReads = ['customer_financial_manual_refund_v1','customer_financial_operation_request','store_order_refund','store_order_refund_split'];
const fulfillmentReads = ['order_waybill_job','delivery_service','manager_order_operation_request'];
const caller = `
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.current_setting('session_replication_role')<>'origin' THEN RAISE EXCEPTION 'Manager capability requires origin READ COMMITTED write transaction' USING ERRCODE='25000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
    WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=session_user AND r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND pg_catalog.has_table_privilege(r.oid,'public.manager_order_operation_request','SELECT')
      AND pg_catalog.has_table_privilege(r.oid,'public.manager_order_operation_request','INSERT')
      AND NOT pg_catalog.has_table_privilege(r.oid,'public.manager_order_operation_request','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')) THEN RAISE EXCEPTION 'Independent manager principal required' USING ERRCODE='42501'; END IF;
`;
export function managerRuntimeCapabilityDefinitions() {
  return [
    { key:'waybill' as const,name:'manager_lock_waybill_v1',args:'',types:'',result:'void',reads:fulfillmentReads,
      body:`BEGIN${caller}  LOCK TABLE public.order_waybill_job IN SHARE MODE NOWAIT;\nEND` },
    { key:'delivery' as const,name:'manager_lock_delivery_agents_v1',args:'integer,integer',types:'23 23',result:'void',reads:fulfillmentReads,
      body:`BEGIN${caller}  IF $1 IS NULL OR $1<1 OR $2 IS NULL OR $2<1 THEN RAISE EXCEPTION 'Invalid manager delivery identity' USING ERRCODE='42501'; END IF;
  LOCK TABLE public.delivery_service IN SHARE MODE NOWAIT;
  PERFORM id FROM public.delivery_service WHERE uid=$1 AND type=1 AND relation_id=$2 ORDER BY id FOR SHARE NOWAIT;
END` },
    { key:'promotion' as const,name:'manager_delete_order_promotions_v1',args:'integer,jsonb',types:'23 3802',result:'integer',reads:promotionReads,
      body:`DECLARE context jsonb;actual jsonb;deleted integer;actor integer;store integer;staff integer;root integer;
BEGIN${caller}
  context:=nullif(pg_catalog.current_setting('${MANAGER_SCOPE_CONTEXT}',true),'')::jsonb;
  IF (context IS NOT NULL AND pg_catalog.jsonb_typeof(context)='object' AND $1 IS NOT NULL AND $1>0
    AND $2 IS NOT NULL AND pg_catalog.jsonb_typeof($2)='array' AND pg_catalog.jsonb_array_length($2)<=4096
    AND (SELECT count(*)=8 AND bool_and(key IN('actor_uid','store_id','staff_id','root_order_id','request_hash','kind','auth_version','expires_at')) FROM pg_catalog.jsonb_object_keys(context) key)
    AND context->>'request_hash' ~ '^[a-f0-9]{64}$' AND pg_catalog.jsonb_typeof(context->'request_hash')='string'
    AND context->>'auth_version' ~ '^[a-f0-9]{32}$' AND pg_catalog.jsonb_typeof(context->'auth_version')='string'
    AND pg_catalog.jsonb_typeof(context->'kind')='string' AND context->>'kind' IN('manual_delivery','split_delivery','refund_execute')
    AND (SELECT bool_and(pg_catalog.jsonb_typeof(context->key)='number' AND context->>key ~ '^[1-9][0-9]{0,9}$') FROM unnest(ARRAY['actor_uid','store_id','staff_id','root_order_id','expires_at']) key)) IS NOT TRUE
    THEN RAISE EXCEPTION 'Reviewed manager operation context required' USING ERRCODE='42501'; END IF;
  actor:=(context->>'actor_uid')::integer;store:=(context->>'store_id')::integer;staff:=(context->>'staff_id')::integer;root:=(context->>'root_order_id')::integer;
  IF actor<1 OR store<1 OR staff<1 OR root<1 OR (context->>'expires_at')::bigint<=extract(epoch FROM pg_catalog.statement_timestamp())::bigint
    OR NOT EXISTS(SELECT 1 FROM public."user" u WHERE u.uid=actor AND u.status=1 AND u.is_del=0 AND u.delete_time IS NULL AND md5(u.pwd)=context->>'auth_version')
    OR (SELECT count(*) FROM public.system_store_staff s JOIN public.system_store t ON t.id=s.store_id
      WHERE s.uid=actor AND s.store_id=store AND s.status=1 AND s.is_del=0 AND s.order_status=1 AND(s.is_manager=1 OR s.is_admin=1)
        AND t.is_store=1 AND t.is_show=1 AND t.is_del=0)<>1
    OR NOT EXISTS(SELECT 1 FROM public.system_store_staff s WHERE s.id=staff AND s.uid=actor AND s.store_id=store AND s.status=1 AND s.is_del=0 AND s.order_status=1 AND(s.is_manager=1 OR s.is_admin=1))
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid() AND relation='public.system_store_staff'::regclass AND mode='ShareLock' AND granted)
    OR NOT EXISTS(SELECT 1 FROM public.store_order o JOIN public.store_order r ON r.id=root WHERE o.id=$1 AND(o.id=root OR o.pid=root)
      AND o.store_id=store AND r.store_id=store AND o.uid=r.uid AND o.is_del=0 AND o.is_system_del=0 AND o.supplier_allocation_status<>1)
    THEN RAISE EXCEPTION 'Manager promotion authority changed' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) INTO actual FROM public.store_order_promotions p WHERE p.oid=$1;
  IF actual IS DISTINCT FROM $2 THEN RAISE EXCEPTION 'Manager promotion ledger changed' USING ERRCODE='40001'; END IF;
  DELETE FROM public.store_order_promotions WHERE oid=$1;
  GET DIAGNOSTICS deleted=ROW_COUNT;
  IF deleted<>pg_catalog.jsonb_array_length($2) THEN RAISE EXCEPTION 'Manager promotion delete cardinality changed' USING ERRCODE='40001'; END IF;
  RETURN deleted;
END` },
  ] as const;
}

/** Source-defined functions, exact owners and ACLs. A matching name supplies no authority. */
export async function inspectManagerRuntimeCapabilities(db: Query) {
  const result: Record<string, {ready:boolean;absent:boolean;definitionSafe:boolean;ownerSafe:boolean;aclSafe:boolean;tablesSafe:boolean;ownerOid:string|null;functionOid:string|null}> = {};
  for (const f of managerRuntimeCapabilityDefinitions()) {
    const manual = f.key==='promotion' ? await inspectCustomerManualRefund(db) : null;
    const allowedReads = [...f.reads,...(manual?.complete?manualReads:[])];
    const allowedFunctions = f.key==='promotion' ? [f.name,'customer_manual_refund_promotion_delete_v1'] : ['manager_lock_waybill_v1','manager_lock_delivery_agents_v1'];
    const [row] = await db.execute(sql`WITH routines AS(SELECT * FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname=${f.name}),
      owner AS(SELECT r.* FROM pg_catalog.pg_roles r WHERE r.oid=(SELECT min(proowner) FROM routines))
      SELECT (SELECT count(*)=0 FROM routines) AS absent,
      (SELECT count(*)=1 AND bool_and(p.proargtypes=${f.types}::oidvector AND p.prokind='f' AND p.prosecdef AND p.prorettype=${f.result}::regtype
        AND l.lanname='plpgsql' AND l.lanpltrusted AND p.provolatile='v' AND p.proparallel='u' AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
        AND p.prosrc=${f.body} AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL
        AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
        AND p.proargnames IS NULL AND p.proargdefaults IS NULL AND p.protrftypes IS NULL) FROM routines p JOIN pg_catalog.pg_language l ON l.oid=p.prolang) AS definition_safe,
      EXISTS(SELECT 1 FROM owner o WHERE NOT(o.rolcanlogin OR o.rolsuper OR o.rolcreatedb OR o.rolcreaterole OR o.rolinherit OR o.rolreplication OR o.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=o.oid OR roleid=o.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=o.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=o.oid OR(nspname !~ '^pg_' AND nspname<>'information_schema' AND pg_catalog.has_schema_privilege(o.oid,oid,'CREATE')))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=o.oid)
        AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','SET,ALTER SYSTEM')
        AND pg_catalog.has_schema_privilege(o.oid,'public','USAGE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=o.oid AND(p.pronamespace<>'public'::regnamespace OR NOT(p.proname IN(SELECT jsonb_array_elements_text(${JSON.stringify(allowedFunctions)}::jsonb)))))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f') AND(c.relowner=o.oid
            OR pg_catalog.has_table_privilege(o.oid,c.oid,'INSERT,TRUNCATE,REFERENCES,TRIGGER') OR pg_catalog.has_any_column_privilege(o.oid,c.oid,'INSERT,REFERENCES')
            OR ((pg_catalog.has_table_privilege(o.oid,c.oid,'SELECT') OR pg_catalog.has_any_column_privilege(o.oid,c.oid,'SELECT')) AND NOT(n.nspname='public' AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(allowedReads)}::jsonb))))
            OR(n.nspname='public' AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(f.reads)}::jsonb)) AND NOT pg_catalog.has_table_privilege(o.oid,c.oid,'SELECT'))
            OR pg_catalog.has_table_privilege(o.oid,c.oid,'UPDATE')<>(n.nspname='public' AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(f.key!=='promotion'?['order_waybill_job','delivery_service']:[])}::jsonb)))
            OR(pg_catalog.has_any_column_privilege(o.oid,c.oid,'UPDATE') AND NOT(n.nspname='public' AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(f.key!=='promotion'?['order_waybill_job','delivery_service']:[])}::jsonb))))
            OR pg_catalog.has_table_privilege(o.oid,c.oid,'DELETE')<>(n.nspname='public' AND c.relname=${f.key==='promotion'?'store_order_promotions':''})
            OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=o.oid AND a.is_grantable)))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND pg_catalog.has_sequence_privilege(o.oid,c.oid,'USAGE,SELECT,UPDATE'))
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.proowner<>o.oid
          AND (pg_catalog.has_function_privilege(o.oid,p.oid,'EXECUTE WITH GRANT OPTION') OR(p.prosecdef AND pg_catalog.has_function_privilege(o.oid,p.oid,'EXECUTE'))))
        AND(${f.key!=='promotion'} OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='customer_manual_refund_promotion_delete_v1' AND p.proowner<>o.oid))) AS owner_safe,
      NOT EXISTS(SELECT 1 FROM routines p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS acl_safe,
      (SELECT count(*)=${f.reads.length} AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid))
        FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(f.reads)}::jsonb))) AS tables_safe,
      (SELECT oid::text FROM owner) AS owner_oid,(SELECT min(oid)::text FROM routines) AS function_oid`);
    const state={absent:row?.absent===true,definitionSafe:row?.definition_safe===true,ownerSafe:row?.owner_safe===true,aclSafe:row?.acl_safe===true,tablesSafe:row?.tables_safe===true,
      ownerOid:typeof row?.owner_oid==='string'?row.owner_oid:null,functionOid:typeof row?.function_oid==='string'?row.function_oid:null};
    let ready=!state.absent&&state.definitionSafe&&state.ownerSafe&&state.aclSafe&&state.tablesSafe;
    if(f.key==='promotion'){
      const [manual]=await db.execute(sql`SELECT count(*)::int AS count FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='customer_manual_refund_promotion_delete_v1'`);
      if(Number(manual?.count)>0)ready=ready&&(await inspectCustomerManualRefund(db)).complete;
    }
    result[f.key]={...state,ready};
  }
  if(result.waybill.ready&&result.delivery.ready&&result.waybill.ownerOid!==result.delivery.ownerOid){result.waybill.ready=false;result.delivery.ready=false;}
  return {ready:result.waybill.ready&&result.delivery.ready&&result.promotion.ready,waybill:result.waybill,delivery:result.delivery,promotion:result.promotion};
}

/** Explicit maintenance transaction only; no roles, passwords, LOGIN changes or repair. */
export async function installManagerRuntimeCapabilities(tx: Query, owners: {waybillOwner:string;promotionOwner?:string}) {
  if(Object.hasOwn(tx,'$client'))throw Error('Manager capabilities require an explicit maintenance transaction');
  const [guard]=await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND current_setting('transaction_read_only')='off' AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') AND pg_try_advisory_xact_lock(731626,914) AS ready`);
  if(guard?.ready!==true)throw Error('Manager capability maintenance unsafe or busy');
  const initial=await inspectManagerRuntimeCapabilities(tx);
  for(const f of managerRuntimeCapabilityDefinitions()){
    if(f.key==='promotion'&&!owners.promotionOwner)continue; // explicitly bounded owned test fixture only
    const name=f.key!=='promotion'?owners.waybillOwner:owners.promotionOwner!;const owner=pricingIdentifier(name);
    const [role]=await tx.execute(sql`SELECT oid::text AS oid FROM pg_roles r WHERE rolname=${name}
      AND NOT(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usesysid=r.oid)
      AND NOT has_schema_privilege(r.oid,'public','CREATE')`);
    if(!role)throw Error('Manager capability requires explicit restricted NOLOGIN owner');
    const state=initial[f.key];
    if(!state.absent){if(!state.ready||state.ownerOid!==role.oid)throw Error('Manager capability catalog or owner drift');continue;}
    if(f.key==='promotion'){
      const [manual]=await tx.execute(sql`SELECT count(*)::integer AS count,bool_and(proowner::text=${role.oid}) AS same_owner FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='customer_manual_refund_promotion_delete_v1'`);
      if(Number(manual?.count)>0&&(Number(manual.count)!==1||manual.same_owner!==true||(await inspectCustomerManualRefund(tx)).complete!==true))throw Error('Manager promotion must reuse the reviewed manual owner');
    }
    await tx.execute(sql.raw(`LOCK TABLE ${f.reads.map(n=>`public.${pricingIdentifier(n)}`).join(',')} IN ACCESS EXCLUSIVE MODE NOWAIT`));
    await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO ${owner}; GRANT SELECT ON ${f.reads.map(n=>`public.${pricingIdentifier(n)}`).join(',')} TO ${owner}; GRANT ${f.key!=='promotion'?'UPDATE ON public.order_waybill_job,public.delivery_service':'DELETE ON public.store_order_promotions'} TO ${owner}`));
    await tx.execute(sql.raw(`CREATE FUNCTION public.${f.name}(${f.args}) RETURNS ${f.result} LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $manager_cap$${f.body}$manager_cap$;
      REVOKE ALL ON FUNCTION public.${f.name}(${f.args}) FROM PUBLIC;ALTER FUNCTION public.${f.name}(${f.args}) OWNER TO ${owner};REVOKE CREATE ON SCHEMA public FROM ${owner};`));
    const final=await inspectManagerRuntimeCapabilities(tx);
    if(!final[f.key].ready||final[f.key].ownerOid!==role.oid)throw Error('Manager capability final verification failed');
  }
  return inspectManagerRuntimeCapabilities(tx);
}

/** OIDs are exempted only after exact protocol and this independent LOGIN's grant. */
export async function reviewedManagerRuntimeCapabilityOids(tx:Query){
  const catalog=await inspectManagerRuntimeCapabilities(tx),oids:string[]=[];
  for(const state of [catalog.waybill,catalog.delivery,catalog.promotion])if(state.ready&&state.functionOid){
    const [caller]=await tx.execute(sql`SELECT current_user=session_user AND EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND r.rolname=session_user AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls))
      AND has_table_privilege(current_user,'public.manager_order_operation_request','SELECT') AND has_table_privilege(current_user,'public.manager_order_operation_request','INSERT')
      AND has_function_privilege(current_user,${state.functionOid}::oid,'EXECUTE') AS ready`);
    if(caller?.ready===true)oids.push(state.functionOid);
  }
  return oids;
}
