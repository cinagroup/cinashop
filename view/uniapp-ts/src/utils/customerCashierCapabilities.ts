import { customerWorkRecord } from './customerWork';
import { customerWorkCanonicalJson, customerWorkSha256 } from '../../../common/customerWorkIntent';
import type { CustomerCashierCapabilities, CustomerCashierCapabilityReadiness } from '@/types/customerCashierCapabilities';

const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).sort().join('|') === [...keys].sort().join('|');
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const epoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function readiness(v: unknown): v is CustomerCashierCapabilityReadiness {
  return customerWorkRecord(v) && exact(v, ['ready', 'reason']) && typeof v.ready === 'boolean'
    && typeof v.reason === 'string' && v.reason.length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(v.reason)
    && (!v.ready || v.reason === '');
}
/** A domain response must match this page's independently loaded App scope.
 * Its revision never replaces the ordinary context's consistency key. */
export function parseCustomerCashierCapabilities(value: unknown, actorUid: number,
  authority: { actor_uid: number; scope_key: string; principal: { service_id: number } }, now = Math.floor(Date.now() / 1000)): CustomerCashierCapabilities {
  const invalid = () => Error('次卡收银能力与当前账号或经营范围不匹配，请重新读取');
  if (!customerWorkRecord(value) || !exact(value, ['version', 'actor_uid', 'principal', 'scope_key', 'consistency_key', 'data'])
    || value.version !== 'customer-cashier-capabilities-v1' || value.actor_uid !== actorUid || authority.actor_uid !== actorUid
    || !customerWorkRecord(value.principal) || !exact(value.principal, ['kind', 'service_id', 'scope'])
    || value.principal.kind !== 'customer-order-manager' || value.principal.scope !== 'global'
    || value.principal.service_id !== authority.principal.service_id
    || !hash(value.scope_key) || value.scope_key !== authority.scope_key || !hash(value.consistency_key)
    || !customerWorkRecord(value.data) || !exact(value.data, ['capabilities', 'readiness', 'runtime_revision', 'lease'])) throw invalid();
  const data = value.data, names = ['origin', 'form_base', 'abandon', 'conditional', 'form_images'];
  const statesValue = data.readiness;
  if (!customerWorkRecord(data.capabilities) || !exact(data.capabilities, ['cashier_second_card', 'cashier_form_images'])
    || typeof data.capabilities.cashier_second_card !== 'boolean' || typeof data.capabilities.cashier_form_images !== 'boolean'
    || !customerWorkRecord(statesValue) || !exact(statesValue, names) || !names.every(name => readiness(statesValue[name]))
    || !hash(data.runtime_revision) || !customerWorkRecord(data.lease) || !exact(data.lease, ['issued_at', 'expires_at', 'session_expires_at'])) throw invalid();
  const states = statesValue as Record<string, CustomerCashierCapabilityReadiness>;
  const writes = ['origin', 'form_base', 'abandon', 'conditional'].every(name => states[name].ready), lease = data.lease;
  if (data.capabilities.cashier_second_card !== writes || data.capabilities.cashier_form_images !== (writes && states.form_images.ready)
    || !epoch(lease.issued_at) || !epoch(lease.expires_at) || !epoch(lease.session_expires_at)
    || lease.expires_at <= lease.issued_at || lease.expires_at > lease.issued_at + 60
    || lease.expires_at > lease.session_expires_at || !epoch(now) || lease.issued_at > now + 5 || lease.expires_at <= now) throw invalid();
  const expected = customerWorkSha256(customerWorkCanonicalJson({ version: value.version, actor_uid: actorUid,
    service_id: value.principal.service_id, scope_key: value.scope_key, data }));
  if (value.consistency_key !== expected) throw invalid();
  return value as unknown as CustomerCashierCapabilities;
}
