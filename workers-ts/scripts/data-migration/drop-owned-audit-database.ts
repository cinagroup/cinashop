type Execute = (statement: string, parameters?: string[]) => PromiseLike<readonly Record<string, unknown>[]>;
const ownedName = /^orm_audit_(external|embedded|orm|orm_upgrade|orm_default_upgrade|orm_constraints|orm_fk_names|orm_checks|orm_sequences|table_gate)_[a-f0-9]{32}$/;

/** Only the audit's successfully created random databases are eligible. */
export async function dropOwnedAuditDatabase(execute: Execute, name: string, created: readonly string[]) {
  if (!ownedName.test(name) || name.length > 63 || !created.includes(name)) throw new Error('Unsafe audit cleanup target');
  const drop = `DROP DATABASE "${name}"`;
  try { await execute(drop); return { timeoutRecovered: false, retried: false }; }
  catch (error) {
    if ((error as { code?: string }).code !== '57014') throw error;
    // A cancelled DROP can leave an already-invalid database. Do not treat a
    // timeout as proof of ownership, absence, invalidity, or lack of sessions.
    const rows = await execute(`SELECT datconnlimit,
      (SELECT count(*)::integer FROM pg_stat_activity WHERE datname=$1) AS connections
      FROM pg_database WHERE datname=$1`, [name]);
    if (rows.length === 0) return { timeoutRecovered: true, retried: false };
    if (rows.length !== 1 || rows[0].datconnlimit !== -2 || rows[0].connections !== 0) throw error;
    // Exactly one retry under the unchanged deadline. No FORCE, disconnect,
    // configuration changes, broad name discovery, or recursive filesystem work.
    await execute(drop);
    return { timeoutRecovered: true, retried: true };
  }
}
