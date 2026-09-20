/** Local migration component. Use the controlled installer for maintenance;
 * ORM tables need explicit empty-ledger protection completion before use. */
export const OFFLINE_ORDER_BALANCE_TABLE_SQL = `
CREATE TABLE public.offline_order_balance (
  order_id integer PRIMARY KEY REFERENCES public.offline_order_payment_selection(order_id) ON DELETE RESTRICT,
  uid integer NOT NULL, order_no varchar(32) NOT NULL,
  version varchar(32) NOT NULL DEFAULT 'offline-balance-v1',
  pay_price numeric(10,2) NOT NULL, balance_before numeric(12,2) NOT NULL, balance_after numeric(12,2) NOT NULL,
  money_id integer NOT NULL REFERENCES public.user_money(id) ON DELETE RESTRICT,
  integral_before integer NOT NULL, integral_after integer NOT NULL, integral_reward integer NOT NULL,
  integral_rate numeric(14,6) NOT NULL, member_bonus integer NOT NULL, member_active boolean NOT NULL,
  integral_bill_id integer REFERENCES public.user_bill(id) ON DELETE RESTRICT,
  savings_id integer REFERENCES public.store_order_economize(id) ON DELETE RESTRICT,
  promoted boolean NOT NULL, policy jsonb NOT NULL, paid_at integer NOT NULL,
  CONSTRAINT oob_identity_ck CHECK(uid>0 AND order_id>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-balance-v1' AND paid_at>0 AND money_id>0
    AND (integral_bill_id IS NULL OR integral_bill_id>0) AND (savings_id IS NULL OR savings_id>0)
    AND jsonb_typeof(policy)='object' AND octet_length(policy::text)<=4096),
  CONSTRAINT oob_money_ck CHECK(pay_price>0 AND pay_price<>'NaN'::numeric
    AND balance_before>=0 AND balance_before<>'NaN'::numeric AND balance_after>=0 AND balance_after<>'NaN'::numeric
    AND balance_before=balance_after+pay_price),
  CONSTRAINT oob_integral_ck CHECK(integral_before>=0 AND integral_after>=0 AND integral_reward>=0
    AND integral_after::bigint=integral_before::bigint+integral_reward::bigint
    AND integral_rate>=0 AND member_bonus>=0 AND (member_active OR member_bonus=0)
    AND integral_reward=trunc(integral_rate*pay_price)+member_bonus
    AND ((integral_reward=0 AND integral_bill_id IS NULL) OR (integral_reward>0 AND integral_bill_id IS NOT NULL)))
);
CREATE UNIQUE INDEX oob_order_no_uq ON public.offline_order_balance(order_no);
CREATE UNIQUE INDEX oob_money_uq ON public.offline_order_balance(money_id);
CREATE UNIQUE INDEX oob_integral_uq ON public.offline_order_balance(integral_bill_id);
CREATE UNIQUE INDEX oob_savings_uq ON public.offline_order_balance(savings_id);
CREATE UNIQUE INDEX um_offline_balance_uq ON public.user_money(uid,link_id) WHERE type='offline_scan';
CREATE UNIQUE INDEX ub_offline_integral_uq ON public.user_bill(uid,link_id) WHERE event_key='offline_order_give_integral';
REVOKE ALL ON public.offline_order_balance FROM PUBLIC;

`;

export const OFFLINE_ORDER_BALANCE_GUARD_SQL = `CREATE FUNCTION public.oob_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oob$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE;
  p public.offline_order_payment_selection%ROWTYPE;
  u public."user"%ROWTYPE; m public.user_money%ROWTYPE; b public.user_bill%ROWTYPE;
  s public.store_order_economize%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_balance' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline balance receipt is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline balance order missing'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
      OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>1 OR o.pay_type<>'yue' OR o.pay_time<>NEW.paid_at OR o.trade_no<>'' OR o.is_del<>0
      OR NEW.paid_at<a.created_at
    THEN RAISE EXCEPTION 'offline balance order mismatch'; END IF;
    SELECT * INTO p FROM public.offline_order_payment_selection WHERE order_id=NEW.order_id;
    IF NOT FOUND OR p.rail<>'yue' OR p.uid<>NEW.uid OR p.order_no<>NEW.order_no OR p.pay_price<>NEW.pay_price OR p.created_at<>NEW.paid_at
    THEN RAISE EXCEPTION 'offline balance payment selection mismatch'; END IF;
    SELECT * INTO u FROM public."user" WHERE uid=NEW.uid FOR UPDATE;
    IF NOT FOUND OR u.status<>1 OR u.is_del<>0 OR u.delete_time IS NOT NULL
      OR u.now_money<>NEW.balance_after OR u.integral<>NEW.integral_after OR (NEW.promoted AND u.is_promoter<>1)
    THEN RAISE EXCEPTION 'offline balance account mismatch'; END IF;
    SELECT * INTO m FROM public.user_money WHERE id=NEW.money_id FOR UPDATE;
    IF NOT FOUND OR m.uid<>NEW.uid OR m.link_id<>NEW.order_no OR m.type<>'offline_scan'
      OR m.pm<>0 OR m.status<>1 OR m.number<>NEW.pay_price OR m.balance<>NEW.balance_after OR m.add_time<>NEW.paid_at
    THEN RAISE EXCEPTION 'offline balance money mismatch'; END IF;
    IF NEW.integral_bill_id IS NOT NULL THEN
      SELECT * INTO b FROM public.user_bill WHERE id=NEW.integral_bill_id FOR UPDATE;
      IF NOT FOUND OR b.uid<>NEW.uid OR b.link_id<>NEW.order_no OR b.category<>'integral' OR b.type<>'gain'
        OR b.event_key<>'offline_order_give_integral' OR b.pm<>1 OR b.status<>1 OR b.take<>0 OR b.frozen_time<>0
        OR b.number<>NEW.integral_reward OR b.balance<>NEW.integral_after OR b.add_time<>NEW.paid_at
      THEN RAISE EXCEPTION 'offline balance integral mismatch'; END IF;
    END IF;
    IF (a.discount_percent>0) IS DISTINCT FROM (NEW.savings_id IS NOT NULL)
    THEN RAISE EXCEPTION 'offline balance savings identity mismatch'; END IF;
    IF NEW.savings_id IS NOT NULL THEN
      SELECT * INTO s FROM public.store_order_economize WHERE id=NEW.savings_id FOR UPDATE;
      IF NOT FOUND OR s.uid<>NEW.uid OR s.order_id<>NEW.order_no OR s.order_type<>2 OR s.pay_price<>NEW.pay_price
        OR s.offline_price<>a.raw_price-a.pay_price OR s.postage_price<>0 OR s.member_price<>0 OR s.coupon_price<>0
        OR s.add_time<>NEW.paid_at OR s.status<>0
      THEN RAISE EXCEPTION 'offline balance savings mismatch'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_balance) THEN RAISE EXCEPTION 'offline balance effects are immutable'; END IF;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='other_order' THEN
    IF EXISTS(SELECT 1 FROM public.offline_order_balance WHERE order_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'offline balance paid state is immutable'; END IF;
      IF ROW(NEW.paid,NEW.pay_type,NEW.pay_time,NEW.trade_no) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.pay_time,OLD.trade_no)
      THEN RAISE EXCEPTION 'offline balance paid state is immutable'; END IF;
    END IF;
  ELSIF (TG_TABLE_NAME='user_money' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE money_id=OLD.id))
    OR (TG_TABLE_NAME='user_bill' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE integral_bill_id=OLD.id))
    OR (TG_TABLE_NAME='store_order_economize' AND EXISTS(SELECT 1 FROM public.offline_order_balance WHERE savings_id=OLD.id))
  THEN RAISE EXCEPTION 'offline balance effects are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $oob$;
REVOKE ALL ON FUNCTION public.oob_guard() FROM PUBLIC;
CREATE TRIGGER oob_insert_guard BEFORE INSERT ON public.offline_order_balance FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_balance FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_truncate_guard BEFORE TRUNCATE ON public.offline_order_balance FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_money_guard BEFORE UPDATE OR DELETE ON public.user_money FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_bill_guard BEFORE UPDATE OR DELETE ON public.user_bill FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_savings_guard BEFORE UPDATE OR DELETE ON public.store_order_economize FOR EACH ROW EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_money_truncate BEFORE TRUNCATE ON public.user_money FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_bill_truncate BEFORE TRUNCATE ON public.user_bill FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
CREATE TRIGGER oob_savings_truncate BEFORE TRUNCATE ON public.store_order_economize FOR EACH STATEMENT EXECUTE FUNCTION public.oob_guard();
`;

export const OFFLINE_ORDER_BALANCE_SQL = `${OFFLINE_ORDER_BALANCE_TABLE_SQL}${OFFLINE_ORDER_BALANCE_GUARD_SQL}`;
