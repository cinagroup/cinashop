const { sql } = require("drizzle-orm");
const { pgSequence, pgTable, pgSchema, integer, smallint, bigint, text } = require("drizzle-orm/pg-core");
const { withSequenceState } = require("tsx/cjs/api").require("../../src/models/pgSequenceState.ts", __filename);
module.exports = (mode = "target") => {
  const tenant = pgSchema("seq_tenant");
  const mark = (seq, dataType, ownedBy) => mode === "baseline" ? seq : withSequenceState(seq, { dataType, ownedBy });
  const smallSequence = mark(pgSequence("seq_small", { startWith: 10, maxValue: 32767 }), "smallint", () => small.uid);
  const small = pgTable("seq_small_owner", { uid: smallint().default(sql.raw("nextval('public.seq_small')")), memo: text() });
  const integerSequence = mark(tenant.sequence("seq_int", { startWith: 100, maxValue: 2147483647 }), "integer", () => int.uid);
  const int = tenant.table("seq_int_owner", { uid: integer().default(sql.raw("nextval('seq_tenant.seq_int')")), memo: text() });
  const bigSequence = mark(pgSequence("seq_big", { startWith: "9007199254740993" }), "bigint", null);
  const big = pgTable("seq_big_owner", { uid: bigint({ mode: "bigint" }).default(sql.raw("nextval('public.seq_big')")) });
  const exported = { tenant, smallSequence, small, integerSequence, int, bigSequence, big };
  if (mode !== "baseline") {
    const quoted = withSequenceState(pgSequence('quoted"sequence;', { startWith: 7 }), { dataType: "integer", ownedBy: () => extra.uid });
    const extra = pgTable("seq_extra;table", { uid: integer().default(sql.raw('nextval(\'public."quoted""sequence;"\')')) });
    Object.assign(exported, { quoted, extra });
  }
  return exported;
};
