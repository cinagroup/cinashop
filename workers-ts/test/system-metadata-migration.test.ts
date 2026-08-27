import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { visibleSystemMessageWhere } from "../src/controllers/api/v1/UserMessageController";
import { systemLog, systemMessage, userLabel } from "../src/models/schema";

describe("system metadata migration parity", () => {
  it("limits both system-message reads to active, undeleted global or owned rows", () => {
    const query = new PgDialect().sqlToQuery(visibleSystemMessageWhere(7)!);

    expect(query.sql).toBe(
      '("system_message"."status" = $1 and "system_message"."is_del" = $2 and ("system_message"."user_id" = $3 or "system_message"."user_id" = $4))',
    );
    expect(query.params).toEqual([1, 0, 0, 7]);
  });

  it("keeps the legacy log, message and user-label fields in the Drizzle schema", () => {
    const log = getTableColumns(systemLog);
    const message = getTableColumns(systemMessage);
    const label = getTableColumns(userLabel);

    expect(Object.keys(log)).toEqual(
      expect.arrayContaining(["storeId", "path", "page", "method", "type", "merchantId"]),
    );
    expect(Object.keys(message)).toEqual(
      expect.arrayContaining(["mark", "userId", "look", "isDel"]),
    );
    expect(message.title.getSQLType()).toBe("varchar(256)");
    expect(Object.keys(label)).toEqual(
      expect.arrayContaining(["type", "relationId", "labelCate", "name", "tagId"]),
    );
    expect(label.name.getSQLType()).toBe("varchar(255)");
  });
});
