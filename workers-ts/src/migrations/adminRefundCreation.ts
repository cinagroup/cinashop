/** Canonical DDL shared by the guarded installer and isolated fixtures.
 * Not a runtime activation entry point; never invoke during a refund request. */
export const ADMIN_REFUND_CREATION_SQL = `
CREATE TABLE "admin_refund_creation" (
  admin_id integer NOT NULL,
  request_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  order_id integer NOT NULL,
  refund_id integer,
  outcome varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT arc_pk PRIMARY KEY (admin_id, request_key),
  CONSTRAINT arc_identity_ck CHECK (admin_id > 0 AND order_id > 0),
  CONSTRAINT arc_key_ck CHECK (request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT arc_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT arc_outcome_ck CHECK (
    (outcome='created' AND refund_id IS NOT NULL AND refund_id > 0)
    OR (outcome='abandoned' AND refund_id IS NULL)
  )
);
CREATE INDEX arc_order_history ON admin_refund_creation(order_id, created_at, admin_id, request_key);
`;
