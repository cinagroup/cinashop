import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { main as migrationMain } from "../scripts/mysql-to-postgres";
import {
  buildSchemaAudit,
  comparePostgresDefinitions,
  mergePostgresAlterColumns,
  parseCreateTables,
} from "../scripts/data-migration/schema-audit";
import {
  addTableCounts,
  buildTransferPlans,
  canonicalColumnValue,
  compareVerificationBatch,
  convertRowForTarget,
  copyEligibleTables,
  decodeCheckpointCursor,
  decodeMultisetCheckpointCursor,
  hasDuplicateSourceMigrationKeys,
  integerRangeBlocker,
  quoteMysqlIdentifier,
  readSourceBatch,
  readSourceMultisetGroups,
  runCursorBatches,
  runKeysetBatches,
  safeErrorLabel,
  selectMultisetBatch,
  validateApplyTarget,
  validateBatchSize,
  validateIncreasingKeyTupleBatch,
  type DatabaseInventory,
  type KeysetProgress,
  type LiveColumn,
} from "../scripts/data-migration/runner";

function column(
  table: string,
  name: string,
  dataType: string,
  overrides: Partial<LiveColumn> = {},
): LiveColumn {
  return {
    table,
    name,
    dataType,
    nullable: false,
    hasDefault: false,
    identity: false,
    primaryKey: false,
    ...overrides,
  };
}

function findAlterBeforeCreate(sources: Array<{ name: string; sql: string }>): string[] {
  const created = new Set<string>();
  const failures: string[] = [];
  const definitionPattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"|ALTER\s+TABLE\s+"([^"]+)"/gi;
  for (const source of sources) {
    for (const match of source.sql.matchAll(definitionPattern)) {
      if (match[1]) created.add(match[1].toLowerCase());
      if (match[2] && !created.has(match[2].toLowerCase())) {
        failures.push(`${source.name}:${match[2]}`);
      }
    }
  }
  return failures;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MySQL to PostgreSQL schema audit", () => {
  it("parses inline and table-level primary keys without splitting numeric type commas", () => {
    const mysql = parseCreateTables(
      `
      CREATE TABLE IF NOT EXISTS \`eb_user\` (
        \`uid\` bigint NOT NULL PRIMARY KEY AUTO_INCREMENT,
        \`balance\` decimal(12, 2) NOT NULL DEFAULT '0.00'
      ) ENGINE=InnoDB;
      CREATE TABLE IF NOT EXISTS \`eb_right\` (
        \`id\` int NOT NULL,
        \`kind\` varchar(20) NOT NULL,
        PRIMARY KEY (\`id\`, \`kind\`) USING BTREE
      ) ENGINE=InnoDB;
      `,
      "mysql",
    );

    expect(mysql.get("eb_user")?.primaryKey).toEqual(["uid"]);
    expect(mysql.get("eb_user")?.columns.get("balance")?.definition).toContain("decimal(12, 2)");
    expect(mysql.get("eb_right")?.primaryKey).toEqual(["id", "kind"]);

    const cache = parseCreateTables(
      `
      CREATE TABLE IF NOT EXISTS \`eb_cache\` (
        \`key\` varchar(32) NOT NULL DEFAULT '',
        \`result\` longtext NULL,
        PRIMARY KEY (\`key\`) USING BTREE
      ) ENGINE=InnoDB;
      `,
      "mysql",
    );
    expect(cache.get("eb_cache")?.primaryKey).toEqual(["key"]);
  });

  it("merges multi-column PostgreSQL ALTER TABLE additions", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS "orders" ("id" SERIAL PRIMARY KEY);
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "status" SMALLINT DEFAULT 0 NOT NULL,
        ADD COLUMN IF NOT EXISTS "memo" VARCHAR(50) DEFAULT '' NOT NULL;
    `;
    const tables = parseCreateTables(sql, "postgres");
    mergePostgresAlterColumns(tables, sql);
    expect([...tables.get("orders")!.columns.keys()]).toEqual(["id", "status", "memo"]);
  });

  it("parses current-schema format DDL with static PostgreSQL table and column identifiers", () => {
    const tables = parseCreateTables(
      `
      EXECUTE format($ddl$
        CREATE TABLE IF NOT EXISTS %I.work_department_current (
          corp_id varchar(18) NOT NULL,
          department_id integer NOT NULL,
          profile_complete boolean NOT NULL DEFAULT false
        )
      $ddl$, target_schema);
      `,
      "postgres",
    );

    expect([...tables.keys()]).toEqual(["work_department_current"]);
    expect([...tables.get("work_department_current")!.columns.keys()]).toEqual([
      "corp_id",
      "department_id",
      "profile_complete",
    ]);
  });

  it("keeps the first duplicate CREATE definition because IF NOT EXISTS does not add columns", () => {
    const tables = parseCreateTables(
      `
        CREATE TABLE IF NOT EXISTS "users" ("id" SERIAL PRIMARY KEY, "name" TEXT);
        CREATE TABLE IF NOT EXISTS "users" ("id" SERIAL PRIMARY KEY, "status" SMALLINT);
      `,
      "postgres",
    );
    expect([...tables.get("users")!.columns.keys()]).toEqual(["id", "name"]);
  });

  it("audits an explicitly renamed source table as one logical shared table", () => {
    const report = buildSchemaAudit(
      "CREATE TABLE `eb_express` (`id` int NOT NULL PRIMARY KEY, `name` varchar(50) NOT NULL);",
      'CREATE TABLE "express_company" ("id" INTEGER PRIMARY KEY, "name" VARCHAR(64) NOT NULL);',
      "eb_",
      [{ table: "express_company", sourceTable: "express", key: ["id"], phase: "commerce" }],
    );

    expect(report.sharedTableCount).toBe(1);
    expect(report.sourceOnlyTables).toEqual([]);
    expect(report.targetOnlyTables).toEqual([]);
    expect(report.sharedTables[0]).toMatchObject({
      sourceTable: "express",
      table: "express_company",
      sourceOnlyColumns: [],
      targetOnlyColumns: [],
    });
  });

  it("keeps the explicit manifest aligned with all currently shared repository tables", () => {
    const sourceSql = readFileSync(
      resolve(import.meta.dirname, "../../../cinashop-php/public/install/crmeb.sql"),
      "utf8",
    );
    const migrationsDirectory = resolve(import.meta.dirname, "../migrations");
    const migrationFiles = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const migrationSources = migrationFiles.map((name) => ({
      name,
      sql: readFileSync(resolve(migrationsDirectory, name), "utf8"),
    }));
    const externalTargetSql = migrationSources.map(({ sql }) => sql).join("\n");
    const embeddedMigrationsDirectory = resolve(import.meta.dirname, "../src/migrations");
    const embeddedMigrationSources = readdirSync(embeddedMigrationsDirectory)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => ({
        name,
        sql: readFileSync(resolve(embeddedMigrationsDirectory, name), "utf8"),
      }));
    const embeddedTargetSql = [
      readFileSync("src/services/MigrationService.ts", "utf8"),
      ...embeddedMigrationSources.map(({ sql }) => sql),
    ].join("\n");
    const report = buildSchemaAudit(sourceSql, externalTargetSql);
    const definitionDrift = comparePostgresDefinitions(externalTargetSql, embeddedTargetSql);

    expect(report.sourceTableCount).toBe(201);
    expect(report.targetTableCount).toBe(247);
    expect(report.sharedTableCount).toBe(201);
    expect(report.sourceColumnCompleteTableCount).toBe(201);
    expect(report.sourceColumnGapTableCount).toBe(0);
    expect(report.sourceOnlyTables).toEqual([]);
    expect(report.targetOnlyTables).toEqual([
      "data_migration_checkpoint",
      "data_migration_run",
      "kefu_visitor_session",
      "luck_lottery_entitlement",
      "order_notification_delivery",
      "order_notification_delivery_action",
      "order_print_job",
      "order_print_job_action",
      "order_waybill_job",
      "order_waybill_job_action",
      "out_api_audit",
      "out_coupon_write_replay",
      "out_product_write_replay",
      "out_user_write_replay",
      "store_order_outbox",
      "store_order_product_coupon_reward",
      "store_order_refund_payment",
      "store_service_transfer",
      "system_queue_dead_letter",
      "system_virtual_inventory_export",
      "user_message",
      "video",
      "video_comment",
      "work_callback_event",
      "work_callback_outbox",
      "work_callback_watermark",
      "work_client_current",
      "work_client_follow_current",
      "work_client_follow_projection_fence",
      "work_client_follow_tag_current",
      "work_client_projection_fence",
      "work_contact_action_audit",
      "work_contact_action_outbox",
      "work_department_current",
      "work_department_leader_current",
      "work_department_projection_fence",
      "work_external_tag_current",
      "work_external_tag_group_current",
      "work_external_tag_projection_fence",
      "work_group_chat_current",
      "work_group_chat_member_current",
      "work_group_chat_projection_fence",
      "work_member_current",
      "work_member_identity_alias",
      "work_member_other_current",
      "work_member_relation_current",
    ]);
    expect(MIGRATION_TABLES.map((table) => table.table).sort()).toEqual(
      report.sharedTables.map((table) => table.table).sort(),
    );
    expect(definitionDrift).toEqual({
      externalTableCount: 247,
      workerTableCount: 247,
      externalOnlyTables: [],
      workerOnlyTables: [],
      columnDrift: [],
    });
    for (const tableName of [
      "store_order",
      "store_order_economize",
      "store_order_invoice",
      "store_order_promotions",
      "store_order_writeoff",
      "store_delivery_order",
      "delivery_service",
      "system_store",
      "system_store_staff",
      "store_user",
      "store_config",
      "store_branch_product",
      "store_branch_product_attr_value",
      "store_extract",
      "supplier_ticket_print",
      "print_document",
      "store_integral_order",
      "store_integral_order_status",
      "capital_flow",
      "store_finance_flow",
      "store_activity",
      "store_activity_relation",
      "store_discounts",
      "store_discounts_products",
      "store_promotions",
      "store_promotions_auxiliary",
      "store_order_refund",
      "store_product_words",
      "category",
      "store_product_unit",
      "store_product_rule",
      "store_product_specs",
      "store_product_virtual",
      "system_group",
      "system_group_data",
      "system_config_tab",
      "system_form",
      "system_form_data",
      "user_group",
      "user_label_relation",
      "system_admin",
      "user",
      "user_recharge",
      "store_seckill_time",
      "community",
      "community_comment",
      "community_topic",
      "community_relevance",
      "community_user",
      "store_coupon_user",
      "system_log",
      "system_message",
      "user_label",
      "store_product_reply_comment",
      "shipping_templates",
      "express_company",
      "system_article",
      "system_city",
      "city_area",
      "article_category",
      "article_content",
      "agreement",
      "system_dise",
      "notification_template",
      "system_notification",
      "system_notice",
      "system_notice_admin",
      "user_notice",
      "user_notice_see",
    ]) {
      expect(
        report.sharedTables.find((table) => table.table === tableName)?.sourceOnlyColumns,
      ).toEqual([]);
    }
    expect(
      report.sharedTables.find((table) => table.table === "store_coupon_user")?.targetOnlyColumns,
    ).toEqual(["type"]);
    expect(
      report.sharedTables.find((table) => table.table === "system_log")?.targetOnlyColumns,
    ).toEqual(["action"]);
    expect(
      report.sharedTables.find((table) => table.table === "system_message")?.targetOnlyColumns,
    ).toEqual(["event_key", "status"]);
    expect(
      report.sharedTables.find((table) => table.table === "user_label")?.targetOnlyColumns,
    ).toEqual(["add_time", "color", "sort", "status"]);
    expect(
      report.sharedTables.find((table) => table.table === "store_product_reply_comment")
        ?.targetOnlyColumns,
    ).toEqual(["avatar", "is_del", "nickname"]);
    expect(
      report.sharedTables.find((table) => table.table === "shipping_templates")
        ?.targetOnlyColumns,
    ).toEqual(["is_del", "status"]);

    expect(findAlterBeforeCreate(migrationSources)).toEqual([]);
    expect(findAlterBeforeCreate([
      { name: "MigrationService.ts", sql: readFileSync("src/services/MigrationService.ts", "utf8") },
      ...embeddedMigrationSources,
    ])).toEqual([]);
  });
});

describe("live migration safety plan", () => {
  it("uses an explicit source table name while retaining the target checkpoint name", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        ["eb_express", [column("eb_express", "id", "int", { primaryKey: true })]],
      ]),
      target: new Map([
        ["express_company", [column("express_company", "id", "integer", { primaryKey: true })]],
      ]),
    };

    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "express_company", sourceTable: "express", key: ["id"], phase: "commerce" },
    ]);

    expect(plan.sourceTable).toBe("eb_express");
    expect(plan.spec.table).toBe("express_company");
    expect(plan.eligible).toBe(true);
  });

  it("accepts a scalar text primary key and records binary keyset semantics", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        ["eb_cache", [
          column("eb_cache", "key", "varchar", { primaryKey: true, characterMaximumLength: 32 }),
          column("eb_cache", "result", "longtext", { nullable: true }),
        ]],
      ]),
      target: new Map([
        ["cache", [
          column("cache", "key", "character varying", { primaryKey: true, characterMaximumLength: 32 }),
          column("cache", "result", "text", { nullable: true }),
        ]],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "cache", key: ["key"], phase: "identity" },
    ]);

    expect(plan.eligible).toBe(true);
    expect(plan.keyKinds).toEqual(["text"]);
    expect(plan.blockers).toEqual([]);
  });

  it("plans sequence synchronization for copied identity columns outside a scalar key", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        ["eb_member_card", [
          column("eb_member_card", "id", "int", { primaryKey: true, identity: true }),
          column("eb_member_card", "card_batch_id", "int", { primaryKey: true }),
          column("eb_member_card", "card_number", "varchar"),
        ]],
      ]),
      target: new Map([
        ["member_card", [
          column("member_card", "id", "integer", { primaryKey: true, identity: true }),
          column("member_card", "card_batch_id", "integer", { primaryKey: true }),
          column("member_card", "card_number", "character varying"),
        ]],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      {
        table: "member_card",
        key: ["id", "card_batch_id"],
        phase: "identity",
      },
    ]);

    expect(plan.eligible).toBe(true);
    expect(plan.keyKinds).toEqual(["integer", "integer"]);
    expect(plan.targetIdentityColumns).toEqual(["id"]);
  });

  it("rejects duplicate logical source or target table assignments", () => {
    expect(() =>
      buildTransferPlans({ source: new Map(), target: new Map() }, "eb_", [
        { table: "target_a", sourceTable: "legacy", key: ["id"], phase: "commerce" },
        { table: "target_b", sourceTable: "legacy", key: ["id"], phase: "commerce" },
      ]),
    ).toThrow("Migration source table legacy is assigned to multiple targets");

    expect(() =>
      buildTransferPlans({ source: new Map(), target: new Map() }, "eb_", [
        { table: "target_a", sourceTable: "legacy_a", key: ["id"], phase: "commerce" },
        { table: "target_a", sourceTable: "legacy_b", key: ["id"], phase: "commerce" },
      ]),
    ).toThrow("Migration target table is configured more than once: target_a");
  });

  it("allows a primary-key table and plans epoch-to-timestamp conversion", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_user",
          [
            column("eb_user", "uid", "int", { primaryKey: true, identity: true }),
            column("eb_user", "delete_time", "int", { nullable: true }),
          ],
        ],
      ]),
      target: new Map([
        [
          "user",
          [
            column("user", "uid", "integer", { primaryKey: true, identity: true }),
            column("user", "delete_time", "timestamp without time zone", { nullable: true }),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "user", key: ["uid"], phase: "identity" },
    ]);

    expect(plan.eligible).toBe(true);
    expect(plan.conversions).toEqual([
      { column: "delete_time", kind: "epoch_seconds_to_timestamp" },
    ]);
    expect(
      convertRowForTarget(
        { uid: 1, delete_time: "1723200000" },
        plan.conversions,
      ).delete_time,
    ).toEqual(new Date(1723200000 * 1000));
    expect(
      convertRowForTarget({ uid: 2, delete_time: 0 }, plan.conversions).delete_time,
    ).toBeNull();
  });

  it("maps explicit source columns into target names for planning and keyset reads", async () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_store_coupon_user",
          [
            column("eb_store_coupon_user", "id", "int", { primaryKey: true }),
            column("eb_store_coupon_user", "cid", "int"),
            column("eb_store_coupon_user", "add_time", "int"),
            column("eb_store_coupon_user", "type", "varchar", {
              characterMaximumLength: 32,
            }),
            column("eb_store_coupon_user", "is_fail", "tinyint"),
          ],
        ],
      ]),
      target: new Map([
        [
          "store_coupon_user",
          [
            column("store_coupon_user", "id", "integer", { primaryKey: true }),
            column("store_coupon_user", "issue_coupon_id", "integer"),
            column("store_coupon_user", "receive_time", "integer"),
            column("store_coupon_user", "receive_source", "character varying", {
              characterMaximumLength: 32,
            }),
            column("store_coupon_user", "is_fail", "smallint"),
            column("store_coupon_user", "type", "smallint", { hasDefault: true }),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      {
        table: "store_coupon_user",
        key: ["id"],
        phase: "activity",
        columnMappings: {
          cid: "issue_coupon_id",
          add_time: "receive_time",
          type: "receive_source",
        },
      },
    ]);

    expect(plan.eligible).toBe(true);
    expect(plan.columns).toEqual([
      "id",
      "issue_coupon_id",
      "receive_time",
      "receive_source",
      "is_fail",
    ]);
    expect(plan.sourceColumnByTarget).toEqual({
      id: "id",
      issue_coupon_id: "cid",
      receive_time: "add_time",
      receive_source: "type",
      is_fail: "is_fail",
    });
    expect(plan.sourceKeyColumns).toEqual(["id"]);
    expect(plan.sourceOnlyColumns).toEqual([]);
    expect(plan.targetOnlyRequiredColumns).toEqual([]);

    const query = vi.fn().mockResolvedValue([
      [
        {
          id: "1",
          issue_coupon_id: "7",
          receive_time: "1723200000",
          receive_source: "get",
          is_fail: 0,
        },
      ],
      [],
    ]);
    await expect(readSourceBatch({ query } as never, plan, null, 10)).resolves.toEqual([
      {
        id: "1",
        issue_coupon_id: "7",
        receive_time: "1723200000",
        receive_source: "get",
        is_fail: 0,
      },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("`cid` AS `issue_coupon_id`");
    expect(sql).toContain("`add_time` AS `receive_time`");
    expect(sql).toContain("`type` AS `receive_source`");
    expect(sql).toContain("ORDER BY `id` ASC");
  });

  it("blocks source data loss, missing target defaults, unsafe keys and incompatible types", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_store_order",
          [
            column("eb_store_order", "id", "int", { primaryKey: true }),
            column("eb_store_order", "legacy_state", "varchar"),
            column("eb_store_order", "payload", "blob"),
          ],
        ],
      ]),
      target: new Map([
        [
          "store_order",
          [
            column("store_order", "id", "integer", { primaryKey: false }),
            column("store_order", "payload", "integer"),
            column("store_order", "required_new", "text"),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "store_order", key: ["id"], phase: "commerce" },
    ]);

    expect(plan.eligible).toBe(false);
    expect(plan.blockers.join("\n")).toContain("source columns would be discarded: legacy_state");
    expect(plan.blockers.join("\n")).toContain("required target columns have no source/default");
    expect(plan.blockers.join("\n")).toContain("target conflict key is not unique");
    expect(plan.blockers.join("\n")).toContain("incompatible type for payload");
  });

  it("requires live unsigned range checks and blocks lossy decimal, time and text casts", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_sample",
          [
            column("eb_sample", "id", "int", { primaryKey: true, unsigned: true }),
            column("eb_sample", "amount", "decimal", {
              numericPrecision: 20,
              numericScale: 4,
            }),
            column("eb_sample", "label", "varchar", { characterMaximumLength: 255 }),
            column("eb_sample", "occurred_at", "datetime"),
          ],
        ],
      ]),
      target: new Map([
        [
          "sample",
          [
            column("sample", "id", "integer", { primaryKey: true }),
            column("sample", "amount", "numeric", {
              numericPrecision: 12,
              numericScale: 2,
            }),
            column("sample", "label", "character varying", {
              characterMaximumLength: 64,
            }),
            column("sample", "occurred_at", "date"),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "sample", key: ["id"], phase: "identity" },
    ]);

    expect(plan.eligible).toBe(false);
    expect(plan.integerRangeChecks).toEqual([
      {
        column: "id",
        sourceColumn: "id",
        minimum: "-2147483648",
        maximum: "2147483647",
      },
    ]);
    expect(integerRangeBlocker(plan.integerRangeChecks[0], "0", "2147483647")).toBeUndefined();
    expect(integerRangeBlocker(plan.integerRangeChecks[0], "0", "2147483648")).toContain(
      "outside target integer range",
    );
    expect(plan.blockers.join("\n")).toContain("incompatible type for amount: decimal -> numeric");
    expect(plan.blockers.join("\n")).toContain("incompatible type for label: varchar -> character varying");
    expect(plan.blockers.join("\n")).toContain("incompatible type for occurred_at: datetime -> date");
  });

  it("validates text-to-JSON conversions before target insertion", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_sample",
          [
            column("eb_sample", "id", "int", { primaryKey: true }),
            column("eb_sample", "payload", "longtext", { nullable: true }),
          ],
        ],
      ]),
      target: new Map([
        [
          "sample",
          [
            column("sample", "id", "integer", { primaryKey: true }),
            column("sample", "payload", "jsonb", { nullable: true }),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "sample", key: ["id"], phase: "identity" },
    ]);

    expect(plan.eligible).toBe(true);
    expect(convertRowForTarget({ id: 1, payload: '{"safe":true}' }, plan.conversions)).toEqual({
      id: 1,
      payload: { safe: true },
    });
    expect(() => convertRowForTarget({ id: 2, payload: "{" }, plan.conversions)).toThrow(
      "Invalid JSON",
    );
  });

  it("treats MySQL enum and set values as bounded text for lossless PostgreSQL copies", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_sample",
          [
            column("eb_sample", "id", "int", { primaryKey: true }),
            column("eb_sample", "event_type", "enum", { characterMaximumLength: 7 }),
            column("eb_sample", "flags", "set", { characterMaximumLength: 32 }),
          ],
        ],
      ]),
      target: new Map([
        [
          "sample",
          [
            column("sample", "id", "integer", { primaryKey: true }),
            column("sample", "event_type", "character varying", { characterMaximumLength: 16 }),
            column("sample", "flags", "text"),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "sample", key: ["id"], phase: "catalog" },
    ]);
    expect(plan.eligible).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it("only converts legacy numeric timestamp strings when the manifest opts in", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_store_pink",
          [
            column("eb_store_pink", "id", "int", { primaryKey: true }),
            column("eb_store_pink", "add_time", "varchar", { characterMaximumLength: 24 }),
            column("eb_store_pink", "stop_time", "varchar", { characterMaximumLength: 24 }),
          ],
        ],
      ]),
      target: new Map([
        [
          "store_pink",
          [
            column("store_pink", "id", "integer", { primaryKey: true }),
            column("store_pink", "add_time", "integer"),
            column("store_pink", "stop_time", "timestamp without time zone", {
              nullable: true,
            }),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      {
        table: "store_pink",
        key: ["id"],
        phase: "activity",
        columnConversions: {
          add_time: "numeric_string_to_integer",
          stop_time: "epoch_string_to_timestamp",
        },
      },
    ]);

    expect(plan.eligible).toBe(true);
    expect(plan.sourceNumericStringChecks).toEqual([
      { column: "add_time", maximum: "2147483647" },
      { column: "stop_time", maximum: "8640000000000" },
    ]);
    const converted = convertRowForTarget(
      { id: 1, add_time: "1723200000", stop_time: "1723200300" },
      plan.conversions,
    );
    expect(converted.add_time).toBe(1723200000);
    expect(converted.stop_time).toEqual(new Date(1723200300 * 1000));
    expect(() =>
      convertRowForTarget({ id: 2, add_time: "not-a-number", stop_time: "0" }, plan.conversions),
    ).toThrow("Invalid numeric string");
  });

  it("blocks source NULLs that cannot populate a required target column", async () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_sample",
          [
            column("eb_sample", "id", "int", { primaryKey: true }),
            column("eb_sample", "label", "varchar", { nullable: true }),
            column("eb_sample", "payload", "longtext"),
          ],
        ],
      ]),
      target: new Map([
        [
          "sample",
          [
            column("sample", "id", "integer", { primaryKey: true }),
            column("sample", "label", "character varying"),
            column("sample", "payload", "jsonb"),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "sample", key: ["id"], phase: "identity" },
    ]);
    expect(plan.sourceNullabilityChecks).toEqual(["label"]);
    expect(plan.sourceSentinelChecks).toEqual([
      { column: "payload", kind: "empty_string_to_null" },
    ]);
    expect(plan.liveChecksVerified).toBe(false);

    const sourceQuery = vi
      .fn()
      .mockResolvedValueOnce([[{ count: "3" }], []])
      .mockResolvedValueOnce([[{ null_count: "1" }], []])
      .mockResolvedValueOnce([[{ sentinel_count: "2" }], []]);
    const target = ((first: unknown) =>
      Array.isArray(first) ? Promise.resolve([{ count: "0" }]) : {}) as never;
    await addTableCounts({ query: sourceQuery } as never, target, [plan]);

    expect(plan.liveChecksVerified).toBe(true);
    expect(plan.eligible).toBe(false);
    expect(plan.blockers.join("\n")).toContain(
      "source NULL values cannot populate required target column: label (1 row(s))",
    );
    expect(plan.blockers.join("\n")).toContain(
      "source sentinel values convert to NULL for required target column: payload (2 row(s), empty_string_to_null)",
    );
  });

  it("enables proven target keys but requires a live duplicate check when MySQL is weaker", async () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_member_right",
          [
            column("eb_member_right", "id", "int", { primaryKey: true }),
            column("eb_member_right", "right_type", "int", { primaryKey: true }),
          ],
        ],
        [
          "eb_store_product_description",
          [
            column("eb_store_product_description", "product_id", "int"),
            column("eb_store_product_description", "type", "int"),
            column("eb_store_product_description", "description", "text"),
          ],
        ],
        [
          "eb_store_order_status",
          [
            column("eb_store_order_status", "oid", "int"),
            column("eb_store_order_status", "change_type", "varchar"),
          ],
        ],
      ]),
      target: new Map([
        [
          "member_right",
          [
            column("member_right", "id", "integer", { primaryKey: true }),
            column("member_right", "right_type", "integer"),
          ],
        ],
        [
          "store_product_description",
          [
            column("store_product_description", "product_id", "integer"),
            column("store_product_description", "type", "integer"),
            column("store_product_description", "description", "text"),
          ],
        ],
        [
          "store_order_status",
          [
            column("store_order_status", "oid", "integer"),
            column("store_order_status", "change_type", "varchar"),
          ],
        ],
      ]),
      sourceUniqueKeys: new Map([
        ["eb_member_right", [["id", "right_type"]]],
        ["eb_store_product_description", []],
        ["eb_store_order_status", []],
      ]),
      targetUniqueKeys: new Map([
        ["member_right", [["id"]]],
        ["store_product_description", [["product_id", "type"]]],
        ["store_order_status", []],
      ]),
    };
    const specs = MIGRATION_TABLES.filter((entry) =>
      new Set(["member_right", "store_product_description", "store_order_status"]).has(entry.table),
    );
    const plans = buildTransferPlans(inventory, "eb_", specs);
    const memberRight = plans.find((plan) => plan.spec.table === "member_right")!;
    const description = plans.find((plan) => plan.spec.table === "store_product_description")!;
    const orderStatus = plans.find((plan) => plan.spec.table === "store_order_status")!;

    expect(memberRight.spec.key).toEqual(["id"]);
    expect(memberRight.eligible).toBe(false);
    expect(memberRight.sourceKeyRequiresUniquenessCheck).toBe(true);
    expect(description.spec.key).toEqual(["product_id", "type"]);
    expect(description.eligible).toBe(false);
    expect(description.sourceKeyRequiresUniquenessCheck).toBe(true);
    expect(orderStatus.eligible).toBe(true);
    expect(orderStatus.spec.copyStrategy).toBe("append_multiset");
    expect(orderStatus.blockers).not.toContain("source table has no deterministic migration key");

    const query = vi.fn().mockResolvedValue([
      [{ duplicate_group_count: "2", duplicate_excess_row_count: "3" }],
      [],
    ]);
    await expect(
      hasDuplicateSourceMigrationKeys({ query } as never, description),
    ).resolves.toBe(true);
    expect(String(query.mock.calls[0][0])).toContain(
      "GROUP BY `product_id`, `type`",
    );
    expect(String(query.mock.calls[0][0])).toContain("HAVING COUNT(*) > 1");

    await expect(
      copyEligibleTables(
        {} as never,
        {} as never,
        [description],
        {
          batchSize: 10,
          runId: "test-run-duplicate-guard",
          sourcePrefix: "eb_",
        },
        "0".repeat(64),
      ),
    ).rejects.toThrow("Live migration checks were not completed");

    const cleanSourceQuery = vi
      .fn()
      .mockResolvedValueOnce([[{ count: "2" }], []])
      .mockResolvedValueOnce([
        [{ duplicate_group_count: "0", duplicate_excess_row_count: "0" }],
        [],
      ]);
    const target = ((first: unknown) =>
      Array.isArray(first) ? Promise.resolve([{ count: "0" }]) : {}) as never;
    await addTableCounts({ query: cleanSourceQuery } as never, target, [description]);
    expect(description.sourceKeyUniquenessVerified).toBe(true);
    expect(description.sourceDuplicateKeyGroups).toBe(0);
    expect(description.eligible).toBe(true);
  });

  it("reports missing and mismatched target rows after canonical conversion", () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_sample",
          [
            column("eb_sample", "id", "int", { primaryKey: true }),
            column("eb_sample", "amount", "decimal", {
              numericPrecision: 12,
              numericScale: 2,
            }),
            column("eb_sample", "payload", "longtext", { nullable: true }),
            column("eb_sample", "created_at", "int"),
            column("eb_sample", "label", "varchar", { characterMaximumLength: 32 }),
          ],
        ],
      ]),
      target: new Map([
        [
          "sample",
          [
            column("sample", "id", "integer", { primaryKey: true }),
            column("sample", "amount", "numeric", {
              numericPrecision: 12,
              numericScale: 2,
            }),
            column("sample", "payload", "jsonb", { nullable: true }),
            column("sample", "created_at", "timestamp with time zone"),
            column("sample", "label", "character varying", {
              characterMaximumLength: 32,
            }),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "sample", key: ["id"], phase: "identity" },
    ]);
    const createdAt = 1_723_200_000;
    const sourceRows = [
      convertRowForTarget(
        {
          id: "1",
          amount: "01.200",
          payload: '{"b":2,"a":1}',
          created_at: String(createdAt),
          label: "source",
        },
        plan.conversions,
      ),
      convertRowForTarget(
        { id: "2", amount: "0.00", payload: null, created_at: "0", label: "missing" },
        plan.conversions,
      ),
    ];
    const result = compareVerificationBatch(
      plan,
      sourceRows,
      [
        {
          id: 1,
          amount: "1.2",
          payload: { a: 1, b: 2 },
          created_at: new Date(createdAt * 1000),
          label: "target",
        },
      ],
      20,
    );

    expect(canonicalColumnValue("numeric", "-0.000")).toBe("decimal:0");
    expect(result).toEqual({
      checkedCount: 2,
      missingTargetCount: 1,
      mismatchedRowCount: 1,
      issues: [
        { key: "1", kind: "value_mismatch", columns: ["label"] },
        { key: "2", kind: "missing_target", columns: [] },
      ],
    });
  });

  it("requires explicit target confirmation and an extra remote-write gate", () => {
    expect(() =>
      validateApplyTarget("postgresql://user:pass@localhost:5432/cinashop_test", undefined, false),
    ).toThrow("MIGRATION_CONFIRM_TARGET");
    expect(
      validateApplyTarget(
        "postgresql://user:pass@localhost:5432/cinashop_test",
        "cinashop_test",
        false,
      ),
    ).toEqual({ database: "cinashop_test", remote: false });
    expect(() =>
      validateApplyTarget(
        "postgresql://user:pass@db.example.com:5432/cinashop",
        "cinashop",
        false,
      ),
    ).toThrow("MIGRATION_ALLOW_REMOTE_TARGET=1");
  });

  it("rejects identifier injection and unbounded batches", () => {
    expect(quoteMysqlIdentifier("eb_store_order")).toBe("`eb_store_order`");
    expect(() => quoteMysqlIdentifier("eb_user; DROP TABLE user")).toThrow("Unsafe");
    expect(validateBatchSize(1000)).toBe(1000);
    expect(() => validateBatchSize(1001)).toThrow("between 1 and 1000");
  });

  it("refuses write mode and command-line secrets before opening a database", async () => {
    await expect(migrationMain(["copy"])).rejects.toThrow("requires the explicit --apply");
    await expect(migrationMain(["copy", "--apply"])).rejects.toThrow("explicit --tables");
    await expect(
      migrationMain(["plan", "--target-url=postgresql://user:secret@example/db"]),
    ).rejects.toThrow("environment variables");
    await expect(migrationMain(["schema-audit", "--aplly"])).rejects.toThrow("Unknown option");
    const databaseError = Object.assign(new Error("invalid value: private customer data"), {
      code: "22001",
    });
    expect(safeErrorLabel(databaseError)).toBe("Error:22001");
    expect(safeErrorLabel(databaseError)).not.toContain("private customer data");
  });

  it("validates the copy target confirmation before opening database connections", async () => {
    vi.stubEnv("SOURCE_MYSQL_URL", "mysql://readonly:placeholder@127.0.0.1:9/source");
    vi.stubEnv("TARGET_POSTGRES_URL", "postgresql://migration:placeholder@127.0.0.1:9/target");
    vi.stubEnv("MIGRATION_CONFIRM_TARGET", "");

    await expect(migrationMain(["copy", "--apply", "--tables=user"])).rejects.toThrow(
      "MIGRATION_CONFIRM_TARGET",
    );
  });

  it("requires an explicit verification table list and run id before connecting", async () => {
    await expect(migrationMain(["verify"])).rejects.toThrow("explicit --tables");
    vi.stubEnv("SOURCE_MYSQL_URL", "mysql://readonly:placeholder@127.0.0.1:9/source");
    vi.stubEnv("TARGET_POSTGRES_URL", "postgresql://migration:placeholder@127.0.0.1:9/target");
    vi.stubEnv("MIGRATION_RUN_ID", "");

    await expect(migrationMain(["verify", "--tables=user"])).rejects.toThrow(
      "MIGRATION_RUN_ID",
    );
  });

  it("resumes from the last committed key after a batch failure without replaying earlier rows", async () => {
    const sourceRows = [1, 2, 3, 4, 5].map((id) => ({ id }));
    let checkpoint: KeysetProgress = { lastKey: null, insertedCount: 0, conflictCount: 0 };
    let writeAttempt = 0;
    const readBatch = async (afterKey: string | null, limit: number) =>
      sourceRows
        .filter((row) => afterKey === null || row.id > Number(afterKey))
        .slice(0, limit);

    await expect(
      runKeysetBatches({
        key: "id",
        batchSize: 2,
        initial: checkpoint,
        readBatch,
        writeBatch: async (rows, lastKey, current) => {
          writeAttempt += 1;
          if (writeAttempt === 2) throw new Error("simulated transaction rollback");
          checkpoint = {
            lastKey,
            insertedCount: current.insertedCount + rows.length,
            conflictCount: current.conflictCount,
          };
          return { insertedCount: rows.length, conflictCount: 0 };
        },
      }),
    ).rejects.toThrow("simulated transaction rollback");
    expect(checkpoint).toEqual({ lastKey: "2", insertedCount: 2, conflictCount: 0 });

    const resumedKeys: number[] = [];
    const completed = await runKeysetBatches({
      key: "id",
      batchSize: 2,
      initial: checkpoint,
      readBatch,
      writeBatch: async (rows, lastKey, current) => {
        resumedKeys.push(...rows.map((row) => Number(row.id)));
        const conflicts = rows.some((row) => row.id === 4) ? 1 : 0;
        const inserted = rows.length - conflicts;
        checkpoint = {
          lastKey,
          insertedCount: current.insertedCount + inserted,
          conflictCount: current.conflictCount + conflicts,
        };
        return { insertedCount: inserted, conflictCount: conflicts };
      },
    });

    expect(resumedKeys).toEqual([3, 4, 5]);
    expect(completed).toEqual({ lastKey: "5", insertedCount: 4, conflictCount: 1 });
  });

  it("does not skip negative integer keys on the first keyset page", async () => {
    const sourceRows = [-3, -1, 0, 2].map((id) => ({ id }));
    const copied: number[] = [];
    const completed = await runKeysetBatches({
      key: "id",
      batchSize: 2,
      initial: { lastKey: null, insertedCount: 0, conflictCount: 0 },
      readBatch: async (afterKey, limit) =>
        sourceRows
          .filter((row) => afterKey === null || row.id > Number(afterKey))
          .slice(0, limit),
      writeBatch: async (rows) => {
        copied.push(...rows.map((row) => Number(row.id)));
        return { insertedCount: rows.length, conflictCount: 0 };
      },
    });

    expect(copied).toEqual([-3, -1, 0, 2]);
    expect(completed).toEqual({ lastKey: "2", insertedCount: 4, conflictCount: 0 });
  });

  it("resumes composite integer keysets lexicographically without dropping equal prefixes", async () => {
    const sourceRows = [
      { product_id: -1, type: 2 },
      { product_id: 1, type: 1 },
      { product_id: 1, type: 3 },
      { product_id: 2, type: 0 },
    ];
    const copied: string[] = [];
    const completed = await runCursorBatches({
      keys: ["product_id", "type"],
      batchSize: 2,
      initial: { lastKey: ["1", "1"], insertedCount: 2, conflictCount: 0 },
      readBatch: async (afterKey, limit) =>
        sourceRows
          .filter((row) =>
            afterKey === null ||
            row.product_id > Number(afterKey[0]) ||
            (row.product_id === Number(afterKey[0]) && row.type > Number(afterKey[1])),
          )
          .slice(0, limit),
      writeBatch: async (rows) => {
        copied.push(...rows.map((row) => `${row.product_id}:${row.type}`));
        return { insertedCount: rows.length, conflictCount: 0 };
      },
    });

    expect(copied).toEqual(["1:3", "2:0"]);
    expect(completed).toEqual({ lastKey: ["2", "0"], insertedCount: 4, conflictCount: 0 });
    expect(
      validateIncreasingKeyTupleBatch(
        [{ product_id: 1, type: 1 }, { product_id: 1, type: 2 }],
        ["product_id", "type"],
        null,
      ),
    ).toEqual(["1", "2"]);
    expect(() =>
      validateIncreasingKeyTupleBatch(
        [{ product_id: 1, type: 2 }, { product_id: 1, type: 2 }],
        ["product_id", "type"],
        null,
      ),
    ).toThrow("strictly increasing");
    expect(decodeCheckpointCursor(["product_id", "type"], null, ["1", "3"])).toEqual([
      "1",
      "3",
    ]);
    expect(() => decodeCheckpointCursor(["product_id", "type"], null, ["1"])).toThrow(
      "Invalid composite",
    );
  });

  it("resumes scalar text keysets in binary UTF-8 order and stores JSON cursors", async () => {
    const rows = [{ key: "A" }, { key: "a" }, { key: "z" }];
    const copied: string[] = [];
    const completed = await runCursorBatches({
      keys: ["key"],
      keyKinds: ["text"],
      batchSize: 1,
      initial: { lastKey: ["A"], insertedCount: 1, conflictCount: 0 },
      readBatch: async (afterKey, limit) => rows
        .filter((row) => afterKey === null || Buffer.compare(
          Buffer.from(row.key),
          Buffer.from(afterKey[0]),
        ) > 0)
        .slice(0, limit),
      writeBatch: async (batch) => {
        copied.push(...batch.map((row) => String(row.key)));
        return { insertedCount: batch.length, conflictCount: 0 };
      },
    });
    expect(copied).toEqual(["a", "z"]);
    expect(completed.lastKey).toEqual(["z"]);
    expect(decodeCheckpointCursor(["key"], null, ["z"], ["text"]))
      .toEqual(["z"]);
    expect(() => decodeCheckpointCursor(["key"], null, [7], ["text"]))
      .toThrow("Invalid JSON");
  });

  it("paginates mixed integer/text composite keys in numeric and binary UTF-8 order", async () => {
    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_live_room",
          [
            column("eb_live_room", "id", "int", { primaryKey: true }),
            column("eb_live_room", "phone", "varchar", {
              primaryKey: true,
              characterMaximumLength: 32,
            }),
            column("eb_live_room", "name", "varchar", { characterMaximumLength: 50 }),
          ],
        ],
      ]),
      target: new Map([
        [
          "live_room",
          [
            column("live_room", "id", "integer", { primaryKey: true }),
            column("live_room", "phone", "character varying", {
              primaryKey: true,
              characterMaximumLength: 32,
            }),
            column("live_room", "name", "character varying", { characterMaximumLength: 50 }),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      { table: "live_room", key: ["id", "phone"], phase: "activity" },
    ]);
    expect(plan.eligible).toBe(true);
    expect(plan.keyKinds).toEqual(["integer", "text"]);
    expect(plan.sourceKeyRequiresUniquenessCheck).toBe(false);

    const query = vi.fn().mockResolvedValue([
      [{ id: "8", phone: "a10", name: "room" }],
      [],
    ]);
    await readSourceBatch({ query } as never, plan, ["7", "A10"], 20);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("(`id` > ?)");
    expect(sql).toContain("`id` = ? AND CAST(`phone` AS BINARY) > CAST(? AS BINARY)");
    expect(sql).toContain("ORDER BY `id` ASC, CAST(`phone` AS BINARY) ASC");
    expect(query.mock.calls[0][1]).toEqual(["7", "7", "A10", 20]);
    expect(decodeCheckpointCursor(
      ["id", "phone"],
      null,
      ["7", "A10"],
      ["integer", "text"],
    )).toEqual(["7", "A10"]);
  });

  it("pages keyless tables as duplicate-preserving full-row multisets", async () => {
    const keylessTables = MIGRATION_TABLES.filter((entry) => entry.key.length === 0);
    expect(keylessTables).toHaveLength(12);
    expect(keylessTables.every((entry) => entry.copyStrategy === "append_multiset")).toBe(true);

    const inventory: DatabaseInventory = {
      source: new Map([
        [
          "eb_store_order_status",
          [
            column("eb_store_order_status", "oid", "int"),
            column("eb_store_order_status", "change_type", "varchar"),
            column("eb_store_order_status", "change_message", "varchar", { nullable: true }),
          ],
        ],
      ]),
      target: new Map([
        [
          "store_order_status",
          [
            column("store_order_status", "oid", "integer"),
            column("store_order_status", "change_type", "character varying"),
            column("store_order_status", "change_message", "character varying", {
              nullable: true,
            }),
          ],
        ],
      ]),
    };
    const [plan] = buildTransferPlans(inventory, "eb_", [
      {
        table: "store_order_status",
        key: [],
        copyStrategy: "append_multiset",
        phase: "commerce",
      },
    ]);
    expect(plan.eligible).toBe(true);
    expect(plan.sourceKeyRequiresUniquenessCheck).toBe(false);

    const cursor = "V1:37;V4:70616964;N;";
    const query = vi.fn().mockResolvedValue([
      [{
        oid: "7",
        change_type: "paid",
        change_message: null,
        __migration_multiplicity: "3",
        __migration_canonical_key: cursor,
      }],
      [],
    ]);
    await expect(
      readSourceMultisetGroups({ query } as never, plan, cursor, 10, true),
    ).resolves.toEqual([{
      canonicalKey: cursor,
      multiplicity: 3,
      row: { oid: "7", change_type: "paid", change_message: null },
    }]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("OCTET_LENGTH(CAST(`change_type` AS BINARY))");
    expect(sql).toContain("HEX(CAST(`change_message` AS BINARY))");
    expect(sql).toContain("COUNT(*) AS __migration_multiplicity");
    expect(sql).toContain("GROUP BY `oid`, `change_type`, `change_message`");
    expect(sql).toContain(">= CAST(? AS BINARY)");
    expect(query.mock.calls[0][1]).toEqual([cursor, 10]);
    expect(decodeMultisetCheckpointCursor([cursor, 2])).toEqual({
      canonicalKey: cursor,
      consumedInGroup: 2,
    });
    expect(() => decodeMultisetCheckpointCursor([cursor, -1])).toThrow("Invalid multiset");

    const duplicateGroup = {
      canonicalKey: cursor,
      multiplicity: 5,
      row: { oid: "7", change_type: "paid", change_message: null },
    };
    const first = selectMultisetBatch(
      "store_order_status",
      [duplicateGroup],
      { canonicalKey: cursor, consumedInGroup: 2 },
      2,
    );
    expect(first.records).toHaveLength(2);
    expect(first.nextCursor).toEqual({ canonicalKey: cursor, consumedInGroup: 4 });
    const second = selectMultisetBatch(
      "store_order_status",
      [duplicateGroup, {
        canonicalKey: `${cursor}V1:38;`,
        multiplicity: 1,
        row: { oid: "8", change_type: "paid", change_message: null },
      }],
      first.nextCursor,
      2,
    );
    expect(second.records.map((row) => row.oid)).toEqual(["7", "8"]);
    expect(second.nextCursor).toEqual({
      canonicalKey: `${cursor}V1:38;`,
      consumedInGroup: 1,
    });
    expect(() => selectMultisetBatch(
      "store_order_status",
      [{ ...duplicateGroup, multiplicity: 1 }],
      { canonicalKey: cursor, consumedInGroup: 2 },
      2,
    )).toThrow("shrank below its checkpoint multiplicity");
  });

  it("compares composite-key verification batches without exposing row values", () => {
    const plan = {
      spec: {
        table: "store_product_description",
        key: ["product_id", "type"],
        phase: "catalog" as const,
      },
      columns: ["product_id", "type", "description"],
      targetColumnTypes: {
        product_id: "integer",
        type: "integer",
        description: "text",
      },
    };
    const result = compareVerificationBatch(
      plan,
      [
        { product_id: "7", type: "1", description: "private source value" },
        { product_id: "7", type: "2", description: "another private value" },
      ],
      [{ product_id: 7, type: 1, description: "different private target value" }],
      20,
    );

    expect(result.issues).toEqual([
      { key: '["7","1"]', kind: "value_mismatch", columns: ["description"] },
      { key: '["7","2"]', kind: "missing_target", columns: [] },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("keeps the physical and embedded control/parity migrations identical", () => {
    const controlMigration = readFileSync(
      "migrations/0020_data_migration_control.sql",
      "utf8",
    ).trim();
    const parityMigration = readFileSync(
      "migrations/0021_repository_schema_parity.sql",
      "utf8",
    ).trim();
    const cursorMigration = readFileSync(
      "migrations/0022_composite_migration_cursor.sql",
      "utf8",
    ).trim();
    const legacyColumnMigration = readFileSync(
      "migrations/0023_legacy_column_preservation.sql",
      "utf8",
    ).trim();
    const communityMigration = readFileSync(
      "migrations/0024_community_seckill_legacy_columns.sql",
      "utf8",
    ).trim();
    const couponUserMigration = readFileSync(
      "migrations/0025_coupon_user_legacy_mapping.sql",
      "utf8",
    ).trim();
    const systemMetadataMigration = readFileSync(
      "migrations/0026_system_metadata_legacy_columns.sql",
      "utf8",
    ).trim();
    const replyShippingMigration = readFileSync(
      "migrations/0027_reply_shipping_legacy_columns.sql",
      "utf8",
    ).trim();
    const shippingRegionMigration = readFileSync(
      "migrations/0028_shipping_region_legacy_mapping.sql",
      "utf8",
    ).trim();
    const userExtractMigration = readFileSync(
      "migrations/0029_user_extract_legacy_columns.sql",
      "utf8",
    ).trim();
    const orderCartPinkMigration = readFileSync(
      "migrations/0030_order_cart_pink_legacy_columns.sql",
      "utf8",
    ).trim();
    const couponIssueMigration = readFileSync(
      "migrations/0031_coupon_issue_legacy_columns.sql",
      "utf8",
    ).trim();
    const activityCatalogMigration = readFileSync(
      "migrations/0032_activity_catalog_legacy_columns.sql",
      "utf8",
    ).trim();
    const orderLegacyMigration = readFileSync(
      "migrations/0033_order_legacy_columns.sql",
      "utf8",
    ).trim();
    const shippingExceptionMigration = readFileSync(
      "migrations/0034_shipping_exception_rules.sql",
      "utf8",
    ).trim();
    const renamedCatalogMigration = readFileSync(
      "migrations/0035_renamed_legacy_catalog_tables.sql",
      "utf8",
    ).trim();
    const geographyMigration = readFileSync(
      "migrations/0036_shipping_geography.sql",
      "utf8",
    ).trim();
    const articleMigration = readFileSync(
      "migrations/0037_article_taxonomy_content.sql",
      "utf8",
    ).trim();
    const legacyNotificationMigration = readFileSync(
      "migrations/0038_legacy_content_notifications.sql",
      "utf8",
    ).trim();
    const communityRelationshipMigration = readFileSync(
      "migrations/0039_community_relationships.sql",
      "utf8",
    ).trim();
    const orderAuxiliaryMigration = readFileSync(
      "migrations/0040_order_auxiliary_records.sql",
      "utf8",
    ).trim();
    const promotionCatalogMigration = readFileSync(
      "migrations/0041_promotion_catalog.sql",
      "utf8",
    ).trim();
    const activityParentMigration = readFileSync(
      "migrations/0042_activity_catalog.sql",
      "utf8",
    ).trim();
    const discountPackageMigration = readFileSync(
      "migrations/0043_discount_packages.sql",
      "utf8",
    ).trim();
    const deliveryOrderMigration = readFileSync(
      "migrations/0044_delivery_orders.sql",
      "utf8",
    ).trim();
    const financeLedgerMigration = readFileSync(
      "migrations/0045_finance_ledgers.sql",
      "utf8",
    ).trim();
    const integralOrderMigration = readFileSync(
      "migrations/0046_integral_orders.sql",
      "utf8",
    ).trim();
    const productMetadataMigration = readFileSync(
      "migrations/0047_product_metadata_and_system_groups.sql",
      "utf8",
    ).trim();
    const userSegmentationMigration = readFileSync(
      "migrations/0048_user_segmentation.sql",
      "utf8",
    ).trim();
    const systemFormsMigration = readFileSync(
      "migrations/0049_system_forms_and_config_tabs.sql",
      "utf8",
    ).trim();
    const systemSignRewardMigration = readFileSync(
      "migrations/0050_system_sign_rewards.sql",
      "utf8",
    ).trim();
    const agentLevelTaskMigration = readFileSync(
      "migrations/0051_agent_level_tasks.sql",
      "utf8",
    ).trim();
    const productCouponMigration = readFileSync(
      "migrations/0052_product_coupon_grants.sql",
      "utf8",
    ).trim();
    const bargainUserHelpMigration = readFileSync(
      "migrations/0053_bargain_user_help.sql",
      "utf8",
    ).trim();
    const productExperienceMigration = readFileSync(
      "migrations/0054_product_assurance_and_visit_analytics.sql",
      "utf8",
    ).trim();
    const customerServiceCatalogMigration = readFileSync(
      "migrations/0055_customer_service_feedback_and_speechcraft.sql",
      "utf8",
    ).trim();
    const distributionRelationshipMigration = readFileSync(
      "migrations/0056_distribution_relationships.sql",
      "utf8",
    ).trim();
    const userFriendMigration = readFileSync(
      "migrations/0057_user_friend_relationships.sql",
      "utf8",
    ).trim();
    const userBehaviorMigration = readFileSync(
      "migrations/0058_user_search_and_visit.sql",
      "utf8",
    ).trim();
    const newcomerMigration = readFileSync(
      "migrations/0059_store_newcomer.sql",
      "utf8",
    ).trim();
    const legacyCacheMigration = readFileSync(
      "migrations/0060_legacy_db_cache.sql",
      "utf8",
    ).trim();
    const paidMembershipMigration = readFileSync(
      "migrations/0061_paid_membership_core.sql",
      "utf8",
    ).trim();
    const couponRelationshipMigration = readFileSync(
      "migrations/0062_coupon_relationship_evidence.sql",
      "utf8",
    ).trim();
    const storeFulfillmentIdentityMigration = readFileSync(
      "migrations/0063_store_fulfillment_identity.sql",
      "utf8",
    ).trim();
    const storeLegacyAuxiliaryMigration = readFileSync(
      "migrations/0064_store_legacy_auxiliary.sql",
      "utf8",
    ).trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const productMigration = readFileSync(
      "migrations/0016_supplier_product_management.sql",
      "utf8",
    );
    const embeddedControl = service
      .match(/private migration_0027\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedParity = service
      .match(/private migration_0028\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedCursor = service
      .match(/private migration_0029\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedLegacyColumns = service
      .match(/private migration_0030\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedCommunity = service
      .match(/private migration_0031\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedCouponUser = service
      .match(/private migration_0032\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedSystemMetadata = service
      .match(/private migration_0033\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedReplyShipping = service
      .match(/private migration_0034\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedShippingRegion = service
      .match(/private migration_0035\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedUserExtract = service
      .match(/private migration_0036\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedOrderCartPink = service
      .match(/private migration_0037\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedCouponIssue = service
      .match(/private migration_0038\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedActivityCatalog = service
      .match(/private migration_0039\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedOrderLegacy = service
      .match(/private migration_0040\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedShippingException = service
      .match(/private migration_0041\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedRenamedCatalog = service
      .match(/private migration_0042\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedGeography = service
      .match(/private migration_0043\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedArticle = service
      .match(/private migration_0044\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedLegacyNotification = service
      .match(/private migration_0045\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedCommunityRelationship = service
      .match(/private migration_0046\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedOrderAuxiliary = service
      .match(/private migration_0047\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedPromotionCatalog = service
      .match(/private migration_0048\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedActivityCatalogParent = service
      .match(/private migration_0049\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedDiscountPackage = service
      .match(/private migration_0050\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedDeliveryOrder = service
      .match(/private migration_0051\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedFinanceLedger = service
      .match(/private migration_0052\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedIntegralOrder = service
      .match(/private migration_0053\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedProductMetadata = service
      .match(/private migration_0054\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedUserSegmentation = service
      .match(/private migration_0055\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedSystemForms = service
      .match(/private migration_0056\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedSystemSignReward = service
      .match(/private migration_0057\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedAgentLevelTask = service
      .match(/private migration_0058\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedProductCoupon = service
      .match(/private migration_0059\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedBargainUserHelp = service
      .match(/private migration_0060\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedProductExperience = service
      .match(/private migration_0061\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedCustomerServiceCatalog = service
      .match(/private migration_0062\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedDistributionRelationship = service
      .match(/private migration_0063\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedUserFriend = service
      .match(/private migration_0064\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedUserBehavior = service
      .match(/private migration_0065\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedNewcomer = service
      .match(/private migration_0066\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedLegacyCache = service
      .match(/private migration_0067\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedPaidMembership = service
      .match(/private migration_0068\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedCouponRelationship = service
      .match(/private migration_0069\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedStoreFulfillmentIdentity = service
      .match(/private migration_0070\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const embeddedStoreLegacyAuxiliary = service
      .match(/private migration_0071\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embeddedControl).toBe(controlMigration);
    expect(embeddedParity).toBe(parityMigration);
    expect(embeddedCursor).toBe(cursorMigration);
    expect(embeddedLegacyColumns).toBe(legacyColumnMigration);
    expect(embeddedCommunity).toBe(communityMigration);
    expect(embeddedCouponUser).toBe(couponUserMigration);
    expect(embeddedSystemMetadata).toBe(systemMetadataMigration);
    expect(embeddedReplyShipping).toBe(replyShippingMigration);
    expect(embeddedShippingRegion).toBe(shippingRegionMigration);
    expect(embeddedUserExtract).toBe(userExtractMigration);
    expect(embeddedOrderCartPink).toBe(orderCartPinkMigration);
    expect(embeddedCouponIssue).toBe(couponIssueMigration);
    expect(embeddedActivityCatalog).toBe(activityCatalogMigration);
    expect(embeddedOrderLegacy).toBe(orderLegacyMigration);
    expect(embeddedShippingException).toBe(shippingExceptionMigration);
    expect(embeddedRenamedCatalog).toBe(renamedCatalogMigration);
    expect(embeddedGeography).toBe(geographyMigration);
    expect(embeddedArticle).toBe(articleMigration);
    expect(embeddedLegacyNotification).toBe(legacyNotificationMigration);
    expect(embeddedCommunityRelationship).toBe(communityRelationshipMigration);
    expect(embeddedOrderAuxiliary).toBe(orderAuxiliaryMigration);
    expect(embeddedPromotionCatalog).toBe(promotionCatalogMigration);
    expect(embeddedActivityCatalogParent).toBe(activityParentMigration);
    expect(embeddedDiscountPackage).toBe(discountPackageMigration);
    expect(embeddedDeliveryOrder).toBe(deliveryOrderMigration);
    expect(embeddedFinanceLedger).toBe(financeLedgerMigration);
    expect(embeddedIntegralOrder).toBe(integralOrderMigration);
    expect(embeddedProductMetadata).toBe(productMetadataMigration);
    expect(embeddedUserSegmentation).toBe(userSegmentationMigration);
    expect(embeddedSystemForms).toBe(systemFormsMigration);
    expect(embeddedSystemSignReward).toBe(systemSignRewardMigration);
    expect(embeddedAgentLevelTask).toBe(agentLevelTaskMigration);
    expect(embeddedProductCoupon).toBe(productCouponMigration);
    expect(embeddedBargainUserHelp).toBe(bargainUserHelpMigration);
    expect(embeddedProductExperience).toBe(productExperienceMigration);
    expect(embeddedCustomerServiceCatalog).toBe(customerServiceCatalogMigration);
    expect(embeddedDistributionRelationship).toBe(distributionRelationshipMigration);
    expect(embeddedUserFriend).toBe(userFriendMigration);
    expect(embeddedUserBehavior).toBe(userBehaviorMigration);
    expect(embeddedNewcomer).toBe(newcomerMigration);
    expect(embeddedLegacyCache).toBe(legacyCacheMigration);
    expect(embeddedPaidMembership).toBe(paidMembershipMigration);
    expect(embeddedCouponRelationship).toBe(couponRelationshipMigration);
    expect(embeddedStoreFulfillmentIdentity).toBe(storeFulfillmentIdentityMigration);
    expect(embeddedStoreLegacyAuxiliary).toBe(storeLegacyAuxiliaryMigration);
    expect(productMigration).not.toContain('DELETE FROM "store_product_description"');
    expect(service).not.toContain('DELETE FROM "store_product_description"');
  });
});
