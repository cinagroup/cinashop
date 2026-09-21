import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
const names = (value: string) => value.trim().split(/\s+/);
/** PostgreSQL row locks require UPDATE authority; explicit table locks require
 * a table-wide write privilege. These grants must not become catalog editing
 * authority. A SECURITY INVOKER trigger rejects every semantic UPDATE except
 * the separately reviewed lottery inventory counter. No new privileges arise
 * from the trigger itself. This is not per-user / per-supplier isolation. */
export const RUNTIME_LOCK_ONLY_RULES: Record<'app'|'admin', Record<string, readonly string[]>> = {
  app: Object.fromEntries(names(`agent_level city_area system_user_level system_store store_coupon_product
    store_brand store_product_label store_product_category_brand store_newcomer supplier_transactions system_form
    store_product_ensure luck_lottery member_ship store_order_status store_product_specs store_user user_friends
    user_group user_label work_client work_group_chat work_department_leader_current work_member_relation_current
    store_product_cate store_promotions store_promotions_auxiliary`).map(t=>[t,[]])),
  admin: Object.fromEntries(names(`agent_level city_area store_coupon_product store_product_category_brand
    supplier_transactions store_order_status store_product_specs store_user user_friends work_client work_group_chat
    work_department_leader_current work_member_relation_current store_product_cate store_promotions store_promotions_auxiliary`).map(t=>[t,[]])),
};
RUNTIME_LOCK_ONLY_RULES.app.luck_prize = ['total'];
export const RUNTIME_TABLE_LOCK_UPDATE = names('store_product_cate store_product_category_brand luck_lottery luck_prize store_promotions store_promotions_auxiliary');
const tables = [...new Set([...Object.keys(RUNTIME_LOCK_ONLY_RULES.app), ...Object.keys(RUNTIME_LOCK_ONLY_RULES.admin)])].sort();
const functionName = 'cinashop_runtime_lock_only_v1';
const triggerName = functionName;

function body(app: string, admin: string) {
  pricingIdentifier(app); pricingIdentifier(admin);
  if (app === admin) throw Error('Distinct runtime identities required');
  const branches = (['app','admin'] as const).map(kind => {
    const role = kind==='app'?app:admin;
    const cases = Object.entries(RUNTIME_LOCK_ONLY_RULES[kind]).sort(([a],[b])=>a.localeCompare(b)).map(([table,columns]) => {
      const excluded=columns.length?`ARRAY[${columns.map(c=>`'${c}'`).join(',')}]::text[]`:`ARRAY[]::text[]`;
      return `WHEN '${table}' THEN
        IF (pg_catalog.to_jsonb(NEW) - ${excluded}) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ${excluded}) THEN
          RAISE EXCEPTION 'Runtime lock privilege cannot edit catalog rows' USING ERRCODE='42501';
        END IF;`;
    }).join('\n');
    return `IF current_user='${role}' THEN CASE TG_TABLE_NAME ${cases} ELSE NULL; END CASE; END IF;`;
  }).join('\n');
  return `BEGIN\n${branches}\nRETURN NEW;\nEND`;
}

export async function inspectRuntimeLockOnlyBoundary(tx: Query, app: string, admin: string, maintenance: string) {
  pricingIdentifier(maintenance);
  const definition=body(app,admin);
  const [r]=await tx.execute(sql`WITH routines AS (
    SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=${functionName}
  ), targets AS (SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
    AND c.relname IN (${sql.join(tables.map(t=>sql`${t}`),sql`, `)}))
  SELECT NOT EXISTS(SELECT 1 FROM routines)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN targets c ON c.oid=t.tgrelid WHERE t.tgname=${triggerName}) AS absent,
    (SELECT count(*)=1 AND bool_and(p.pronargs=0 AND p.proargtypes=''::oidvector AND p.prokind='f'
      AND p.prorettype='pg_catalog.trigger'::regtype AND p.prosrc=${definition} AND NOT p.prosecdef AND NOT p.proleakproof
      AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u'
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0
      AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL
      AND p.proargnames IS NULL AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenance})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner)) FROM routines p) AS routine_safe,
    (SELECT count(*)=${tables.length} AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenance})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)) FROM targets c) AS tables_safe,
    (SELECT count(*)=${tables.length} AND bool_and(t.tgenabled='O' AND t.tgtype=19 AND NOT t.tgisinternal
      AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector AND t.tgqual IS NULL
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgparentid=0
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND t.tgfoid=(SELECT oid FROM routines LIMIT 1))
      FROM pg_catalog.pg_trigger t JOIN targets c ON c.oid=t.tgrelid WHERE t.tgname=${triggerName}) AS triggers_safe`);
  return { absent:r?.absent===true, ready:r?.routine_safe===true && r?.tables_safe===true && r?.triggers_safe===true,
    tablesSafe:r?.tables_safe===true, routineSafe:r?.routine_safe===true, triggersSafe:r?.triggers_safe===true };
}

/** Existing caller-owned, bounded maintenance transaction only. Does not grant
 * privileges, change business data, repair drift or create/alter LOGIN roles. */
export async function installRuntimeLockOnlyBoundaryInTransaction(tx: Query, app: string, admin: string, maintenance: string) {
  if (Object.hasOwn(tx,'$client')) throw Error('Lock-only boundary requires an existing transaction');
  body(app,admin); pricingIdentifier(maintenance);
  await tx.execute(sql`SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
    set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [environment]=await tx.execute(sql`SELECT current_user=${maintenance} AND session_user=current_user
    AND current_setting('server_version_num')::int/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND (SELECT count(*)=2 AND bool_and(r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
      FROM pg_catalog.pg_roles r WHERE rolname IN (${app},${admin}) AND rolname<>current_user)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if(environment?.supported!==true)throw Error('Lock-only boundary identity requires review');
  await tx.execute(sql.raw('LOCK TABLE '+tables.map(t=>'public.'+pricingIdentifier(t)).join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const state=await inspectRuntimeLockOnlyBoundary(tx,app,admin,maintenance);
  if(state.ready)return {applied:false,...state};
  if(!state.absent || !state.tablesSafe)throw Error('Lock-only boundary catalog drift');
  await tx.execute(sql.raw(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path=pg_catalog,pg_temp AS $lock_boundary$${body(app,admin)}$lock_boundary$`));
  await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION public.${functionName}() FROM PUBLIC`));
  for(const table of tables)await tx.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON public.${pricingIdentifier(table)}
    FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`));
  const after=await inspectRuntimeLockOnlyBoundary(tx,app,admin,maintenance);
  if(!after.ready)throw Error('Lock-only boundary verification failed');
  return {applied:true,...after};
}
