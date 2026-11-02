import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureAssignmentRequest, captureAssignmentSource, assignmentSnapshot, assignmentRequestHash,
  decodeAssignmentEvent, assignmentReceipt } from '@/services/admin/AdminOrderFulfillmentAssignmentInput';
import { isAdminFulfillmentAssignmentRecoveryRoute, requiredAdminPermission } from '@/services/admin/AdminPermissionService';

const hex = 'a'.repeat(64);
const request = () => ({ format_version: 1, operation_id: randomUUID(), kind: 'grant', order_id: 91,
  target_store_id: 77, expected_head: { ordinal: 0, operation_id: null }, expected_order_revision: hex, expected_source_hash: hex });
const source = () => ({ cart_rows: [{ row_id: 1, cart_id: 'original-cart', product_id: 2, unique: '', quantity: 3 }] });

describe('controlled Admin assignment input and recovery authority', () => {
  it('detaches an exact request before asynchronous work and rejects coercion, extra authority and inconsistent predecessors', () => {
    const raw = request(), saved = captureAssignmentRequest(raw); raw.expected_head.ordinal = 3; raw.target_store_id = 99;
    expect(saved.target_store_id).toBe(77); expect(saved.expected_head.ordinal).toBe(0);
    expect(Object.isFrozen(saved)).toBe(true); expect(Object.isFrozen(saved.expected_head)).toBe(true);
    for (const bad of [{ ...request(), actor_id: 1 }, { ...request(), order_id: '91' },
      { ...request(), expected_head: { ordinal: 1, operation_id: null } },
      { ...request(), expected_head: { ordinal: 0, operation_id: randomUUID() } },
      { ...request(), operation_id: 'not-a-uuid' }, { ...request(), expected_source_hash: 'A'.repeat(64) }])
      expect(() => captureAssignmentRequest(bad)).toThrow();
  });
  it('never invokes accessors or toJSON and refuses sparse, symbolic or inherited input', () => {
    let invoked = 0;
    const raw = { ...request(), get order_id() { invoked++; return 91; } };
    for (const bad of [raw, { ...request(), toJSON() { invoked++; return request(); } },
      Object.assign(Object.create({ actor_id: 1 }), request()), { ...request(), [Symbol('authority')]: 1 },
      { cart_rows: Array(1) }]) expect(() => assignmentSnapshot(bad)).toThrow();
    expect(invoked).toBe(0);
  });
  it('keeps the real cart string, empty SKU and 255-character Unicode SKU within closed source bounds', () => {
    expect(captureAssignmentSource(source()).cart_rows[0].unique).toBe('');
    const full = source(); full.cart_rows[0].unique = '界'.repeat(255);
    expect(captureAssignmentSource(full).cart_rows[0].unique).toBe('界'.repeat(255));
    for (const row of [{ ...full.cart_rows[0], unique: '界'.repeat(256) }, { ...full.cart_rows[0], cart_id: 1 },
      { ...full.cart_rows[0], quantity: 0 }, { ...full.cart_rows[0], quantity: 0.5 },
      { ...full.cart_rows[0], phone: 'unexpected' }]) expect(() => captureAssignmentSource({ cart_rows: [row] })).toThrow();
  });
  it('rejects unordered or duplicated source identity and oversized snapshots', () => {
    const row = source().cart_rows[0];
    for (const rows of [[row, { ...row, row_id: 2 }], [{ ...row, row_id: 2 }, row],
      Array.from({ length: 201 }, (_, i) => ({ ...row, row_id: i + 1, cart_id: String(i) })),
      Array.from({ length: 200 }, (_, i) => ({ ...row, row_id: i + 1, cart_id: String(i), unique: '界'.repeat(255) }))])
      expect(() => captureAssignmentSource({ cart_rows: rows })).toThrow();
  });
  it('reconstructs the exact request hash from a stored event and keeps recovery independent of source PII', async () => {
    const a = captureAssignmentRequest(request()), hash = await assignmentRequestHash(a, 8);
    const event = { operation_id: a.operation_id, format_version: 1, kind: a.kind, actor_id: 8, root_order_id: 91,
      order_id: 91, target_store_id: 77, customer_uid: 22, financial_store_id: 0, ordinal: 1, previous_ref: null,
      order_revision: hex, payload_hash: hash, source_hash: hex, source: source(), created_at: '1793590000' };
    const saved = await decodeAssignmentEvent(event);
    expect(assignmentReceipt(saved)).not.toHaveProperty('source');
    await expect(decodeAssignmentEvent({ ...event, actor_id: 9 })).rejects.toThrow();
    await expect(decodeAssignmentEvent({ ...event, target_store_id: 78 })).rejects.toThrow();
    await expect(decodeAssignmentEvent({ ...event, financial_store_id: 77 })).rejects.toThrow();
    expect(await assignmentRequestHash(a, 9)).not.toBe(hash);
  });
  it('exempts only minimal GET/HEAD receipts and keeps review and commits under explicit permissions', () => {
    for (const prefix of ['/adminapi', '/api/admin']) {
      const base = `${prefix}/order/fulfillment_assignment`;
      for (const verb of ['GET', 'HEAD']) {
        expect(isAdminFulfillmentAssignmentRecoveryRoute(verb, `${base}/receipt/:operationId`)).toBe(true);
        expect(requiredAdminPermission(verb, `${base}/receipt/:operationId`)).toBeNull();
        expect(requiredAdminPermission(verb, `${base}/review/:id`)).toBe('order.view');
        expect(requiredAdminPermission(verb, `${base}/stores`)).toBe('order.manage');
      }
      expect(requiredAdminPermission('POST', `${base}/commit`)).toBe('order.manage');
      for (const [method, suffix] of [['POST', '/receipt/:operationId'], ['GET', '/receipt/:operationId/source'],
        ['GET', '/commit'], ['POST', '/review/:id'], ['POST', '/resolve'], ['GET', '/receipts/:operationId']]) {
        expect(isAdminFulfillmentAssignmentRecoveryRoute(method, base + suffix)).toBe(false);
        expect(requiredAdminPermission(method, base + suffix)).toBeNull();
      }
    }
  });
});
