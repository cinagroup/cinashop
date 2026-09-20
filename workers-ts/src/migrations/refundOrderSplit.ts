import { INVOICE_EVIDENCE_SQL } from './invoiceEvidence';

/** Table definitions alone are not runtime-ready: append-only guards and
 * maintenance-owner/runtime-role separation are required before use. */
export const REFUND_ORDER_SPLIT_TABLE_SQL = `
CREATE TABLE "store_order_refund_split" (
  refund_id integer PRIMARY KEY,
  fingerprint varchar(64) NOT NULL,
  uid integer NOT NULL,
  supplier_id integer NOT NULL,
  store_id integer NOT NULL,
  source_order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  selected_order_id integer NOT NULL,
  remaining_order_id integer,
  disposition varchar(16) NOT NULL,
  previous_refund_id integer NOT NULL,
  base_branch_id varchar(32),
  returned_point_bill_ids text NOT NULL,
  earned_income_scope text NOT NULL,
  invoice_allocation text NOT NULL DEFAULT 'null',
  source_snapshot text NOT NULL,
  partitions text NOT NULL,
  add_time integer NOT NULL,
  CONSTRAINT sors_identity_ck CHECK (refund_id > 0 AND uid > 0 AND supplier_id >= 0 AND store_id >= 0
    AND source_order_id > 0 AND payment_order_id > 0 AND selected_order_id > 0 AND add_time > 0),
  CONSTRAINT sors_fingerprint_ck CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sors_branch_ck CHECK (base_branch_id IS NULL OR base_branch_id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT sors_generation_ck CHECK (previous_refund_id >= 0 AND previous_refund_id < refund_id
    AND octet_length(returned_point_bill_ids) <= 16384 AND jsonb_typeof(returned_point_bill_ids::jsonb)='array'
    AND jsonb_array_length(returned_point_bill_ids::jsonb) <= 1024),
  CONSTRAINT sors_income_ck CHECK (octet_length(earned_income_scope) <= 2048 AND jsonb_typeof(earned_income_scope::jsonb) IN ('object', 'null')),
  CONSTRAINT sors_invoice_ck CHECK (octet_length(invoice_allocation) <= 16384 AND jsonb_typeof(invoice_allocation::jsonb) IN ('object', 'null')),
  CONSTRAINT sors_disposition_ck CHECK ((disposition='whole' AND remaining_order_id IS NULL AND selected_order_id=source_order_id)
    OR (disposition='split' AND remaining_order_id IS NOT NULL AND remaining_order_id > 0 AND selected_order_id <> source_order_id AND selected_order_id <> remaining_order_id)),
  CONSTRAINT sors_snapshot_ck CHECK (octet_length(source_snapshot) <= 16777216 AND jsonb_typeof(source_snapshot::jsonb)='object'
    AND octet_length(partitions) <= 131072 AND jsonb_typeof(partitions::jsonb)='array')
);
CREATE INDEX sors_source_history ON store_order_refund_split(source_order_id, refund_id);
CREATE INDEX sors_payment_history ON store_order_refund_split(payment_order_id, refund_id);
CREATE INDEX sors_remaining_history ON store_order_refund_split(remaining_order_id, refund_id) WHERE remaining_order_id IS NOT NULL;
CREATE TABLE "store_order_fulfillment_branch" (
  id varchar(32) PRIMARY KEY,
  source_branch_id varchar(32),
  source_refund_id integer NOT NULL,
  source_order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  child_order_id integer NOT NULL,
  uid integer NOT NULL,
  supplier_id integer NOT NULL,
  store_id integer NOT NULL,
  covered_refunds text NOT NULL,
  materialized_refunds text NOT NULL,
  returned_point_bill_ids text NOT NULL,
  partitions text NOT NULL,
  add_time integer NOT NULL,
  CONSTRAINT sofb_identity_ck CHECK (id ~ '^[0-9a-f]{32}$' AND source_order_id > 0 AND payment_order_id > 0
    AND child_order_id > 0 AND uid > 0 AND supplier_id >= 0 AND store_id >= 0 AND add_time > 0
    AND source_refund_id >= 0 AND (source_refund_id > 0 OR source_branch_id IS NOT NULL)
    AND (source_branch_id IS NULL OR (source_branch_id ~ '^[0-9a-f]{32}$' AND source_branch_id <> id))),
  CONSTRAINT sofb_history_ck CHECK (octet_length(covered_refunds) <= 32768 AND jsonb_typeof(covered_refunds::jsonb)='array'
    AND jsonb_array_length(covered_refunds::jsonb) <= 201
    AND octet_length(materialized_refunds) <= 32768 AND jsonb_typeof(materialized_refunds::jsonb)='array'
    AND jsonb_array_length(materialized_refunds::jsonb) <= 201),
  CONSTRAINT sofb_bills_ck CHECK (octet_length(returned_point_bill_ids) <= 16384 AND jsonb_typeof(returned_point_bill_ids::jsonb)='array'
    AND jsonb_array_length(returned_point_bill_ids::jsonb) <= 1024),
  CONSTRAINT sofb_partitions_ck CHECK (octet_length(partitions) <= 32768 AND jsonb_typeof(partitions::jsonb)='array'
    AND jsonb_array_length(partitions::jsonb) BETWEEN 1 AND 200)
);
CREATE INDEX sofb_child_history ON store_order_fulfillment_branch(child_order_id, add_time);
`;

export const REFUND_ORDER_SPLIT_GUARD_SQL = `
CREATE FUNCTION protect_refund_order_split() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Refund materialization evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER sors_no_rewrite BEFORE UPDATE OR DELETE ON store_order_refund_split FOR EACH ROW EXECUTE FUNCTION protect_refund_order_split();
CREATE TRIGGER sors_no_truncate BEFORE TRUNCATE ON store_order_refund_split FOR EACH STATEMENT EXECUTE FUNCTION protect_refund_order_split();
CREATE TRIGGER sofb_no_rewrite BEFORE UPDATE OR DELETE ON store_order_fulfillment_branch FOR EACH ROW EXECUTE FUNCTION protect_refund_order_split();
CREATE TRIGGER sofb_no_truncate BEFORE TRUNCATE ON store_order_fulfillment_branch FOR EACH STATEMENT EXECUTE FUNCTION protect_refund_order_split();
REVOKE ALL ON FUNCTION protect_refund_order_split() FROM PUBLIC;
`;

/** Candidate fixture composition, not an upgrade or runtime auto-installer. */
export const REFUND_ORDER_SPLIT_SQL = INVOICE_EVIDENCE_SQL + REFUND_ORDER_SPLIT_TABLE_SQL + REFUND_ORDER_SPLIT_GUARD_SQL;
