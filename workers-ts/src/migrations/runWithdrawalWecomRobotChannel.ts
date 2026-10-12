import type { DbClient } from "@/lib/di";
import { withdrawalWecomRobotChannelSql, type WithdrawalWecomMaintenanceTarget } from "./withdrawalWecomRobotChannel";

export async function runWithdrawalWecomRobotChannel(
  db: Pick<DbClient, "$client">, target: WithdrawalWecomMaintenanceTarget,
): Promise<void> {
  if (!db.$client) throw Error("Withdrawal WeCom channel upgrade requires a root database");
  const installation = withdrawalWecomRobotChannelSql(target);
  await db.$client.begin("isolation level read committed", async (tx) => {
    await tx.unsafe(installation);
  });
}
