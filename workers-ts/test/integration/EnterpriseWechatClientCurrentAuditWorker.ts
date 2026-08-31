import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
} from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import {
  applyClientCurrentProjection,
  auditClientProjectionRows,
  recordClientProjectionSeen,
} from "@/services/work/EnterpriseWechatClientCurrentService";
import {
  EnterpriseWechatClientProjectionError,
  type ClientProjectionClaim,
  type EnterpriseWechatClientFollowSnapshot,
  type PreparedClientProjection,
} from "@/services/work/EnterpriseWechatClientProjection";
import {
  EnterpriseWechatContextService,
  type WorkContextStateStore,
} from "@/services/work/EnterpriseWechatContextService";

interface ClientCurrentAuditEnv {
  readonly HYPERDRIVE: Hyperdrive;
  readonly AUDIT_READ_TOKEN_SHA256: string;
  readonly AUDIT_MIGRATE_TOKEN_SHA256: string;
  readonly AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_work_client_current_";
const TARGET_TABLES = [
  "work_client_current",
  "work_client_projection_fence",
  "work_client_follow_current",
  "work_client_follow_projection_fence",
  "work_client_follow_tag_current",
] as const;
const LEGACY_TABLES = [
  "work_client",
  "work_client_follow",
  "work_client_follow_tags",
] as const;

function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = bytesFromHex(expectedHex);
  if (!expected) return false;
  const match = /^Bearer ([^\s]{1,4096})$/i.exec(
    request.headers.get("Authorization") ?? "",
  );
  const actual = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(match?.[1] ?? ""),
  ));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertAuditSchema(schema: string): void {
  if (!new RegExp(`^${AUDIT_SCHEMA_PREFIX}[0-9a-f]{32}$`).test(schema)) {
    throw new Error("unsafe_isolated_schema_name");
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

function pgClient(connectionString: string, applicationName: string) {
  return postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: applicationName },
  });
}

async function inventory(client: postgres.Sql, schema = "public") {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL statement_timeout = '180s'`;
    const relations = await tx<Array<{
      kind: string;
      name: string;
      oid: string;
      relfilenode: string;
    }>>`
      SELECT relation.relkind::text AS kind, relation.relname AS name,
        relation.oid::text AS oid, relation.relfilenode::text AS relfilenode
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${schema}
        AND relation.relkind IN ('r','S')
        AND NOT relation.relispartition
      ORDER BY relation.relkind, relation.relname
    `;
    return relations;
  });
}

async function tableFingerprint(
  client: postgres.Sql,
  schema: string,
  tables: readonly string[],
) {
  const output: Array<{ table: string; rows: string; digest: string }> = [];
  for (const table of tables) {
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    const exists = (await client<Array<{ exists: boolean }>>`
      SELECT to_regclass(${`${schema}.${table}`}) IS NOT NULL AS exists
    `)[0]?.exists ?? false;
    if (!exists) {
      output.push({ table, rows: "missing", digest: "" });
      continue;
    }
    const rows = await client.unsafe<Array<{ rows: string; digest: string }>>(`
      WITH tokens AS (
        SELECT hashtextextended(tableoid::text||':'||ctid::text||':'||xmin::text,0) AS a,
          hashtextextended(tableoid::text||':'||ctid::text||':'||xmin::text,1) AS b
        FROM ${qualified}
      )
      SELECT count(*)::text AS rows,
        md5(count(*)::text||':'||COALESCE(sum(a::numeric)::text,'0')||':'
          ||COALESCE(sum(b::numeric)::text,'0')) AS digest
      FROM tokens
    `);
    output.push({ table, rows: rows[0]?.rows ?? "-1", digest: rows[0]?.digest ?? "" });
  }
  return output;
}

async function targetMetadata(client: postgres.Sql, schema: string) {
  const rows = await client<Array<{
    kind: string;
    name: string;
    table_name: string | null;
    oid: string;
    relfilenode: string | null;
    definition: string | null;
  }>>`
    SELECT 'relation' AS kind, relation.relname AS name, NULL::text AS table_name,
      relation.oid::text AS oid, relation.relfilenode::text AS relfilenode,
      NULL::text AS definition
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema}
      AND relation.relname = ANY(${[...TARGET_TABLES]})
    UNION ALL
    SELECT 'constraint', constraint_row.conname, table_row.relname,
      constraint_row.oid::text, NULL::text,
      pg_get_constraintdef(constraint_row.oid, true)
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = ${schema}
      AND table_row.relname = ANY(${[...TARGET_TABLES]})
    UNION ALL
    SELECT 'index', index_row.relname, table_row.relname,
      index_row.oid::text, index_row.relfilenode::text,
      pg_get_indexdef(index_row.oid)
    FROM pg_index AS index_meta
    JOIN pg_class AS index_row ON index_row.oid = index_meta.indexrelid
    JOIN pg_class AS table_row ON table_row.oid = index_meta.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = ${schema}
      AND table_row.relname = ANY(${[...TARGET_TABLES]})
    ORDER BY kind, table_name NULLS FIRST, name
  `;
  return rows;
}

async function setupCallbackPrerequisite(client: postgres.Sql, schema: string) {
  assertAuditSchema(schema);
  await client.unsafe(`
    CREATE TABLE ${quoteIdentifier(schema)}.work_callback_event (
      id serial PRIMARY KEY,
      event_key varchar(64) NOT NULL UNIQUE,
      payload_hash varchar(64) NOT NULL,
      subject_key_hash varchar(64) NOT NULL,
      corp_id varchar(64) NOT NULL,
      msg_type varchar(64) NOT NULL DEFAULT '',
      event_type varchar(64) NOT NULL DEFAULT '',
      change_type varchar(64) NOT NULL DEFAULT '',
      event_time integer NOT NULL DEFAULT 0,
      sequence_rank integer NOT NULL DEFAULT 0,
      payload jsonb NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'RECEIVED',
      projection_status varchar(16) NOT NULL DEFAULT 'PENDING',
      attempt_count integer NOT NULL DEFAULT 0,
      lease_until integer NOT NULL DEFAULT 0,
      lease_token varchar(36) NOT NULL DEFAULT '',
      last_error_code varchar(64) NOT NULL DEFAULT '',
      received_time integer NOT NULL DEFAULT 0,
      processed_time integer NOT NULL DEFAULT 0,
      update_time integer NOT NULL DEFAULT 0,
      CONSTRAINT wce_department_ref_uq UNIQUE
        (id,corp_id,event_key,subject_key_hash,event_time,sequence_rank)
    )
  `);
  await client.unsafe(`
    CREATE TABLE ${quoteIdentifier(schema)}.work_member_identity_alias (
      corp_id varchar(18) NOT NULL,
      userid varchar(64) NOT NULL,
      member_id integer,
      canonical_userid varchar(64),
      lifecycle_state varchar(16) NOT NULL,
      last_event_id integer,
      last_event_key varchar(64),
      last_event_subject_key_hash varchar(64),
      last_event_time integer NOT NULL DEFAULT 0,
      last_sequence_rank integer NOT NULL DEFAULT 0
    );
    CREATE TABLE ${quoteIdentifier(schema)}.work_member_current (
      id integer PRIMARY KEY,
      corp_id varchar(18) NOT NULL,
      userid varchar(64) NOT NULL,
      canonical_userid varchar(64),
      lifecycle_state varchar(16) NOT NULL,
      status smallint,
      enable smallint,
      last_event_id integer,
      last_event_key varchar(64),
      last_event_subject_key_hash varchar(64),
      last_event_time integer NOT NULL DEFAULT 0,
      last_sequence_rank integer NOT NULL DEFAULT 0
    );
    CREATE TABLE ${quoteIdentifier(schema)}.work_member (
      id integer PRIMARY KEY,
      corp_id varchar(18) NOT NULL,
      userid varchar(64) NOT NULL,
      enable smallint NOT NULL,
      status smallint NOT NULL
    );
    INSERT INTO ${quoteIdentifier(schema)}.work_member
      (id,corp_id,userid,enable,status)
    VALUES (1,'ww-audit-corp','alice',1,1)
  `);
}

async function applyMigration(container: Container) {
  const migration = new MigrationService(container)
    .workClientCurrentProjectionMigrationSqlForVerification();
  await withTx(container, async (tx) => {
    await tx.execute(drizzleSql.raw(migration));
  });
}

function eventHex(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

async function insertClaim(
  client: postgres.Sql,
  schema: string,
  input: { eventTime: number; changeType: string; userid: string },
): Promise<ClientProjectionClaim> {
  const externalUserid = "wo-audit-client";
  const eventKey = eventHex(input.eventTime);
  const subjectKeyHash = eventHex(input.eventTime + 10000);
  const payload = { ExternalUserID: externalUserid, UserID: input.userid };
  const rows = await client.unsafe<Array<{ id: number }>>(`
    INSERT INTO ${quoteIdentifier(schema)}.work_callback_event
      (event_key,payload_hash,subject_key_hash,corp_id,msg_type,event_type,
       change_type,event_time,sequence_rank,payload,status,projection_status,
       received_time,update_time)
    VALUES ($1,$2,$3,$4,'event','change_external_contact',$5,$6,50,$7::jsonb,
      'PROCESSING','PROCESSING',$6,$6)
    RETURNING id
  `, [eventKey, eventHex(input.eventTime + 20000), subjectKeyHash,
    "ww-audit-corp", input.changeType, input.eventTime, JSON.stringify(payload)]);
  if (!rows[0]) throw new Error("direct_service_callback_insert_failed");
  return {
    eventId: rows[0].id,
    eventKey,
    subjectKeyHash,
    eventTime: input.eventTime,
    sequenceRank: 50,
    corpId: "ww-audit-corp",
    msgType: "event",
    eventType: "change_external_contact",
    changeType: input.changeType,
    payload,
  };
}

function follow(userid: string, seed: number): EnterpriseWechatClientFollowSnapshot {
  return {
    userid,
    remark: `remark-${seed}`,
    description: `description-${seed}`,
    followCreatedTime: seed,
    remarkCorpName: `corp-${seed}`,
    remarkMobiles: [`1380000${String(seed).padStart(4, "0").slice(-4)}`],
    addWay: 1,
    operUserid: null,
    state: `state-${seed}`,
    tags: [{
      tagKeyHash: eventHex(seed + 30000),
      tagId: seed % 2 ? null : `tag-${seed}`,
      groupName: seed % 2 ? "personal" : "group",
      tagName: `tag-name-${seed}`,
      type: seed % 2 ? 2 : 1,
      sortOrder: 0,
    }],
  };
}

function snapshot(
  callbackUserid: string,
  follows: EnterpriseWechatClientFollowSnapshot[],
  seed: number,
): PreparedClientProjection {
  return {
    kind: "snapshot",
    externalUserid: "wo-audit-client",
    callbackUserid,
    snapshot: {
      externalUserid: "wo-audit-client",
      name: `Audit Client ${seed}`,
      avatar: `https://example.invalid/${seed}.png`,
      type: 1,
      gender: 2,
      unionid: `union-${seed}`,
      position: "buyer",
      corpName: "Audit Corp",
      corpFullName: "Audit Corporation",
      externalProfile: { external_attr: [], seed },
      follows,
    },
  };
}

async function applyPrepared(
  container: Container,
  claim: ClientProjectionClaim,
  prepared: PreparedClientProjection,
) {
  const seen = await withTx(container, (tx) =>
    recordClientProjectionSeen(tx, claim, claim.eventTime));
  if (seen === "superseded") return seen;
  const applied = await withTx(container, (tx) =>
    applyClientCurrentProjection(tx, claim, prepared, claim.eventTime));
  return applied;
}

async function directServiceScenario(
  client: postgres.Sql,
  schema: string,
  container: Container,
) {
  const alice = "alice";
  const bob = "bob";
  const addAlice = await insertClaim(client, schema, {
    eventTime: 100,
    changeType: "add_external_contact",
    userid: alice,
  });
  const initial = await applyPrepared(
    container,
    addAlice,
    snapshot(alice, [follow(alice, 1), follow(bob, 2)], 1),
  );
  const deleteAlice = await insertClaim(client, schema, {
    eventTime: 200,
    changeType: "del_follow_user",
    userid: alice,
  });
  const removed = await applyPrepared(container, deleteAlice, {
    kind: "absent",
    externalUserid: "wo-audit-client",
    userid: alice,
    source: "delete_callback",
  });
  const editBob = await insertClaim(client, schema, {
    eventTime: 150,
    changeType: "edit_external_contact",
    userid: bob,
  });
  const independent = await applyPrepared(
    container,
    editBob,
    snapshot(bob, [follow(alice, 3), follow(bob, 4)], 2),
  );
  const staleAlice = await insertClaim(client, schema, {
    eventTime: 90,
    changeType: "add_external_contact",
    userid: alice,
  });
  const stale = await withTx(container, (tx) =>
    recordClientProjectionSeen(tx, staleAlice, staleAlice.eventTime));
  const restoreAlice = await insertClaim(client, schema, {
    eventTime: 250,
    changeType: "edit_external_contact",
    userid: alice,
  });
  const restored = await applyPrepared(
    container,
    restoreAlice,
    snapshot(alice, [follow(alice, 5), follow(bob, 6)], 3),
  );
  const omitAlice = await insertClaim(client, schema, {
    eventTime: 300,
    changeType: "edit_external_contact",
    userid: bob,
  });
  const omitted = await applyPrepared(
    container,
    omitAlice,
    snapshot(bob, [follow(bob, 7)], 4),
  );
  const racingAlice = await insertClaim(client, schema, {
    eventTime: 350,
    changeType: "edit_external_contact",
    userid: alice,
  });
  const racingSeen = await withTx(container, (tx) =>
    recordClientProjectionSeen(tx, racingAlice, racingAlice.eventTime));
  const newerBob = await insertClaim(client, schema, {
    eventTime: 400,
    changeType: "edit_external_contact",
    userid: bob,
  });
  const newerApplied = await applyPrepared(
    container,
    newerBob,
    snapshot(bob, [follow(alice, 8), follow(bob, 9)], 5),
  );
  let crossedFenceRejected = false;
  try {
    await withTx(container, (tx) => applyClientCurrentProjection(
      tx,
      racingAlice,
      snapshot(alice, [follow(alice, 10), follow(bob, 11)], 6),
      racingAlice.eventTime,
    ));
  } catch (error) {
    crossedFenceRejected = error instanceof EnterpriseWechatClientProjectionError
      && error.errorCode === "callback_client_snapshot_drift"
      && !error.terminal;
  }
  const retrySeen = await withTx(container, (tx) =>
    recordClientProjectionSeen(tx, racingAlice, racingAlice.eventTime));
  const retriedAfterNewFence = await withTx(container, (tx) =>
    applyClientCurrentProjection(
      tx,
      racingAlice,
      snapshot(alice, [follow(alice, 12), follow(bob, 13)], 7),
      racingAlice.eventTime,
    ));
  const audit = await withTx(container, (tx) =>
    auditClientProjectionRows(tx, "ww-audit-corp", ["wo-audit-client"]));
  await client.unsafe(`
    UPDATE ${quoteIdentifier(schema)}.work_callback_event
    SET status='ORDERED', projection_status='APPLIED', processed_time=update_time
    WHERE status='PROCESSING'
  `);
  const aliceRow = audit.follows.find((row) => row.userid === alice);
  const bobRow = audit.follows.find((row) => row.userid === bob);
  const clientRow = audit.clients[0];
  const assertions = {
    initial_snapshot_applied: initial === "applied",
    relationship_delete_applied: removed === "applied",
    older_other_relationship_applied: independent === "applied",
    stale_target_suppressed: stale === "superseded",
    only_target_callback_restored_tombstone: restored === "applied"
      && aliceRow?.lifecycleState === "ACTIVE",
    omission_did_not_delete_non_target: omitted === "applied"
      && aliceRow?.lifecycleState === "ACTIVE",
    direct_fences_are_per_relationship: audit.directFences.length === 2,
    both_follows_active: audit.follows.length === 2
      && audit.follows.every((row) => row.lifecycleState === "ACTIVE"),
    current_profile_is_latest_snapshot: clientRow?.lastEventId === newerBob.eventId
      && clientRow.lifecycleState === "ACTIVE",
    non_target_direct_provenance_preserved: bobRow?.lastEventId === newerBob.eventId,
    crossed_profile_fence_response_retried: racingSeen === "ready"
      && newerApplied === "applied"
      && crossedFenceRejected
      && retrySeen === "ready"
      && retriedAfterNewFence === "applied"
      && aliceRow?.lastEventId === racingAlice.eventId,
    tag_rows_replaced_not_accumulated: audit.tags.length === 2,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error("direct_client_service_assertions_failed");
  }
  const context = await contextScenario(container);
  return {
    assertions,
    context,
    checks_passed: Object.keys(assertions).length + context.checks_passed,
  };
}

async function verifierHash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  ));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function contextScenario(container: Container) {
  const makeStore = (state: string, verifier: string): WorkContextStateStore => {
    let available = true;
    return {
      async putOnce() { return true; },
      async take<T>(key: string) {
        if (!available || key !== `work_context:state:${state}`) return null;
        available = false;
        return {
          verifierHash: await verifierHash(verifier),
          origin: "https://work-audit.invalid",
          expiresAt: 2_000_000_000,
        } as T;
      },
    };
  };
  const exchange = async (authority: boolean, seed: string) => {
    const state = seed.repeat(64).slice(0, 64);
    const verifier = (seed === "a" ? "c" : "d").repeat(64);
    const service = new EnterpriseWechatContextService(container, {
      APP_KEY: "client-current-audit-signing-key-000000000000000000",
      WORK_WECHAT_ALLOWED_ORIGINS: "https://work-audit.invalid",
      WECHAT_WORK_CLIENT_CURRENT_AUTHORITY: authority ? "verified" : undefined,
    } as never, {
      now: () => 1_900_000_000,
      stateStore: makeStore(state, verifier),
      identityProvider: {
        async employeeIdentity() {
          return { corpId: "ww-audit-corp", agentId: 1, userid: " ALICE " };
        },
      },
    });
    return {
      service,
      result: service.exchange({
        origin: "https://work-audit.invalid",
        state,
        code: `${seed}-oauth-code`,
        cookieValue: `${state}.${verifier}`,
        target: { type: "client", externalUserid: "wo-audit-client" },
      }),
    };
  };
  const enabled = await exchange(true, "a");
  const enabledResult = await enabled.result;
  const info = await enabled.service.clientInfo(enabledResult.token);
  let authorityOffRejected = false;
  try {
    await (await exchange(false, "b")).result;
  } catch {
    authorityOffRejected = true;
  }
  const assertions = {
    current_scope_issued_token: enabledResult.target.type === "client",
    current_scope_reads_current_client: info.external_userid === "wo-audit-client"
      && info.name === "Audit Client 5",
    current_scope_uses_relationship_remark: info.remark === "remark-12",
    current_scope_uses_current_tags: info.tags.length === 1
      && info.tags[0]?.tag_name === "tag-name-12",
    actor_identity_case_normalized: info.external_userid === "wo-audit-client",
    authority_off_current_footprint_fails_closed: authorityOffRejected,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error(`client_context_assertions_failed:${Object.entries(assertions)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(",")}`);
  }
  return { assertions, checks_passed: Object.keys(assertions).length };
}

async function isolatedAudit(connectionString: string) {
  const schema = `${AUDIT_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  assertAuditSchema(schema);
  const admin = pgClient(connectionString, "cinashop_work_client_current_isolated_audit");
  let isolatedDb: ReturnType<typeof createDbFromConnectionString> | null = null;
  let schemaCreated = false;
  let schemaRemoved = false;
  let beforeInventory: Awaited<ReturnType<typeof inventory>> | null = null;
  let afterInventory: Awaited<ReturnType<typeof inventory>> | null = null;
  let result: Record<string, unknown> | null = null;
  let primaryError: unknown = null;
  const cleanupErrors: string[] = [];
  try {
    beforeInventory = await inventory(admin);
    await admin.unsafe(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    schemaCreated = true;
    await setupCallbackPrerequisite(admin, schema);
    isolatedDb = createDbFromConnectionString(connectionString, 1, {
      searchPath: schema,
      applicationName: "cinashop_work_client_current_schema_audit",
    });
    const container = createContainerFromDb(isolatedDb);
    await applyMigration(container);
    const firstMetadata = await targetMetadata(admin, schema);
    const firstFingerprint = await tableFingerprint(admin, schema, TARGET_TABLES);
    await applyMigration(container);
    const secondMetadata = await targetMetadata(admin, schema);
    const secondFingerprint = await tableFingerprint(admin, schema, TARGET_TABLES);
    const migrationAssertions = {
      five_projection_tables_created: secondMetadata.filter((row) =>
        row.kind === "relation" && TARGET_TABLES.includes(row.name as never)).length === 5,
      repeated_migration_preserved_oids_relfilenodes_and_definitions:
        sameJson(firstMetadata, secondMetadata),
      repeated_migration_preserved_empty_tuples:
        sameJson(firstFingerprint, secondFingerprint)
        && secondFingerprint.every((row) => row.rows === "0"),
      exact_projection_constraint_count:
        secondMetadata.filter((row) => row.kind === "constraint").length === 39,
    };
    if (!Object.values(migrationAssertions).every(Boolean)) {
      throw new Error("isolated_client_migration_assertions_failed");
    }
    const direct = await directServiceScenario(admin, schema, container);
    result = {
      complete: true,
      isolated_schema_only: true,
      migration_passes: 2,
      migration_assertions: migrationAssertions,
      direct_service: direct,
      failed_checks: [],
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (isolatedDb) {
      try { await isolatedDb.$client.end({ timeout: 1 }); } catch {
        cleanupErrors.push("isolated_client_close_failed");
      }
    }
    try {
      if (schemaCreated) await admin.unsafe(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      schemaRemoved = (await admin<Array<{ removed: boolean }>>`
        SELECT to_regnamespace(${schema}) IS NULL AS removed
      `)[0]?.removed ?? false;
      if (schemaCreated && !schemaRemoved) cleanupErrors.push("isolated_schema_not_removed");
    } catch { cleanupErrors.push("isolated_schema_cleanup_failed"); }
    try {
      afterInventory = await inventory(admin);
      if (beforeInventory && !sameJson(beforeInventory, afterInventory)) {
        cleanupErrors.push("public_catalog_changed_during_isolated_audit");
      }
    } catch { cleanupErrors.push("public_inventory_after_failed"); }
    try { await admin.end({ timeout: 1 }); } catch {
      cleanupErrors.push("admin_client_close_failed");
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new Error(`isolated_cleanup_failed:${cleanupErrors.join(",")}`);
  if (!result || !beforeInventory || !afterInventory) throw new Error("isolated_audit_incomplete");
  return {
    ...result,
    temporary_schema_removed: schemaRemoved,
    public_catalog_unchanged: sameJson(beforeInventory, afterInventory),
    public_catalog_digest: await sha256Json(afterInventory),
  };
}

async function productionAudit(connectionString: string) {
  const client = pgClient(connectionString, "cinashop_work_client_current_read_audit");
  try {
    const objects = await targetMetadata(client, "public");
    const fingerprints = await tableFingerprint(client, "public", [
      ...LEGACY_TABLES,
      ...TARGET_TABLES,
    ]);
    const inventoryRows = await inventory(client);
    const leakedSchemas = await client<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace
      WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}
    `;
    return {
      complete: true,
      read_only: true,
      production_schema: "public",
      table_count: inventoryRows.filter((row) => row.kind === "r").length,
      sequence_count: inventoryRows.filter((row) => row.kind === "S").length,
      target_object_count: objects.length,
      table_fingerprints: fingerprints,
      temporary_audit_schema_count: leakedSchemas[0]?.count ?? -1,
      inventory_digest: await sha256Json(inventoryRows),
    };
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function productionMigrate(connectionString: string) {
  const client = pgClient(connectionString, "cinashop_work_client_current_migrate_audit");
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_work_client_current_migration",
  });
  const container = createContainerFromDb(db);
  try {
    const beforeInventory = await inventory(client);
    const beforeLegacy = await tableFingerprint(client, "public", LEGACY_TABLES);
    const beforeTargets = await tableFingerprint(client, "public", TARGET_TABLES);
    await applyMigration(container);
    const firstMetadata = await targetMetadata(client, "public");
    const firstTargets = await tableFingerprint(client, "public", TARGET_TABLES);
    await applyMigration(container);
    const secondMetadata = await targetMetadata(client, "public");
    const afterTargets = await tableFingerprint(client, "public", TARGET_TABLES);
    const afterLegacy = await tableFingerprint(client, "public", LEGACY_TABLES);
    const afterInventory = await inventory(client);
    const beforeTableCount = beforeInventory.filter((row) => row.kind === "r").length;
    const beforeSequenceCount = beforeInventory.filter((row) => row.kind === "S").length;
    const targetsPreviouslyAbsent = beforeTargets.every((row) => row.rows === "missing");
    const assertions = {
      migration_objects_stable_on_second_pass: sameJson(firstMetadata, secondMetadata),
      target_rows_stable_on_second_pass: sameJson(firstTargets, afterTargets),
      projection_tables_empty: afterTargets.every((row) => row.rows === "0"),
      legacy_rows_mvcc_unchanged: sameJson(beforeLegacy, afterLegacy),
      table_delta_exact: afterInventory.filter((row) => row.kind === "r").length
        === beforeTableCount + (targetsPreviouslyAbsent ? 5 : 0),
      sequence_delta_exact: afterInventory.filter((row) => row.kind === "S").length
        === beforeSequenceCount + (targetsPreviouslyAbsent ? 1 : 0),
      exact_constraint_count:
        secondMetadata.filter((row) => row.kind === "constraint").length === 39,
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error("production_client_migration_assertions_failed");
    }
    return {
      complete: true,
      production_schema: "public",
      migration_passes: 2,
      targets_previously_absent: targetsPreviouslyAbsent,
      before: { table_count: beforeTableCount, sequence_count: beforeSequenceCount },
      after: {
        table_count: afterInventory.filter((row) => row.kind === "r").length,
        sequence_count: afterInventory.filter((row) => row.kind === "S").length,
      },
      assertions,
      target_metadata_digest: await sha256Json(secondMetadata),
      failed_checks: [],
    };
  } finally {
    await db.$client.end({ timeout: 1 });
    await client.end({ timeout: 1 });
  }
}

function noStoreJson(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { ...init, headers });
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  if (/cleanup/i.test(error.message)) return "cleanup_failed";
  if (/migration/i.test(error.message)) return "migration_failed";
  if (/direct_client_service/i.test(error.message)) return "service_assertion_failed";
  return "audit_failed";
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const detail = error.message.replace(
    new RegExp(`${AUDIT_SCHEMA_PREFIX}[0-9a-f]{32}`, "g"),
    `${AUDIT_SCHEMA_PREFIX}[redacted]`,
  );
  if (
    detail.length > 300
    || /(?:postgres(?:ql)?:\/\/|password|token|secret|authorization)/i.test(detail)
  ) return undefined;
  return detail;
}

export default {
  async fetch(request: Request, env: ClientCurrentAuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.search ||
      !["/audit", "/migrate", "/isolated"].includes(url.pathname)) {
      return noStoreJson({ error: "not_found" }, { status: 404 });
    }
    const expected = url.pathname === "/audit"
      ? env.AUDIT_READ_TOKEN_SHA256
      : url.pathname === "/migrate"
        ? env.AUDIT_MIGRATE_TOKEN_SHA256
        : env.AUDIT_ISOLATED_TOKEN_SHA256;
    if (!(await authorized(request, expected ?? ""))) {
      return noStoreJson({ error: "forbidden" }, { status: 403 });
    }
    const requestId = crypto.randomUUID();
    try {
      const result = url.pathname === "/audit"
        ? await productionAudit(env.HYPERDRIVE.connectionString)
        : url.pathname === "/migrate"
          ? await productionMigrate(env.HYPERDRIVE.connectionString)
          : await isolatedAudit(env.HYPERDRIVE.connectionString);
      return noStoreJson({ request_id: requestId, ...result });
    } catch (error) {
      console.error(JSON.stringify({
        event: "enterprise_wechat_client_current_audit_failed",
        request_id: requestId,
        error_code: safeError(error),
      }));
      return noStoreJson({
        error: "audit_failed",
        error_code: safeError(error),
        request_id: requestId,
        ...(safeErrorDetail(error) ? { error_detail: safeErrorDetail(error) } : {}),
      }, { status: 500 });
    }
  },
};
