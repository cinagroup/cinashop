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
  applyExternalTagCurrentProjection,
  recordExternalTagProjectionSeen,
} from "@/services/work/EnterpriseWechatExternalTagCurrentService";
import type {
  EnterpriseWechatExternalTagCatalogSnapshot,
  ExternalTagProjectionClaim,
  PreparedExternalTagProjection,
} from "@/services/work/EnterpriseWechatExternalTagProjection";
import { EnterpriseWechatCatalogService } from "@/services/work/EnterpriseWechatCatalogService";

interface AuditEnv {
  readonly HYPERDRIVE: Hyperdrive;
  readonly AUDIT_READ_TOKEN_SHA256: string;
  readonly AUDIT_MIGRATE_TOKEN_SHA256: string;
  readonly AUDIT_ISOLATED_TOKEN_SHA256: string;
}

// Keep the generated identifier below PostgreSQL's 63-byte identifier limit.
const AUDIT_SCHEMA_PREFIX = "codex_wtag_audit_";
const TARGET_TABLES = [
  "work_external_tag_group_current",
  "work_external_tag_current",
  "work_external_tag_projection_fence",
] as const;
const LEGACY_TABLES = ["work_label", "user_label", "user_label_cate"] as const;
const CORP_ID = "ww-tag-audit";

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
    return tx<Array<{ kind: string; name: string; oid: string; relfilenode: string }>>`
      SELECT relation.relkind::text AS kind, relation.relname AS name,
        relation.oid::text AS oid, relation.relfilenode::text AS relfilenode
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ${schema}
        AND relation.relkind IN ('r','S') AND NOT relation.relispartition
      ORDER BY relation.relkind, relation.relname
    `;
  });
}

async function tableFingerprint(
  client: postgres.Sql,
  schema: string,
  tables: readonly string[],
) {
  const output: Array<{ table: string; rows: string; digest: string }> = [];
  for (const table of tables) {
    const exists = (await client<Array<{ exists: boolean }>>`
      SELECT to_regclass(${`${schema}.${table}`}) IS NOT NULL AS exists
    `)[0]?.exists ?? false;
    if (!exists) {
      output.push({ table, rows: "missing", digest: "" });
      continue;
    }
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
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
  return client<Array<{
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
    WHERE namespace.nspname = ${schema} AND relation.relname = ANY(${[...TARGET_TABLES]})
    UNION ALL
    SELECT 'constraint', constraint_row.conname, table_row.relname,
      constraint_row.oid::text, NULL::text, pg_get_constraintdef(constraint_row.oid, true)
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = ${schema} AND table_row.relname = ANY(${[...TARGET_TABLES]})
    UNION ALL
    SELECT 'index', index_row.relname, table_row.relname,
      index_row.oid::text, index_row.relfilenode::text, pg_get_indexdef(index_row.oid)
    FROM pg_index AS index_meta
    JOIN pg_class AS index_row ON index_row.oid = index_meta.indexrelid
    JOIN pg_class AS table_row ON table_row.oid = index_meta.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = ${schema} AND table_row.relname = ANY(${[...TARGET_TABLES]})
    ORDER BY kind, table_name NULLS FIRST, name
  `;
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
    CREATE TABLE ${quoteIdentifier(schema)}.work_label (
      id serial PRIMARY KEY, corp_id varchar(18) NOT NULL DEFAULT '',
      group_id integer NOT NULL DEFAULT 0, group_name varchar(50) NOT NULL DEFAULT '',
      name varchar(50) NOT NULL DEFAULT '', sort integer NOT NULL DEFAULT 0,
      create_time integer NOT NULL DEFAULT 0
    )
  `);
}

async function applyMigration(container: Container) {
  const migration = new MigrationService(container)
    .workExternalTagCurrentProjectionMigrationSqlForVerification();
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
  eventTime: number,
  changeType: "create" | "update" | "delete" | "shuffle",
  payload: Record<string, string | number>,
): Promise<ExternalTagProjectionClaim> {
  const sequenceRank = changeType === "delete" ? 100 : changeType === "create" ? 10 : 50;
  const seed = eventTime * 100 + sequenceRank + Object.keys(payload).length;
  const eventKey = eventHex(seed);
  const subjectKeyHash = eventHex(seed + 100_000);
  const rows = await client.unsafe<Array<{ id: number }>>(`
    INSERT INTO ${quoteIdentifier(schema)}.work_callback_event
      (event_key,payload_hash,subject_key_hash,corp_id,msg_type,event_type,
       change_type,event_time,sequence_rank,payload,status,projection_status,
       received_time,update_time)
    VALUES ($1,$2,$3,$4,'event','change_external_tag',$5,$6,$7,$8::jsonb,
      'PROCESSING','PROCESSING',$6,$6)
    RETURNING id
  `, [eventKey, eventHex(seed + 200_000), subjectKeyHash, CORP_ID,
    changeType, eventTime, sequenceRank, JSON.stringify(payload)]);
  if (!rows[0]) throw new Error("direct_external_tag_callback_insert_failed");
  return {
    eventId: rows[0].id,
    eventKey,
    subjectKeyHash,
    eventTime,
    sequenceRank,
    corpId: CORP_ID,
    msgType: "event",
    eventType: "change_external_tag",
    changeType,
    payload,
  };
}

function catalogSnapshot(
  groups: EnterpriseWechatExternalTagCatalogSnapshot["groups"],
  scope: "tag" | "group" | "catalog",
  expectedRemoteId: string,
  strategyId = 0,
): EnterpriseWechatExternalTagCatalogSnapshot {
  return { strategyId, scope, expectedRemoteId, groups };
}

function group(groupId: string, tagIds: string[], seed: number) {
  return {
    groupId,
    groupName: `Group ${groupId} ${seed}`,
    sortOrder: seed,
    providerCreateTime: 10,
    deleted: false,
    tags: tagIds.map((tagId, index) => ({
      tagId,
      name: `Tag ${tagId} ${seed}`,
      sortOrder: seed + index,
      providerCreateTime: 11 + index,
      deleted: false,
    })),
  };
}

async function applyPrepared(
  container: Container,
  claim: ExternalTagProjectionClaim,
  prepared: PreparedExternalTagProjection,
) {
  const seen = await withTx(container, (tx) =>
    recordExternalTagProjectionSeen(tx, claim, claim.eventTime));
  if (seen === "superseded") return seen;
  return withTx(container, (tx) =>
    applyExternalTagCurrentProjection(tx, claim, prepared, claim.eventTime));
}

async function projectionRows(client: postgres.Sql, schema: string) {
  const qualified = quoteIdentifier(schema);
  // Hyperdrive may multiplex the raw audit client. Make every checkpoint one
  // explicit, sequential transaction so it observes a fresh coherent snapshot.
  return client.begin(async (tx) => {
    const groups = await tx.unsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM ${qualified}.work_external_tag_group_current ORDER BY strategy_id,group_id`,
    );
    const tags = await tx.unsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM ${qualified}.work_external_tag_current ORDER BY strategy_id,tag_id`,
    );
    const fences = await tx.unsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM ${qualified}.work_external_tag_projection_fence ORDER BY strategy_id,subject_type,remote_id`,
    );
    return { groups, tags, fences };
  });
}

async function directServiceScenario(
  client: postgres.Sql,
  schema: string,
  container: Container,
) {
  const create = await insertClaim(client, schema, 100, "create", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const initial = await applyPrepared(container, create, {
    kind: "snapshot",
    identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" },
    snapshot: catalogSnapshot([group("et-group-1", ["et-tag-1", "et-tag-2"], 1)], "group", "et-group-1"),
  });

  const update = await insertClaim(client, schema, 200, "update", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const omitted = await applyPrepared(container, update, {
    kind: "snapshot",
    identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" },
    snapshot: catalogSnapshot([group("et-group-1", ["et-tag-1"], 2)], "group", "et-group-1"),
  });
  const afterOmission = await projectionRows(client, schema);

  const noopClaim = await insertClaim(client, schema, 250, "update", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const noop = await applyPrepared(container, noopClaim, {
    kind: "snapshot",
    identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" },
    snapshot: catalogSnapshot([group("et-group-1", ["et-tag-1"], 2)], "group", "et-group-1"),
  });
  const staleClaim = await insertClaim(client, schema, 150, "update", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const stale = await withTx(container, (tx) =>
    recordExternalTagProjectionSeen(tx, staleClaim, staleClaim.eventTime));

  const racingClaim = await insertClaim(client, schema, 300, "update", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const racingSeen = await withTx(container, (tx) =>
    recordExternalTagProjectionSeen(tx, racingClaim, racingClaim.eventTime));
  const newerClaim = await insertClaim(client, schema, 400, "update", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const newerPrepared: PreparedExternalTagProjection = {
    kind: "snapshot",
    identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" },
    snapshot: catalogSnapshot([group("et-group-1", ["et-tag-1", "et-tag-3"], 4)], "group", "et-group-1"),
  };
  const newer = await applyPrepared(container, newerClaim, newerPrepared);
  const crossed = await withTx(container, (tx) =>
    applyExternalTagCurrentProjection(tx, racingClaim, {
      kind: "snapshot",
      identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" },
      snapshot: catalogSnapshot([group("et-group-1", ["et-tag-1"], 3)], "group", "et-group-1"),
    }, racingClaim.eventTime));

  const notFoundClaim = await insertClaim(client, schema, 450, "update", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const notFound = await applyPrepared(container, notFoundClaim, {
    kind: "not_found",
    identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" },
    source: "provider_not_found",
  });
  const afterNotFound = await projectionRows(client, schema);

  const tagDelete = await insertClaim(client, schema, 500, "delete", {
    TagType: "tag", Id: "et-tag-1",
  });
  const tagDeleted = await applyPrepared(container, tagDelete, {
    kind: "absent",
    identity: { strategyId: 0, subjectType: "tag", remoteId: "et-tag-1", scope: "tag" },
    source: "delete_callback",
  });
  const impossibleTag = await insertClaim(client, schema, 2_000, "update", {
    TagType: "tag", Id: "et-tag-1",
  });
  const impossibleTagSeen = await withTx(container, (tx) =>
    recordExternalTagProjectionSeen(tx, impossibleTag, impossibleTag.eventTime));

  const groupDelete = await insertClaim(client, schema, 600, "delete", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const groupDeleted = await applyPrepared(container, groupDelete, {
    kind: "absent",
    identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-1", scope: "group" },
    source: "delete_callback",
  });
  const impossibleGroup = await insertClaim(client, schema, 3_000, "update", {
    TagType: "tag_group", Id: "et-group-1",
  });
  const impossibleGroupSeen = await withTx(container, (tx) =>
    recordExternalTagProjectionSeen(tx, impossibleGroup, impossibleGroup.eventTime));

  const secondGroup = await insertClaim(client, schema, 700, "create", {
    TagType: "tag_group", Id: "et-group-2",
  });
  await applyPrepared(container, secondGroup, {
    kind: "snapshot",
    identity: { strategyId: 0, subjectType: "tag_group", remoteId: "et-group-2", scope: "group" },
    snapshot: catalogSnapshot([group("et-group-2", ["et-tag-4"], 7)], "group", "et-group-2"),
  });
  const shuffle = await insertClaim(client, schema, 800, "shuffle", {});
  const shuffled = await applyPrepared(container, shuffle, {
    kind: "snapshot",
    identity: { strategyId: 0, subjectType: "catalog", remoteId: "*", scope: "catalog" },
    snapshot: catalogSnapshot([], "catalog", "*"),
  });

  const strategy = await insertClaim(client, schema, 900, "create", {
    StrategyId: 17, TagType: "tag_group", Id: "et-strategy-group",
  });
  const strategyApplied = await applyPrepared(container, strategy, {
    kind: "snapshot",
    identity: { strategyId: 17, subjectType: "tag_group", remoteId: "et-strategy-group", scope: "group" },
    snapshot: catalogSnapshot(
      [group("et-strategy-group", ["et-strategy-tag"], 9)],
      "group",
      "et-strategy-group",
      17,
    ),
  });
  await client.unsafe(`
    UPDATE ${quoteIdentifier(schema)}.work_callback_event
    SET status='ORDERED', projection_status='APPLIED', processed_time=update_time
    WHERE id=$1
  `, [strategy.eventId]);
  // Catalog reads do not open their own transaction. Reuse the isolated
  // request transaction so its SET LOCAL search_path remains authoritative.
  const enabledCatalog = await withTx(container, (tx) =>
    new EnterpriseWechatCatalogService(createContainerFromDb(tx), {
      WECHAT_WORK_TAG_CURRENT_AUTHORITY: "verified",
      WECHAT_WORK_EXTERNAL_CONTACT_FULL_VISIBILITY: "verified",
    }).labels({}));
  const blockedCatalog = await withTx(container, (tx) =>
    new EnterpriseWechatCatalogService(createContainerFromDb(tx), {}).labels({}));

  const finalRows = await projectionRows(client, schema);
  const tag1 = finalRows.tags.find((row) => row.tag_id === "et-tag-1");
  const tag2 = afterOmission.tags.find((row) => row.tag_id === "et-tag-2");
  const tag3 = finalRows.tags.find((row) => row.tag_id === "et-tag-3");
  const group1 = finalRows.groups.find((row) => row.group_id === "et-group-1");
  const group2 = finalRows.groups.find((row) => row.group_id === "et-group-2");
  const strategyTag = finalRows.tags.find((row) => row.tag_id === "et-strategy-tag");
  const afterNotFoundGroup = afterNotFound.groups.find((row) => row.group_id === "et-group-1");
  const assertions = {
    initial_group_and_tags_applied: initial === "applied",
    group_snapshot_omission_tombstones_child: omitted === "applied"
      && tag2?.lifecycle_state === "DELETED",
    exact_repeat_is_business_noop: noop === "applied-noop",
    older_direct_callback_suppressed: stale === "superseded",
    provider_response_crossing_newer_fence_suppressed:
      racingSeen === "ready" && newer === "applied" && crossed === "superseded",
    provider_not_found_is_refresh_only: notFound === "refresh-required"
      && afterNotFoundGroup?.last_event_id === newerClaim.eventId,
    tag_delete_is_terminal: tagDeleted === "applied"
      && tag1?.lifecycle_state === "DELETED" && impossibleTagSeen === "superseded",
    group_delete_cascades_without_erasing_history: groupDeleted === "applied"
      && group1?.lifecycle_state === "DELETED"
      && tag3?.lifecycle_state === "DELETED"
      && impossibleGroupSeen === "superseded",
    full_shuffle_tombstones_omitted_catalog: shuffled === "applied"
      && group2?.lifecycle_state === "DELETED",
    strategy_identity_isolated: strategyApplied === "applied"
      && strategyTag?.strategy_id === 17 && strategyTag?.lifecycle_state === "ACTIVE",
    current_catalog_reads_only_closed_active_rows:
      enabledCatalog.count === 1
      && enabledCatalog.list[0]?.id === "et-strategy-tag",
    authority_off_current_footprint_fails_closed:
      blockedCatalog.count === 0
      && Number("blocked_current_rows" in blockedCatalog
        ? blockedCatalog.blocked_current_rows : 0) > 0,
    history_retained: finalRows.groups.length === 3 && finalRows.tags.length === 5,
  };
  if (!Object.values(assertions).every(Boolean)) {
    const diagnostic = [
      `nf=${notFound}/${String(afterNotFoundGroup?.last_event_id)}/${newerClaim.eventId}`,
      `td=${tagDeleted}/${String(tag1?.lifecycle_state)}/${impossibleTagSeen}`,
      `gd=${groupDeleted}/${String(group1?.lifecycle_state)}/${String(tag3?.lifecycle_state)}/${impossibleGroupSeen}`,
      `sh=${shuffled}/${String(group2?.lifecycle_state)}`,
      `st=${strategyApplied}/${String(strategyTag?.strategy_id)}/${String(strategyTag?.lifecycle_state)}`,
      `rows=${finalRows.groups.length}/${finalRows.tags.length}`,
    ].join(";");
    throw new Error(`direct_external_tag_service_diag:${diagnostic}`);
  }
  return { assertions, checks_passed: Object.keys(assertions).length };
}

async function isolatedAudit(connectionString: string) {
  const schema = `${AUDIT_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  assertAuditSchema(schema);
  const admin = pgClient(connectionString, "cinashop_work_external_tag_isolated_audit");
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
      applicationName: "cinashop_work_external_tag_schema_audit",
    });
    const container = createContainerFromDb(isolatedDb);
    await applyMigration(container);
    const firstMetadata = await targetMetadata(admin, schema);
    const firstFingerprint = await tableFingerprint(admin, schema, TARGET_TABLES);
    await applyMigration(container);
    const secondMetadata = await targetMetadata(admin, schema);
    const secondFingerprint = await tableFingerprint(admin, schema, TARGET_TABLES);
    const migrationAssertions = {
      three_projection_tables_created:
        secondMetadata.filter((row) => row.kind === "relation").length === 3,
      repeated_migration_preserved_oids_relfilenodes_and_definitions:
        sameJson(firstMetadata, secondMetadata),
      repeated_migration_preserved_empty_tuples:
        sameJson(firstFingerprint, secondFingerprint)
        && secondFingerprint.every((row) => row.rows === "0"),
      exact_projection_constraint_count:
        secondMetadata.filter((row) => row.kind === "constraint").length === 25,
      exact_projection_index_count:
        secondMetadata.filter((row) => row.kind === "index").length === 8,
      exact_closed_object_count: secondMetadata.length === 36,
    };
    if (!Object.values(migrationAssertions).every(Boolean)) {
      throw new Error("isolated_external_tag_migration_assertions_failed");
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
        cleanupErrors.push("isolated_external_tag_close_failed");
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
  const client = pgClient(connectionString, "cinashop_work_external_tag_read_audit");
  try {
    const objects = await targetMetadata(client, "public");
    const fingerprints = await tableFingerprint(client, "public", [
      ...LEGACY_TABLES, ...TARGET_TABLES,
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
  } finally { await client.end({ timeout: 1 }); }
}

async function productionMigrate(connectionString: string) {
  const client = pgClient(connectionString, "cinashop_work_external_tag_migrate_audit");
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_work_external_tag_migration",
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
        === beforeTableCount + (targetsPreviouslyAbsent ? 3 : 0),
      sequence_delta_exact: afterInventory.filter((row) => row.kind === "S").length
        === beforeSequenceCount,
      exact_constraint_count:
        secondMetadata.filter((row) => row.kind === "constraint").length === 25,
      exact_index_count:
        secondMetadata.filter((row) => row.kind === "index").length === 8,
      exact_closed_object_count: secondMetadata.length === 36,
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error("production_external_tag_migration_assertions_failed");
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
  if (/direct_external_tag_service/i.test(error.message)) return "service_assertion_failed";
  return "audit_failed";
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const detail = error.message.replace(
    new RegExp(`${AUDIT_SCHEMA_PREFIX}[0-9a-f]{32}`, "g"),
    `${AUDIT_SCHEMA_PREFIX}[redacted]`,
  );
  if (detail.length > 300
    || /(?:postgres(?:ql)?:\/\/|password|token|secret|authorization)/i.test(detail)) {
    return undefined;
  }
  return detail;
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.search
      || !["/audit", "/migrate", "/isolated"].includes(url.pathname)) {
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
        event: "enterprise_wechat_external_tag_current_audit_failed",
        request_id: requestId,
        error_code: safeError(error),
      }));
      const detail = safeErrorDetail(error);
      return noStoreJson({
        error: "audit_failed",
        error_code: safeError(error),
        request_id: requestId,
        ...(detail ? { error_detail: detail } : {}),
      }, { status: 500 });
    }
  },
};
