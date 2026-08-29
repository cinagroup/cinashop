import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("legacy content and notification migration", () => {
  it("uses explicit aliases without conflating old notice reads with new user messages", () => {
    const byTable = new Map(MIGRATION_TABLES.map((entry) => [entry.table, entry]));
    expect(byTable.get("system_dise")).toMatchObject({ sourceTable: "diy", key: ["id"] });
    expect(byTable.get("notification_template")).toMatchObject({
      sourceTable: "template_message",
      columnMappings: { type: "legacy_type", tempkey: "mark", name: "title" },
      columnConversions: { add_time: "numeric_string_to_integer" },
    });
    expect(byTable.get("user_notice")?.sourceTable).toBeUndefined();
    expect(byTable.get("user_notice_see")?.sourceTable).toBeUndefined();
    expect(byTable.get("user_message")?.sourceTable).toBeUndefined();
  });

  it("keeps imported DIY JSON editable and preserves legacy notification channel semantics", () => {
    const controller = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const notificationPage = readFileSync(
      "../view/admin-ts/src/pages/setting/NotificationList.vue",
      "utf8",
    );
    expect(controller).toContain("value: systemDise.value");
    expect(controller).toContain("content: systemDise.content");
    expect(controller).toContain("...(body.value !== undefined ? { value: body.value } : {})");
    expect(controller).toContain("...(body.content !== undefined ? { content: body.content } : {})");
    expect(controller).not.toContain("COALESCE(NULLIF(content, ''), value, '') AS content");
    expect(controller).toContain("CASE \"legacy_type\" WHEN 0 THEN 'routine' WHEN 1 THEN 'wechat'");
    expect(notificationPage).toContain('<el-option value="routine" label="小程序订阅" />');
  });
});
