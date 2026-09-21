import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { OFFLINE_CATALOG_SQL, OFFLINE_CATALOG_VERSIONS } from './offlineOrderCatalog';

/** Fixed ordinary indexes already declared by the ORM. No UNIQUE constraint,
 * row rewrite, DROP, IF NOT EXISTS, sequence or target-learned schema repair. */
export const RELEASE_SHARED_INDEXES = {
  system_config: {
    system_config_is_store_idx: ['is_store'], config_tab_id: ['config_tab_id'], system_config_menu_name_idx: ['menu_name'],
  },
  user: {
    user_account_idx: ['account'], spreaduid: ['spread_uid'], level: ['level'], user_status_idx: ['status'],
    work_uid: ['work_uid'], is_promoter: ['is_promoter', 'phone'], user_phone_idx: ['phone'],
    user_delete_time_idx: ['delete_time'], add_time_delete_sex: ['add_time', 'delete_time', 'sex'],
  },
  user_bill: {
    ub_uid_idx: ['uid'], ub_status: ['status'], ub_add_time: ['add_time'], ub_pm: ['pm'],
    ub_cat_type_link_idx: ['category', 'type', 'link_id'],
  },
  user_money: { um_uid_idx: ['uid'], um_type_link: ['type', 'link_id'] },
} as const;

export const RELEASE_SHARED_INDEX_SQL = Object.entries(RELEASE_SHARED_INDEXES).flatMap(([table, indexes]) =>
  Object.entries(indexes).map(([name, columns]) =>
    `CREATE INDEX "${name}" ON public."${table}" USING btree (${columns.map((column: string) => '"' + column + '"').join(',')});`)).join('\n');

/** Independently derived PG16 canonical predecessor, minus exactly these 19
 * ordinary indexes. Never generated from the production target. */
export const RELEASE_PRE_INDEX_HASHES: Record<string, string> = {
  system_config: '4787b4354ec5cc57dc789c05806f9d6bd4a59712051c5f395f2f7a6c0e86b9f4',
  user: '2fdb44f1f3070888d369d2a3aefa10bf5a2b387e1a9261f47569941c7c4e8193',
  user_bill: '52162eaf07eceb20c22c886bb4c15c83e3d474f181cec08dd2cc34ac5e00e3c8',
  user_money: '11b18c55700933f40f497ef7c37546920c45a099b1d83b813e3feeaa41481089',
};
type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
type Query = Pick<DbClient, 'execute'>;
const tables = Object.keys(RELEASE_SHARED_INDEXES);
async function inspect(tx: Query) {
  const catalog = await tx.execute(sql.raw(OFFLINE_CATALOG_SQL));
  return tables.map(name => {
    const rows = catalog.filter(row => row.name === name && row.kind === 'table');
    const row = rows[0], safe = rows.length === 1 && row.present === true && row.owned === true && row.safe === true;
    return { name, state: safe && [OFFLINE_CATALOG_VERSIONS.fresh[name], OFFLINE_CATALOG_VERSIONS.v1[name]].includes(row.fingerprint as string) ? 'ready'
      : safe && row.fingerprint === RELEASE_PRE_INDEX_HASHES[name] ? 'missing-reviewed-indexes' : 'drift' };
  });
}
async function setup(tx: Query) {
  await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout','5000',true),
    pg_catalog.set_config('lock_timeout','1000',true),pg_catalog.set_config('idle_in_transaction_session_timeout','5000',true),
    pg_catalog.set_config('search_path','public,pg_temp',true),pg_catalog.set_config('row_security','off',true)`);
  const [row] = await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16
    AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS safe`);
  if (row?.safe !== true) throw Error('Shared index environment requires review');
}
async function fingerprint(tx: Query) {
  const rows = [];
  for (const name of tables) {
    const [row] = await tx.execute(sql`SELECT count(*)::int AS rows,
      encode(sha256(convert_to(COALESCE(jsonb_agg(data ORDER BY data::text COLLATE "C")::text,'[]'),'UTF8')),'hex') AS sha256
      FROM (SELECT to_jsonb(t) AS data FROM public.${sql.identifier(name)} t LIMIT 10001) bounded`);
    if (!row || Number(row.rows) > 10000) throw Error('Shared index row budget exceeded');
    rows.push({ table: name, rows: row.rows, sha256: row.sha256 });
  }
  return rows;
}
export async function inspectReleaseSharedIndexes(db: Root) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Shared index inspection requires root');
  return db.transaction(async tx => { await setup(tx); return { tables: await inspect(tx) }; },
    { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export async function installReleaseSharedIndexes(db: Root) {
  if (!Object.hasOwn(db,'$client') || !db.$client) throw Error('Shared index installation requires root');
  return db.transaction(installReleaseSharedIndexesInTransaction, { isolationLevel: 'read committed', accessMode: 'read write' });
}
/** Compose only inside an explicit maintenance transaction. The same catalog,
 * lock, budget and fingerprint checks apply; no autocommit repair. */
export async function installReleaseSharedIndexesInTransaction(tx: Query) {
    if (Object.hasOwn(tx,'$client')) throw Error('Shared index composition requires a transaction');
    await setup(tx);
    await tx.execute(sql`LOCK TABLE public.system_config,public."user",public.user_bill,public.user_money IN ACCESS EXCLUSIVE MODE NOWAIT`);
    const initial = await inspect(tx);
    if (initial.some(row => row.state === 'drift')) throw Error('Shared index catalog drift requires review');
    const before = await fingerprint(tx);
    let created = 0;
    for (const [name, indexes] of Object.entries(RELEASE_SHARED_INDEXES)) {
      if (initial.find(row => row.name === name)?.state === 'ready') continue;
      for (const [index, columns] of Object.entries(indexes)) {
        await tx.execute(sql.raw(`CREATE INDEX "${index}" ON public."${name}" USING btree (${columns.map((column: string) => '"' + column + '"').join(',')})`));
        created++;
      }
    }
    const after = await fingerprint(tx);
    if ((await inspect(tx)).some(row => row.state !== 'ready') || JSON.stringify(before) !== JSON.stringify(after))
      throw Error('Shared index postflight mismatch');
    return { ready: true, created, before, after };
}
