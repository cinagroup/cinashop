import type { DbClient } from "@/lib/di";
import { WITHDRAWAL_WECOM_ROBOT_CHANNEL_SQL } from "./withdrawalWecomRobotChannel";

export async function runWithdrawalWecomRobotChannel(db: Pick<DbClient, "$client">): Promise<void> {
  if (!db.$client) throw Error("Withdrawal WeCom channel upgrade requires a root database");
  await db.$client.begin("isolation level read committed", async (tx) => {
    await tx.unsafe(WITHDRAWAL_WECOM_ROBOT_CHANNEL_SQL);
  });
}
