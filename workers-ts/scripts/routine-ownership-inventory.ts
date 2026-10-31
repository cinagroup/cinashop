/** Maintenance-only database inventory. This is deliberately outside the
 * Worker dependency graph. It neither attributes history to an AppID nor
 * issues/consumes a switch permit. No runtime connection or APP_KEY fallback. */
import { createHmac, type Hmac } from 'node:crypto';
import type postgres from 'postgres';

type Query = Pick<postgres.Sql, 'unsafe'>;
type Relation = { oid: string; type_oid: string; schema: string; name: string; kind: string; am: string | null };
type Column = { name: string; oid: number; namespace: string; type: string };
export type RoutineInventoryTarget = Readonly<{ database: string; maintenance: string }>;
export type RoutineOwnershipInventory = {
  version: 1; purpose: 'routine_ownership_database_inventory';
  database: { name: string; oid: string }; maintenance: { name: string; oid: string };
  snapshot: string; observedAt: string;
  scope: 'non_system_heap_tables_and_partition_roots';
  ownership: 'not_evaluated'; activationAllowed: false; externalSourcesIncluded: false;
  metadataDigest: string; sourceDigest: string; rowCount: string;
  relations: { oid: string; schema: string; name: string; kind: string; rowCount: string; digest: string }[];
};

// Capacity refusals are whole-operation failures, never successful prefixes.
const PAGE = 16, MAX_RELATIONS = 2048, MAX_ROW_BYTES = 262144, MAX_DURATION_MS = 30000;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const scope = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
const tableScope = `SELECT c.oid::text AS oid,c.reltype::text AS type_oid,n.nspname AS schema,c.relname AS name,c.relkind AS kind,a.amname AS am
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_catalog.pg_am a ON a.oid=c.relam
  WHERE ${scope} AND c.relkind IN ('r','m','p','f') ORDER BY c.oid LIMIT ${MAX_RELATIONS + 1}`;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const fail = () => new Error('Routine ownership database inventory incomplete');
function frame(hash: Hmac, value: string) {
  hash.update(String(Buffer.byteLength(value, 'utf8')) + ':'); hash.update(value, 'utf8');
}
function hash(key: string, domain: string) {
  return createHmac('sha256', key).update('cinashop.routine-ownership-inventory.v1\0' + domain + '\0');
}

// Exact built-in scalar types only. Custom type output/JSON casts can execute
// user code. Arrays, domains, enums, foreign tables and custom table AMs require
// a separately reviewed extension, not a fallback cast in this reader.
const scalarOids = new Set([16,17,18,19,20,21,23,25,26,114,700,701,1042,1043,1082,1083,1114,1184,1186,1266,1700,2950,3802]);
function rowBudget(columns: Column[]) {
  let overhead = 2;
  const terms = columns.map(column => {
    if (column.namespace !== 'pg_catalog' || !scalarOids.has(column.oid)) throw fail();
    overhead += 8 + Buffer.byteLength(column.name, 'utf8') * 6;
    const c = 't.' + quote(column.name);
    if ([17,25,1042,1043].includes(column.oid))
      return `COALESCE(6::bigint*pg_catalog.octet_length(${c}),4)`;
    if (column.oid === 1700)
      return `COALESCE(pg_catalog.octet_length(${c}::text)::bigint,4)`;
    // Bound the binary/input document before conversion. Small JSONB numeric
    // values can expand to 100k+ decimal characters, so size*8 alone is unsafe.
    // Walk numeric leaves first; each PG numeric scalar has a bounded output.
    // The walk is over <=32KiB input, never an already expanded full document.
    if ([114,3802].includes(column.oid)) {
      const json = column.oid === 114 ? `${c}::jsonb` : c;
      return `CASE WHEN pg_catalog.pg_column_compression(${c}) IS NOT NULL OR pg_catalog.pg_column_size(${c})>32768
        THEN ${MAX_ROW_BYTES + 1} ELSE COALESCE(8::bigint*pg_catalog.pg_column_size(${c}),4)
        +COALESCE((SELECT sum(pg_catalog.octet_length(v::text)) FROM pg_catalog.jsonb_path_query(${json},
          'strict $.** ? (@.type() == "number")'::jsonpath) AS numbers(v)),0) END`;
    }
    return '128::bigint';
  });
  return `${overhead}::bigint` + terms.map(term => '+' + term).join('');
}

// Catalog rows are streamed too; no json_agg over the complete database. These
// are definitions/privileges, not sequence reservations or pg_authid secrets.
// Statistics and physical allocation fields are intentionally excluded.
const metadataQueries = [
  `SELECT to_jsonb(n)::text AS value FROM pg_catalog.pg_namespace n WHERE ${scope} ORDER BY n.oid`,
  `SELECT (to_jsonb(c)-ARRAY['relpages','reltuples','relallvisible','relfrozenxid','relminmxid'])::text AS value
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${scope} ORDER BY c.oid`,
  ...[
    ['pg_attribute','a','a.attrelid','a.attrelid,a.attnum','AND a.attnum>0'],
    ['pg_attrdef','a','a.adrelid','a.oid',''],
    ['pg_index','a','a.indrelid','a.indexrelid',''],
    ['pg_trigger','a','a.tgrelid','a.oid',''],
    ['pg_rewrite','a','a.ev_class','a.oid',''],
    ['pg_policy','a','a.polrelid','a.oid',''],
    ['pg_sequence','a','a.seqrelid','a.seqrelid',''],
    ['pg_inherits','a','a.inhrelid','a.inhrelid,a.inhseqno',''],
  ].map(([table, alias, relation, order, extra]) => `SELECT to_jsonb(${alias})::text AS value
    FROM pg_catalog.${table} ${alias} JOIN pg_catalog.pg_class c ON c.oid=${relation}
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${scope} ${extra} ORDER BY ${order}`),
  ...[
    ['pg_constraint','connamespace'], ['pg_proc','pronamespace'], ['pg_type','typnamespace'], ['pg_collation','collnamespace'],
  ].map(([table, namespace]) => `SELECT to_jsonb(a)::text AS value FROM pg_catalog.${table} a
    JOIN pg_catalog.pg_namespace n ON n.oid=a.${namespace} WHERE ${scope} ORDER BY a.oid`),
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_enum a JOIN pg_catalog.pg_type t ON t.oid=a.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE ${scope} ORDER BY a.oid`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_range a JOIN pg_catalog.pg_type t ON t.oid=a.rngtypid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE ${scope} ORDER BY a.rngtypid`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_default_acl a ORDER BY a.oid`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_roles a ORDER BY a.oid`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_auth_members a ORDER BY a.oid`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_db_role_setting a ORDER BY a.setdatabase,a.setrole`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_extension a ORDER BY a.oid`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_event_trigger a ORDER BY a.oid`,
  `SELECT to_jsonb(a)::text AS value FROM pg_catalog.pg_database a WHERE datname=current_database()`,
];
const limitsSql = `SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
  set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',true),
  set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true),
  set_config('temp_file_limit',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='temp_file_limit'),-1),65536)::text||'kB',true)`;

/** Use a dedicated, exclusively held max-one postgres.js root connection.
 * Locks precede the first RR SELECT/snapshot: TRUNCATE/table rewrites otherwise
 * can falsely appear empty. Discovery is not evidence and is checked again
 * under those locks. READ ONLY + superuser bypasses RLS without running views.
 * This API makes no provider/Redis/SMS call and performs no DML/DDL/grants. */
export async function collectRoutineOwnershipInventory(client: postgres.Sql, declaration: RoutineInventoryTarget,
  fingerprintKey: string): Promise<RoutineOwnershipInventory> {
  // Capture primitives synchronously, before BEGIN or any awaited callback.
  const target = { database: declaration.database, maintenance: declaration.maintenance };
  if (![target.database,target.maintenance].every(v => typeof v === 'string' && IDENTIFIER.test(v))
    || typeof fingerprintKey !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprintKey)
    || !client.options || client.options.max !== 1 || client.options.prepare !== false) throw fail();
  const deadline = Date.now() + MAX_DURATION_MS;
  const query = async <T extends object>(db: Query, text: string, parameters: (string | number)[] = []) => {
    if (Date.now() >= deadline) throw fail();
    return db.unsafe<T[]>(text, parameters);
  };
  try {
    const contextSql = `SELECT d.oid::text AS database_oid,r.oid::text AS role_oid,
      pg_backend_pid() AS pid,extract(epoch FROM pg_postmaster_start_time())::text AS server_start,
      current_database() AS database,current_user AS maintenance,
      current_user=session_user AND r.rolsuper AND r.rolcanlogin AND current_setting('server_version_num')::integer/10000=16
      AND current_setting('server_encoding')='UTF8' AND NOT pg_is_in_recovery()
      AND current_setting('session_replication_role')='origin' AS ready
      FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`;
    type Context = { database_oid: string; role_oid: string; pid: number; server_start: string;
      database: string; maintenance: string; ready: boolean };
    const { before, discovered } = await client.begin('isolation level read committed read only', async tx => {
      await query(tx, 'SET LOCAL search_path=pg_catalog');
      await query(tx, limitsSql);
      const [before] = await query<Context>(tx, contextSql);
      if (!before?.ready || before.database !== target.database || before.maintenance !== target.maintenance) throw fail();
      return { before, discovered: Array.from(await query<Relation>(tx, tableScope)) };
    });
    // PG LOCK TABLE does not support materialized views. Do not skip them and
    // return an apparently complete snapshot while REFRESH can rewrite them.
    if (discovered.length > MAX_RELATIONS || discovered.some(r => ['f','m'].includes(r.kind)
      || (r.kind !== 'p' && r.am !== 'heap'))) throw fail();
    return await client.begin('isolation level repeatable read read only', async tx => {
      await query(tx, `SET LOCAL search_path=pg_catalog; SET LOCAL row_security=off;
        SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL intervalstyle='postgres';
        SET LOCAL bytea_output='hex'; SET LOCAL extra_float_digits=3; SET LOCAL max_parallel_workers_per_gather=0`);
      // No SELECT (even set_config/pg_settings) may be moved above this lock.
      if (discovered.length) await query(tx, 'LOCK TABLE ' + discovered.map(r =>
        'ONLY ' + quote(r.schema) + '.' + quote(r.name)).join(',') + ' IN ACCESS SHARE MODE NOWAIT');
      await query(tx, limitsSql);
      const [actual] = await query<Context>(tx, contextSql);
      if (JSON.stringify(actual) !== JSON.stringify(before)) throw fail();
      const locked = Array.from(await query<Relation>(tx, tableScope));
      if (JSON.stringify(locked) !== JSON.stringify(discovered)) throw fail();
      const [snapshot] = await query<{ snapshot: string; observed_at: string; ready: boolean }>(tx,
        `SELECT pg_current_snapshot()::text AS snapshot,clock_timestamp()::text AS observed_at,
        current_setting('transaction_isolation')='repeatable read' AND current_setting('transaction_read_only')='on' AS ready`);
      if (!snapshot?.ready) throw fail();
      // Validate the complete stored column universe before catalog JSON too:
      // pg_attribute.attmissingval may contain a typed array whose conversion
      // would otherwise reach a custom type output function during metadata.
      const unsupported = await query(tx, `SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_type t ON t.oid=a.atttypid WHERE ${scope} AND c.relkind IN ('r','p')
        AND a.attnum>0 AND NOT a.attisdropped AND (t.typnamespace<>'pg_catalog'::regnamespace
          OR a.atttypid NOT IN (${[...scalarOids].join(',')})) LIMIT 1`);
      if (unsupported.length) throw fail();
      // Fast ADD COLUMN defaults live in pg_attribute as anyarray. Budget them
      // before serializing that catalog row too. JSON missing values need a
      // separate typed reader; do not expand them via an unbounded anyarray.
      const missing = await query(tx, `SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE ${scope} AND c.relkind IN ('r','p') AND a.attmissingval IS NOT NULL
        AND (a.atttypid IN (114,3802) OR pg_column_compression(a.attmissingval) IS NOT NULL
          OR pg_column_size(a.attmissingval)>32768) LIMIT 1`);
      if (missing.length) throw fail();
      // Reject user-defined scalar→JSON casts before calling to_jsonb(record).
      const casts = await query(tx, `SELECT 1 FROM pg_cast c JOIN pg_proc p ON p.oid=c.castfunc
        WHERE c.castsource IN (${[...scalarOids].join(',')}) AND c.casttarget IN (114,3802)
        AND p.pronamespace<>'pg_catalog'::regnamespace LIMIT 1`);
      if (casts.length) throw fail();
      type StreamRow = { value: string | null; row_type?: string; empty?: boolean };
      const stream = async (select: string, visit: (row: StreamRow) => void) => {
        await query(tx, 'DECLARE routine_inventory_cursor NO SCROLL CURSOR WITHOUT HOLD FOR ' + select);
        for (;;) {
          const rows = await query<StreamRow>(tx, `FETCH FORWARD ${PAGE} FROM routine_inventory_cursor`);
          for (const row of rows) {
            if (typeof row.value !== 'string' || Buffer.byteLength(row.value, 'utf8') > MAX_ROW_BYTES) throw fail();
            visit(row);
          }
          if (rows.length < PAGE) break;
        }
        await query(tx, 'CLOSE routine_inventory_cursor');
      };
      const metadata = hash(fingerprintKey, 'metadata');
      for (let i = 0; i < metadataQueries.length; i++) {
        frame(metadata, String(i));
        // A too-large definition is refused before it reaches the client.
        await stream(`SELECT CASE WHEN octet_length(s.value)<=${MAX_ROW_BYTES} THEN s.value ELSE NULL END AS value
          FROM (${metadataQueries[i]}) s`, row => frame(metadata, row.value!));
      }
      const relations: RoutineOwnershipInventory['relations'] = [];
      let total = 0n;
      for (const relation of locked) {
        const columns = await query<Column>(tx, `SELECT a.attname AS name,a.atttypid::integer AS oid,n.nspname AS namespace,t.typname AS type
          FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace n ON n.oid=t.typnamespace
          WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, [relation.oid]);
        if (columns.length > 512) throw fail();
        const budget = rowBudget(columns), digest = hash(fingerprintKey, 'relation');
        frame(digest, JSON.stringify(relation));
        let count = 0n;
        // The sentinel makes even an empty parsed relation attest its actual
        // composite type OID. Schema rename/replacement can evade explicit RR
        // catalog reads; it cannot make a replacement table have this type OID.
        if (relation.kind !== 'p') await stream(`SELECT s.row_type,s.empty,
          CASE WHEN s.empty THEN '' WHEN s.value IS NOT NULL AND octet_length(s.value)<=${MAX_ROW_BYTES - 64}
          THEN s.version||':'||s.position||':'||s.value ELSE NULL END AS value FROM (
          SELECT t.xmin::text AS version,t.ctid::text AS position,
            pg_typeof(t)::oid::text AS row_type,t.ctid IS NULL AS empty,
            CASE WHEN pg_typeof(t)::oid=${relation.type_oid}::oid THEN
              CASE WHEN (${budget})<=${MAX_ROW_BYTES - 64} THEN to_jsonb(t)::text ELSE NULL END ELSE NULL END AS value
          FROM (VALUES(1)) sentinel(n) LEFT JOIN ONLY ${quote(relation.schema)}.${quote(relation.name)} t ON true ORDER BY t.ctid) s`, row => {
          if (row.row_type !== relation.type_oid) throw fail();
          if (row.empty) return;
          frame(digest, row.value!); count++;
        });
        total += count;
        relations.push({ oid: relation.oid, schema: relation.schema, name: relation.name, kind: relation.kind,
          rowCount: count.toString(), digest: digest.digest('hex') });
      }
      const metadataDigest = metadata.digest('hex'), source = hash(fingerprintKey, 'source');
      frame(source, JSON.stringify([target,actual.database_oid,actual.role_oid,metadataDigest,relations]));
      // Construct a public result only after every source has completed.
      return { version: 1 as const, purpose: 'routine_ownership_database_inventory' as const,
        database: { name: target.database, oid: actual.database_oid }, maintenance: { name: target.maintenance, oid: actual.role_oid },
        snapshot: snapshot.snapshot, observedAt: snapshot.observed_at, scope: 'non_system_heap_tables_and_partition_roots' as const,
        ownership: 'not_evaluated' as const, activationAllowed: false as const, externalSourcesIncluded: false as const,
        metadataDigest, sourceDigest: source.digest('hex'), rowCount: total.toString(), relations };
    });
  } catch { throw fail(); } // SQL/cast errors can contain secrets or row values.
}
