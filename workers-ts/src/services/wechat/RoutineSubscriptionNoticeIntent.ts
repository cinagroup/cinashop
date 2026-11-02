import { Buffer } from 'node:buffer';
import type { Env } from '@/env';
import { freezeSubscription, parseRoutineSubscriptionAccountJournal, routineSubscriptionUnavailable,
  subscriptionEqual, subscriptionHex, subscriptionInteger, subscriptionMac, subscriptionObject, subscriptionSame,
  type RoutineSubscriptionAccountJournal, type RoutineSubscriptionScope } from './RoutineSubscriptionAccount';
import type { RoutineSubscriptionDeliveryNoticeFacts, RoutineSubscriptionNoticeRequest } from './RoutineSubscriptionDeliveryNotice';

/** Authenticated staging projection, never evidence of a POST or fresh send
 * authority. The immutable accepted intent remains the dispatch attempt. */
export interface RoutineSubscriptionNoticeIntent {
  format: 2; scope: RoutineSubscriptionScope; actor: { role: string; roleOid: string };
  deliveryId: number; outboxId: number; eventKey: string; createdAt: number; requestSignature: string;
  source: RoutineSubscriptionDeliveryNoticeFacts; policy: RoutineSubscriptionAccountJournal;
  request: Readonly<RoutineSubscriptionNoticeRequest>; signature: string;
}
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
/** Bounded JSON snapshot before any serializer, coercion or recursive parser.
 * Reflection reads descriptors only; no getter/toJSON/prototype method is used.
 * A shared acyclic subtree is copied, while an ancestor cycle is rejected. */
function captureIntentJson(raw: unknown): unknown {
  const ancestors = new WeakSet<object>(); let nodes = 0, bytes = 0;
  const string = (value: string) => {
    if (value.length > 65536) return routineSubscriptionUnavailable();
    for (const c of value) { const point = c.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff) return routineSubscriptionUnavailable(); }
    bytes += Buffer.byteLength(value, 'utf8'); if (bytes > 65536) return routineSubscriptionUnavailable(); return value;
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) return routineSubscriptionUnavailable();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return string(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : routineSubscriptionUnavailable();
    if (!value || typeof value !== 'object' || ancestors.has(value)) return routineSubscriptionUnavailable();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return routineSubscriptionUnavailable();
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
    if (keys.length > 4096 || keys.some(key => typeof key !== 'string')) return routineSubscriptionUnavailable();
    ancestors.add(value);
    try {
      if (array) {
        const length = descriptors.length;
        if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 4095
          || keys.length !== length.value + 1) return routineSubscriptionUnavailable();
        const output: unknown[] = [];
        for (let i = 0; i < length.value; i++) {
          const d = descriptors[String(i)]; if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable();
          output.push(copy(d.value, depth + 1));
        }
        return output;
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        const d = descriptors[key as string];
        if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable();
        output[string(key as string)] = copy(d.value, depth + 1);
      }
      return output;
    } finally { ancestors.delete(value); }
  };
  const snapshot = copy(raw, 0);
  const encoded = JSON.stringify(snapshot);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 65536) return routineSubscriptionUnavailable();
  return snapshot;
}
const roleName = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const roleOid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
function captureIntentScope(raw: unknown): RoutineSubscriptionScope {
  const r = subscriptionObject(raw, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!roleName(r.database) || !roleOid(r.databaseOid) || !roleName(r.maintenance) || !roleOid(r.maintenanceOid)) return routineSubscriptionUnavailable();
  return { database: r.database, databaseOid: r.databaseOid, maintenance: r.maintenance, maintenanceOid: r.maintenanceOid };
}
export function parseRoutineSubscriptionNoticeIntent(env: Pick<Env, 'APP_KEY'>, raw: unknown, scope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionNoticeIntent> {
  const r = subscriptionObject(captureIntentJson(raw), ['format', 'scope', 'actor', 'deliveryId', 'outboxId', 'eventKey', 'createdAt', 'requestSignature', 'source', 'policy', 'request', 'signature']);
  const expectedScope = captureIntentScope(scope), capturedScope = captureIntentScope(r.scope);
  const actor = subscriptionObject(r.actor, ['role', 'roleOid']);
  const source = subscriptionObject(r.source, ['deliveryId', 'outboxId', 'eventKey', 'orderId', 'rootId', 'buyerUid', 'appId', 'ownershipId', 'bindingId',
    'observationId', 'evidenceId', 'evidenceSignature', 'relatedDigest', 'approvedUseDigest', 'templateMark', 'sourceDigest']);
  const q = subscriptionObject(r.request, ['touser', 'template_id', 'page', 'data']);
  if (r.format !== 2 || !subscriptionSame(capturedScope, expectedScope) || !roleName(actor.role) || !roleOid(actor.roleOid)
    || !subscriptionInteger(r.deliveryId) || !subscriptionInteger(r.outboxId) || !subscriptionInteger(r.createdAt)
    || !text(r.eventKey, 128) || !/^order\.delivery\.notice:[1-9]\d*(?::city:[1-9]\d*)?$/u.test(r.eventKey)
    || !subscriptionHex(r.requestSignature) || !subscriptionHex(r.signature) || r.deliveryId !== source.deliveryId || r.outboxId !== source.outboxId
    || r.eventKey !== source.eventKey || !subscriptionInteger(source.orderId) || !subscriptionInteger(source.rootId) || !subscriptionInteger(source.buyerUid)
    || !subscriptionInteger(source.bindingId) || !text(source.appId, 32) || !text(source.ownershipId, 128) || !text(source.observationId, 128)
    || !text(source.evidenceId, 128) || !subscriptionHex(source.evidenceSignature) || !subscriptionHex(source.relatedDigest)
    || !subscriptionHex(source.approvedUseDigest) || !subscriptionHex(source.sourceDigest) || typeof source.templateMark !== 'string' || !['1458', '1128'].includes(source.templateMark)
    || !text(q.touser, 128) || !text(q.template_id, 100) || !text(q.page, 512) || !q.data || typeof q.data !== 'object' || Array.isArray(q.data)
    || Buffer.byteLength(JSON.stringify(r), 'utf8') > 65536) return routineSubscriptionUnavailable();
  const descriptors = Object.getOwnPropertyDescriptors(q.data), fields = Reflect.ownKeys(q.data);
  if (fields.length < 1 || fields.length > 16 || fields.some(key => typeof key !== 'string' || !/^[a-z0-9_]{1,64}$/u.test(key)
    || !descriptors[key]?.enumerable || !('value' in descriptors[key]))) return routineSubscriptionUnavailable();
  for (const d of Object.values(descriptors)) {
    const value = subscriptionObject(d.value, ['value']);
    if (typeof value.value !== 'string' || value.value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value.value)) return routineSubscriptionUnavailable();
  }
  const policy = parseRoutineSubscriptionAccountJournal(env, r.policy, expectedScope);
  if (policy.payload.data.appId !== source.appId || policy.payload.data.state !== 'active' || r.createdAt < policy.created_at
    || r.createdAt < policy.payload.data.validFrom || r.createdAt >= policy.payload.data.validUntil
    || !policy.payload.data.templates.some(t => t.mark === source.templateMark && t.templateId === q.template_id)) return routineSubscriptionUnavailable();
  const { signature, ...body } = r;
  if (!subscriptionEqual(signature, subscriptionMac(env, 'notice-stage', body))) return routineSubscriptionUnavailable();
  return freezeSubscription({ ...body, signature } as unknown as RoutineSubscriptionNoticeIntent);
}
