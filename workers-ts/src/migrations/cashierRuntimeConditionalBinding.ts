import { pricingIdentifier } from './checkoutPricingLockCatalog';

/** Captured from the inspected database, never a role prefix or grant plan. */
export interface CashierRuntimeConditionalBinding {
  database: string;
  databaseOid: string;
  role: string;
  roleOid: string;
}

export function captureCashierRuntimeConditionalBinding(value: CashierRuntimeConditionalBinding) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 4
    || Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !['database', 'databaseOid', 'role', 'roleOid'].includes(key)))
    throw Error('Exact Cashier conditional database and principal binding required');
  const binding = { database:value.database, databaseOid:value.databaseOid, role:value.role, roleOid:value.roleOid };
  if (typeof binding.database !== 'string' || typeof binding.role !== 'string') throw Error('Literal Cashier conditional identities required');
  pricingIdentifier(binding.database); pricingIdentifier(binding.role);
  for (const oid of [binding.databaseOid, binding.roleOid])
    if (typeof oid !== 'string' || !/^[1-9][0-9]*$/u.test(oid) || BigInt(oid) > 4294967295n)
      throw Error('Actual Cashier conditional database and principal OIDs required');
  return binding;
}

/** Match both a renamed original OID and a replacement with the original name.
 * The assertion rejects either mismatch instead of skipping the guard. */
export function cashierConditionalRoleMatch(value: CashierRuntimeConditionalBinding) {
  const b = captureCashierRuntimeConditionalBinding(value);
  return `(current_user='${b.role}' OR (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)='${b.roleOid}'::oid)`;
}

export function cashierConditionalAppPredicate(app: string, value?: CashierRuntimeConditionalBinding, spaced = false) {
  pricingIdentifier(app);
  const original = `current_user${spaced ? ' = ' : '='}'${app}'`;
  if (!value) return original;
  const b = captureCashierRuntimeConditionalBinding(value);
  if (app === b.role) throw Error('Cashier must be distinct from the original App');
  return `(${original} OR ${cashierConditionalRoleMatch(b)})`;
}

/** SECURITY INVOKER only; it neither grants access nor changes the session. */
export function cashierConditionalIdentityAssertion(value?: CashierRuntimeConditionalBinding) {
  if (!value) return '';
  const b = captureCashierRuntimeConditionalBinding(value);
  return `\nIF ${cashierConditionalRoleMatch(b)} THEN
IF current_database()<>'${b.database}' OR
  (SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())<>'${b.databaseOid}'::oid OR
  current_user<>'${b.role}' OR (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)<>'${b.roleOid}'::oid OR
  session_user<>current_user OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity
    WHERE pid=pg_catalog.pg_backend_pid() AND usesysid='${b.roleOid}'::oid) THEN
RAISE EXCEPTION 'Cashier conditional runtime identity changed' USING ERRCODE='42501';
END IF;
END IF;`;
}
