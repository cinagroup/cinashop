import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureAssignedFulfillmentInput, captureAssignedActor, assignedFulfillmentHash,
  decodeAssignedFulfillmentRecord, assignedFulfillmentReceipt, assertAssignedSameRequest,
} from '@/services/store/ManagerAssignedFulfillmentInput';

const hex = 'a'.repeat(64);
const request = () => ({ version: 'merchant-assigned-whole-express-v1', order_id: 91, store_id: 77,
  scope_key: hex, assignment_operation_id: randomUUID(), assignment_ordinal: 1,
  assignment_payload_hash: hex, expected_assignment_source_hash: hex, expected_order_revision: hex,
  payload: { type: 1, express_record_type: 1, delivery_name: '顺丰', delivery_code: 'SF', delivery_id: 'SF123' } });

async function record() {
  const intent = captureAssignedFulfillmentInput(request()), key = randomUUID();
  return { actor_uid: 103, request_key: key, format_version: 1, kind: 'assigned_whole_express', outcome: 'delivery-recorded',
    request_hash: await assignedFulfillmentHash(103, key, intent), target_store_id: 77, staff_id: 9, scope_key: hex,
    root_order_id: 91, order_id: 91, customer_uid: 22, financial_store_id: 0, supplier_id: 0,
    assignment_operation_id: intent.assignment_operation_id, assignment_ordinal: 1, assignment_payload_hash: hex,
    assignment_source_hash: hex, assignment_order_revision: hex, expected_order_revision: hex, post_order_revision: hex,
    delivery_outbox_id: 8, delivery_event_key: 'order.delivery.notice:91', delivery_payload_hash: hex,
    intent, created_at: '1793590000' };
}

describe('Manager assigned whole express input and receipt boundary', () => {
  it('detaches the request before async work and freezes its manual express intent', () => {
    const raw = request(), saved = captureAssignedFulfillmentInput(raw);
    raw.store_id = 78; raw.payload.delivery_id = 'changed';
    expect(saved.store_id).toBe(77); expect(saved.payload.delivery_id).toBe('SF123');
    expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.payload)).toBe(true);
  });
  it('accepts only typed manual whole express and never accepts caller supplied authority', () => {
    for (const bad of [{ ...request(), actor_uid: 1 }, { ...request(), staff_id: 9 }, { ...request(), financial_store_id: 77 },
      { ...request(), order_id: '91' }, { ...request(), store_id: 0 }, { ...request(), assignment_ordinal: 65 },
      { ...request(), assignment_ordinal: 1.5 }, { ...request(), assignment_operation_id: 'not-a-uuid' },
      { ...request(), expected_assignment_source_hash: 'A'.repeat(64) },
      { ...request(), payload: { ...request().payload, type: 2 } },
      { ...request(), payload: { ...request().payload, express_record_type: 2 } },
      { ...request(), payload: { ...request().payload, split: true } }])
      expect(() => captureAssignedFulfillmentInput(bad)).toThrow();
  });
  it('does not invoke accessors or serialization hooks and refuses inherited or symbolic input', () => {
    let invoked = 0;
    for (const bad of [{ ...request(), get order_id() { invoked++; return 91; } },
      { ...request(), toJSON() { invoked++; return request(); } },
      Object.assign(Object.create({ actor_uid: 1 }), request()), { ...request(), [Symbol('authority')]: 1 }])
      expect(() => captureAssignedFulfillmentInput(bad)).toThrow();
    expect(invoked).toBe(0);
  });
  it('keeps Unicode code point limits and refuses blank, padded or control-bearing carrier facts', () => {
    const raw = request(); raw.payload.delivery_name = '界'.repeat(64); raw.payload.delivery_id = '🚚'.repeat(64);
    expect(captureAssignedFulfillmentInput(raw).payload.delivery_id).toBe('🚚'.repeat(64));
    for (const value of ['', ' SF123', 'SF123 ', 'SF\n123', 'SF\u007f123', '界'.repeat(65)])
      expect(() => captureAssignedFulfillmentInput({ ...request(), payload: { ...request().payload, delivery_id: value } })).toThrow();
    expect(() => captureAssignedFulfillmentInput({ ...request(), payload: { ...request().payload, delivery_code: 'S'.repeat(51) } })).toThrow();
  });
  it('captures only the authenticated user/session identity without coercion', () => {
    const raw = { uid: 103, authVersion: hex, expiresAt: 1793590000 }, actor = captureAssignedActor(raw);
    raw.uid = 104; expect(actor.uid).toBe(103);
    for (const bad of [{ ...raw, store_id: 77 }, { ...raw, authVersion: '' }, { ...raw, expiresAt: '1793590000' },
      { ...raw, uid: 0 }, { ...raw, expiresAt: 0 }]) expect(() => captureAssignedActor(bad as never)).toThrow();
  });
  it('binds idempotency to the original user, UUID, assignment and exact tracking intent', async () => {
    const input = captureAssignedFulfillmentInput(request()), key = randomUUID(), hash = await assignedFulfillmentHash(103, key, input);
    expect(await assignedFulfillmentHash(104, key, input)).not.toBe(hash);
    expect(await assignedFulfillmentHash(103, randomUUID(), input)).not.toBe(hash);
    for (const change of [{ assignment_operation_id: randomUUID() }, { store_id: 78 },
      { payload: { ...input.payload, delivery_id: 'SF456' } }])
      expect(await assignedFulfillmentHash(103, key, captureAssignedFulfillmentInput({ ...input, ...change }))).not.toBe(hash);
  });
  it('reconstructs a stored request and exposes a minimal receipt without tracking intent', async () => {
    const raw = await record(), saved = await decodeAssignedFulfillmentRecord(raw);
    expect(saved.created_at).toBe(1793590000);
    const receipt = assignedFulfillmentReceipt(saved);
    expect(receipt).not.toHaveProperty('intent'); expect(receipt).not.toHaveProperty('delivery_id');
    expect(receipt.delivery_outbox_id).toBe(8); expect(Object.isFrozen(receipt)).toBe(true);
    expect(assertAssignedSameRequest(saved, 103, raw.request_key, saved.intent, saved.request_hash)).toBe(true);
    expect(assertAssignedSameRequest(saved, 104, raw.request_key, saved.intent, saved.request_hash)).toBe(false);
  });
  it('rejects a receipt whose original user, root, grant, financial scope or notification binding was changed', async () => {
    const raw = await record();
    for (const change of [{ actor_uid: 104 }, { root_order_id: 92 }, { financial_store_id: 77 }, { supplier_id: 1 },
      { target_store_id: 78 }, { assignment_ordinal: 2 }, { assignment_source_hash: 'b'.repeat(64) },
      { assignment_order_revision: 'b'.repeat(64) }, { delivery_event_key: 'order.delivery.notice:92' },
      { created_at: '1.5' }, { unexplained_evidence: {} },
      { intent: { ...raw.intent, payload: { ...raw.intent.payload, delivery_id: 'changed' } } }])
      await expect(decodeAssignedFulfillmentRecord({ ...raw, ...change })).rejects.toThrow();
  });
});
