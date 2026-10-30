import type { RuntimePrivilegePlan } from './runtimeBusinessPrivilegePlan';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { inspectCashierSecondCardFormImages } from './runCashierSecondCardFormImages';
import { cashierSecondCardRuntimeGrantSql, cashierSecondCardRuntimePrivilegePlan } from './cashierSecondCardRuntimePlan';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS,
  CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS } from './cashierSecondCardFormImages';
export { CASHIER_SECOND_CARD_FORM_IMAGE_TABLES, CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS,
  CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS, CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS } from './cashierSecondCardFormImages';
export const CASHIER_SECOND_CARD_FORM_IMAGES_RUNTIME_OPERATION = 'customer-cashier-second-card-form-images-runtime-v1';
/** Source/owner/ACL proof independent of the querying principal. The complete
 * named Cashier audit separately checks every effective privilege. */
export async function inspectCashierSecondCardFormImagesRuntimeCatalog(db: Pick<DbClient,'execute'>, maintenance: string) {
  pricingIdentifier(maintenance);
  const catalog = await inspectCashierSecondCardFormImages(db), failures:string[]=[];
  if (!catalog.complete) failures.push('cashier_form_images_catalog');
  const allowed = [
    ...CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS.map(c => [CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[0],c]),
    ...CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS.map(c => [CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[1],c]),
  ];
  const [authority] = await db.execute(sql`WITH relations AS(SELECT * FROM pg_catalog.pg_class
    WHERE relnamespace='public'::regnamespace AND relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(CASHIER_SECOND_CARD_FORM_IMAGE_TABLES)}::jsonb))),
    columns AS(SELECT a.*,c.relname FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    allowed AS(SELECT x->>0 AS table_name,x->>1 AS column_name FROM jsonb_array_elements(${JSON.stringify(allowed)}::jsonb) x),
    routines AS(SELECT * FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN(SELECT split_part(jsonb_array_elements_text(${JSON.stringify(CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS)}::jsonb),'(',1)))
    SELECT (SELECT count(*)=2 AND bool_and(c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenance})
      AND c.relkind='r' AND c.relpersistence='p' AND NOT(c.relrowsecurity OR c.relforcerowsecurity OR c.relispartition OR c.relhasrules)
      AND c.reloptions IS NULL AND c.relreplident='d'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)) FROM relations c)
      AND NOT EXISTS(SELECT 1 FROM relations c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM columns c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
        WHERE a.grantee=0 OR a.is_grantable OR a.privilege_type<>'UPDATE'
          OR NOT EXISTS(SELECT 1 FROM allowed x WHERE x.table_name=c.relname AND x.column_name=c.attname))
      AND NOT EXISTS(SELECT 1 FROM relations c JOIN pg_catalog.pg_depend d ON d.refobjid=c.oid
        JOIN pg_catalog.pg_class s ON s.oid=d.objid WHERE d.classid='pg_catalog.pg_class'::regclass AND d.refclassid=d.classid
          AND d.deptype IN('a','i') AND s.relkind='S') AS tables,
      (SELECT count(*)=3 AND bool_and(p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenance})
        AND NOT p.prosecdef) FROM routines p)
      AND NOT EXISTS(SELECT 1 FROM routines p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE a.grantee<>p.proowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')) AS routines`);
  if (authority?.tables !== true) failures.push('cashier_form_images_table_authority');
  if (authority?.routines !== true) failures.push('cashier_form_images_routine_authority');
  const tables = await db.execute(sql`SELECT oid::text AS oid,relname AS name,relowner::text AS owner
    FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN(SELECT jsonb_array_elements_text(${JSON.stringify(CASHIER_SECOND_CARD_FORM_IMAGE_TABLES)}::jsonb)) ORDER BY relname,oid`);
  const functions = await db.execute(sql`SELECT oid::text AS oid,proname AS name,proowner::text AS owner
    FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN(SELECT split_part(jsonb_array_elements_text(${JSON.stringify(CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS)}::jsonb),'(',1)) ORDER BY proname,oid`);
  return { ready:failures.length===0, readOnly:true as const, failures, catalog, tables, functions };
}
/** Adds only guarded session/upload columns; the existing profile stays intact. */
export function cashierSecondCardFormImagesRuntimePrivilegePlan(): RuntimePrivilegePlan {
  const previous = cashierSecondCardRuntimePrivilegePlan();
  return { tables: { ...Object.fromEntries(Object.entries(previous.tables).map(([name, values]) => [name, [...values]])),
    ...Object.fromEntries(CASHIER_SECOND_CARD_FORM_IMAGE_TABLES.map(name => [name, ['SELECT', 'INSERT']])) },
    updateColumns: { ...Object.fromEntries(Object.entries(previous.updateColumns).map(([name, values]) => [name, [...values]])),
      cashier_second_card_form_session_v1: [...CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS],
      cashier_second_card_form_upload_v1: [...CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS] },
    functions: [...previous.functions, ...CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS], standaloneSequences: [...previous.standaloneSequences] };
}
/** Explicit maintenance compiler; never runtime installation or repair. */
export function cashierSecondCardFormImagesRuntimeGrantSql(role: string, owned: readonly { name: string; table: string }[]) {
  return [...cashierSecondCardRuntimeGrantSql(role, owned), ...cashierSecondCardFormImagesRuntimeAddonGrantSql(role)];
}
/** Fixed addon only: a complete existing source profile has already been
 * proven by the maintenance forward. Never replay unrelated base grants. */
export function cashierSecondCardFormImagesRuntimeAddonGrantSql(role: string) {
  const target = pricingIdentifier(role), statements:string[] = [];
  for (const table of CASHIER_SECOND_CARD_FORM_IMAGE_TABLES) statements.push(`GRANT SELECT,INSERT ON public.${pricingIdentifier(table)} TO ${target}`);
  for (const [table, columns] of [[CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[0], CASHIER_SECOND_CARD_FORM_SESSION_UPDATE_COLUMNS],
    [CASHIER_SECOND_CARD_FORM_IMAGE_TABLES[1], CASHIER_SECOND_CARD_FORM_UPLOAD_UPDATE_COLUMNS]] as const)
    statements.push(`GRANT UPDATE(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(table)} TO ${target}`);
  for (const signature of CASHIER_SECOND_CARD_FORM_IMAGE_FUNCTIONS) statements.push(`GRANT EXECUTE ON FUNCTION public.${signature} TO ${target}`);
  return statements;
}
