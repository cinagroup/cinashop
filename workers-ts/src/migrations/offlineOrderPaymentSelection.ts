/** Local migration component. Use the controlled installer for maintenance;
 * ORM tables need explicit empty-ledger protection completion before use. */
export const OFFLINE_ORDER_PAYMENT_SELECTION_TABLE_SQL = `
CREATE TABLE public.offline_order_payment_selection (
  order_id integer PRIMARY KEY REFERENCES public.offline_order_admission(order_id) ON DELETE RESTRICT,
  selection_key uuid NOT NULL, uid integer NOT NULL, order_no varchar(32) NOT NULL,
  version varchar(32) NOT NULL DEFAULT 'offline-payment-v1', rail varchar(10) NOT NULL,
  profile varchar(10) NOT NULL, transaction_type varchar(10) NOT NULL,
  app_id varchar(64) NOT NULL, merchant_id varchar(64) NOT NULL, payer_id varchar(100) NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'CNY', pay_price numeric(10,2) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT oops_identity_ck CHECK(order_id>0 AND uid>0 AND order_no ~ '^xx[0-9a-f]{30}$'
    AND selection_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND version='offline-payment-v1' AND currency='CNY' AND created_at>0),
  CONSTRAINT oops_price_ck CHECK(pay_price>0 AND pay_price<>'NaN'::numeric
    AND (rail='yue' OR pay_price<=21474836.47)),
  CONSTRAINT oops_rail_ck CHECK(
    (rail='yue' AND profile='' AND transaction_type='' AND app_id='' AND merchant_id='' AND payer_id='')
    OR (rail IN ('wechat','alipay') AND app_id ~ '^[A-Za-z0-9_-]{1,64}$' AND merchant_id ~ '^[A-Za-z0-9_-]{1,64}$'
      AND ((rail='wechat' AND profile IN ('wechat','routine')
        AND ((transaction_type='jsapi' AND payer_id ~ '^[A-Za-z0-9_-]{1,100}$')
          OR (transaction_type='h5' AND profile='wechat' AND payer_id='')))
      OR (rail='alipay' AND profile='alipay' AND transaction_type='wap' AND payer_id=''))))
);
CREATE UNIQUE INDEX oops_key_uq ON public.offline_order_payment_selection(selection_key);
CREATE UNIQUE INDEX oops_order_no_uq ON public.offline_order_payment_selection(order_no);
REVOKE ALL ON public.offline_order_payment_selection FROM PUBLIC;

`;

export const OFFLINE_ORDER_PAYMENT_SELECTION_GUARD_SQL = `CREATE FUNCTION public.oops_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oops$
DECLARE o public.other_order%ROWTYPE; a public.offline_order_admission%ROWTYPE;
  s public.offline_order_payment_selection%ROWTYPE; matches integer; payer text;
BEGIN
  IF TG_TABLE_NAME='offline_order_payment_selection' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'offline payment selection is immutable'; END IF;
    IF current_setting('transaction_isolation')<>'read committed' THEN
      RAISE EXCEPTION 'offline payment requires READ COMMITTED' USING ERRCODE='25000';
    END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline payment order missing'; END IF;
    SELECT * INTO a FROM public.offline_order_admission WHERE order_id=NEW.order_id;
    IF NOT FOUND OR a.uid<>NEW.uid OR a.order_no<>NEW.order_no OR a.pay_price<>NEW.pay_price
      OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3 OR o.pay_price<>NEW.pay_price
      OR o.paid<>0 OR o.pay_type<>'' OR o.trade_no<>'' OR o.pay_time<>0 OR o.is_del<>0 OR NEW.created_at<a.created_at
    THEN RAISE EXCEPTION 'offline payment selection order mismatch'; END IF;
    PERFORM uid FROM public."user" WHERE uid=NEW.uid AND status=1 AND is_del=0 AND delete_time IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'offline payment account unavailable'; END IF;
    IF NEW.rail='wechat' THEN
      IF (a.channel='routine' AND (NEW.profile<>'routine' OR NEW.transaction_type<>'jsapi'))
        OR (a.channel='wechat' AND (NEW.profile<>'wechat' OR NEW.transaction_type<>'jsapi'))
        OR (a.channel IN ('h5','weixinh5') AND (NEW.profile<>'wechat' OR NEW.transaction_type<>'h5'))
      THEN RAISE EXCEPTION 'offline payment channel mismatch'; END IF;
      IF NEW.transaction_type='jsapi' THEN
        SELECT count(*),min(openid) INTO matches,payer FROM
          (SELECT openid FROM public.wechat_user WHERE uid=NEW.uid AND user_type=NEW.profile AND is_del=0 LIMIT 2 FOR UPDATE) bindings;
        IF matches<>1 OR payer IS DISTINCT FROM NEW.payer_id THEN RAISE EXCEPTION 'offline payment payer mismatch'; END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM public.offline_order_payment_selection WHERE order_id=OLD.id;
  IF FOUND AND ROW(NEW.paid,NEW.pay_type,NEW.trade_no,NEW.pay_time) IS DISTINCT FROM ROW(OLD.paid,OLD.pay_type,OLD.trade_no,OLD.pay_time) THEN
    IF NOT ((NEW.paid=0 AND NEW.pay_type='' AND NEW.trade_no='' AND NEW.pay_time=0)
      OR (NEW.paid=1 AND NEW.pay_time>=s.created_at
        AND NEW.pay_type=CASE s.rail WHEN 'wechat' THEN 'weixin' ELSE s.rail END
        AND ((s.rail='yue' AND NEW.trade_no='') OR (s.rail<>'yue' AND NEW.trade_no<>''))))
    THEN RAISE EXCEPTION 'offline payment rail mismatch'; END IF;
  END IF;
  RETURN NEW;
END $oops$;
REVOKE ALL ON FUNCTION public.oops_guard() FROM PUBLIC;
CREATE TRIGGER oops_insert_guard BEFORE INSERT ON public.offline_order_payment_selection FOR EACH ROW EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_payment_selection FOR EACH ROW EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_truncate_guard BEFORE TRUNCATE ON public.offline_order_payment_selection FOR EACH STATEMENT EXECUTE FUNCTION public.oops_guard();
CREATE TRIGGER oops_order_guard BEFORE UPDATE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.oops_guard();

-- A wallet reservation is never an orphan committed before the debit. External
-- choices intentionally persist while provider outcome is still unknown.
CREATE FUNCTION public.oops_wallet_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $oops_commit$
BEGIN
  IF NEW.rail='yue' AND NOT EXISTS(SELECT 1 FROM public.offline_order_balance
    WHERE order_id=NEW.order_id AND uid=NEW.uid AND order_no=NEW.order_no AND pay_price=NEW.pay_price AND paid_at=NEW.created_at)
  THEN RAISE EXCEPTION 'offline wallet selection requires committed receipt'; END IF;
  RETURN NULL;
END $oops_commit$;
REVOKE ALL ON FUNCTION public.oops_wallet_commit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER oops_wallet_commit AFTER INSERT ON public.offline_order_payment_selection
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.oops_wallet_commit();
`;

export const OFFLINE_ORDER_PAYMENT_SELECTION_SQL = `${OFFLINE_ORDER_PAYMENT_SELECTION_TABLE_SQL}${OFFLINE_ORDER_PAYMENT_SELECTION_GUARD_SQL}`;
