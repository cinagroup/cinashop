import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { ServiceUnavailableException } from '../utils/errors';
import type { SeckillScheduleRuntimeTarget } from './runSeckillScheduleRuntimeUpgrade';

type Query = Pick<DbClient, 'execute'>;
export type SupplierProductLabelCapabilityTarget = SeckillScheduleRuntimeTarget & { owner: string };
export type SupplierProductLabelCapabilityInspectionTarget = Pick<SupplierProductLabelCapabilityTarget,'app'|'admin'|'maintenance'>
  & Partial<Pick<SupplierProductLabelCapabilityTarget,'owner'|'database'>>;
export const SUPPLIER_PRODUCT_LABEL_CAPABILITY = 'supplier-product-label-capability-v1';
export const SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION = 'supplier_product_label_mutate_v1';
export const SUPPLIER_PRODUCT_LABEL_CAPABILITY_SIGNATURE = 'public.supplier_product_label_mutate_v1(jsonb,text,integer,jsonb,jsonb)';
export const SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE = [731626, 28] as const;
export const SUPPLIER_PRODUCT_LABEL_CAPABILITY_ARGUMENTS = ['p_context','p_operation','p_id','p_expected','p_payload'] as const;

// This source-defined block is deliberately repeated after deferred effects.
// A GUC, a supplied role list or a serialized boolean never grants authority.
const authoritySql = String.raw`-- context is detached from the caller body by the service before its first await.
-- Every value is still checked independently; no authorized=true or role list from context.
v_role_ids:=ARRAY[]::integer[]; v_all_menu_ids:=ARRAY[]::integer[];
v_active_tokens:=ARRAY[]::text[]; v_active_menu_ids:=ARRAY[]::integer[]; v_manage:=false;
IF p_context IS NULL OR pg_catalog.jsonb_typeof(p_context)<>'object'
THEN RAISE EXCEPTION 'Invalid Supplier label actor context' USING ERRCODE='P2104'; END IF;
IF (SELECT count(*)<>4 OR NOT bool_and(key IN('actor_id','supplier_id','auth_version','expires_at'))
      FROM pg_catalog.jsonb_object_keys(p_context) AS key)
  OR NOT(p_context ?& ARRAY['actor_id','supplier_id','auth_version','expires_at'])
  OR (SELECT bool_or(pg_catalog.jsonb_typeof(p_context->key)<>'number'
        OR (p_context->>key) !~ '^[1-9][0-9]{0,9}$')
      FROM pg_catalog.unnest(ARRAY['actor_id','supplier_id']) AS key)
  OR pg_catalog.jsonb_typeof(p_context->'auth_version')<>'string'
  OR (p_context->>'auth_version') !~ '^[a-f0-9]{32}$'
THEN RAISE EXCEPTION 'Invalid Supplier label actor context' USING ERRCODE='P2104'; END IF;
IF pg_catalog.jsonb_typeof(p_context->'expires_at')<>'number' OR (p_context->>'expires_at')!~'^-?(0|[1-9][0-9]{0,15})$' THEN
  RAISE EXCEPTION '供应商会话期限格式错误' USING ERRCODE='P2104';
END IF;
IF pg_catalog.abs((p_context->>'expires_at')::numeric)>9007199254740991 THEN
  RAISE EXCEPTION '供应商会话期限格式错误' USING ERRCODE='P2104';
END IF;
IF (p_context->>'actor_id')::numeric>2147483647 OR (p_context->>'supplier_id')::numeric>2147483647

THEN RAISE EXCEPTION '供应商身份格式错误' USING ERRCODE='P2104'; END IF;
IF (p_context->>'expires_at')::numeric<=pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp()))
THEN RAISE EXCEPTION '登录已过期' USING ERRCODE='P2105'; END IF;
SELECT * INTO v_admin FROM public.system_admin
 WHERE id=(p_context->>'actor_id')::integer AND admin_type=4
   AND relation_id=(p_context->>'supplier_id')::integer AND status=1 AND is_del=0
 FOR SHARE NOWAIT;
SELECT * INTO v_supplier FROM public.system_supplier
 WHERE id=(p_context->>'supplier_id')::integer AND is_show=1 AND is_del=0
 FOR SHARE NOWAIT;
IF v_admin.id IS NULL OR v_supplier.id IS NULL
THEN RAISE EXCEPTION '供应商标签权限已变化' USING ERRCODE='P2104'; END IF;
IF pg_catalog.md5(v_admin.pwd) IS DISTINCT FROM p_context->>'auth_version'
THEN RAISE EXCEPTION '登录凭据已变化' USING ERRCODE='P2105'; END IF;
v_auth_roles:='[]'::jsonb; v_auth_menus:='[]'::jsonb;
IF v_supplier.admin_id=v_admin.id THEN
  v_manage:=true; -- Primary authority derives only from the actual live supplier.admin_id.
ELSE
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT pg_catalog.btrim(t,v_js_ws))
    FILTER(WHERE pg_catalog.btrim(t,v_js_ws)<>''),ARRAY[]::text[]) INTO v_tokens
    FROM pg_catalog.unnest(pg_catalog.string_to_array(v_admin.roles,',')) AS t;
  IF pg_catalog.cardinality(v_tokens)>512 THEN RAISE EXCEPTION 'Supplier role count invalid' USING ERRCODE='P2101'; END IF;
  FOREACH v_token IN ARRAY v_tokens LOOP
    -- Match the stronger write precheck in SupplierProductLabelService.assertAuthority.
    IF v_token !~ '^[1-9][0-9]*$' OR pg_catalog.length(v_token)>10
    THEN RAISE EXCEPTION 'Supplier role identity invalid' USING ERRCODE='P2101'; END IF;
    IF v_token::numeric>2147483647
    THEN RAISE EXCEPTION 'Supplier role identity invalid' USING ERRCODE='P2101'; END IF;
    v_role_ids:=pg_catalog.array_append(v_role_ids,v_token::integer);
  END LOOP;
  -- Missing/wrong-scope roles are ignored by the mature resolver. Disabled real
  -- same-scope roles remain locked but do not contribute effective permissions.
  FOR v_role IN SELECT * FROM public.system_role
    WHERE id=ANY(v_role_ids) AND type=4 AND relation_id=v_supplier.id
    ORDER BY id FOR SHARE NOWAIT LOOP
    v_auth_roles:=v_auth_roles||pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_role));
    SELECT COALESCE(pg_catalog.array_agg(DISTINCT pg_catalog.btrim(t,v_js_ws))
      FILTER(WHERE pg_catalog.btrim(t,v_js_ws)<>''),ARRAY[]::text[]) INTO v_tokens
      FROM pg_catalog.unnest(pg_catalog.string_to_array(v_role.rules,',')) AS t;
    IF v_role.status=1 THEN
      IF pg_catalog.cardinality(v_tokens)>512 THEN RAISE EXCEPTION 'Supplier rule count invalid' USING ERRCODE='P2101'; END IF;
      v_active_tokens:=v_active_tokens||v_tokens;
    END IF;
    FOREACH v_token IN ARRAY v_tokens LOOP
      IF v_token ~ '^[1-9][0-9]*$' THEN
        -- Existing write admission rejects out-of-int32 menu IDs, even in a
        -- disabled role, before the effective active-role resolver runs.
        IF pg_catalog.length(v_token)>10 OR v_token::numeric>2147483647
        THEN RAISE EXCEPTION 'Supplier menu identity invalid' USING ERRCODE='P2101'; END IF;
        v_all_menu_ids:=pg_catalog.array_append(v_all_menu_ids,v_token::integer);
      END IF;
    END LOOP;
  END LOOP;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT id),ARRAY[]::integer[]) INTO v_all_menu_ids
    FROM pg_catalog.unnest(v_all_menu_ids) AS id;
  IF pg_catalog.cardinality(v_all_menu_ids)>512 THEN RAISE EXCEPTION 'Supplier menu count invalid' USING ERRCODE='P2101'; END IF;
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT token),ARRAY[]::text[]) INTO v_active_tokens
    FROM pg_catalog.unnest(v_active_tokens) AS token;
  IF pg_catalog.cardinality(v_active_tokens)>512 THEN RAISE EXCEPTION 'Supplier effective rule count invalid' USING ERRCODE='P2101'; END IF;
  v_manage:='supplier.product.manage'=ANY(v_active_tokens);
  SELECT COALESCE(pg_catalog.array_agg(DISTINCT token::integer),ARRAY[]::integer[]) INTO v_active_menu_ids
    FROM pg_catalog.unnest(v_active_tokens) AS token WHERE token ~ '^[1-9][0-9]*$';
  -- Lock the entire same-scope referenced API menu set, not just one granting row.
  -- is_show is deliberately irrelevant; type/auth_type/access/is_del are exact.
  FOR v_menu IN SELECT * FROM public.system_menus
    WHERE id=ANY(v_all_menu_ids) AND type=4 AND auth_type=2 AND access=1 AND is_del=0
    ORDER BY id FOR SHARE NOWAIT LOOP
    v_auth_menus:=v_auth_menus||pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_menu));
    IF v_menu.id=ANY(v_active_menu_ids) THEN
      SELECT COALESCE(pg_catalog.array_agg(pg_catalog.btrim(m,v_js_ws))
        FILTER(WHERE pg_catalog.btrim(m,v_js_ws)<>''),ARRAY[]::text[]) INTO v_methods
        FROM pg_catalog.unnest(pg_catalog.regexp_split_to_array(v_menu.methods,'[,|]')) AS m;
      IF pg_catalog.cardinality(v_methods)=0 THEN v_methods:=ARRAY['GET']::text[]; END IF;
      FOREACH v_method IN ARRAY v_methods LOOP
        v_route:=pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.btrim(v_menu.api_url,v_js_ws),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'['||v_js_ws||']+','','g');
        v_route:=pg_catalog.regexp_replace(v_route,'^/supplierapi/?','');
        v_route:=pg_catalog.regexp_replace(v_route,'^/+','');
        v_route:=pg_catalog.regexp_replace(v_route,'/+$','');
        v_verb:=pg_catalog.upper(v_method);
        v_numeric_manage:=false;
        IF v_route='product/product/copy' OR pg_catalog.starts_with(v_route,'product/product/copy/')
          OR v_route='product/product/copy_operations' OR pg_catalog.starts_with(v_route,'product/product/copy_operations/') THEN
          v_numeric_manage:=v_verb='POST' AND v_route ~ ('^product/product/copy/'||v_ident||'$');
        ELSIF v_route='product/type_header' OR pg_catalog.starts_with(v_route,'product/type_header/')
          OR v_route='product/product/thorough' OR pg_catalog.starts_with(v_route,'product/product/thorough/') THEN
          v_numeric_manage:=v_verb='DELETE' AND v_route ~ ('^product/product/thorough/'||v_ident||'$');
        ELSIF v_route='product/product/get_rule' OR pg_catalog.starts_with(v_route,'product/product/get_rule/')
          OR v_route='product/product/rule' OR pg_catalog.starts_with(v_route,'product/product/rule/') THEN
          v_numeric_manage:=(v_verb='POST' AND v_route ~ ('^product/product/rule/(0|'||v_ident||')$'))
            OR (v_verb='DELETE' AND v_route ~ ('^product/product/rule/delete/'||v_ident||'$'));
        ELSIF v_route='product/all_label' OR v_route='product/label' OR pg_catalog.starts_with(v_route,'product/label/') THEN
          v_numeric_manage:=(v_verb='POST' AND (v_route='product/label/0' OR v_route ~ ('^product/label/'||v_ident||'$')))
            OR (v_verb='DELETE' AND v_route ~ ('^product/label/'||v_ident||'$'));
        ELSIF v_route='product/batch_process' OR pg_catalog.starts_with(v_route,'product/batch_process/')
          OR v_route='product/product/batch-selection' OR pg_catalog.starts_with(v_route,'product/product/batch-selection/') THEN
          v_numeric_manage:=v_verb='POST' AND v_route='product/batch_process';
        ELSIF v_route='product/category' OR pg_catalog.starts_with(v_route,'product/category/') THEN
          v_numeric_manage:=(v_verb='POST' AND v_route='product/category')
            OR (v_verb IN('PUT','DELETE') AND v_route ~ ('^product/category/'||v_ident||'$'))
            OR (v_verb='PUT' AND v_route ~ ('^product/category/set_show/'||v_ident||'/(0|1|:is_show|<is_show>)$'));
        ELSE
          v_numeric_manage:=(pg_catalog.starts_with(v_route,'product/') OR pg_catalog.starts_with(v_route,'form/'))
            AND v_verb NOT IN('GET','HEAD');
        END IF;
        IF v_numeric_manage THEN v_manage:=true; END IF;
      END LOOP;
    END IF;
  END LOOP;
END IF;
IF NOT v_manage THEN RAISE EXCEPTION '暂时没有权限访问' USING ERRCODE='P2104'; END IF;
v_authority_now:=pg_catalog.jsonb_build_object('admin',pg_catalog.to_jsonb(v_admin),'supplier',pg_catalog.to_jsonb(v_supplier),'roles',v_auth_roles,'menus',v_auth_menus);
IF v_phase=1 THEN v_authority_before:=v_authority_now;
ELSIF v_authority_before IS DISTINCT FROM v_authority_now THEN
  RAISE EXCEPTION '供应商权限事实在事务内变化' USING ERRCODE='P2106';
END IF;
`;

/** The only callable capability. No table/SQL/type/realm/explicit create ID can
 * be selected by its caller. All SQL names, defaults and audit values are fixed. */
export function supplierProductLabelCapabilityBody(appRole: string): string {
  pricingIdentifier(appRole);
  return String.raw`
DECLARE
v_admin public.system_admin%ROWTYPE;
v_supplier public.system_supplier%ROWTYPE;
v_role record; v_menu record; v_method text; v_token text;
v_role_ids integer[]:=ARRAY[]::integer[];
v_all_menu_ids integer[]:=ARRAY[]::integer[];
v_active_tokens text[]:=ARRAY[]::text[];
v_active_menu_ids integer[]:=ARRAY[]::integer[];
v_tokens text[]; v_methods text[];
v_manage boolean:=false;
v_js_ws text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_phase integer; v_route text; v_verb text; v_numeric_manage boolean;
  v_ident text:='([1-9][0-9]{0,9}|:id|<id>)';
  v_auth_roles jsonb; v_auth_menus jsonb; v_authority_now jsonb; v_authority_before jsonb;
  v_supplier_id integer; v_actor_id integer; v_target integer; v_group_id integer;
  v_name text; v_now integer; v_changed integer;
  v_before public.store_product_label%ROWTYPE;
  v_group public.category%ROWTYPE;
  v_group_before jsonb;
  v_actual jsonb; v_wanted jsonb; v_read jsonb;
  v_audit jsonb; v_audit_wanted jsonb; v_audit_id integer;
  v_audit_action text; v_audit_method text;
  v_linked boolean;
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(${SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE[0]},${SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE[1]}) THEN
    RAISE EXCEPTION '供应商商品标签能力正在维护' USING ERRCODE='P2103';
  END IF;
  IF session_user<>'${appRole}'
    OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
    OR pg_catalog.current_setting('transaction_read_only')<>'off'
    OR pg_catalog.current_setting('session_replication_role')<>'origin'
    OR pg_catalog.current_setting('server_version_num')::integer/10000<>16 THEN
    RAISE EXCEPTION 'Supplier label capability requires the reviewed App LOGIN and origin transaction' USING ERRCODE='P2104';
  END IF;
  IF p_context IS NULL OR pg_catalog.jsonb_typeof(p_context)<>'object' THEN
    RAISE EXCEPTION '供应商标签身份格式错误' USING ERRCODE='P2104';
  END IF;
  IF NOT(p_context ?& ARRAY['actor_id','supplier_id','auth_version','expires_at'])
    OR (SELECT count(*)<>4 FROM pg_catalog.jsonb_object_keys(p_context)) THEN
    RAISE EXCEPTION '供应商标签身份格式错误' USING ERRCODE='P2104';
  END IF;
  IF (SELECT bool_or(pg_catalog.jsonb_typeof(p_context->key)<>'number'
       OR (p_context->>key)!~'^[1-9][0-9]{0,9}$')
      FROM pg_catalog.unnest(ARRAY['actor_id','supplier_id']) AS key) THEN
    RAISE EXCEPTION '供应商标签身份格式错误' USING ERRCODE='P2104';
  END IF;
  IF pg_catalog.jsonb_typeof(p_context->'expires_at')<>'number' OR (p_context->>'expires_at')!~'^-?(0|[1-9][0-9]{0,15})$' THEN
  RAISE EXCEPTION '供应商会话期限格式错误' USING ERRCODE='P2104';
END IF;
IF pg_catalog.abs((p_context->>'expires_at')::numeric)>9007199254740991 THEN
  RAISE EXCEPTION '供应商会话期限格式错误' USING ERRCODE='P2104';
END IF;
IF (p_context->>'actor_id')::numeric>2147483647 OR (p_context->>'supplier_id')::numeric>2147483647 THEN
    RAISE EXCEPTION '供应商标签身份格式错误' USING ERRCODE='P2104';
  END IF;
  v_actor_id:=(p_context->>'actor_id')::integer; v_supplier_id:=(p_context->>'supplier_id')::integer;
  IF p_operation IS NULL OR p_operation NOT IN('create','update','delete') OR p_id IS NULL
    OR (p_operation='create' AND (p_id<>0 OR (p_expected IS NOT NULL AND p_expected<>'null'::jsonb)))
    OR (p_operation<>'create' AND (p_id<1 OR p_expected IS NULL OR pg_catalog.jsonb_typeof(p_expected)<>'object')) THEN
    RAISE EXCEPTION '商品标签操作格式错误' USING ERRCODE='P2101';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload)<>'object' THEN
    RAISE EXCEPTION '商品标签字段错误' USING ERRCODE='P2101';
  END IF;
  IF p_operation='delete' THEN
    IF p_payload<>'{}'::jsonb THEN RAISE EXCEPTION '商品标签删除字段错误' USING ERRCODE='P2101'; END IF;
  ELSE
    IF NOT(p_payload ?& ARRAY['label_cate','label_name'])
      OR (SELECT count(*)<>2 FROM pg_catalog.jsonb_object_keys(p_payload)) THEN
      RAISE EXCEPTION '商品标签字段错误' USING ERRCODE='P2101';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'label_cate')<>'number'
      OR (p_payload->>'label_cate')!~'^[1-9][0-9]{0,9}$'
      OR pg_catalog.jsonb_typeof(p_payload->'label_name')<>'string' THEN
      RAISE EXCEPTION '商品标签字段格式错误' USING ERRCODE='P2101';
    END IF;
    IF (p_payload->>'label_cate')::numeric>2147483647 THEN RAISE EXCEPTION '商品标签分类错误' USING ERRCODE='P2101'; END IF;
    v_group_id:=(p_payload->>'label_cate')::integer; v_name:=p_payload->>'label_name';
    IF pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 20
      OR v_name IS DISTINCT FROM pg_catalog.btrim(v_name,v_js_ws)
      OR v_name ~ U&'[\0001-\001F\007F]' THEN
      RAISE EXCEPTION '请输入1至20个字的标签名称' USING ERRCODE='P2101';
    END IF;
  END IF;
  -- Match the mature owner serialization: credentials are checked after a wait.
  PERFORM pg_catalog.pg_advisory_xact_lock(731737,v_supplier_id);
  FOR v_phase IN 1..2 LOOP
${authoritySql}
    IF v_phase=2 THEN EXIT; END IF;
    IF p_operation<>'create' THEN
      SELECT * INTO v_before FROM public.store_product_label
        WHERE id=p_id AND type=2 AND relation_id=v_supplier_id FOR UPDATE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION '商品标签不存在或不属于当前供应商' USING ERRCODE='P2102'; END IF;
      IF pg_catalog.to_jsonb(v_before) IS DISTINCT FROM p_expected THEN
        RAISE EXCEPTION '商品标签或权限已变化，请刷新后重试' USING ERRCODE='P2103';
      END IF;
    END IF;
    IF p_operation<>'delete' THEN
      IF p_operation='create' AND (SELECT count(*) FROM public.store_product_label WHERE type=2 AND relation_id=v_supplier_id)>=2000 THEN
        RAISE EXCEPTION '商品标签已达2000项，请先整理' USING ERRCODE='P2101';
      END IF;
      SELECT * INTO v_group FROM public.category WHERE id=v_group_id AND "group"=2 AND owner_id=0
        AND ((type=0 AND relation_id=0) OR(type=2 AND relation_id=v_supplier_id)) FOR SHARE NOWAIT;
      IF NOT FOUND THEN RAISE EXCEPTION '标签组不存在或不属于平台及当前供应商' USING ERRCODE='P2101'; END IF;
      v_group_before:=pg_catalog.to_jsonb(v_group);
      IF EXISTS(SELECT 1 FROM public.store_product_label WHERE type=2 AND relation_id=v_supplier_id
          AND label_cate=v_group_id AND label_name=v_name AND id<>p_id) THEN
        RAISE EXCEPTION '标签已经存在' USING ERRCODE='P2101';
      END IF;
    ELSE
      SELECT EXISTS(SELECT 1 FROM public.store_product_relation WHERE type=3 AND relation_id=p_id)
        OR EXISTS(SELECT 1 FROM public.store_product_label_auxiliary WHERE label_id=p_id)
        OR EXISTS(SELECT 1 FROM public.store_product p WHERE p.is_del=0 AND btrim(coalesce(p.store_label_id,''))<>''
          AND EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(coalesce(p.store_label_id,''),',')) AS token(value)
            WHERE btrim(token.value)<>'' AND CASE WHEN btrim(token.value) ~ '^[+-]?[0-9]+$'
              THEN ltrim(btrim(token.value),'+0')=p_id::text ELSE true END)) INTO v_linked;
      IF v_linked IS DISTINCT FROM false THEN RAISE EXCEPTION '标签仍被商品或历史辅助引用使用，不能删除' USING ERRCODE='P2101'; END IF;
    END IF;
    v_now:=pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp()))::integer;
    IF p_operation='create' THEN
      INSERT INTO public.store_product_label AS l(type,relation_id,label_cate,label_name,style_type,color,bg_color,border_color,icon,is_show,status,sort,add_time)
        VALUES(2,v_supplier_id,v_group_id,v_name,1,'','','','',1,1,0,v_now) RETURNING pg_catalog.to_jsonb(l) INTO v_actual;
      GET DIAGNOSTICS v_changed=ROW_COUNT;
      IF v_changed<>1 OR v_actual IS NULL OR (v_actual->>'id')!~'^[1-9][0-9]{0,9}$' THEN
        RAISE EXCEPTION '商品标签新增完整回执不一致' USING ERRCODE='P2106';
      END IF;
      v_target:=(v_actual->>'id')::integer;
      v_wanted:=pg_catalog.jsonb_build_object('id',v_target,'type',2,'relation_id',v_supplier_id,'label_cate',v_group_id,'label_name',v_name,
        'style_type',1,'color','','bg_color','','border_color','','icon','','is_show',1,'status',1,'sort',0,'add_time',v_now);
    ELSIF p_operation='update' THEN
      UPDATE public.store_product_label AS l SET label_cate=v_group_id,label_name=v_name
        WHERE id=p_id AND type=2 AND relation_id=v_supplier_id RETURNING pg_catalog.to_jsonb(l) INTO v_actual;
      GET DIAGNOSTICS v_changed=ROW_COUNT; v_target:=p_id;
      v_wanted:=pg_catalog.to_jsonb(v_before)||pg_catalog.jsonb_build_object('label_cate',v_group_id,'label_name',v_name);
    ELSE
      DELETE FROM public.store_product_label AS l WHERE id=p_id AND type=2 AND relation_id=v_supplier_id
        RETURNING pg_catalog.to_jsonb(l) INTO v_actual;
      GET DIAGNOSTICS v_changed=ROW_COUNT; v_target:=p_id; v_wanted:=pg_catalog.to_jsonb(v_before);
    END IF;
    IF v_changed<>1 OR v_actual IS DISTINCT FROM v_wanted THEN
      RAISE EXCEPTION '商品标签完整写入回执不一致' USING ERRCODE='P2106';
    END IF;
    v_audit_action:='{"operation":"'||p_operation||'","ids":['||v_target::text||']}';
    v_audit_method:=CASE WHEN p_operation='delete' THEN 'DELETE' ELSE 'POST' END;
    v_audit_wanted:=pg_catalog.jsonb_build_object('store_id',0,'merchant_id',v_supplier_id,'admin_id',v_actor_id,'admin_name','','ip','',
      'path','product/label/'||v_target::text,'page','供应商商品标签管理','method',v_audit_method,
      'action',v_audit_action,'type','supplier_product_label','add_time',v_now);
    INSERT INTO public.system_log AS a(store_id,merchant_id,admin_id,admin_name,ip,path,page,method,action,type,add_time)
      VALUES(0,v_supplier_id,v_actor_id,'','','product/label/'||v_target::text,'供应商商品标签管理',v_audit_method,v_audit_action,'supplier_product_label',v_now)
      RETURNING pg_catalog.to_jsonb(a) INTO v_audit;
    GET DIAGNOSTICS v_changed=ROW_COUNT;
    IF v_changed<>1 OR v_audit IS NULL OR (v_audit->>'id')!~'^[1-9][0-9]{0,9}$' THEN
      RAISE EXCEPTION '商品标签审计回执不完整' USING ERRCODE='P2106';
    END IF;
    v_audit_id:=(v_audit->>'id')::integer;
    v_audit_wanted:=v_audit_wanted||pg_catalog.jsonb_build_object('id',v_audit_id);
    IF v_audit IS DISTINCT FROM v_audit_wanted THEN RAISE EXCEPTION '商品标签审计完整回执不一致' USING ERRCODE='P2106'; END IF;
    SET CONSTRAINTS ALL IMMEDIATE;
    SELECT pg_catalog.to_jsonb(a) INTO v_read FROM public.system_log a WHERE id=v_audit_id;
    IF v_read IS DISTINCT FROM v_audit_wanted THEN RAISE EXCEPTION '商品标签审计完整回读不一致' USING ERRCODE='P2106'; END IF;
    IF p_operation='delete' THEN
      IF EXISTS(SELECT 1 FROM public.store_product_label WHERE id=v_target) THEN
        RAISE EXCEPTION '商品标签删除后仍存在' USING ERRCODE='P2106';
      END IF;
      SELECT EXISTS(SELECT 1 FROM public.store_product_relation WHERE type=3 AND relation_id=v_target)
        OR EXISTS(SELECT 1 FROM public.store_product_label_auxiliary WHERE label_id=v_target)
        OR EXISTS(SELECT 1 FROM public.store_product p WHERE p.is_del=0 AND btrim(coalesce(p.store_label_id,''))<>''
          AND EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(coalesce(p.store_label_id,''),',')) AS token(value)
            WHERE btrim(token.value)<>'' AND CASE WHEN btrim(token.value) ~ '^[+-]?[0-9]+$'
              THEN ltrim(btrim(token.value),'+0')=v_target::text ELSE true END)) INTO v_linked;
      IF v_linked IS DISTINCT FROM false THEN RAISE EXCEPTION '标签仍被商品或历史辅助引用使用，不能删除' USING ERRCODE='P2101'; END IF;
    ELSE
      SELECT pg_catalog.to_jsonb(l) INTO v_read FROM public.store_product_label l WHERE id=v_target AND type=2 AND relation_id=v_supplier_id;
      IF v_read IS DISTINCT FROM v_wanted THEN RAISE EXCEPTION '商品标签提交前完整事实已变化' USING ERRCODE='P2106'; END IF;
      SELECT pg_catalog.to_jsonb(g) INTO v_read FROM public.category g WHERE id=v_group_id;
      IF v_read IS DISTINCT FROM v_group_before THEN RAISE EXCEPTION '商品标签提交前分组事实已变化' USING ERRCODE='P2106'; END IF;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('row',v_wanted,'audit_id',v_audit_id);
END
`;
}

const fullReads = ['store_product_label','category','system_admin','system_supplier','system_role','system_menus','system_log'] as const;
const columnRights: Record<string, Partial<Record<'SELECT'|'INSERT'|'UPDATE', readonly string[]>>> = {
  store_product_label: { INSERT: ['type','relation_id','label_cate','label_name','style_type','color','bg_color','border_color','icon','is_show','status','sort','add_time'], UPDATE: ['label_cate','label_name'] },
  system_log: { INSERT: ['store_id','merchant_id','admin_id','admin_name','ip','path','page','method','action','type','add_time'] },
  category: { UPDATE: ['id'] }, system_admin: { UPDATE: ['id'] }, system_supplier: { UPDATE: ['id'] },
  system_role: { UPDATE: ['id'] }, system_menus: { UPDATE: ['id'] },
  store_product: { SELECT: ['is_del','store_label_id'] },
  store_product_relation: { SELECT: ['type','relation_id'] },
  store_product_label_auxiliary: { SELECT: ['label_id'] },
};
export const SUPPLIER_PRODUCT_LABEL_CAPABILITY_TABLES = [...new Set([...fullReads,...Object.keys(columnRights)])] as readonly string[];
const sequences = ['store_product_label_id_seq','system_log_id_seq'] as const;

/** Grants belong only to the dedicated NOLOGIN function owner. The App receives
 * none of these table, column or sequence privileges. */
export function supplierProductLabelOwnerGrantSql(owner: string): string[] {
  const name = pricingIdentifier(owner);
  const statements = [
    `GRANT SELECT ON ${fullReads.map(t=>`public.${pricingIdentifier(t)}`).join(',')} TO ${name}`,
    `GRANT DELETE ON public.store_product_label TO ${name}`,
  ];
  for (const [table, rights] of Object.entries(columnRights))
    for (const [privilege, columns] of Object.entries(rights)) {
      if (!columns) throw Error('Supplier label fixed owner grant is incomplete');
      statements.push(`GRANT ${privilege}(${columns.map(pricingIdentifier).join(',')}) ON public.${pricingIdentifier(table)} TO ${name}`);
    }
  statements.push(`GRANT USAGE ON SEQUENCE ${sequences.map(t=>`public.${pricingIdentifier(t)}`).join(',')} TO ${name}`);
  return statements;
}

/** Effective and direct privileges are checked over every ordinary user
 * namespace, including column grants. A precreated owner is either empty, or
 * has precisely this installed capability; no repair or inherited escape. */
export async function inspectSupplierProductLabelOwner(db: Query, owner: string, installed: boolean): Promise<boolean> {
  pricingIdentifier(owner);
  const tables = installed ? [...fullReads.map(name=>({name,privilege:'SELECT'})),{name:'store_product_label',privilege:'DELETE'}] : [];
  const columns = installed ? Object.entries(columnRights).flatMap(([name,rights])=>Object.entries(rights)
    .flatMap(([privilege,names])=>(names??[]).map(column=>({name,column,privilege})))) : [];
  const [row] = await db.execute(sql`
    WITH owner AS(SELECT * FROM pg_catalog.pg_roles WHERE rolname=${owner}),
    wanted_tables AS(SELECT * FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(tables)}::jsonb) AS t(name text,privilege text)),
    wanted_columns AS(SELECT * FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(columns)}::jsonb) AS t(name text,"column" text,privilege text)),
    relations AS(SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')
    SELECT EXISTS(SELECT 1 FROM owner o WHERE NOT(o.rolcanlogin OR o.rolsuper OR o.rolcreatedb OR o.rolcreaterole OR o.rolinherit OR o.rolreplication OR o.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=o.oid OR roleid=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid=o.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=o.oid OR(nspname !~ '^pg_' AND pg_catalog.has_schema_privilege(o.oid,oid,'CREATE')))
      AND NOT pg_catalog.has_database_privilege(o.oid,current_database(),'CREATE')
      AND NOT pg_catalog.has_parameter_privilege(o.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND (${!installed} OR pg_catalog.has_schema_privilege(o.oid,'public','USAGE'))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.refclassid='pg_catalog.pg_authid'::regclass AND d.refobjid=o.oid AND d.deptype='o'
        AND NOT(${installed} AND d.classid='pg_catalog.pg_proc'::regclass AND d.objid IN(SELECT oid FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname=${SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION})))
      AND NOT EXISTS(SELECT 1 FROM relations c WHERE CASE WHEN c.relkind IN('r','p','v','m','f') THEN
        c.relowner=o.oid OR EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS requested(privilege)
          WHERE pg_catalog.has_table_privilege(o.oid,c.oid,requested.privilege) IS DISTINCT FROM EXISTS(
            SELECT 1 FROM wanted_tables w WHERE c.nspname='public' AND w.name=c.relname AND w.privilege=requested.privilege))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a CROSS JOIN pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS requested(privilege)
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND pg_catalog.has_column_privilege(o.oid,c.oid,a.attnum,requested.privilege) IS DISTINCT FROM
            (EXISTS(SELECT 1 FROM wanted_tables w WHERE c.nspname='public' AND w.name=c.relname AND w.privilege=requested.privilege)
             OR EXISTS(SELECT 1 FROM wanted_columns w WHERE c.nspname='public' AND w.name=c.relname AND w."column"=a.attname AND w.privilege=requested.privilege)))
        OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=o.oid
          AND(a.is_grantable OR NOT EXISTS(SELECT 1 FROM wanted_tables w WHERE c.nspname='public' AND w.name=c.relname AND w.privilege=a.privilege_type)))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
          WHERE att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped AND a.grantee=o.oid
            AND(a.is_grantable OR NOT EXISTS(SELECT 1 FROM wanted_columns w WHERE c.nspname='public' AND w.name=c.relname AND w."column"=att.attname AND w.privilege=a.privilege_type)))
        WHEN c.relkind='S' THEN c.relowner=o.oid
          OR pg_catalog.has_sequence_privilege(o.oid,c.oid,'USAGE') IS DISTINCT FROM (${installed} AND c.nspname='public' AND c.relname IN('store_product_label_id_seq','system_log_id_seq'))
          OR pg_catalog.has_sequence_privilege(o.oid,c.oid,'SELECT,UPDATE')
          OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('S',c.relowner))) a WHERE a.grantee=o.oid
             AND(a.is_grantable OR a.privilege_type<>'USAGE' OR NOT(${installed} AND c.nspname='public' AND c.relname IN('store_product_label_id_seq','system_log_id_seq'))))
        ELSE c.relowner=o.oid END)
      AND NOT EXISTS(SELECT 1 FROM wanted_tables w WHERE NOT EXISTS(SELECT 1 FROM relations c WHERE c.nspname='public' AND c.relname=w.name AND c.relkind='r'))
      AND NOT EXISTS(SELECT 1 FROM wanted_columns w WHERE NOT EXISTS(SELECT 1 FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
          WHERE c.nspname='public' AND c.relname=w.name AND a.attname=w."column" AND a.attnum>0 AND NOT a.attisdropped))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        AND (p.proowner=o.oid OR(p.prosecdef AND pg_catalog.has_function_privilege(o.oid,p.oid,'EXECUTE')) OR pg_catalog.has_function_privilege(o.oid,p.oid,'EXECUTE WITH GRANT OPTION'))
        AND NOT(${installed} AND n.nspname='public' AND p.proname=${SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION} AND p.proowner=o.oid))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=o.oid OR EXISTS(
        SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=o.oid))) AS ready`);
  return row?.ready === true;
}

type ColumnShape = { table: string; name: string; type: string; nullable: boolean; modifier: number };
const column = (table:string,name:string,type:string,nullable=false,modifier=-1):ColumnShape=>({table,name,type,nullable,modifier});
const shapes: ColumnShape[] = [
  ...['id','relation_id','label_cate','sort','add_time'].map(n=>column('store_product_label',n,'int4')),
  ...['type','style_type','is_show','status'].map(n=>column('store_product_label',n,'int2')),
  ...['label_name','icon'].map(n=>column('store_product_label',n,'varchar',false,259)),
  ...['color','bg_color','border_color'].map(n=>column('store_product_label',n,'varchar',false,36)),
  ...['id','store_id','merchant_id','admin_id','add_time'].map(n=>column('system_log',n,'int4')),
  ...[['admin_name',68],['path',132],['page',68],['method',16],['action',259],['ip',49],['type',36]].map(([n,m])=>column('system_log',String(n),'varchar',false,Number(m))),
  ...['id','pid','relation_id','owner_id','sort','add_time','integral_min','integral_max'].map(n=>column('category',n,'int4')),
  ...['type','group','is_show'].map(n=>column('category',n,'int2')),column('category','name','varchar',false,259),column('category','other','text',true),
  ...['id','label_id','product_id'].map(n=>column('store_product_label_auxiliary',n,'int4')),
  ...['id','relation_id'].map(n=>column('system_admin',n,'int4')),
  ...['admin_type','status','is_del'].map(n=>column('system_admin',n,'int2')),
  column('system_admin','pwd','varchar',false,104),column('system_admin','roles','varchar',false,132),
  ...['id','admin_id'].map(n=>column('system_supplier',n,'int4')),...['is_show','is_del'].map(n=>column('system_supplier',n,'int2')),
  ...['id','relation_id'].map(n=>column('system_role',n,'int4')),...['type','level','status'].map(n=>column('system_role',n,'int2')),
  column('system_role','rules','text'),column('system_role','role_name','varchar',false,36),
  column('system_menus','id','int4'),...['type','auth_type','access','is_del'].map(n=>column('system_menus',n,'int2')),
  column('system_menus','methods','varchar',false,36),column('system_menus','api_url','varchar',false,259),
  column('store_product','is_del','int2'),column('store_product','store_label_id','text',true),
  column('store_product_relation','type','int4'),column('store_product_relation','relation_id','int4'),
];

export interface SupplierProductLabelCapabilityState {
  absent: boolean; ready: boolean; functionOid: string|null; ownerOid: string|null;
  appRole: string|null; ownerRole: string|null; maintenanceRole: string|null;
  definitionSafe: boolean; ownerSafe: boolean; aclSafe: boolean; tablesSafe: boolean; runtimeSafe: boolean;
}

/** Readonly and source-exact. On maintenance calls the optional target pins the
 * identities; a runtime call independently derives the sole EXECUTE grantee. */
export async function inspectSupplierProductLabelCapability(db: Query, target?: SupplierProductLabelCapabilityInspectionTarget): Promise<SupplierProductLabelCapabilityState> {
  if (target) Object.values(target).forEach(pricingIdentifier);
  const routines = await db.execute(sql`SELECT p.oid::text AS oid,p.prosrc,p.proconfig,p.prosecdef,p.provolatile,p.proparallel,p.prokind,
    p.prorettype='pg_catalog.jsonb'::regtype AS returns_json,p.pronargs=5 AND p.proargtypes='3802 25 23 3802 3802'::oidvector
      AND p.proargnames=ARRAY['p_context','p_operation','p_id','p_expected','p_payload']::text[] AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AS arguments_safe,
    l.lanname='plpgsql' AND l.lanpltrusted AS language_safe,
    NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL
      AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0 AND p.protrftypes IS NULL AS flags_safe,
    pg_catalog.pg_get_userbyid(p.proowner) AS owner,p.proowner::text AS owner_oid,
    ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND a.grantee<>0 ORDER BY a.grantee) AS callers
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE p.pronamespace='public'::regnamespace AND p.proname=${SUPPLIER_PRODUCT_LABEL_CAPABILITY_FUNCTION}`);
  const [base] = await db.execute(sql`SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner,current_database() AS database
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.store_product_label')`);
  const row = routines.length===1 ? routines[0] : undefined;
  const callers = Array.isArray(row?.callers) ? row.callers : [];
  const appRole = target?.app ?? (callers.length===1 && typeof callers[0]==='string' ? callers[0] : null);
  const ownerRole = target?.owner ?? (typeof row?.owner==='string' ? row.owner : null);
  const maintenanceRole = target?.maintenance ?? (typeof base?.owner==='string' ? base.owner : null);
  const state:SupplierProductLabelCapabilityState = {absent:routines.length===0,ready:false,functionOid:typeof row?.oid==='string'?row.oid:null,
    ownerOid:typeof row?.owner_oid==='string'?row.owner_oid:null,appRole,ownerRole,maintenanceRole,
    definitionSafe:false,ownerSafe:false,aclSafe:false,tablesSafe:false,runtimeSafe:false};
  if (!appRole || !ownerRole || !maintenanceRole || routines.length!==1) return state;
  [appRole,ownerRole,maintenanceRole].forEach(pricingIdentifier);
  if (new Set([appRole,ownerRole,maintenanceRole]).size!==3 || (target && (target.admin===appRole || target.admin===ownerRole || target.admin===maintenanceRole || (target.database!==undefined && target.database!==base?.database)))) return state;
  state.definitionSafe = row?.prosrc===supplierProductLabelCapabilityBody(appRole) && row?.prosecdef===true && row?.provolatile==='v'
    && row?.proparallel==='u' && row?.prokind==='f' && row?.returns_json===true && row?.arguments_safe===true
    && row?.language_safe===true && row?.flags_safe===true && row?.owner===ownerRole
    && JSON.stringify(row?.proconfig)===JSON.stringify(['search_path=pg_catalog, pg_temp']);
  const [catalog] = await db.execute(sql`
    WITH tables AS(SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relname IN(${sql.join(SUPPLIER_PRODUCT_LABEL_CAPABILITY_TABLES.map(t=>sql`${t}`),sql`, `)})),
    wanted AS(SELECT * FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(shapes)}::jsonb) AS s("table" text,name text,type text,nullable boolean,modifier integer))
    SELECT current_setting('server_version_num')::integer/10000=16
      AND (SELECT count(*)=${SUPPLIER_PRODUCT_LABEL_CAPABILITY_TABLES.length} AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT(c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity)
        AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenanceRole})
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)) FROM tables c)
      AND NOT EXISTS(SELECT 1 FROM wanted w LEFT JOIN tables c ON c.relname=w."table"
        LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=w.name AND a.attnum>0 AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
        WHERE a.attname IS NULL OR t.typnamespace<>'pg_catalog'::regnamespace OR t.typname<>w.type OR a.atttypmod<>w.modifier
          OR a.attnotnull=w.nullable OR a.attgenerated<>'' OR a.attidentity<>'')
      AND NOT EXISTS(SELECT 1 FROM tables c WHERE c.relname IN('store_product_label','system_log','category','store_product_label_auxiliary','system_role')
        AND(SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)
          <>(SELECT count(*) FROM wanted WHERE "table"=c.relname))
      AND (SELECT count(*)=3 AND bool_and(i.indisprimary AND i.indisunique AND i.indisvalid AND i.indisready
          AND i.indnatts=1 AND i.indnkeyatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indkey::text=a.attnum::text)
        FROM tables c JOIN pg_catalog.pg_index i ON i.indrelid=c.oid AND i.indisprimary
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='id'
        WHERE c.relname IN('store_product_label','system_log','store_product_label_auxiliary'))
      AND (SELECT count(*)=2 AND bool_and(c.relkind='S' AND c.relpersistence='p'
          AND c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${maintenanceRole})
          AND s.seqtypid='pg_catalog.int4'::regtype AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmin=1 AND s.seqmax=2147483647 AND s.seqcache=1 AND NOT s.seqcycle
          AND EXISTS(SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
            JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid AND a.attname='id'
            WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.refclassid=d.classid AND d.deptype='a'
              AND t.relnamespace='public'::regnamespace AND c.relname=t.relname||'_id_seq'
              AND pg_catalog.pg_get_serial_sequence('public.'||t.relname,'id')= 'public.'||c.relname
              AND EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef ad WHERE ad.adrelid=t.oid AND ad.adnum=a.attnum
                AND pg_catalog.pg_get_expr(ad.adbin,ad.adrelid)='nextval('||pg_catalog.quote_literal(('public.'||c.relname)::regclass::text)||'::regclass)')))
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN('store_product_label_id_seq','system_log_id_seq')) AS tables_safe,
      (SELECT count(*)=2 AND bool_and(a.privilege_type='EXECUTE' AND NOT a.is_grantable AND a.grantee IN(
          SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(${appRole},${ownerRole})))
        AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${appRole}))
        AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${ownerRole}))
        FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        WHERE p.oid=${state.functionOid}::oid) AS acl_safe,
      EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE rolname=${appRole} AND r.rolcanlogin
        AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
        AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND pg_catalog.has_schema_privilege(r.oid,oid,'CREATE'))
        AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
        AND pg_catalog.has_table_privilege(r.oid,'public.store_product_label','SELECT')
        AND pg_catalog.has_column_privilege(r.oid,'public.store_product_label','id','UPDATE')
        AND NOT pg_catalog.has_table_privilege(r.oid,'public.store_product_label','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT pg_catalog.has_any_column_privilege(r.oid,'public.store_product_label','INSERT,REFERENCES')
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.store_product_label'::regclass
          AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'id' AND pg_catalog.has_column_privilege(r.oid,a.attrelid,a.attnum,'UPDATE'))
        AND NOT pg_catalog.has_table_privilege(r.oid,'public.store_product_label_auxiliary','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT pg_catalog.has_any_column_privilege(r.oid,'public.store_product_label_auxiliary','SELECT,INSERT,UPDATE,REFERENCES')
        AND NOT pg_catalog.has_sequence_privilege(r.oid,'public.store_product_label_id_seq','USAGE,SELECT,UPDATE')) AS runtime_safe`);
  state.tablesSafe=catalog?.tables_safe===true;
  state.aclSafe=catalog?.acl_safe===true;
  state.runtimeSafe=catalog?.runtime_safe===true;
  state.ownerSafe=await inspectSupplierProductLabelOwner(db,ownerRole,true);
  state.ready=state.definitionSafe && state.tablesSafe && state.aclSafe && state.runtimeSafe && state.ownerSafe;
  return state;
}

/** Runtime is inspection-only. An absent/partial/changed capability is never
 * installed or repaired by a Supplier request. */
export async function assertSupplierProductLabelCapabilityReady(db: Query): Promise<void> {
  try {
    const [gate] = await db.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock_shared(${SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE[0]},${SUPPLIER_PRODUCT_LABEL_CAPABILITY_GATE[1]}) AS locked`);
    if (gate?.locked!==true) throw Error('Supplier label capability maintenance is busy');
    const state=await inspectSupplierProductLabelCapability(db);
    const [identity]=await db.execute(sql`SELECT current_user=session_user AND current_user=${state.appRole} AND current_setting('session_replication_role')='origin' AS ready`);
    if (!state.ready || identity?.ready!==true) throw Error(`Supplier label capability absent or drifted: ${JSON.stringify(state)}`);
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('供应商商品标签受控写入能力尚未就绪'),{cause});
  }
}
