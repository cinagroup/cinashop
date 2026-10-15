-- Explicit independent owner-only PG16 maintenance addon. Never run by HTTP or historical bootstrap.
CREATE TABLE public.admin_product_video_upload_v1 (
  upload_id uuid NOT NULL,
  actor_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  intent jsonb,
  object_key varchar(180),
  state varchar(16) NOT NULL,
  parts jsonb NOT NULL,
  confirmed jsonb NOT NULL,
  attachment_id integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  expires_at integer NOT NULL,
  CONSTRAINT apvu_pk PRIMARY KEY(upload_id),
  CONSTRAINT apvu_object_uq UNIQUE(object_key),
  CONSTRAINT apvu_identity_ck CHECK (actor_id>0 AND created_at>0 AND updated_at>=created_at
    AND expires_at::bigint=created_at::bigint+43200
    AND upload_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT apvu_parts_ck CHECK (jsonb_typeof(parts)='object'
    AND jsonb_array_length(jsonb_path_query_array(parts,'$.keyvalue()'))<=100 AND octet_length(parts::text)<=16384),
  CONSTRAINT apvu_confirmed_ck CHECK (jsonb_typeof(confirmed)='array' AND jsonb_array_length(confirmed)<=100),
  CONSTRAINT apvu_state_ck CHECK ((
    (state='cancelled' AND attachment_id IS NULL AND (
      (intent IS NULL AND object_key IS NULL AND request_hash='' AND parts='{}'::jsonb AND confirmed='[]'::jsonb)
      OR (jsonb_typeof(intent)='object' AND request_hash ~ '^[0-9a-f]{64}$' AND object_key IS NOT NULL)))
    OR (state IN ('active','committed') AND jsonb_typeof(intent)='object'
      AND request_hash ~ '^[0-9a-f]{64}$' AND object_key IS NOT NULL
      AND ((state='active' AND attachment_id IS NULL) OR (state='committed' AND attachment_id>0)))) IS TRUE),
  CONSTRAINT apvu_object_ck CHECK (object_key IS NULL OR object_key ~ '^attachments/admin/1/[0-9]{4}/[0-9]{2}/[a-f0-9-]{36}\.mp4$')
);
CREATE FUNCTION public.admin_product_video_upload_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $apvu$BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.state <> 'active' THEN
    RAISE EXCEPTION 'Product video upload facts cannot be removed or reopened' USING ERRCODE='42501';
  END IF;
  IF (NEW.upload_id,NEW.actor_id,NEW.request_hash,NEW.intent,NEW.object_key,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.upload_id,OLD.actor_id,OLD.request_hash,OLD.intent,OLD.object_key,OLD.created_at,OLD.expires_at)
    OR NEW.state NOT IN ('active','cancelled','committed') OR NEW.updated_at<OLD.updated_at
    OR NOT (NEW.parts @> OLD.parts) OR NOT (NEW.confirmed @> OLD.confirmed) THEN
    RAISE EXCEPTION 'Product video upload identity and confirmed parts are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END$apvu$;
REVOKE ALL ON FUNCTION public.admin_product_video_upload_guard_v1() FROM PUBLIC;
CREATE TRIGGER apvu_rows BEFORE UPDATE OR DELETE ON public.admin_product_video_upload_v1
FOR EACH ROW EXECUTE FUNCTION public.admin_product_video_upload_guard_v1();
CREATE TRIGGER apvu_truncate BEFORE TRUNCATE ON public.admin_product_video_upload_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_product_video_upload_guard_v1();
REVOKE ALL ON TABLE public.admin_product_video_upload_v1 FROM PUBLIC;
