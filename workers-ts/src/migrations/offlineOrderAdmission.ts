/** Local migration component. Use the controlled installer for maintenance;
 * ORM tables need explicit empty-ledger protection completion before use. */
export const OFFLINE_ORDER_ADMISSION_TABLE_SQL = `
CREATE TABLE public.offline_order_admission (
  uid integer NOT NULL, request_key uuid NOT NULL, request_hash varchar(64) NOT NULL,
  order_id integer NOT NULL, order_no varchar(32) NOT NULL,
  version varchar(32) NOT NULL DEFAULT 'offline-admission-v1',
  raw_price numeric(10,2) NOT NULL, pay_price numeric(10,2) NOT NULL,
  member_active boolean NOT NULL, discount_percent integer NOT NULL,
  channel varchar(10) NOT NULL, created_at integer NOT NULL,
  CONSTRAINT ooa_pk PRIMARY KEY(uid,request_key),
  CONSTRAINT ooa_user_fk FOREIGN KEY(uid) REFERENCES public."user"(uid) ON DELETE RESTRICT,
  CONSTRAINT ooa_order_fk FOREIGN KEY(order_id) REFERENCES public.other_order(id) ON DELETE RESTRICT,
  CONSTRAINT ooa_identity_ck CHECK(uid>0 AND order_id>0 AND created_at>0
    AND request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND request_hash ~ '^[0-9a-f]{64}$' AND order_no ~ '^xx[0-9a-f]{30}$'
    AND version='offline-admission-v1' AND channel IN ('wechat','weixinh5','routine','h5')),
  CONSTRAINT ooa_pricing_ck CHECK(raw_price>0 AND pay_price>=0 AND discount_percent BETWEEN 0 AND 100
    AND (member_active OR discount_percent=0)
    AND pay_price=CASE WHEN discount_percent=0 THEN raw_price ELSE trunc(raw_price*discount_percent/100,2) END)
);
CREATE UNIQUE INDEX ooa_order_id_uq ON public.offline_order_admission(order_id);
CREATE UNIQUE INDEX ooa_order_no_uq ON public.offline_order_admission(order_no);
CREATE INDEX ooa_user_history ON public.offline_order_admission(uid,created_at,order_id);
REVOKE ALL ON public.offline_order_admission FROM PUBLIC;

`;

export const OFFLINE_ORDER_ADMISSION_GUARD_SQL = `CREATE FUNCTION public.ooa_lock_pricing() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooa_lock$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'offline admission requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  LOCK TABLE public.member_right,public.system_config IN SHARE MODE NOWAIT;
END $ooa_lock$;
REVOKE ALL ON FUNCTION public.ooa_lock_pricing() FROM PUBLIC;

CREATE FUNCTION public.ooa_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $ooa$
DECLARE o public.other_order%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='offline_order_admission' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'offline admission is immutable'; END IF;
    SELECT * INTO o FROM public.other_order WHERE id=NEW.order_id FOR UPDATE;
    IF NOT FOUND OR o.uid<>NEW.uid OR o.order_id<>NEW.order_no OR o.type<>3
      OR o.store_id<>0 OR o.staff_id<>0 OR o.money<>NEW.raw_price OR o.pay_price<>NEW.pay_price
      OR o.member_price<>NEW.pay_price OR o.channel_type<>NEW.channel OR o.add_time<>NEW.created_at
      OR o.paid<>0 OR o.pay_type<>'' OR o.trade_no<>'' OR o.pay_time<>0 OR o.is_del<>0
      OR o.member_type<>'' OR o.is_free<>0 OR o.is_permanent<>0 OR o.vip_day<>0 OR o.overdue_time<>0
    THEN RAISE EXCEPTION 'offline admission order mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.offline_order_admission WHERE order_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'admitted offline order cannot be deleted'; END IF;
    IF ROW(NEW.id,NEW.uid,NEW.order_id,NEW.type,NEW.store_id,NEW.staff_id,NEW.money,NEW.pay_price,NEW.member_price,
      NEW.channel_type,NEW.add_time,NEW.member_type,NEW.is_free,NEW.is_permanent,NEW.vip_day,NEW.overdue_time)
      IS DISTINCT FROM ROW(OLD.id,OLD.uid,OLD.order_id,OLD.type,OLD.store_id,OLD.staff_id,OLD.money,OLD.pay_price,OLD.member_price,
      OLD.channel_type,OLD.add_time,OLD.member_type,OLD.is_free,OLD.is_permanent,OLD.vip_day,OLD.overdue_time)
    THEN RAISE EXCEPTION 'offline order admission fields are immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $ooa$;
REVOKE ALL ON FUNCTION public.ooa_guard() FROM PUBLIC;
CREATE TRIGGER ooa_insert_guard BEFORE INSERT ON public.offline_order_admission FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_change_guard BEFORE UPDATE OR DELETE ON public.offline_order_admission FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_truncate_guard BEFORE TRUNCATE ON public.offline_order_admission FOR EACH STATEMENT EXECUTE FUNCTION public.ooa_guard();
CREATE TRIGGER ooa_order_guard BEFORE UPDATE OR DELETE ON public.other_order FOR EACH ROW EXECUTE FUNCTION public.ooa_guard();
`;

export const OFFLINE_ORDER_ADMISSION_SQL = `${OFFLINE_ORDER_ADMISSION_TABLE_SQL}${OFFLINE_ORDER_ADMISSION_GUARD_SQL}`;
