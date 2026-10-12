/** DB-003 catalog evidence only. No configuration rows or cluster identifier are read. */
type Query = (statement: string, parameters?: readonly string[]) => Promise<Record<string, unknown>[]>;

type Column = {
  name: string;
  type: string;
  not_null: boolean;
  default: string | null;
  identity: string;
  generated: string;
};

const EXPECTED_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["id", "integer", "serial"],
  ["is_store", "smallint", "0"],
  ["menu_name", "character varying(255)", "empty"],
  ["type", "character varying(255)", "empty"],
  ["input_type", "character varying(20)", "input"],
  ["config_tab_id", "integer", "0"],
  ["parameter", "character varying(255)", "empty"],
  ["upload_type", "smallint", "1"],
  ["required", "character varying(255)", "empty"],
  ["width", "integer", "0"],
  ["high", "integer", "0"],
  ["value", "character varying(5000)", "empty"],
  ["info", "character varying(255)", "empty"],
  ["desc", "character varying(255)", "empty"],
  ["sort", "integer", "0"],
  ["status", "smallint", "0"],
];

const IDENTITY_SQL = `SELECT current_database() AS database_name,
  current_user AS current_role, session_user AS session_role,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid,
  current_setting('server_version_num')::integer AS version_num,
  current_setting('transaction_read_only') AS transaction_read_only,
  current_setting('transaction_isolation') AS transaction_isolation,
  pg_catalog.pg_is_in_recovery() AS in_recovery,
  EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a
    JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
    WHERE a.pid=pg_catalog.pg_backend_pid() AND a.backend_type='client backend'
      AND a.usename=current_user AND r.rolname=current_user AND r.rolcanlogin
      AND NOT r.rolsuper AND NOT r.rolreplication AND NOT r.rolbypassrls) AS backend_login_ok,
  pg_catalog.has_function_privilege(current_user,
    'pg_catalog.pg_control_system()'::regprocedure, 'EXECUTE') AS control_system_executable`;

const CATALOG_SQL = `SELECT c.relkind::text AS relation_kind,
  c.relpersistence::text AS persistence, c.relispartition AS is_partition,
  c.relrowsecurity AS row_security, c.relforcerowsecurity AS force_row_security,
  owner.rolname AS owner_name,
  (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
      'identity',a.attidentity::text,'generated',a.attgenerated::text)
    ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
  (SELECT count(*)::integer FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS trigger_count,
  (SELECT count(*)::integer FROM pg_catalog.pg_rewrite r
    WHERE r.ev_class=c.oid AND r.rulename<>'_RETURN') AS rule_count,
  (SELECT count(*)::integer FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid) AS policy_count,
  (SELECT count(*)::integer FROM pg_catalog.pg_inherits i
    WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inheritance_count,
  (SELECT count(*)::integer FROM pg_catalog.pg_constraint f
    WHERE f.contype='f' AND f.confrelid=c.oid) AS inbound_fk_count,
  pg_catalog.pg_get_serial_sequence('public.system_config','id') AS id_sequence,
  (SELECT count(*)::integer FROM pg_catalog.pg_depend d
    JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S'
    WHERE d.classid='pg_catalog.pg_class'::regclass
      AND d.refclassid='pg_catalog.pg_class'::regclass
      AND d.refobjid=c.oid AND d.deptype IN ('a','i')) AS owned_sequence_count,
  pg_catalog.has_table_privilege(current_user,c.oid,'SELECT') AS app_select,
  pg_catalog.has_table_privilege(current_user,c.oid,'DELETE') AS app_delete,
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname=$1 AND r.rolcanlogin
      AND pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE')) AS maintenance_delete
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_roles owner ON owner.oid=c.relowner
  WHERE n.nspname='public' AND c.relname='system_config'`;

function defaultMatches(actual: string | null, kind: string): boolean {
  if (kind === "serial") return typeof actual === "string"
    && /^nextval\('(?:public\.)?system_config_id_seq'::regclass\)$/.test(actual);
  if (kind === "empty") return actual === "''::character varying";
  if (kind === "input") return actual === "'input'::character varying";
  return actual === kind;
}

function exactColumns(value: unknown): value is Column[] {
  return Array.isArray(value) && value.length === EXPECTED_COLUMNS.length
    && value.every((column, index) => {
      const expected = EXPECTED_COLUMNS[index];
      return column && typeof column === "object" && !Array.isArray(column)
        && Object.keys(column).sort().join("|") === "default|generated|identity|name|not_null|type"
        && column.name === expected[0] && column.type === expected[1]
        && column.not_null === true && column.identity === "" && column.generated === ""
        && defaultMatches(column.default, expected[2]);
    });
}

function trueBoolean(value: unknown): boolean { return value === true; }
function zeroCount(value: unknown): boolean { return value === 0; }
function oidText(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value)
    && Number(value) <= 4_294_967_295;
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The caller supplies a read-only transaction; role names are fixed at its call site. */
export async function readSystemConfigCatalog(
  query: Query,
  expectedDatabase: string,
  expectedAppRole: string,
  maintenanceRole: string,
) {
  const identityRows = await query(IDENTITY_SQL);
  const identity = identityRows.length === 1 ? identityRows[0] : undefined;
  const identityChecks = {
    database: identity?.database_name === expectedDatabase,
    currentRole: identity?.current_role === expectedAppRole,
    sessionRole: identity?.session_role === expectedAppRole,
    backendLogin: trueBoolean(identity?.backend_login_ok),
    postgres16: typeof identity?.version_num === "number" && identity.version_num >= 160000
      && identity.version_num < 170000,
    readOnly: identity?.transaction_read_only === "on",
    repeatableRead: identity?.transaction_isolation === "repeatable read",
    primary: identity?.in_recovery === false,
    databaseOidPresent: oidText(identity?.database_oid),
  };
  if (Object.values(identityChecks).some((passed) => !passed)) {
    throw new Error("DB-003 catalog identity failed");
  }
  const catalogRows = await query(CATALOG_SQL, [maintenanceRole]);
  const catalog = catalogRows.length === 1 ? catalogRows[0] : undefined;
  const checks = {
    ordinaryPersistentTable: catalog?.relation_kind === "r" && catalog.persistence === "p"
      && catalog.is_partition === false,
    exactSixteenColumns: exactColumns(catalog?.columns),
    ownerIsNotApp: typeof catalog?.owner_name === "string"
      && catalog.owner_name !== expectedAppRole,
    noRowSecurity: catalog?.row_security === false && catalog.force_row_security === false
      && zeroCount(catalog.policy_count),
    noTriggers: zeroCount(catalog?.trigger_count),
    noRules: zeroCount(catalog?.rule_count),
    noInheritance: zeroCount(catalog?.inheritance_count),
    noInboundForeignKeys: zeroCount(catalog?.inbound_fk_count),
    idSequenceOwned: catalog?.id_sequence === "public.system_config_id_seq"
      && catalog.owned_sequence_count === 1,
    appSelectOnly: trueBoolean(catalog?.app_select) && catalog?.app_delete === false,
    maintenanceCatalogDelete: trueBoolean(catalog?.maintenance_delete),
  };
  const catalogStructure = {
    relation_kind: catalog?.relation_kind, persistence: catalog?.persistence,
    is_partition: catalog?.is_partition, row_security: catalog?.row_security,
    force_row_security: catalog?.force_row_security, columns: catalog?.columns,
    trigger_count: catalog?.trigger_count, rule_count: catalog?.rule_count,
    policy_count: catalog?.policy_count, inheritance_count: catalog?.inheritance_count,
    inbound_fk_count: catalog?.inbound_fk_count, id_sequence: catalog?.id_sequence,
    owned_sequence_count: catalog?.owned_sequence_count,
  };
  return {
    databaseOid: identity!.database_oid as string,
    identityChecks,
    catalogSha256: await digest(catalogStructure),
    columnCount: Array.isArray(catalog?.columns) ? catalog.columns.length : 0,
    checks,
    catalogSafe: Object.values(checks).every(Boolean),
    controlSystemAclExecutable: trueBoolean(identity?.control_system_executable),
    originIdentityVerified: false,
    readyForDml: false,
  };
}
