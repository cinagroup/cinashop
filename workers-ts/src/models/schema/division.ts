/**
 * 事业部/代理商申请。
 *
 * 对应 PHP eb_division_apply。角色关系本身仍保存在 user 表，申请表只保存
 * 审核工作流，避免待审核数据提前影响下单分佣快照。
 */
import {
  pgTable,
  serial,
  integer,
  varchar,
  smallint,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const divisionApply = pgTable(
  "division_apply",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    divisionName: varchar("division_name", { length: 255 }).default("").notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    phone: varchar("phone", { length: 32 }).default("0").notNull(),
    divisionId: integer("division_id").default(0).notNull(),
    divisionInvite: integer("division_invite").default(0).notNull(),
    /** JSON string array, compatible with the PHP payload. */
    images: varchar("images", { length: 2000 }).default("").notNull(),
    addTime: integer("add_time").default(0).notNull(),
    /** 0 pending, 1 approved, 2 rejected. */
    status: smallint("status").default(0).notNull(),
    statusTime: integer("status_time").default(0).notNull(),
    refusalReason: varchar("refusal_reason", { length: 1000 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    index("da_division_status").on(t.divisionId, t.status, t.isDel),
    index("da_status_time").on(t.status, t.addTime),
    uniqueIndex("da_uid_active_uq").on(t.uid).where(sql`${t.isDel} = 0`),
    check("da_status_ck", sql`${t.status} BETWEEN 0 AND 2`),
  ],
);

export type DivisionApply = typeof divisionApply.$inferSelect;
export type NewDivisionApply = typeof divisionApply.$inferInsert;
