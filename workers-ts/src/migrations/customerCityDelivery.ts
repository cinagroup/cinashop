import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { compositeCustomerWorkCatalogSql } from './customerWorkCatalog';
import { outRequestHash } from '@/services/out/OutIdempotency';
// Generated once from the authored source-shaped schema; standalone SQL is identical.
export const CUSTOMER_CITY_DELIVERY_SQL = "-- Explicit owner maintenance only. Not part of MigrationService/runAll/startup.\nCREATE TABLE IF NOT EXISTS \"customer_city_delivery_job\" (\n  \"id\" bigserial NOT NULL PRIMARY KEY,\n  \"actor_uid\" integer NOT NULL,\n  \"service_id\" integer NOT NULL,\n  \"actor_auth_version\" varchar(32) NOT NULL,\n  \"actor_expires_at\" integer NOT NULL,\n  \"scope_key\" varchar(64) NOT NULL,\n  \"request_key\" varchar(36) NOT NULL,\n  \"request_hash\" varchar(64) NOT NULL,\n  \"intent_hash\" varchar(64) NOT NULL,\n  \"requested_order_id\" integer NOT NULL,\n  \"root_order_id\" integer NOT NULL,\n  \"order_id\" integer NOT NULL,\n  \"customer_uid\" integer NOT NULL,\n  \"store_id\" integer NOT NULL,\n  \"supplier_id\" integer NOT NULL,\n  \"provider\" varchar(8) NOT NULL,\n  \"provider_order_id\" varchar(32) NOT NULL,\n  \"intent\" jsonb NOT NULL,\n  \"status\" varchar(16) DEFAULT 'PENDING' NOT NULL,\n  \"lease_token\" varchar(36) DEFAULT '' NOT NULL,\n  \"lease_until\" integer DEFAULT 0 NOT NULL,\n  \"last_error_code\" varchar(64) DEFAULT '' NOT NULL,\n  \"add_time\" integer NOT NULL,\n  \"update_time\" integer NOT NULL,\n  CONSTRAINT \"ccdjob_identity_ck\" CHECK (\"customer_city_delivery_job\".\"actor_uid\">0 AND \"customer_city_delivery_job\".\"service_id\">0 AND \"customer_city_delivery_job\".\"requested_order_id\">0 AND \"customer_city_delivery_job\".\"root_order_id\">0 AND \"customer_city_delivery_job\".\"order_id\">0 AND \"customer_city_delivery_job\".\"customer_uid\">0 AND \"customer_city_delivery_job\".\"store_id\">=0 AND \"customer_city_delivery_job\".\"supplier_id\">=0),\n  CONSTRAINT \"ccdjob_keys_ck\" CHECK (\"customer_city_delivery_job\".\"request_key\" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND \"customer_city_delivery_job\".\"request_hash\" ~ '^[0-9a-f]{64}$' AND \"customer_city_delivery_job\".\"intent_hash\" ~ '^[0-9a-f]{64}$' AND \"customer_city_delivery_job\".\"scope_key\" ~ '^[0-9a-f]{64}$' AND \"customer_city_delivery_job\".\"actor_auth_version\" ~ '^[0-9a-f]{32}$'),\n  CONSTRAINT \"ccdjob_provider_ck\" CHECK (\"customer_city_delivery_job\".\"provider\" IN ('dada','uu') AND \"customer_city_delivery_job\".\"provider_order_id\" ~ '^[A-Za-z0-9._:-]{1,32}$'),\n  CONSTRAINT \"ccdjob_status_ck\" CHECK (\"customer_city_delivery_job\".\"status\" IN ('PENDING','PROCESSING','ADMITTED','UNKNOWN','REJECTED','REVOKED','CANCELLED','DELIVERED')),\n  CONSTRAINT \"ccdjob_intent_ck\" CHECK (jsonb_typeof(\"customer_city_delivery_job\".\"intent\")='object' AND octet_length(\"customer_city_delivery_job\".\"intent\"::text)<=131072),\n  CONSTRAINT \"ccdjob_time_ck\" CHECK (\"customer_city_delivery_job\".\"actor_expires_at\">0 AND \"customer_city_delivery_job\".\"add_time\">0 AND \"customer_city_delivery_job\".\"update_time\">=\"customer_city_delivery_job\".\"add_time\" AND \"customer_city_delivery_job\".\"lease_until\">=0)\n);\nCREATE UNIQUE INDEX IF NOT EXISTS \"ccdjob_actor_request_uq\" ON \"customer_city_delivery_job\" (\"actor_uid\",\"request_key\");\nCREATE UNIQUE INDEX IF NOT EXISTS \"ccdjob_provider_order_uq\" ON \"customer_city_delivery_job\" (\"provider\",\"provider_order_id\");\nCREATE INDEX IF NOT EXISTS \"ccdjob_root_status\" ON \"customer_city_delivery_job\" (\"root_order_id\",\"status\",\"id\");\nCREATE INDEX IF NOT EXISTS \"ccdjob_dispatch\" ON \"customer_city_delivery_job\" (\"status\",\"lease_until\",\"id\");\nCREATE TABLE IF NOT EXISTS \"customer_city_delivery_attempt\" (\n  \"id\" bigserial NOT NULL PRIMARY KEY,\n  \"job_id\" bigint NOT NULL,\n  \"request_key\" varchar(36) NOT NULL,\n  \"phase\" varchar(16) NOT NULL,\n  \"quote\" jsonb DEFAULT '{}'::jsonb NOT NULL,\n  \"result\" jsonb DEFAULT '{}'::jsonb NOT NULL,\n  \"error_code\" varchar(64) DEFAULT '' NOT NULL,\n  \"started_time\" integer NOT NULL,\n  \"issued_time\" integer DEFAULT 0 NOT NULL,\n  \"update_time\" integer NOT NULL,\n  CONSTRAINT \"ccdattempt_phase_ck\" CHECK (\"customer_city_delivery_attempt\".\"phase\" IN ('QUOTING','QUOTED','ISSUING','ACCEPTED','UNKNOWN','REJECTED','REVOKED')),\n  CONSTRAINT \"ccdattempt_json_ck\" CHECK (jsonb_typeof(\"customer_city_delivery_attempt\".\"quote\")='object' AND jsonb_typeof(\"customer_city_delivery_attempt\".\"result\")='object' AND octet_length(\"customer_city_delivery_attempt\".\"quote\"::text)<=32768 AND octet_length(\"customer_city_delivery_attempt\".\"result\"::text)<=32768),\n  CONSTRAINT \"ccdattempt_key_ck\" CHECK (\"customer_city_delivery_attempt\".\"request_key\" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND \"customer_city_delivery_attempt\".\"started_time\">0 AND \"customer_city_delivery_attempt\".\"issued_time\">=0 AND \"customer_city_delivery_attempt\".\"update_time\">=\"customer_city_delivery_attempt\".\"started_time\"),\n  CONSTRAINT \"ccdattempt_job_fk\" FOREIGN KEY (\"job_id\") REFERENCES \"customer_city_delivery_job\" (\"id\") ON DELETE RESTRICT\n);\nCREATE UNIQUE INDEX IF NOT EXISTS \"ccdattempt_job_uq\" ON \"customer_city_delivery_attempt\" (\"job_id\");\nCREATE TABLE IF NOT EXISTS \"customer_city_delivery_binding\" (\n  \"job_id\" bigint NOT NULL PRIMARY KEY,\n  \"attempt_id\" bigint NOT NULL,\n  \"delivery_order_id\" integer NOT NULL,\n  \"order_id\" integer NOT NULL,\n  \"root_order_id\" integer NOT NULL,\n  \"customer_uid\" integer NOT NULL,\n  \"store_id\" integer NOT NULL,\n  \"supplier_id\" integer NOT NULL,\n  \"provider\" varchar(8) NOT NULL,\n  \"provider_order_id\" varchar(32) NOT NULL,\n  \"active\" smallint DEFAULT 1 NOT NULL,\n  \"add_time\" integer NOT NULL,\n  \"update_time\" integer NOT NULL,\n  CONSTRAINT \"ccdbinding_identity_ck\" CHECK (\"customer_city_delivery_binding\".\"delivery_order_id\">0 AND \"customer_city_delivery_binding\".\"order_id\">0 AND \"customer_city_delivery_binding\".\"root_order_id\">0 AND \"customer_city_delivery_binding\".\"customer_uid\">0 AND \"customer_city_delivery_binding\".\"store_id\">=0 AND \"customer_city_delivery_binding\".\"supplier_id\">=0 AND \"customer_city_delivery_binding\".\"active\" IN (0,1)),\n  CONSTRAINT \"ccdbinding_provider_ck\" CHECK (\"customer_city_delivery_binding\".\"provider\" IN ('dada','uu') AND \"customer_city_delivery_binding\".\"provider_order_id\" ~ '^[A-Za-z0-9._:-]{1,32}$' AND \"customer_city_delivery_binding\".\"add_time\">0 AND \"customer_city_delivery_binding\".\"update_time\">=\"customer_city_delivery_binding\".\"add_time\"),\n  CONSTRAINT \"ccdbinding_job_fk\" FOREIGN KEY (\"job_id\") REFERENCES \"customer_city_delivery_job\" (\"id\") ON DELETE RESTRICT,\n  CONSTRAINT \"ccdbinding_attempt_fk\" FOREIGN KEY (\"attempt_id\") REFERENCES \"customer_city_delivery_attempt\" (\"id\") ON DELETE RESTRICT\n);\nCREATE UNIQUE INDEX IF NOT EXISTS \"ccdbinding_delivery_uq\" ON \"customer_city_delivery_binding\" (\"delivery_order_id\");\nCREATE UNIQUE INDEX IF NOT EXISTS \"ccdbinding_provider_uq\" ON \"customer_city_delivery_binding\" (\"provider\",\"provider_order_id\");\nCREATE UNIQUE INDEX IF NOT EXISTS \"ccdbinding_active_order_uq\" ON \"customer_city_delivery_binding\" (\"order_id\") WHERE \"customer_city_delivery_binding\".\"active\"=1;\n\n-- Preserve actual legacy store station columns; no station registration/provider call.\nALTER TABLE system_store ADD COLUMN IF NOT EXISTS city_shop_id VARCHAR(255) DEFAULT '' NOT NULL;\nALTER TABLE system_store ADD COLUMN IF NOT EXISTS business INTEGER DEFAULT 0 NOT NULL;\n";
export const CUSTOMER_CITY_CATALOG: readonly { table:string; columns:readonly {name:string;type:string;notNull:boolean}[]; checks:readonly string[];foreignKeys:readonly string[];indexes:readonly {name:string;unique:boolean;columns:readonly string[];partial:boolean}[] }[] = [
  {
    "table": "customer_city_delivery_job",
    "columns": [
      {
        "name": "id",
        "type": "bigserial",
        "notNull": true
      },
      {
        "name": "actor_uid",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "service_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "actor_auth_version",
        "type": "varchar(32)",
        "notNull": true
      },
      {
        "name": "actor_expires_at",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "scope_key",
        "type": "varchar(64)",
        "notNull": true
      },
      {
        "name": "request_key",
        "type": "varchar(36)",
        "notNull": true
      },
      {
        "name": "request_hash",
        "type": "varchar(64)",
        "notNull": true
      },
      {
        "name": "intent_hash",
        "type": "varchar(64)",
        "notNull": true
      },
      {
        "name": "requested_order_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "root_order_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "order_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "customer_uid",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "store_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "supplier_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "provider",
        "type": "varchar(8)",
        "notNull": true
      },
      {
        "name": "provider_order_id",
        "type": "varchar(32)",
        "notNull": true
      },
      {
        "name": "intent",
        "type": "jsonb",
        "notNull": true
      },
      {
        "name": "status",
        "type": "varchar(16)",
        "notNull": true
      },
      {
        "name": "lease_token",
        "type": "varchar(36)",
        "notNull": true
      },
      {
        "name": "lease_until",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "last_error_code",
        "type": "varchar(64)",
        "notNull": true
      },
      {
        "name": "add_time",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "update_time",
        "type": "integer",
        "notNull": true
      }
    ],
    "checks": [
      "ccdjob_identity_ck",
      "ccdjob_keys_ck",
      "ccdjob_provider_ck",
      "ccdjob_status_ck",
      "ccdjob_intent_ck",
      "ccdjob_time_ck"
    ],
    "foreignKeys": [],
    "indexes": [
      {
        "name": "ccdjob_actor_request_uq",
        "unique": true,
        "columns": [
          "actor_uid",
          "request_key"
        ],
        "partial": false
      },
      {
        "name": "ccdjob_provider_order_uq",
        "unique": true,
        "columns": [
          "provider",
          "provider_order_id"
        ],
        "partial": false
      },
      {
        "name": "ccdjob_root_status",
        "unique": false,
        "columns": [
          "root_order_id",
          "status",
          "id"
        ],
        "partial": false
      },
      {
        "name": "ccdjob_dispatch",
        "unique": false,
        "columns": [
          "status",
          "lease_until",
          "id"
        ],
        "partial": false
      }
    ]
  },
  {
    "table": "customer_city_delivery_attempt",
    "columns": [
      {
        "name": "id",
        "type": "bigserial",
        "notNull": true
      },
      {
        "name": "job_id",
        "type": "bigint",
        "notNull": true
      },
      {
        "name": "request_key",
        "type": "varchar(36)",
        "notNull": true
      },
      {
        "name": "phase",
        "type": "varchar(16)",
        "notNull": true
      },
      {
        "name": "quote",
        "type": "jsonb",
        "notNull": true
      },
      {
        "name": "result",
        "type": "jsonb",
        "notNull": true
      },
      {
        "name": "error_code",
        "type": "varchar(64)",
        "notNull": true
      },
      {
        "name": "started_time",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "issued_time",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "update_time",
        "type": "integer",
        "notNull": true
      }
    ],
    "checks": [
      "ccdattempt_phase_ck",
      "ccdattempt_json_ck",
      "ccdattempt_key_ck"
    ],
    "foreignKeys": [
      "ccdattempt_job_fk"
    ],
    "indexes": [
      {
        "name": "ccdattempt_job_uq",
        "unique": true,
        "columns": [
          "job_id"
        ],
        "partial": false
      }
    ]
  },
  {
    "table": "customer_city_delivery_binding",
    "columns": [
      {
        "name": "job_id",
        "type": "bigint",
        "notNull": true
      },
      {
        "name": "attempt_id",
        "type": "bigint",
        "notNull": true
      },
      {
        "name": "delivery_order_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "order_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "root_order_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "customer_uid",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "store_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "supplier_id",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "provider",
        "type": "varchar(8)",
        "notNull": true
      },
      {
        "name": "provider_order_id",
        "type": "varchar(32)",
        "notNull": true
      },
      {
        "name": "active",
        "type": "smallint",
        "notNull": true
      },
      {
        "name": "add_time",
        "type": "integer",
        "notNull": true
      },
      {
        "name": "update_time",
        "type": "integer",
        "notNull": true
      }
    ],
    "checks": [
      "ccdbinding_identity_ck",
      "ccdbinding_provider_ck"
    ],
    "foreignKeys": [
      "ccdbinding_job_fk",
      "ccdbinding_attempt_fk"
    ],
    "indexes": [
      {
        "name": "ccdbinding_delivery_uq",
        "unique": true,
        "columns": [
          "delivery_order_id"
        ],
        "partial": false
      },
      {
        "name": "ccdbinding_provider_uq",
        "unique": true,
        "columns": [
          "provider",
          "provider_order_id"
        ],
        "partial": false
      },
      {
        "name": "ccdbinding_active_order_uq",
        "unique": true,
        "columns": [
          "order_id"
        ],
        "partial": true
      }
    ]
  }
];

/** Measured from the fresh authored PG16 installation; full constraints, indexes,
 * defaults, expressions, ordering, operator classes and trigger graph are pinned. */
export const CUSTOMER_CITY_CATALOG_SHA256='559592dc59b55f5c1472b6790928ee739bfcf546ba961d0be21c74b473616fdb';
export const CUSTOMER_CITY_CATALOG_SQL=compositeCustomerWorkCatalogSql({job:'customer_city_delivery_job',attempt:'customer_city_delivery_attempt',binding:'customer_city_delivery_binding'});
export const CUSTOMER_CITY_UPDATE_COLUMNS={
 customer_city_delivery_job:['status','provider_order_id','lease_token','lease_until','last_error_code','update_time'],
 customer_city_delivery_attempt:['phase','quote','result','error_code','issued_time','update_time'],
 customer_city_delivery_binding:['active','update_time'],
} as const;
/** Explicit fresh reviewed owner operation. Never registered in automatic migration. */
export async function installCustomerCityDelivery(db:DbClient,options:{maintenance:true}){
 if(options?.maintenance!==true||!Object.hasOwn(db,'$client'))throw Error('Explicit reviewed city root owner maintenance required');
 await db.transaction(async tx=>{
  await tx.execute(sql.raw('SET LOCAL search_path=public,pg_temp; SET LOCAL row_security=off'));
  const [owner]=await tx.execute<{allowed:boolean;fresh:boolean}>(sql`SELECT
   current_setting('server_version_num')::int/10000=16 AND current_setting('transaction_isolation')='read committed'
   AND current_setting('transaction_read_only')='off' AND current_setting('session_replication_role')='origin'
   AND NOT EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
   AND(r.rolsuper OR has_schema_privilege(current_user,'public','CREATE')) AS allowed,
   to_regclass('public.customer_city_delivery_job') IS NULL AND to_regclass('public.customer_city_delivery_attempt') IS NULL
   AND to_regclass('public.customer_city_delivery_binding') IS NULL AS fresh FROM pg_roles r WHERE r.rolname=current_user`);
  if(owner?.allowed!==true||owner.fresh!==true)throw Error('City fresh PG16 owner installation requires catalog review');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(731735,0)`);await tx.execute(sql.raw(CUSTOMER_CITY_DELIVERY_SQL));
  await assertCustomerCityDeliveryReady(tx as unknown as DbClient,false);
 },{isolationLevel:'read committed',accessMode:'read write'});
}
export async function assertCustomerCityDeliveryReady(db:DbClient,privileges=true):Promise<void>{
 const rows=await db.execute<{shape:unknown}>(sql.raw(CUSTOMER_CITY_CATALOG_SQL));
 if(rows.length!==1||await outRequestHash(rows[0].shape)!==CUSTOMER_CITY_CATALOG_SHA256)throw new ServiceUnavailableException('客户同城配送完整目录合同未验收');
 const [environment]=await db.execute<{sane:boolean}>(sql`SELECT current_setting('server_version_num')::int/10000=16
  AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid IN('public.customer_city_delivery_job'::regclass,'public.customer_city_delivery_attempt'::regclass,'public.customer_city_delivery_binding'::regclass)
   AND(${privileges} AND pg_get_userbyid(c.relowner)=current_user AND NOT(SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
    OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attisdropped))) AS sane`);
 if(environment?.sane!==true)throw new ServiceUnavailableException('客户同城配送目录所有权未验收');
 const stationColumns=await db.execute<{name:string;type:string;required:boolean;initial:string;identity:string;generated:string}>(sql`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS initial,a.attidentity AS identity,a.attgenerated AS generated FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass('public.system_store') AND a.attname IN('city_shop_id','business') AND NOT a.attisdropped ORDER BY a.attname`);
 if(stationColumns.length!==2||stationColumns[0].name!=='business'||stationColumns[0].type!=='integer'||!stationColumns[0].required||stationColumns[0].initial!=='0'||stationColumns[1].name!=='city_shop_id'||stationColumns[1].type!=='character varying(255)'||!stationColumns[1].required||stationColumns[1].initial!=="''::character varying"||stationColumns.some(c=>c.identity!==''||c.generated!==''))throw new ServiceUnavailableException('客户同城配送门店站点列未就绪');
 if(!privileges)return;
 for(const table of CUSTOMER_CITY_CATALOG){
  const allowed=CUSTOMER_CITY_UPDATE_COLUMNS[table.table as keyof typeof CUSTOMER_CITY_UPDATE_COLUMNS],identity=table.columns.map(c=>c.name).filter(c=>!(allowed as readonly string[]).includes(c));
  const [p]=await db.execute<{allowed:boolean}>(sql`SELECT has_table_privilege(current_user,${'public.'+table.table},'SELECT')
   AND has_table_privilege(current_user,${'public.'+table.table},'INSERT')
   AND NOT has_table_privilege(current_user,${'public.'+table.table},'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(identity)}::jsonb) c WHERE has_column_privilege(current_user,${'public.'+table.table},c,'UPDATE,REFERENCES'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${JSON.stringify(allowed)}::jsonb) c WHERE NOT has_column_privilege(current_user,${'public.'+table.table},c,'UPDATE')) AS allowed`);
  if(p?.allowed!==true)throw new ServiceUnavailableException('客户同城配送身份不可变运行时权限未就绪');
 }
 const [p]=await db.execute<{allowed:boolean}>(sql`SELECT has_table_privilege(current_user,'public.store_delivery_order','SELECT') AND has_table_privilege(current_user,'public.store_delivery_order','INSERT') AND has_table_privilege(current_user,'public.store_delivery_order','UPDATE') AND has_sequence_privilege(current_user,pg_get_serial_sequence('public.store_delivery_order','id'),'USAGE') AND has_sequence_privilege(current_user,pg_get_serial_sequence('public.customer_city_delivery_job','id'),'USAGE') AND has_sequence_privilege(current_user,pg_get_serial_sequence('public.customer_city_delivery_attempt','id'),'USAGE') AS allowed`);
 if(p?.allowed!==true)throw new ServiceUnavailableException('客户同城配送运行时权限未就绪');
}
