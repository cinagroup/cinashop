/** Canonical receipt table DDL. The guarded installer is the upgrade entrypoint.
 * No automatic CREATE IF NOT EXISTS: an incompatible table must not be accepted.
 * No template FK or TTL: deletion/retirement must never make an old key reusable.
 */
export const SHIPPING_TEMPLATE_CREATE_REPLAY_SQL = `
CREATE TABLE "shipping_template_create_replay" (
  "owner_type" smallint NOT NULL,
  "relation_id" integer NOT NULL,
  "actor_id" integer NOT NULL,
  "request_key" uuid NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "template_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT stcr_pk PRIMARY KEY (owner_type, relation_id, actor_id, request_key),
  CONSTRAINT stcr_template_uq UNIQUE (template_id),
  CONSTRAINT stcr_scope_ck CHECK ((owner_type = 0 AND relation_id = 0) OR (owner_type = 2 AND relation_id > 0)),
  CONSTRAINT stcr_identity_ck CHECK (actor_id > 0 AND template_id > 0),
  CONSTRAINT stcr_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT stcr_key_ck CHECK (request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);`;
