/** Candidate DDL. Install atomically with a reviewed maintenance identity and
 * reconciled pre-install data, before enabling durable v2. Never infer or
 * backfill a 'created unissued' baseline from a mutable existing row. */
export const INVOICE_HISTORY_TABLE_SQL = `
CREATE TABLE "store_order_invoice_evidence" (
  invoice_id integer NOT NULL,
  kind varchar(12) NOT NULL,
  document_number varchar(50) NOT NULL,
  order_id integer NOT NULL,
  uid integer NOT NULL,
  snapshot text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT soie_identity_pk PRIMARY KEY (invoice_id, kind, document_number),
  CONSTRAINT soie_identity_ck CHECK (invoice_id > 0 AND order_id > 0 AND uid > 0
    AND kind IN ('created','issued','unverified') AND (kind='issued' OR document_number='')),
  CONSTRAINT soie_snapshot_ck CHECK ((octet_length(snapshot) <= 16384 AND jsonb_typeof(snapshot::jsonb)='object'
    AND snapshot::jsonb @> '{"v":1}'::jsonb AND jsonb_typeof(snapshot::jsonb->'invoice')='object'
    AND (snapshot::jsonb->'invoice') ?& ARRAY['id','order_id','uid','category','is_invoice','invoice_number']
    AND (snapshot::jsonb->'invoice'->>'id')::integer=invoice_id
    AND (snapshot::jsonb->'invoice'->>'order_id')::integer=order_id
    AND (snapshot::jsonb->'invoice'->>'uid')::integer=uid
    AND jsonb_typeof(snapshot::jsonb->'invoice'->'is_invoice')='number'
    AND jsonb_typeof(snapshot::jsonb->'invoice'->'invoice_number')='string'
    AND (kind<>'issued' OR (document_number=snapshot::jsonb->'invoice'->>'invoice_number'
      AND ((snapshot::jsonb->'invoice'->>'is_invoice')::integer=1 OR document_number<>'')))) IS TRUE)
);
CREATE INDEX soie_order_kind ON store_order_invoice_evidence(order_id, kind);
`;

export const INVOICE_HISTORY_CAPTURE_SQL = `
CREATE FUNCTION protect_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Invoice evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER soie_no_rewrite BEFORE UPDATE OR DELETE ON store_order_invoice_evidence
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soie_no_truncate BEFORE TRUNCATE ON store_order_invoice_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soi_no_truncate BEFORE TRUNCATE ON store_order_invoice
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
CREATE FUNCTION capture_invoice_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  evidence regclass;
  prior jsonb;
  next_row jsonb;
  candidate jsonb;
  has_created boolean;
  captured boolean;
  written integer;
BEGIN
  IF TG_TABLE_NAME<>'store_order_invoice' OR TG_LEVEL<>'ROW' THEN
    RAISE EXCEPTION 'Unexpected invoice evidence source' USING ERRCODE='42501';
  END IF;
  evidence := format('%I.store_order_invoice_evidence', TG_TABLE_SCHEMA)::regclass;
  IF TG_OP<>'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN next_row := to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' AND (OLD.id,OLD.uid,OLD.order_id,OLD.category) IS DISTINCT FROM (NEW.id,NEW.uid,NEW.order_id,NEW.category) THEN
    RAISE EXCEPTION 'Invoice identity is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
      VALUES ($1,''created'','''',$2,$3,$4)', evidence)
      USING NEW.id, NEW.order_id, NEW.uid, jsonb_build_object('v',1,'invoice',next_row)::text;
    GET DIAGNOSTICS written = ROW_COUNT;
    IF written<>1 THEN RAISE EXCEPTION 'Invoice creation evidence was not captured'; END IF;
  ELSE
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''created'')', evidence)
      INTO has_created USING OLD.id;
    IF NOT has_created THEN
      EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
        VALUES ($1,''unverified'','''',$2,$3,$4) ON CONFLICT DO NOTHING', evidence)
        USING OLD.id, OLD.order_id, OLD.uid, jsonb_build_object('v',1,'invoice',prior)::text;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''unverified'')', evidence)
        INTO captured USING OLD.id;
      IF NOT captured THEN RAISE EXCEPTION 'Unverified invoice evidence was not captured'; END IF;
    END IF;
  END IF;
  -- Capture OLD first: an existing issued row must survive number clearing.
  -- Each reported number has its own immutable first-observed full snapshot.
  FOREACH candidate IN ARRAY ARRAY[prior,next_row] LOOP
    IF candidate IS NOT NULL AND ((candidate->>'is_invoice')::integer=1 OR candidate->>'invoice_number'<>'') THEN
      EXECUTE format('INSERT INTO %s (invoice_id,kind,document_number,order_id,uid,snapshot)
        VALUES ($1,''issued'',$2,$3,$4,$5) ON CONFLICT DO NOTHING', evidence)
        USING (candidate->>'id')::integer, candidate->>'invoice_number', (candidate->>'order_id')::integer,
          (candidate->>'uid')::integer, jsonb_build_object('v',1,'invoice',candidate)::text;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE invoice_id=$1 AND kind=''issued'' AND document_number=$2)', evidence)
        INTO captured USING (candidate->>'id')::integer, candidate->>'invoice_number';
      IF NOT captured THEN RAISE EXCEPTION 'Invoice issuance evidence was not captured'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER soi_capture_evidence AFTER INSERT OR UPDATE OR DELETE ON store_order_invoice
  FOR EACH ROW EXECUTE FUNCTION capture_invoice_evidence();
REVOKE ALL ON store_order_invoice_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_invoice_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_invoice_evidence() FROM PUBLIC;
`;

/** Additive v1 -> v2 step. The installer must first verify the v1 catalog. */
export const INVOICE_ALLOCATION_TABLE_SQL = `
CREATE TABLE "store_order_invoice_allocation" (
  id varchar(32) PRIMARY KEY,
  source_invoice_id integer NOT NULL,
  source_order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  uid integer NOT NULL,
  reason varchar(16) NOT NULL,
  source_snapshot text NOT NULL,
  targets text NOT NULL,
  add_time integer NOT NULL,
  CONSTRAINT soia_identity_ck CHECK (id ~ '^[0-9a-f]{32}$' AND source_invoice_id > 0
    AND source_order_id > 0 AND payment_order_id > 0 AND uid > 0 AND add_time > 0
    AND reason IN ('fulfillment','supplier')),
  CONSTRAINT soia_snapshot_ck CHECK ((octet_length(source_snapshot) <= 16384
    AND jsonb_typeof(source_snapshot::jsonb)='object'
    AND (source_snapshot::jsonb->>'id')::integer=source_invoice_id
    AND (source_snapshot::jsonb->>'orderId')::integer=source_order_id
    AND (source_snapshot::jsonb->>'uid')::integer=uid) IS TRUE),
  CONSTRAINT soia_targets_ck CHECK ((octet_length(targets) <= 65536
    AND jsonb_typeof(targets::jsonb)='array' AND jsonb_array_length(targets::jsonb) BETWEEN 2 AND 200) IS TRUE)
);
CREATE INDEX soia_source_history ON store_order_invoice_allocation(source_invoice_id, add_time);
`;

export const INVOICE_ALLOCATION_GUARD_SQL = `
CREATE TRIGGER soia_no_rewrite BEFORE UPDATE OR DELETE ON store_order_invoice_allocation
  FOR EACH ROW EXECUTE FUNCTION protect_invoice_evidence();
CREATE TRIGGER soia_no_truncate BEFORE TRUNCATE ON store_order_invoice_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION protect_invoice_evidence();
REVOKE ALL ON store_order_invoice_allocation FROM PUBLIC;
`;

export const INVOICE_HISTORY_V1_SQL = INVOICE_HISTORY_TABLE_SQL + INVOICE_HISTORY_CAPTURE_SQL;
export const INVOICE_ALLOCATION_V2_SQL = INVOICE_ALLOCATION_TABLE_SQL + INVOICE_ALLOCATION_GUARD_SQL;
export const INVOICE_EVIDENCE_SQL = INVOICE_HISTORY_V1_SQL + INVOICE_ALLOCATION_V2_SQL;
