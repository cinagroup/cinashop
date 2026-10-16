-- Independent product video GC addon; explicit owner maintenance only.
CREATE TABLE public.product_video_gc_state_v1 (
  scope varchar(16) NOT NULL,
  cursor uuid,
  maximum uuid,
  cycle integer NOT NULL,
  lease_token uuid,
  lease_until integer NOT NULL,
  last_completed_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT pvgc_pk PRIMARY KEY(scope),
  CONSTRAINT pvgc_scope_ck CHECK (scope IN ('admin','supplier')),
  CONSTRAINT pvgc_numeric_ck CHECK (cycle>=0 AND lease_until>=0 AND last_completed_at>=0 AND updated_at>=0),
  CONSTRAINT pvgc_cursor_ck CHECK (cursor IS NULL OR (maximum IS NOT NULL AND cursor<=maximum)),
  CONSTRAINT pvgc_lease_ck CHECK ((lease_token IS NULL)=(lease_until=0))
);
INSERT INTO public.product_video_gc_state_v1
  (scope,cursor,maximum,cycle,lease_token,lease_until,last_completed_at,updated_at)
  VALUES ('admin',NULL,NULL,0,NULL,0,0,0),('supplier',NULL,NULL,0,NULL,0,0,0);
CREATE FUNCTION public.product_video_gc_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $pvgc$DECLARE
  now_seconds bigint;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Product video GC scopes cannot be added or removed' USING ERRCODE='42501';
  END IF;
  IF NEW.scope IS DISTINCT FROM OLD.scope OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Product video GC scope and time are immutable or monotone' USING ERRCODE='42501';
  END IF;
  now_seconds := floor(extract(epoch FROM clock_timestamp()))::bigint;
  IF (NEW.cursor,NEW.maximum,NEW.cycle,NEW.last_completed_at)
      IS NOT DISTINCT FROM (OLD.cursor,OLD.maximum,OLD.cycle,OLD.last_completed_at)
    AND NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token
    AND (OLD.lease_token IS NULL OR OLD.lease_until<=now_seconds)
    AND NEW.lease_until>now_seconds AND NEW.lease_until<=now_seconds+120 THEN
    RETURN NEW;
  END IF;
  IF OLD.maximum IS NULL AND OLD.cursor IS NULL AND NEW.maximum IS NOT NULL AND NEW.cursor IS NULL
    AND OLD.lease_token IS NOT NULL AND NEW.lease_token=OLD.lease_token AND NEW.lease_until=OLD.lease_until
    AND NEW.cycle=OLD.cycle AND NEW.last_completed_at=OLD.last_completed_at THEN
    RETURN NEW;
  END IF;
  IF OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL AND NEW.lease_until=0 AND (
    (NEW.cursor,NEW.maximum,NEW.cycle,NEW.last_completed_at)
      IS NOT DISTINCT FROM (OLD.cursor,OLD.maximum,OLD.cycle,OLD.last_completed_at)
    OR (OLD.maximum IS NOT NULL AND NEW.maximum=OLD.maximum AND NEW.cycle=OLD.cycle
      AND NEW.last_completed_at=OLD.last_completed_at AND NEW.cursor IS NOT NULL
      AND (OLD.cursor IS NULL OR NEW.cursor>OLD.cursor) AND NEW.cursor<=OLD.maximum)
    OR (NEW.cursor IS NULL AND NEW.maximum IS NULL AND NEW.cycle::bigint=OLD.cycle::bigint+1
      AND NEW.last_completed_at>=OLD.last_completed_at AND NEW.last_completed_at>0)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Product video GC update is not an allowed lease transition' USING ERRCODE='42501';
END$pvgc$;
REVOKE ALL ON FUNCTION public.product_video_gc_guard_v1() FROM PUBLIC;
CREATE TRIGGER pvgc_rows BEFORE INSERT OR UPDATE OR DELETE ON public.product_video_gc_state_v1
FOR EACH ROW EXECUTE FUNCTION public.product_video_gc_guard_v1();
CREATE TRIGGER pvgc_truncate BEFORE TRUNCATE ON public.product_video_gc_state_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.product_video_gc_guard_v1();
REVOKE ALL ON TABLE public.product_video_gc_state_v1 FROM PUBLIC;
