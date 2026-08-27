/**
 * Receipt-printer configuration preserved from the PHP schema.
 *
 * supplier_ticket_print is the superseded single-printer supplier store and
 * remains migration-only. print_document is the active definition catalog;
 * every runtime read and write must additionally scope by supplierId (0 means
 * the platform). Provider secrets must never be returned by an API view.
 */
import {
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  varchar,
} from "drizzle-orm/pg-core";

export const supplierTicketPrint = pgTable(
  "supplier_ticket_print",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id").default(0).notNull(),
    developId: integer("develop_id").default(0).notNull(),
    apiKey: varchar("api_key", { length: 100 }).default("").notNull(),
    clientId: varchar("client_id", { length: 100 }).default("").notNull(),
    terminalNumber: varchar("terminal_number", { length: 100 }).default("").notNull(),
    status: smallint("status").default(0).notNull(),
  },
  (t) => [index("supplier_ticket_print_supplier_id").on(t.supplierId)],
);

export const printDocument = pgTable(
  "print_document",
  {
    id: serial("id").primaryKey(),
    type: smallint("type").default(1).notNull(),
    supplierId: integer("supplier_id").default(0).notNull(),
    printName: varchar("print_name", { length: 255 }).default("").notNull(),
    ylyUserId: varchar("yly_user_id", { length: 255 }).default("").notNull(),
    ylyAppId: varchar("yly_app_id", { length: 255 }).default("").notNull(),
    ylyAppSecret: varchar("yly_app_secret", { length: 255 }).default("").notNull(),
    ylySn: varchar("yly_sn", { length: 255 }).default("").notNull(),
    feyUser: varchar("fey_user", { length: 255 }).default("").notNull(),
    feyUkey: varchar("fey_ukey", { length: 255 }).default("").notNull(),
    feySn: varchar("fey_sn", { length: 255 }).default("").notNull(),
    times: integer("times").default(0).notNull(),
    printType: smallint("print_type").default(1).notNull(),
    printContent: text("print_content"),
    addTime: integer("add_time").default(0).notNull(),
    status: smallint("status").default(0).notNull(),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (t) => [
    index("print_document_supplier_id").on(t.supplierId, t.id),
    index("print_document_active_lookup").on(
      t.supplierId,
      t.isDel,
      t.status,
      t.printType,
      t.id,
    ),
  ],
);

export type SupplierTicketPrint = typeof supplierTicketPrint.$inferSelect;
export type PrintDocument = typeof printDocument.$inferSelect;
