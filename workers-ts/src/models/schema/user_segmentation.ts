/** User grouping and label-assignment relations retained from CRMEB. */
import { index, integer, pgTable, serial, smallint, varchar } from "drizzle-orm/pg-core";

export const userGroup = pgTable(
  "user_group",
  {
    // Source uses SMALLINT UNSIGNED; INTEGER safely covers its full range.
    id: serial("id").primaryKey(),
    groupName: varchar("group_name", { length: 64 }).default("").notNull(),
  },
  (table) => [index("user_group_name").on(table.groupName)],
);

export const userLabelRelation = pgTable(
  "user_label_relation",
  {
    id: serial("id").primaryKey(),
    uid: integer("uid").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    relationId: integer("relation_id").default(0).notNull(),
    labelId: integer("label_id").default(0).notNull(),
  },
  (table) => [
    index("ulr_scope_user").on(table.type, table.relationId, table.uid, table.id),
    index("ulr_scope_label_user").on(
      table.type,
      table.relationId,
      table.labelId,
      table.uid,
    ),
  ],
);
