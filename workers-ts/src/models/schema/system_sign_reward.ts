/** Configurable continuous/cumulative sign-in milestone rewards. */
import { index, integer, pgTable, serial, smallint } from "drizzle-orm/pg-core";

export const systemSignReward = pgTable(
  "system_sign_reward",
  {
    id: serial("id").primaryKey(),
    /** 0=continuous sign-in milestone, 1=cumulative sign-in milestone. */
    type: smallint("type").default(0).notNull(),
    days: integer("days").default(0).notNull(),
    point: integer("point").default(0).notNull(),
    exp: integer("exp").default(0).notNull(),
  },
  (table) => [
    // Keep source duplicates importable; runtime writes enforce uniqueness.
    index("system_sign_reward_lookup").on(table.type, table.days, table.id),
  ],
);
