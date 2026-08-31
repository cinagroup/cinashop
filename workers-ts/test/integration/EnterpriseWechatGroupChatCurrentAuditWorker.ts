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
  applyGroupChatCurrentProjection,
  auditGroupChatProjectionRows,
  recordGroupChatProjectionSeen,
} from "@/services/work/EnterpriseWechatGroupChatCurrentService";
import type {
  EnterpriseWechatGroupChatMemberSnapshot,
  EnterpriseWechatGroupChatSnapshot,
  GroupChatProjectionClaim,
  PreparedGroupChatProjection,
} from "@/services/work/EnterpriseWechatGroupChatProjection";
import {
  EnterpriseWechatContextService,
  type WorkContextStateStore,
} from "@/services/work/EnterpriseWechatContextService";

interface GroupChatCurrentAuditEnv {
  readonly HYPERDRIVE: Hyperdrive;
  readonly AUDIT_READ_TOKEN_SHA256: string;
  readonly AUDIT_MIGRATE_TOKEN_SHA256: string;
  readonly AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_work_group_chat_current_";
const TARGET_TABLES = [
  "work_group_chat_current",
  "work_group_chat_projection_fence",
  "work_group_chat_member_current",
] as const;
const LEGACY_TABLES = ["work_group_chat", "work_group_chat_member"] as const;
const CORP_ID = "ww-audit-corp";
const CHAT_ID = "wr-audit-chat";

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
    return tx<Array<{
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
      name varchar(128),
      avatar varchar(1024),
      gender smallint,
      profile_complete boolean NOT NULL DEFAULT false,
      status smallint,
      enable smallint,
      last_event_id integer,
      last_event_key varchar(64),
      last_event_subject_key_hash varchar(64),
      last_event_time integer NOT NULL DEFAULT 0,
      last_sequence_rank integer NOT NULL DEFAULT 0
    );
    INSERT INTO ${quoteIdentifier(schema)}.work_member_current
      (id,corp_id,userid,canonical_userid,lifecycle_state,name,avatar,gender,
       profile_complete,status,enable)
    VALUES
      (1,'${CORP_ID}','alice','alice','ACTIVE','Alice','',1,true,1,1),
      (2,'${CORP_ID}','mallory','mallory','ACTIVE','Mallory','',2,true,1,1);
    INSERT INTO ${quoteIdentifier(schema)}.work_member_identity_alias
      (corp_id,userid,member_id,canonical_userid,lifecycle_state)
    VALUES
      ('${CORP_ID}','alice',1,'alice','ACTIVE'),
      ('${CORP_ID}','mallory',2,'mallory','ACTIVE')
  `);
}

async function applyMigration(container: Container) {
  const migration = new MigrationService(container)
    .workGroupChatCurrentProjectionMigrationSqlForVerification();
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
  changeType: "create" | "update" | "dismiss",
): Promise<GroupChatProjectionClaim> {
  const sequenceRank = changeType === "dismiss" ? 100 : changeType === "update" ? 20 : 10;
  const seed = eventTime * 10 + sequenceRank;
  const eventKey = eventHex(seed);
  const subjectKeyHash = eventHex(seed + 100_000);
  const payload = { ChatId: CHAT_ID };
  const rows = await client.unsafe<Array<{ id: number }>>(`
    INSERT INTO ${quoteIdentifier(schema)}.work_callback_event
      (event_key,payload_hash,subject_key_hash,corp_id,msg_type,event_type,
       change_type,event_time,sequence_rank,payload,status,projection_status,
       received_time,update_time)
    VALUES ($1,$2,$3,$4,'event','change_external_chat',$5,$6,$7,$8::jsonb,
      'PROCESSING','PROCESSING',$6,$6)
    RETURNING id
  `, [eventKey, eventHex(seed + 200_000), subjectKeyHash, CORP_ID,
    changeType, eventTime, sequenceRank, JSON.stringify(payload)]);
  if (!rows[0]) throw new Error("direct_group_callback_insert_failed");
  return {
    eventId: rows[0].id,
    eventKey,
    subjectKeyHash,
    eventTime,
    sequenceRank,
    corpId: CORP_ID,
    msgType: "event",
    eventType: "change_external_chat",
    changeType,
    payload,
  };
}

function employee(userid: string, seed: number): EnterpriseWechatGroupChatMemberSnapshot {
  return {
    userid,
    type: 1,
    unionid: null,
    joinTime: seed,
    joinScene: 1,
    invitorUserid: null,
    groupNickname: `${userid}-${seed}`,
    name: userid,
    state: `state-${seed}`,
  };
}

function external(userid: string, seed: number): EnterpriseWechatGroupChatMemberSnapshot {
  return {
    userid,
    type: 2,
    unionid: `union-${seed}`,
    joinTime: seed,
    joinScene: 1,
    invitorUserid: "alice",
    groupNickname: `external-${seed}`,
    name: `External ${seed}`,
    state: null,
  };
}

function snapshot(
  members: EnterpriseWechatGroupChatMemberSnapshot[],
  seed: number,
): EnterpriseWechatGroupChatSnapshot {
  return {
    chatId: CHAT_ID,
    name: `Audit Group ${seed}`,
    owner: "alice",
    groupCreatedTime: 10,
    notice: `notice-${seed}\nline-two`,
    adminList: ["alice"],
    providerStatus: 0,
    members: [...members].sort((left, right) => left.userid.localeCompare(right.userid)),
  };
}

async function applyPrepared(
  container: Container,
  claim: GroupChatProjectionClaim,
  prepared: PreparedGroupChatProjection,
) {
  const seen = await withTx(container, (tx) =>
    recordGroupChatProjectionSeen(tx, claim, claim.eventTime));
  if (seen === "superseded") return seen;
  return withTx(container, (tx) =>
    applyGroupChatCurrentProjection(tx, claim, prepared, claim.eventTime));
}

async function verifierHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

async function contextScenario(container: Container, groupId: number) {
  const exchange = async (
    seed: string,
    actorUserid: string,
    groupAuthority: boolean,
  ) => {
    const state = seed.repeat(64).slice(0, 64);
    const verifier = ({ a: "d", b: "e", c: "f" }[seed] ?? "0").repeat(64);
    let available = true;
    const store: WorkContextStateStore = {
      async putOnce() { return true; },
      async take<T>(key: string) {
        if (!available || key !== `work_context:state:${state}`) return null;
        available = false;
        return {
          verifierHash: await verifierHash(verifier),
          origin: "https://work-group-audit.invalid",
          expiresAt: 2_000_000_000,
        } as T;
      },
    };
    const service = new EnterpriseWechatContextService(container, {
      APP_KEY: "group-current-audit-signing-key-0000000000000000000",
      WORK_WECHAT_ALLOWED_ORIGINS: "https://work-group-audit.invalid",
      WECHAT_WORK_MEMBER_CURRENT_AUTHORITY: "verified",
      WECHAT_WORK_GROUP_CHAT_CURRENT_AUTHORITY: groupAuthority ? "verified" : undefined,
    } as never, {
      now: () => 1_900_000_000,
      stateStore: store,
      identityProvider: {
        async employeeIdentity() {
          return { corpId: CORP_ID, agentId: 1, userid: ` ${actorUserid.toUpperCase()} ` };
        },
      },
    });
    const result = await service.exchange({
      origin: "https://work-group-audit.invalid",
      state,
      code: `${seed}-oauth-code`,
      cookieValue: `${state}.${verifier}`,
      target: { type: "group", chatId: CHAT_ID },
    });
    return { service, result };
  };

  const enabled = await exchange("a", "alice", true);
  const info = await enabled.service.groupInfo(enabled.result.token);
  const members = await enabled.service.groupMembers(
    enabled.result.token,
    groupId,
    { name: "alice", page: "1", limit: "20" },
  );
  let authorityOffRejected = false;
  try { await exchange("b", "alice", false); } catch { authorityOffRejected = true; }
  let outsiderRejected = false;
  try { await exchange("c", "mallory", true); } catch { outsiderRejected = true; }
  const assertions = {
    current_group_scope_issued: enabled.result.target.type === "group",
    current_group_info_is_exact: info.id === groupId
      && info.name === "Audit Group 4"
      && info.member_num === 3
      && info.retreat_group_num === 1,
    current_employee_profile_used: members.count === 1
      && members.list[0]?.userid === "alice"
      && members.list[0]?.member?.name === "Alice",
    authority_off_current_footprint_fails_closed: authorityOffRejected,
    active_non_member_fails_closed: outsiderRejected,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error(`group_context_assertions_failed:${Object.entries(assertions)
      .filter(([, passed]) => !passed).map(([name]) => name).join(",")}`
      + `:info=${info.id}|${info.name}|${info.member_num}|${info.retreat_group_num}`
      + `:members=${members.count}|${members.list[0]?.userid ?? "-"}`
      + `|${members.list[0]?.member?.name ?? "-"}`);
  }
  return {
    assertions,
    checks_passed: Object.keys(assertions).length,
    service: enabled.service,
    token: enabled.result.token,
  };
}

async function directServiceScenario(
  client: postgres.Sql,
  schema: string,
  container: Container,
) {
  const alice = employee("alice", 1);
  const bob = employee("bob", 2);
  const ext = external("woExternalA", 3);
  const create = await insertClaim(client, schema, 100, "create");
  const initialSnapshot = snapshot([alice, ext], 1);
  const initial = await applyPrepared(container, create, {
    kind: "snapshot", chatId: CHAT_ID, snapshot: initialSnapshot,
  });

  const update = await insertClaim(client, schema, 200, "update");
  const reducedSnapshot = snapshot([alice, bob], 2);
  const omitted = await applyPrepared(container, update, {
    kind: "snapshot", chatId: CHAT_ID, snapshot: reducedSnapshot,
  });
  const afterOmission = await withTx(container, (tx) =>
    auditGroupChatProjectionRows(tx, CORP_ID, [CHAT_ID]));

  const noopClaim = await insertClaim(client, schema, 250, "update");
  const noop = await applyPrepared(container, noopClaim, {
    kind: "snapshot", chatId: CHAT_ID, snapshot: reducedSnapshot,
  });

  const rejoinClaim = await insertClaim(client, schema, 300, "update");
  const fullSnapshot = snapshot([alice, bob, ext], 3);
  const rejoined = await applyPrepared(container, rejoinClaim, {
    kind: "snapshot", chatId: CHAT_ID, snapshot: fullSnapshot,
  });

  const staleClaim = await insertClaim(client, schema, 150, "update");
  const stale = await withTx(container, (tx) =>
    recordGroupChatProjectionSeen(tx, staleClaim, staleClaim.eventTime));

  const racingClaim = await insertClaim(client, schema, 350, "update");
  const racingSeen = await withTx(container, (tx) =>
    recordGroupChatProjectionSeen(tx, racingClaim, racingClaim.eventTime));
  const newerClaim = await insertClaim(client, schema, 400, "update");
  const newerSnapshot = snapshot([alice, bob, ext], 4);
  const newer = await applyPrepared(container, newerClaim, {
    kind: "snapshot", chatId: CHAT_ID, snapshot: newerSnapshot,
  });
  const crossed = await withTx(container, (tx) =>
    applyGroupChatCurrentProjection(tx, racingClaim, {
      kind: "snapshot", chatId: CHAT_ID, snapshot: fullSnapshot,
    }, racingClaim.eventTime));

  await client.unsafe(`
    UPDATE ${quoteIdentifier(schema)}.work_callback_event
    SET status='ORDERED', projection_status='APPLIED', processed_time=update_time
    WHERE id=$1
  `, [newerClaim.eventId]);
  const afterNewer = await withTx(container, (tx) =>
    auditGroupChatProjectionRows(tx, CORP_ID, [CHAT_ID]));
  const currentGroupId = afterNewer.groups[0]?.id;
  if (!currentGroupId) throw new Error("group_context_identity_missing");
  const context = await contextScenario(container, currentGroupId);

  const notFoundClaim = await insertClaim(client, schema, 450, "update");
  const notFound = await applyPrepared(container, notFoundClaim, {
    kind: "not_found", chatId: CHAT_ID, source: "provider_not_found",
  });
  const afterNotFound = await withTx(container, (tx) =>
    auditGroupChatProjectionRows(tx, CORP_ID, [CHAT_ID]));

  const sameSecondUpdate = await insertClaim(client, schema, 500, "update");
  const sameSecondSeen = await withTx(container, (tx) =>
    recordGroupChatProjectionSeen(tx, sameSecondUpdate, sameSecondUpdate.eventTime));
  const dismiss = await insertClaim(client, schema, 500, "dismiss");
  const dismissed = await applyPrepared(container, dismiss, {
    kind: "absent", chatId: CHAT_ID, source: "dismiss_callback",
  });
  const updateAfterDismissSeen = await withTx(container, (tx) =>
    recordGroupChatProjectionSeen(tx, sameSecondUpdate, sameSecondUpdate.eventTime));
  const updateAfterDismissApply = await withTx(container, (tx) =>
    applyGroupChatCurrentProjection(tx, sameSecondUpdate, {
      kind: "snapshot", chatId: CHAT_ID, snapshot: newerSnapshot,
    }, sameSecondUpdate.eventTime));

  const impossibleLater = await insertClaim(client, schema, 2_000, "update");
  const impossibleLaterSeen = await withTx(container, (tx) =>
    recordGroupChatProjectionSeen(tx, impossibleLater, impossibleLater.eventTime));
  const finalAudit = await withTx(container, (tx) =>
    auditGroupChatProjectionRows(tx, CORP_ID, [CHAT_ID]));
  let dismissedTokenRejected = false;
  try { await context.service.groupInfo(context.token); } catch { dismissedTokenRejected = true; }
  const omittedExternal = afterOmission.members.find((row) => row.userid === ext.userid);
  const afterNotFoundGroup = afterNotFound.groups[0];
  const finalGroup = finalAudit.groups[0];
  const assertions = {
    initial_full_snapshot_applied: initial === "applied",
    omitted_member_tombstoned: omitted === "applied"
      && omittedExternal?.lifecycleState === "LEFT"
      && omittedExternal.leftTime === update.eventTime,
    departure_count_incremented_once: afterOmission.groups[0]?.departedMemberCount === 1,
    exact_repeat_is_business_noop: noop === "applied-noop",
    tombstone_can_rejoin_without_erasing_history: rejoined === "applied"
      && finalGroup?.departedMemberCount === 1,
    older_update_suppressed: stale === "superseded",
    provider_response_crossing_newer_fence_suppressed: racingSeen === "ready"
      && newer === "applied" && crossed === "superseded",
    provider_not_found_is_refresh_only: notFound === "refresh-required"
      && afterNotFoundGroup?.lifecycleState === "ACTIVE"
      && afterNotFoundGroup.lastEventId === newerClaim.eventId,
    dismiss_wins_same_second_update: sameSecondSeen === "ready"
      && dismissed === "applied"
      && updateAfterDismissSeen === "superseded"
      && updateAfterDismissApply === "superseded",
    impossible_later_update_cannot_revive: impossibleLaterSeen === "superseded"
      && finalGroup?.lifecycleState === "DISMISSED"
      && finalGroup.lastEventId === dismiss.eventId,
    dismiss_retains_member_history: finalAudit.members.length === 3
      && finalAudit.members.every((row) => row.lifecycleState === "DISMISSED")
      && finalAudit.members.every((row) => row.leftTime === dismiss.eventTime),
    one_group_one_fence: finalAudit.groups.length === 1 && finalAudit.fences.length === 1,
    dismissed_group_invalidates_old_token: dismissedTokenRejected,
  };
  if (!Object.values(assertions).every(Boolean)) {
    throw new Error(`direct_group_service_assertions_failed:${Object.entries(assertions)
      .filter(([, passed]) => !passed).map(([name]) => name).join(",")}`);
  }
  return {
    assertions,
    context: { assertions: context.assertions, checks_passed: context.checks_passed },
    checks_passed: Object.keys(assertions).length + context.checks_passed,
  };
}

async function isolatedAudit(connectionString: string) {
  const schema = `${AUDIT_SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  assertAuditSchema(schema);
  const admin = pgClient(connectionString, "cinashop_work_group_chat_current_isolated_audit");
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
      applicationName: "cinashop_work_group_chat_current_schema_audit",
    });
    const container = createContainerFromDb(isolatedDb);
    await applyMigration(container);
    const firstMetadata = await targetMetadata(admin, schema);
    const firstFingerprint = await tableFingerprint(admin, schema, TARGET_TABLES);
    await applyMigration(container);
    const secondMetadata = await targetMetadata(admin, schema);
    const secondFingerprint = await tableFingerprint(admin, schema, TARGET_TABLES);
    const migrationAssertions = {
      three_projection_tables_created: secondMetadata.filter((row) =>
        row.kind === "relation" && TARGET_TABLES.includes(row.name as never)).length === 3,
      repeated_migration_preserved_oids_relfilenodes_and_definitions:
        sameJson(firstMetadata, secondMetadata),
      repeated_migration_preserved_empty_tuples:
        sameJson(firstFingerprint, secondFingerprint)
        && secondFingerprint.every((row) => row.rows === "0"),
      exact_projection_constraint_count:
        secondMetadata.filter((row) => row.kind === "constraint").length === 26,
      exact_projection_index_count:
        secondMetadata.filter((row) => row.kind === "index").length === 11,
      exact_closed_object_count: secondMetadata.length === 40,
    };
    if (!Object.values(migrationAssertions).every(Boolean)) {
      throw new Error("isolated_group_migration_assertions_failed");
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
        cleanupErrors.push("isolated_group_close_failed");
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
  const client = pgClient(connectionString, "cinashop_work_group_chat_current_read_audit");
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
  const client = pgClient(connectionString, "cinashop_work_group_chat_current_migrate_audit");
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_work_group_chat_current_migration",
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
        === beforeSequenceCount + (targetsPreviouslyAbsent ? 2 : 0),
      exact_constraint_count:
        secondMetadata.filter((row) => row.kind === "constraint").length === 26,
      exact_index_count:
        secondMetadata.filter((row) => row.kind === "index").length === 11,
      exact_closed_object_count: secondMetadata.length === 40,
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error("production_group_migration_assertions_failed");
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
  if (/direct_group_service/i.test(error.message)) return "service_assertion_failed";
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
  async fetch(request: Request, env: GroupChatCurrentAuditEnv): Promise<Response> {
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
        event: "enterprise_wechat_group_chat_current_audit_failed",
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
