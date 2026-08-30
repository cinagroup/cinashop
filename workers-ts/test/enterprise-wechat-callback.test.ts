import { readFileSync } from "node:fs";
import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decryptCallbackCipher,
  encryptedXmlValue,
  normalizeDecryptedCallback,
  verifyCallbackSignature,
} from "../src/services/work/EnterpriseWechatCallbackCrypto";
import {
  consumeWorkCallbackQueueMessage,
  EnterpriseWechatCallbackService,
  isWorkCallbackDispatchMessage,
  isWorkCallbackOutboxMessage,
} from "../src/services/work/EnterpriseWechatCallbackService";
import { MigrationService } from "../src/services/MigrationService";
import { exactStatusConstraint } from "./integration/EnterpriseWechatCallbackAuditWorker";

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const encodingAesKey = key.toString("base64").slice(0, -1);
const corpId = "ww-callback-test";
const token = "callback-token";

function encryptedMessage(message: string, receiveId = corpId): string {
  const messageBytes = Buffer.from(message);
  const receiveBytes = Buffer.from(receiveId);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBytes.byteLength);
  const plain = Buffer.concat([Buffer.alloc(16, 7), length, messageBytes, receiveBytes]);
  const padding = 32 - (plain.byteLength % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function signature(timestamp: string, nonce: string, encrypted: string): string {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

describe("Enterprise WeChat callback protocol", () => {
  it("verifies SHA-1 and decrypts protocol padding up to 32 bytes", async () => {
    const xml = `<xml><ToUserName><![CDATA[${corpId}]]></ToUserName><FromUserName><![CDATA[sys]]></FromUserName><CreateTime>1788048000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[change_external_chat]]></Event><ChangeType><![CDATA[update]]></ChangeType><ChatId><![CDATA[wr-chat-1]]></ChatId><UpdateDetail><![CDATA[add_member]]></UpdateDetail></xml>`;
    const encrypted = encryptedMessage(xml);
    const query = { timestamp: "1788048001", nonce: "nonce-1", signature: "" };
    query.signature = signature(query.timestamp, query.nonce, encrypted);
    await expect(verifyCallbackSignature(query, encrypted, token)).resolves.toBeUndefined();
    expect(decryptCallbackCipher(encrypted, encodingAesKey, corpId)).toBe(xml);

    const normalized = normalizeDecryptedCallback(xml, corpId);
    expect(normalized).toMatchObject({
      corpId,
      msgType: "event",
      eventType: "change_external_chat",
      changeType: "update",
      eventTime: 1788048000,
      subjectKey: "external-chat:wr-chat-1",
      sequenceRank: 50,
      recognized: true,
    });
  });

  it("rejects forged signatures and receive-id confusion", async () => {
    const encrypted = encryptedMessage("<xml><MsgType>event</MsgType></xml>");
    await expect(verifyCallbackSignature({
      timestamp: "1788048001",
      nonce: "nonce-2",
      signature: "0".repeat(40),
    }, encrypted, token)).rejects.toThrow("callback_signature_invalid");
    expect(() => decryptCallbackCipher(encrypted, encodingAesKey, "another-corp"))
      .toThrow("callback_receive_id_mismatch");
  });

  it("stores only allowlisted fields and keeps external tag ids as strings", () => {
    const xml = `<xml><ToUserName>${corpId}</ToUserName><FromUserName>sys</FromUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>change_external_tag</Event><ChangeType>delete</ChangeType><Id><![CDATA[etXXXXXXXXXXXX]]></Id><TagType>tag</TagType><Content>must-not-persist</Content></xml>`;
    const normalized = normalizeDecryptedCallback(xml, corpId);
    expect(normalized.subjectKey).toBe("external-tag:tag:etXXXXXXXXXXXX");
    expect(normalized.sequenceRank).toBe(100);
    expect(normalized.payload.Id).toBe("etXXXXXXXXXXXX");
    expect(normalized.payload).not.toHaveProperty("Content");
  });

  it("scopes external-contact ordering to one employee follow relationship", () => {
    const callback = (userid: string) => `<xml><ToUserName>${corpId}</ToUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>change_external_contact</Event><ChangeType>del_follow_user</ChangeType><ExternalUserID>wo-client-1</ExternalUserID><UserID>${userid}</UserID></xml>`;
    const first = normalizeDecryptedCallback(callback("employee-a"), corpId);
    const second = normalizeDecryptedCallback(callback("employee-b"), corpId);
    expect(first.subjectKey).toBe("external-contact:wo-client-1:follow:employee-a");
    expect(second.subjectKey).toBe("external-contact:wo-client-1:follow:employee-b");
    expect(first.subjectKey).not.toBe(second.subjectKey);
    expect(first.recognized).toBe(true);
    expect(() => normalizeDecryptedCallback(
      callback("").replace("<UserID></UserID>", ""),
      corpId,
    )).toThrow("callback_field_invalid");
    expect(() => normalizeDecryptedCallback(callback("employee&#10;a"), corpId))
      .toThrow("callback_field_invalid");
  });

  it("case-folds Enterprise WeChat member identities before ordering", () => {
    const callback = (userid: string) => `<xml><ToUserName>${corpId}</ToUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>change_contact</Event><ChangeType>update_user</ChangeType><UserID>${userid}</UserID></xml>`;
    expect(normalizeDecryptedCallback(callback("Member-A"), corpId).subjectKey)
      .toBe("member:member-a");
    expect(normalizeDecryptedCallback(callback("member-a"), corpId).subjectKey)
      .toBe("member:member-a");
  });

  it("rejects XML entities/DOCTYPE and malformed wrappers", () => {
    expect(() => encryptedXmlValue("<!DOCTYPE xml><xml><Encrypt>x</Encrypt></xml>"))
      .toThrow("callback_xml_invalid");
    expect(() => encryptedXmlValue("<xml><Encrypt>&unknown;</Encrypt></xml>"))
      .toThrow("callback_xml_invalid");
    expect(() => encryptedXmlValue("<Encrypt>x</Encrypt>"))
      .toThrow("callback_xml_invalid");
  });
});

describe("Enterprise WeChat callback durable pipeline", () => {
  it("accepts only opaque callback queue messages", () => {
    const valid = {
      action: "processWorkCallbackOutbox",
      outboxId: 7,
      eventId: 11,
      eventKey: "a".repeat(64),
    };
    expect(isWorkCallbackOutboxMessage(valid)).toBe(true);
    expect(isWorkCallbackOutboxMessage({ ...valid, corpId })).toBe(false);
    expect(isWorkCallbackOutboxMessage({ ...valid, eventKey: "external-user-id" })).toBe(false);
    expect(isWorkCallbackOutboxMessage({ ...valid, eventId: 0 })).toBe(false);
  });

  it("accepts only the exact scheduled dispatch message shape", () => {
    const valid = {
      action: "dispatchWorkCallbackOutbox",
      scheduledAt: 1788048000,
    };
    expect(isWorkCallbackDispatchMessage(valid)).toBe(true);
    expect(isWorkCallbackDispatchMessage({ ...valid, eventKey: "a".repeat(64) })).toBe(false);
    expect(isWorkCallbackDispatchMessage({ ...valid, scheduledAt: 0 })).toBe(false);
    expect(isWorkCallbackDispatchMessage({ action: "processWorkCallbackOutbox", scheduledAt: 1788048000 })).toBe(false);
  });

  it("acks durable terminal outcomes and retries busy or failed Queue deliveries", async () => {
    const body = {
      action: "processWorkCallbackOutbox" as const,
      outboxId: 7,
      eventId: 11,
      eventKey: "a".repeat(64),
    };
    const ack = vi.fn();
    const retry = vi.fn();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await consumeWorkCallbackQueueMessage(
        { body, attempts: 1, ack, retry },
        { processMessage: vi.fn().mockResolvedValue("applied") },
      );
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();

      ack.mockClear();
      await consumeWorkCallbackQueueMessage(
        { body, attempts: 1, ack, retry },
        { processMessage: vi.fn().mockResolvedValue("busy") },
      );
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenLastCalledWith({ delaySeconds: 30 });

      retry.mockClear();
      await consumeWorkCallbackQueueMessage(
        { body, attempts: 1, ack, retry },
        { processMessage: vi.fn().mockResolvedValue({ kind: "deferred", delaySeconds: 137 }) },
      );
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenLastCalledWith({ delaySeconds: 137 });

      ack.mockClear();
      retry.mockClear();
      await consumeWorkCallbackQueueMessage(
        { body, attempts: 8, ack, retry },
        { processMessage: vi.fn().mockResolvedValue({ kind: "parked" }) },
      );
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();

      ack.mockClear();
      retry.mockClear();
      await consumeWorkCallbackQueueMessage(
        { body, attempts: 2, ack, retry },
        { processMessage: vi.fn().mockRejectedValue(new Error("projection_failed")) },
      );
      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  it("drains callback replay in bounded pages and stops after a short page", async () => {
    const service = new EnterpriseWechatCallbackService(
      {} as never,
      { ORDER_QUEUE: {} } as never,
    );
    const dispatch = vi.spyOn(service, "dispatchPending")
      .mockResolvedValueOnce({ claimed: 20, enqueued: 20 })
      .mockResolvedValueOnce({ claimed: 20, enqueued: 20 })
      .mockResolvedValueOnce({ claimed: 7, enqueued: 7 });

    await expect(service.dispatchPendingPages(20, 5)).resolves.toEqual({
      claimed: 47,
      enqueued: 47,
      batches: 3,
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls.map(([limit]) => limit)).toEqual([20, 20, 20]);
  });

  it("caps one scheduled callback drain at one hundred rows", async () => {
    const service = new EnterpriseWechatCallbackService(
      {} as never,
      { ORDER_QUEUE: {} } as never,
    );
    const dispatch = vi.spyOn(service, "dispatchPending")
      .mockImplementation(async (limit = 20) => ({ claimed: limit, enqueued: limit }));

    await expect(service.dispatchPendingPages(30, 10)).resolves.toEqual({
      claimed: 100,
      enqueued: 100,
      batches: 4,
    });
    expect(dispatch.mock.calls.map(([limit]) => limit)).toEqual([30, 30, 30, 10]);
  });

  it("does not classify legacy empty-handler event variants as restored", () => {
    const variants = [
      ["change_contact", "update_tag", "<Id>1</Id>"],
      ["change_external_contact", "add_half_external_contact", "<ExternalUserID>wo-half</ExternalUserID>"],
      ["change_external_contact", "transfer_fail", "<ExternalUserID>wo-transfer</ExternalUserID>"],
      ["change_external_tag", "shuffle", "<TagType>tag</TagType><Id>et-tag</Id>"],
      ["batch_job_result", "", "<JobType>sync_user</JobType><JobId>job-1</JobId>"],
    ];
    for (const [event, change, fields] of variants) {
      const xml = `<xml><ToUserName>${corpId}</ToUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>${event}</Event><ChangeType>${change}</ChangeType>${fields}</xml>`;
      expect(normalizeDecryptedCallback(xml, corpId).recognized).toBe(false);
    }
  });

  it("keeps external and embedded migration SQL identical", () => {
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    for (const [externalPath, migration] of [
      ["migrations/0109_work_callback_pipeline.sql", "0115"],
      ["migrations/0110_work_callback_follow_projection.sql", "0116"],
      ["migrations/0111_work_callback_projection_state.sql", "0117"],
      ["migrations/0112_work_member_current_projection.sql", "0118"],
      ["migrations/0113_work_member_resolved_rename_fence.sql", "0119"],
    ] as const) {
      const external = readFileSync(externalPath, "utf8");
      const embedded = service.match(
        new RegExp("private migration_" + migration + "\\(\\): string \\{\\s*return `([\\s\\S]*?)`;\\s*\\}"),
      )?.[1];
      expect(embedded).toBe(external);
      expect(service).toContain(`this.migration_${migration}()`);
    }
    expect(service).toContain("workCallbackFollowProjectionMigrationSqlForVerification");
    expect(service).toContain("workCallbackProjectionStateMigrationSqlForVerification");
    expect(service).toContain("workMemberCurrentProjectionMigrationSqlForVerification");
    expect(service).toContain("workMemberResolvedRenameFenceMigrationSqlForVerification");
    expect(service).toContain("workDepartmentCurrentProjectionMigrationSqlForVerification");
    expect(service).toContain("this.migration_0120()");
    expect(service).toContain('if (i < 115 && msg.includes("already exists"))');

    const departmentProjectionMigration = readFileSync(
      "migrations/0114_work_department_current_projection.sql",
      "utf8",
    );
    expect(new MigrationService({} as never)
      .workDepartmentCurrentProjectionMigrationSqlForVerification())
      .toBe(departmentProjectionMigration);
    expect((departmentProjectionMigration.match(/^\s*CREATE TABLE IF NOT EXISTS/gm) ?? []))
      .toHaveLength(3);
    expect(departmentProjectionMigration).toContain("wce_department_ref_uq");
    expect(departmentProjectionMigration).toContain("wdc_last_event_fk");
    expect(departmentProjectionMigration).toContain("wdpf_last_event_fk");
    expect(departmentProjectionMigration).toContain("ON DELETE RESTRICT");
    expect(departmentProjectionMigration).toContain("sort_order DESC");
    expect(departmentProjectionMigration).toContain(
      "x.indoption::text=expected_record.key_options",
    );
    expect(departmentProjectionMigration).toContain(
      "ARRAY['corp_id','parent_department_id','sort_order','department_id']::text[],'0 0 3 0'",
    );
    expect(departmentProjectionMigration).toContain("indnullsnotdistinct");
    expect(departmentProjectionMigration).toContain("unexpected constraint set");
    expect(departmentProjectionMigration).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+work_department|DELETE\s+FROM|DROP\s+TABLE)\b/i,
    );

    const projectionMigration = readFileSync(
      "migrations/0111_work_callback_projection_state.sql",
      "utf8",
    );
    expect(projectionMigration).toContain('"projection_status" IS DISTINCT FROM CASE "status"');
    expect(projectionMigration).toContain("constraint_row.convalidated");
    expect(projectionMigration).toContain("NOT constraint_row.connoinherit");
    expect(projectionMigration).toContain(
      "constraint_row.conkey = ARRAY[column_row.attnum]::smallint[]",
    );
    expect(projectionMigration).toContain("status_normalized <> 'checkstatus=anyarray[");

    const memberProjectionMigration = readFileSync(
      "migrations/0112_work_member_current_projection.sql",
      "utf8",
    );
    expect((memberProjectionMigration.match(/^CREATE TABLE IF NOT EXISTS/gm) ?? [])).toHaveLength(4);
    expect(memberProjectionMigration).toContain('CREATE TABLE IF NOT EXISTS "work_member_current"');
    expect(memberProjectionMigration).toContain('CREATE TABLE IF NOT EXISTS "work_member_identity_alias"');
    expect(memberProjectionMigration).toContain('CREATE TABLE IF NOT EXISTS "work_member_other_current"');
    expect(memberProjectionMigration).toContain('CREATE TABLE IF NOT EXISTS "work_member_relation_current"');
    expect(memberProjectionMigration).not.toMatch(
      /ALTER TABLE "(?:work_member|work_member_other|work_member_relation)"/,
    );
    expect(memberProjectionMigration).not.toMatch(/\bDROP (?:TABLE|INDEX|CONSTRAINT)\b/i);
    expect(memberProjectionMigration).toContain('"name" varchar(128)');
    expect(memberProjectionMigration).toContain('"email" varchar(254)');
    expect(memberProjectionMigration).toContain('"qr_code" varchar(1024)');
    expect(memberProjectionMigration).toContain('"main_department" integer');
    expect(memberProjectionMigration).toContain('"direct_leader" text');
    expect(memberProjectionMigration).toContain('"profile_complete" boolean NOT NULL DEFAULT false');
    expect(memberProjectionMigration).toContain('"relations_complete" boolean NOT NULL DEFAULT false');
    expect(memberProjectionMigration).toContain('"userid" = lower("userid")');
    expect(memberProjectionMigration).toContain(
      'CHECK ("lifecycle_state" IN (\'ACTIVE\', \'DELETED\'))',
    );
    expect(memberProjectionMigration).toContain(
      'CHECK ("lifecycle_state" IN (\'UNRESOLVED\', \'ACTIVE\', \'RENAMED\', \'DELETED\'))',
    );
    const currentTable = memberProjectionMigration.slice(
      memberProjectionMigration.indexOf('CREATE TABLE IF NOT EXISTS "work_member_current"'),
      memberProjectionMigration.indexOf('CREATE TABLE IF NOT EXISTS "work_member_identity_alias"'),
    );
    const aliasTable = memberProjectionMigration.slice(
      memberProjectionMigration.indexOf('CREATE TABLE IF NOT EXISTS "work_member_identity_alias"'),
      memberProjectionMigration.indexOf('CREATE TABLE IF NOT EXISTS "work_member_other_current"'),
    );
    expect(currentTable).not.toContain('"link_event_id"');
    expect(currentTable).not.toContain('"link_event_time"');
    expect(currentTable).not.toContain('"link_sequence_rank"');
    expect(aliasTable).toContain('"member_id" integer,');
    expect(aliasTable).not.toContain('"member_id" integer NOT NULL');
    expect(aliasTable).toContain('"link_event_id" integer,');
    expect(aliasTable).toContain('"link_event_time" integer NOT NULL DEFAULT 0');
    expect(aliasTable).toContain('"link_sequence_rank" integer NOT NULL DEFAULT 0');
    expect(memberProjectionMigration).toContain(
      'FOREIGN KEY ("corp_id", "member_id")\n      REFERENCES "work_member_current" ("corp_id", "id")',
    );
    expect(memberProjectionMigration).toContain(
      '("userid" <> "canonical_userid" AND "link_event_id" IS NOT NULL)',
    );
    expect(memberProjectionMigration).toContain(
      '"lifecycle_state" = \'DELETED\'\n          AND "userid" = "canonical_userid"',
    );
    expect(memberProjectionMigration).toContain('"sort_order" bigint NOT NULL DEFAULT 0');
    expect(memberProjectionMigration).toContain(
      '"sort_order" BETWEEN 0 AND 4294967295',
    );
    expect(memberProjectionMigration).toContain("Last-applied callback fence");
    expect(memberProjectionMigration).toContain("Latest-seen callback fence");
    for (const exactObject of [
      "wmc_values_ck",
      "wmia_link_event_fk",
      "wmia_link_fence_ck",
      "wmia_pending_source_idx",
      "wmia_link_event_idx",
      "wmoc_values_ck",
    ]) {
      expect(memberProjectionMigration).toContain(exactObject);
    }
    expect(memberProjectionMigration).not.toContain("wmoc_time_ck");
    expect(memberProjectionMigration).toContain("actual_shape IS DISTINCT FROM expected_shape");
    expect(memberProjectionMigration).toContain(
      "attribute.attgenerated <> ''",
    );
    expect(memberProjectionMigration).toContain(
      "attribute.attcollation <> attribute_type.typcollation",
    );
    expect(memberProjectionMigration).toContain("DO $work_current_identity$");
    expect(memberProjectionMigration).toContain("FROM pg_sequence AS sequence_catalog");
    expect(memberProjectionMigration).toContain(
      "next_sequence_value <= maximum_member_id",
    );
    expect(memberProjectionMigration).toContain(
      "actual_definition IS DISTINCT FROM reference_definition",
    );
    expect(memberProjectionMigration).toContain(
      "pg_get_expr(index_metadata.indpred, index_metadata.indrelid)",
    );
    expect(memberProjectionMigration).not.toContain(
      "lower(regexp_replace(\n        pg_get_constraintdef",
    );
    expect(memberProjectionMigration).toContain("IF NOT index_compatible THEN");

    const resolvedRenameFenceMigration = readFileSync(
      "migrations/0113_work_member_resolved_rename_fence.sql",
      "utf8",
    );
    expect(resolvedRenameFenceMigration).toContain(
      "0113 cannot infer immutable edge fences",
    );
    expect(resolvedRenameFenceMigration).toContain(
      "wmia_resolved_link_required_ck",
    );
    expect(resolvedRenameFenceMigration).toContain(
      "wmia_guard_renamed_link_0113",
    );
    expect(resolvedRenameFenceMigration).toContain(
      "OLD.lifecycle_state = 'RENAMED'",
    );

    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain(
      "return c.json({ ok: false, dropped, migrated: result.executed, errors: result.errors }, 500)",
    );
    expect(routes).toContain(
      "return c.json({ ok: false, migrated: result.executed, errors: result.errors }, 500)",
    );

    const auditWorker = readFileSync(
      "test/integration/EnterpriseWechatCallbackAuditWorker.ts",
      "utf8",
    );
    expect(auditWorker).toContain("ctid::text AS tuple_identity");
    expect(auditWorker).toContain("xmin::text AS tuple_xmin");
    expect(auditWorker).toContain("projection_migration_tuple_identity_stable");
  });

  it("stops immediately when a modern migration fails", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    let transactionNumber = 0;
    const transaction = vi.fn(async (work: (tx: { execute: typeof execute }) => Promise<void>) => {
      const current = transactionNumber++;
      if (current === 115) throw new Error("modern_exact_verifier_failed");
      await work({ execute });
    });
    const service = new MigrationService({ db: { transaction } } as never);

    const result = await service.runAll();

    expect(transaction).toHaveBeenCalledTimes(116);
    expect(result.executed).toHaveLength(115);
    expect(result.errors).toEqual(["0115: modern_exact_verifier_failed"]);
  });

  it("requires the complete validated status CHECK shape", () => {
    const statuses = [
      "RECEIVED",
      "PROCESSING",
      "ORDERED",
      "APPLIED",
      "APPLIED_NOOP",
      "SUPERSEDED",
      "IGNORED",
      "FAILED",
      "DEAD",
    ] as const;
    const values = statuses.map((status) => `'${status}'::character varying`).join(", ");
    const definition = `CHECK (((status)::text = ANY ((ARRAY[${values}])::text[])))`;
    const exact = {
      name: "wce_status_ck",
      definition,
      convalidated: true,
      connoinherit: false,
      conkey_exact: true,
    };
    expect(exactStatusConstraint(exact, "status", statuses)).toBe(true);
    expect(exactStatusConstraint({
      ...exact,
      definition: `CHECK (((status)::text <> ALL ((ARRAY[${values}])::text[])))`,
    }, "status", statuses)).toBe(false);
    expect(exactStatusConstraint({
      ...exact,
      definition: `CHECK ((((status)::text = ANY ((ARRAY[${values}])::text[])) OR true))`,
    }, "status", statuses)).toBe(false);
    expect(exactStatusConstraint({ ...exact, convalidated: false }, "status", statuses)).toBe(false);
    expect(exactStatusConstraint({ ...exact, connoinherit: true }, "status", statuses)).toBe(false);
    expect(exactStatusConstraint({ ...exact, conkey_exact: false }, "status", statuses)).toBe(false);
  });

  it("does not make provider calls in the HTTP callback controller", () => {
    const controller = readFileSync("src/controllers/api/v1/EnterpriseWechatController.ts", "utf8");
    const receive = controller.slice(
      controller.indexOf("export async function callbackReceive"),
      controller.indexOf("/** GET /api/work/config"),
    );
    expect(receive).not.toMatch(/qyapi\.weixin\.qq\.com|fetch\s*\(/);
    expect(receive).toContain("dispatchById(received.outboxId)");
    expect(receive).not.toContain("received.eventKey");
  });

  it("maps CorpID storage failures separately from secret configuration failures", () => {
    const service = readFileSync("src/services/work/EnterpriseWechatCallbackService.ts", "utf8");
    const configMethod = service.slice(
      service.indexOf("private async config()"),
      service.indexOf("private protocolError"),
    );
    expect(configMethod).toContain('EnterpriseWechatCallbackError(errorCode(error), "storage")');
    expect(configMethod).toContain('EnterpriseWechatCallbackError("callback_corp_id_unconfigured", "configuration")');
    expect(service).toContain('WECHAT_WORK_DIRECTORY_FULL_VISIBILITY !== "verified"');
    expect(service).toContain("WECHAT_WORK_MEMBER_CURRENT_AUTHORITY");
    expect(service).toContain("WECHAT_WORK_DEPARTMENT_CURRENT_AUTHORITY");
    expect(service).toContain('event.changeType === "delete_user"');
    expect(service).toContain('event.changeType === "delete_party"');
    expect(service).toContain('const MEMBER_PROJECTION_DISABLED = "member_projection_disabled"');
    expect(service).toContain('const DEPARTMENT_PROJECTION_DISABLED = "department_projection_disabled"');
    expect(service).toContain("recordParkedMemberProjectionSeen(tx, row, now)");
    expect(service).toContain("recordDepartmentProjectionSeen(tx, row, now)");
    expect(service).toContain("ne(workCallbackOutbox.lastErrorCode, MEMBER_PROJECTION_DISABLED)");
    expect(service).toContain("eq(workCallbackOutbox.lastErrorCode, MEMBER_PROJECTION_DISABLED)");
    expect(service).toContain("ne(workCallbackOutbox.lastErrorCode, DEPARTMENT_PROJECTION_DISABLED)");
    expect(service).toContain("eq(workCallbackOutbox.lastErrorCode, DEPARTMENT_PROJECTION_DISABLED)");
    const disabledMemberClaim = service.indexOf(
      "if (isMemberProjectionEvent(row) && !this.memberCurrentProjectionEnabled(row))",
    );
    const failedBackoff = service.indexOf(
      'if (row.outboxStatus === "FAILED" && row.outboxAvailableTime > now)',
    );
    expect(disabledMemberClaim).toBeGreaterThan(-1);
    expect(failedBackoff).toBeGreaterThan(disabledMemberClaim);
    const disabledDepartmentClaim = service.indexOf(
      "if (isDepartmentProjectionEvent(row) && !this.departmentCurrentProjectionEnabled(row))",
    );
    expect(disabledDepartmentClaim).toBeGreaterThan(disabledMemberClaim);
    expect(failedBackoff).toBeGreaterThan(disabledDepartmentClaim);
    expect(service).not.toContain("cron dispatch will enqueue it again without exhausting");
    expect(service).toContain('return { kind: "parked" as const }');
    expect(service).toContain('"configuration", "directory_visibility_gate"');
  });
});
