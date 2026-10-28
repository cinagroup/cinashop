import * as UserExtractController from './UserExtractController';
import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { jsonFail, jsonOk } from "@/utils/json";
import { UserFinanceReadService } from "@/services/user/UserFinanceReadService";

import { readPromoterOrdersInput } from '@/services/user/PromoterOrdersInput';
import { PromoterOrdersService } from '@/services/user/PromoterOrdersService';

import { distributionRankingsPage } from '@/services/user/DistributionRankingsInput';
import { DistributionRankingsService } from '@/services/user/DistributionRankingsService';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Operation = (service: UserFinanceReadService, uid: number) => Promise<unknown>;

async function read(c: C, operation: Operation) {
  c.header("Cache-Control", "private, no-store");
  const uid = c.get("uid");
  if (!uid) return jsonFail(c, "请先登录");
  return jsonOk(c, await operation(new UserFinanceReadService(c.get("container"), c.env), uid));
}

export const integralList = (c: C) => read(c, (s, uid) => s.integralList(uid, c.req.query()));
export const extractBank = (c: C) => new URL(c.req.url).searchParams.has('view') ? UserExtractController.bank(c) : read(c, (s, uid) => s.extractBank(uid));
export const spreadCount = (c: C) => read(c, (s, uid) => s.spreadCount(uid, c.req.param("type") ?? ""));
async function leaderboard(c: C, kind: 'promoter' | 'commission') {
  c.header('Cache-Control', 'private, no-store');
  const uid = c.get('uid');
  if (!uid) return jsonFail(c, '请先登录');
  const paging = distributionRankingsPage(new URL(c.req.url).searchParams);
  return jsonOk(c, await new DistributionRankingsService(c.get('container'), c.env).read(uid, kind, paging));
}
export const brokerageRank = (c: C) => new URL(c.req.url).searchParams.has('view')
  ? leaderboard(c, 'commission') : read(c, (s, uid) => s.brokerageRank(uid, c.req.query()));
export const spreadRank = (c: C) => new URL(c.req.url).searchParams.has('view')
  ? leaderboard(c, 'promoter') : read(c, (s, uid) => s.spreadRank(uid, c.req.query()));
export const spreadOrder = async (c: C) => {
  if (new URL(c.req.url).searchParams.has('view')) {
    c.header('Cache-Control', 'private, no-store');
    const uid = c.get('uid');
    if (!uid) return jsonFail(c, '请先登录');
    const query = await readPromoterOrdersInput(c.req.raw);
    return jsonOk(c, await new PromoterOrdersService(c.get('container'), c.env).read(uid, query));
  }
  return read(c, async (s, uid) => {
    const raw: unknown = await c.req.json().catch(() => ({}));
    return s.spreadOrder(uid, raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {});
  });
};
