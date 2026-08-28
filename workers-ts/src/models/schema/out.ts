/**
 * Legacy third-party API accounts and interface documentation.
 *
 * Every PHP column is retained for lossless import. Worker runtime code must
 * never authenticate with or return apppwd/push_password; appsecret is the
 * only credential verifier and is stored as a bcrypt hash.
 */
import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  serial,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const outAccount = pgTable(
  "out_account",
  {
    id: serial("id").primaryKey(),
    appid: varchar("appid", { length: 50 }).default("").notNull(),
    appsecret: varchar("appsecret", { length: 100 }).default("").notNull(),
    /** Legacy plaintext duplicate. Import-only; Worker writes always clear it. */
    apppwd: varchar("apppwd", { length: 100 }).default("").notNull(),
    title: varchar("title", { length: 200 }).default("").notNull(),
    status: smallint("status").default(1).notNull(),
    rules: text("rules"),
    addTime: integer("add_time").default(0).notNull(),
    lastTime: integer("last_time").default(0).notNull(),
    ip: varchar("ip", { length: 30 }).default("").notNull(),
    isDel: smallint("is_del").default(0).notNull(),
    pushOpen: smallint("push_open").default(0).notNull(),
    pushAccount: varchar("push_account", { length: 255 }).default("").notNull(),
    pushPassword: varchar("push_password", { length: 255 }).default("").notNull(),
    pushTokenUrl: varchar("push_token_url", { length: 255 }).default("").notNull(),
    userUpdatePush: varchar("user_update_push", { length: 255 }).default("").notNull(),
    orderCreatePush: varchar("order_create_push", { length: 255 }).default("").notNull(),
    orderPayPush: varchar("order_pay_push", { length: 255 }).default("").notNull(),
    refundCreatePush: varchar("refund_create_push", { length: 255 }).default("").notNull(),
    refundCancelPush: varchar("refund_cancel_push", { length: 255 }).default("").notNull(),
  },
  (table) => [
    index("out_account_active_appid")
      .on(table.appid, table.id)
      .where(sql`${table.isDel} = 0`),
    index("out_account_status_time").on(table.isDel, table.status, table.addTime, table.id),
  ],
);

export const outInterface = pgTable(
  "out_interface",
  {
    id: serial("id").primaryKey(),
    pid: integer("pid").default(0).notNull(),
    type: smallint("type").default(0).notNull(),
    name: varchar("name", { length: 255 }).default("").notNull(),
    describe: text("describe"),
    method: varchar("method", { length: 255 }).default("").notNull(),
    url: varchar("url", { length: 255 }).default("").notNull(),
    requestParams: text("request_params"),
    returnParams: text("return_params"),
    requestExample: text("request_example"),
    returnExample: text("return_example"),
    errorCode: text("error_code"),
    isDel: smallint("is_del").default(0).notNull(),
  },
  (table) => [
    index("out_interface_active_tree")
      .on(table.pid, table.id)
      .where(sql`${table.isDel} = 0`),
    index("out_interface_active_route")
      .on(table.method, table.url, table.id)
      .where(sql`${table.isDel} = 0`),
  ],
);

/**
 * Append-only, privacy-preserving access evidence for sensitive Out API calls.
 *
 * Paths, IP addresses, user agents, query values, request bodies and response
 * bodies are never stored. Stable HMAC digests allow correlation without
 * turning the audit table into a second PII store.
 */
export const outApiAudit = pgTable(
  "out_api_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    outAccountId: integer("out_account_id").default(0).notNull(),
    appidSnapshot: varchar("appid_snapshot", { length: 50 }).default("").notNull(),
    method: varchar("method", { length: 12 }).default("").notNull(),
    routeTemplate: varchar("route_template", { length: 128 }).default("").notNull(),
    operation: varchar("operation", { length: 16 }).default("read").notNull(),
    resourceHash: varchar("resource_hash", { length: 64 }).default("").notNull(),
    queryFields: varchar("query_fields", { length: 255 }).default("").notNull(),
    ipHash: varchar("ip_hash", { length: 64 }).default("").notNull(),
    userAgentHash: varchar("user_agent_hash", { length: 64 }).default("").notNull(),
    outcome: varchar("outcome", { length: 16 }).default("success").notNull(),
    resultCode: integer("result_code").default(200).notNull(),
    durationMs: integer("duration_ms").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    index("out_audit_account_time").on(table.outAccountId, table.addTime, table.id),
    index("out_audit_route_time").on(table.routeTemplate, table.addTime, table.id),
    index("out_audit_outcome_time").on(table.outcome, table.addTime, table.id),
    check("out_audit_operation_ck", sql`${table.operation} IN ('read', 'write')`),
    check("out_audit_outcome_ck", sql`${table.outcome} IN ('success', 'denied', 'rate_limited', 'error')`),
    check("out_audit_result_code_ck", sql`${table.resultCode} BETWEEN 0 AND 999999`),
    check("out_audit_duration_ck", sql`${table.durationMs} BETWEEN 0 AND 3600000`),
    check("out_audit_add_time_ck", sql`${table.addTime} >= 0`),
    check(
      "out_audit_hashes_ck",
      sql`(${table.resourceHash} = '' OR ${table.resourceHash} ~ '^[0-9a-f]{64}$')
        AND (${table.ipHash} = '' OR ${table.ipHash} ~ '^[0-9a-f]{64}$')
        AND (${table.userAgentHash} = '' OR ${table.userAgentHash} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/**
 * Transactional replay ledger for externally-triggered product writes.
 * Request payloads, product names, barcodes and inventory values are never
 * stored here; only a canonical SHA-256 digest and bounded result identifiers.
 */
export const outProductWriteReplay = pgTable(
  "out_product_write_replay",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    outAccountId: integer("out_account_id").notNull(),
    operation: varchar("operation", { length: 32 }).notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    productId: integer("product_id").default(0).notNull(),
    resultCount: integer("result_count").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("opwr_account_operation_key_uq")
      .on(table.outAccountId, table.operation, table.requestKey),
    index("opwr_product_history").on(table.productId, table.id),
    check(
      "opwr_operation_ck",
      sql`${table.operation} IN ('product_create', 'product_update', 'product_show', 'stock_upload')`,
    ),
    check(
      "opwr_identity_ck",
      sql`${table.outAccountId} > 0 AND ${table.productId} >= 0 AND ${table.resultCount} >= 0 AND ${table.addTime} >= 0`,
    ),
    check("opwr_request_hash_ck", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Content-free replay ledger for Out API coupon writes. Coupon titles, values,
 * scopes, dates and request/response bodies are intentionally never retained.
 */
export const outCouponWriteReplay = pgTable(
  "out_coupon_write_replay",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    outAccountId: integer("out_account_id").notNull(),
    operation: varchar("operation", { length: 32 }).notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    couponId: integer("coupon_id").default(0).notNull(),
    resultStatus: smallint("result_status").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("ocwr_account_operation_key_uq")
      .on(table.outAccountId, table.operation, table.requestKey),
    index("ocwr_coupon_history").on(table.couponId, table.id),
    check(
      "ocwr_operation_ck",
      sql`${table.operation} IN ('coupon_create', 'coupon_status', 'coupon_delete')`,
    ),
    check(
      "ocwr_identity_ck",
      sql`${table.outAccountId} > 0 AND ${table.couponId} > 0
        AND ${table.resultStatus} BETWEEN -1 AND 1 AND ${table.addTime} >= 0`,
    ),
    check("ocwr_request_hash_ck", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Content-free replay ledger for Out API user writes. Names, phone numbers,
 * identity-card values, profile fields and request/response bodies are never
 * persisted here; only a canonical digest and bounded result identifiers.
 */
export const outUserWriteReplay = pgTable(
  "out_user_write_replay",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    outAccountId: integer("out_account_id").notNull(),
    operation: varchar("operation", { length: 32 }).notNull(),
    requestKey: varchar("request_key", { length: 36 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    userId: integer("user_id").default(0).notNull(),
    moneyLedgerId: integer("money_ledger_id").default(0).notNull(),
    integralLedgerId: integer("integral_ledger_id").default(0).notNull(),
    addTime: integer("add_time").default(0).notNull(),
  },
  (table) => [
    uniqueIndex("ouwr_account_operation_key_uq")
      .on(table.outAccountId, table.operation, table.requestKey),
    index("ouwr_user_history").on(table.userId, table.id),
    check(
      "ouwr_operation_ck",
      sql`${table.operation} IN ('user_create', 'user_update', 'user_give')`,
    ),
    check(
      "ouwr_identity_ck",
      sql`${table.outAccountId} > 0 AND ${table.userId} > 0
        AND ${table.moneyLedgerId} >= 0 AND ${table.integralLedgerId} >= 0
        AND ${table.addTime} >= 0`,
    ),
    check("ouwr_request_hash_ck", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export type OutAccount = typeof outAccount.$inferSelect;
export type OutInterface = typeof outInterface.$inferSelect;
export type OutApiAudit = typeof outApiAudit.$inferSelect;
export type OutProductWriteReplay = typeof outProductWriteReplay.$inferSelect;
export type OutCouponWriteReplay = typeof outCouponWriteReplay.$inferSelect;
export type OutUserWriteReplay = typeof outUserWriteReplay.$inferSelect;
