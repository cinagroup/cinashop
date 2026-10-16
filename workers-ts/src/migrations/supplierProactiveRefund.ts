import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

/** Explicit, independent PG16 maintenance. No historical bootstrap, ORM,
 * request handler or startup path installs these four financial evidence tables. */
export const SUPPLIER_PROACTIVE_REFUND_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Supplier proactive refund evidence is immutable' USING ERRCODE='42501';
END`;
export const SUPPLIER_PROACTIVE_REFUND_PAYMENT_GUARD_BODY = `BEGIN
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Supplier refund money payment cannot be removed' USING ERRCODE='42501';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['provider_status','provider_refund_id','last_error','attempts','request_lease_until','next_retry_at','last_queried_at','query_count','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['provider_status','provider_refund_id','last_error','attempts','request_lease_until','next_retry_at','last_queried_at','query_count','updated_at'])
    OR NEW.updated_at<OLD.updated_at OR NEW.attempts<OLD.attempts OR NEW.query_count<OLD.query_count
    OR (OLD.last_queried_at IS NOT NULL AND (NEW.last_queried_at IS NULL OR NEW.last_queried_at<OLD.last_queried_at))
    OR (OLD.provider_status='SUCCESS' AND NEW.provider_status<>'SUCCESS')
    OR (OLD.provider_refund_id<>'' AND NEW.provider_refund_id<>OLD.provider_refund_id) THEN
    RAISE EXCEPTION 'Supplier refund money payment identity or progress changed' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;

export const SUPPLIER_PROACTIVE_REFUND_SQL = `CREATE TABLE public.supplier_proactive_refund_operation_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  state text NOT NULL,
  kind text,
  request_hash text NOT NULL,
  intent jsonb,
  intent_json text,
  source jsonb,
  source_json text,
  source_hash text NOT NULL,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT spro_pk PRIMARY KEY (operation_id),
  CONSTRAINT spro_identity_ck CHECK (actor_id>0 AND supplier_id>0 AND order_id>0 AND created_at>0),
  CONSTRAINT spro_uuid_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT spro_state_ck CHECK (((state='not_applied' AND kind IS NULL AND request_hash='' AND source_hash=''
      AND intent IS NULL AND intent_json IS NULL AND source IS NULL AND source_json IS NULL AND result IS NULL)
    OR (state='committed' AND kind IN ('goods','money','refuse')
      AND request_hash ~ '^[0-9a-f]{64}$' AND source_hash ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(intent)='object' AND octet_length(intent::text)<=16384
      AND octet_length(intent_json)>0 AND octet_length(intent_json)<=16384 AND intent_json::jsonb=intent
      AND intent->>'version'='supplier-proactive-refund-intent-v1'
      AND intent->>'operation_id'=operation_id::text AND intent->'actor_id'=to_jsonb(actor_id)
      AND intent->'supplier_id'=to_jsonb(supplier_id) AND intent->'order_id'=to_jsonb(order_id)
      AND ((kind='refuse' AND intent->'type'='2'::jsonb) OR (kind IN ('goods','money') AND intent->'type'='1'::jsonb))
      AND jsonb_typeof(source)='object' AND octet_length(source::text)<=16777216
      AND octet_length(source_json)>0 AND octet_length(source_json)<=16777216 AND source_json::jsonb=source
      AND jsonb_typeof(result)='object' AND octet_length(result::text)<=65536)) IS TRUE)
);
CREATE INDEX spro_order ON public.supplier_proactive_refund_operation_v1 USING btree (order_id,created_at,operation_id);
CREATE TABLE public.supplier_proactive_refund_decision_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  kind text NOT NULL,
  outcome text NOT NULL,
  request_hash text NOT NULL,
  evidence jsonb NOT NULL,
  evidence_json text NOT NULL,
  evidence_hash text NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT sprd_pk PRIMARY KEY (operation_id),
  CONSTRAINT sprd_operation_fk FOREIGN KEY (operation_id) REFERENCES public.supplier_proactive_refund_operation_v1(operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT sprd_identity_ck CHECK (actor_id>0 AND supplier_id>0 AND order_id>0 AND created_at>0
    AND request_hash ~ '^[0-9a-f]{64}$' AND evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sprd_kind_ck CHECK ((kind='refuse' AND outcome='refused')
    OR (kind IN ('goods','money') AND outcome IN ('local-settled','provider-admitted'))),
  CONSTRAINT sprd_payload_ck CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16777216
    AND octet_length(evidence_json)>0 AND octet_length(evidence_json)<=16777216 AND evidence_json::jsonb=evidence)
);
CREATE TABLE public.supplier_refund_money_payment_v1 (
  id integer GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.supplier_refund_money_payment_v1_id_seq) NOT NULL,
  operation_id uuid NOT NULL,
  order_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  provider text NOT NULL,
  out_refund_no text NOT NULL,
  transaction_id text NOT NULL,
  request_amount integer NOT NULL,
  total_amount integer NOT NULL,
  provider_status text NOT NULL,
  provider_refund_id text DEFAULT '' NOT NULL,
  last_error text DEFAULT '' NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  request_lease_until integer,
  next_retry_at integer DEFAULT 0 NOT NULL,
  last_queried_at integer,
  query_count integer DEFAULT 0 NOT NULL,
  request jsonb NOT NULL,
  request_json text NOT NULL,
  request_hash text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  CONSTRAINT srmp_pk PRIMARY KEY (id),
  CONSTRAINT srmp_operation_uq UNIQUE (operation_id),
  CONSTRAINT srmp_out_refund_no_uq UNIQUE (out_refund_no),
  CONSTRAINT srmp_operation_fk FOREIGN KEY (operation_id) REFERENCES public.supplier_proactive_refund_operation_v1(operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT srmp_identity_ck CHECK (id>0 AND order_id>0 AND payment_order_id>0 AND created_at>0 AND updated_at>=created_at
    AND request_amount>0 AND total_amount>=request_amount),
  CONSTRAINT srmp_provider_ck CHECK (provider IN ('wechat','alipay') AND octet_length(out_refund_no)>0
    AND octet_length(out_refund_no)<=64 AND octet_length(transaction_id)<=100 AND octet_length(provider_refund_id)<=100),
  CONSTRAINT srmp_progress_ck CHECK (provider_status IN ('INIT','REQUESTING','PROCESSING','SUCCESS','CLOSED','ABNORMAL','UNKNOWN')
    AND octet_length(last_error)<=4096 AND attempts>=0 AND query_count>=0 AND next_retry_at>=0
    AND (request_lease_until IS NULL OR request_lease_until>0) AND (last_queried_at IS NULL OR last_queried_at>0)),
  CONSTRAINT srmp_payload_ck CHECK (request_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(request)='object'
    AND octet_length(request::text)<=65536 AND octet_length(request_json)>0 AND octet_length(request_json)<=65536
    AND request_json::jsonb=request)
);
CREATE INDEX srmp_retry ON public.supplier_refund_money_payment_v1 USING btree (provider_status,next_retry_at,id);
CREATE TABLE public.supplier_refund_money_completion_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  order_id integer NOT NULL,
  first_refund_id integer NOT NULL,
  payment_order_id integer NOT NULL,
  amount numeric(12,2) NOT NULL,
  pay_type text NOT NULL,
  source_hash text NOT NULL,
  request_hash text NOT NULL,
  before_refunded numeric(12,2) NOT NULL,
  after_refunded numeric(12,2) NOT NULL,
  proof jsonb NOT NULL,
  proof_json text NOT NULL,
  proof_hash text NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT srmc_pk PRIMARY KEY (operation_id),
  CONSTRAINT srmc_operation_fk FOREIGN KEY (operation_id) REFERENCES public.supplier_proactive_refund_operation_v1(operation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT srmc_identity_ck CHECK (actor_id>0 AND supplier_id>0 AND order_id>0 AND first_refund_id>0 AND payment_order_id>0 AND created_at>0
    AND pay_type IN ('cash','offline','yue','weixin','alipay') AND source_hash ~ '^[0-9a-f]{64}$'
    AND request_hash ~ '^[0-9a-f]{64}$' AND proof_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT srmc_money_ck CHECK (amount>0 AND amount<=9999999999.99 AND before_refunded>=0
    AND before_refunded<=9999999999.99 AND after_refunded<=9999999999.99 AND after_refunded=before_refunded+amount),
  CONSTRAINT srmc_payload_ck CHECK (jsonb_typeof(proof)='object' AND octet_length(proof::text)<=16777216
    AND octet_length(proof_json)>0 AND octet_length(proof_json)<=16777216 AND proof_json::jsonb=proof)
);
CREATE INDEX srmc_order ON public.supplier_refund_money_completion_v1 USING btree (order_id,created_at,operation_id);
CREATE FUNCTION public.supplier_proactive_refund_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $spr_immutable$${SUPPLIER_PROACTIVE_REFUND_IMMUTABLE_BODY}$spr_immutable$;
CREATE FUNCTION public.supplier_refund_money_payment_guard_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $srmp_guard$${SUPPLIER_PROACTIVE_REFUND_PAYMENT_GUARD_BODY}$srmp_guard$;
REVOKE ALL ON FUNCTION public.supplier_proactive_refund_immutable_v1(),public.supplier_refund_money_payment_guard_v1() FROM PUBLIC;
CREATE TRIGGER spro_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_proactive_refund_operation_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER spro_immutable_truncate BEFORE TRUNCATE ON public.supplier_proactive_refund_operation_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER sprd_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_proactive_refund_decision_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER sprd_immutable_truncate BEFORE TRUNCATE ON public.supplier_proactive_refund_decision_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER srmp_guard_rows BEFORE UPDATE OR DELETE ON public.supplier_refund_money_payment_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_refund_money_payment_guard_v1();
CREATE TRIGGER srmp_guard_truncate BEFORE TRUNCATE ON public.supplier_refund_money_payment_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_refund_money_payment_guard_v1();
CREATE TRIGGER srmc_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_refund_money_completion_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
CREATE TRIGGER srmc_immutable_truncate BEFORE TRUNCATE ON public.supplier_refund_money_completion_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_proactive_refund_immutable_v1();
REVOKE ALL ON TABLE public.supplier_proactive_refund_operation_v1,public.supplier_proactive_refund_decision_v1,
public.supplier_refund_money_payment_v1,public.supplier_refund_money_completion_v1 FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.supplier_refund_money_payment_v1_id_seq FROM PUBLIC;
`;

// Requires independent, actual PG16 catalog calibration before release. Never
// substitute a source hash or an assumed pg_get_constraintdef representation.
export const SUPPLIER_PROACTIVE_REFUND_CONSTRAINTS_SHA256 = 'dc8c72d19fa9e639cb946906045d090aa9fd2b0537937053b9c07c396d2a8d34';
const paymentColumns = ['provider_status','provider_refund_id','last_error','attempts','request_lease_until',
  'next_retry_at','last_queried_at','query_count','updated_at'] as const;
type Column = readonly [name: string, type: string, nullable?: boolean, defaultValue?: string, identity?: string];
interface TableSpec {
  name: string; prefix: string; columns: readonly Column[]; constraints: number; checks: number;
  indexes: readonly (readonly [name: string, keys: readonly string[], unique: boolean, primary: boolean])[];
}
const tables: readonly TableSpec[] = [
  { name:'supplier_proactive_refund_operation_v1',prefix:'spro',constraints:4,checks:3,
    columns:[['operation_id','uuid'],['actor_id','integer'],['supplier_id','integer'],['order_id','integer'],['state','text'],
      ['kind','text',true],['request_hash','text'],['intent','jsonb',true],['intent_json','text',true],['source','jsonb',true],
      ['source_json','text',true],['source_hash','text'],['result','jsonb',true],['created_at','integer']],
    indexes:[['spro_pk',['operation_id'],true,true],['spro_order',['order_id','created_at','operation_id'],false,false]] },
  { name:'supplier_proactive_refund_decision_v1',prefix:'sprd',constraints:5,checks:3,
    columns:[['operation_id','uuid'],['actor_id','integer'],['supplier_id','integer'],['order_id','integer'],['kind','text'],
      ['outcome','text'],['request_hash','text'],['evidence','jsonb'],['evidence_json','text'],['evidence_hash','text'],['created_at','integer']],
    indexes:[['sprd_pk',['operation_id'],true,true]] },
  { name:'supplier_refund_money_payment_v1',prefix:'srmp',constraints:8,checks:4,
    columns:[['id','integer',false,undefined,'a'],['operation_id','uuid'],['order_id','integer'],['payment_order_id','integer'],
      ['provider','text'],['out_refund_no','text'],['transaction_id','text'],['request_amount','integer'],['total_amount','integer'],
      ['provider_status','text'],['provider_refund_id','text',false,"''::text"],['last_error','text',false,"''::text"],
      ['attempts','integer',false,'0'],['request_lease_until','integer',true],['next_retry_at','integer',false,'0'],
      ['last_queried_at','integer',true],['query_count','integer',false,'0'],['request','jsonb'],['request_json','text'],
      ['request_hash','text'],['created_at','integer'],['updated_at','integer']],
    indexes:[['srmp_pk',['id'],true,true],['srmp_operation_uq',['operation_id'],true,false],
      ['srmp_out_refund_no_uq',['out_refund_no'],true,false],['srmp_retry',['provider_status','next_retry_at','id'],false,false]] },
  { name:'supplier_refund_money_completion_v1',prefix:'srmc',constraints:5,checks:3,
    columns:[['operation_id','uuid'],['actor_id','integer'],['supplier_id','integer'],['order_id','integer'],['first_refund_id','integer'],
      ['payment_order_id','integer'],['amount','numeric(12,2)'],['pay_type','text'],['source_hash','text'],['request_hash','text'],
      ['before_refunded','numeric(12,2)'],['after_refunded','numeric(12,2)'],['proof','jsonb'],['proof_json','text'],
      ['proof_hash','text'],['created_at','integer']],
    indexes:[['srmc_pk',['operation_id'],true,true],['srmc_order',['order_id','created_at','operation_id'],false,false]] },
];
const names = tables.map(table => table.name);
const guards = ['supplier_proactive_refund_immutable_v1','supplier_refund_money_payment_guard_v1'];
const expectedColumns = (table: TableSpec) => table.columns.map(([name,type,nullable,defaultValue,identity], index) =>
  [index+1,name,type,!nullable,defaultValue??null,identity??'','',false,type==='text'?'"default"':null]);
const expectedIndexes = (table: TableSpec) => table.indexes.map(([name,keys,unique,primary]) => [name,keys,unique,primary]);

async function inspectTable(tx: Pick<DbClient,'execute'>, table: TableSpec, mode:'read'|'write'):Promise<Record<string,unknown>|undefined> {
  const payment = table.prefix==='srmp', guard = payment?guards[1]:guards[0], rowTrigger=payment?'srmp_guard_rows':table.prefix+'_immutable_rows';
  const truncateTrigger=payment?'srmp_guard_truncate':table.prefix+'_immutable_truncate';
  const [row] = await tx.execute(sql`SELECT c.relname AS name,c.relowner::text AS owner,
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnatts=${table.columns.length} AND c.relchecks=${table.checks} AND c.reloptions IS NULL AND c.relreplident='d'
      AND c.reltablespace=0 AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND
        (k.contype NOT IN ('p','u','c','f') OR NOT k.convalidated OR k.condeferrable OR k.condeferred OR NOT k.conislocal OR k.coninhcount<>0 OR k.conparentid<>0))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.confrelid=c.oid AND
        (c.relname<>'supplier_proactive_refund_operation_v1' OR k.conname NOT IN ('sprd_operation_fk','srmp_operation_fk','srmc_operation_fk')
          OR k.conrelid NOT IN (to_regclass('public.supplier_proactive_refund_decision_v1'),to_regclass('public.supplier_refund_money_payment_v1'),to_regclass('public.supplier_refund_money_completion_v1'))))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid AND k.contype='f' AND
        (k.confrelid<>to_regclass('public.supplier_proactive_refund_operation_v1') OR k.confkey<>ARRAY[1]::smallint[]
          OR k.conkey<>CASE WHEN c.relname='supplier_refund_money_payment_v1' THEN ARRAY[2]::smallint[] ELSE ARRAY[1]::smallint[] END
          OR k.confupdtype<>'r' OR k.confdeltype<>'r' OR k.confmatchtype<>'s')) AS safe,
    (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,a.attisdropped,
      CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0) AS columns,
    (SELECT count(*)=${table.constraints} FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid) AS constraint_count,
    (SELECT jsonb_agg(jsonb_build_object('name',i.relname,'keys',(SELECT jsonb_agg(a.attname ORDER BY key.ordinality)
        FROM unnest(x.indkey) WITH ORDINALITY key(attnum,ordinality) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum),
      'unique',x.indisunique,'primary',x.indisprimary) ORDER BY i.relname)
      FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid) AS index_definitions,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid AND
      (NOT x.indisvalid OR NOT x.indisready OR NOT x.indislive OR NOT x.indimmediate OR x.indisexclusion OR x.indnullsnotdistinct
        OR x.indisclustered OR x.indisreplident OR x.indpred IS NOT NULL OR x.indexprs IS NOT NULL OR x.indnatts<>x.indnkeyatts
        OR i.relkind<>'i' OR i.relpersistence<>'p' OR i.relispartition OR i.relowner<>c.relowner OR i.relnamespace<>c.relnamespace
        OR i.reloptions IS NOT NULL OR i.relacl IS NOT NULL OR i.reltablespace<>0
        OR i.relam<>(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
        OR EXISTS(SELECT 1 FROM unnest(x.indkey::smallint[],x.indcollation::oid[],x.indclass::oid[],x.indoption::smallint[]) key(attnum,index_collation,opclass,options)
          LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum
          LEFT JOIN pg_catalog.pg_opclass o ON o.oid=key.opclass WHERE a.attnum IS NULL OR key.options<>0
            OR key.index_collation<>a.attcollation OR o.opcnamespace<>'pg_catalog'::regnamespace OR o.opcmethod<>i.relam
            OR o.opcname<>CASE WHEN a.atttypid='uuid'::regtype THEN 'uuid_ops' WHEN a.atttypid='integer'::regtype THEN 'int4_ops' ELSE 'text_ops' END))) AS indexes,
    (SELECT count(*)=2 AND bool_and(t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgconstraint=0
      AND t.tgfoid=to_regprocedure(${'public.'+guard+'()'}) AND t.tgattr::text='' AND t.tgargs='\\x'::bytea
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred
      AND ((t.tgname=${rowTrigger} AND t.tgtype=27) OR (t.tgname=${truncateTrigger} AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND t.tgisinternal AND
        (t.tgenabled<>'O' OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint
          AND k.contype='f' AND k.conname IN ('sprd_operation_fk','srmp_operation_fk','srmc_operation_fk')))) AS triggers,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner AND
        (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT') OR r.rolsuper OR r.rolcreaterole
          OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE col.attrelid=c.oid AND a.grantee<>c.relowner AND
        (NOT ${payment} OR col.attname NOT IN (${sql.join(paymentColumns.map(name=>sql`${name}`),sql`,`)})
          OR a.grantee=0 OR a.is_grantable OR a.privilege_type<>'UPDATE' OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls))
      AND has_table_privilege(current_user,c.oid,'SELECT') AND (${mode==='read'} OR has_table_privilege(current_user,c.oid,'INSERT'))
      AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR
        (NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col WHERE col.attrelid=c.oid AND col.attnum>0
            AND (NOT ${payment} OR col.attname NOT IN (${sql.join(paymentColumns.map(name=>sql`${name}`),sql`,`)}))
            AND has_column_privilege(current_user,c.oid,col.attnum,'UPDATE'))
          AND (${mode==='read'||!payment} OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col WHERE col.attrelid=c.oid
            AND col.attname IN (${sql.join(paymentColumns.map(name=>sql`${name}`),sql`,`)})
            AND NOT has_column_privilege(current_user,c.oid,col.attnum,'UPDATE'))))) AS privileges
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass(${'public.'+table.name})`);
  if (!row) return undefined;
  const actual=row.index_definitions;
  const normalized=Array.isArray(actual)?actual.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const index=value as Record<string,unknown>;return [index.name,index.keys,index.unique,index.primary];
  }):null;
  return { ...row, columns_match:JSON.stringify(row.columns)===JSON.stringify(expectedColumns(table)),
    indexes_match:!!normalized&&normalized.every(index=>index!==null)
      &&JSON.stringify([...normalized].sort((a,b)=>String(a?.[0]).localeCompare(String(b?.[0]))))
        ===JSON.stringify([...expectedIndexes(table)].sort((a,b)=>String(a[0]).localeCompare(String(b[0])))) };
}

export async function inspectSupplierProactiveRefund(tx: Pick<DbClient,'execute'>, mode:'read'|'write'='write') {
  const [environment]=await tx.execute(sql`SELECT current_user=session_user AND current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=current_user AND
      (r.rolsuper OR (NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
        AND NOT has_schema_privilege(r.oid,'public','CREATE')
        AND NOT has_parameter_privilege(r.oid,'session_replication_role','SET')
        AND NOT has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
        AND NOT EXISTS(WITH RECURSIVE authority(oid) AS (SELECT r.oid UNION
          SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON m.member=a.oid)
          SELECT 1 FROM authority a JOIN pg_catalog.pg_roles p ON p.oid=a.oid
          WHERE p.rolsuper OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication OR p.rolbypassrls)))) AS identity`);
  const actual=[];
  for (const table of tables) actual.push(await inspectTable(tx,table,mode));
  const functions=[];
  for (const [index,name] of guards.entries()) {
    const [record]=await tx.execute(sql`SELECT p.proowner::text AS owner,p.prosrc=${index===0?SUPPLIER_PROACTIVE_REFUND_IMMUTABLE_BODY:SUPPLIER_PROACTIVE_REFUND_PAYMENT_GUARD_BODY}
      AND p.prorettype='pg_catalog.trigger'::regtype AND p.pronargs=0 AND NOT p.prosecdef AND NOT p.proleakproof
      AND p.provolatile='v' AND p.prokind='f' AND NOT p.proisstrict AND NOT p.proretset AND p.proparallel='u'
      AND p.prosupport=0 AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.procost=100 AND p.prorows=0
      AND p.probin IS NULL AND p.prosqlbody IS NULL AND p.protrftypes IS NULL AND p.proconfig=ARRAY['search_path=pg_catalog']
      AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND (SELECT count(*)=1 FROM pg_catalog.pg_proc other WHERE other.pronamespace=p.pronamespace AND other.proname=p.proname)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
      AND (SELECT count(*)=${index===0?6:2} FROM pg_catalog.pg_trigger t WHERE t.tgfoid=p.oid) AS safe
      FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(${'public.'+name+'()'})`);
    functions.push(record);
  }
  const [sequence]=await tx.execute(sql`SELECT c.relowner::text AS owner,c.relkind='S' AND c.relpersistence='p'
    AND NOT c.relispartition AND c.reloptions IS NULL AND c.reltablespace=0
    AND s.seqtypid='pg_catalog.int4'::regtype AND s.seqstart=1 AND s.seqincrement=1 AND s.seqmin=1
    AND s.seqmax=2147483647 AND s.seqcache=1 AND NOT s.seqcycle
    AND (SELECT count(*)=1 AND bool_and(d.deptype='i' AND d.refobjid=to_regclass('public.supplier_refund_money_payment_v1')
      AND d.refobjsubid=1) FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass
      AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_class'::regclass) AS safe,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('s',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable
        OR a.privilege_type<>'USAGE' OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls))
      AND (${mode==='read'} OR has_sequence_privilege(current_user,c.oid,'USAGE'))
      AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
        OR NOT has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE')) AS privileges
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid
    WHERE c.oid=to_regclass('public.supplier_refund_money_payment_v1_id_seq')`);
  const [constraints]=await tx.execute(sql`SELECT encode(sha256(convert_to(jsonb_object_agg(name,definitions ORDER BY name)::text,'UTF8')),'hex') AS constraints_hash
    FROM (SELECT c.relname AS name,jsonb_object_agg(k.conname,pg_get_constraintdef(k.oid,false) ORDER BY k.conname) AS definitions
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN (${sql.join(names.map(name=>sql`${name}`),sql`,`)})
      GROUP BY c.relname) definitions`);
  const complete=actual.every(row=>!!row),owner=actual[0]?.owner;
  return { supported:environment?.supported===true&&environment.identity===true,
    safe:complete&&actual.every(row=>row?.safe===true&&row.owner===owner),
    columns:complete&&actual.every(row=>row?.columns_match===true),
    constraint_count:complete&&actual.every(row=>row?.constraint_count===true),
    indexes:complete&&actual.every(row=>row?.indexes===true&&row.indexes_match===true),
    triggers:complete&&actual.every(row=>row?.triggers===true),
    function:functions.every(row=>row?.safe===true&&row.owner===owner),
    sequence:sequence?.safe===true&&sequence.owner===owner,
    privileges:complete&&actual.every(row=>row?.privileges===true)&&sequence?.privileges===true,
    constraints_hash:constraints?.constraints_hash,tables:actual,functions,sequence_catalog:sequence };
}

export async function supplierProactiveRefundReadiness(tx: Pick<DbClient,'execute'>, mode:'read'|'write'='write') {
  const state=await inspectSupplierProactiveRefund(tx,mode);
  const ready=['supported','safe','columns','constraint_count','indexes','triggers','function','sequence','privileges']
    .every(key=>state[key as keyof typeof state]===true)&&state.constraints_hash===SUPPLIER_PROACTIVE_REFUND_CONSTRAINTS_SHA256;
  return { ready,reason:ready?'':'供应商主动退款凭据、目录或运行权限尚未就绪',state };
}
export async function assertSupplierProactiveRefundReady(tx: Pick<DbClient,'execute'>, mode:'read'|'write'='write') {
  try {
    const [preflight]=await tx.execute(sql`SELECT count(*)=4 AND bool_and(c.relkind='r'
      AND has_table_privilege(current_user,c.oid,'SELECT')) AS readable FROM pg_catalog.pg_class c
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN (${sql.join(names.map(name=>sql`${name}`),sql`,`)})`);
    if(preflight?.readable!==true)throw Error('Supplier proactive refund relations are not readable');
    // Metadata alone does not pin a relation. Inspect the full catalog AFTER
    // acquiring AccessShare on every actual table, so a concurrent replacement
    // between the preflight and SELECT cannot retain an earlier ready result.
    // The metadata preflight rejects missing SELECT without aborting this TX.
    for (const name of names) await tx.execute(sql.raw(`SELECT operation_id FROM public.${name} LIMIT 0`));
    if (!(await supplierProactiveRefundReadiness(tx,mode)).ready) throw Error('Supplier proactive refund catalog drift');
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('供应商主动退款凭据、目录或运行权限尚未就绪'),{cause});
  }
}
export async function assertSupplierProactiveRefundReadable(tx: Pick<DbClient,'execute'>) {
  await assertSupplierProactiveRefundReady(tx,'read');
}
async function assertRuntime(tx: Pick<DbClient,'execute'>, role:string) {
  const [identity]=await tx.execute(sql`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=pg_roles.oid)
    AND rolname<>current_user AND NOT has_schema_privilege(oid,'public','CREATE')
    AND NOT has_parameter_privilege(oid,'session_replication_role','SET')
    AND NOT has_parameter_privilege(oid,'session_replication_role','ALTER SYSTEM') AS safe
    FROM pg_catalog.pg_roles WHERE rolname=${role}`);
  if(identity?.safe!==true)throw Error('Supplier proactive refund runtime must be a separate restricted identity');
}
async function assertRuntimeGrants(tx: Pick<DbClient,'execute'>, role:string) {
  for (const table of tables) {
    const payment=table.prefix==='srmp';
    const [grant]=await tx.execute(sql`SELECT has_table_privilege(${role},${'public.'+table.name},'SELECT')
      AND has_table_privilege(${role},${'public.'+table.name},'INSERT')
      AND NOT has_table_privilege(${role},${'public.'+table.name},'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=to_regclass(${'public.'+table.name}) AND a.attnum>0
        AND (has_column_privilege(${role},a.attrelid,a.attnum,'UPDATE') IS DISTINCT FROM
          (${payment} AND a.attname IN (${sql.join(paymentColumns.map(name=>sql`${name}`),sql`,`)})))) AS ready`);
    if(grant?.ready!==true)throw Error('Supplier proactive refund runtime grants require review');
  }
  const [sequence]=await tx.execute(sql`SELECT has_sequence_privilege(${role},'public.supplier_refund_money_payment_v1_id_seq','USAGE')
    AND NOT has_sequence_privilege(${role},'public.supplier_refund_money_payment_v1_id_seq','SELECT,UPDATE') AS ready`);
  if(sequence?.ready!==true)throw Error('Supplier proactive refund identity sequence grants require review');
}
export async function installSupplierProactiveRefund(tx: Pick<DbClient,'execute'>, options:{runtimeRole?:string}={}) {
  if(Object.hasOwn(tx,'$client'))throw Error('Supplier proactive refund installation requires an existing maintenance transaction');
  const role=options.runtimeRole;
  if(role!==undefined&&!/^[a-z][a-z0-9_]{0,62}$/.test(role))throw Error('Invalid supplier proactive refund runtime identity');
  const [gate]=await tx.execute(sql`SELECT current_user=session_user AND current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AND pg_try_advisory_xact_lock(731627,20) AS supported,
    (SELECT count(*)::integer FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND relname IN (${sql.join([...names,'supplier_refund_money_payment_v1_id_seq'].map(name=>sql`${name}`),sql`,`)})) AS relations,
    (SELECT count(*)::integer FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN (${sql.join(guards.map(name=>sql`${name}`),sql`,`)})) AS functions`);
  if(gate?.supported!==true)throw Error('Supplier proactive refund installation requires explicit PG16 owner maintenance');
  if(role)await assertRuntime(tx,role);
  if(gate.relations!==0||gate.functions!==0){
    if(gate.relations!==5||gate.functions!==2)throw Error('Partial supplier proactive refund catalog requires review');
    await tx.execute(sql.raw(`LOCK TABLE ${names.map(name=>'ONLY public.'+name).join(',')} IN ACCESS EXCLUSIVE MODE NOWAIT`));
    await assertSupplierProactiveRefundReady(tx);
    if(role)await assertRuntimeGrants(tx,role);
    return {applied:false};
  }
  await tx.execute(sql.raw(SUPPLIER_PROACTIVE_REFUND_SQL));
  if(role){
    await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE ${names.map(name=>'public.'+name).join(',')} TO "${role}"`));
    await tx.execute(sql.raw(`GRANT UPDATE(${paymentColumns.join(',')}) ON TABLE public.supplier_refund_money_payment_v1 TO "${role}"`));
    await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.supplier_refund_money_payment_v1_id_seq TO "${role}"`));
  }
  await assertSupplierProactiveRefundReady(tx);
  if(role)await assertRuntimeGrants(tx,role);
  return {applied:true};
}
