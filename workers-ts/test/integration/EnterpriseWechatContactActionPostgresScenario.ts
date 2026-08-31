import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import type { OrderMessage, WorkContactActionMessage } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
} from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import {
  EnterpriseWechatContactActionService,
  type WorkContactActionProvider,
} from "@/services/work/EnterpriseWechatContactActionService";
import { EnterpriseWechatProviderError } from "@/services/work/EnterpriseWechatProviderClient";

const SCHEMA_PREFIX = "codex_work_action_";
const CORP_ID = "ww-action-audit";
const CLONE_TABLES = [
  "work_callback_event",
  "work_callback_outbox",
  "work_client_current",
  "work_channel_code",
  "work_welcome",
  "work_welcome_relation",
  "work_external_tag_current",
  "wechat_user",
  "user",
] as const;

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertSchema(schema: string): void {
  if (!new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`).test(schema)) {
    throw new Error("unsafe_contact_action_schema");
  }
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

class AuditProvider implements WorkContactActionProvider {
  welcomeCalls = 0;
  tagCalls = 0;
  private firstWelcomeStartedResolve!: () => void;
  private firstWelcomeReleaseResolve!: () => void;
  readonly firstWelcomeStarted = new Promise<void>((resolve) => {
    this.firstWelcomeStartedResolve = resolve;
  });
  private readonly firstWelcomeRelease = new Promise<void>((resolve) => {
    this.firstWelcomeReleaseResolve = resolve;
  });

  releaseFirstWelcome(): void {
    this.firstWelcomeReleaseResolve();
  }

  async sendWelcome(): Promise<void> {
    this.welcomeCalls += 1;
    if (this.welcomeCalls === 1) {
      this.firstWelcomeStartedResolve();
      await this.firstWelcomeRelease;
      return;
    }
    throw new Error("unexpected_welcome_provider_call");
  }

  async markExternalContactTags(): Promise<void> {
    this.tagCalls += 1;
    if (this.tagCalls === 1) {
      throw new EnterpriseWechatProviderError(
        "unknown",
        "external_contact_mark_tag",
        -2,
        0,
      );
    }
    if (this.tagCalls === 2) return;
    throw new Error("unexpected_tag_provider_call");
  }
}

async function createIsolatedSchema(client: postgres.Sql, schema: string): Promise<void> {
  assertSchema(schema);
  await client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '2s'`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    await tx.unsafe(`CREATE SCHEMA ${quote(schema)}`);
    for (const table of CLONE_TABLES) {
      await tx.unsafe(
        `CREATE TABLE ${quote(schema)}.${quote(table)} `
        + `(LIKE public.${quote(table)} INCLUDING ALL)`,
      );
    }
  });
}

async function seed(container: Container, now: number): Promise<void> {
  const event = (
    id: number,
    changeType: "add_external_contact" | "edit_external_contact",
    externalUserid: string,
    userid: string,
    receivedTime: number,
    extra: Record<string, string> = {},
  ) => ({
    id,
    eventKey: id.toString(16).padStart(64, "0"),
    payloadHash: (id + 100).toString(16).padStart(64, "0"),
    subjectHash: (id + 200).toString(16).padStart(64, "0"),
    changeType,
    externalUserid,
    userid,
    receivedTime,
    payload: {
      MsgType: "event",
      Event: "change_external_contact",
      ChangeType: changeType,
      CreateTime: receivedTime,
      ExternalUserID: externalUserid,
      UserID: userid,
      ...extra,
    },
  });
  const events = [
    event(101, "add_external_contact", "external-a", "employee-a", now, {
      State: "channelCode-301", WelcomeCode: "welcome-a",
    }),
    event(102, "add_external_contact", "external-b", "employee-b", now, {
      State: "channelCode-303", WelcomeCode: "welcome-b",
    }),
    event(103, "add_external_contact", "external-c", "employee-c", now, {
      State: "channelCode-302", WelcomeCode: "welcome-c",
    }),
    event(104, "add_external_contact", "external-d", "employee-d", now - 120, {
      WelcomeCode: "welcome-d",
    }),
  ];

  await withTx(container, async (tx) => {
    for (const row of events) {
      await tx.execute(drizzleSql`
        INSERT INTO work_callback_event (
          id,event_key,payload_hash,subject_key_hash,corp_id,msg_type,event_type,
          change_type,event_time,sequence_rank,payload,status,projection_status,
          attempt_count,lease_until,lease_token,last_error_code,received_time,
          processed_time,payload_retained_until,payload_redacted_time,update_time
        ) VALUES (
          ${row.id},${row.eventKey},${row.payloadHash},${row.subjectHash},${CORP_ID},
          'event','change_external_contact',${row.changeType},${row.receivedTime},10,
          ${JSON.stringify(row.payload)}::jsonb,'ORDERED','APPLIED',1,0,'','',
          ${row.receivedTime},${now},${now + 2592000},0,${now}
        )
      `);
      await tx.execute(drizzleSql`
        INSERT INTO work_callback_outbox (
          id,event_id,event_key,status,dispatch_count,attempt_count,available_time,
          lease_until,lease_token,last_error_code,enqueued_time,processed_time,add_time,update_time
        ) VALUES (
          ${row.id},${row.id},${row.eventKey},'COMPLETED',1,1,${row.receivedTime},
          0,'','',${row.receivedTime},${now},${row.receivedTime},${now}
        )
      `);
    }

    const clients = [
      { id: 201, event: events[0], name: "Client A", unionid: "union-a" },
      { id: 202, event: events[1], name: "Client B", unionid: null },
      { id: 203, event: events[2], name: "Client C", unionid: "union-c" },
      { id: 204, event: events[3], name: "Client D", unionid: null },
    ];
    for (const client of clients) {
      await tx.execute(drizzleSql`
        INSERT INTO work_client_current (
          id,corp_id,external_userid,lifecycle_state,profile_complete,
          provider_snapshot_complete,uid,name,type,gender,unionid,external_profile,
          last_event_id,last_event_key,last_event_subject_key_hash,last_event_time,
          last_sequence_rank,create_time,update_time,inactive_time
        ) OVERRIDING SYSTEM VALUE VALUES (
          ${client.id},${CORP_ID},${client.event.externalUserid},'ACTIVE',true,true,
          NULL,${client.name},1,0,${client.unionid},'{}'::jsonb,${client.event.id},
          ${client.event.eventKey},${client.event.subjectHash},${client.event.receivedTime},
          10,${now},${now},NULL
        )
      `);
    }

    await tx.execute(drizzleSql`
      INSERT INTO work_channel_code (
        id,label_id,welcome_type,welcome_words,status,client_num,create_time,update_time
      ) VALUES
        (301,'["tag-1"]',0,${JSON.stringify({
          text: { content: "Hello ##客户名称##" }, attachments: [],
        })},1,0,${now},${now}),
        (302,'[]',0,${JSON.stringify({
          text: { content: "Legacy media" },
          attachments: [{ msgtype: "image", image: { pic_url: "https://invalid.example/image.png" } }],
        })},1,0,${now},${now}),
        (303,'[]',0,${JSON.stringify({
          text: { content: "Welcome B" }, attachments: [],
        })},1,0,${now},${now})
    `);

    await tx.execute(drizzleSql`
      INSERT INTO work_external_tag_current (
        corp_id,strategy_id,tag_id,group_id,lifecycle_state,snapshot_complete,
        name,sort_order,provider_create_time,last_event_id,last_event_key,
        last_event_subject_key_hash,last_event_time,last_sequence_rank,
        create_time,update_time,deleted_time
      ) VALUES (
        ${CORP_ID},0,'tag-1','group-1','ACTIVE',true,'Tag 1',1,${now},101,
        ${events[0].eventKey},${events[0].subjectHash},${events[0].receivedTime},10,
        ${now},${now},NULL
      )
    `);

    for (const identity of [
      { uid: 401, id: 501, unionid: "union-a", openid: "openid-a" },
      { uid: 402, id: 502, unionid: "union-c", openid: "openid-c1" },
      { uid: 403, id: 503, unionid: "union-c", openid: "openid-c2" },
    ]) {
      await tx.execute(drizzleSql`
        INSERT INTO "user" (uid,account,nickname,status,is_del,add_time)
        VALUES (${identity.uid},${`audit-${identity.uid}`},${`User ${identity.uid}`},1,0,${now})
      `);
      await tx.execute(drizzleSql`
        INSERT INTO wechat_user (id,uid,unionid,openid,is_del,add_time)
        VALUES (${identity.id},${identity.uid},${identity.unionid},${identity.openid},0,${now})
      `);
    }
  });
}

function claim(
  eventId: number,
  eventKey: string,
  changeType: "add_external_contact" | "edit_external_contact",
  receivedTime: number,
  payload: Record<string, string | number>,
) {
  return { eventId, eventKey, corpId: CORP_ID, changeType, receivedTime, payload };
}

function actionMessage(value: OrderMessage): value is WorkContactActionMessage {
  return value.action === "processWorkContactAction";
}

export async function runEnterpriseWechatContactActionScenario(connectionString: string) {
  const schema = `${SCHEMA_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
  assertSchema(schema);
  const admin = pgClient(connectionString, "cinashop_work_action_scenario_admin");
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: schema,
    applicationName: "cinashop_work_action_scenario_a",
  });
  const db2 = createDbFromConnectionString(connectionString, 1, {
    searchPath: schema,
    applicationName: "cinashop_work_action_scenario_b",
  });
  let schemaCreated = false;
  try {
    await createIsolatedSchema(admin, schema);
    schemaCreated = true;
    const container = createContainerFromDb(db);
    const container2 = createContainerFromDb(db2);
    const migration = new MigrationService(container);
    await withTx(container, async (tx) => {
      await tx.execute(drizzleSql.raw(migration.workContactActionOutboxMigrationSqlForVerification()));
    });
    await withTx(container, async (tx) => {
      await tx.execute(drizzleSql.raw(migration.workContactActionOutboxMigrationSqlForVerification()));
    });

    const now = Math.floor(Date.now() / 1000);
    await seed(container, now);
    const queued: OrderMessage[] = [];
    const queue = {
      async send(message: OrderMessage) { queued.push(message); },
    } as unknown as Queue<OrderMessage>;
    const provider = new AuditProvider();
    const env = {
      ORDER_QUEUE: queue,
      WECHAT_WORK_CONTACT_ACTION_AUTHORITY: "verified",
    };
    const service = new EnterpriseWechatContactActionService(
      container,
      env,
      () => provider,
    );
    const service2 = new EnterpriseWechatContactActionService(
      container2,
      env,
      () => provider,
    );

    const eventKeys = [101, 102, 103, 104].map((id) => id.toString(16).padStart(64, "0"));
    await withTx(container, async (tx) => {
      await service.enqueueProjectedClientActions(tx, claim(
        101, eventKeys[0], "add_external_contact", now,
        {
          ExternalUserID: "external-a", UserID: "employee-a",
          State: "channelCode-301", WelcomeCode: "welcome-a",
        },
      ), "applied", now);
      await service.enqueueProjectedClientActions(tx, claim(
        102, eventKeys[1], "add_external_contact", now,
        {
          ExternalUserID: "external-b", UserID: "employee-b",
          State: "channelCode-303", WelcomeCode: "welcome-b",
        },
      ), "applied", now);
      await service.enqueueProjectedClientActions(tx, claim(
        103, eventKeys[2], "add_external_contact", now,
        {
          ExternalUserID: "external-c", UserID: "employee-c",
          State: "channelCode-302", WelcomeCode: "welcome-c",
        },
      ), "applied", now);
      await service.enqueueProjectedClientActions(tx, claim(
        104, eventKeys[3], "add_external_contact", now - 120,
        {
          ExternalUserID: "external-d", UserID: "employee-d", WelcomeCode: "welcome-d",
        },
      ), "applied", now);
    });

    const inserted = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT count(*)::integer AS count FROM work_contact_action_outbox
    `));
    if (Number(inserted[0]?.count ?? 0) !== 12) throw new Error("scenario_action_insert_count");

    await service.dispatchForEvent(101);
    const eventA = queued.splice(0).filter(actionMessage);
    if (eventA.length !== 3) throw new Error("scenario_event_a_queue_count");
    if (eventA.some((message) => Object.keys(message).length !== 3)) {
      throw new Error("scenario_queue_payload_not_reference_only");
    }
    const firstWelcome = service.processMessage(eventA[0]);
    await provider.firstWelcomeStarted;
    const concurrentWelcome = await service2.processMessage(eventA[0]);
    provider.releaseFirstWelcome();
    const firstWelcomeResult = await firstWelcome;
    const eventAResults = [firstWelcomeResult];
    for (const message of eventA.slice(1)) eventAResults.push(await service.processMessage(message));
    if (concurrentWelcome !== "busy" || firstWelcomeResult !== "succeeded") {
      throw new Error("scenario_welcome_concurrency");
    }

    const replayResults = [];
    for (const message of eventA) replayResults.push(await service.processMessage(message));
    if (replayResults.some((result) => result !== "already-terminal")) {
      throw new Error("scenario_terminal_replay");
    }
    if (provider.welcomeCalls !== 1 || provider.tagCalls !== 1) {
      throw new Error("scenario_provider_duplicate_before_manual");
    }

    const tagAction = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT id::integer FROM work_contact_action_outbox
      WHERE event_id = 101 AND action_type = 'AUTO_TAG'
    `));
    await service.decide(7, Number(tagAction[0].id), {
      request_key: "11111111-1111-4111-8111-111111111111",
      operation: "RETRY_WITH_RISK",
      reason: "已完成企业微信后台对账并接受重复标签风险",
      risk_accepted: true,
    });
    await service.dispatchForEvent(101);
    const manualTag = queued.splice(0).filter(actionMessage);
    if (manualTag.length !== 1 || await service.processMessage(manualTag[0]) !== "succeeded") {
      throw new Error("scenario_manual_tag_retry");
    }

    await service.dispatchForEvent(102);
    const eventB = queued.splice(0).filter(actionMessage);
    if (eventB.length !== 2) throw new Error("scenario_event_b_queue_count");
    const welcomeBId = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT id::integer FROM work_contact_action_outbox
      WHERE event_id = 102 AND action_type = 'WELCOME_SEND'
    `));
    const welcomeActionId = Number(welcomeBId[0]?.id ?? 0);
    await withTx(container, async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE work_contact_action_outbox SET status = 'PROCESSING',
          lease_until = ${now - 1}, lease_token = 'expired-provider-lease',
          attempt_count = 1, update_time = ${now}
        WHERE id = ${welcomeActionId}
      `);
    });
    if (!eventB.some((message) => message.actionId === welcomeActionId)) {
      throw new Error("scenario_welcome_b_message_missing");
    }
    const eventBResults = new Map<number, Awaited<ReturnType<typeof service.processMessage>>>();
    for (const message of eventB) {
      eventBResults.set(message.actionId, await service.processMessage(message));
    }
    if (eventBResults.get(welcomeActionId) !== "unknown") {
      throw new Error("scenario_expired_provider_lease_not_unknown");
    }
    const welcomeB = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT id::integer,status FROM work_contact_action_outbox
      WHERE event_id = 102 AND action_type = 'WELCOME_SEND'
    `));
    if (welcomeB[0]?.status !== "UNKNOWN") throw new Error("scenario_welcome_unknown");
    await service.decide(7, Number(welcomeB[0].id), {
      request_key: "22222222-2222-4222-8222-222222222222",
      operation: "CONFIRM_SUCCEEDED",
      reason: "已在企业微信后台确认欢迎语成功送达客户",
      provider_reference: "audit-reference-b",
    });
    if (Number(provider.welcomeCalls) !== 1) throw new Error("scenario_welcome_manual_resend");

    await service.dispatchForEvent(103);
    const eventC = queued.splice(0).filter(actionMessage);
    if (eventC.length !== 1 || await service.processMessage(eventC[0]) !== "dead") {
      throw new Error("scenario_ambiguous_uid_dead");
    }
    const deadWelcome = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT id::integer,status FROM work_contact_action_outbox
      WHERE event_id = 103 AND action_type = 'WELCOME_SEND'
    `));
    if (deadWelcome[0]?.status !== "DEAD") throw new Error("scenario_legacy_media_dead");
    await service.decide(7, Number(deadWelcome[0].id), {
      request_key: "33333333-3333-4333-8333-333333333333",
      operation: "CLOSE",
      reason: "旧媒体尚未迁移为可发送素材，确认关闭本次动作",
    });

    await service.dispatchForEvent(104);
    const eventD = queued.splice(0).filter(actionMessage);
    if (eventD.length !== 1 || await service.processMessage(eventD[0]) !== "skipped") {
      throw new Error("scenario_expired_event_uid_skip");
    }

    await withTx(container, async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE work_callback_event SET payload_retained_until = ${now}
        WHERE id IN (101,102,104)
      `);
    });
    const redacted = await service.redactCompletedCallbackPayloads(10);
    if (redacted !== 3) throw new Error("scenario_callback_redaction_count");

    let immutableAuditBlocked = false;
    try {
      await withTx(container, async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE work_contact_action_audit SET reason = 'mutation forbidden'
          WHERE id = (SELECT min(id) FROM work_contact_action_audit)
        `);
      });
    } catch {
      immutableAuditBlocked = true;
    }

    const finalRows = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT status,count(*)::integer AS count
      FROM work_contact_action_outbox GROUP BY status ORDER BY status
    `));
    const finalStatuses = Object.fromEntries(finalRows.map((row) => [String(row.status), Number(row.count)]));
    const evidence = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT
        (SELECT count(*)::integer FROM work_contact_action_audit) AS manual_actions,
        (SELECT count(*)::integer FROM work_callback_event
          WHERE payload_redacted_time > 0 AND NOT (payload ? 'WelcomeCode')) AS redacted_callbacks,
        (SELECT count(*)::integer FROM work_callback_event
          WHERE id = 103 AND payload ? 'WelcomeCode' AND payload_redacted_time = 0) AS blocked_redaction,
        (SELECT sum(client_num)::integer FROM work_channel_code WHERE id IN (301,302,303)) AS channel_clients,
        (SELECT count(*)::integer FROM work_client_current WHERE uid = 401) AS linked_clients,
        (SELECT count(*)::integer FROM work_contact_action_outbox
          WHERE payload <> '{}'::jsonb AND status IN ('SUCCEEDED','SKIPPED','EXPIRED','CLOSED')) AS terminal_payload_leaks
    `));
    const assertions = {
      exact_action_count: Number(inserted[0]?.count ?? 0) === 12,
      reference_only_queue: eventA.every((message) => Object.keys(message).length === 3),
      concurrent_welcome_single_provider_call: concurrentWelcome === "busy" && Number(provider.welcomeCalls) === 1,
      partial_success_observed: eventAResults.includes("unknown") && eventAResults.includes("succeeded"),
      terminal_replay_no_provider_call: replayResults.every((result) => result === "already-terminal"),
      manual_tag_retry_succeeded: Number(provider.tagCalls) === 2,
      expired_provider_lease_unknown_not_resent: Number(provider.welcomeCalls) === 1,
      ambiguous_uid_failed_closed: finalStatuses.DEAD === 1,
      expired_welcome_terminal: finalStatuses.EXPIRED === 1,
      legacy_media_closed: finalStatuses.CLOSED === 1,
      all_other_actions_converged: finalStatuses.SUCCEEDED === 4 && finalStatuses.SKIPPED === 5,
      manual_audit_exact: Number(evidence[0]?.manual_actions ?? 0) === 3,
      manual_audit_immutable: immutableAuditBlocked,
      callback_payload_redacted: Number(evidence[0]?.redacted_callbacks ?? 0) === 3,
      unresolved_event_not_redacted: Number(evidence[0]?.blocked_redaction ?? 0) === 1,
      channel_count_exact_once: Number(evidence[0]?.channel_clients ?? 0) === 3,
      commerce_uid_linked: Number(evidence[0]?.linked_clients ?? 0) === 1,
      converged_payloads_scrubbed: Number(evidence[0]?.terminal_payload_leaks ?? 0) === 0,
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error("contact_action_scenario_assertions_failed");
    }
    return {
      schema_created: true,
      migration_passes: 2,
      assertions,
      final_statuses: finalStatuses,
      provider_calls: { welcome: provider.welcomeCalls, tag: provider.tagCalls },
      manual_actions: Number(evidence[0]?.manual_actions ?? 0),
      redacted_callbacks: Number(evidence[0]?.redacted_callbacks ?? 0),
    };
  } finally {
    await db.$client.end({ timeout: 1 });
    await db2.$client.end({ timeout: 1 });
    if (schemaCreated) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    }
    await admin.end({ timeout: 1 });
  }
}
