/** Local migration component. Use the controlled installer for maintenance;
 * ORM tables need explicit empty-ledger protection completion before use. */
export const OFFLINE_ORDER_EXTERNAL_PAYMENT_TABLE_SQL = `
CREATE TABLE public.offline_order_query_evidence (
  id uuid PRIMARY KEY, replay_key uuid NOT NULL,
  case_id bigint NOT NULL REFERENCES public.payment_reconciliation_case(id) ON DELETE RESTRICT,
  selection_key uuid NOT NULL REFERENCES public.offline_order_payment_selection(selection_key) ON DELETE RESTRICT,
  version varchar(32) NOT NULL DEFAULT 'offline-query-v1', identity_source varchar(32) NOT NULL,
  provider varchar(10) NOT NULL, profile varchar(10) NOT NULL, order_no varchar(32) NOT NULL,
  transaction_id varchar(50) NOT NULL, trade_state varchar(32) NOT NULL, amount_cents integer NOT NULL,
  currency varchar(3) NOT NULL, provider_event_time integer NOT NULL,
  evidence_hash varchar(64) NOT NULL, identity_hash varchar(64) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT ooqe_identity_ck CHECK(version='offline-query-v1' AND case_id>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND transaction_id ~ '^[A-Za-z0-9_-]{1,50}$' AND amount_cents>0 AND currency='CNY'
    AND provider_event_time>0 AND created_at>0 AND evidence_hash ~ '^[0-9a-f]{64}$' AND identity_hash ~ '^[0-9a-f]{64}$'
    AND ((provider='wechat' AND profile IN ('wechat','routine') AND trade_state='SUCCESS' AND identity_source='wechat-signed-query')
      OR (provider='alipay' AND profile='alipay' AND trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED') AND identity_source='alipay-direct-request-scope')))
);
CREATE UNIQUE INDEX ooqe_evidence_uq ON public.offline_order_query_evidence(evidence_hash);
CREATE UNIQUE INDEX ooqe_replay_uq ON public.offline_order_query_evidence(replay_key);
CREATE INDEX ooqe_case_idx ON public.offline_order_query_evidence(case_id,created_at,id);
CREATE INDEX ooqe_transaction_idx ON public.offline_order_query_evidence(provider,transaction_id);
CREATE INDEX prc_provider_transaction_lookup ON public.payment_reconciliation_case(provider,provider_transaction_id)
  WHERE provider_transaction_id<>'';
REVOKE ALL ON public.offline_order_query_evidence FROM PUBLIC;
CREATE TABLE public.offline_order_callback_binding (
  event_id bigint PRIMARY KEY REFERENCES public.payment_callback_event(id) ON DELETE RESTRICT,
  selection_key uuid NOT NULL REFERENCES public.offline_order_payment_selection(selection_key) ON DELETE RESTRICT,
  event_hash varchar(64) NOT NULL, identity_hash varchar(64) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT oocb_identity_ck CHECK(event_id>0 AND created_at>0
    AND event_hash ~ '^[0-9a-f]{64}$' AND identity_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX oocb_selection_idx ON public.offline_order_callback_binding(selection_key);
CREATE TABLE public.offline_order_external_payment (
  order_id integer PRIMARY KEY REFERENCES public.offline_order_payment_selection(order_id) ON DELETE RESTRICT,
  event_id bigint REFERENCES public.offline_order_callback_binding(event_id) ON DELETE RESTRICT,
  query_id uuid REFERENCES public.offline_order_query_evidence(id) ON DELETE RESTRICT,
  uid integer NOT NULL, order_no varchar(32) NOT NULL, version varchar(32) NOT NULL DEFAULT 'offline-external-v1',
  provider varchar(10) NOT NULL, profile varchar(10) NOT NULL, transaction_id varchar(50) NOT NULL,
  provider_paid_at integer NOT NULL, pay_price numeric(10,2) NOT NULL,
  integral_before integer NOT NULL, integral_after integer NOT NULL, integral_reward integer NOT NULL,
  integral_rate numeric(14,6) NOT NULL, member_bonus integer NOT NULL, member_active boolean NOT NULL,
  integral_bill_id integer REFERENCES public.user_bill(id) ON DELETE RESTRICT,
  savings_id integer REFERENCES public.store_order_economize(id) ON DELETE RESTRICT,
  promoted boolean NOT NULL, policy jsonb NOT NULL, paid_at integer NOT NULL,
  CONSTRAINT ooep_source_ck CHECK((event_id IS NOT NULL AND query_id IS NULL) OR (event_id IS NULL AND query_id IS NOT NULL)),
  CONSTRAINT ooep_identity_ck CHECK(order_id>0 AND (event_id IS NULL OR event_id>0) AND uid>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-external-v1' AND paid_at>0 AND provider_paid_at>=0
    AND ((provider='wechat' AND profile IN ('wechat','routine')) OR (provider='alipay' AND profile='alipay'))
    AND transaction_id ~ '^[A-Za-z0-9_-]{1,50}$'
    AND (integral_bill_id IS NULL OR integral_bill_id>0) AND (savings_id IS NULL OR savings_id>0)
    AND jsonb_typeof(policy)='object' AND octet_length(policy::text)<=4096),
  CONSTRAINT ooep_amount_ck CHECK(pay_price>0 AND pay_price<=21474836.47 AND pay_price<>'NaN'::numeric),
  CONSTRAINT ooep_integral_ck CHECK(integral_before>=0 AND integral_after>=0 AND integral_reward>=0
    AND integral_after::bigint=integral_before::bigint+integral_reward::bigint
    AND integral_rate>=0 AND integral_rate<>'NaN'::numeric AND member_bonus>=0 AND (member_active OR member_bonus=0)
    AND integral_reward=trunc(integral_rate*pay_price)+member_bonus
    AND ((integral_reward=0 AND integral_bill_id IS NULL) OR (integral_reward>0 AND integral_bill_id IS NOT NULL)))
);
CREATE UNIQUE INDEX ooep_order_no_uq ON public.offline_order_external_payment(order_no);
CREATE UNIQUE INDEX ooep_event_uq ON public.offline_order_external_payment(event_id);
CREATE UNIQUE INDEX ooep_query_uq ON public.offline_order_external_payment(query_id);
CREATE UNIQUE INDEX ooep_transaction_uq ON public.offline_order_external_payment(provider,transaction_id);
CREATE UNIQUE INDEX ooep_integral_uq ON public.offline_order_external_payment(integral_bill_id);
CREATE UNIQUE INDEX ooep_savings_uq ON public.offline_order_external_payment(savings_id);
REVOKE ALL ON public.offline_order_callback_binding,public.offline_order_external_payment FROM PUBLIC;

`;

export const OFFLINE_ORDER_EXTERNAL_PAYMENT_GUARD_SQL = `CREATE FUNCTION public.ooqe_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooqe$
DECLARE p public.offline_order_payment_selection%ROWTYPE; r public.payment_reconciliation_case%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline query evidence is immutable'; END IF;
  SELECT * INTO p FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
  IF NOT FOUND OR p.rail<>NEW.provider OR p.profile<>NEW.profile OR p.order_no<>NEW.order_no
    OR p.pay_price*100<>NEW.amount_cents OR p.currency<>NEW.currency OR NEW.created_at<p.created_at
  THEN RAISE EXCEPTION 'offline query selection mismatch'; END IF;
  SELECT * INTO r FROM public.payment_reconciliation_case WHERE id=NEW.case_id;
  IF NOT FOUND OR r.provider<>NEW.provider OR r.profile<>NEW.profile OR r.order_no<>NEW.order_no
    OR r.order_domain<>'offline_order' OR r.expected_amount_cents<>NEW.amount_cents OR r.currency<>NEW.currency
  THEN RAISE EXCEPTION 'offline query recovery mismatch'; END IF;
  RETURN NEW;
END $ooqe$;
REVOKE ALL ON FUNCTION public.ooqe_guard() FROM PUBLIC;
CREATE TRIGGER ooqe_insert_guard BEFORE INSERT ON public.offline_order_query_evidence FOR EACH ROW EXECUTE FUNCTION public.ooqe_guard();
CREATE TRIGGER ooqe_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_query_evidence FOR EACH ROW EXECUTE FUNCTION public.ooqe_guard();
CREATE TRIGGER ooqe_truncate_guard BEFORE TRUNCATE ON public.offline_order_query_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.ooqe_guard();
CREATE FUNCTION public.oocb_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oocb$
DECLARE e public.payment_callback_event%ROWTYPE; p public.offline_order_payment_selection%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_callback_binding' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline callback binding is immutable'; END IF;
    SELECT * INTO e FROM public.payment_callback_event WHERE id=NEW.event_id FOR UPDATE;
    IF NOT FOUND OR e.payload_hash<>NEW.event_hash OR e.currency<>'CNY' OR e.order_domain NOT IN ('','offline_order')
      OR e.last_error_code='transaction_evidence_conflict'
      OR NOT ((e.provider='wechat' AND e.trade_state='SUCCESS') OR (e.provider='alipay' AND e.trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED')))
    THEN RAISE EXCEPTION 'offline callback event mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE selection_key=NEW.selection_key;
    IF NOT FOUND OR p.rail<>e.provider OR p.profile<>e.profile OR p.order_no<>e.order_no
      OR p.pay_price*100<>e.amount_cents OR NEW.created_at<p.created_at
    THEN RAISE EXCEPTION 'offline callback selection mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.offline_order_callback_binding WHERE event_id=OLD.id) AND
    ROW(NEW.id,NEW.provider,NEW.profile,NEW.provider_event_id,NEW.replay_key,NEW.payload_hash,NEW.order_no,
      NEW.transaction_id,NEW.trade_state,NEW.amount_cents,NEW.currency,NEW.provider_event_time)
    IS DISTINCT FROM ROW(OLD.id,OLD.provider,OLD.profile,OLD.provider_event_id,OLD.replay_key,OLD.payload_hash,OLD.order_no,
      OLD.transaction_id,OLD.trade_state,OLD.amount_cents,OLD.currency,OLD.provider_event_time)
  THEN RAISE EXCEPTION 'bound offline callback evidence is immutable'; END IF;
  RETURN NEW;
END $oocb$;
REVOKE ALL ON FUNCTION public.oocb_guard() FROM PUBLIC;
CREATE TRIGGER oocb_insert_guard BEFORE INSERT ON public.offline_order_callback_binding FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_callback_binding FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_truncate_guard BEFORE TRUNCATE ON public.offline_order_callback_binding FOR EACH STATEMENT EXECUTE FUNCTION public.oocb_guard();
CREATE TRIGGER oocb_event_guard BEFORE UPDATE ON public.payment_callback_event FOR EACH ROW EXECUTE FUNCTION public.oocb_guard();

CREATE FUNCTION public.ooep_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooep$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE; p public.offline_order_payment_selection%ROWTYPE;
  e public.payment_callback_event%ROWTYPE; c public.offline_order_callback_binding%ROWTYPE; q public.offline_order_query_evidence%ROWTYPE;
  u public."user"%ROWTYPE; b public.user_bill%ROWTYPE; s public.store_order_economize%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_external_payment' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline external receipt is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>1 OR o.pay_type<>(CASE NEW.provider WHEN 'wechat' THEN 'weixin' ELSE 'alipay' END)
      OR o.pay_time<>NEW.paid_at OR o.trade_no<>NEW.transaction_id
    THEN RAISE EXCEPTION 'offline external paid order mismatch'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
    THEN RAISE EXCEPTION 'offline external admission mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE order_id=NEW.order_id;
    IF NOT FOUND OR p.rail<>NEW.provider OR p.profile<>NEW.profile OR p.uid<>NEW.uid OR p.order_no<>NEW.order_no
      OR p.pay_price<>NEW.pay_price OR NEW.paid_at<p.created_at
    THEN RAISE EXCEPTION 'offline external selection mismatch'; END IF;
    IF NEW.event_id IS NOT NULL THEN
    SELECT * INTO c FROM public.offline_order_callback_binding WHERE event_id=NEW.event_id;
    IF NOT FOUND OR c.selection_key<>p.selection_key OR NEW.paid_at<c.created_at
    THEN RAISE EXCEPTION 'offline external binding mismatch'; END IF;
    SELECT * INTO e FROM public.payment_callback_event WHERE id=NEW.event_id;
    IF NOT FOUND OR e.payload_hash<>c.event_hash OR e.provider<>NEW.provider OR e.profile<>NEW.profile
      OR e.order_no<>NEW.order_no OR e.transaction_id<>NEW.transaction_id OR e.amount_cents<>NEW.pay_price*100
      OR e.currency<>'CNY' OR e.provider_event_time<>NEW.provider_paid_at
      OR NOT ((e.provider='wechat' AND e.trade_state='SUCCESS') OR (e.provider='alipay' AND e.trade_state IN ('TRADE_SUCCESS','TRADE_FINISHED')))
    THEN RAISE EXCEPTION 'offline external collection mismatch'; END IF;
    ELSE
      SELECT * INTO q FROM public.offline_order_query_evidence WHERE id=NEW.query_id;
      IF NOT FOUND OR q.selection_key<>p.selection_key OR NEW.paid_at<q.created_at
        OR q.provider<>NEW.provider OR q.profile<>NEW.profile OR q.order_no<>NEW.order_no
        OR q.transaction_id<>NEW.transaction_id OR q.amount_cents<>NEW.pay_price*100
        OR q.currency<>'CNY' OR q.provider_event_time<>NEW.provider_paid_at
      THEN RAISE EXCEPTION 'offline external query collection mismatch'; END IF;
    END IF;
    SELECT * INTO u FROM public."user" WHERE uid=NEW.uid FOR UPDATE;
    IF NOT FOUND OR u.integral<>NEW.integral_after OR (NEW.promoted AND u.is_promoter<>1)
    THEN RAISE EXCEPTION 'offline external account mismatch'; END IF;
    IF NEW.integral_bill_id IS NOT NULL THEN
      SELECT * INTO b FROM public.user_bill WHERE id=NEW.integral_bill_id FOR UPDATE;
      IF NOT FOUND OR b.uid<>NEW.uid OR b.link_id<>NEW.order_no OR b.category<>'integral' OR b.type<>'gain'
        OR b.event_key<>'offline_order_give_integral' OR b.pm<>1 OR b.status<>1 OR b.take<>0 OR b.frozen_time<>0
        OR b.number<>NEW.integral_reward OR b.balance<>NEW.integral_after OR b.add_time<>NEW.paid_at
      THEN RAISE EXCEPTION 'offline external integral mismatch'; END IF;
    END IF;
    IF (a.discount_percent>0) IS DISTINCT FROM (NEW.savings_id IS NOT NULL)
    THEN RAISE EXCEPTION 'offline external savings identity mismatch'; END IF;
    IF NEW.savings_id IS NOT NULL THEN
      SELECT * INTO s FROM public.store_order_economize WHERE id=NEW.savings_id FOR UPDATE;
      IF NOT FOUND OR s.uid<>NEW.uid OR s.order_id<>NEW.order_no OR s.order_type<>2 OR s.pay_price<>NEW.pay_price
        OR s.offline_price<>a.raw_price-a.pay_price OR s.postage_price<>0 OR s.member_price<>0 OR s.coupon_price<>0
        OR s.add_time<>NEW.paid_at OR s.status<>0
      THEN RAISE EXCEPTION 'offline external savings mismatch'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_external_payment) THEN RAISE EXCEPTION 'offline external effects are immutable'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='other_order' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE order_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'offline external paid state is immutable'; END IF;
      IF ROW(NEW.paid,NEW.pay_type,NEW.pay_time,NEW.trade_no) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.pay_time,OLD.trade_no)
      THEN RAISE EXCEPTION 'offline external paid state is immutable'; END IF;
    END IF;
  ELSIF (TG_TABLE_NAME='user_bill' AND EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE integral_bill_id=OLD.id))
    OR (TG_TABLE_NAME='store_order_economize' AND EXISTS(SELECT 1 FROM public.offline_order_external_payment WHERE savings_id=OLD.id))
  THEN RAISE EXCEPTION 'offline external effects are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $ooep$;
REVOKE ALL ON FUNCTION public.ooep_guard() FROM PUBLIC;
CREATE TRIGGER ooep_insert_guard BEFORE INSERT ON public.offline_order_external_payment FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_external_payment FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_truncate_guard BEFORE TRUNCATE ON public.offline_order_external_payment FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_bill_guard BEFORE UPDATE OR DELETE ON public.user_bill FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_savings_guard BEFORE UPDATE OR DELETE ON public.store_order_economize FOR EACH ROW EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_bill_truncate BEFORE TRUNCATE ON public.user_bill FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();
CREATE TRIGGER ooep_savings_truncate BEFORE TRUNCATE ON public.store_order_economize FOR EACH STATEMENT EXECUTE FUNCTION public.ooep_guard();

-- Unlike a pre-dispatch selection, a paid state cannot commit ahead of its
-- financial receipt. Deferred so the order update and receipt can be atomic.
CREATE FUNCTION public.ooep_paid_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooep_commit$
BEGIN
  IF NEW.type=3 AND NEW.paid=1 AND EXISTS(SELECT 1 FROM public.offline_order_payment_selection
    WHERE order_id=NEW.id AND rail IN ('wechat','alipay')) AND NOT EXISTS(SELECT 1 FROM public.offline_order_external_payment
      WHERE order_id=NEW.id AND uid=NEW.uid AND order_no=NEW.order_id AND pay_price=NEW.pay_price
        AND paid_at=NEW.pay_time AND transaction_id=NEW.trade_no
        AND NEW.pay_type=CASE provider WHEN 'wechat' THEN 'weixin' ELSE 'alipay' END)
  THEN RAISE EXCEPTION 'offline external paid state requires committed receipt'; END IF;
  RETURN NULL;
END $ooep_commit$;
REVOKE ALL ON FUNCTION public.ooep_paid_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER ooep_paid_commit AFTER UPDATE ON public.other_order
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ooep_paid_commit();
`;

export const OFFLINE_ORDER_EXTERNAL_PAYMENT_SQL = `${OFFLINE_ORDER_EXTERNAL_PAYMENT_TABLE_SQL}${OFFLINE_ORDER_EXTERNAL_PAYMENT_GUARD_SQL}`;
