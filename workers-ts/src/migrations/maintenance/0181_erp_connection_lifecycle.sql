-- Candidate local ERP lifecycle. Apply only through reviewed commissioning.
-- This file creates no role and issues no GRANT or provider/production request.
CREATE FUNCTION public.erp_config_write_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP <> 'INSERT' AND OLD.is_store=0 AND lower(btrim(OLD.menu_name)) IN ('erp_open','erp_type','jst_appkey','jst_appsecret','jst_default_shopid'))
  OR (TG_OP <> 'DELETE' AND NEW.is_store=0 AND lower(btrim(NEW.menu_name)) IN ('erp_open','erp_type','jst_appkey','jst_appsecret','jst_default_shopid'))
 THEN PERFORM pg_advisory_xact_lock(731745,0); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER erp_config_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.system_config FOR EACH ROW EXECUTE FUNCTION public.erp_config_write_barrier();

CREATE FUNCTION public.erp_store_scope_write_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR TG_OP='DELETE' OR ROW(NEW.id,NEW.erp_shop_id,NEW.is_show,NEW.is_del) IS DISTINCT FROM ROW(OLD.id,OLD.erp_shop_id,OLD.is_show,OLD.is_del)
 THEN PERFORM pg_advisory_xact_lock(731745,1); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER erp_store_scope_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.system_store FOR EACH ROW EXECUTE FUNCTION public.erp_store_scope_write_barrier();
CREATE FUNCTION public.erp_supplier_scope_write_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR TG_OP='DELETE' OR ROW(NEW.id,NEW.is_show,NEW.is_del) IS DISTINCT FROM ROW(OLD.id,OLD.is_show,OLD.is_del)
 THEN PERFORM pg_advisory_xact_lock(731745,1); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER erp_supplier_scope_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON public.system_supplier FOR EACH ROW EXECUTE FUNCTION public.erp_supplier_scope_write_barrier();

CREATE TABLE public.erp_connection (
 id uuid PRIMARY KEY, provider varchar(16) NOT NULL CHECK(provider='jushuitan'), name varchar(64) NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 64),
 state varchar(16) NOT NULL CHECK(state IN ('enrolled','active','disabled','revoked')), revision integer NOT NULL CHECK(revision>0),
 app_key varchar(128) NOT NULL CHECK(length(app_key)>0), credential_fingerprint varchar(64) NOT NULL CHECK(credential_fingerprint~'^[a-f0-9]{64}$'),
 capability_hash varchar(64) NOT NULL CHECK(capability_hash~'^[a-f0-9]{64}$'), capability_version integer NOT NULL CHECK(capability_version>0), rotated_at bigint NOT NULL CHECK(rotated_at>0),
 bindings jsonb NOT NULL CHECK(jsonb_typeof(bindings)='array' AND jsonb_array_length(bindings)<=100), scope_revision integer NOT NULL CHECK(scope_revision>0),
 shop_observation_hash varchar(64) CHECK(shop_observation_hash IS NULL OR shop_observation_hash~'^[a-f0-9]{64}$'),
 created_by integer NOT NULL CHECK(created_by>0), updated_by integer NOT NULL CHECK(updated_by>0), created_at bigint NOT NULL CHECK(created_at>0), updated_at bigint NOT NULL CHECK(updated_at>=created_at),
 revoked_at bigint, revoke_reason varchar(255),
 CHECK(state<>'active' OR (jsonb_array_length(bindings)>0 AND shop_observation_hash IS NOT NULL)),
 CHECK((state='revoked')=(revoked_at IS NOT NULL)), CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE UNIQUE INDEX erp_connection_current_application ON public.erp_connection(app_key,credential_fingerprint) WHERE state<>'revoked';
CREATE TABLE public.erp_auth_state (
 state_hash varchar(64) PRIMARY KEY CHECK(state_hash~'^[a-f0-9]{64}$'), connection_id uuid NOT NULL REFERENCES public.erp_connection(id) ON DELETE RESTRICT,
 connection_revision integer NOT NULL CHECK(connection_revision>0), capability_version integer NOT NULL CHECK(capability_version>0), app_key varchar(128) NOT NULL,
 credential_fingerprint varchar(64) NOT NULL CHECK(credential_fingerprint~'^[a-f0-9]{64}$'), actor_id integer NOT NULL CHECK(actor_id>0),
 actor_auth_version varchar(32) NOT NULL CHECK(actor_auth_version~'^[a-f0-9]{32}$'), actor_expires_at bigint NOT NULL, required_permission varchar(64) NOT NULL CHECK(required_permission='erp.connection.manage'),
 created_at bigint NOT NULL CHECK(created_at>0), expires_at bigint NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+900 AND expires_at<=actor_expires_at),
 state varchar(16) NOT NULL CHECK(state IN ('issued','exchanging','consumed','failed')), code_hash varchar(64) CHECK(code_hash IS NULL OR code_hash~'^[a-f0-9]{64}$'),
 exchange_lease_hash varchar(64) CHECK(exchange_lease_hash IS NULL OR exchange_lease_hash~'^[a-f0-9]{64}$'), lease_expires_at bigint, consumed_at bigint, error_code varchar(64),
 CHECK(state<>'issued' OR (code_hash IS NULL AND exchange_lease_hash IS NULL AND lease_expires_at IS NULL AND consumed_at IS NULL)),
 CHECK(state<>'exchanging' OR (code_hash IS NOT NULL AND exchange_lease_hash IS NOT NULL AND lease_expires_at>created_at)),
 CHECK(state<>'consumed' OR (code_hash IS NOT NULL AND consumed_at>=created_at AND exchange_lease_hash IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX erp_auth_state_connection ON public.erp_auth_state(connection_id,created_at);
CREATE UNIQUE INDEX erp_auth_state_code_once ON public.erp_auth_state(connection_id,code_hash) WHERE code_hash IS NOT NULL;
CREATE TABLE public.erp_credential (
 connection_id uuid PRIMARY KEY REFERENCES public.erp_connection(id) ON DELETE RESTRICT, version integer NOT NULL CHECK(version>0), app_key varchar(128) NOT NULL,
 credential_fingerprint varchar(64) NOT NULL CHECK(credential_fingerprint~'^[a-f0-9]{64}$'), access_token_sealed text NOT NULL CHECK(access_token_sealed LIKE 'erp:v1:%' AND length(access_token_sealed)<=6000),
 refresh_token_sealed text NOT NULL CHECK(refresh_token_sealed LIKE 'erp:v1:%' AND length(refresh_token_sealed)<=6000), issued_at bigint NOT NULL CHECK(issued_at>0),
 expires_at bigint NOT NULL CHECK(expires_at>issued_at), refresh_after bigint NOT NULL CHECK(refresh_after>=issued_at AND refresh_after<expires_at),
 auth_state_hash varchar(64) NOT NULL REFERENCES public.erp_auth_state(state_hash) ON DELETE RESTRICT,
 shop_observation_hash varchar(64) CHECK(shop_observation_hash IS NULL OR shop_observation_hash~'^[a-f0-9]{64}$'),
 refresh_lease_hash varchar(64) CHECK(refresh_lease_hash IS NULL OR refresh_lease_hash~'^[a-f0-9]{64}$'), refresh_lease_expires_at bigint,
 updated_at bigint NOT NULL CHECK(updated_at>=issued_at), state varchar(16) NOT NULL CHECK(state IN ('usable','expired','revoked')), error_code varchar(64),
 CHECK((refresh_lease_hash IS NULL)=(refresh_lease_expires_at IS NULL))
);
CREATE TABLE public.erp_operation (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL REFERENCES public.erp_connection(id) ON DELETE RESTRICT,
 kind varchar(24) NOT NULL CHECK(kind IN ('product-sync','stock','deliver','cancel','refund-receive')), business_key varchar(255) NOT NULL CHECK(length(business_key)>0), provider_event_id varchar(128),
 request_hash varchar(64) NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'), source_ts bigint NOT NULL CHECK(source_ts>0), received_at bigint NOT NULL CHECK(received_at>0),
 connection_revision integer NOT NULL CHECK(connection_revision>0), capability_version integer NOT NULL CHECK(capability_version>0), scope_revision integer NOT NULL CHECK(scope_revision>0), credential_version integer NOT NULL CHECK(credential_version>0),
 state varchar(24) NOT NULL CHECK(state IN ('admitted','observed','business_committed','provider_pending','rejected','failed')),
 lease_hash varchar(64) CHECK(lease_hash IS NULL OR lease_hash~'^[a-f0-9]{64}$'), lease_expires_at bigint, attempt_count integer NOT NULL CHECK(attempt_count BETWEEN 1 AND 100),
 scope jsonb CHECK(scope IS NULL OR jsonb_typeof(scope)='object'), observation_hash varchar(64) CHECK(observation_hash IS NULL OR observation_hash~'^[a-f0-9]{64}$'), observed_at bigint,
 provider_facts jsonb CHECK(provider_facts IS NULL OR jsonb_typeof(provider_facts)='object'), business_result jsonb CHECK(business_result IS NULL OR jsonb_typeof(business_result)='object'),
 payment_admission_id varchar(128), error_code varchar(64), created_at bigint NOT NULL CHECK(created_at>0), updated_at bigint NOT NULL CHECK(updated_at>=created_at), completed_at bigint,
 UNIQUE(connection_id,kind,business_key), CHECK((lease_hash IS NULL)=(lease_expires_at IS NULL)),
 CHECK(state NOT IN ('observed','business_committed','provider_pending') OR (scope IS NOT NULL AND observation_hash IS NOT NULL AND observed_at>0 AND provider_facts IS NOT NULL)),
 CHECK(state<>'business_committed' OR (business_result IS NOT NULL AND completed_at>=created_at AND lease_hash IS NULL)),
 CHECK(state<>'provider_pending' OR (payment_admission_id IS NOT NULL AND business_result IS NOT NULL AND lease_hash IS NULL))
);
CREATE INDEX erp_operation_connection_receipts ON public.erp_operation(connection_id,created_at,id);
CREATE INDEX erp_operation_recovery ON public.erp_operation(state,lease_expires_at) WHERE state IN ('admitted','observed','provider_pending');

-- Immutable identifiers and final receipts survive service mistakes. These
-- guards do not grant an actor authority; live application admission remains
-- obligatory under the same transaction as business effects.
CREATE FUNCTION public.erp_operation_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.kind IS DISTINCT FROM OLD.kind
  OR NEW.business_key IS DISTINCT FROM OLD.business_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
  OR NEW.source_ts IS DISTINCT FROM OLD.source_ts OR NEW.received_at IS DISTINCT FROM OLD.received_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
 THEN RAISE EXCEPTION 'erp operation identity immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state IN ('business_committed','rejected') AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'erp terminal receipt immutable' USING ERRCODE='23514'; END IF;
 IF OLD.observation_hash IS NOT NULL AND (NEW.scope IS DISTINCT FROM OLD.scope OR NEW.observation_hash IS DISTINCT FROM OLD.observation_hash
  OR NEW.provider_facts IS DISTINCT FROM OLD.provider_facts OR NEW.observed_at IS DISTINCT FROM OLD.observed_at) THEN
  RAISE EXCEPTION 'erp admitted facts immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erp_operation_transition_guard BEFORE UPDATE ON public.erp_operation FOR EACH ROW EXECUTE FUNCTION public.erp_operation_transition_guard();
