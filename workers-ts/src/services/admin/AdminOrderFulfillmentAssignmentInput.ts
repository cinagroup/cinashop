/** Backward-compatible Admin input surface; shared data never grants authority. */
export * from '../order/FulfillmentAssignmentProtocol';
import { assignmentRecord, assignmentSnapshot, assignmentId } from '../order/FulfillmentAssignmentProtocol';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';

export function captureAssignmentActor(value: AdminAuthorityActor): Readonly<AdminAuthorityActor> {
  const r = assignmentRecord(assignmentSnapshot(value, { nodes: 16, bytes: 512, string: 128 }), ['id', 'authVersion', 'expiresAt']);
  const actor = Object.freeze({ id: assignmentId(r.id), authVersion: r.authVersion as string, expiresAt: r.expiresAt as number });
  assertAdminAuthoritySession(actor);
  return actor;
}
