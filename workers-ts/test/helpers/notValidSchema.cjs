const { sql } = require("drizzle-orm");
const { pgSchema, pgTable, integer, text, check, foreignKey, uniqueIndex, index } = require("drizzle-orm/pg-core");
const { notValid } = require("tsx/cjs/api").require("../../src/models/pgNotValid.ts", __filename);

module.exports = function schema(mode = "not-valid") {
  const mark = mode === "not-valid" ? notValid : value => value;
  const tenant = pgSchema("nv_tenant");
  const parent = pgTable("nv_parent", {
    id: integer().primaryKey(), corp: text().notNull(), external: integer().notNull(),
  }, t => [uniqueIndex("nv_parent_ref_uq").on(t.corp, t.external)]);
  const child = pgTable("nv_child", {
    id: integer().primaryKey(), corp: text().notNull(), external: integer().notNull(),
    amount: integer(), message: text(), memo: text().notNull().default("unchanged"),
  }, t => [
    index("nv_child_ref_idx").on(t.corp, t.external),
    check("nv_ceiling_ck", sql`${t.amount} < 1000`),
    ...(mode === "baseline" ? [] : [
      mark(check("nv_amount_ck", sql`${t.amount} >= 0`)),
      mark(check("nv_message_ck", sql`${t.message} <> 'forbidden;token'`)),
      mark(foreignKey({ name: "nv_child_fk", columns: [t.corp, t.external], foreignColumns: [parent.corp, parent.external] })
        .onDelete("cascade").onUpdate("cascade")),
    ]),
  ]);
  const tenantChild = tenant.table("nv_child", {
    id: integer().primaryKey(), corp: text().notNull(), external: integer().notNull(), amount: integer(),
  }, t => [
    index("nv_tenant_ref_idx").on(t.corp, t.external),
    ...(mode === "baseline" ? [] : [
      mark(check("nv_tenant_amount_ck", sql`${t.amount} >= 0`)),
      mark(foreignKey({ name: "nv_tenant_fk", columns: [t.corp, t.external], foreignColumns: [parent.corp, parent.external] })
        .onDelete("cascade").onUpdate("cascade")),
    ]),
  ]);
  return { tenant, parent, child, tenantChild };
};
