import { OFFLINE_TABLES, OFFLINE_DISPATCH_COLUMNS } from './offlineOrderCatalog';

/** Reviewed cashier + collection/recovery SQL requirements, not all Worker
 * features, admin reconciliation actions or a deployment permission change. */
export const OFFLINE_RUNTIME_READ_TABLES = [
  ...OFFLINE_TABLES, 'user', 'system_config', 'member_right', 'wechat_user',
  'other_order', 'other_order_status', 'store_order', 'user_recharge',
  'user_money', 'user_bill', 'store_order_economize', 'payment_callback_event',
  'payment_callback_outbox', 'payment_reconciliation_case',
] as const;
export const OFFLINE_RUNTIME_INSERT_TABLES = [
  ...OFFLINE_TABLES, 'other_order', 'other_order_status', 'user_money', 'user_bill',
  'store_order_economize', 'payment_callback_event', 'payment_callback_outbox', 'payment_reconciliation_case',
] as const;
// The shared callback/reconciliation state machines use their existing table
// UPDATE contract. This does not certify their non-offline domains or retention.
export const OFFLINE_RUNTIME_UPDATE_TABLES = ['payment_callback_event', 'payment_callback_outbox', 'payment_reconciliation_case'] as const;
export const OFFLINE_RUNTIME_UPDATE_COLUMNS = {
  user: ['uid', 'now_money', 'integral', 'is_promoter'],
  other_order: ['id', 'paid', 'pay_type', 'pay_time', 'trade_no'],
  wechat_user: ['id'],
  offline_order_payment_dispatch: OFFLINE_DISPATCH_COLUMNS,
} as const;
export const OFFLINE_RUNTIME_SEQUENCES = [
  ['other_order_id_seq', 'other_order', 'id'], ['user_bill_id_seq', 'user_bill', 'id'],
  ['user_money_id_seq', 'user_money', 'id'], ['store_order_economize_id_seq', 'store_order_economize', 'id'],
  ['payment_callback_event_id_seq', 'payment_callback_event', 'id'],
  ['payment_callback_outbox_id_seq', 'payment_callback_outbox', 'id'],
  ['payment_reconciliation_case_id_seq', 'payment_reconciliation_case', 'id'],
] as const;

/** Pure, reviewable SQL plan. Never connects, installs schema, changes roles,
 * revokes other features' rights or claims that applying it makes a role safe.
 * Execution requires a separately reviewed maintenance operation. */
export function offlineRuntimeGrantPlan(role: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role) || role.trim() !== role) throw Error('Invalid explicit runtime role');
  const target = '"' + role + '"', tables = (names: readonly string[]) => names.map(n => 'public."' + n + '"').join(',');
  return [
    `GRANT USAGE ON SCHEMA public TO ${target};`,
    `GRANT SELECT ON ${tables(OFFLINE_RUNTIME_READ_TABLES)} TO ${target};`,
    `GRANT INSERT ON ${tables(OFFLINE_RUNTIME_INSERT_TABLES)} TO ${target};`,
    `GRANT UPDATE ON ${tables(OFFLINE_RUNTIME_UPDATE_TABLES)} TO ${target};`,
    ...Object.entries(OFFLINE_RUNTIME_UPDATE_COLUMNS).map(([table, columns]) =>
      `GRANT UPDATE(${columns.join(',')}) ON public."${table}" TO ${target};`),
    `GRANT USAGE ON SEQUENCE ${tables(OFFLINE_RUNTIME_SEQUENCES.map(([name]) => name))} TO ${target};`,
    `GRANT EXECUTE ON FUNCTION public.ooa_lock_pricing() TO ${target};`,
  ].join('\n');
}
