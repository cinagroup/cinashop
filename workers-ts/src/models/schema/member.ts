/** 付费会员权益配置，对应 PHP eb_member_right。 */
import {
  pgTable,
  serial,
  varchar,
  integer,
  smallint,
  text,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const memberRight = pgTable(
  "member_right",
  {
    id: serial("id").primaryKey(),
    rightType: varchar("right_type", { length: 100 }).default("").notNull(),
    title: varchar("title", { length: 200 }).default("").notNull(),
    showTitle: varchar("show_title", { length: 255 }).default("").notNull(),
    image: varchar("image", { length: 200 }).default("").notNull(),
    explain: varchar("explain", { length: 1024 }).default("").notNull(),
    content: text("content"),
    number: integer("number").default(1).notNull(),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [
    index("mr_right_type").on(t.rightType),
    check("mr_number_ck", sql`${t.number} >= 0`),
  ],
);

export type MemberRight = typeof memberRight.$inferSelect;
