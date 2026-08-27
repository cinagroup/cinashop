import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { SystemConfigService } from "@/services/system/SystemConfigService";

const CANCEL_CONFIG_KEYS = [
  "order_activity_time",
  "order_bargain_time",
  "order_cancel_time",
  "order_pink_time",
  "order_seckill_time",
  "rebate_points_orders_time",
] as const;

function configHours(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function orderCancelHours(
  orderType: number,
  config: Record<string, string>,
): number {
  const normal = configHours(config.order_cancel_time, 1);
  const activity = configHours(config.order_activity_time, 1);
  switch (orderType) {
    case 0:
      return normal;
    case 1:
      return configHours(config.order_seckill_time, 0) || activity;
    case 2:
      return configHours(config.order_bargain_time, 0) || activity;
    case 3:
      return configHours(config.order_pink_time, 0) || activity;
    case 4:
      return configHours(config.rebate_points_orders_time, 0) || activity;
    default:
      return activity;
  }
}

export async function getOrderInvalidTime(
  container: Container,
  env: Env,
  orderType: number,
  addTime: number,
): Promise<number> {
  const config = await new SystemConfigService(container, env).getMany([...CANCEL_CONFIG_KEYS]);
  const hours = orderCancelHours(orderType, config);
  return hours > 0 ? addTime + Math.ceil(hours * 3600) : 0;
}
