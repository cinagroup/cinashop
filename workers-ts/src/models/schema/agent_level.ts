import { index, integer, pgTable, serial, smallint, varchar } from "drizzle-orm/pg-core";

/** PHP eb_agent_level：分销等级及一、二级佣金上浮百分比。 */
export const agentLevel = pgTable(
  "agent_level",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    image: varchar("image", { length: 255 }).default("").notNull(),
    color: varchar("color", { length: 32 }).default("").notNull(),
    oneBrokerage: smallint("one_brokerage").default(0).notNull(),
    twoBrokerage: smallint("two_brokerage").default(0).notNull(),
    grade: smallint("grade").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (t) => [index("al_status_del").on(t.status, t.isDel)],
);

/** PHP eb_agent_level_task: upgrade requirements attached to a distributor level. */
export const agentLevelTask = pgTable(
  "agent_level_task",
  {
    id: serial("id").primaryKey(),
    levelId: integer("level_id").default(0).notNull(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    type: smallint("type").default(0).notNull(),
    number: integer("number").default(0).notNull(),
    desc: varchar("desc", { length: 255 }).default("").notNull(),
    isMust: smallint("is_must").default(0).notNull(),
    sort: smallint("sort").default(0).notNull(),
    status: smallint("status").default(1).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("alt_level_active").on(table.levelId, table.isDel, table.status, table.sort, table.id),
    index("alt_type_level").on(table.type, table.levelId, table.isDel),
  ],
);

/** PHP eb_agent_level_task_record: durable evidence that a user completed a task. */
export const agentLevelTaskRecord = pgTable(
  "agent_level_task_record",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    levelId: integer("level_id").default(0).notNull(),
    taskId: integer("task_id").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    addTime: integer("add_time").default(10).notNull(),
  },
  (table) => [
    // Preserve source duplicates during import; per-user runtime locking avoids new ones.
    index("altr_user_level_task").on(table.uid, table.levelId, table.taskId, table.id),
    index("altr_task_user").on(table.taskId, table.uid),
  ],
);
