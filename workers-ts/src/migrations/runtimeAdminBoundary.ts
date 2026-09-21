import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
const tables = ['system_admin', 'system_role', 'system_menus'] as const;
const functionName = 'cinashop_runtime_admin_boundary_v1';
const triggerName = 'cinashop_runtime_admin_boundary_v1';

/** SECURITY INVOKER only: the app cannot acquire any new authority by calling
 * this trigger. Supplier type=4 remains writable; platform identity, role and
 * menu authority cannot be rewritten through the shared application LOGIN.
 * This is NOT tenant isolation between suppliers (enforced by services). */
export function runtimeAdminBoundaryBody(appRole: string) {
  pricingIdentifier(appRole);
  return `
BEGIN
  IF current_user = '${appRole}' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Application identity cannot remove staff authority' USING ERRCODE='42501';
    ELSIF TG_TABLE_NAME = 'system_admin' THEN
      IF TG_OP = 'INSERT' THEN
        IF NEW.admin_type = 4 AND NEW.relation_id > 0 THEN RETURN NEW; END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.admin_type = 4 AND NEW.admin_type = 4 AND OLD.id = NEW.id
          AND OLD.relation_id = NEW.relation_id AND NEW.relation_id > 0 THEN RETURN NEW; END IF;
        IF (pg_catalog.to_jsonb(NEW) - ARRAY['last_ip','last_time','login_count'])
          = (pg_catalog.to_jsonb(OLD) - ARRAY['last_ip','last_time','login_count']) THEN RETURN NEW; END IF;
      END IF;
    ELSIF TG_TABLE_NAME = 'system_role' THEN
      IF TG_OP = 'INSERT' THEN
        IF NEW.type = 4 AND NEW.relation_id > 0 THEN RETURN NEW; END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.type = 4 AND NEW.type = 4 AND OLD.id = NEW.id
          AND OLD.relation_id = NEW.relation_id AND NEW.relation_id > 0 THEN RETURN NEW; END IF;
        IF pg_catalog.to_jsonb(NEW) = pg_catalog.to_jsonb(OLD) THEN RETURN NEW; END IF;
      END IF;
    ELSIF TG_TABLE_NAME = 'system_menus' AND TG_OP = 'UPDATE' THEN
      IF pg_catalog.to_jsonb(NEW) = pg_catalog.to_jsonb(OLD) THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Application identity cannot rewrite platform authority' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
`;
}

/** Read-only exact trigger/function boundary check. It deliberately does not
 * certify the role's remaining table grants, memberships or other routines. */
export async function inspectRuntimeAdminBoundary(tx: Query, appRole: string, maintenanceRole: string) {
  pricingIdentifier(maintenanceRole);
  const body = runtimeAdminBoundaryBody(appRole);
  const [row] = await tx.execute(sql`WITH routine AS (
    SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=${functionName}
  ), targets AS (
    SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN ('system_admin','system_role','system_menus')
  ) SELECT
    NOT EXISTS(SELECT 1 FROM routine) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t JOIN targets c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname=${triggerName}) AS absent,
    (SELECT count(*)=1 AND bool_and(p.pronargs=0 AND p.prokind='f' AND p.prorettype='pg_catalog.trigger'::regtype
      AND NOT p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
      AND p.provolatile='v' AND p.proparallel='u' AND p.prosrc=${body}
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0
      AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargtypes=''::oidvector
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL
      AND p.proargdefaults IS NULL AND p.protrftypes IS NULL
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
      AND p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenanceRole})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner)) FROM routine p) AS routine_safe,
    (SELECT count(*)=3 AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenanceRole})
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)) FROM targets c) AS tables_safe,
    (SELECT count(*)=3 AND bool_and(t.tgname=${triggerName} AND t.tgenabled='O' AND t.tgtype=31
      AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector AND t.tgqual IS NULL
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgparentid=0
      AND t.tgfoid=(SELECT oid FROM routine LIMIT 1)) FROM pg_catalog.pg_trigger t JOIN targets c ON c.oid=t.tgrelid
      WHERE NOT t.tgisinternal) AS triggers_safe`);
  return { absent: row?.absent === true, ready: row?.routine_safe === true && row?.tables_safe === true && row?.triggers_safe === true,
    routineSafe: row?.routine_safe === true, tablesSafe: row?.tables_safe === true, triggersSafe: row?.triggers_safe === true };
}

/** Run only inside the reviewed commissioning transaction. No GRANT, role
 * creation, data repair or replacement of an existing/drifted object. */
export async function installRuntimeAdminBoundaryInTransaction(tx: Query, appRole: string, maintenanceRole: string) {
  if (Object.hasOwn(tx, '$client')) throw Error('Staff boundary requires an existing transaction');
  pricingIdentifier(appRole); pricingIdentifier(maintenanceRole);
  await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout','5000',true),
    pg_catalog.set_config('lock_timeout','1000',true), pg_catalog.set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [environment] = await tx.execute(sql`SELECT current_user=${maintenanceRole} AND session_user=current_user
    AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND current_setting('session_replication_role')='origin'
    AND current_user<>${appRole} AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=${appRole} AND r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (environment?.supported !== true) throw Error('Staff boundary target or identity requires review');
  await tx.execute(sql.raw('LOCK TABLE '+tables.map(t=>'public."'+t+'"').join(',')+' IN ACCESS EXCLUSIVE MODE NOWAIT'));
  const state = await inspectRuntimeAdminBoundary(tx, appRole, maintenanceRole);
  if (state.ready) return { applied: false, ...state };
  if (!state.absent || !state.tablesSafe) throw Error('Staff authority catalog drift');
  const [extra] = await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE NOT tgisinternal
    AND tgrelid IN ('public.system_admin'::regclass,'public.system_role'::regclass,'public.system_menus'::regclass)) AS present`);
  if (extra?.present !== false) throw Error('Unreviewed staff authority trigger');
  await tx.execute(sql.raw(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path=pg_catalog,pg_temp AS $staff_boundary$${runtimeAdminBoundaryBody(appRole)}$staff_boundary$`));
  await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION public.${functionName}() FROM PUBLIC`));
  for (const table of tables) await tx.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE OR DELETE
    ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`));
  const after = await inspectRuntimeAdminBoundary(tx, appRole, maintenanceRole);
  if (!after.ready) throw Error('Staff authority boundary verification failed');
  return { applied: true, ...after };
}
