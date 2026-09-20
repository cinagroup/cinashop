/** Local migration component. Use the controlled installer for maintenance;
 * ORM tables need explicit empty-ledger protection completion before use. */
export const OFFLINE_ORDER_PAYMENT_DISPATCH_TABLE_SQL = `
CREATE TABLE public.offline_order_payment_dispatch (
  selection_key uuid PRIMARY KEY REFERENCES public.offline_order_payment_selection(selection_key) ON DELETE RESTRICT,
  attempt_key uuid NOT NULL, case_id bigint NOT NULL REFERENCES public.payment_reconciliation_case(id) ON DELETE RESTRICT,
  state varchar(10) NOT NULL, ticket_payload text NOT NULL DEFAULT '', ticket_hash varchar(64) NOT NULL DEFAULT '',
  created_at integer NOT NULL, finished_at integer NOT NULL DEFAULT 0, display_until integer NOT NULL DEFAULT 0,
  CONSTRAINT oopd_identity_ck CHECK(attempt_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND case_id>0 AND created_at>0),
  CONSTRAINT oopd_state_ck CHECK(
    (state='ISSUING' AND finished_at=0 AND display_until=0 AND ticket_payload='' AND ticket_hash='')
    OR (state='UNKNOWN' AND finished_at>=created_at AND display_until=0 AND ticket_payload='' AND ticket_hash='')
    OR (state='READY' AND finished_at>=created_at AND display_until=created_at+300
      AND octet_length(ticket_payload) BETWEEN 2 AND 8192 AND ticket_hash ~ '^[0-9a-f]{64}$'))
);
CREATE UNIQUE INDEX oopd_attempt_uq ON public.offline_order_payment_dispatch(attempt_key);
CREATE UNIQUE INDEX oopd_case_uq ON public.offline_order_payment_dispatch(case_id);
REVOKE ALL ON public.offline_order_payment_dispatch FROM PUBLIC;
`;

export const OFFLINE_ORDER_PAYMENT_DISPATCH_GUARD_SQL = `CREATE FUNCTION public.oopd_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oopd$
DECLARE s public.offline_order_payment_selection%ROWTYPE; c public.payment_reconciliation_case%ROWTYPE;
BEGIN
  IF TG_OP NOT IN ('INSERT','UPDATE') THEN RAISE EXCEPTION 'offline dispatch cannot be removed'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.selection_key,NEW.attempt_key,NEW.case_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.selection_key,OLD.attempt_key,OLD.case_id,OLD.created_at)
      OR OLD.state<>'ISSUING' OR NEW.state NOT IN ('READY','UNKNOWN')
    THEN RAISE EXCEPTION 'offline dispatch transition invalid'; END IF;
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'offline dispatch requires READ COMMITTED'; END IF;
  SELECT * INTO s FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
  IF NOT FOUND OR s.rail NOT IN ('wechat','alipay') OR NEW.state<>'ISSUING' OR NEW.created_at<>s.created_at
    THEN RAISE EXCEPTION 'offline dispatch selection mismatch'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payment-reconciliation:' || s.rail || ':' || s.order_no,0));
  SELECT * INTO c FROM public.payment_reconciliation_case WHERE id=NEW.case_id FOR UPDATE;
  IF NOT FOUND OR c.provider<>s.rail OR c.profile<>s.profile OR c.order_domain<>'offline_order' OR c.order_no<>s.order_no
    OR c.expected_amount_cents<>s.pay_price*100 OR c.currency<>'CNY' OR c.status<>'OPEN'
    OR c.provider_status<>'UNKNOWN' OR c.provider_transaction_id<>'' OR c.callback_event_id IS NOT NULL
    OR c.initiated_time<>NEW.created_at
  THEN RAISE EXCEPTION 'offline dispatch recovery mismatch'; END IF;
  PERFORM id FROM public.other_order WHERE id=s.order_id AND uid=s.uid AND paid=0 AND pay_type='' AND trade_no='' AND pay_time=0 AND is_del=0 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offline dispatch order unavailable'; END IF;
  PERFORM uid FROM public."user" WHERE uid=s.uid AND status=1 AND is_del=0 AND delete_time IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offline dispatch account unavailable'; END IF;
  RETURN NEW;
END $oopd$;
REVOKE ALL ON FUNCTION public.oopd_guard() FROM PUBLIC;
CREATE TRIGGER oopd_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.offline_order_payment_dispatch
  FOR EACH ROW EXECUTE FUNCTION public.oopd_guard();
CREATE TRIGGER oopd_truncate_guard BEFORE TRUNCATE ON public.offline_order_payment_dispatch
  FOR EACH STATEMENT EXECUTE FUNCTION public.oopd_guard();
`;

export const OFFLINE_ORDER_PAYMENT_DISPATCH_SQL = `${OFFLINE_ORDER_PAYMENT_DISPATCH_TABLE_SQL}${OFFLINE_ORDER_PAYMENT_DISPATCH_GUARD_SQL}`;
