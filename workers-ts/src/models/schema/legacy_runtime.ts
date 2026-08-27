/**
 * Legacy batch-queue history and dynamic timer catalog.
 *
 * These tables remain migration/diagnostic records. Cloudflare Queues and the
 * Worker scheduled handler are the execution authorities; importing a legacy
 * row must never enqueue or replay external work.
 */
import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  varchar,
} from "drizzle-orm/pg-core";

export const queueList = pgTable(
  "queue_list",
  {
    id: serial("id").notNull(),
    type: smallint("type").default(0).notNull(),
    source: varchar("source", { length: 5 }).default("admin").notNull(),
    executeKey: varchar("execute_key", { length: 512 }).default("").notNull(),
    title: varchar("title", { length: 200 }).default("").notNull(),
    queueInValue: text("queue_in_value"),
    sort: integer("sort").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    firstTime: integer("first_time").default(0).notNull(),
    againTime: integer("again_time").default(0).notNull(),
    finishTime: integer("finish_time").default(0).notNull(),
    surplusNum: integer("surplus_num").default(0).notNull(),
    totalNum: integer("total_num").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    // MySQL declares this exact composite primary key even though id is
    // AUTO_INCREMENT. Do not replace it with invented business uniqueness.
    primaryKey({
      name: "queue_list_pk",
      columns: [table.id, table.type, table.status],
    }),
    index("queue_list_status_type_time").on(
      table.status,
      table.type,
      table.addTime,
      table.id,
    ),
    index("queue_list_source_time").on(table.source, table.addTime, table.id),
  ],
);

export const queueAuxiliary = pgTable(
  "queue_auxiliary",
  {
    id: serial("id").primaryKey(),
    bindingId: integer("binding_id").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    other: varchar("other", { length: 2048 }).default("").notNull(),
    status: integer("status").default(0).notNull(),
    updateTime: integer("update_time").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("queue_auxiliary_binding_type_time").on(
      table.bindingId,
      table.type,
      table.addTime,
      table.id,
    ),
    index("queue_auxiliary_status_type_time").on(
      table.status,
      table.type,
      table.addTime,
      table.id,
    ),
  ],
);

export const systemTimer = pgTable(
  "system_timer",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 50 }).default("").notNull(),
    mark: varchar("mark", { length: 50 }).default("").notNull(),
    type: smallint("type").default(1).notNull(),
    title: varchar("title", { length: 255 }).default("").notNull(),
    isOpen: smallint("is_open").default(0).notNull(),
    cycle: varchar("cycle", { length: 255 }).default("").notNull(),
    lastExecutionTime: integer("last_execution_time").default(0).notNull(),
    updateExecutionTime: integer("update_execution_time").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    // The PHP service checks duplicate names/marks in application code; the
    // source schema has no unique constraint, so historical duplicates stay.
    index("system_timer_active_open").on(table.isDel, table.isOpen, table.id),
    index("system_timer_mark").on(table.mark, table.id),
  ],
);

export type QueueList = typeof queueList.$inferSelect;
export type QueueAuxiliary = typeof queueAuxiliary.$inferSelect;
export type SystemTimer = typeof systemTimer.$inferSelect;
