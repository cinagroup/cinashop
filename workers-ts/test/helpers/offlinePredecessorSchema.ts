/** Historical pre-offline fixture only. Not used by production or the nine-path
 * current-schema audit. Preserves incremental candidate/first-install tests
 * after the full ORM barrel starts exporting all seven registered ledgers. */
export async function offlinePredecessorSchemaSql() {
  const kit = await import('drizzle-kit/api'), models = await import('../../src/models/schema');
  const offline = new Set(['offlineOrderAdmission', 'offlineOrderPaymentSelection', 'offlineOrderBalance',
    'offlineOrderQueryEvidence', 'offlineOrderCallbackBinding', 'offlineOrderExternalPayment', 'offlineOrderPaymentDispatch']);
  const snapshot = kit.generateDrizzleJson(Object.fromEntries(Object.entries(models).filter(([name]) => !offline.has(name))));
  for (const [table, index] of [['user_money', 'um_offline_balance_uq'], ['user_bill', 'ub_offline_integral_uq'],
    ['payment_reconciliation_case', 'prc_provider_transaction_lookup']]) delete snapshot.tables['public.' + table].indexes[index];
  for (const [table, name] of [['payment_callback_event', 'pce_order_domain_ck'], ['payment_reconciliation_case', 'prc_order_domain_ck']]) {
    const check = snapshot.tables['public.' + table].checkConstraints[name];
    if (!check.value.includes(", 'offline_order'")) throw Error('Offline predecessor fixture contract changed');
    check.value = check.value.replace(", 'offline_order'", '');
  }
  return (await kit.generateMigration(kit.generateDrizzleJson({}), snapshot)).join('\n');
}
