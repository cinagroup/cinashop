import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export type VirtualInventoryExportActorType = "admin" | "supplier";
export type VirtualInventoryExportStatus = "READY" | "CONSUMED" | "EXPIRED";

/**
 * One-time authorization and audit record for plaintext virtual-card export.
 * Only a SHA-256 token digest is persisted; card numbers and passwords never
 * enter this table.
 */
export const systemVirtualInventoryExport = pgTable(
  "system_virtual_inventory_export",
  {
    id: serial("id").primaryKey(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    actorType: varchar("actor_type", { length: 16 })
      .$type<VirtualInventoryExportActorType>()
      .notNull(),
    actorId: integer("actor_id").notNull(),
    supplierId: integer("supplier_id").default(0).notNull(),
    productId: integer("product_id").notNull(),
    attrUnique: varchar("attr_unique", { length: 20 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    requestedCount: integer("requested_count").notNull(),
    exportedCount: integer("exported_count").default(0).notNull(),
    status: varchar("status", { length: 16 })
      .$type<VirtualInventoryExportStatus>()
      .default("READY")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("svie_token_hash_uq").on(table.tokenHash),
    index("svie_actor_history").on(table.actorType, table.actorId, table.id),
    index("svie_product_history").on(table.productId, table.attrUnique, table.id),
    index("svie_ready_expiry")
      .on(table.expiresAt, table.id)
      .where(sql`${table.status} = 'READY'`),
    check(
      "svie_actor_type_ck",
      sql`${table.actorType} IN ('admin', 'supplier')`,
    ),
    check(
      "svie_status_ck",
      sql`${table.status} IN ('READY', 'CONSUMED', 'EXPIRED')`,
    ),
    check(
      "svie_identity_ck",
      sql`${table.actorId} > 0 AND ${table.supplierId} >= 0 AND ${table.productId} > 0`,
    ),
    check(
      "svie_count_ck",
      sql`${table.requestedCount} > 0 AND ${table.requestedCount} <= 1000
        AND ${table.exportedCount} >= 0 AND ${table.exportedCount} <= 1000`,
    ),
    check("svie_expiry_ck", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export type SystemVirtualInventoryExport = typeof systemVirtualInventoryExport.$inferSelect;
