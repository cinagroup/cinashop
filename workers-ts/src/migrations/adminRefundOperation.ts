/** Immutable decision evidence. This canonical DDL is not a production upgrade
 * entrypoint: guarded catalog installation/registration must accompany rollout. */
export const ADMIN_REFUND_OPERATION_SQL = `
CREATE TABLE "admin_refund_operation" (
  "admin_id" integer NOT NULL,
  "request_key" uuid NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "refund_id" integer NOT NULL,
  "action" varchar(8) NOT NULL,
  "outcome" varchar(24) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT aro_pk PRIMARY KEY (admin_id, request_key),
  CONSTRAINT aro_identity_ck CHECK (admin_id > 0 AND refund_id > 0),
  CONSTRAINT aro_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT aro_key_ck CHECK (request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT aro_outcome_ck CHECK (
    (action = 'return' AND outcome IN ('return-approved','abandoned')) OR
    (action = 'refuse' AND outcome IN ('refused','abandoned')) OR
    (action = 'refund' AND outcome IN ('balance-settled','provider-admitted','abandoned'))
  )
);
CREATE INDEX aro_refund_history ON admin_refund_operation (refund_id, created_at, admin_id, request_key);
`;
