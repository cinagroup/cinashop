import { sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";

// Helpers share this per-activity boundary. Rule writers take it exclusively
// before the activity row, so each help observes one committed people/window/
// status rule through its own commit without serializing unrelated helpers.
const BARGAIN_HELP_RULE_LOCK_NAMESPACE = 731_633;

export async function lockBargainHelpRuleShared(tx: DbClient, activityId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${BARGAIN_HELP_RULE_LOCK_NAMESPACE}, ${activityId})`);
}

export async function lockBargainHelpRuleExclusive(tx: DbClient, activityId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${BARGAIN_HELP_RULE_LOCK_NAMESPACE}, ${activityId})`);
}
